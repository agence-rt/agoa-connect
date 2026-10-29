'use strict';
/*
 * CONNECT — mode « réseau privé » (VPN).
 * Chaque poste :
 *   1. écoute (hub) uniquement sur ses adresses du réseau privé + la boucle locale ;
 *   2. repère les autres postes CONNECT du réseau privé : liste des appareils du VPN
 *      (Tailscale), balayage des plages configurées, adresses ajoutées à la main ;
 *   3. publie la liste (prénom, adresse, disponibilité) à l'interface.
 * Aucun serveur central n'est nécessaire pour ce mode.
 */
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');
const { createHub, NAME_RE } = require('./hub');

const DEFAULT_PORT = 47800;
const DEFAULT_NETS = ['100.64.0.0/10'];     // plage Tailscale ; adapter pour WireGuard / OpenVPN (ex. 10.8.0.0/24)
const SCAN_MAX = 1024;                       // taille maximale d'une plage balayée

/* ---------- Utilitaires d'adresses (purs, testés) ---------- */
function ip4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
const intToIp4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
function parseCidr(s) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const ip = ip4ToInt(m[1]), bits = m[2] === undefined ? 32 : Number(m[2]);
  if (ip === null || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, mask, bits };
}
function inCidr(ip, cidr) {
  const n = ip4ToInt(ip), c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  return n !== null && !!c && ((n & c.mask) >>> 0) === c.base;
}
// Adresses d'une plage (sans réseau ni diffusion pour /30 et plus larges), vide si trop grande.
function expandCidr(s, max = SCAN_MAX) {
  const c = parseCidr(s);
  if (!c) return [];
  const size = 2 ** (32 - c.bits);
  if (size > max) return [];
  const out = [];
  for (let i = 0; i < size; i++) {
    if (c.bits <= 30 && (i === 0 || i === size - 1)) continue;
    out.push(intToIp4(c.base + i));
  }
  return out;
}
// Adresses IPv4 de ce poste qui appartiennent au réseau privé configuré.
function vpnAddresses(nets, ifaces = os.networkInterfaces()) {
  const cidrs = (nets || []).map(parseCidr).filter(Boolean);
  const out = [];
  Object.values(ifaces).forEach((list) => (list || []).forEach((a) => {
    if ((a.family === 'IPv4' || a.family === 4) && !a.internal && cidrs.some((c) => inCidr(a.address, c))) out.push(a.address);
  }));
  return [...new Set(out)];
}
// « 10.8.0.5 » ou « 10.8.0.5:47801 » -> { host, port }
function parseTarget(s, defPort) {
  const m = /^\s*([A-Za-z0-9.-]+)(?::(\d{1,5}))?\s*$/.exec(String(s || ''));
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defPort;
  return port > 0 && port < 65536 ? { host: m[1], port } : null;
}
const splitList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);

/* ---------- Découverte ---------- */
// Un poste CONNECT répond à GET /who ; on n'accepte qu'une réponse bien formée.
function probe(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host, port, path: '/who', timeout: timeoutMs, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; if (buf.length > 2048) { res.destroy(); fin(null); } });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.app === 'connect' && typeof j.name === 'string' && NAME_RE.test(j.name)) fin({ name: j.name, busy: !!j.busy });
          else fin(null);
        } catch { fin(null); }
      });
      res.on('error', () => fin(null));
    });
    req.on('timeout', () => { req.destroy(); fin(null); });
    req.on('error', () => fin(null));
  });
}
// Exécute fn sur chaque élément avec au plus n tâches simultanées.
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}
// Appareils en ligne du VPN Tailscale (si la commande est installée).
function tailscalePeers() {
  const bins = process.platform === 'win32'
    ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : process.platform === 'darwin' ? ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] : ['tailscale'];
  const tryBin = (i) => new Promise((resolve) => {
    if (i >= bins.length) return resolve([]);
    execFile(bins[i], ['status', '--json'], { timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(tryBin(i + 1));
      try {
        const j = JSON.parse(out), ips = [];
        Object.values(j.Peer || {}).forEach((p) => {
          if (p && p.Online !== false) (p.TailscaleIPs || []).forEach((a) => { if (ip4ToInt(a) !== null) ips.push(a); });
        });
        resolve(ips);
      } catch { resolve([]); }
    });
  });
  return tryBin(0);
}

/* ---------- Service ---------- */
class Direct {
  /**
   * getCfg()  -> { prenom, key, directEnabled, directPort, directNets, directPeers }
   * onPeers(list)   list = [{ name, host, port, busy }]
   * onStatus(obj)   obj  = { enabled, port, listening:[adresses], vpn:boolean, tailscale:boolean, error }
   */
  constructor({ getCfg, onPeers, onStatus, tailscale = tailscalePeers, intervalMs = 10000 }) {
    this.getCfg = getCfg; this.onPeers = onPeers || (() => {}); this.onStatus = onStatus || (() => {});
    this.tailscale = tailscale; this.intervalMs = intervalMs;
    this.hub = null; this.timer = null; this.busy = false; this.scanTick = 0;
    this.status = { enabled: false, port: DEFAULT_PORT, listening: [], vpn: false, tailscale: false, error: '' };
    this.lastKey = '';
  }
  cfg() {
    const c = this.getCfg() || {};
    const port = Number(c.directPort) > 0 && Number(c.directPort) < 65536 ? Number(c.directPort) : DEFAULT_PORT;
    const nets = splitList(c.directNets).filter((x) => parseCidr(x));
    return { enabled: c.directEnabled !== false, port, nets: nets.length ? nets : DEFAULT_NETS, extra: splitList(c.directPeers), key: c.key || '' };
  }
  // Applique la configuration : hub créé, adresses d'écoute mises à jour.
  async apply() {
    const c = this.cfg();
    this.status.enabled = c.enabled; this.status.port = c.port;
    if (!c.enabled) { this.stopHub(); this.status.listening = []; this.status.error = ''; this.onStatus({ ...this.status }); return; }
    if (this.hub && this.hubPort !== c.port) this.stopHub();
    if (!this.hub) { this.hub = createHub({ key: c.key, ice: [], exposeWho: true, label: 'CONNECT : poste (réseau privé)' }); this.hubPort = c.port; }
    this.hub.setKey(c.key);
    const want = new Set(['127.0.0.1', ...vpnAddresses(c.nets)]);
    this.status.vpn = want.size > 1; this.status.error = '';
    for (const id of this.hub.hosts()) { const h = id.slice(0, id.lastIndexOf(':')); if (!want.has(h)) this.hub.unlisten(c.port, h); }
    for (const h of want) {
      try { await this.hub.listen(c.port, h); }
      catch (e) { if (h === '127.0.0.1') this.status.error = e.code === 'EADDRINUSE' ? 'Le port ' + c.port + ' est déjà utilisé.' : 'Écoute impossible : ' + e.message; }
    }
    this.status.listening = this.hub.hosts().map((id) => id.slice(0, id.lastIndexOf(':'))).filter((h) => h !== '127.0.0.1');
    this.onStatus({ ...this.status });
  }
  stopHub() { if (this.hub) { this.hub.close(); this.hub = null; } }
  info() { return { port: this.status.port, url: 'ws://127.0.0.1:' + this.status.port }; }

  async start() {
    await this.apply();
    await this.scan();
    this.timer = setInterval(() => { this.scan().catch(() => {}); }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.stopHub(); }

  // Un tour de découverte. La liste des appareils du VPN est relue à chaque tour, les plages balayées tous les 3 tours.
  async scan() {
    if (this.busy) { this.again = true; return; }     // un tour est en cours : on en refera un juste après
    this.busy = true;
    try {
      await this.apply();                       // suit les changements de réseau (VPN qui démarre / s'arrête)
      const c = this.cfg();
      if (!c.enabled) { this.onPeers([]); return; }
      const targets = new Map();                // "hôte:port" -> { host, port }
      const add = (host, port) => targets.set(host + ':' + port, { host, port });
      const ts = await this.tailscale();
      this.status.tailscale = ts.length > 0;
      ts.forEach((ip) => add(ip, c.port));
      if (this.scanTick++ % 3 === 0 || !this.ranges) {
        this.ranges = c.nets.flatMap((n) => expandCidr(n));
      }
      this.ranges.forEach((ip) => add(ip, c.port));
      c.extra.forEach((t) => { const p = parseTarget(t, c.port); if (p) add(p.host, p.port); });
      const mine = new Set(vpnAddresses(c.nets).concat(['127.0.0.1', 'localhost']));
      const found = new Map();                  // prénom normalisé -> poste
      await pool([...targets.values()].filter((t) => !(mine.has(t.host) && t.port === c.port)), 48, async (t) => {
        const r = await probe(t.host, t.port);
        if (r && r.name) { const k = r.name.toLowerCase(); if (!found.has(k)) found.set(k, { name: r.name, host: t.host, port: t.port, busy: r.busy }); }
      });
      this.status.tailscale = this.status.tailscale || false;
      this.onStatus({ ...this.status });
      this.onPeers([...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; setTimeout(() => this.scan().catch(() => {}), 50); }
    }
  }
}

module.exports = { Direct, ip4ToInt, intToIp4, parseCidr, inCidr, expandCidr, vpnAddresses, parseTarget, splitList, probe, tailscalePeers, DEFAULT_PORT, DEFAULT_NETS };
