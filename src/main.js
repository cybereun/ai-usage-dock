const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, '').replace(/ ai-usage-dock\/\S+/, '');
// 설정·로그인 정보는 C: 드라이브가 아니라 exe 옆 data 폴더에 저장
app.setPath('userData', path.join(path.dirname(process.execPath), 'data'));
if (!app.requestSingleInstanceLock()) app.quit();
const { spawn, execFile } = require('child_process');
// 구글 로그인은 앱 내장 브라우저를 막으므로, 설치된 Chrome(없으면 Edge)을 계정별 전용 프로필로 사용한다
const browserExe = () => [process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe', process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe', process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe', process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe', process.env.ProgramFiles + '\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profileDir = (id) => path.join(app.getPath('userData'), 'profiles', id);

const SERVICES = {
  claude: { name: 'Claude', color: '#d97757', url: 'https://claude.ai/settings/usage', mode: 'auto' },
  codex: { name: 'Codex', color: '#10a37f', url: 'https://chatgpt.com/codex/cloud/settings/usage', mode: 'auto' },
  gemini: { name: 'Gemini', color: '#4f8cff', url: 'https://gemini.google.com/app', mode: 'manual' },
  antigravity: { name: 'Antigravity', color: '#a855f7', url: '', mode: 'cli' },
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
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); store = { accounts: d.accounts || [], settings: { ...DEFAULT_SETTINGS, ...d.settings } }; store.accounts.forEach(a => { if (a.url === 'https://chatgpt.com/codex/settings/usage') a.url = SERVICES.codex.url; }); } catch {}
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
    const r = /(resets?[^\n]{0,40}|재설정[^\n]{0,30}|초기화[^\n]{0,30}|\d+\s*(?:시간|분|hr|min)[^\n]{0,10}(?:후|left|remaining)[^\n]{0,12})/i.exec(seg);
    return { pct: Math.max(0, Math.min(100, Math.round(pct))), reset: r ? r[1].trim().replace(/^(재설정|resets?)\s*[:：]?\s*/i, '') : '' };
  };
  const h5 = find(/current session|5[\s-]?hour|5시간|현재 세션/i);
  const wk = find(/이번 주|weekly limits?|this week/i) || find(/weekly|per week|week\b|주간/i);
  return h5 || wk ? { h5: h5 || { pct: 0, reset: '' }, wk: wk || { pct: 0, reset: '' } } : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const AGY = process.env.LOCALAPPDATA + '\\agy\\bin\\agy.exe';
const fmtReset = (iso) => { const ms = Date.parse(iso) - Date.now(); if (!(ms > 0)) return ''; const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60); return (d ? d + '일 ' : '') + (h ? h + '시간 ' : '') + (d ? '' : (m % 60) + '분 ') + '후 초기화'; };
async function readAgy(acc) {
  const out = await new Promise(res => execFile(fs.existsSync(AGY) ? AGY : 'agy', ['-p', '/usage', '--print-timeout', '25s'], { timeout: 45000, windowsHide: true }, (e, o) => res(o || '')));
  const g = (acc.group || 'Gemini Models').toLowerCase();
  const rows = out.split(/\r?\n/).map(l => l.split('\t')).filter(c => c.length >= 3 && c[0].trim().toLowerCase() === g);
  const pick = (re) => { const c = rows.find(r => re.test(r[1])); return c ? { pct: Math.max(0, Math.min(100, Math.round(100 - parseFloat(c[2])))), reset: fmtReset(c[3]) } : null; };
  const h5 = pick(/five hour/i), wk = pick(/weekly/i);
  if (h5 || wk) Object.assign(acc, { h5: h5 || { pct: 0, reset: '' }, wk: wk || { pct: 0, reset: '' }, status: 'ok', msg: '', updated: Date.now() });
  else { acc.status = 'error'; acc.msg = out.trim() ? '사용량 형식을 읽지 못했어요' : 'agy CLI 를 실행하지 못했어요 (설치·로그인 확인)'; }
}
async function readAccount(acc) {
  if (acc.mode === 'cli') return readAgy(acc);
  if (acc.mode === 'manual') { acc.status = 'manual'; acc.updated = Date.now(); return; }
  if (!acc.url) { acc.status = 'error'; acc.msg = 'URL 이 비어 있어요'; return; }
  const exe = browserExe();
  if (!exe) { acc.status = 'error'; acc.msg = 'Chrome 또는 Edge 가 필요해요'; return; }
  // 실제 Chrome 창을 화면 밖에 잠깐 띄워 읽고 닫는다 (헤드리스는 봇 검사에 막힘)
  const port = 9300 + Math.floor(Math.random() * 600);
  const p = spawn(exe, ['--user-data-dir=' + profileDir(acc.id), '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--start-minimized', '--window-position=-32000,-32000', '--window-size=900,700', acc.url], { stdio: 'ignore' });
  let usage = null, text = '', seen = false;
  for (let i = 0; i < 22 && !usage; i++) {
    await sleep(1500);
    const tabs = await httpJson(port, '/json');
    const list = (tabs || []).filter(x => x.type === 'page' && x.webSocketDebuggerUrl);
    if (!list.length) continue; seen = true;
    const host = (() => { try { return new URL(acc.url).hostname; } catch { return ''; } })();
    list.sort((x, y) => (y.url.includes(host) ? 1 : 0) - (x.url.includes(host) ? 1 : 0));
    for (const tab of list) {
      const r = await cdp(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      const tx = (r && r.result && r.result.value) || ''; if (tab === list[0] && tx) text = tx;
      usage = parseUsage(tx); if (usage) break;
    }
  }
  const v = await httpJson(port, '/json/version');
  if (v && v.webSocketDebuggerUrl) await cdp(v.webSocketDebuggerUrl, 'Browser.close', {}); else p.kill();
  if (usage) Object.assign(acc, usage, { status: 'ok', msg: '', updated: Date.now() });
  else if (!seen) { acc.status = 'error'; acc.msg = 'Chrome 을 열지 못했어요 (로그인 창이 열려 있으면 닫아 주세요)'; }
  else if (/보안 확인|security check|verify you are human|Just a moment/i.test(text)) { acc.status = 'login'; acc.msg = '보안 확인이 필요해요 → [로그인]에서 한 번 통과해 주세요'; }
  else if (/log ?in|sign ?in|continue with|로그인|accounts\.google/i.test(text)) { acc.status = 'login'; acc.msg = '로그인이 필요해요'; }
  else { acc.status = 'error'; acc.msg = '사용량을 찾지 못했어요 (주소 확인 또는 수동 입력)'; }
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
  const exe = browserExe(); if (!exe) return;
  const port = 9300 + Math.floor(Math.random() * 600);
  const p = spawn(exe, ['--user-data-dir=' + profileDir(id), '--remote-debugging-port=' + port, '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--new-window', acc.url], { detached: true, stdio: 'ignore' });
  let done = false;
  p.on('exit', () => { clearInterval(poll); if (!done) refresh(acc.id); });
  // 로그인해서 사용량이 보이면 자동으로 읽고 Chrome 창을 닫는다
  const poll = setInterval(async () => {
    if (done) return;
    const tabs = await httpJson(port, '/json');
    for (const t of (tabs || []).filter(x => x.type === 'page' && x.webSocketDebuggerUrl)) {
      const r = await cdp(t.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
      const usage = parseUsage((r && r.result && r.result.value) || '');
      if (usage) {
        done = true; clearInterval(poll);
        Object.assign(acc, usage, { status: 'ok', msg: '', updated: Date.now() }); publish();
        const v = await httpJson(port, '/json/version');
        if (v && v.webSocketDebuggerUrl) await cdp(v.webSocketDebuggerUrl, 'Browser.close', {}); else p.kill();
        return;
      }
    }
  }, 3000);
}
// ---- 최소 CDP(WebSocket) 클라이언트: 로그인 창 내용을 읽기 위함 ----
const http = require('http'), net = require('net'), crypto = require('crypto');
const httpJson = (port, p) => new Promise(res => { http.get({ host: '127.0.0.1', port, path: p }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } }); }).on('error', () => res(null)); });
function cdp(wsUrl, method, params) {
  return new Promise(res => {
    const u = new URL(wsUrl); const sock = net.connect(+u.port, u.hostname); let buf = Buffer.alloc(0), up = false, text = '';
    const end = (v) => { clearTimeout(t); sock.destroy(); res(v); };
    const t = setTimeout(() => end(null), 8000);
    sock.on('error', () => end(null)); sock.on('close', () => end(null));
    sock.on('connect', () => sock.write(`GET ${u.pathname} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (!up) {
        const i = buf.indexOf('\r\n\r\n'); if (i < 0) return; buf = buf.slice(i + 4); up = true;
        const pl = Buffer.from(JSON.stringify({ id: 1, method, params })), mask = crypto.randomBytes(4);
        const h = pl.length < 126 ? Buffer.from([0x81, 0x80 | pl.length]) : pl.length < 65536 ? Buffer.from([0x81, 0xfe, pl.length >> 8, pl.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 0xff; b.writeBigUInt64BE(BigInt(pl.length), 2); return b; })();
        sock.write(Buffer.concat([h, mask, Buffer.from(pl.map((b, k) => b ^ mask[k % 4]))]));
      }
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const op = buf[0] & 15, fin = buf[0] & 128; text += op === 8 ? '' : buf.slice(off, off + len).toString('utf8'); buf = buf.slice(off + len);
        if (fin && (op === 1 || op === 0)) { try { const m = JSON.parse(text); if (m.id === 1) return end(m.result || {}); } catch {} text = ''; }
      }
    });
  });
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
  if (process.env.AIUD_DEBUG && Date.now() % 1000 < 100) { try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), JSON.stringify({ p, b, sf: d.scaleFactor, inTop, inClock, visible, pinned, mode, wb }) + '\n'); } catch {} }
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

function logErr(e) { try { fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), new Date().toISOString() + ' ' + (e && e.stack || e) + '\n'); } catch {} }
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
  setInterval(() => { try { tick(); } catch (e) { logErr(e); } }, 100); schedule();
  // 오래 켜 두거나 절전·모니터 변경 뒤에도 독이 멈추지 않도록 주기적으로 상태를 바로잡는다
  const heal = () => { try { if (!widget || widget.isDestroyed()) { createWidget(); return; } widget.setAlwaysOnTop(true, 'screen-saver'); if (!widget.isVisible()) widget.showInactive(); place(visible); } catch (e) { logErr(e); } };
  setInterval(heal, 5000);
  screen.on('display-metrics-changed', heal); screen.on('display-added', heal); screen.on('display-removed', heal);
  powerMonitor.on('resume', () => setTimeout(heal, 1500)); powerMonitor.on('unlock-screen', () => setTimeout(heal, 1500));
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
  if (service === 'antigravity') {
    for (const [g, nm] of [['Gemini Models', 'Gemini 모델'], ['Claude and GPT models', 'Claude·GPT 모델']]) store.accounts.push({ id: uid(), service, group: g, label: [label, nm].filter(Boolean).join(' · '), url: '', mode: 'cli', h5: { pct: 0, reset: '' }, wk: { pct: 0, reset: '' }, status: 'idle', updated: 0 });
    publish(); refresh(); return;
  }
  store.accounts.push({ id: uid(), service, label: label || '', url: s.url, mode: s.mode, h5: { pct: 0, reset: '' }, wk: { pct: 0, reset: '' }, status: 'idle', updated: 0 });
  publish(); if (s.mode === 'auto') refresh(store.accounts[store.accounts.length - 1].id);
});
ipcMain.on('update', (_, { id, patch }) => { const a = store.accounts.find(x => x.id === id); if (a) { Object.assign(a, patch); if (a.mode === 'manual') { a.status = 'manual'; a.updated = Date.now(); } publish(); if (a.mode === 'cli' && (patch.mode || patch.group)) refresh(a.id); } });
ipcMain.on('remove', (_, id) => { store.accounts = store.accounts.filter(a => a.id !== id); publish(); });
ipcMain.on('move', (_, { id, dir }) => { const i = store.accounts.findIndex(a => a.id === id), j = i + dir; if (i < 0 || j < 0 || j >= store.accounts.length) return; [store.accounts[i], store.accounts[j]] = [store.accounts[j], store.accounts[i]]; publish(); });
ipcMain.on('settings', (_, patch) => {
  Object.assign(store.settings, patch);
  app.setLoginItemSettings({ openAtLogin: !!store.settings.autoStart });
  schedule(); publish();
});
