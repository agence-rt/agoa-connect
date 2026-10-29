'use strict';
const { app, BrowserWindow, ipcMain, session, desktopCapturer, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_SERVER = process.env.CONNECT_SERVER || 'ws://localhost:8080';
let win = null;

/* ---------- Configuration locale ---------- */
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const NAME_RE = /^\p{L}[\p{L}\p{N} '’-]{0,29}$/u;
function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { /* première exécution */ }
  // Le prénom identifie le poste ; il est demandé au premier lancement (ou fourni par CONNECT_PRENOM, par exemple par le launcher).
  if (!NAME_RE.test(c.prenom || '')) c.prenom = NAME_RE.test(process.env.CONNECT_PRENOM || '') ? process.env.CONNECT_PRENOM : '';
  if (!c.server) c.server = DEFAULT_SERVER;
  if (typeof c.key !== 'string' || !c.key) c.key = process.env.CONNECT_KEY || '';
  if (!/^[\w-]{8,64}$/.test(c.inst || '')) c.inst = crypto.randomUUID();
  delete c.id; delete c.name;
  saveConfig(c);
  return c;
}
function saveConfig(c) { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2)); }

/* ---------- Injection souris / clavier (poste qui partage son écran) ---------- */
let nut = null;
function loadNut() {
  if (nut !== null) return nut;
  try {
    nut = require('@nut-tree-fork/nut-js');
    nut.mouse.config.autoDelayMs = 0;
    nut.keyboard.config.autoDelayMs = 0;
  } catch (e) {
    console.error('Injection de commandes indisponible :', e.message);
    nut = false;
  }
  return nut;
}

const KEYS = {};
function buildKeys(Key) {
  const add = (code, name) => { if (Key[name] !== undefined) KEYS[code] = Key[name]; };
  for (const L of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') add('Key' + L, L);
  for (let i = 0; i <= 9; i++) add('Digit' + i, 'Num' + i);
  for (let i = 1; i <= 12; i++) add('F' + i, 'F' + i);
  Object.entries({
    Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Space: 'Space', Escape: 'Escape', Delete: 'Delete',
    Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
    AltLeft: 'LeftAlt', AltRight: 'RightAlt', MetaLeft: 'LeftSuper', MetaRight: 'RightSuper', CapsLock: 'CapsLock',
    Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash',
    Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash', Backquote: 'Grave',
  }).forEach(([code, name]) => add(code, name));
}

function toScreenPoint(nx, ny) {
  const b = screen.getPrimaryDisplay().bounds;
  const x = b.x + Math.min(1, Math.max(0, nx)) * (b.width - 1);
  const y = b.y + Math.min(1, Math.max(0, ny)) * (b.height - 1);
  return process.platform === 'win32' ? screen.dipToScreenPoint({ x, y }) : { x, y };
}

const down = new Set();     // touches enfoncées à distance, relâchées en fin de session
const buttons = new Set();
let chain = Promise.resolve();

async function apply(ev) {
  const n = loadNut();
  if (!n) return;
  const { mouse, keyboard, Button, Point } = n;
  if (!KEYS.KeyA) buildKeys(n.Key);
  const BTN = { 0: Button.LEFT, 1: Button.MIDDLE, 2: Button.RIGHT };
  switch (ev.k) {
    case 'mm': { const p = toScreenPoint(ev.x, ev.y); await mouse.setPosition(new Point(Math.round(p.x), Math.round(p.y))); break; }
    case 'md': {
      const p = toScreenPoint(ev.x, ev.y); await mouse.setPosition(new Point(Math.round(p.x), Math.round(p.y)));
      const b = BTN[ev.b]; if (b !== undefined) { buttons.add(b); await mouse.pressButton(b); } break;
    }
    case 'mu': { const b = BTN[ev.b]; if (b !== undefined) { buttons.delete(b); await mouse.releaseButton(b); } break; }
    case 'wh': {
      const dy = Number(ev.dy) || 0, dx = Number(ev.dx) || 0;
      const steps = (v) => Math.max(1, Math.round(Math.abs(v) / 40));
      if (dy > 0) await mouse.scrollDown(steps(dy)); else if (dy < 0) await mouse.scrollUp(steps(dy));
      if (dx > 0) await mouse.scrollRight(steps(dx)); else if (dx < 0) await mouse.scrollLeft(steps(dx));
      break;
    }
    case 'ty': if (typeof ev.text === 'string' && ev.text.length <= 4) await keyboard.type(ev.text); break;
    case 'kd': { const k = KEYS[ev.code]; if (k !== undefined) { down.add(k); await keyboard.pressKey(k); } break; }
    case 'ku': { const k = KEYS[ev.code]; if (k !== undefined) { down.delete(k); await keyboard.releaseKey(k); } break; }
  }
}

async function resetInput() {
  const n = loadNut();
  if (!n) return;
  for (const k of [...down]) { try { await n.keyboard.releaseKey(k); } catch { /* ignoré */ } }
  for (const b of [...buttons]) { try { await n.mouse.releaseButton(b); } catch { /* ignoré */ } }
  down.clear(); buttons.clear();
}

ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:set', (_e, patch) => {
  const c = loadConfig();
  if (patch && typeof patch.prenom === 'string') {
    const p = patch.prenom.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (NAME_RE.test(p)) c.prenom = p;
  }
  if (patch && typeof patch.server === 'string' && /^wss?:\/\//.test(patch.server)) c.server = patch.server.trim();
  if (patch && typeof patch.key === 'string') c.key = patch.key.trim().slice(0, 200);
  saveConfig(c);
  return c;
});
ipcMain.handle('input:available', () => !!loadNut());
ipcMain.handle('input:send', (_e, ev) => {
  if (!ev || typeof ev.k !== 'string') return false;
  chain = chain.then(() => apply(ev)).catch((e) => console.error('input:', e.message));
  return true;
});
ipcMain.handle('input:reset', () => { chain = chain.then(resetInput); return true; });

/* ---------- Fenêtre ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 760, minHeight: 560,
    title: 'CONNECT',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  // Capture de l'écran principal sans fenêtre de sélection : l'utilisateur a déjà accepté la connexion dans l'application.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primary = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.display_id === primary) || sources[0];
      callback(src ? { video: src } : {});
    } catch { callback({}); }
  });
  createWindow();
  // Arrêt d'urgence du contrôle à distance, utilisable même quand l'autre poste tient la souris.
  globalShortcut.register('CommandOrControl+Alt+X', () => { if (win) win.webContents.send('panic'); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
