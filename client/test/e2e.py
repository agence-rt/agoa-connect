"""Test de bout en bout (Chromium + serveur réel).

Des fenêtres chargent l'interface du client avec une fausse couche Electron
(configuration, capture d'écran simulée, injection enregistrée). On vérifie :
identification par prénom, appairage par code, flux vidéo WebRTC, commandes
souris/clavier reçues, arrêt d'urgence, demande de contrôle, mode « Présenter »,
prénom déjà pris, clé d'agence erronée, premier réglage.

Lancer :  python3 test/e2e.py   (nécessite playwright + chromium)
"""
import os, subprocess, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = 'file://' + os.path.join(ROOT, 'renderer', 'index.html')
PORT = 8000 + int(time.time()) % 900
KEY = 'cle-agence-test'
STUB = """
window.__inputs = []; window.__resets = 0; window.__panic = null;
const __cfg = { prenom: '%PRENOM%', server: '%SERVER%', key: '%KEY%', inst: '%INST%', directEnabled: true, directNets: '100.64.0.0/10', directPeers: '' };
window.__directInfo = %DIRECT%;
window.api = {
  getConfig: async () => ({ ...__cfg }),
  setConfig: async (p) => { Object.assign(__cfg, p); return { ...__cfg }; },
  inputAvailable: async () => true,
  input: async (ev) => { window.__inputs.push(ev); return true; },
  inputReset: async () => { window.__resets++; return true; },
  directInfo: async () => window.__directInfo,
  directRefresh: async () => true,
  onDirectPeers: (cb) => { window.__peersCb = cb; },
  onDirectStatus: (cb) => { window.__statusCb = cb; },
  onPanic: (cb) => { window.__panic = cb; },
  platform: 'linux',
};
navigator.mediaDevices.getDisplayMedia = async () => {
  const c = document.createElement('canvas'); c.width = 640; c.height = 400;
  const g = c.getContext('2d'); let i = 0;
  setInterval(() => { g.fillStyle = '#234'; g.fillRect(0, 0, 640, 400); g.fillStyle = '#fff'; g.fillRect((i * 7) %% 600, 100, 40, 40); i++; }, 33);
  return c.captureStream(30);
};
"""

def stub(prenom, inst, key=KEY, server=None, direct_port=None):
    server = 'ws://127.0.0.1:%d' % PORT if server is None else server
    direct = 'null' if direct_port is None else '{ port: %d, url: "ws://127.0.0.1:%d" }' % (direct_port, direct_port)
    return (STUB.replace('%PRENOM%', prenom).replace('%SERVER%', server).replace('%KEY%', key)
            .replace('%INST%', inst).replace('%DIRECT%', direct).replace('%%', '%'))

def check(label, cond):
    print(('  ✓ ' if cond else '  ✗ ') + label)
    if not cond:
        raise SystemExit('ÉCHEC : ' + label)

def video_flowing(page):
    page.wait_for_function("() => { const v = document.querySelector('#video'); return v.videoWidth > 0 && v.currentTime > 0.3; }", timeout=20000)

def chip_is(page, text, timeout=8000):
    page.wait_for_function("(t) => document.querySelector('#roleChip').textContent === t", arg=text, timeout=timeout)

def connect(a, b, mode, tick_control=False, typed='eleonore'):
    code = b.inner_text('#myCode')
    a.fill('#target', typed); a.fill('#peerCode', code)
    a.click('label.mode:has(input[value=%s])' % mode)
    a.click('#goBtn')
    b.wait_for_selector('#incoming', state='visible', timeout=5000)
    if tick_control:
        b.check('#inCtl')
    b.click('#inYes')
    a.wait_for_selector('#session', state='visible', timeout=8000)
    b.wait_for_selector('#session', state='visible', timeout=8000)

srv = subprocess.Popen(['node', 'server.js'], cwd=os.path.join(os.path.dirname(ROOT), 'server'),
                       env={**os.environ, 'PORT': str(PORT), 'ICE_SERVERS': '[]', 'AGENCY_KEY': KEY},
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.7)
try:
    with sync_playwright() as p:
        br = p.chromium.launch(args=['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'])
        def new_page(prenom, inst, key=KEY, server=None, direct_port=None):
            pg = br.new_context(viewport={'width': 1100, 'height': 760}).new_page()
            pg.on('pageerror', lambda e: print('  [erreur page %s]' % prenom, e))
            pg.add_init_script(stub(prenom, inst, key, server, direct_port))
            pg.goto(PAGE)
            return pg
        A = new_page('Anna', 'instance-anna-0001')
        B = new_page('Éléonore', 'instance-eleonore-01')

        print('Scénario 1 : Anna prend le contrôle du poste d’Éléonore (appel en minuscules, sans accent)')
        A.wait_for_selector('#netPill[data-s=online]', timeout=5000); B.wait_for_selector('#netPill[data-s=online]', timeout=5000)
        check('les deux postes sont en ligne, identifiés par prénom (%s / %s)' % (A.inner_text('#myId'), B.inner_text('#myId')),
              A.inner_text('#myId') == 'Anna' and B.inner_text('#myId') == 'Éléonore')
        A.wait_for_function("() => document.querySelector('#peerList').textContent.includes('Éléonore')", timeout=5000)
        check('la liste des postes en ligne montre Éléonore à Anna (et pas Anna à elle-même)',
              'Anna' not in A.inner_text('#peerList'))
        A.click('#peerList button[data-m=control]')
        check('un clic sur un poste remplit son prénom et le mode',
              A.input_value('#target') == 'Éléonore' and A.is_checked('input[name=mode][value=control]'))
        code_before = B.inner_text('#myCode')
        connect(A, B, 'control', tick_control=True)
        check('session ouverte des deux côtés après acceptation', True)
        check('A voit « Éléonore » comme interlocutrice, B voit « Anna »', A.inner_text('#peerName') == 'Éléonore' and B.inner_text('#peerName') == 'Anna')
        check('le code d’Éléonore a été renouvelé après usage', B.inner_text('#myCode') != code_before)
        video_flowing(A)
        check('A reçoit le flux vidéo WebRTC', True)
        chip_is(A, 'Vous contrôlez')
        check('A est en mode « Vous contrôlez »', True)
        check('B affiche « Contrôlé à distance »', B.inner_text('#roleChip') == 'Contrôlé à distance')

        box = A.locator('#viewer').bounding_box()
        cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        A.mouse.move(cx, cy); A.mouse.down(); A.mouse.up()
        A.keyboard.press('a'); A.keyboard.press('Enter')
        A.mouse.wheel(0, 120)
        time.sleep(0.8)
        ev = B.evaluate('window.__inputs')
        kinds = [e['k'] for e in ev]
        check('B reçoit déplacement, clic, saisie, touche spéciale et molette (%s)' % ','.join(sorted(set(kinds))),
              all(k in kinds for k in ['mm', 'md', 'mu', 'ty', 'kd', 'ku', 'wh']))
        md = next(e for e in ev if e['k'] == 'md')
        check('coordonnées normalisées proches du centre (%.2f, %.2f)' % (md['x'], md['y']), abs(md['x'] - 0.5) < 0.05 and abs(md['y'] - 0.5) < 0.05)
        check('le texte tapé arrive tel quel', any(e['k'] == 'ty' and e['text'] == 'a' for e in ev))

        B.evaluate('window.__panic()')
        chip_is(A, 'Vous observez', 5000)
        n = len(B.evaluate('window.__inputs'))
        A.mouse.move(cx + 20, cy + 20); A.mouse.down(); A.mouse.up(); A.keyboard.press('b')
        time.sleep(0.6)
        check('arrêt d’urgence : plus aucune commande n’arrive', len(B.evaluate('window.__inputs')) == n)
        check('B a bien relâché ses entrées (inputReset)', B.evaluate('window.__resets') >= 1)

        A.click('#btnCtl')
        B.wait_for_selector('#reqbar', state='visible', timeout=5000)
        B.click('#reqYes')
        chip_is(A, 'Vous contrôlez', 5000)
        check('demande de contrôle acceptée par Éléonore', True)

        A.click('#btnEnd')
        B.wait_for_selector('#home', state='visible', timeout=5000)
        check('Anna termine : Éléonore revient à l’accueil', True)

        print('Scénario 2 : Anna présente son écran à Éléonore')
        A.wait_for_selector('#home', state='visible')
        connect(A, B, 'present', typed='ÉLÉONORE')
        video_flowing(B)
        check('Éléonore reçoit le flux vidéo (appel en majuscules accentuées)', True)
        check('Éléonore est simple observatrice', B.inner_text('#roleChip') == 'Vous observez')
        a_in = len(A.evaluate('window.__inputs'))
        box = B.locator('#viewer').bounding_box()
        B.mouse.move(box['x'] + 50, box['y'] + 50); B.mouse.down(); B.mouse.up(); B.keyboard.press('x')
        time.sleep(0.6)
        check('sans autorisation, rien n’est injecté chez Anna', len(A.evaluate('window.__inputs')) == a_in)
        A.click('#btnCtl')
        chip_is(B, 'Vous contrôlez', 5000)
        B.mouse.move(box['x'] + 80, box['y'] + 80); B.mouse.down(); B.mouse.up()
        time.sleep(0.6)
        check('après « Autoriser le contrôle », Anna reçoit les commandes', len(A.evaluate('window.__inputs')) > a_in)
        B.click('#btnEnd')
        A.wait_for_selector('#home', state='visible', timeout=5000)
        check('Éléonore termine : Anna revient à l’accueil', True)

        print('Scénario 3 : mauvais code, prénom inconnu, refus')
        A.fill('#target', 'eleonore'); A.fill('#peerCode', 'WRONG1'); A.click('#goBtn')
        A.wait_for_function("() => document.querySelector('#err').textContent.includes('incorrect')", timeout=5000)
        check('mauvais code : message clair', True)
        A.fill('#target', 'Personne'); A.fill('#peerCode', 'ABCDEF'); A.click('#goBtn')
        A.wait_for_function("() => document.querySelector('#err').textContent.includes('introuvable')", timeout=5000)
        check('prénom inconnu : message clair', True)
        A.fill('#target', 'Éléonore'); A.fill('#peerCode', B.inner_text('#myCode')); A.click('#goBtn')
        B.wait_for_selector('#incoming', state='visible'); B.click('#inNo')
        A.wait_for_function("() => document.querySelector('#err').textContent.includes('refusée')", timeout=5000)
        check('refus : message clair, pas de session', A.is_visible('#home'))

        print('Scénario 4 : premier réglage, prénom déjà pris, mauvaise clé')
        C = new_page('', 'instance-nouveau-001')
        C.wait_for_selector('#setup', state='visible', timeout=5000)
        check('poste sans prénom : l’écran de premier réglage s’ouvre', True)
        check('la clé est déjà fournie : le champ clé n’apparaît pas', not C.is_visible('#setupKeyRow'))
        C.fill('#setupName', 'anna'); C.click('#setupForm button[type=submit]')
        C.wait_for_function("() => document.querySelector('#setupTitle').textContent.includes('déjà utilisé')", timeout=5000)
        check('prénom déjà porté par Anna (même en minuscules) : refusé avec explication', C.is_visible('#setup'))
        C.fill('#setupName', 'Anna-Lyon'); C.click('#setupForm button[type=submit]')
        C.wait_for_selector('#netPill[data-s=online]', timeout=5000)
        check('avec un repère, le poste se connecte (%s)' % C.inner_text('#myId'), C.inner_text('#myId') == 'Anna-Lyon')
        C.wait_for_function("() => document.querySelector('#peerList').textContent.includes('Éléonore')", timeout=5000)
        check('il voit les autres postes en ligne', True)
        D = new_page('Intrus', 'instance-intrus-001', key='mauvaise-cle')
        D.wait_for_function("() => document.querySelector('#netPill').textContent.includes('Clé')", timeout=5000)
        check('mauvaise clé d’agence : refusée, avec message', True)
        E = new_page('', 'instance-sanscle-001', key='')
        E.wait_for_selector('#setup', state='visible', timeout=5000)
        check('poste sans prénom ni clé : le champ clé est demandé', E.is_visible('#setupKeyRow'))
        E.fill('#setupName', 'Camille'); E.click('#setupForm button[type=submit]')
        E.wait_for_function("() => document.querySelector('#setupErr').textContent.includes('clé')", timeout=3000)
        check('sans clé saisie, l’enregistrement est refusé avec explication', E.is_visible('#setup'))
        E.fill('#setupKey', KEY); E.click('#setupForm button[type=submit]')
        E.wait_for_selector('#netPill[data-s=online]', timeout=5000)
        check('prénom et clé saisis au premier lancement : le poste est en ligne (%s)' % E.inner_text('#myId'), E.inner_text('#myId') == 'Camille')

        print('Scénario 5 : réseau privé (VPN), sans aucun serveur Internet')
        pa, pb = PORT + 100, PORT + 101
        hubs = [subprocess.Popen(['node', os.path.join(ROOT, 'test', 'hub-run.js'), str(p), KEY], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for p in (pa, pb)]
        try:
            time.sleep(0.7)
            G = new_page('Dieu', 'instance-dieu-0001', server='', direct_port=pa)
            H = new_page('Hélène', 'instance-helene-001', server='', direct_port=pb)
            check('sans serveur Internet, le poste l’indique et reste utilisable', 'non configuré' in G.inner_text('#netPill'))
            for pg, port in ((G, pa), (H, pb)):
                pg.evaluate('(p) => window.__statusCb({ enabled: true, port: p, listening: ["100.88.0.%d"], vpn: true, tailscale: true, error: "" })' % (1 if port == pa else 2), port)
            G.wait_for_selector('#vpnPill[data-s=online]', timeout=5000)
            check('le VPN est détecté : le poste annonce son écoute (%s)' % G.inner_text('#vpnInfo'), '100.88.0.1' in G.inner_text('#vpnInfo'))
            time.sleep(0.8)   # les postes se déclarent à leur hub
            for pg, who, port in ((G, 'Hélène', pb), (H, 'Dieu', pa)):
                pg.evaluate('(a) => window.__peersCb([{ name: a[0], host: "127.0.0.1", port: a[1], busy: false }])', [who, port])
            G.wait_for_function("() => document.querySelector('#peerList').textContent.includes('Hélène')", timeout=5000)
            check('Dieu voit directement le poste d’Hélène, marqué « réseau privé »', 'réseau privé' in G.inner_text('#peerList'))
            code = H.inner_text('#myCode')
            G.fill('#target', 'helene'); G.fill('#peerCode', 'WRONG1')
            G.click('label.mode:has(input[value=control])'); G.click('#goBtn')
            G.wait_for_function("() => document.querySelector('#err').textContent.includes('incorrect')", timeout=5000)
            check('mauvais code : refusé en direct', True)
            G.fill('#peerCode', code); G.click('#goBtn')
            H.wait_for_selector('#incoming', state='visible', timeout=5000)
            check('Hélène reçoit la demande sans serveur central', 'Dieu' in H.inner_text('#inText'))
            H.check('#inCtl'); H.click('#inYes')
            G.wait_for_selector('#session', state='visible', timeout=8000)
            video_flowing(G)
            chip_is(G, 'Vous contrôlez')
            check('Dieu voit l’écran d’Hélène et la contrôle, en direct sur le réseau privé', H.inner_text('#roleChip') == 'Contrôlé à distance')
            check('le code d’Hélène a été renouvelé après usage', H.inner_text('#myCode') != code)
            box = G.locator('#viewer').bounding_box()
            G.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2); G.mouse.down(); G.mouse.up()
            time.sleep(0.7)
            check('les commandes arrivent chez Hélène', any(e['k'] == 'md' for e in H.evaluate('window.__inputs')))
            G.click('#btnEnd')
            H.wait_for_selector('#home', state='visible', timeout=5000)
            check('fin de session propagée par la liaison directe', True)
            # poste annoncé mais injoignable, sans serveur de repli
            G.evaluate('() => window.__peersCb([{ name: "Fantôme", host: "127.0.0.1", port: 9, busy: false }])')
            G.fill('#target', 'Fantôme'); G.fill('#peerCode', 'ABCDEF'); G.click('label.mode:has(input[value=present])'); G.click('#goBtn')
            G.wait_for_function("() => document.querySelector('#err').textContent.includes('injoignable')", timeout=8000)
            check('poste injoignable : message clair, pas de blocage', G.is_visible('#home') and G.locator('#calling').is_hidden())
            # VPN absent
            H.evaluate('() => window.__statusCb({ enabled: true, port: %d, listening: [], vpn: false, tailscale: false, error: "" })' % pb)
            H.wait_for_selector('#vpnPill[data-s=offline]', timeout=3000)
            check('VPN absent : l’interface le dit et explique quoi faire', 'Tailscale' in H.inner_text('#vpnInfo'))
        finally:
            for h in hubs: h.terminate()
        br.close()
    print('\nTest de bout en bout : tout passe.')
finally:
    srv.terminate()
