/*
 * Conference Check-in — browser app
 *
 * Where data is saved (picked automatically on load):
 *   1. "server" — page opened from server.js (http://...): every change is sent to the
 *                 server, which writes it to data.json on that computer. All devices share it.
 *   2. "file"   — page opened directly (file:// or any host) in desktop Chrome/Edge and a
 *                 JSON file was linked with "Open JSON file…": every change is written to that file.
 *   3. "local"  — fallback: browser localStorage only.
 * A copy is always kept in localStorage as a safety cache.
 */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const CACHE_KEY = 'confcheckin.v1';
  const QUEUE_KEY = 'confcheckin.queue';
  const PREFIX = 'CONF1|';

  // =====================================================================
  //  STORAGE
  // =====================================================================
  let db = Core.emptyDb();
  let mode = 'local';            // 'cloud' | 'server' | 'file' | 'local'
  let version = -1;              // server data version
  let serverFile = '';           // path of data.json on the server PC
  let queue = [];                // server ops not yet delivered (offline)
  let fileHandle = null;         // linked JSON file (File System Access API)
  let pendingHandle = null;      // remembered file that needs permission again
  const canLinkFile = 'showOpenFilePicker' in window;

  const lsGet = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  // --- tiny IndexedDB helper: remembers the linked file between visits ---
  function idb(op, val) {
    return new Promise(resolve => {
      try {
        const r = indexedDB.open('confcheckin', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
          const tx = r.result.transaction('kv', op === 'get' ? 'readonly' : 'readwrite').objectStore('kv');
          const q = op === 'get' ? tx.get('file') : op === 'set' ? tx.put(val, 'file') : tx.delete('file');
          q.onsuccess = () => resolve(q.result); q.onerror = () => resolve(null);
        };
        r.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }

  // --- server API ---
  async function api(pathname, body) {
    const r = await fetch(pathname, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' } : { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  function takeServer(j) { db = Core.normalize(j.db); version = j.version; lsSet(CACHE_KEY, db); }

  // --- linked JSON file ---
  let writing = Promise.resolve();
  function writeFile() {
    const h = fileHandle, text = JSON.stringify(db, null, 2);
    writing = writing.then(async () => {
      const w = await h.createWritable(); await w.write(text); await w.close();
    }).catch(e => { setStatus('bad', 'Could not write ' + h.name + ' — ' + e.message); toast('Save to file failed'); });
    return writing;
  }
  async function readFile(h) {
    const text = (await (await h.getFile()).text()).trim();
    return text ? Core.normalize(JSON.parse(text)) : null;
  }
  async function linkFile(h, { create }) {
    try {
      if (create) { fileHandle = h; await writeFile(); }
      else {
        const data = await readFile(h);
        fileHandle = h;
        if (data) db = data; else await writeFile(); // empty file: fill it with current data
      }
      mode = 'file'; pendingHandle = null;
      await idb('set', h); lsSet(CACHE_KEY, db);
      ev.textContent = db.event; render(); setStatus();
      toast('Linked ' + h.name);
    } catch (e) {
      if (e.name !== 'AbortError') toast(e instanceof SyntaxError ? 'That file is not valid JSON' : 'Could not open file: ' + e.message);
    }
  }

  /** Apply a change and save it wherever data lives. Returns the op result. */
  async function run(op) { return (await runBatch([op]))[0]; }

  /** Apply several changes in one save (used by bulk upload). Returns one result per op. */
  async function runBatch(ops) {
    const now = Date.now();
    ops.forEach(op => { op.at = op.at || now; });
    if (mode === 'cloud') {
      if (!Cloud.user()) { $('#authDlg').open || $('#authDlg').showModal(); return ops.map(() => ({ status: 'invalid' })); }
      const out = await Cloud.runOps(ops, db);
      db = out.db; lsSet(CACHE_KEY, db); render(); setStatus();
      return out.results;
    }
    if (mode === 'server') {
      queue.push(...ops); lsSet(QUEUE_KEY, queue);
      try {
        const j = await api('api/ops', queue);
        queue = []; lsSet(QUEUE_KEY, queue); takeServer(j); render(); setStatus();
        return j.results.slice(-ops.length);
      } catch (e) { // server unreachable: apply locally now, send later
        const rs = ops.map(op => Core.applyOp(db, op)); lsSet(CACHE_KEY, db); render(); setStatus();
        return rs;
      }
    }
    const rs = ops.map(op => Core.applyOp(db, op));
    lsSet(CACHE_KEY, db);
    if (mode === 'file') writeFile();
    render();
    return rs;
  }

  async function sync() { // server mode: deliver queued ops and pick up other devices' changes
    if (mode !== 'server' || document.hidden) return;
    try {
      if (queue.length) { takeServer(await api('api/ops', queue)); queue = []; lsSet(QUEUE_KEY, queue); render(); }
      else {
        const { version: v } = await api('api/version');
        if (v !== version) { takeServer(await api('api/data')); ev.textContent = db.event; render(); }
      }
      setStatus();
    } catch (e) { setStatus(); }
  }

  async function initStore() {
    queue = lsGet(QUEUE_KEY) || [];
    if (window.Cloud && Cloud.enabled()) { // live shared database (firebase-config.js filled in)
      mode = 'cloud';
      db = Core.normalize(lsGet(CACHE_KEY));
      try {
        await Cloud.start({
          onData: d => { db = d; lsSet(CACHE_KEY, db); render(); setStatus(); },
          onStatus: () => setStatus(),
          onAuth: user => {
            const dlg = $('#authDlg');
            if (user) { if (dlg.open) dlg.close(); }
            else { $('#authPw').value = ''; if (!dlg.open) dlg.showModal(); setTimeout(() => $('#authEmail').focus(), 50); }
            setStatus();
          },
        });
      } catch (e) { setStatus('bad', 'Could not start the cloud database: ' + e.message); }
      return;
    }
    if (location.protocol.startsWith('http')) {
      try {
        const j = await api('api/data');
        mode = 'server'; serverFile = j.file; takeServer(j);
        if (queue.length) await sync();
        (function loop() { setTimeout(() => sync().finally(loop), $('#scan').classList.contains('on') ? 1500 : 3000); })();
        return;
      } catch (e) { /* not served by server.js */ }
    }
    db = Core.normalize(lsGet(CACHE_KEY));
    if (canLinkFile) {
      const h = await idb('get');
      if (h) {
        try {
          if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') {
            const data = await readFile(h); fileHandle = h; mode = 'file'; if (data) db = data;
          } else pendingHandle = h; // needs a click to grant access again
        } catch (e) { pendingHandle = h; }
      }
    }
  }

  function setStatus(kind, text) {
    const dot = $('#storeDot'), t = $('#storeText'), info = $('#storeInfo');
    let k, msg, detail;
    if (mode === 'cloud') {
      const s = Cloud.status(); k = s.kind; msg = s.text;
      detail = `Data is stored in the Firebase project <b>${esc(Cloud.projectId)}</b> (event <b>${esc(Cloud.EVENT_ID)}</b>). Every signed-in device sees changes live. Without internet the app keeps working and uploads changes when the connection returns.` +
        (Cloud.user() ? ` Signed in as <b>${esc(Cloud.user().email)}</b>.` : '');
    } else if (mode === 'server') {
      const off = queue.length > 0;
      k = off ? 'warn' : 'ok';
      msg = off ? `Server offline — ${queue.length} change(s) waiting to save` : 'Saved to data file on server';
      detail = `Every change is written to <b>${esc(serverFile)}</b> on the computer running server.js. All devices that open this address share the same data.`;
    } else if (mode === 'file') {
      k = 'ok'; msg = 'Saved to ' + fileHandle.name;
      detail = `Every change is written to <b>${esc(fileHandle.name)}</b> on this computer.`;
    } else {
      k = 'warn'; msg = pendingHandle ? `Click “Reconnect” (Attendees tab) to resume saving to ${pendingHandle.name}` : 'Browser storage only — no data file linked';
      detail = canLinkFile
        ? 'Link a JSON file on this computer and every change will be saved to it. Or run <b>server.js</b> to save to data.json and share it with phones.'
        : 'This browser cannot write files directly. Run <b>server.js</b> on a computer and open its address to save to data.json, or use Backup.';
    }
    if (kind) { k = kind; msg = text; }
    dot.className = 'dot ' + k; t.textContent = msg; info.innerHTML = detail;
    $('#fileBtns').hidden = mode === 'server' || mode === 'cloud' || !canLinkFile;
    $('#cloudBtns').hidden = mode !== 'cloud' || !Cloud.user();
    $('#unlink').hidden = mode !== 'file';
    $('#reconnect').hidden = !pendingHandle;
    if (pendingHandle) $('#reconnect').textContent = 'Reconnect ' + pendingHandle.name;
  }

  // ---------- staff sign-in (cloud mode) ----------
  $('#authDlg').addEventListener('cancel', e => e.preventDefault()); // cannot be dismissed while signed out
  $('#authForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('#authErr').textContent = ''; $('#authGo').disabled = true; $('#authGo').textContent = 'Signing in…';
    try { await Cloud.signIn($('#authEmail').value.trim(), $('#authPw').value); }
    catch (err) {
      const c = err && err.code || '';
      $('#authErr').textContent = /invalid-credential|wrong-password|user-not-found|invalid-email/.test(c) ? 'Wrong email or password.'
        : /network/.test(c) ? 'No internet connection. Connect once to sign in; after that the app also works offline.'
        : /too-many-requests/.test(c) ? 'Too many attempts. Wait a minute and try again.' : 'Sign-in failed: ' + (err.message || c);
    }
    $('#authGo').disabled = false; $('#authGo').textContent = 'Sign in';
  });
  $('#signOutBtn').onclick = async () => { if (await confirmBox('Sign out of the cloud database on this device?')) Cloud.signOut(); };

  const jsonTypes = [{ description: 'JSON data', accept: { 'application/json': ['.json'] } }];
  $('#openFile').onclick = async () => {
    try { const [h] = await showOpenFilePicker({ types: jsonTypes }); await linkFile(h, { create: false }); }
    catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  };
  $('#newFile').onclick = async () => {
    try { const h = await showSaveFilePicker({ suggestedName: 'data.json', types: jsonTypes }); await linkFile(h, { create: true }); }
    catch (e) { if (e.name !== 'AbortError') toast(e.message); }
  };
  $('#reconnect').onclick = async () => {
    const h = pendingHandle;
    if (h && (await h.requestPermission({ mode: 'readwrite' })) === 'granted') await linkFile(h, { create: false });
  };
  $('#unlink').onclick = async () => { fileHandle = null; mode = 'local'; await idb('del'); setStatus(); toast('File unlinked — data kept in browser'); };

  // =====================================================================
  //  UI
  // =====================================================================
  const byId = id => db.people.find(p => p.id === id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const time = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const slug = s => s.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 40);
  const uid = () => {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
    for (const b of crypto.getRandomValues(new Uint8Array(6))) s += a[b % a.length];
    return byId(s) ? uid() : s;
  };

  let toastT;
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400); }
  function confirmBox(msg) {
    return new Promise(res => {
      const d = $('#dlg'); $('#dlgMsg').textContent = msg; d.showModal();
      $('#dlgYes').onclick = () => { d.close(); res(true); }; $('#dlgNo').onclick = () => { d.close(); res(false); };
    });
  }
  function download(name, blobOrText, type) {
    const blob = blobOrText instanceof Blob ? blobOrText : new Blob([blobOrText], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- event name ----------
  const ev = $('#eventName');
  ev.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ev.blur(); } });
  ev.addEventListener('blur', async () => {
    const name = ev.textContent.trim() || 'National eLearning Conference 2026';
    if (name !== db.event) await run({ t: 'event', name });
    ev.textContent = db.event;
  });

  // ---------- tabs ----------
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  function showTab(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('section').forEach(s => s.classList.toggle('on', s.id === name));
    if (name !== 'scan') stopCam();
    else if (scanMode === 'wedge') setTimeout(() => $('#wedgeIn').focus(), 0);
    try { history.replaceState(null, '', '#' + name); } catch (e) {}
  }

  // ---------- QR generation ----------
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  const payload = p => PREFIX + JSON.stringify({ i: p.id, n: p.name, o: p.org || undefined });

  // Badge = one precut sticker: 2.9 in long x 1.5 in wide (landscape), drawn at 300 DPI = 870 x 450 px.
  // Layout: the NAME in large type across the top; QR code bottom-left; organization and ID beside it.
  const DPI = 300, BADGE_IN_W = 2.9, BADGE_IN_H = 1.5;
  const BADGE_W = Math.round(BADGE_IN_W * DPI), BADGE_H = Math.round(BADGE_IN_H * DPI);
  function drawBadge(canvas, p) {
    const qr = qrcode(0, 'M'); qr.addData(payload(p), 'Byte'); qr.make();
    const n = qr.getModuleCount();
    canvas.width = BADGE_W; canvas.height = BADGE_H;
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, BADGE_W, BADGE_H);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    const m = Math.round(0.08 * DPI); // safe margin inside the sticker edge
    const font = (px, w) => c.font = `${w} ${px}px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif`;
    const lh = px => Math.round(px * 1.12);

    // wrap text into a given width, shrinking the font until it fits; maxLines may depend on the font size
    function wrap(text, width, maxPx, minPx, weight, maxLines) {
      const limit = px => typeof maxLines === 'function' ? maxLines(px) : maxLines;
      const split = () => {
        const lines = []; let line = '';
        for (const w of String(text).split(' ')) {
          const t = line ? line + ' ' + w : w;
          if (c.measureText(t).width <= width || !line) line = t; else { lines.push(line); line = w; }
        }
        return lines.concat(line);
      };
      for (let px = maxPx; px >= minPx; px -= 2) {
        font(px, weight);
        const lines = split();
        if (lines.length <= limit(px) && lines.every(l => c.measureText(l).width <= width)) return { px, lines };
      }
      font(minPx, weight); // still too long: keep the allowed lines and end with …
      const lines = split().slice(0, limit(minPx)).map(l => { while (c.measureText(l).width > width && l.length > 1) l = l.slice(0, -1); return l; });
      let last = lines[lines.length - 1];
      while (c.measureText(last + '…').width > width && last.length > 1) last = last.slice(0, -1);
      lines[lines.length - 1] = last.replace(/\s+$/, '') + '…';
      return { px: minPx, lines };
    }

    // 1) NAME — as big as possible: one line up to ~26 pt, otherwise two lines
    const fullW = BADGE_W - 2 * m;
    const name = wrap(p.name, fullW, 112, 46, 800, px => px >= 72 ? 1 : 2);
    font(name.px, 800); c.fillStyle = '#000';
    let y = m + Math.round(name.px * 0.92);
    name.lines.forEach((l, i) => c.fillText(l, m, y + i * lh(name.px)));
    const nameBottom = y + (name.lines.length - 1) * lh(name.px) + Math.round(name.px * 0.25);

    // thin rule under the name
    const ruleY = nameBottom + Math.round(0.03 * DPI);
    c.fillStyle = '#000'; c.fillRect(m, ruleY, fullW, 3);

    // 2) QR — fills the space below the name, bottom-left
    const qTop = ruleY + Math.round(0.05 * DPI), avail = BADGE_H - m - qTop;
    const cell = Math.max(2, Math.floor(avail / n)), qSize = cell * n;
    const qx = m, qy = BADGE_H - m - qSize;
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) c.fillRect(qx + k * cell, qy + r * cell, cell, cell);

    // 3) details to the right of the QR: organization (top) and ID (bottom)
    const tx = qx + qSize + Math.round(0.08 * DPI), tw = BADGE_W - m - tx;
    if (p.org) {
      const org = wrap(p.org, tw, 48, 26, 600, px => px > 40 ? 2 : 3);
      font(org.px, 600); c.fillStyle = '#111';
      org.lines.forEach((l, i) => c.fillText(l, tx, qTop + org.px + i * lh(org.px)));
    }
    font(26, 600); c.fillStyle = '#666';
    c.fillText('ID ' + p.id, tx, BADGE_H - m - 2);
  }

  // PNG with 300 DPI stored inside, so it prints at exactly 2.9 x 1.5 in
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function withDpi(blob) {
    const png = new Uint8Array(await blob.arrayBuffer());
    const ppm = Math.round(DPI / 0.0254), chunk = new Uint8Array(21), v = new DataView(chunk.buffer);
    v.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); v.setUint32(8, ppm); v.setUint32(12, ppm); chunk[16] = 1;
    v.setUint32(17, crc32(chunk.subarray(4, 17)));
    const at = 33; // right after the IHDR chunk
    return new Blob([png.subarray(0, at), chunk, png.subarray(at)], { type: 'image/png' });
  }
  const savePng = (canvas, p) => canvas.toBlob(async b => download(`QR_${slug(p.name)}_${p.id}.png`, await withDpi(b)));

  // ---------- printing (one or many badges) ----------
  // sheet : A4 precut sticker sheet, 2 columns x 7 rows = 14 stickers of 2.9 x 1.5 in.
  //         Sticker 1 is always the top-left one, then left-to-right, top-to-bottom.
  // label : one 2.9 x 1.5 in sticker per page (label printer).
  const A4 = { w: 8.27, h: 11.69 }, SH_COLS = 2, SH_ROWS = 7, PER_SHEET = SH_COLS * SH_ROWS;
  // default position of the stickers on the A4 sheet (inches) — adjust to match your sticker paper
  const SHEET_DEFAULT = { top: 0.6, left: 1.13, gapX: 0.2, gapY: 0 };
  const getSheet = () => Object.assign({}, SHEET_DEFAULT, lsGet('confcheckin.sheet15') || {});
  const fields = ['top', 'left', 'gapX', 'gapY'];
  const readSheetForm = () => Object.fromEntries(fields.map(f => [f, Math.max(0, Number($('#sh_' + f).value) || 0)]));
  function sheetFits(L) {
    const right = L.left + SH_COLS * BADGE_IN_W + (SH_COLS - 1) * L.gapX, bottom = L.top + SH_ROWS * BADGE_IN_H + (SH_ROWS - 1) * L.gapY;
    return { ok: right <= A4.w + 0.001 && bottom <= A4.h + 0.001, right: A4.w - right, bottom: A4.h - bottom };
  }

  let printList = [];
  function openPrint(people) {
    printList = people.filter(Boolean); if (!printList.length) return;
    const saved = lsGet('confcheckin.paper') || {};
    const radio = document.querySelector(`input[name=paper][value="${saved.paper === 'label' ? 'label' : 'sheet'}"]`);
    if (radio) radio.checked = true;
    $('#prCut').checked = !!saved.cut;
    const L = getSheet(); fields.forEach(f => $('#sh_' + f).value = L[f]);
    $('#prTitle').textContent = `Print ${printList.length} QR badge${printList.length > 1 ? 's' : ''}`;
    updatePrintInfo(); $('#prDlg').showModal();
  }
  function updatePrintInfo() {
    const paper = document.querySelector('input[name=paper]:checked').value, n = printList.length;
    $('#sheetOpts').hidden = paper !== 'sheet';
    const pages = paper === 'sheet' ? Math.ceil(n / PER_SHEET) : n;
    let msg = `${pages} page${pages > 1 ? 's' : ''}`;
    if (paper === 'sheet') {
      const fit = sheetFits(readSheetForm());
      msg += n % PER_SHEET && n > 0 ? ` (last sheet uses stickers 1–${n % PER_SHEET})` : '';
      msg += fit.ok ? `. Right margin ${fit.right.toFixed(2)} in, bottom margin ${fit.bottom.toFixed(2)} in.` : '. <b style="color:var(--bad)">These settings do not fit on A4 — reduce the margins or gaps.</b>';
      msg += ' In the print dialog choose paper <b>A4</b>, <b>Margins: None</b>, <b>Scale: 100%</b> (not “Fit to page”).';
    } else msg += '. In the print dialog choose the 2.9 × 1.5 in label size, <b>Margins: None</b>, <b>Scale: 100%</b>.';
    $('#prInfo').innerHTML = msg;
    $('#prGo').disabled = paper === 'sheet' && !sheetFits(readSheetForm()).ok;
  }
  document.querySelectorAll('input[name=paper]').forEach(r => r.onchange = updatePrintInfo);
  fields.forEach(f => $('#sh_' + f).oninput = updatePrintInfo);
  $('#shCenter').onclick = () => { // centre the 2 x 7 block on the page, keeping the gaps
    const L = readSheetForm();
    $('#sh_left').value = Math.max(0, (A4.w - SH_COLS * BADGE_IN_W - (SH_COLS - 1) * L.gapX) / 2).toFixed(2);
    $('#sh_top').value = Math.max(0, (A4.h - SH_ROWS * BADGE_IN_H - (SH_ROWS - 1) * L.gapY) / 2).toFixed(2);
    updatePrintInfo();
  };
  $('#shReset').onclick = () => { fields.forEach(f => $('#sh_' + f).value = SHEET_DEFAULT[f]); updatePrintInfo(); };
  $('#shTest').onclick = async () => { // numbered outlines only, to hold against a sticker sheet
    const L = readSheetForm(); if (!sheetFits(L).ok) return;
    lsSet('confcheckin.sheet15', L);
    $('#prDlg').close();
    await printSheets(Array.from({ length: PER_SHEET }, (_, i) => `<div class="tslot">${i + 1}</div>`), L, true);
  };
  $('#prCancel').onclick = () => $('#prDlg').close();
  $('#prGo').onclick = async () => {
    const paper = document.querySelector('input[name=paper]:checked').value, cut = $('#prCut').checked;
    lsSet('confcheckin.paper', { paper, cut });
    const L = readSheetForm(); if (paper === 'sheet') lsSet('confcheckin.sheet15', L);
    $('#prDlg').close();
    await printBadges(printList, paper, cut, L);
  };

  let printUrls = [];
  async function printBadges(people, paper, cut, L) {
    if (people.length > 20) toast(`Preparing ${people.length} badges…`);
    printUrls.forEach(u => URL.revokeObjectURL(u)); printUrls = [];
    const cv = document.createElement('canvas');
    for (const p of people) {
      drawBadge(cv, p);
      const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
      printUrls.push(URL.createObjectURL(blob));
    }
    const imgs = printUrls.map(u => `<img src="${u}" alt="">`);
    if (paper === 'label') {
      $('#pageStyle').textContent = `@page{size:${BADGE_IN_W}in ${BADGE_IN_H}in;margin:0}`;
      $('#printArea').innerHTML = imgs.map(i => `<div class="pp" style="width:${BADGE_IN_W}in;height:${BADGE_IN_H}in">${i}</div>`).join('');
      await finishPrint();
    } else await printSheets(imgs, L, cut);
  }
  // place items on A4 pages at exact positions: item 1 = top-left sticker, 2 = top-right, 3 = 2nd row left …
  async function printSheets(items, L, outline) {
    let html = '';
    for (let i = 0; i < items.length; i += PER_SHEET) {
      html += `<div class="pp sheetpage${outline ? ' outline' : ''}" style="width:210mm;height:297mm;position:relative">` +
        items.slice(i, i + PER_SHEET).map((it, j) => {
          const col = j % SH_COLS, row = Math.floor(j / SH_COLS);
          const x = L.left + col * (BADGE_IN_W + L.gapX), y = L.top + row * (BADGE_IN_H + L.gapY);
          return `<div class="slot" style="left:${x.toFixed(3)}in;top:${y.toFixed(3)}in;width:${BADGE_IN_W}in;height:${BADGE_IN_H}in">${it}</div>`;
        }).join('') + '</div>';
    }
    $('#pageStyle').textContent = '@page{size:A4 portrait;margin:0}';
    $('#printArea').innerHTML = html;
    await finishPrint();
  }
  async function finishPrint() {
    await Promise.all([...$('#printArea').querySelectorAll('img')].map(img => img.decode().catch(() => {})));
    window.print();
  }

  let lastReg = null;
  $('#regForm').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#fName').value.trim().replace(/\s+/g, ' ');
    if (!name) return;
    const r = await run({ t: 'add', p: { id: uid(), name, email: $('#fEmail').value.trim(), org: $('#fOrg').value.trim() } });
    if (r.status === 'invalid') return toast('Please enter a name');
    lastReg = r.person;
    toast(r.status === 'dupEmail' ? 'Email already registered — showing existing QR' : 'Registered ' + lastReg.name);
    drawBadge($('#qrCanvas'), lastReg);
    $('#qrOut').style.display = 'block'; $('#regForm').reset();
  });
  $('#dlQR').onclick = () => lastReg && savePng($('#qrCanvas'), lastReg);
  $('#printQR').onclick = () => lastReg && openPrint([lastReg]);
  $('#newReg').onclick = () => { $('#qrOut').style.display = 'none'; $('#fName').focus(); };

  let dlgPerson = null;
  function showQR(id) { dlgPerson = byId(id); if (!dlgPerson) return; drawBadge($('#qrDlgCanvas'), dlgPerson); $('#qrDlg').showModal(); }
  $('#qrDlgDl').onclick = () => dlgPerson && savePng($('#qrDlgCanvas'), dlgPerson);
  $('#qrDlgPrint').onclick = () => { if (dlgPerson) { $('#qrDlg').close(); openPrint([dlgPerson]); } };
  $('#qrDlgClose').onclick = () => $('#qrDlg').close();

  // ---------- check-in ----------
  function parseCode(text) {
    if (!text || !text.startsWith(PREFIX)) return null;
    try { const o = JSON.parse(text.slice(PREFIX.length)); if (o && o.i && o.n) return o; } catch (e) {}
    return null;
  }
  async function checkIn(d) {
    const s = currentSession();
    if (!s) return { kind: 'bad', title: 'No session selected', msg: 'Today is not one of the event days. Pick a session above, or set the dates in Attendees → Event days.' };
    const label = sessLabel(s);
    const r = await run({ t: 'checkin', i: d.i, n: d.n, o: d.o, s });
    if (r.status === 'already') return { kind: 'warn', title: 'Already checked in · ' + label, p: r.person, msg: 'at ' + fmt(r.person.att[s]) };
    if (r.status === 'ok') return { kind: 'ok', title: 'Welcome, ' + r.person.name, p: r.person, msg: `${label} · checked in at ${time(r.person.att[s])}` + (r.added ? ' · added from QR' : '') + ` · ${attended(r.person)}/${sessList().length} sessions` };
    return { kind: 'bad', title: 'Could not check in', msg: r.status === 'badSession' ? 'That session no longer exists. Pick another.' : '' };
  }

  // ---------- sessions (Day 1 AM, Day 1 PM, Day 2 AM, ...) ----------
  const sessList = () => Core.sessions(db);
  const sessLabel = k => { const s = sessList().find(x => x.key === k); return s ? s.label : k; };
  const shortLabel = s => `D${s.day} ${s.half.toUpperCase()}`;
  const dayText = date => date ? new Date(date + 'T00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) : 'date not set';
  const attended = p => sessList().filter(s => p.att[s.key]).length;
  const present = k => db.people.filter(p => p.att[k]).length;
  let sessMode = lsGet('confcheckin.session') || 'auto'; // this device's choice: 'auto' or a session key
  function currentSession() {
    if (sessMode !== 'auto' && sessList().some(s => s.key === sessMode)) return sessMode;
    return Core.sessionAt(db, Date.now());
  }
  function renderSession() {
    const list = sessList(), auto = Core.sessionAt(db, Date.now()), sel = $('#sessSel');
    if (sessMode !== 'auto' && !list.some(s => s.key === sessMode)) sessMode = 'auto';
    sel.innerHTML = `<option value="auto">Auto${auto ? ' — now ' + esc(sessLabel(auto)) : ' (no event day today)'}</option>` +
      list.map(s => `<option value="${s.key}">${esc(s.label)} · ${esc(dayText(s.date))}</option>`).join('');
    sel.value = sessMode;
    const cur = currentSession(), box = $('#sessNow');
    if (cur) {
      const s = list.find(x => x.key === cur);
      box.className = 'sessnow';
      box.innerHTML = `<span><b>${esc(s.label)}</b> <span class="sub">${esc(dayText(s.date))}${sessMode === 'auto' ? ' · auto' : ''}</span></span><span>${present(cur)} / ${db.people.length} present</span>`;
    } else {
      box.className = 'sessnow bad';
      box.innerHTML = `<span>${db.days.some(Boolean) ? 'Today is not an event day.' : 'Event dates are not set.'} Pick a session above${db.days.some(Boolean) ? '' : ', or set the dates in Attendees → Event days'}.</span>`;
    }
  }
  $('#sessSel').onchange = e => { sessMode = e.target.value; lsSet('confcheckin.session', sessMode); render(); };
  setInterval(() => { if (sessMode === 'auto') render(); }, 30000); // auto mode switches AM -> PM at the cutoff

  // ---------- event days form ----------
  let daysDirty = false;
  function renderDaysForm(force) {
    if (daysDirty && !force) return;
    const n = db.days.length;
    $('#dayCount').innerHTML = Array.from({ length: Core.MAX_DAYS }, (_, i) => `<option value="${i + 1}">${i + 1} day${i ? 's' : ''}</option>`).join('');
    $('#dayCount').value = n; $('#cutoff').value = db.cutoff;
    drawDayInputs(db.days);
  }
  function drawDayInputs(dates) {
    $('#dayDates').innerHTML = dates.map((d, i) => `<div><label for="day${i}">Day ${i + 1} date</label><input type="date" id="day${i}" value="${esc(d)}"></div>`).join('');
  }
  const formDates = () => [...document.querySelectorAll('#dayDates input')].map(x => x.value);
  $('#dayCount').onchange = () => {
    daysDirty = true;
    const n = Number($('#dayCount').value), dates = formDates().slice(0, n);
    while (dates.length < n) { // suggest the day after the previous one
      const prev = dates[dates.length - 1]; let next = '';
      if (prev) { const d = new Date(prev + 'T12:00'); d.setDate(d.getDate() + 1); next = d.toISOString().slice(0, 10); }
      dates.push(next);
    }
    drawDayInputs(dates);
  };
  $('#daysCard').addEventListener('input', () => { daysDirty = true; });
  $('#saveDays').onclick = async () => {
    const days = formDates(), cutoff = $('#cutoff').value || '12:00';
    const filled = days.filter(Boolean);
    if (new Set(filled).size !== filled.length) return toast('Two days have the same date');
    const dropped = sessList().filter(s => s.day > days.length && present(s.key)).length;
    if (dropped && !(await confirmBox(`Removing days hides attendance already recorded for ${dropped} session(s). It is kept in the data file and shows again if you add the days back. Continue?`))) return;
    await run({ t: 'settings', days, cutoff });
    daysDirty = false; renderDaysForm(true); toast('Event days saved');
  };
  function showResult(r) {
    const el = $('#result');
    el.className = 'result ' + r.kind; void el.offsetWidth; el.classList.add('flash');
    const sub = r.p ? [r.p.org, r.p.id].filter(Boolean).join(' · ') : '';
    el.innerHTML = `<b>${esc(r.title)}</b><span>${esc(r.msg || '')}</span>${sub ? `<div class="note" style="margin:4px 0 0">${esc(sub)}</div>` : ''}`;
    feedback(r.kind);
  }
  async function handleText(text) {
    const d = parseCode(text);
    showResult(d ? await checkIn(d) : { kind: 'bad', title: 'Not a valid attendee QR', msg: text.length > 60 ? text.slice(0, 60) + '…' : text });
  }

  let actx;
  function feedback(kind) {
    try { navigator.vibrate && navigator.vibrate(kind === 'ok' ? 80 : [60, 60, 60]); } catch (e) {}
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = kind === 'ok' ? 880 : kind === 'warn' ? 520 : 220;
      g.gain.setValueAtTime(.15, actx.currentTime); g.gain.exponentialRampToValueAtTime(.001, actx.currentTime + .18);
      o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + .2);
    } catch (e) {}
  }

  // ---------- camera scanner ----------
  const video = $('#video'), work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
  let stream = null, raf = 0, lastCode = '', lastAt = 0, busy = false;

  if (!window.isSecureContext) {
    $('#camNote').textContent = 'Live camera needs HTTPS or localhost. On this address, use “Scan photo” — it opens your phone camera. (See README for HTTPS.)';
  }

  async function startCam(deviceId) {
    stopCam();
    if (!navigator.mediaDevices?.getUserMedia) { toast('Camera not available here — use Scan photo'); return; }
    try {
      const want = deviceId || lsGet('confcheckin.cam');
      const size = { width: { ideal: 1280 }, height: { ideal: 1280 } };
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: want ? { deviceId: { exact: want }, ...size } : { facingMode: { ideal: 'environment' }, ...size } }); }
      catch (e) { if (!want || e.name === 'NotAllowedError') throw e; stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, ...size } }); }
      if (deviceId) lsSet('confcheckin.cam', deviceId);
    } catch (e) {
      $('#idle').textContent = e.name === 'NotAllowedError' ? 'Camera permission denied. Allow it in your browser settings.' : 'Could not open camera: ' + e.message;
      return;
    }
    video.srcObject = stream; await video.play().catch(() => {});
    $('#idle').hidden = true; $('#frame').hidden = false; $('#camBtn').textContent = 'Stop camera';
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {}
    listCams(stream.getVideoTracks()[0]?.getSettings().deviceId);
    raf = requestAnimationFrame(tick);
  }
  function stopCam() {
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    $('#idle').hidden = false; $('#idle').textContent = 'Camera is off'; $('#frame').hidden = true; $('#camBtn').textContent = 'Start camera';
  }
  async function listCams(current) {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const sel = $('#camSel');
      if (!cams.length || !cams[0].label) { sel.style.display = 'none'; return; } // labels appear after permission
      sel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || 'Camera ' + (i + 1))}</option>`).join('');
      if (current) sel.value = current;
      sel.style.display = '';
    } catch (e) {}
  }
  $('#camSel').onchange = e => startCam(e.target.value);
  // a phone connected as a webcam (Windows Phone Link, Mac Continuity Camera, DroidCam…) shows up here when it connects
  try { navigator.mediaDevices.addEventListener('devicechange', () => listCams(stream?.getVideoTracks()[0]?.getSettings().deviceId)); } catch (e) {}
  $('#camBtn').onclick = () => stream ? stopCam() : startCam();

  // ---------- Bluetooth / USB scanner (keyboard input) ----------
  // A phone app such as "Bluetooth QR & Barcode to PC", or a QR scanner gun, "types" the QR text followed by Enter.
  // Keyboard layouts can change symbols like | { " so the ID is found leniently.
  let scanMode = lsGet('confcheckin.scanmode') || 'camera';
  function setScanMode(m) {
    scanMode = m; lsSet('confcheckin.scanmode', m);
    document.querySelectorAll('#scanModes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#wedgeBox').hidden = m !== 'wedge'; $('#camBox').hidden = m === 'wedge'; $('#camNote').hidden = m === 'wedge';
    if (m === 'wedge') { stopCam(); if ($('#scan').classList.contains('on')) $('#wedgeIn').focus(); }
    wedgeState();
  }
  document.querySelectorAll('#scanModes button').forEach(b => b.onclick = () => setScanMode(b.dataset.mode));
  const wedgeIn = $('#wedgeIn');
  function wedgeState() {
    const ready = scanMode === 'wedge' && document.activeElement === wedgeIn && document.hasFocus();
    $('#wedgeBox').classList.toggle('ready', ready);
    $('#wedgeSt').textContent = ready ? 'Ready — scan a badge' : 'Click here to activate the scanner';
  }
  $('#wedgeBox').onclick = () => wedgeIn.focus();
  wedgeIn.addEventListener('focus', wedgeState); wedgeIn.addEventListener('blur', wedgeState);
  window.addEventListener('focus', wedgeState); window.addEventListener('blur', wedgeState);
  let wedgeTimer;
  function wedgeSubmit() {
    clearTimeout(wedgeTimer);
    const text = wedgeIn.value.trim(); wedgeIn.value = '';
    if (text) handleLoose(text);
  }
  wedgeIn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); wedgeSubmit(); } });
  // some scanners send no Enter: submit once a complete code has been typed and input pauses
  wedgeIn.addEventListener('input', () => { clearTimeout(wedgeTimer); if (/^conf1.*[}\]]\s*$/i.test(wedgeIn.value.trim())) wedgeTimer = setTimeout(wedgeSubmit, 250); });
  // typing anywhere on the Scan tab goes into the scanner box
  document.addEventListener('keydown', e => {
    if (scanMode !== 'wedge' || !$('#scan').classList.contains('on') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = document.activeElement;
    if (t === wedgeIn || (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) || document.querySelector('dialog[open]')) return;
    if (e.key.length === 1) wedgeIn.focus();
  }, true);

  const ID_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  function handleLoose(text) {
    const exact = parseCode(text);
    if (exact && byId(exact.i)) return handleText(text);
    // find the ID even if the keyboard layout changed the symbols around it, e.g. CONF1~@i@:@ABC123@...
    const m = text.match(/i\W{1,4}([A-HJ-NP-Z2-9]{6})(?![A-Za-z0-9])/i) || text.match(/^\s*([A-HJ-NP-Z2-9]{6})\s*$/i);
    const id = m && m[1].toUpperCase(), p = id && byId(id);
    if (p) return checkIn({ i: p.id, n: p.name }).then(showResult);
    if (exact) return handleText(text); // valid badge from another device, not in this list yet
    showResult({ kind: 'bad', title: id ? 'Unknown ID ' + id : 'Not a valid attendee QR', msg: id ? 'This badge is not in the attendee list.' : (text.length > 60 ? text.slice(0, 60) + '…' : text) });
  }

  // ---------- live feed: latest check-ins in this session, from every device ----------
  let seenFeed = null;
  function renderRecent() {
    const cur = currentSession(), box = $('#recent');
    if (!cur) { box.innerHTML = ''; return; }
    const list = db.people.filter(p => p.att[cur]).sort((a, b) => b.att[cur] - a.att[cur]).slice(0, 8);
    const keys = list.map(p => p.id + p.att[cur]);
    box.innerHTML = list.length ? `<div class="rh">Latest check-ins · ${esc(sessLabel(cur))}</div><ol>` + list.map((p, i) =>
      `<li class="${seenFeed && !seenFeed.has(keys[i]) ? 'new' : ''}"><span class="t">${esc(time(p.att[cur]))}</span><span>${esc(p.name)}${p.org ? ` <span class="sub">· ${esc(p.org)}</span>` : ''}</span></li>`).join('') + '</ol>' : '';
    seenFeed = new Set(keys);
  }

  function decode(source, w, h) {
    const s = Math.min(1, 720 / Math.max(w, h));
    work.width = Math.round(w * s); work.height = Math.round(h * s);
    wctx.drawImage(source, 0, 0, work.width, work.height);
    const img = wctx.getImageData(0, 0, work.width, work.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  }
  function tick() {
    if (!stream) return;
    if (video.readyState >= 2 && !busy) {
      const code = decode(video, video.videoWidth, video.videoHeight);
      if (code && code.data) {
        const now = Date.now();
        if (code.data !== lastCode || now - lastAt > 4000) { // ignore the same code held in front of the camera
          lastCode = code.data; lastAt = now; busy = true;
          handleText(code.data).finally(() => setTimeout(() => busy = false, 1200));
        }
      }
    }
    raf = requestAnimationFrame(tick);
  }

  $('#photoIn').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const code = decode(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(img.src);
      code ? handleText(code.data) : showResult({ kind: 'bad', title: 'No QR code found', msg: 'Try again closer, with the code in focus.' });
    };
    img.src = URL.createObjectURL(f);
  };

  $('#manualForm').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('#manualIn').value.trim().toLowerCase(); if (!q) return;
    const hits = db.people.filter(p => p.id.toLowerCase() === q || p.name.toLowerCase().includes(q));
    if (hits.length === 1) { const p = hits[0]; showResult(await checkIn({ i: p.id, n: p.name })); $('#manualIn').value = ''; }
    else showResult({ kind: 'bad', title: hits.length ? hits.length + ' matches' : 'No match', msg: hits.length ? 'Be more specific, or use the Attendees tab.' : 'Check the spelling or register them first.' });
  });

  // ---------- attendee list ----------
  const selected = new Set();
  let shownIds = [];
  function render() {
    for (const id of selected) if (!byId(id)) selected.delete(id);
    const total = db.people.length, list = sessList(), cur = currentSession();
    $('#stats').textContent = cur ? `${sessLabel(cur)}: ${present(cur)} / ${total} present` : `${total} registered`;
    if (document.activeElement !== ev) ev.textContent = db.event;
    renderSession(); renderDaysForm(); renderRecent();

    // per-session counters (click one to list who is present in it)
    $('#sessStats').innerHTML = list.map(s => `<button class="sbox${s.key === cur ? ' cur' : ''}" data-f="in:${s.key}">
      <div class="k">${esc(s.label)} · ${esc(dayText(s.date))}</div><div class="v">${present(s.key)} <small>/ ${total}</small></div></button>`).join('');

    // filter options follow the sessions
    const fSel = $('#filter'), prevF = fSel.value || 'all';
    const opts = [['all', 'Everyone'], ...list.flatMap(s => [[`in:${s.key}`, `Present · ${s.label}`], [`out:${s.key}`, `Absent · ${s.label}`]]), ['full', 'Attended all sessions'], ['partial', 'Missed a session'], ['none', 'No attendance yet']];
    fSel.innerHTML = opts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
    fSel.value = opts.some(o => o[0] === prevF) ? prevF : 'all';
    const rSel = $('#resetSel'), prevR = rSel.value;
    rSel.innerHTML = '<option value="">All sessions</option>' + list.map(s => `<option value="${s.key}">${esc(s.label)}</option>`).join('');
    if (list.some(s => s.key === prevR)) rSel.value = prevR;

    const q = $('#search').value.trim().toLowerCase(), f = fSel.value, [fk, fs] = f.split(':');
    const last = p => Math.max(0, ...list.map(s => p.att[s.key] || 0));
    const rows = db.people
      .filter(p => fk === 'all' || (fk === 'in' ? p.att[fs] : fk === 'out' ? !p.att[fs] : fk === 'full' ? attended(p) === list.length : fk === 'partial' ? attended(p) < list.length : attended(p) === 0))
      .filter(p => !q || [p.name, p.email, p.org, p.id].some(v => (v || '').toLowerCase().includes(q)))
      .sort((a, b) => (fk === 'in' ? (b.att[fs] || 0) - (a.att[fs] || 0) : last(b) - last(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    shownIds = rows.map(p => p.id);
    $('#tbody').innerHTML = rows.length ? rows.map(p => `
      <tr>
        <td class="ck"><input type="checkbox" data-sel="${esc(p.id)}"${selected.has(p.id) ? ' checked' : ''} aria-label="Select ${esc(p.name)}"></td>
        <td><div>${esc(p.name)}</div><div class="sub">${esc([p.org, p.email, p.id].filter(Boolean).join(' · '))}</div></td>
        <td><div class="chips">${list.map(s => `<button class="chip${p.att[s.key] ? ' on' : ''}${s.key === cur ? ' cur' : ''}" data-a="tog" data-s="${s.key}" data-id="${esc(p.id)}" title="${esc(s.label)}: ${p.att[s.key] ? 'checked in ' + esc(fmt(p.att[s.key])) : 'not yet — click to check in'}">${p.att[s.key] ? '✓ ' : ''}${shortLabel(s)}</button>`).join('')}</div></td>
        <td class="act">
          <button class="btn ghost sm" data-a="qr" data-id="${esc(p.id)}">QR</button>
          <button class="btn ghost sm danger" data-a="del" data-id="${esc(p.id)}" aria-label="Delete">✕</button>
        </td>
      </tr>`).join('') : `<tr><td colspan="4" class="empty">${total ? 'No matches' : 'No registrations yet'}</td></tr>`;
    renderSel();
  }
  function renderSel() {
    const n = selected.size, shownSel = shownIds.filter(id => selected.has(id)).length, all = $('#selAll');
    all.checked = shownIds.length > 0 && shownSel === shownIds.length;
    all.indeterminate = shownSel > 0 && shownSel < shownIds.length;
    $('#selBar').classList.toggle('on', n > 0);
    $('#selCount').textContent = `${n} selected`;
  }
  $('#tbody').addEventListener('change', e => {
    const id = e.target.dataset.sel; if (!id) return;
    e.target.checked ? selected.add(id) : selected.delete(id); renderSel();
  });
  $('#selAll').onchange = e => { shownIds.forEach(id => e.target.checked ? selected.add(id) : selected.delete(id)); render(); };
  $('#selClear').onclick = () => { selected.clear(); render(); };
  $('#selPrint').onclick = () => openPrint(db.people.filter(p => selected.has(p.id)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
  $('#search').oninput = render; $('#filter').onchange = render;
  $('#sessStats').addEventListener('click', e => { const b = e.target.closest('[data-f]'); if (b) { $('#filter').value = $('#filter').value === b.dataset.f ? 'all' : b.dataset.f; render(); } });
  $('#tbody').addEventListener('click', async e => {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const p = byId(b.dataset.id); if (!p) return;
    if (b.dataset.a === 'qr') showQR(p.id);
    if (b.dataset.a === 'tog') {
      const s = b.dataset.s;
      if (p.att[s] && !(await confirmBox(`Remove ${p.name}'s check-in for ${sessLabel(s)}?`))) return;
      await run({ t: 'set', i: p.id, s, value: p.att[s] ? null : Date.now() });
    }
    if (b.dataset.a === 'del' && await confirmBox(`Delete ${p.name}?`)) await run({ t: 'del', i: p.id });
  });

  // ---------- export / import ----------
  const iso = t => t ? new Date(t).toLocaleString() : '';
  const csvCell = v => /[",\n]/.test(v = String(v ?? '')) ? `"${v.replace(/"/g, '""')}"` : v;
  $('#csvBtn').onclick = () => {
    const list = sessList();
    const head = ['ID', 'Name', 'Email', 'Organization', 'Registered', ...list.map(s => `${s.label}${s.date ? ' (' + s.date + ')' : ''}`), 'Sessions attended', 'Total sessions'];
    const lines = [head, ...db.people.map(p => [p.id, p.name, p.email, p.org, iso(p.registeredAt), ...list.map(s => iso(p.att[s.key])), attended(p), list.length])].map(r => r.map(csvCell).join(','));
    download(`${slug(db.event)}_attendance.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
  };
  $('#backupBtn').onclick = () => download(`${slug(db.event)}_backup.json`, JSON.stringify(db, null, 2), 'application/json');
  $('#restoreIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const d = JSON.parse(await f.text()); if (!Array.isArray(d.people)) throw 0;
      const r = await run({ t: 'merge', people: d.people, event: d.event, days: d.days, cutoff: d.cutoff });
      toast(`Merged: ${r.added} added, ${r.updated} check-ins updated`);
    } catch (err) { toast('Invalid backup file'); }
  };
  $('#resetIn').onclick = async () => {
    const s = $('#resetSel').value;
    if (await confirmBox(`Clear check-ins for ${s ? sessLabel(s) : 'ALL sessions'}? Registrations are kept.`)) await run(s ? { t: 'reset', s } : { t: 'reset' });
  };
  $('#wipe').onclick = async () => { if (await confirmBox('Delete ALL registrations and attendance? Make a backup first.')) await run({ t: 'wipe' }); };

  // ---------- bulk upload (CSV / Excel) ----------
  let xlsxLoading;
  function loadXlsx() { // spreadsheet reader is only loaded when needed
    if (window.XLSX) return Promise.resolve();
    return xlsxLoading = xlsxLoading || new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'lib/xlsx.mini.min.js';
      s.onload = res; s.onerror = () => { xlsxLoading = null; rej(new Error('Could not load lib/xlsx.mini.min.js')); };
      document.head.appendChild(s);
    });
  }
  async function readTable(file) {
    await loadXlsx();
    const wb = /\.csv$/i.test(file.name) || file.type === 'text/csv'
      ? XLSX.read((await file.text()).replace(/^\ufeff/, ''), { type: 'string', raw: true })
      : XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
  }
  // recognised column headings (compared lowercase, letters only)
  const COLS = {
    name:  ['name', 'fullname', 'completename', 'participant', 'participantname', 'attendee', 'attendeename', 'nameofparticipant', 'registrant', 'pangalan'],
    first: ['firstname', 'givenname', 'first', 'fname'],
    middle:['middlename', 'middleinitial', 'mi', 'middle'],
    last:  ['lastname', 'surname', 'familyname', 'last', 'lname'],
    suffix:['suffix', 'ext', 'nameextension', 'extension'],
    email: ['email', 'emailaddress', 'mail', 'eaddress'],
    org:   ['organization', 'organisation', 'org', 'company', 'school', 'institution', 'affiliation', 'agency', 'office', 'university', 'companyname', 'schoolname', 'employer'],
  };
  const keyOf = h => String(h).toLowerCase().replace(/[^a-z]/g, '');
  function mapColumns(rows) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) { // header may not be the very first row
      const map = {};
      rows[r].forEach((h, i) => { const k = keyOf(h); for (const f in COLS) if (map[f] == null && COLS[f].includes(k)) map[f] = i; });
      if (map.name != null || map.first != null || map.last != null) return { headerRow: r, map };
    }
    return null;
  }
  const clean = v => String(v ?? '').trim().replace(/\s+/g, ' ');
  let importRows = [];
  async function startImport(file) {
    if (!file) return;
    let rows;
    try { rows = await readTable(file); }
    catch (e) { return toast('Could not read file: ' + e.message); }
    const found = mapColumns(rows);
    if (!found) return toast('No "Name" column found. Use the template headings: Name, Email, Organization');
    const { headerRow, map } = found, cell = (row, f) => map[f] == null ? '' : clean(row[map[f]]);
    const emails = new Set(db.people.filter(p => p.email).map(p => p.email.toLowerCase()));
    const nameOrg = new Set(db.people.map(p => (p.name + '|' + p.org).toLowerCase()));
    importRows = rows.slice(headerRow + 1).map(row => {
      let name = cell(row, 'name');
      if (!name) {
        const mid = cell(row, 'middle');
        name = [cell(row, 'first'), mid && mid.length <= 2 ? mid.replace(/\.?$/, '.') : mid, cell(row, 'last'), cell(row, 'suffix')].filter(Boolean).join(' ');
      }
      const email = cell(row, 'email'), org = cell(row, 'org');
      let skip = '';
      if (!name) skip = 'no name';
      if (!skip && email && emails.has(email.toLowerCase())) skip = 'email already registered';
      if (!skip && !email && nameOrg.has((name + '|' + org).toLowerCase())) skip = 'already registered';
      if (!skip) { if (email) emails.add(email.toLowerCase()); nameOrg.add((name + '|' + org).toLowerCase()); }
      return { name, email, org, skip };
    }).filter(r => r.name || r.email || r.org);
    const ok = importRows.filter(r => !r.skip).length, skipped = importRows.length - ok;
    $('#impTitle').textContent = `Import from ${file.name}`;
    $('#impSummary').textContent = `${ok} new registrant${ok === 1 ? '' : 's'}` + (skipped ? ` · ${skipped} skipped (duplicates or missing name)` : '') +
      ` · columns used: ${Object.keys(map).map(f => `${f} = "${rows[headerRow][map[f]]}"`).join(', ')}`;
    const show = importRows.slice(0, 300);
    $('#impBody').innerHTML = show.map(r => `<tr class="${r.skip ? 'skip' : ''}"><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.org)}</td><td class="sub" style="text-decoration:none">${esc(r.skip)}</td></tr>`).join('') +
      (importRows.length > show.length ? `<tr><td colspan="4" class="sub">…and ${importRows.length - show.length} more rows</td></tr>` : '');
    $('#impGo').disabled = !ok; $('#impGo').textContent = ok ? `Import ${ok}` : 'Nothing to import';
    $('#impDlg').showModal();
  }
  $('#impCancel').onclick = () => $('#impDlg').close();
  $('#impGo').onclick = async () => {
    const used = new Set(), newId = () => { let id; do { id = uid(); } while (used.has(id)); used.add(id); return id; };
    const ops = importRows.filter(r => !r.skip).map(r => ({ t: 'add', p: { id: newId(), name: r.name, email: r.email, org: r.org } }));
    $('#impGo').disabled = true;
    const results = await runBatch(ops);
    $('#impDlg').close();
    const added = results.filter(r => r.status === 'added').map(r => r.person);
    toast(`Imported ${added.length} registrant${added.length === 1 ? '' : 's'}`);
    if ($('#impPrint').checked && added.length) {
      selected.clear(); added.forEach(p => selected.add(p.id));
      $('#search').value = ''; $('#filter').value = 'all';
      showTab('list'); render();
    }
  };
  $('#bulkIn').onchange = e => { const f = e.target.files[0]; e.target.value = ''; startImport(f); };
  const drop = $('#drop');
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); startImport(e.dataTransfer.files[0]); });
  $('#tplBtn').onclick = () => download('registrants_template.csv',
    '\ufeffName,Email,Organization\r\nJuan Dela Cruz,juan@example.com,UP Diliman\r\nMaria Santos,maria@example.com,Ateneo de Manila University\r\n', 'text/csv');

  // ---------- init ----------
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCam(); else sync(); });
  const h = location.hash.slice(1); if (['register', 'scan', 'list'].includes(h)) showTab(h);
  setScanMode(scanMode);
  initStore().then(() => { render(); setStatus(); });
})();
