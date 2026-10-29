(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const api = window.api;

const REASONS = {
  badcode: 'Code incorrect.',
  offline: 'Poste introuvable ou hors ligne.',
  busy: 'Ce poste est occupé.',
  refused: 'Connexion refusée par l’autre poste.',
  blocked: 'Trop d’essais. Patientez une minute.',
  gone: 'L’autre poste s’est déconnecté.',
};

// Trois sortes de liaisons de signalisation :
//   net : serveur Internet ; hub : hub de ce poste, ouvert aux autres postes du réseau privé (VPN) ;
//   out : liaison temporaire vers le hub d'un autre poste, le temps d'un appel direct.
let cfg = null, retry = 0, retryT = null, hubRetry = 0, hubRetryT = null;
const net = { kind: 'net', ws: null, ice: [{ urls: 'stun:stun.l.google.com:19302' }] };
const hub = { kind: 'hub', ws: null, ice: [] };
let netPeers = [], directPeers = [], directStatus = null, hubGen = 0;
let myCode = '', outgoing = null, incoming = null, sess = null, toastT = null, noRetry = false;

/* ---------- Utilitaires ---------- */
function toast(t) {
  const e = $('#toast'); e.textContent = t; e.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { e.hidden = true; }, 3200);
}
const NAME_RE = /^\p{L}[\p{L}\p{N} '’-]{0,29}$/u;
// « Éléonore » et « eleonore » désignent le même poste (même règle que le serveur).
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/’/g, "'").replace(/\s+/g, ' ').trim();
const cleanName = (s) => String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function genCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, (x) => a[x % a.length]).join('');
}
function show(view) { $('#home').hidden = view !== 'home'; $('#session').hidden = view !== 'session'; }
function chSend(ch, o) { if (ch && ch.ws && ch.ws.readyState === 1) ch.ws.send(JSON.stringify(o)); }
const wsSend = (o) => chSend(net, o);
function setNet(s, text) { const p = $('#netPill'); p.dataset.s = s; p.textContent = text; }
function renderSelf() { $('#myId').textContent = cfg.prenom || '—'; $('#myCode').textContent = myCode; }

/* ---------- Prénom du poste (premier lancement, prénom déjà pris) ---------- */
function showSetup(text, title) {
  $('#setupTitle').textContent = title || 'Prénom de ce poste';
  $('#setupText').textContent = text || 'Ce prénom identifie ce poste auprès des collègues, qui le saisissent pour s’y connecter.';
  $('#setupName').value = cfg.prenom || ''; $('#setupErr').textContent = '';
  $('#setupKeyRow').hidden = !!cfg.key;     // la clé n'est demandée que si elle n'a pas été fournie à l'installation
  $('#setupKey').value = '';
  $('#setup').hidden = false; $('#setupName').focus();
}
$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = cleanName($('#setupName').value), k = $('#setupKey').value.trim();
  if (!NAME_RE.test(v)) { $('#setupErr').textContent = 'Saisissez un prénom : lettres, chiffres, espace, tiret ou apostrophe (30 signes maximum).'; return; }
  if (!$('#setupKeyRow').hidden && !k) { $('#setupErr').textContent = 'Saisissez la clé de l’agence.'; return; }
  cfg = await api.setConfig(k ? { prenom: v, key: k } : { prenom: v });
  $('#setup').hidden = true; $('#setPrenom').value = cfg.prenom; $('#setKey').value = cfg.key;
  renderSelf(); connectWs(); connectHub();
});

/* ---------- Postes en ligne ---------- */
// Postes visibles : ceux du réseau privé (liaison directe) et ceux du serveur Internet. Un poste présent
// des deux côtés est joint par le réseau privé.
function allPeers() {
  const me = norm(cfg.prenom), map = new Map();
  netPeers.forEach((p) => { if (norm(p.name) !== me) map.set(norm(p.name), { name: p.name, busy: !!p.busy, via: 'net' }); });
  directPeers.forEach((p) => { if (norm(p.name) !== me) map.set(norm(p.name), { name: p.name, busy: !!p.busy, via: 'direct', host: p.host, port: p.port }); });
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}
function renderPeers() {
  const others = allPeers();
  $('#onlineNames').innerHTML = others.map((p) => '<option value="' + esc(p.name) + '"></option>').join('');
  renderNetInfo();
  const box = $('#peerList');
  if (!others.length) { box.innerHTML = '<span class="hint">Aucun autre poste en ligne.</span>'; return; }
  box.innerHTML = others.map((p) =>
    '<div class="peer"><span class="dot ' + (p.busy ? 'busy' : 'on') + '"></span><span class="nm">' + esc(p.name) + '</span><span class="via">' + (p.via === 'direct' ? 'réseau privé' : 'Internet') + '</span><span class="st">' + (p.busy ? 'occupé' : 'disponible') + '</span>' +
    '<button type="button" class="ghost" data-n="' + esc(p.name) + '" data-m="present"' + (p.busy ? ' disabled' : '') + '>Présenter</button>' +
    '<button type="button" class="ghost" data-n="' + esc(p.name) + '" data-m="control"' + (p.busy ? ' disabled' : '') + '>Contrôler</button></div>').join('');
}
$('#peerList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-n]'); if (!b || b.disabled) return;
  $('#target').value = b.dataset.n;
  const r = document.querySelector('input[name="mode"][value="' + b.dataset.m + '"]');
  r.checked = true; r.dispatchEvent(new Event('change'));
  $('#peerCode').focus();
});

/* ---------- Réseau privé (VPN) ---------- */
function renderNetInfo() {
  const st = directStatus, pill = $('#vpnPill'), info = $('#vpnInfo');
  if (!st) { pill.dataset.s = 'connecting'; pill.textContent = 'Réseau privé…'; info.textContent = ''; return; }
  if (!st.enabled) { pill.dataset.s = 'idle'; pill.textContent = 'Réseau privé désactivé'; info.textContent = 'Le mode réseau privé est désactivé dans les réglages.'; return; }
  if (st.error) { pill.dataset.s = 'offline'; pill.textContent = 'Réseau privé : erreur'; info.textContent = st.error; return; }
  if (!st.listening.length) {
    pill.dataset.s = 'offline'; pill.textContent = 'Réseau privé : VPN non détecté';
    info.textContent = 'Aucun VPN détecté sur ce poste. Lancez Tailscale (ou votre VPN) pour voir directement les postes connectés.';
    return;
  }
  pill.dataset.s = 'online'; pill.textContent = 'Réseau privé : ' + directPeers.length + ' poste' + (directPeers.length > 1 ? 's' : '');
  info.textContent = 'À l’écoute sur ' + st.listening.join(', ') + ' (port ' + st.port + ').';
}
api.onDirectPeers((l) => { directPeers = Array.isArray(l) ? l : []; renderPeers(); });
api.onDirectStatus((st) => { const was = directStatus; directStatus = st; renderPeers(); if (!was || was.port !== st.port || was.enabled !== st.enabled) connectHub(); });
$('#refreshPeers').addEventListener('click', () => { api.directRefresh(); toast('Recherche des postes…'); });

// Hub de ce poste : les autres postes du réseau privé s'y connectent pour m'appeler.
async function connectHub() {
  const gen = ++hubGen;
  clearTimeout(hubRetryT);
  if (hub.ws) { try { hub.ws.onclose = null; hub.ws.close(); } catch { /* ignoré */ } hub.ws = null; }
  if (!cfg || !cfg.prenom || !directStatus || !directStatus.enabled) return;
  const info = await api.directInfo(); if (!info || gen !== hubGen) return;
  let sock;
  try { sock = hub.ws = new WebSocket(info.url); } catch { return; }
  sock.onopen = () => { hubRetry = 0; chSend(hub, { t: 'hello', name: cfg.prenom, code: myCode, key: cfg.key, inst: cfg.inst }); };
  sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m, hub); };
  sock.onclose = () => { if (sock !== hub.ws) return; hubRetryT = setTimeout(connectHub, Math.min(10000, 1000 * 2 ** hubRetry++)); };
  sock.onerror = () => {};
}
const sendCode = () => { chSend(net, { t: 'code', code: myCode }); chSend(hub, { t: 'code', code: myCode }); };

/* ---------- Connexion au serveur de signalisation ---------- */
function connectWs() {
  clearTimeout(retryT); noRetry = false;
  if (net.ws) { try { net.ws.onclose = null; net.ws.close(); } catch { /* ignoré */ } net.ws = null; }
  netPeers = []; renderPeers();
  if (!cfg.prenom) { setNet('offline', 'Prénom à choisir'); showSetup(); return; }
  if (!cfg.server) { setNet('idle', 'Serveur Internet : non configuré'); return; }
  setNet('connecting', 'Connexion au serveur…');
  let sock;
  try { sock = net.ws = new WebSocket(cfg.server); } catch { setNet('offline', 'Adresse du serveur invalide'); return; }
  sock.onopen = () => { retry = 0; wsSend({ t: 'hello', name: cfg.prenom, code: myCode, key: cfg.key, inst: cfg.inst }); };
  sock.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m, net); };
  sock.onclose = () => {
    if (sock !== net.ws) return;
    if (noRetry) return;
    setNet('offline', 'Hors ligne');
    retryT = setTimeout(connectWs, Math.min(10000, 1000 * 2 ** retry++));
  };
  sock.onerror = () => {};
}

function onMsg(m, ch) {
  const isNet = ch.kind === 'net';
  switch (m.t) {
    case 'welcome':
      if (Array.isArray(m.ice)) ch.ice = m.ice;   // liste vide acceptée : réseau local sans STUN
      if (isNet) setNet('online', 'En ligne');
      break;
    case 'idtaken':
      if (!isNet) { if (ch.kind === 'out') failOut(ch, 'Un poste de ce réseau porte déjà votre prénom.'); break; }
      noRetry = true; setNet('offline', 'Prénom déjà utilisé');
      showSetup('Un autre poste en ligne porte déjà le prénom « ' + cfg.prenom + ' ». Ajoutez un repère, par exemple « ' + cfg.prenom + '-Paris ».', 'Prénom déjà utilisé');
      break;
    case 'forbidden':
      if (!isNet) { if (ch.kind === 'out') failOut(ch, 'Clé de l’agence refusée par ce poste : vérifiez les réglages.'); break; }
      noRetry = true; setNet('offline', 'Clé de l’agence refusée');
      toast('Clé de l’agence incorrecte : vérifiez les réglages.'); $('#settings').open = true;
      break;
    case 'error':
      if (!isNet) { if (ch.kind === 'out' && m.reason === 'blocked') failOut(ch, REASONS.blocked); break; }
      if (m.reason === 'blocked') { noRetry = true; setNet('offline', 'Trop d’essais, patientez'); retryT = setTimeout(connectWs, 65000); }
      break;
    case 'peers': if (isNet) { netPeers = Array.isArray(m.list) ? m.list : []; renderPeers(); } break;
    case 'codeused':
      myCode = genCode(); renderSelf(); sendCode(); break;
    case 'ringing':
      if (outgoing && outgoing.ch === ch) $('#callText').textContent = 'En attente de l’acceptation de l’autre poste…'; break;
    case 'incoming': onIncoming(m, ch); break;
    case 'reply': onReply(m, ch); break;
    case 'signal': onSignal(m, ch); break;
    case 'bye':
      if (incoming && incoming.from === m.from && incoming.ch === ch) { closeIncoming(); toast('La demande a été annulée.'); }
      else if (sess && sess.peer === m.from && sess.ch === ch) endSession(false, 'L’autre poste a mis fin à la session.');
      break;
  }
}

/* ---------- Appel sortant ---------- */
function onReply(m, ch) {
  if (!outgoing || outgoing.ch !== ch) return;
  const o = outgoing; outgoing = null;
  $('#calling').hidden = true;
  if (m.ok) startSession({ peer: m.from, name: m.from, mode: o.mode, initiator: true, control: !!m.control, ch });
  else { closeOut(ch); const t = REASONS[m.reason] || 'Connexion impossible.'; $('#err').textContent = t; toast(t); }
}
function closeOut(ch, delay = 0) {
  if (!ch || ch.kind !== 'out' || !ch.ws) return;
  const w = ch.ws; ch.ws = null;
  setTimeout(() => { try { w.onclose = null; w.close(); } catch { /* ignoré */ } }, delay);
}
function failOut(ch, text) {
  if (!outgoing || outgoing.ch !== ch) return;
  outgoing = null; $('#calling').hidden = true; closeOut(ch);
  $('#err').textContent = text; toast(text);
}
// Appel direct : liaison vers le hub du poste appelé (réseau privé), puis appel avec son code.
function callDirect(route, to, code, mode) {
  const ch = { kind: 'out', ws: null, ice: [] };
  outgoing = { to, mode, ch };
  $('#callText').textContent = 'Appel de ' + to + ' (réseau privé)…';
  $('#calling').hidden = false;
  let sock;
  const unreachable = () => {
    if (!outgoing || outgoing.ch !== ch) return;
    if (net.ws && net.ws.readyState === 1) { closeOut(ch); callNet(to, code, mode); }      // repli : serveur Internet
    else failOut(ch, 'Poste injoignable sur le réseau privé.');
  };
  try { sock = ch.ws = new WebSocket('ws://' + (route.host.includes(':') ? '[' + route.host + ']' : route.host) + ':' + route.port); } catch { unreachable(); return; }
  const timer = setTimeout(() => { if (!ch.welcomed) unreachable(); }, 5000);
  sock.onopen = () => chSend(ch, { t: 'hello', name: cfg.prenom, code: myCode, key: cfg.key, inst: cfg.inst });
  sock.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'welcome') { ch.welcomed = true; clearTimeout(timer); ch.ice = Array.isArray(m.ice) ? m.ice : []; chSend(ch, { t: 'call', to, code, mode }); return; }
    onMsg(m, ch);
  };
  sock.onerror = () => {};
  sock.onclose = () => {
    clearTimeout(timer);
    if (!ch.welcomed) unreachable();
    else if (outgoing && outgoing.ch === ch) failOut(ch, 'La liaison avec le poste a été interrompue.');
  };
}
function callNet(to, code, mode) {
  outgoing = { to, mode, ch: net };
  $('#callText').textContent = 'Appel de ' + to + '…';
  $('#calling').hidden = false;
  wsSend({ t: 'call', to, code, mode });
}

/* ---------- Appel entrant ---------- */
function onIncoming(m, ch) {
  if (sess || incoming || outgoing) { chSend(ch, { t: 'reply', to: m.from, ok: false }); return; }
  incoming = { ...m, ch };
  $('#inText').textContent = m.mode === 'control'
    ? m.from + ' demande à voir votre écran et à le piloter.'
    : m.from + ' souhaite vous présenter son écran.';
  $('#inCtlRow').hidden = m.mode !== 'control';
  $('#inCtl').checked = false;
  $('#incoming').hidden = false; $('#inYes').focus();
}
function closeIncoming() { incoming = null; $('#incoming').hidden = true; }

/* ---------- Session ---------- */
async function startSession(o) {
  const sharer = o.initiator ? o.mode === 'present' : o.mode === 'control';
  const s = sess = {
    peer: o.peer, name: o.name, mode: o.mode, sharer, control: !!o.control, ch: o.ch,
    canInject: true, pc: null, dc: null, stream: null, cands: [], sec: 0, tickT: null, statT: null,
    sentDown: new Set(), btnDown: new Set(), reqTimer: null,
  };
  if (sharer) {
    s.canInject = await api.inputAvailable();
    if (!s.canInject) s.control = false;
  }
  if (sess !== s) return;

  show('session');
  $('#peerName').textContent = o.name;
  $('#viewer').hidden = sharer; $('#sharer').hidden = !sharer;
  $('#btnFull').hidden = sharer;
  $('#wait').hidden = false; $('#reqbar').hidden = true;
  $('#timer').textContent = '00:00'; $('#netInfo').textContent = 'connexion…';
  updateUi();
  s.tickT = setInterval(() => { s.sec++; $('#timer').textContent = String(Math.floor(s.sec / 60)).padStart(2, '0') + ':' + String(s.sec % 60).padStart(2, '0'); }, 1000);

  const pc = s.pc = new RTCPeerConnection({ iceServers: o.ch.ice });
  pc.onicecandidate = (e) => { if (e.candidate && sess === s) chSend(s.ch, { t: 'signal', to: s.peer, data: { c: e.candidate.toJSON() } }); };
  pc.onconnectionstatechange = () => {
    if (sess !== s) return;
    if (pc.connectionState === 'connected') { clearInterval(s.statT); s.statT = setInterval(() => readStats(s), 2000); readStats(s); }
    else if (pc.connectionState === 'disconnected') $('#netInfo').textContent = 'connexion instable…';
    else if (pc.connectionState === 'failed') endSession(true, 'La connexion a échoué. Un relais TURN est peut-être nécessaire.');
  };
  pc.ontrack = (e) => { if (sess !== s) return; $('#video').srcObject = e.streams[0]; $('#wait').hidden = true; };
  pc.ondatachannel = (e) => wireDc(s, e.channel);

  if (sharer) startSharing(s);
}

async function startSharing(s) {
  try {
    s.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  } catch (e) {
    if (sess === s) endSession(true, 'Capture de l’écran impossible : ' + (e.message || e.name));
    return;
  }
  if (sess !== s) { s.stream.getTracks().forEach((t) => t.stop()); return; }
  const vt = s.stream.getVideoTracks()[0];
  vt.contentHint = 'detail';
  vt.onended = () => { if (sess === s) endSession(true, 'Le partage d’écran a été interrompu.'); };
  s.pc.addTrack(vt, s.stream);
  wireDc(s, s.pc.createDataChannel('input', { ordered: true }));
  const offer = await s.pc.createOffer();
  await s.pc.setLocalDescription(offer);
  chSend(s.ch, { t: 'signal', to: s.peer, data: { sdp: s.pc.localDescription.toJSON() } });
  try {
    const sender = s.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
    const p = sender.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = 6e6; p.encodings[0].maxFramerate = 30;
    await sender.setParameters(p);
  } catch { /* réglage facultatif */ }
}

async function onSignal(m, ch) {
  const s = sess;
  if (!s || m.from !== s.peer || ch !== s.ch || !m.data) return;
  const d = m.data;
  try {
    if (d.sdp) {
      await s.pc.setRemoteDescription(d.sdp);
      for (const c of s.cands.splice(0)) await s.pc.addIceCandidate(c).catch(() => {});
      if (d.sdp.type === 'offer') {
        const a = await s.pc.createAnswer();
        await s.pc.setLocalDescription(a);
        chSend(s.ch, { t: 'signal', to: s.peer, data: { sdp: s.pc.localDescription.toJSON() } });
      }
    } else if (d.c) {
      if (s.pc.remoteDescription) await s.pc.addIceCandidate(d.c).catch(() => {});
      else s.cands.push(d.c);
    }
  } catch (e) { console.error('signal:', e); }
}

function wireDc(s, dc) {
  s.dc = dc;
  dc.onopen = () => { if (s.sharer && sess === s) dc.send(JSON.stringify({ t: 'perm', control: s.control })); };
  dc.onmessage = (e) => {
    if (sess !== s) return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (s.sharer) {
      if (m.t === 'reqctl') showCtlRequest(s);
      else if (m.k && s.control) api.input(m);          // le poste partageant revérifie toujours l'autorisation
    } else if (m.t === 'perm') {
      s.control = !!m.control; updateUi();
      toast(s.control ? 'Vous pouvez maintenant contrôler ce poste.' : 'Le contrôle a été retiré.');
      if (!s.control) releaseAll(s);
    }
  };
}

/* Poste qui partage : accorder ou retirer le contrôle */
function setControl(s, v) {
  if (!s.sharer || !s.canInject) return;
  s.control = v;
  if (s.dc && s.dc.readyState === 'open') s.dc.send(JSON.stringify({ t: 'perm', control: v }));
  if (!v) api.inputReset();
  $('#reqbar').hidden = true;
  updateUi();
}
function showCtlRequest(s) {
  if (!s.canInject) return;
  $('#reqText').textContent = s.name + ' demande à contrôler votre poste.';
  $('#reqbar').hidden = false;
}

function updateUi() {
  const s = sess; if (!s) return;
  const chip = $('#roleChip'), banner = $('#banner'), btn = $('#btnCtl');
  const ctl = s.control;
  chip.classList.toggle('ctl', ctl); banner.classList.toggle('ctl', ctl);
  if (s.sharer) {
    chip.textContent = ctl ? 'Contrôlé à distance' : 'Vous partagez';
    banner.textContent = ctl
      ? s.name + ' contrôle votre poste. Ctrl+Alt+X ou « Reprendre la main » pour reprendre.'
      : s.name + ' voit votre écran. Il ne peut utiliser ni votre souris ni votre clavier.';
    $('#shareText').textContent = banner.textContent;
    btn.hidden = !s.canInject; btn.textContent = ctl ? 'Reprendre la main' : 'Autoriser le contrôle';
    btn.setAttribute('aria-pressed', String(ctl));
    if (!s.canInject) $('#shareText').textContent += ' (Contrôle indisponible sur ce poste.)';
  } else {
    chip.textContent = ctl ? 'Vous contrôlez' : 'Vous observez';
    banner.textContent = ctl
      ? 'Vous contrôlez le poste de ' + s.name + '. Votre souris et votre clavier agissent sur son écran.'
      : (s.mode === 'present' ? s.name + ' vous présente son écran.' : 'Vous voyez l’écran de ' + s.name + '. Demandez le contrôle pour agir.');
    btn.hidden = ctl; btn.textContent = 'Demander le contrôle'; btn.setAttribute('aria-pressed', 'false');
    $('#viewer').classList.toggle('live', ctl);
    if (ctl) $('#viewer').focus();
  }
}

async function readStats(s) {
  try {
    const stats = await s.pc.getStats();
    let rtt = null, kind = '';
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        rtt = r.currentRoundTripTime;
        const l = stats.get(r.localCandidateId), q = stats.get(r.remoteCandidateId);
        kind = (l && l.candidateType === 'relay') || (q && q.candidateType === 'relay') ? 'relais' : 'direct';
      }
    });
    if (sess === s && rtt !== null) $('#netInfo').textContent = Math.round(rtt * 1000) + ' ms · ' + kind;
  } catch { /* ignoré */ }
}

function endSession(notify, msg) {
  const s = sess; if (!s) return;
  sess = null;
  if (notify) chSend(s.ch, { t: 'bye' });
  closeOut(s.ch, 400);                      // laisse partir le « bye » avant de fermer la liaison temporaire
  clearInterval(s.tickT); clearInterval(s.statT);
  try { s.dc && s.dc.close(); } catch { /* ignoré */ }
  try { s.pc && s.pc.close(); } catch { /* ignoré */ }
  if (s.stream) s.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  $('#video').srcObject = null;
  api.inputReset();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  show('home');
  toast(msg || 'Session terminée');
}

/* ---------- Commandes envoyées par le poste qui contrôle ---------- */
const viewer = $('#viewer'), video = $('#video');
const canSend = () => !!sess && !sess.sharer && sess.control && sess.dc && sess.dc.readyState === 'open';
const sendIn = (o) => { try { sess.dc.send(JSON.stringify(o)); } catch { /* canal fermé */ } };
function videoPos(e) {
  const r = video.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  const k = Math.min(r.width / vw, r.height / vh), w = vw * k, h = vh * k;
  const ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  return { x: Math.min(1, Math.max(0, (e.clientX - ox) / w)), y: Math.min(1, Math.max(0, (e.clientY - oy) / h)) };
}
function releaseAll(s) {
  if (!s || s.sharer || !s.dc || s.dc.readyState !== 'open') { if (s) { s.sentDown.clear(); s.btnDown.clear(); } return; }
  s.sentDown.forEach((code) => s.dc.send(JSON.stringify({ k: 'ku', code })));
  s.btnDown.forEach((b) => s.dc.send(JSON.stringify({ k: 'mu', b })));
  s.sentDown.clear(); s.btnDown.clear();
}
const printable = (e) => e.key.length === 1 && !e.metaKey && (!e.ctrlKey || e.getModifierState('AltGraph')) && (!e.altKey || e.getModifierState('AltGraph'));
let moveP = null, raf = 0;
viewer.addEventListener('mousemove', (e) => {
  if (!canSend()) return;
  const p = videoPos(e); if (!p) return;
  moveP = p;
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (moveP && canSend()) sendIn({ k: 'mm', x: moveP.x, y: moveP.y }); moveP = null; });
});
viewer.addEventListener('mousedown', (e) => {
  viewer.focus();
  if (!canSend()) return;
  const p = videoPos(e); if (!p) return;
  e.preventDefault(); sess.btnDown.add(e.button); sendIn({ k: 'md', b: e.button, x: p.x, y: p.y });
});
viewer.addEventListener('mouseup', (e) => { if (!canSend()) return; e.preventDefault(); sess.btnDown.delete(e.button); sendIn({ k: 'mu', b: e.button }); });
viewer.addEventListener('mouseleave', () => { if (sess && !sess.sharer) { sess.btnDown.forEach((b) => sendIn({ k: 'mu', b })); sess.btnDown.clear(); } });
viewer.addEventListener('wheel', (e) => { if (!canSend()) return; e.preventDefault(); sendIn({ k: 'wh', dx: e.deltaX, dy: e.deltaY }); }, { passive: false });
viewer.addEventListener('contextmenu', (e) => { if (canSend()) e.preventDefault(); });
viewer.addEventListener('keydown', (e) => {
  if (!canSend()) return;
  e.preventDefault();
  if (printable(e)) { sendIn({ k: 'ty', text: e.key }); return; }
  sess.sentDown.add(e.code); sendIn({ k: 'kd', code: e.code });
});
viewer.addEventListener('keyup', (e) => {
  if (!canSend()) return;
  e.preventDefault();
  if (sess.sentDown.delete(e.code)) sendIn({ k: 'ku', code: e.code });
});
viewer.addEventListener('blur', () => { if (sess) releaseAll(sess); });

/* ---------- Interface ---------- */
$('#btnCtl').addEventListener('click', () => {
  const s = sess; if (!s) return;
  if (s.sharer) setControl(s, !s.control);
  else if (s.dc && s.dc.readyState === 'open') {
    s.dc.send(JSON.stringify({ t: 'reqctl' }));
    $('#btnCtl').disabled = true; setTimeout(() => { $('#btnCtl').disabled = false; }, 10000);
    toast('Demande envoyée à ' + s.name + '.');
  }
});
$('#reqYes').addEventListener('click', () => { if (sess) setControl(sess, true); });
$('#reqNo').addEventListener('click', () => { $('#reqbar').hidden = true; });
$('#btnEnd').addEventListener('click', () => endSession(true, 'Session terminée'));
$('#btnFull').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else viewer.requestFullscreen().catch(() => {}); });
api.onPanic(() => { if (sess && sess.sharer && sess.control) { setControl(sess, false); toast('Contrôle à distance arrêté.'); } });

$('#peerCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  const ctl = r.value === 'control' && r.checked;
  if (!r.checked) return;
  $('#goBtn').classList.toggle('ctl', ctl);
  $('#goBtn').textContent = ctl ? 'Prendre le contrôle' : 'Présenter mon écran';
}));
$('#connectForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const to = cleanName($('#target').value), code = $('#peerCode').value, err = $('#err');
  if (!NAME_RE.test(to)) { err.textContent = 'Saisissez le prénom du poste à joindre.'; return; }
  if (code.length !== 6) { err.textContent = 'Le code compte 6 signes. Demandez-le à la personne au poste distant.'; return; }
  if (norm(to) === norm(cfg.prenom)) { err.textContent = 'C’est le prénom de ce poste.'; return; }
  const route = allPeers().find((p) => norm(p.name) === norm(to) && p.via === 'direct');
  const netUp = !!net.ws && net.ws.readyState === 1;
  if (!route && !netUp) { err.textContent = cfg.server ? 'Pas de connexion au serveur.' : 'Ce poste n’est pas visible sur le réseau privé. Vérifiez que le VPN est actif des deux côtés.'; return; }
  err.textContent = '';
  const mode = document.querySelector('input[name="mode"]:checked').value;
  if (route) callDirect(route, to, code, mode); else callNet(to, code, mode);
});
$('#callCancel').addEventListener('click', () => { if (outgoing) { chSend(outgoing.ch, { t: 'bye' }); closeOut(outgoing.ch, 300); } outgoing = null; $('#calling').hidden = true; });
$('#inNo').addEventListener('click', () => { if (incoming) chSend(incoming.ch, { t: 'reply', to: incoming.from, ok: false }); closeIncoming(); });
$('#inYes').addEventListener('click', () => {
  if (!incoming) return;
  const m = incoming, control = m.mode === 'control' && $('#inCtl').checked;
  chSend(m.ch, { t: 'reply', to: m.from, ok: true, control });
  closeIncoming();
  startSession({ peer: m.from, name: m.from, mode: m.mode, initiator: false, control, ch: m.ch });
});
$('#newCode').addEventListener('click', () => { myCode = genCode(); renderSelf(); sendCode(); });
$('#copyCode').addEventListener('click', () => {
  navigator.clipboard.writeText(myCode).then(() => toast('Code copié.'), () => toast('Copie impossible.'));
});
$('#saveSettings').addEventListener('click', async () => {
  const server = $('#setServer').value.trim(), prenom = cleanName($('#setPrenom').value);
  if (server && !/^wss?:\/\/.+/.test(server)) { toast('L’adresse du serveur doit commencer par ws:// ou wss:// (ou rester vide).'); return; }
  if (!NAME_RE.test(prenom)) { toast('Prénom invalide : lettres, chiffres, espace, tiret ou apostrophe.'); return; }
  cfg = await api.setConfig({ prenom, server, key: $('#setKey').value, directEnabled: $('#setDirect').checked, directNets: $('#setNets').value, directPeers: $('#setPeers').value });
  fillSettings(); renderSelf(); connectWs(); connectHub(); toast('Réglages enregistrés.');
});

function fillSettings() {
  $('#setPrenom').value = cfg.prenom; $('#setServer').value = cfg.server; $('#setKey').value = cfg.key;
  $('#setDirect').checked = cfg.directEnabled !== false;
  $('#setNets').value = cfg.directNets || ''; $('#setPeers').value = cfg.directPeers || '';
}

/* ---------- Démarrage ---------- */
(async () => {
  cfg = await api.getConfig();
  myCode = genCode();
  renderSelf();
  fillSettings();
  const inj = await api.inputAvailable();
  $('#injectInfo').textContent = inj
    ? 'Contrôle à distance : disponible sur ce poste.' + (api.platform === 'darwin' ? ' Sur Mac, autorisez l’app dans Réglages Système > Confidentialité (Enregistrement de l’écran et Accessibilité).' : '')
    : 'Contrôle à distance : indisponible sur ce poste (module de saisie non chargé). La présentation fonctionne.';
  connectWs();
  directStatus = null; renderPeers();
  connectHub();
})();
})();
