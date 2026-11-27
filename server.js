#!/usr/bin/env node
/*
 * Conference Check-in — local server
 * Serves the app and stores all data in a JSON file on this computer.
 * No npm packages needed. Requires Node.js 16+.
 *
 *   node server.js                         -> data saved to ./data.json, http://localhost:8080
 *   node server.js --data D:\event\db.json --port 9000
 *
 * If key.pem and cert.pem exist in this folder, an HTTPS server also starts
 * on port 8443 (needed for the live camera on phones). See README.md.
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Core = require('./core.js');

// ---------- settings ----------
const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : def; };
const ROOT = __dirname;
const PORT = Number(arg('port', process.env.PORT || 8080));
const HTTPS_PORT = Number(arg('https-port', process.env.HTTPS_PORT || 8443));
const DATA_FILE = path.resolve(arg('data', process.env.DATA_FILE || path.join(ROOT, 'data.json')));

// ---------- JSON file database ----------
let db = Core.emptyDb(), version = 0, lastMtime = 0;

function load() {
  if (!fs.existsSync(DATA_FILE)) { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); write(); return; }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  try { db = Core.normalize(raw.trim() ? JSON.parse(raw) : {}); }
  catch (e) {
    const bad = DATA_FILE + '.corrupt-' + Date.now();
    fs.copyFileSync(DATA_FILE, bad);
    console.error(`! ${DATA_FILE} is not valid JSON. Copied it to ${bad} and starting with an empty database.`);
    db = Core.emptyDb(); write();
  }
  lastMtime = fs.statSync(DATA_FILE).mtimeMs; version++;
}
function write() {
  // write to a temp file then rename, so the JSON file is never left half-written
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  lastMtime = fs.statSync(DATA_FILE).mtimeMs; version++;
}
function reloadIfEditedByHand() {
  try { if (fs.statSync(DATA_FILE).mtimeMs !== lastMtime) { load(); console.log('↻ data file changed on disk — reloaded'); } }
  catch (e) { write(); } // file was deleted: recreate it from memory
}

load();
if (db.people.length) { // one safety copy each time the server starts
  fs.copyFileSync(DATA_FILE, DATA_FILE.replace(/\.json$/i, '') + '.backup.json');
}

// ---------- HTTP ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/lib/qrcode.js': ['lib/qrcode.js', 'text/javascript; charset=utf-8'],
  '/lib/jsQR.js': ['lib/jsQR.js', 'text/javascript; charset=utf-8'],
  '/lib/xlsx.mini.min.js': ['lib/xlsx.mini.min.js', 'text/javascript; charset=utf-8'],
  '/lib/firebase.js': ['lib/firebase.js', 'text/javascript; charset=utf-8'],
  '/cloud.js': ['cloud.js', 'text/javascript; charset=utf-8'],
  '/firebase-config.js': ['firebase-config.js', 'text/javascript; charset=utf-8'],
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 10e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/data' && req.method === 'GET') {
      reloadIfEditedByHand();
      return send(res, 200, { version, db, file: DATA_FILE });
    }
    if (url.pathname === '/api/version' && req.method === 'GET') {
      reloadIfEditedByHand();
      return send(res, 200, { version });
    }
    if (url.pathname === '/api/ops' && req.method === 'POST') {
      reloadIfEditedByHand();
      const ops = JSON.parse(await readBody(req));
      if (!Array.isArray(ops)) return send(res, 400, { error: 'expected an array of ops' });
      const results = ops.map(o => Core.applyOp(db, o));
      write();
      for (const [i, r] of results.entries()) {
        if (ops[i].t === 'checkin' && r.status === 'ok') console.log(`✓ ${new Date().toLocaleTimeString()}  ${r.person.name} (${r.person.id})`);
        if (ops[i].t === 'add' && r.status === 'added') console.log(`+ registered ${r.person.name} (${r.person.id})`);
      }
      return send(res, 200, { version, db, results });
    }
    const file = STATIC[url.pathname];
    if (file && req.method === 'GET') return send(res, 200, fs.readFileSync(path.join(ROOT, file[0])), file[1]);
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message });
  }
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
}

http.createServer(handler).listen(PORT, () => {
  console.log('\nConference Check-in server');
  console.log('  Data file : ' + DATA_FILE);
  console.log(`  This PC   : http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  Same Wi-Fi: http://${ip}:${PORT}`);
});

const KEY = path.join(ROOT, 'key.pem'), CERT = path.join(ROOT, 'cert.pem');
if (fs.existsSync(KEY) && fs.existsSync(CERT)) {
  https.createServer({ key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }, handler).listen(HTTPS_PORT, () => {
    for (const ip of lanAddresses()) console.log(`  Phones (camera): https://${ip}:${HTTPS_PORT}`);
    console.log('');
  });
} else {
  console.log('  (No key.pem/cert.pem — HTTPS for phone cameras is off. See README.md)\n');
}
