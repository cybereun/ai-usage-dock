const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ ai-usage-dock\/\S+/, '');
if (!app.requestSingleInstanceLock()) app.quit();

const SERVICES = {
  claude: { name: 'Claude', color: '#d97757', url: 'https://claude.ai/settings/usage', mode: 'auto' },
  codex: { name: 'Codex', color: '#10a37f', url: 'https://chatgpt.com/codex/settings/usage', mode: 'auto' },
  gemini: { name: 'Gemini', color: '#4f8cff', url: 'https://gemini.google.com/app', mode: 'manual' },
  antigravity: { name: 'Antigravity', color: '#a855f7', url: '', mode: 'manual' },
  grok: { name: 'Grok', color: '#9ca3af', url: 'https://grok.com', mode: 'manual' },
  custom: { name: '기타', color: '#f59e0b', url: '', mode: 'manual' },
};

const DEFAULT_SETTINGS = { topTrigger: true, clockTrigger: true, intervalMin: 3, autoStart: false, topWidth: 420 };
let store = { accounts: [], settings: { ...DEFAULT_SETTINGS } };
let widget, settingsWin, tray;
let pinned = false, visible = false, mode = 'top', widgetH = 200, hideTimer = 0, dwell = 0;
const WIDTH = 760;

const file = () => path.join(app.getPath('userData'), 'data.json');
function load() {
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); store = { accounts: d.accounts || [], settings: { ...DEFAULT_SETTINGS, ...d.settings } }; } catch {}
}
function save() { try { fs.writeFileSync(file(), JSON.stringify(store, null, 1)); } catch {} }
function publish() {
  const payload = { accounts: store.accounts, settings: store.settings, services: SERVICES };
  for (const w of [widget, settingsWin]) if (w && !w.isDestroyed()) w.webContents.send('state', payload);
  save();
}

// ---------- 사용량 읽기 ----------
function parseUsage(text) {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const joined = lines.join('\n');
  const find = (re) => {
    const m = re.exec(joined); if (!m) return null;
    const seg = joined.slice(m.index, m.index + 260);
    const p = /(\d+(?:\.\d+)?)\s*%\s*(used|remaining|left|사용|남음|남았)?/i.exec(seg);
    if (!p) return null;
    let pct = parseFloat(p[1]);
    const rem = /remaining|left|남음|남았/i.test(p[2] || '') || /remaining|left|남음|남았/i.test(seg.slice(p.index, p.index + 40));
    if (rem) pct = 100 - pct;
    const r = /(resets?[^\n]{0,40}|초기화[^\n]{0,30}|\d+\s*(?:hr|시간)[^\n]{0,20}(?:min|분)?)/i.exec(seg);
    return { pct: Math.max(0, Math.min(100, Math.round(pct))), reset: r ? r[1].trim() : '' };
  };
  const h5 = find(/current session|5[\s-]?hour|5시간/i);
  const wk = find(/weekly|per week|week\b|주간/i);
  return h5 || wk ? { h5: h5 || { pct: 0, reset: '' }, wk: wk || { pct: 0, reset: '' } } : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function readAccount(acc) {
  if (acc.mode === 'manual') { acc.status = 'manual'; acc.updated = Date.now(); return; }
  if (!acc.url) { acc.status = 'error'; acc.msg = 'URL 이 비어 있어요'; return; }
  const w = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { partition: 'persist:acct-' + acc.id, backgroundThrottling: false } });
  try {
    w.loadURL(acc.url).catch(() => {});
    await Promise.race([new Promise(r => w.webContents.once('did-finish-load', r)), sleep(20000)]);
    let usage = null;
    for (let i = 0; i < 8 && !usage; i++) {
      await sleep(1500);
      const text = await w.webContents.executeJavaScript('document.body.innerText').catch(() => '');
      usage = parseUsage(text || '');
    }
    const cur = w.webContents.getURL();
    if (usage) { Object.assign(acc, usage, { status: 'ok', msg: '', updated: Date.now() }); }
    else if (/login|signin|sign-in|auth|accounts\.google|log-in/i.test(cur)) { acc.status = 'login'; acc.msg = '로그인이 필요해요'; }
    else { acc.status = 'error'; acc.msg = '사용량을 찾지 못했어요 (로그인 확인 또는 수동 입력)'; }
  } catch (e) { acc.status = 'error'; acc.msg = String(e.message || e); }
  finally { if (!w.isDestroyed()) w.destroy(); }
}
let busy = new Set();
async function refresh(id) {
  const list = store.accounts.filter(a => !id || a.id === id);
  await Promise.all(list.map(async a => {
    if (busy.has(a.id)) return; busy.add(a.id); a.loading = true; publish();
    await readAccount(a); a.loading = false; busy.delete(a.id); publish();
  }));
}
function openLogin(id) {
  const acc = store.accounts.find(a => a.id === id); if (!acc || !acc.url) return;
  const w = new BrowserWindow({ width: 1000, height: 780, title: SERVICES[acc.service].name + ' 로그인 — 다 되면 창을 닫으세요', autoHideMenuBar: true, webPreferences: { partition: 'persist:acct-' + acc.id } });
  w.loadURL(acc.url);
  w.on('closed', () => refresh(acc.id));
}

// ---------- 창 ----------
function createWidget() {
  widget = new BrowserWindow({
    width: WIDTH, height: widgetH, x: -5000, y: -5000, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.loadFile(path.join(__dirname, 'widget.html'));
  widget.once('ready-to-show', () => { widget.showInactive(); place(false); });
}
function place(show) {
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  const b = d.bounds, wa = d.workArea;
  const h = widgetH;
  if (!show) { widget.setBounds({ x: b.x, y: -h - 200, width: WIDTH, height: h }); return; }
  if (mode === 'clock') widget.setBounds({ x: b.x + b.width - WIDTH - 6, y: wa.y + wa.height - h + 6, width: WIDTH, height: h });
  else widget.setBounds({ x: Math.round(b.x + (b.width - WIDTH) / 2), y: b.y, width: WIDTH, height: h });
}
function showWidget(m) {
  if (visible && m === mode) return;
  mode = m || mode; visible = true; place(true);
  widget.webContents.send('visibility', { show: true, mode });
  const stale = store.accounts.some(a => !a.updated || Date.now() - a.updated > 60000);
  if (stale) refresh();
}
function hideWidget() {
  if (!visible || pinned) return; visible = false;
  widget.webContents.send('visibility', { show: false, mode });
  setTimeout(() => { if (!visible) place(false); }, 260);
}
function tick() {
  if (!widget || widget.isDestroyed()) return;
  const p = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(p);
  const b = d.bounds, wa = d.workArea, s = store.settings;
  const inTop = s.topTrigger && p.y <= b.y + 1 && Math.abs(p.x - (b.x + b.width / 2)) < s.topWidth / 2;
  const inClock = s.clockTrigger && p.y >= wa.y + wa.height && p.y <= b.y + b.height && p.x >= b.x + b.width - 230;
  const wb = widget.getBounds();
  const inWin = visible && p.x >= wb.x - 6 && p.x <= wb.x + wb.width + 6 && p.y >= wb.y - 6 && p.y <= wb.y + wb.height + 6;
  if (inTop || inClock) {
    dwell += 100;
    if (dwell >= (inClock ? 350 : 150)) showWidget(inClock ? 'clock' : 'top');
    hideTimer = 0;
  } else {
    dwell = 0;
    if (visible && !inWin && !pinned) { hideTimer += 100; if (hideTimer >= 600) { hideTimer = 0; hideWidget(); } }
    else hideTimer = 0;
  }
}
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({ width: 920, height: 720, minWidth: 720, title: 'AI 사용량 — 설정', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#0f1320', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}

// ---------- 트레이 아이콘 (PNG 직접 생성) ----------
function makeIcon() {
  const N = 32, raw = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    for (let x = 0; x < N; x++) {
      const dx = x - 15.5, dy = y - 15.5, r = Math.hypot(dx, dy);
      const o = y * (N * 4 + 1) + 1 + x * 4;
      let c = null;
      if (r <= 15 && r >= 10.5) { const a = (Math.atan2(dy, dx) + Math.PI * 2.5) % (Math.PI * 2); c = a < Math.PI * 1.35 ? [96, 165, 250] : [75, 85, 120]; }
      else if (r < 6.5) c = [250, 250, 255];
      if (c) { raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2]; raw[o + 3] = 255; }
    }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  return nativeImage.createFromBuffer(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

let timer;
function schedule() { clearInterval(timer); timer = setInterval(() => refresh(), Math.max(1, store.settings.intervalMin) * 60000); }

app.whenReady().then(() => {
  load(); createWidget();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 32, height: 32 })); tray.setToolTip('AI 사용량');
  const menu = () => Menu.buildFromTemplate([
    { label: '지금 보기 (Ctrl+Alt+U)', click: () => togglePin() },
    { label: '새로고침', click: () => refresh() },
    { label: '설정 · 계정 관리', click: openSettings },
    { type: 'separator' }, { label: '종료', click: () => app.exit() }]);
  tray.setContextMenu(menu()); tray.on('click', togglePin); tray.on('double-click', openSettings);
  globalShortcut.register('Control+Alt+U', togglePin);
  setInterval(tick, 100); schedule();
  if (!store.accounts.length) setTimeout(openSettings, 600); else refresh();
});
function togglePin() { if (visible) { pinned = false; hideWidget(); } else { pinned = true; showWidget('top'); setTimeout(() => { pinned = false; }, 6000); } }
app.on('window-all-closed', (e) => e.preventDefault());
app.on('second-instance', openSettings);

// ---------- IPC ----------
const uid = () => Math.random().toString(36).slice(2, 9);
ipcMain.handle('state', () => ({ accounts: store.accounts, settings: store.settings, services: SERVICES }));
ipcMain.on('refresh', (_, id) => refresh(id));
ipcMain.on('login', (_, id) => openLogin(id));
ipcMain.on('openSettings', openSettings);
ipcMain.on('size', (_, h) => { h = Math.ceil(h); if (h !== widgetH) { widgetH = h; if (visible) place(true); else place(false); } });
ipcMain.on('hold', (_, v) => { pinned = !!v; });
ipcMain.on('add', (_, { service, label }) => {
  const s = SERVICES[service] || SERVICES.custom;
  store.accounts.push({ id: uid(), service, label: label || '', url: s.url, mode: s.mode, h5: { pct: 0, reset: '' }, wk: { pct: 0, reset: '' }, status: 'idle', updated: 0 });
  publish(); if (s.mode === 'auto') refresh(store.accounts[store.accounts.length - 1].id);
});
ipcMain.on('update', (_, { id, patch }) => { const a = store.accounts.find(x => x.id === id); if (a) { Object.assign(a, patch); if (a.mode === 'manual') { a.status = 'manual'; a.updated = Date.now(); } publish(); } });
ipcMain.on('remove', (_, id) => { store.accounts = store.accounts.filter(a => a.id !== id); publish(); });
ipcMain.on('move', (_, { id, dir }) => { const i = store.accounts.findIndex(a => a.id === id), j = i + dir; if (i < 0 || j < 0 || j >= store.accounts.length) return; [store.accounts[i], store.accounts[j]] = [store.accounts[j], store.accounts[i]]; publish(); });
ipcMain.on('settings', (_, patch) => {
  Object.assign(store.settings, patch);
  app.setLoginItemSettings({ openAtLogin: !!store.settings.autoStart });
  schedule(); publish();
});
