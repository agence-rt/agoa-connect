'use strict';
// Tests du mode réseau privé : adresses, hub à l'écoute, découverte par sondage, appel entre deux postes.
const assert = require('assert');
const WebSocket = require('ws');
const { createHub } = require('../hub');
const D = require('../direct');

const ok = (s) => console.log('  ✓ ' + s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 20000 + Math.floor(Math.random() * 20000);

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url), q = [], w = [];
    ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); const i = w.findIndex((x) => x.t === m.t); if (i >= 0) w.splice(i, 1)[0].res(m); else q.push(m); });
    const c = {
      ws, send: (o) => ws.send(JSON.stringify(o)),
      next: (t, ms = 1500) => new Promise((res, rej) => {
        const i = q.findIndex((m) => m.t === t); if (i >= 0) return res(q.splice(i, 1)[0]);
        const x = { t, res }; w.push(x); setTimeout(() => { const k = w.indexOf(x); if (k >= 0) { w.splice(k, 1); rej(new Error('Timeout : ' + t)); } }, ms);
      }),
    };
    ws.on('open', () => resolve(c)); ws.on('error', reject);
  });
}

(async () => {
  /* --- adresses --- */
  assert.strictEqual(D.ip4ToInt('0.0.0.1'), 1);
  assert.strictEqual(D.ip4ToInt('256.1.1.1'), null);
  assert.strictEqual(D.ip4ToInt('abc'), null);
  assert.strictEqual(D.intToIp4(D.ip4ToInt('100.101.102.103')), '100.101.102.103');
  assert(D.inCidr('100.100.5.9', '100.64.0.0/10') && D.inCidr('100.127.255.255', '100.64.0.0/10'));
  assert(!D.inCidr('100.128.0.1', '100.64.0.0/10') && !D.inCidr('192.168.1.5', '100.64.0.0/10'));
  assert(D.inCidr('10.8.0.7', '10.8.0.0/24') && !D.inCidr('10.8.1.7', '10.8.0.0/24'));
  ok('calcul des plages d’adresses');

  assert.deepStrictEqual(D.expandCidr('10.8.0.0/30'), ['10.8.0.1', '10.8.0.2']);
  assert.strictEqual(D.expandCidr('10.8.0.0/24').length, 254);
  assert.deepStrictEqual(D.expandCidr('100.64.0.0/10'), []);           // trop grande : pas de balayage
  assert.deepStrictEqual(D.expandCidr('n’importe quoi'), []);
  assert.deepStrictEqual(D.expandCidr('10.8.0.9'), ['10.8.0.9']);
  ok('balayage limité aux petites plages');

  const ifaces = {
    eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.88.1.2', internal: false }, { family: 'IPv6', address: 'fd7a::1', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  };
  assert.deepStrictEqual(D.vpnAddresses(['100.64.0.0/10'], ifaces), ['100.88.1.2']);
  assert.deepStrictEqual(D.vpnAddresses(['192.168.1.0/24', '100.64.0.0/10'], ifaces).sort(), ['100.88.1.2', '192.168.1.20']);
  assert.deepStrictEqual(D.vpnAddresses(['10.8.0.0/24'], ifaces), []);
  ok('le poste n’écoute que sur les adresses du réseau privé');

  assert.deepStrictEqual(D.parseTarget('10.8.0.5', 47800), { host: '10.8.0.5', port: 47800 });
  assert.deepStrictEqual(D.parseTarget('poste-paris:47801', 47800), { host: 'poste-paris', port: 47801 });
  assert.strictEqual(D.parseTarget('a b', 1), null);
  assert.strictEqual(D.parseTarget('10.0.0.1:99999', 1), null);
  assert.deepStrictEqual(D.splitList('10.8.0.5, 10.8.0.6;10.8.0.7  x'), ['10.8.0.5', '10.8.0.6', '10.8.0.7', 'x']);
  ok('adresses saisies à la main');

  /* --- un poste = un hub + une découverte --- */
  const mk = (prenom, port, extra) => new D.Direct({
    getCfg: () => ({ prenom, key: 'cle-test', directEnabled: true, directPort: port, directNets: '127.0.0.0/30', directPeers: extra || '' }),
    onPeers: (l) => { mk.last[prenom] = l; }, onStatus: () => {}, tailscale: async () => [], intervalMs: 60000,
  });
  mk.last = {};
  const pA = base, pB = base + 1;
  const A = mk('Dieu', pA), B = mk('Éléonore', pB, '127.0.0.1:' + pA);
  await A.start(); await B.start();
  ok('les hubs démarrent (boucle locale ici ; adresses du VPN en situation réelle)');

  // Les postes se déclarent comme le fait l'interface : connexion de boucle locale au hub de leur poste.
  const a = await open(A.info().url); a.send({ t: 'hello', name: 'Dieu', code: 'AAAAAA', inst: 'inst-dieu-1', key: 'cle-test' }); await a.next('welcome');
  const b = await open(B.info().url); b.send({ t: 'hello', name: 'Éléonore', code: 'BBBBBB', inst: 'inst-eleo-1', key: 'cle-test' }); await b.next('welcome');
  await wait(100);

  assert.deepStrictEqual(await D.probe('127.0.0.1', pA), { name: 'Dieu', busy: false });
  assert.strictEqual(await D.probe('127.0.0.1', pA + 50), null);
  ok('sondage : un poste CONNECT se présente par son prénom');

  await B.scan();
  assert.deepStrictEqual((mk.last['Éléonore'] || []).map((p) => p.name), ['Dieu']); ok('découverte : Éléonore voit le poste de Dieu');
  assert.strictEqual(mk.last['Éléonore'][0].busy, false);

  // appel direct : le poste appelant se connecte au hub du poste appelé
  const v = await open('ws://127.0.0.1:' + pA);
  v.send({ t: 'hello', name: 'Éléonore', code: 'XXXXXX', inst: 'inst-eleo-1', key: 'cle-test' }); await v.next('welcome');
  v.send({ t: 'call', to: 'dieu', code: 'ZZZZZZ', mode: 'control' });
  assert.strictEqual((await v.next('reply')).reason, 'badcode'); ok('code incorrect refusé');
  v.send({ t: 'call', to: 'dieu', code: 'AAAAAA', mode: 'control' });
  await v.next('ringing');
  const inc = await a.next('incoming'); assert.deepStrictEqual([inc.from, inc.mode], ['Éléonore', 'control']); ok('le poste appelé reçoit la demande');
  await a.next('codeused');
  a.send({ t: 'reply', to: 'Éléonore', ok: true, control: true });
  assert.deepStrictEqual((await v.next('reply')).ok, true);
  v.send({ t: 'signal', to: 'Dieu', data: { x: 1 } }); assert.deepStrictEqual((await a.next('signal')).data, { x: 1 });
  ok('acceptation et signalisation WebRTC en direct');

  await wait(150);
  assert.strictEqual((await D.probe('127.0.0.1', pA)).busy, true); ok('un poste en session est signalé occupé');

  // clé de l'agence
  const bad = await open('ws://127.0.0.1:' + pA); bad.send({ t: 'hello', name: 'Intrus', code: 'QQQQQQ', inst: 'inst-intrus-1', key: 'mauvaise' });
  await bad.next('forbidden'); ok('clé d’agence exigée aussi en direct');

  // le hub ne révèle rien sans poste local, et ne parle qu'en /who
  const H = createHub({ exposeWho: true }); await H.listen(base + 2, '127.0.0.1');
  assert.deepStrictEqual(await D.probe('127.0.0.1', base + 2), null); ok('sans poste local, aucun prénom n’est annoncé');
  H.close();

  // désactivation
  mk.last = {};
  const off = new D.Direct({ getCfg: () => ({ directEnabled: false, directPort: base + 3 }), onPeers: (l) => { mk.last.off = l; }, onStatus: () => {}, tailscale: async () => [] });
  await off.start(); assert.strictEqual(await D.probe('127.0.0.1', base + 3), null); assert.deepStrictEqual(mk.last.off, []); off.stop();
  ok('mode réseau privé désactivable');

  [a, b, v, bad].forEach((c) => c.ws.terminate()); A.stop(); B.stop();
  console.log('\nTous les tests du réseau privé passent.');
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC :', e.message); console.error(e.stack); process.exit(1); });
