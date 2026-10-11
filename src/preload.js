const { contextBridge, ipcRenderer } = require('electron');
const send = (c, d) => ipcRenderer.send(c, d);
contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state'),
  onState: (cb) => ipcRenderer.on('state', (_, s) => cb(s)),
  onVisibility: (cb) => ipcRenderer.on('visibility', (_, v) => cb(v)),
  refresh: (id) => send('refresh', id),
  login: (id) => send('login', id),
  openSettings: () => send('openSettings'),
  size: (h) => send('size', h),
  hold: (v) => send('hold', v),
  add: (d) => send('add', d),
  update: (id, patch) => send('update', { id, patch }),
  remove: (id) => send('remove', id),
  move: (id, dir) => send('move', { id, dir }),
  setSettings: (p) => send('settings', p),
});
