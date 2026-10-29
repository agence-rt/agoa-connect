'use strict';
/*
 * CONNECT — serveur de signalisation.
 * Chaque poste s'identifie par un prénom (unique parmi les postes en ligne).
 * Le serveur met deux postes en relation (prénom + code) puis relaie les
 * messages WebRTC. Il ne voit jamais l'écran : image et commandes passent
 * en direct entre les postes (ou via un relais TURN).
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const AGENCY_KEY = process.env.AGENCY_KEY || '';   // clé commune des postes de l'agence (vide = ouvert, pour les essais)

let ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.ICE_SERVERS) {
  try { ICE = JSON.parse(process.env.ICE_SERVERS); }
  catch { console.error('ICE_SERVERS : JSON invalide, valeur ignorée'); }
}
if (!AGENCY_KEY) console.warn('AGENCY_KEY non définie : tout client peut se connecter. À définir avant une mise en ligne.');

const NAME_RE = /^\p{L}[\p{L}\p{N} '’-]{0,29}$/u;
const CODE_RE = /^[A-Z0-9]{6}$/;
const INST_RE = /^[\w-]{8,64}$/;

// « Éléonore » et « eleonore » désignent le même poste.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();

const peers = new Map();   // prénom normalisé -> poste
const fails = new Map();   // ip -> { n, t }

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function send(p, obj) { if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function isBlocked(ip) { const f = fails.get(ip); return !!f && f.n >= 5 && Date.now() - f.t < 60000; }
function addFail(ip) {
  const f = fails.get(ip), now = Date.now();
  if (!f || now - f.t >= 60000) fails.set(ip, { n: 1, t: now }); else f.n++;
}

// Liste des postes en ligne, envoyée aux postes authentifiés à chaque changement.
let rosterT = null;
function scheduleRoster() {
  if (rosterT) return;
  rosterT = setTimeout(() => {
    rosterT = null;
    const list = [...peers.values()].map((p) => ({ name: p.name, busy: !!(p.link || p.pendingFrom || p.pendingTo) }));
    peers.forEach((p) => send(p, { t: 'peers', list }));
  }, 100);
}

// Termine tout appel ou toute session en cours pour ce poste.
function release(p) {
  if (p.link) {
    const o = peers.get(p.link);
    if (o) { send(o, { t: 'bye', from: p.name }); o.link = null; }
    p.link = null;
  }
  if (p.pendingTo) {
    const o = peers.get(p.pendingTo);
    if (o && o.pendingFrom === p.id) { o.pendingFrom = null; send(o, { t: 'bye', from: p.name }); }
    p.pendingTo = null;
  }
  if (p.pendingFrom) {
    const o = peers.get(p.pendingFrom);
    if (o && o.pendingTo === p.id) { o.pendingTo = null; send(o, { t: 'reply', from: p.name, ok: false, reason: 'gone' }); }
    p.pendingFrom = null;
  }
  scheduleRoster();
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, online: peers.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('CONNECT : serveur de signalisation\n');
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  const fwd = TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || req.socket.remoteAddress || 'inconnu';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const me = ws.peer;

    if (m.t === 'hello') {
      if (me) return;
      if (isBlocked(ip)) { send({ ws }, { t: 'error', reason: 'blocked' }); return; }
      if (AGENCY_KEY && (typeof m.key !== 'string' || !safeEq(AGENCY_KEY, m.key))) {
        addFail(ip); send({ ws }, { t: 'forbidden' }); setTimeout(() => ws.close(), 200); return;
      }
      const name = String(m.name || '').normalize('NFC').trim().replace(/\s+/g, ' ');
      if (!NAME_RE.test(name) || !CODE_RE.test(m.code) || !INST_RE.test(String(m.inst || ''))) { send({ ws }, { t: 'error', reason: 'invalid' }); return; }
      const id = norm(name);
      const old = peers.get(id);
      if (old && old.ws !== ws) {
        // Même installation qui se reconnecte : on reprend la place. Sinon le prénom est pris.
        if (old.ws.readyState === 1 && old.inst !== m.inst) { send({ ws }, { t: 'idtaken' }); return; }
        release(old); peers.delete(id);
        try { old.ws.terminate(); } catch { /* ignoré */ }
      }
      const p = { id, name, inst: m.inst, code: m.code, ws, ip, link: null, pendingTo: null, pendingFrom: null };
      ws.peer = p;
      peers.set(id, p);
      send(p, { t: 'welcome', ice: ICE });
      scheduleRoster();
      return;
    }
    if (!me) return;

    switch (m.t) {
      case 'code':
        if (CODE_RE.test(m.code)) me.code = m.code;
        break;

      case 'call': {
        if (me.link || me.pendingTo) { send(me, { t: 'reply', from: m.to, ok: false, reason: 'busy' }); break; }
        if (isBlocked(me.ip)) { send(me, { t: 'reply', from: m.to, ok: false, reason: 'blocked' }); break; }
        const target = peers.get(norm(m.to));
        if (!target || target === me) { addFail(me.ip); send(me, { t: 'reply', from: m.to, ok: false, reason: 'offline' }); break; }
        if (!target.code || typeof m.code !== 'string' || !safeEq(target.code, m.code.toUpperCase())) {
          addFail(me.ip); send(me, { t: 'reply', from: target.name, ok: false, reason: 'badcode' }); break;
        }
        if (target.link || target.pendingFrom || target.pendingTo) { send(me, { t: 'reply', from: target.name, ok: false, reason: 'busy' }); break; }
        target.code = null; // code à usage unique
        target.pendingFrom = me.id; me.pendingTo = target.id;
        send(target, { t: 'codeused' });
        send(target, { t: 'incoming', from: me.name, mode: m.mode === 'control' ? 'control' : 'present' });
        send(me, { t: 'ringing', to: target.name });
        scheduleRoster();
        break;
      }

      case 'reply': {
        const key = norm(m.to);
        if (!me.pendingFrom || me.pendingFrom !== key) break;
        const ini = peers.get(key);
        me.pendingFrom = null;
        if (!ini || ini.pendingTo !== me.id) break;
        ini.pendingTo = null;
        if (m.ok) {
          me.link = ini.id; ini.link = me.id;
          send(ini, { t: 'reply', from: me.name, ok: true, control: !!m.control });
        } else {
          send(ini, { t: 'reply', from: me.name, ok: false, reason: 'refused' });
        }
        scheduleRoster();
        break;
      }

      case 'signal': {
        if (!me.link || me.link !== norm(m.to)) break;
        send(peers.get(me.link), { t: 'signal', from: me.name, data: m.data });
        break;
      }

      case 'bye':
        release(me);
        break;
    }
  });

  ws.on('close', () => {
    const p = ws.peer;
    if (!p) return;
    release(p);
    if (peers.get(p.id) === p) peers.delete(p.id);
    scheduleRoster();
  });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  fails.forEach((f, ip) => { if (now - f.t > 120000) fails.delete(ip); });
}, 30000).unref();

server.listen(PORT, () => console.log('Serveur de signalisation sur le port ' + PORT));
