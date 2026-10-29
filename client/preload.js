'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  inputAvailable: () => ipcRenderer.invoke('input:available'),
  input: (ev) => ipcRenderer.invoke('input:send', ev),
  inputReset: () => ipcRenderer.invoke('input:reset'),
  directInfo: () => ipcRenderer.invoke('direct:info'),
  directRefresh: () => ipcRenderer.invoke('direct:refresh'),
  onDirectPeers: (cb) => ipcRenderer.on('direct:peers', (_e, l) => cb(l)),
  onDirectStatus: (cb) => ipcRenderer.on('direct:status', (_e, s) => cb(s)),
  onPanic: (cb) => ipcRenderer.on('panic', () => cb()),
  platform: process.platform,
});
