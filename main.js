import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { ConfigStore } from './lib/config-store.js';
import { AvantisChannels, AvantisClient } from './lib/avantis-client.js';
import { TallyManager } from './lib/tally-manager.js';
import {
  normalizeTallyMac,
  provisionTallyOverSerial,
  scanTallyBeacons
} from './lib/tally-serial-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configStore = new ConfigStore();
const avantisClient = new AvantisClient();
let tallyManager = null;

const SUPPORTED_TALLY_MODEL = 'tally';
const SUPPORTED_FIRMWARE_PREFIX = '1.';
const STATUS_RESYNC_INTERVAL_MS = 4000;

let mainWindow = null;
let rendererReady = false;
let statusResyncTimer = null;
const pendingMenuActions = [];
let resyncInProgress = false;
let resyncQueued = false;

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

function normalizeHexColor(value, fallback) {
  const text = String(value ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toLowerCase();
  }

  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return `#${text.toLowerCase()}`;
  }

  return fallback;
}

function sanitizeTallyColors(input) {
  return {
    active: normalizeHexColor(input?.active, '#ff0000'),
    belowThreshold: normalizeHexColor(input?.belowThreshold, '#00ff00'),
    muted: normalizeHexColor(input?.muted, '#00008b')
  };
}

function sanitizeTally(input) {
  const parsedChannel = parseChannelKey(input?.channelKey ?? 'input:1');
  const legacyThreshold = Number(input?.onThreshold);
  const rawPercent = Number.isFinite(Number(input?.activeThresholdPercent))
    ? Number(input?.activeThresholdPercent)
    : Number.isFinite(legacyThreshold)
      ? (legacyThreshold <= 1 ? legacyThreshold * 100 : legacyThreshold)
      : 5;

  return {
    id: String(input?.id ?? randomUUID()),
    name: String(input?.name ?? normalizeTallyMac(input?.deviceId) ?? 'Tally Light'),
    deviceId: normalizeTallyMac(input?.deviceId),
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
    tallyColors: sanitizeTallyColors(persisted.tallyColors),
    websocketPort: Number(persisted.websocketPort ?? 19188),
    tallyLights: (persisted.tallyLights ?? []).map((item) => sanitizeTally(item)).filter((item) => item.deviceId)
  };
}

function savePersistedState(nextState) {
  configStore.set({
    console: nextState.console,
    tallyConnection: nextState.tallyConnection,
    tallyColors: sanitizeTallyColors(nextState.tallyColors),
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
    tallyColors: persisted.tallyColors,
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
      await tallyManager.updateTallyOutput(tally, faderState, snapshot.tallyColors);
    } catch (error) {
      runtimeState.websocketError = error.message;
    }
  }

  broadcastState();
}

function getLocalLanAddress() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== 'IPv4' || entry.internal) {
        continue;
      }

      const address = String(entry.address || '').trim();
      if (!address) {
        continue;
      }

      const isPrivate =
        address.startsWith('10.') ||
        address.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);

      candidates.push({ address, isPrivate });
    }
  }

  const preferred = candidates.find((item) => item.isPrivate);
  return (preferred || candidates[0] || {}).address || '';
}

async function resyncAllTallyStatuses() {
  resyncQueued = true;
  if (resyncInProgress) {
    return;
  }

  resyncInProgress = true;

  try {
    while (resyncQueued) {
      resyncQueued = false;
      await syncAllTallyOutputs();
    }
  } catch (error) {
    runtimeState.websocketError = error?.message ? String(error.message) : 'Failed to resync tally status.';
    broadcastState();
  } finally {
    resyncInProgress = false;
  }
}

function buildProvisionPayload(persisted) {
  const host = String(persisted.tallyConnection.proxyAddress || getLocalLanAddress() || '').trim();
  if (!host) {
    throw new Error('Set Proxy Address or ensure this computer has a LAN IP before syncing tally lights.');
  }

  const ssid = String(persisted.tallyConnection.wifiSsid || '').trim();
  if (!ssid) {
    throw new Error('WiFi SSID is required before syncing tally lights.');
  }

  return {
    op: 'provision',
    ssid,
    psk: String(persisted.tallyConnection.wifiPassword || ''),
    host,
    port: Number(persisted.websocketPort || 19188),
    tls: false,
    token: ''
  };
}

function isProvisionedDevice(mac) {
  const normalized = normalizeTallyMac(mac);
  if (!normalized) {
    return false;
  }

  const persisted = getPersistedState();
  return persisted.tallyLights.some((item) => item.deviceId === normalized);
}

function createDefaultTallyForDevice(mac) {
  return {
    id: randomUUID(),
    name: mac,
    deviceId: mac,
    channelKey: 'input:1',
    activeThresholdPercent: 5
  };
}

function attachAvantisHandlers() {
  avantisClient.on('connection', async ({ connected }) => {
    runtimeState.connected = connected;
    if (!connected) {
      runtimeState.faders = {};
    }
    await resyncAllTallyStatuses();
  });

  avantisClient.on('error', async (error) => {
    runtimeState.connectError = error.message;
    runtimeState.connected = false;
    runtimeState.faders = {};
    await resyncAllTallyStatuses();
  });

  avantisClient.on('channel-state', async ({ channel, state }) => {
    runtimeState.faders[channel.key] = {
      level: state.level,
      muted: state.muted,
      updatedAt: state.updatedAt
    };

    await resyncAllTallyStatuses();
  });
}

function attachTallyHandlers() {
  if (!tallyManager) {
    return;
  }

  tallyManager.on('devices-changed', async (devices) => {
    runtimeState.devices = devices;
    await resyncAllTallyStatuses();
  });

  tallyManager.on('server-error', (error) => {
    runtimeState.websocketError = error.message;
    broadcastState();
  });

  tallyManager.on('device-error', ({ error }) => {
    runtimeState.websocketError = error.message;
    broadcastState();
  });

  tallyManager.on('server-status', async ({ listening, port }) => {
    runtimeState.websocketError = listening ? '' : `WebSocket server is not listening on ${port}`;
    if (listening) {
      await resyncAllTallyStatuses();
      return;
    }
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
          label: 'Sync Tally Lights',
          click: () => dispatchMenuAction('open-sync-modal')
        },
        {
          label: 'Tally Connection Settings',
          click: () => dispatchMenuAction('open-tally-connection-modal')
        },
        {
          label: 'Tally Color Settings',
          click: () => dispatchMenuAction('open-tally-color-modal')
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
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false
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

function ensureValidTallyInput(payload) {
  const tally = sanitizeTally(payload);
  if (!tally.deviceId) {
    throw new Error('A synced tally device MAC is required.');
  }
  return tally;
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
    runtimeState.faders = {};
    await resyncAllTallyStatuses();
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

  ipcMain.handle('tally-colors:save', async (_event, payload) => {
    const persisted = getPersistedState();
    const nextState = {
      ...persisted,
      tallyColors: sanitizeTallyColors(payload)
    };

    savePersistedState(nextState);
    await syncAllTallyOutputs();
    return currentSnapshot();
  });

  ipcMain.handle('proxy:save', async (_event, payload) => {
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
    const tally = ensureValidTallyInput(payload);

    const duplicate = persisted.tallyLights.find((item) => item.deviceId === tally.deviceId && item.id !== tally.id);
    if (duplicate) {
      throw new Error('A tally light for this MAC address already exists.');
    }

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
    const tally = ensureValidTallyInput(payload);

    const duplicate = persisted.tallyLights.find((item) => item.deviceId === tally.deviceId && item.id !== tally.id);
    if (duplicate) {
      throw new Error('A tally light for this MAC address already exists.');
    }

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

  ipcMain.handle('tally:scan-beacons', async () => {
    const results = await scanTallyBeacons({
      timeoutMs: 2000,
      baudRate: 115200,
      supportedModel: SUPPORTED_TALLY_MODEL,
      supportedFirmwarePrefix: SUPPORTED_FIRMWARE_PREFIX,
      concurrency: 4
    });

    return {
      results: results.filter((item) => item.beacon)
    };
  });

  ipcMain.handle('tally:provision-device', async (_event, payload) => {
    const persisted = getPersistedState();
    const mac = normalizeTallyMac(payload?.mac);
    const portPath = String(payload?.port ?? '').trim();

    if (!mac) {
      throw new Error('A valid MAC address is required.');
    }

    if (!portPath) {
      throw new Error('Serial port is required.');
    }

    const provisionPayload = buildProvisionPayload(persisted);
    const provisionResult = await provisionTallyOverSerial({
      portPath,
      expectedMac: mac,
      provisionPayload,
      timeoutMs: 2500,
      baudRate: 115200,
      supportedModel: SUPPORTED_TALLY_MODEL,
      supportedFirmwarePrefix: SUPPORTED_FIRMWARE_PREFIX
    });

    if (!provisionResult.acknowledged) {
      throw new Error(provisionResult.reason || 'Provisioning failed.');
    }

    let added = false;
    if (!isProvisionedDevice(mac)) {
      const nextState = getPersistedState();
      nextState.tallyLights = [...nextState.tallyLights, createDefaultTallyForDevice(mac)];
      savePersistedState(nextState);
      added = true;
    }

    await syncAllTallyOutputs();

    return {
      added,
      mac,
      provision: provisionResult,
      snapshot: currentSnapshot()
    };
  });

  ipcMain.handle('dialog:error', async (_event, payload) => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Error',
      message: String(payload?.message ?? 'Unknown error')
    });
  });

  ipcMain.handle('dialog:info', async (_event, payload) => {
    await dialog.showMessageBox({
      type: 'info',
      title: String(payload?.title ?? 'Info'),
      message: String(payload?.message ?? '')
    });
  });
}

app.whenReady().then(() => {
  const persisted = getPersistedState();

  avantisClient.setBaseMidiChannel(persisted.console.baseMidiChannel);
  if (persisted.console.address) {
    runtimeState.connectError = '';
    avantisClient.connect(persisted.console.address, persisted.console.port);
  }

  tallyManager = new TallyManager(persisted.websocketPort, {
    isDeviceAllowed: (mac) => isProvisionedDevice(mac)
  });
  attachTallyHandlers();
  tallyManager.start();

  attachAvantisHandlers();
  registerIpc();
  createMenu();
  createWindow();
  broadcastState();

  statusResyncTimer = setInterval(() => {
    resyncAllTallyStatuses();
  }, STATUS_RESYNC_INTERVAL_MS);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      broadcastState();
    }
  });
});

app.on('before-quit', async () => {
  if (statusResyncTimer) {
    clearInterval(statusResyncTimer);
    statusResyncTimer = null;
  }
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
