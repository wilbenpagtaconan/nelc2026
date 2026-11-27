/*
 * Shared data logic — used by the browser (app.js) and by server.js,
 * so both apply changes to the database in exactly the same way.
 *
 * Database shape (this is what data.json contains):
 * {
 *   "event": "National eLearning Conference 2026",
 *   "days": ["2026-12-01", "2026-12-02"],     // date of Day 1, Day 2 ("" = not set yet)
 *   "cutoff": "12:00",                         // scans before this time are AM, from it on PM
 *   "people": [
 *     { "id": "T66372", "name": "Juan Dela Cruz", "email": "", "org": "UP Diliman",
 *       "registeredAt": 1763342100000,
 *       "att": { "d1am": 1764550800000, "d1pm": null, "d2am": null, "d2pm": null } }
 *   ]
 * }
 * Session keys are d<day><am|pm>: d1am, d1pm, d2am, d2pm ...
 * Times are milliseconds since 1970 (JavaScript Date.now()).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_DAYS = 5;
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

  const DEFAULT_EVENT = 'National eLearning Conference 2026';
  function emptyDb() { return { event: DEFAULT_EVENT, days: ['', ''], cutoff: '12:00', people: [] }; }

  /** List of sessions for the configured days: [{ key, day, half, date, label }] */
  function sessions(db) {
    const out = [];
    db.days.forEach((date, i) => {
      for (const half of ['am', 'pm']) out.push({ key: `d${i + 1}${half}`, day: i + 1, half, date, label: `Day ${i + 1} ${half.toUpperCase()}` });
    });
    return out;
  }

  /** Which session a moment in time belongs to (uses this computer's local time), or null. */
  function sessionAt(db, ts) {
    const d = new Date(ts), pad = n => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const day = db.days.indexOf(date);
    if (day < 0) return null;
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `d${day + 1}${hm < db.cutoff ? 'am' : 'pm'}`;
  }

  function normalize(d) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.people)) return emptyDb();
    const db = {
      // the old placeholder name is replaced by the conference name
      event: typeof d.event === 'string' && d.event.trim() && !/^My Conference( 2026)?$/.test(d.event.trim()) ? d.event : DEFAULT_EVENT,
      days: Array.isArray(d.days) && d.days.length ? d.days.slice(0, MAX_DAYS).map(x => isDate(x) ? x : '') : ['', ''],
      cutoff: isTime(d.cutoff) ? d.cutoff : '12:00',
      people: []
    };
    const keys = sessions(db).map(s => s.key);
    db.people = d.people.filter(p => p && p.id && p.name).map(p => {
      const att = {};
      for (const k of keys) att[k] = p.att && p.att[k] ? Number(p.att[k]) : null;
      // keep times of sessions beyond the current number of days, in case days are added back
      if (p.att) for (const k in p.att) if (!(k in att) && /^d\d+(am|pm)$/.test(k) && p.att[k]) att[k] = Number(p.att[k]);
      // older single check-in format -> put it in the matching session (or Day 1 AM)
      if (p.checkedInAt) { const k = sessionAt(db, Number(p.checkedInAt)) || 'd1am'; if (!att[k]) att[k] = Number(p.checkedInAt); }
      return {
        id: String(p.id), name: String(p.name), email: p.email ? String(p.email) : '',
        org: p.org ? String(p.org) : '', registeredAt: Number(p.registeredAt) || Date.now(), att
      };
    });
    return db;
  }

  const find = (db, id) => db.people.find(p => p.id === id);
  const str = (v, max) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
  const validSession = (db, s) => sessions(db).some(x => x.key === s);
  const newPerson = (db, id, name, email, org, at) => {
    const att = {}; for (const s of sessions(db)) att[s.key] = null;
    return { id: str(id, 20), name: str(name, 80), email: str(email, 100), org: str(org, 80), registeredAt: at, att };
  };

  /*
   * Apply one change ("op") to the database. Every op is safe to apply twice,
   * so ops queued while offline can be re-sent without double effects.
   * Returns a result object describing what happened.
   */
  function applyOp(db, o) {
    const at = Number(o.at) || Date.now();
    switch (o.t) {
      case 'add': {
        const p = newPerson(db, o.p.id, o.p.name, o.p.email, o.p.org, at);
        if (!p.id || !p.name) return { status: 'invalid' };
        const same = find(db, p.id);
        if (same) return { status: 'added', person: same };
        const dup = p.email && db.people.find(x => x.email && x.email.toLowerCase() === p.email.toLowerCase());
        if (dup) return { status: 'dupEmail', person: dup };
        db.people.push(p);
        return { status: 'added', person: p };
      }
      case 'checkin': { // { i, n, o, s: session key }
        if (!validSession(db, o.s)) return { status: 'badSession' };
        let p = find(db, o.i), added = false;
        if (!p) { // QR generated on another device: accept it as a registration
          p = newPerson(db, o.i, o.n, '', o.o, at);
          if (!p.id || !p.name) return { status: 'invalid' };
          db.people.push(p); added = true;
        }
        // same timestamp = this exact op was already applied (e.g. re-sent after a network error)
        if (p.att[o.s]) return { status: o.at && p.att[o.s] === at ? 'ok' : 'already', person: p, session: o.s };
        p.att[o.s] = at;
        return { status: 'ok', person: p, added, session: o.s };
      }
      case 'set': { // set or clear one session explicitly: { i, s, value }
        const p = find(db, o.i); if (!p || !validSession(db, o.s)) return { status: 'missing' };
        p.att[o.s] = o.value ? Number(o.value) : null;
        return { status: 'ok', person: p };
      }
      case 'del':
        db.people = db.people.filter(p => p.id !== o.i);
        return { status: 'ok' };
      case 'event':
        db.event = str(o.name, 120) || DEFAULT_EVENT;
        return { status: 'ok' };
      case 'settings': { // { days: ["YYYY-MM-DD", ...], cutoff: "HH:MM" }
        if (Array.isArray(o.days) && o.days.length >= 1) db.days = o.days.slice(0, MAX_DAYS).map(x => isDate(x) ? x : '');
        if (isTime(o.cutoff)) db.cutoff = o.cutoff;
        for (const p of db.people) for (const s of sessions(db)) if (!(s.key in p.att)) p.att[s.key] = null;
        return { status: 'ok' };
      }
      case 'reset': // { s } clears one session; without s clears all sessions
        db.people.forEach(p => { for (const k in p.att) if (!o.s || k === o.s) p.att[k] = null; });
        return { status: 'ok' };
      case 'wipe':
        db.people = [];
        return { status: 'ok' };
      case 'merge': {
        const src = normalize({ event: o.event, days: o.days || db.days, cutoff: o.cutoff || db.cutoff, people: o.people });
        const wasEmpty = db.people.length === 0;
        let added = 0, updated = 0;
        for (const p of src.people) {
          const ex = find(db, p.id);
          if (!ex) { for (const s of sessions(db)) if (!(s.key in p.att)) p.att[s.key] = null; db.people.push(p); added++; continue; }
          let changed = false;
          for (const k in p.att) if (p.att[k] && (!ex.att[k] || p.att[k] < ex.att[k])) { ex.att[k] = p.att[k]; changed = true; }
          if (changed) updated++;
        }
        if (wasEmpty && o.event) db.event = src.event;
        if (wasEmpty && o.days) { db.days = src.days; db.cutoff = src.cutoff; }
        return { status: 'ok', added, updated };
      }
      default:
        return { status: 'invalid' };
    }
  }

  return { emptyDb, normalize, applyOp, sessions, sessionAt, MAX_DAYS };
});
