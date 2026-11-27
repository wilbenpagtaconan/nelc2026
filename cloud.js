/*
 * Live shared database — Firebase (Cloud Firestore + staff sign-in).
 *
 * Turned on when firebase-config.js contains your project's settings. Then every device that opens the app
 * (GitHub Pages, server.js or the file itself) reads and writes the same data, live.
 *
 * Firestore layout (EVENT_ID comes from firebase-config.js):
 *   events/{EVENT_ID}                 { event, days, cutoff }
 *   events/{EVENT_ID}/people/{id}     { id, name, email, org, registeredAt, att: { d1am, d1pm, ... } }
 *
 * Changes are worked out with the same rules as everywhere else (core.js): the op is applied to a copy of the
 * data and only the fields that changed are written. Check-ins use a transaction, so two devices scanning the
 * same badge at the same moment correctly get "Welcome" on one and "Already checked in" on the other.
 * Without internet, Firestore keeps working from its local copy and uploads the changes when back online.
 */
(function () {
  'use strict';
  const cfg = window.FIREBASE_CONFIG || {};
  const EVENT_ID = String(window.EVENT_ID || 'event').replace(/[^\w\-]/g, '_');
  const enabled = () => !!(cfg.apiKey && cfg.projectId && !/PASTE|YOUR_/i.test(cfg.apiKey + cfg.projectId));

  let FB, auth, fs, evRef, peopleCol, unsubs = [];
  let meta = null, metaLoaded = false, people = new Map(), fromCache = true, pending = false, lastError = '';
  let handlers = {};

  function loadSdk() {
    if (window.FB) return Promise.resolve(window.FB);
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'lib/firebase.js';
      s.onload = () => res(window.FB); s.onerror = () => rej(new Error('Could not load lib/firebase.js'));
      document.head.appendChild(s);
    });
  }

  async function start(h) {
    handlers = h;
    FB = await loadSdk();
    const app = FB.initializeApp(cfg);
    auth = FB.getAuth(app);
    try { fs = FB.initializeFirestore(app, { localCache: FB.persistentLocalCache({ tabManager: FB.persistentMultipleTabManager() }) }); }
    catch (e) { fs = FB.initializeFirestore(app, { localCache: FB.memoryLocalCache() }); }
    evRef = FB.doc(fs, 'events', EVENT_ID);
    peopleCol = FB.collection(fs, 'events', EVENT_ID, 'people');
    FB.onAuthStateChanged(auth, user => {
      stopListening();
      handlers.onAuth && handlers.onAuth(user);
      if (user) listen();
    });
  }

  function stopListening() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; meta = null; metaLoaded = false; people = new Map(); }

  let emitTimer = 0;
  function emit() { // combine bursts of snapshot events into one screen update
    if (emitTimer) return;
    emitTimer = setTimeout(() => {
      emitTimer = 0;
      if (!metaLoaded) return;
      const db = Core.normalize(Object.assign(Core.emptyDb(), meta || {}, { people: [...people.values()] }));
      handlers.onData && handlers.onData(db);
    }, 30);
  }
  function onErr(e) {
    lastError = e && e.code === 'permission-denied'
      ? 'This account is not allowed to use the attendance database. Ask the organizer to add your email.'
      : 'Cloud error: ' + (e && e.message || e);
    handlers.onStatus && handlers.onStatus();
  }

  function listen() {
    lastError = '';
    unsubs.push(FB.onSnapshot(evRef, { includeMetadataChanges: true }, snap => {
      meta = snap.exists() ? snap.data() : null; metaLoaded = true;
      fromCache = snap.metadata.fromCache;
      // first use of this EVENT_ID: create the event settings document
      if (!snap.exists() && !snap.metadata.fromCache) FB.setDoc(evRef, plainMeta(Core.emptyDb()), { merge: true }).catch(onErr);
      emit(); handlers.onStatus && handlers.onStatus();
    }, onErr));
    unsubs.push(FB.onSnapshot(peopleCol, { includeMetadataChanges: true }, snap => {
      people = new Map(snap.docs.map(d => [d.id, Object.assign({ id: d.id }, d.data())]));
      fromCache = snap.metadata.fromCache; pending = snap.metadata.hasPendingWrites;
      emit(); handlers.onStatus && handlers.onStatus();
    }, onErr));
  }

  const plainMeta = d => ({ event: d.event, days: d.days, cutoff: d.cutoff });
  const personDoc = p => ({ id: p.id, name: p.name, email: p.email || '', org: p.org || '', registeredAt: p.registeredAt, att: Object.assign({}, p.att) });
  const clone = d => JSON.parse(JSON.stringify(d));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // compare two versions of the data and list the writes that turn the first into the second
  function diff(before, after) {
    const w = [];
    const mb = plainMeta(before), ma = plainMeta(after), mChange = {};
    for (const k in ma) if (!same(mb[k], ma[k])) mChange[k] = ma[k];
    if (Object.keys(mChange).length) w.push({ kind: 'set', ref: evRef, data: mChange });
    const B = new Map(before.people.map(p => [p.id, p])), A = new Map(after.people.map(p => [p.id, p]));
    for (const [id, p] of A) {
      const ref = FB.doc(peopleCol, id), o = B.get(id);
      if (!o) { w.push({ kind: 'set', ref, data: personDoc(p) }); continue; }
      const ch = {};
      for (const k of ['name', 'email', 'org', 'registeredAt']) if (o[k] !== p[k]) ch[k] = p[k];
      const att = {};
      for (const k of new Set([...Object.keys(o.att), ...Object.keys(p.att)])) if ((o.att[k] || null) !== (p.att[k] || null)) att[k] = p.att[k] || null;
      if (Object.keys(att).length) ch.att = att;
      if (Object.keys(ch).length) w.push({ kind: 'set', ref, data: ch }); // merge: only these fields change
    }
    for (const id of B.keys()) if (!A.has(id)) w.push({ kind: 'del', ref: FB.doc(peopleCol, id) });
    return w;
  }

  function commit(writes) {
    // Firestore applies the batch to the local copy immediately; the upload finishes in the background
    // (later, if offline). Batches hold at most 500 writes.
    for (let i = 0; i < writes.length; i += 450) {
      const b = FB.writeBatch(fs);
      for (const x of writes.slice(i, i + 450)) x.kind === 'del' ? b.delete(x.ref) : b.set(x.ref, x.data, { merge: true });
      b.commit().catch(onErr);
    }
  }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // check-in inside a transaction: reads the latest server copy of this person first
  function checkinTx(working, op) {
    return FB.runTransaction(fs, async tx => {
      const ref = FB.doc(peopleCol, String(op.i));
      const snap = await tx.get(ref);
      const tmp = Core.normalize({ event: working.event, days: working.days, cutoff: working.cutoff,
        people: snap.exists() ? [Object.assign({ id: snap.id }, snap.data())] : [] });
      const r = Core.applyOp(tmp, op);
      if (r.status === 'ok') {
        if (!snap.exists()) tx.set(ref, personDoc(r.person));
        else tx.set(ref, { att: { [op.s]: r.person.att[op.s] } }, { merge: true });
      }
      return r;
    });
  }

  /** Apply ops; returns { results, db } where db already includes the changes. */
  async function runOps(ops, current) {
    const working = clone(current), results = [], writes = [];
    for (const op of ops) {
      if (op.t === 'checkin' && navigator.onLine !== false) {
        try {
          const r = await withTimeout(checkinTx(working, op), 5000);
          Core.applyOp(working, op);            // mirror locally for the screen
          if (r.status === 'already') { const p = working.people.find(x => x.id === op.i); if (p && r.person) p.att[op.s] = r.person.att[op.s]; }
          results.push(r); continue;
        } catch (e) {
          if (e && e.code === 'permission-denied') { onErr(e); results.push({ status: 'invalid' }); continue; }
          // offline or slow: fall through and record it locally; it uploads when the connection returns
        }
      }
      const before = clone(working);
      results.push(Core.applyOp(working, op));
      writes.push(...diff(before, working));
    }
    if (writes.length) commit(writes);
    return { results, db: working };
  }

  function status() {
    if (lastError) return { kind: 'bad', text: lastError };
    if (!auth || !auth.currentUser) return { kind: 'warn', text: 'Cloud database — sign in to continue' };
    if (fromCache) return { kind: 'warn', text: 'Offline — showing saved copy; changes upload when back online' };
    if (pending) return { kind: 'warn', text: 'Uploading changes…' };
    return { kind: 'ok', text: 'Live cloud database · ' + auth.currentUser.email };
  }

  window.Cloud = {
    enabled, start, runOps, status, EVENT_ID,
    projectId: cfg.projectId,
    user: () => auth && auth.currentUser,
    signIn: (email, pw) => FB.signInWithEmailAndPassword(auth, email, pw),
    signOut: () => FB.signOut(auth),
  };
})();
