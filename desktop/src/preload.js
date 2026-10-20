'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const listeners = new Set();
ipcRenderer.on('buddy:event', (_e, kind, payload) => { for (const fn of listeners) { try { fn(kind, payload); } catch (err) { console.error(err); } } });
contextBridge.exposeInMainWorld('buddyBridge', {
  call: (method, args) => ipcRenderer.invoke('api', method, args || []),
  onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  pathFor: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  query: Object.fromEntries(new URLSearchParams(location.search)),
});
