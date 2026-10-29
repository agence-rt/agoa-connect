'use strict';
// Test de bout en bout du protocole de signalisation (identifiants = prénoms). Lance le serveur sur un port libre.
const { spawn } = require('child_process');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 18080 + Math.floor(Math.random() * 500);
const URL = 'ws://127.0.0.1:' + PORT;
const KEY = 'cle-agence-test';

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const q = [], waiters = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const w = waiters.findIndex((x) => x.t === m.t);
      if (w >= 0) waiters.splice(w, 1)[0].res(m); else q.push(m);
    });
    const c = {
      ws,
      send: (o) => ws.send(JSON.stringify(o)),
      next: (t, ms = 1500) => new Promise((res, rej) => {
        const i = q.findIndex((m) => m.t === t);
        if (i >= 0) return res(q.splice(i, 1)[0]);
        const w = { t, res };
        waiters.push(w);
        setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); rej(new Error('Timeout en attendant ' + t)); } }, ms);
      }),
      none: (t, ms = 300) => new Promise((res, rej) => {
        setTimeout(() => (q.some((m) => m.t === t) ? rej(new Error('Message inattendu : ' + t)) : res()), ms);
      }),
      // dernière liste de postes reçue
      lastPeers: async () => { await new Promise((r) => setTimeout(r, 350)); let last = null; while (q.some((m) => m.t === 'peers')) last = q.splice(q.findIndex((m) => m.t === 'peers'), 1)[0]; return last && last.list; },
    };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
const hello = (name, code, inst, key = KEY) => ({ t: 'hello', name, code, inst, key });

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), AGENCY_KEY: KEY }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const ok = (s) => console.log('  ✓ ' + s);
  try {
    const bad = await client();
    bad.send(hello('Intrus', 'ZZZZZZ', 'instance-intrus', 'mauvaise-cle'));
    await bad.next('forbidden'); ok('mauvaise clé d’agence refusée');

    const A = await client(), B = await client(), C = await client();
    A.send(hello('Dieu', 'AAAAAA', 'instance-aaaa')); await A.next('welcome');
    B.send(hello('Éléonore', 'BBBBBB', 'instance-bbbb')); await B.next('welcome');
    C.send(hello('Charlotte', 'CCCCCC', 'instance-cccc')); await C.next('welcome');
    ok('enregistrement de trois postes par prénom (accents compris)');

    const list = await A.lastPeers();
    assert.deepStrictEqual(list.map((p) => p.name).sort(), ['Charlotte', 'Dieu', 'Éléonore']); ok('liste des postes en ligne reçue');

    const dup = await client();
    dup.send(hello('dieu', 'ZZZZZZ', 'instance-autre'));
    await dup.next('idtaken'); ok('prénom déjà pris refusé, même en minuscules');
    const dup2 = await client();
    dup2.send(hello('ELEONORE', 'ZZZZZZ', 'instance-autre'));
    await dup2.next('idtaken'); ok('prénom déjà pris refusé, accents et casse ignorés');

    const inv = await client();
    inv.send(hello('1234', 'ZZZZZZ', 'instance-inv'));
    assert.strictEqual((await inv.next('error')).reason, 'invalid'); ok('prénom invalide refusé');

    A.send({ t: 'call', to: 'eleonore', code: 'WRONG1', mode: 'control' });
    assert.strictEqual((await A.next('reply')).reason, 'badcode'); ok('mauvais code refusé');

    A.send({ t: 'call', to: 'Personne', code: 'AAAAAA', mode: 'control' });
    assert.strictEqual((await A.next('reply')).reason, 'offline'); ok('prénom inconnu signalé');

    A.send({ t: 'call', to: 'ELEONORE', code: 'bbbbbb', mode: 'control' });
    await A.next('ringing');
    const inc = await B.next('incoming');
    assert.deepStrictEqual([inc.from, inc.mode], ['Dieu', 'control']);
    await B.next('codeused'); ok('appel par prénom (casse et accents libres), demande reçue, code consommé');

    C.send({ t: 'call', to: 'Éléonore', code: 'BBBBBB', mode: 'present' });
    assert.strictEqual((await C.next('reply')).reason, 'badcode'); ok('ancien code inutilisable (usage unique)');

    A.send({ t: 'signal', to: 'Éléonore', data: { x: 1 } });
    await B.none('signal'); ok('signal refusé avant acceptation');

    B.send({ t: 'reply', to: 'Dieu', ok: true, control: true });
    const rep = await A.next('reply');
    assert.ok(rep.ok && rep.control && rep.from === 'Éléonore'); ok('acceptation avec permission de contrôle');

    A.send({ t: 'signal', to: 'Éléonore', data: { sdp: 'offer' } });
    assert.deepStrictEqual((await B.next('signal')).data, { sdp: 'offer' });
    B.send({ t: 'signal', to: 'Dieu', data: { sdp: 'answer' } });
    assert.deepStrictEqual((await A.next('signal')).data, { sdp: 'answer' }); ok('signaux relayés dans les deux sens');

    C.send({ t: 'signal', to: 'Éléonore', data: { evil: true } });
    await B.none('signal'); ok('tiers non appairé ne peut pas injecter de signal');

    const busy = await A.lastPeers();
    assert.ok(busy.find((p) => p.name === 'Dieu').busy && busy.find((p) => p.name === 'Éléonore').busy && !busy.find((p) => p.name === 'Charlotte').busy); ok('postes en session signalés « occupés » dans la liste');

    A.send({ t: 'bye' });
    assert.strictEqual((await B.next('bye')).from, 'Dieu'); ok('fin de session notifiée');

    // Reconnexion de la même installation : reprend sa place sans « prénom pris »
    const A2 = await client();
    A2.send(hello('Dieu', 'DDDDDD', 'instance-aaaa'));
    await A2.next('welcome'); ok('même installation qui se reconnecte reprend son prénom');

    const D = await client();
    D.send(hello('Daniel', 'DDDDDD', 'instance-dddd')); await D.next('welcome');
    for (let i = 0; i < 6; i++) { D.send({ t: 'call', to: 'Charlotte', code: 'NOPE' + i + 'X', mode: 'present' }); await D.next('reply'); }
    D.send({ t: 'call', to: 'Charlotte', code: 'CCCCCC', mode: 'present' });
    assert.strictEqual((await D.next('reply')).reason, 'blocked'); ok('limitation après 5 essais ratés');

    console.log('\nTous les tests du serveur passent.');
  } catch (e) {
    console.error('\nÉCHEC :', e.message);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
})();
