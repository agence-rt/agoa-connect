'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  inputAvailable: () => ipcRenderer.invoke('input:available'),
  input: (ev) => ipcRenderer.invoke('input:send', ev),
  inputReset: () => ipcRenderer.invoke('input:reset'),
  onPanic: (cb) => ipcRenderer.on('panic', () => cb()),
  platform: process.platform,
});
