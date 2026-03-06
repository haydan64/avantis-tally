import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ConfigStore } from './lib/config-store.js';
import { AvantisChannels, AvantisClient } from './lib/avantis-client.js';
import { TallyManager } from './lib/tally-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configStore = new ConfigStore();
const avantisClient = new AvantisClient();
let tallyManager = null;

let mainWindow = null;
let rendererReady = false;
const pendingMenuActions = [];

let runtimeState = {
  connected: false,
  connectError: '',
  faders: {},
  devices: [],
  websocketError: ''
};

const CHANNEL_TYPE_LABELS = {
  input: 'Inputs',
  'mono-group': 'Mono Groups',
  'stereo-group': 'Stereo Groups',
  'mono-aux': 'Mono Aux',
  'stereo-aux': 'Stereo Aux',
  'mono-matrix': 'Mono Matrix',
  'stereo-matrix': 'Stereo Matrix',
  'mono-fx-send': 'Mono FX Send',
  'stereo-fx-send': 'Stereo FX Send',
  'fx-return': 'FX Return',
  main: 'Main',
  dca: 'DCA',
  'mute-group': 'Mute Groups'
};

function parseChannelKey(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  const match = /^([a-z-]+):(\d+)$/.exec(trimmed);
  if (!match) {
    return null;
  }

  return {
    key: `${match[1]}:${Number(match[2])}`
  };
}

function sanitizeTally(input) {
  const parsedChannel = parseChannelKey(input?.channelKey ?? 'input:1');
  const legacyThreshold = Number(input?.onThreshold);
  const rawPercent = Number.isFinite(Number(input?.activeThresholdPercent))
    ? Number(input?.activeThresholdPercent)
    : Number.isFinite(legacyThreshold)
      ? (legacyThreshold <= 1 ? legacyThreshold * 100 : legacyThreshold)
      : 0;

  return {
    id: String(input?.id ?? randomUUID()),
    name: String(input?.name ?? 'Tally Light'),
    deviceId: String(input?.deviceId ?? ''),
    channelKey: parsedChannel?.key ?? 'input:1',
    activeThresholdPercent: Math.max(0, Math.min(100, rawPercent))
  };
}

function buildChannelCatalogForUi() {
  const groups = new Map();

  for (const channel of AvantisChannels.all) {
    if (!groups.has(channel.type)) {
      groups.set(channel.type, []);
    }

    groups.get(channel.type).push({
      key: channel.key,
      index: channel.index,
      name: channel.label
    });
  }

  return Array.from(groups.entries()).map(([type, channels]) => ({
    type,
    label: CHANNEL_TYPE_LABELS[type] ?? type,
    channels
  }));
}

function getPersistedState() {
  const persisted = configStore.get();

  return {
    console: {
      address: String(persisted.console?.address ?? ''),
      port: Number(persisted.console?.port ?? 51325),
      baseMidiChannel: Math.min(12, Math.max(1, Number(persisted.console?.baseMidiChannel ?? 12)))
    },
    tallyConnection: {
      proxyAddress: String(persisted.tallyConnection?.proxyAddress ?? ''),
      wifiSsid: String(persisted.tallyConnection?.wifiSsid ?? ''),
      wifiPassword: String(persisted.tallyConnection?.wifiPassword ?? '')
    },
    websocketPort: Number(persisted.websocketPort ?? 19188),
    tallyLights: (persisted.tallyLights ?? []).map((item) => sanitizeTally(item))
  };
}

function savePersistedState(nextState) {
  configStore.set({
    console: nextState.console,
    tallyConnection: nextState.tallyConnection,
    websocketPort: nextState.websocketPort,
    tallyLights: nextState.tallyLights
  });
}

function currentSnapshot() {
  const persisted = getPersistedState();

  return {
    console: {
      ...persisted.console,
      connected: runtimeState.connected,
      connectError: runtimeState.connectError
    },
    tallyConnection: persisted.tallyConnection,
    websocketPort: persisted.websocketPort,
    websocketError: runtimeState.websocketError,
    devices: runtimeState.devices,
    tallyLights: persisted.tallyLights,
    faders: runtimeState.faders,
    channelCatalog: buildChannelCatalogForUi()
  };
}

function broadcastState() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('app-state', currentSnapshot());
}

function dispatchMenuAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!rendererReady) {
    pendingMenuActions.push(action);
    return;
  }

  mainWindow.webContents.send('menu-action', action);
}

function flushPendingMenuActions() {
  if (!mainWindow || mainWindow.isDestroyed() || !rendererReady) {
    return;
  }

  while (pendingMenuActions.length > 0) {
    const action = pendingMenuActions.shift();
    mainWindow.webContents.send('menu-action', action);
  }
}

async function syncAllTallyOutputs() {
  if (!tallyManager) {
    return;
  }

  const snapshot = currentSnapshot();

  for (const tally of snapshot.tallyLights) {
    const faderState = snapshot.faders[tally.channelKey] ?? { level: 0, muted: true };

    try {
      await tallyManager.updateTallyOutput(tally, faderState);
    } catch (error) {
      runtimeState.websocketError = error.message;
    }
  }

  broadcastState();
}

function attachAvantisHandlers() {
  avantisClient.on('connection', ({ connected }) => {
    runtimeState.connected = connected;
    if (!connected) {
      runtimeState.faders = {};
    }
    broadcastState();
  });

  avantisClient.on('error', (error) => {
    runtimeState.connectError = error.message;
    runtimeState.connected = false;
    broadcastState();
  });

  avantisClient.on('channel-state', async ({ channel, state }) => {
    runtimeState.faders[channel.key] = {
      level: state.level,
      muted: state.muted,
      updatedAt: state.updatedAt
    };

    await syncAllTallyOutputs();
  });
}

function attachTallyHandlers() {
  if (!tallyManager) {
    return;
  }

  tallyManager.on('devices-changed', (devices) => {
    runtimeState.devices = devices;
    broadcastState();
  });

  tallyManager.on('server-error', (error) => {
    runtimeState.websocketError = error.message;
    broadcastState();
  });

  tallyManager.on('device-error', ({ error }) => {
    runtimeState.websocketError = error.message;
    broadcastState();
  });

  tallyManager.on('server-status', ({ listening, port }) => {
    runtimeState.websocketError = listening ? '' : `WebSocket server is not listening on ${port}`;
    broadcastState();
  });
}

function createMenu() {
  const template = process.platform === 'darwin' ? [{ role: 'appMenu' }] : [];

  template.push(
    {
      label: 'File',
      submenu: [
        {
          label: 'Console Connection',
          click: () => dispatchMenuAction('open-console-modal')
        },
        {
          label: 'Add Tally Light',
          click: () => dispatchMenuAction('open-add-tally')
        },
        {
          label: 'Tally Connection Settings',
          click: () => dispatchMenuAction('open-tally-connection-modal')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    flushPendingMenuActions();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    rendererReady = false;
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('state:get', async () => currentSnapshot());

  ipcMain.handle('console:save', async (_event, payload) => {
    const persisted = getPersistedState();

    const nextState = {
      ...persisted,
      console: {
        address: String(payload?.address ?? '').trim(),
        port: Number(payload?.port ?? 51325),
        baseMidiChannel: Math.min(12, Math.max(1, Number(payload?.baseMidiChannel ?? 12)))
      }
    };

    if (!nextState.console.address) {
      throw new Error('Console address is required.');
    }

    savePersistedState(nextState);

    runtimeState.connectError = '';
    avantisClient.setBaseMidiChannel(nextState.console.baseMidiChannel);
    avantisClient.connect(nextState.console.address, nextState.console.port);
    broadcastState();

    return currentSnapshot();
  });

  ipcMain.handle('console:disconnect', async () => {
    avantisClient.disconnect();
    runtimeState.connected = false;
    broadcastState();
    return currentSnapshot();
  });

  ipcMain.handle('tally-connection:save', async (_event, payload) => {
    const persisted = getPersistedState();
    const nextState = {
      ...persisted,
      tallyConnection: {
        proxyAddress: String(payload?.proxyAddress ?? persisted.tallyConnection.proxyAddress ?? '').trim(),
        wifiSsid: String(payload?.wifiSsid ?? persisted.tallyConnection.wifiSsid ?? '').trim(),
        wifiPassword: String(payload?.wifiPassword ?? persisted.tallyConnection.wifiPassword ?? '')
      }
    };

    savePersistedState(nextState);
    broadcastState();
    return currentSnapshot();
  });

  ipcMain.handle('proxy:save', async (_event, payload) => {
    // Backward compatibility for older renderer builds.
    const persisted = getPersistedState();
    const nextState = {
      ...persisted,
      tallyConnection: {
        ...persisted.tallyConnection,
        proxyAddress: String(payload?.proxyAddress ?? '').trim()
      }
    };

    savePersistedState(nextState);
    broadcastState();
    return currentSnapshot();
  });

  ipcMain.handle('tally:add', async (_event, payload) => {
    const persisted = getPersistedState();
    const tally = sanitizeTally(payload);

    const nextState = {
      ...persisted,
      tallyLights: [...persisted.tallyLights, tally]
    };

    savePersistedState(nextState);
    await syncAllTallyOutputs();
    return currentSnapshot();
  });

  ipcMain.handle('tally:update', async (_event, payload) => {
    const persisted = getPersistedState();
    const tally = sanitizeTally(payload);

    const nextState = {
      ...persisted,
      tallyLights: persisted.tallyLights.map((item) => (item.id === tally.id ? tally : item))
    };

    savePersistedState(nextState);
    await syncAllTallyOutputs();
    return currentSnapshot();
  });

  ipcMain.handle('tally:remove', async (_event, payload) => {
    const persisted = getPersistedState();
    const id = String(payload?.id ?? '');

    const nextState = {
      ...persisted,
      tallyLights: persisted.tallyLights.filter((item) => item.id !== id)
    };

    savePersistedState(nextState);
    await syncAllTallyOutputs();
    return currentSnapshot();
  });

  ipcMain.handle('tally:sync', async (_event, payload) => {
    if (!tallyManager) {
      throw new Error('WebSocket server is not started.');
    }

    const persisted = getPersistedState();
    const id = String(payload?.id ?? '');
    const tally = persisted.tallyLights.find((item) => item.id === id);

    if (!tally) {
      throw new Error('Tally not found.');
    }

    await tallyManager.syncProxy(tally, {
      proxyAddress: persisted.tallyConnection.proxyAddress,
      fallbackAddress: persisted.console.address,
      wifiSsid: persisted.tallyConnection.wifiSsid,
      wifiPassword: persisted.tallyConnection.wifiPassword
    });

    await syncAllTallyOutputs();
    return currentSnapshot();
  });

  ipcMain.handle('dialog:error', async (_event, payload) => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Error',
      message: String(payload?.message ?? 'Unknown error')
    });
  });
}

app.whenReady().then(() => {
  const persisted = getPersistedState();

  avantisClient.setBaseMidiChannel(persisted.console.baseMidiChannel);

  tallyManager = new TallyManager(persisted.websocketPort);
  attachTallyHandlers();
  tallyManager.start();

  attachAvantisHandlers();
  registerIpc();
  createMenu();
  createWindow();
  broadcastState();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      broadcastState();
    }
  });
});

app.on('before-quit', async () => {
  avantisClient.disconnect();
  if (tallyManager) {
    await tallyManager.stop();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
