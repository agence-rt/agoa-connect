'use strict';
/*
 * CONNECT — cœur de signalisation (partagé).
 * Utilisé de deux façons :
 *   - par server.js : serveur Internet central (les postes s'y connectent) ;
 *   - par chaque poste CONNECT : « hub » local, à l'écoute sur le réseau privé
 *     (VPN) uniquement, pour que les autres postes se connectent en direct.
 * Chaque poste s'identifie par un prénom (unique parmi les postes en ligne).
 * Le hub met deux postes en relation (prénom + code) puis relaie les messages
 * WebRTC. Il ne voit jamais l'écran.
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const NAME_RE = /^\p{L}[\p{L}\p{N} '’-]{0,29}$/u;
const CODE_RE = /^[A-Z0-9]{6}$/;
const INST_RE = /^[\w-]{8,64}$/;

// « Éléonore » et « eleonore » désignent le même poste.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/**
 * opts.key         clé commune de l'agence (vide = ouvert)
 * opts.ice         serveurs ICE transmis aux postes à l'accueil
 * opts.trustProxy  lire l'IP réelle dans X-Forwarded-For (derrière Caddy)
 * opts.label       texte de la page d'accueil HTTP
 * opts.exposeWho   répondre à GET /who (découverte) avec le poste local (client uniquement)
 */
function createHub(opts = {}) {
  let key = opts.key || '';
  const ice = Array.isArray(opts.ice) ? opts.ice : [];
  const peers = new Map();   // prénom normalisé -> poste
  const fails = new Map();   // ip -> { n, t }
  const servers = new Map(); // "hôte:port" -> { http, wss }

  const send = (p, obj) => { if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); };
  const isBlocked = (ip) => { const f = fails.get(ip); return !!f && f.n >= 5 && Date.now() - f.t < 60000; };
  const addFail = (ip) => {
    const f = fails.get(ip), now = Date.now();
    if (!f || now - f.t >= 60000) fails.set(ip, { n: 1, t: now }); else f.n++;
  };

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

  function onConnection(ws, req) {
    const fwd = opts.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
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
        if (key && (typeof m.key !== 'string' || !safeEq(key, m.key))) {
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
        send(p, { t: 'welcome', ice });
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
          const k = norm(m.to);
          if (!me.pendingFrom || me.pendingFrom !== k) break;
          const ini = peers.get(k);
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
  }

  function onRequest(req, res) {
    const url = String(req.url || '').split('?')[0];
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, online: peers.size }));
      return;
    }
    if (opts.exposeWho && url === '/who') {
      // Découverte : le poste local (connecté en boucle locale) se présente. Rien d'autre n'est révélé.
      const me = [...peers.values()].find((p) => isLoopback(p.ip));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(me ? { app: 'connect', v: 1, name: me.name, busy: !!(me.link || me.pendingFrom || me.pendingTo) } : { app: 'connect', v: 1, name: null }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end((opts.label || 'CONNECT : serveur de signalisation') + '\n');
  }

  function listen(port, host) {
    const id = (host || '*') + ':' + port;
    if (servers.has(id)) return Promise.resolve(servers.get(id).http);
    return new Promise((resolve, reject) => {
      const srv = http.createServer(onRequest);
      const wss = new WebSocketServer({ server: srv, maxPayload: 256 * 1024 });
      wss.on('connection', onConnection);
      srv.once('error', reject);
      srv.listen(port, host, () => { srv.off('error', reject); srv.on('error', () => {}); servers.set(id, { http: srv, wss }); resolve(srv); });
    });
  }
  function unlisten(port, host) {
    const id = (host || '*') + ':' + port, s = servers.get(id);
    if (!s) return;
    servers.delete(id);
    s.wss.clients.forEach((c) => { try { c.terminate(); } catch { /* ignoré */ } });
    try { s.wss.close(); s.http.close(); } catch { /* ignoré */ }
  }

  const timer = setInterval(() => {
    servers.forEach((s) => s.wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }));
    const now = Date.now();
    fails.forEach((f, ip) => { if (now - f.t > 120000) fails.delete(ip); });
  }, 30000);
  timer.unref();

  function close() {
    clearInterval(timer);
    [...servers.keys()].forEach((id) => { const i = id.lastIndexOf(':'); const h = id.slice(0, i); unlisten(Number(id.slice(i + 1)), h === '*' ? undefined : h); });
  }

  return { peers, listen, unlisten, close, hosts: () => [...servers.keys()], setKey: (k) => { key = k || ''; } };
}

module.exports = { createHub, norm, NAME_RE, CODE_RE, INST_RE, isLoopback };
