const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avantisApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveConsole: (payload) => ipcRenderer.invoke('console:save', payload),
  disconnectConsole: () => ipcRenderer.invoke('console:disconnect'),
  saveTallyConnection: (payload) => ipcRenderer.invoke('tally-connection:save', payload),
  saveProxy: (payload) => ipcRenderer.invoke('tally-connection:save', payload),
  addTally: (payload) => ipcRenderer.invoke('tally:add', payload),
  updateTally: (payload) => ipcRenderer.invoke('tally:update', payload),
  removeTally: (payload) => ipcRenderer.invoke('tally:remove', payload),
  syncTally: (payload) => ipcRenderer.invoke('tally:sync', payload),
  showError: (payload) => ipcRenderer.invoke('dialog:error', payload),
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('app-state', wrapped);
    return () => ipcRenderer.removeListener('app-state', wrapped);
  },
  onMenuAction: (listener) => {
    const wrapped = (_event, action) => listener(action);
    ipcRenderer.on('menu-action', wrapped);
    return () => ipcRenderer.removeListener('menu-action', wrapped);
  }
});
