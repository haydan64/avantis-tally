const state = {
  snapshot: null,
  editorMode: 'add',
  editingId: null,
  scanResults: []
};

const statusEl = document.getElementById('console-status');
const consoleSummaryEl = document.getElementById('console-summary');
const baseChannelEl = document.getElementById('base-channel');
const wsSummaryEl = document.getElementById('ws-summary');
const deviceCountEl = document.getElementById('device-count');
const errorTextEl = document.getElementById('error-text');
const disconnectButtonEl = document.getElementById('disconnect-button');

const tallyListEl = document.getElementById('tally-list');
const addTallyEl = document.getElementById('add-tally');
const syncTalliesEl = document.getElementById('sync-tallies');

const syncModalEl = document.getElementById('sync-modal');
const syncFormEl = document.getElementById('sync-form');
const syncDeviceListEl = document.getElementById('sync-device-list');
const syncRescanEl = document.getElementById('sync-rescan');
const syncCloseEl = document.getElementById('sync-close');

const consoleModalEl = document.getElementById('console-modal');
const consoleFormEl = document.getElementById('console-form');
const consoleCancelEl = document.getElementById('console-cancel');

const tallyConnectionModalEl = document.getElementById('tally-connection-modal');
const tallyConnectionFormEl = document.getElementById('tally-connection-form');
const tallyConnectionCancelEl = document.getElementById('tally-connection-cancel');

const tallyColorsModalEl = document.getElementById('tally-colors-modal');
const tallyColorsFormEl = document.getElementById('tally-colors-form');
const tallyColorsCancelEl = document.getElementById('tally-colors-cancel');

const editorEl = document.getElementById('tally-editor');
const editorTitleEl = document.getElementById('editor-title');
const editorMacEl = document.getElementById('editor-mac');
const editorFormEl = document.getElementById('editor-form');
const editorCancelEl = document.getElementById('editor-cancel');
const editorDeleteEl = document.getElementById('editor-delete');
const deviceFieldEl = document.getElementById('device-field');
const deviceSelectEl = document.getElementById('device-select');
const channelTypeEl = document.getElementById('channel-type');
const channelIndexEl = document.getElementById('channel-index');

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeColor(value, fallback) {
  const text = String(value || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toLowerCase();
  }

  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return `#${text.toLowerCase()}`;
  }

  return fallback;
}

function normalizeMac(value) {
  const raw = String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  if (raw.length !== 12) {
    return '';
  }

  const parts = [];
  for (let i = 0; i < 12; i += 2) {
    parts.push(raw.slice(i, i + 2));
  }

  return parts.join(':');
}

function parseChannelKey(value) {
  const text = String(value || '').toLowerCase();
  const match = /^([a-z-]+):(\d+)$/.exec(text);
  if (!match) {
    return { type: 'input', index: 1, key: 'input:1' };
  }

  return {
    type: match[1],
    index: Number(match[2]),
    key: `${match[1]}:${Number(match[2])}`
  };
}

function getThresholdPercent(tally) {
  const raw = Number(tally?.activeThresholdPercent);
  if (Number.isFinite(raw)) {
    return Math.max(0, Math.min(100, raw));
  }

  const legacy = Number(tally?.onThreshold);
  if (Number.isFinite(legacy)) {
    return Math.max(0, Math.min(100, legacy <= 1 ? legacy * 100 : legacy));
  }

  return 5;
}

function buildChannelTypeOptions(snapshot) {
  return Array.isArray(snapshot?.channelCatalog) ? snapshot.channelCatalog : [];
}

function getTallyColors(snapshot) {
  const colors = snapshot?.tallyColors || {};
  return {
    active: normalizeColor(colors.active, '#ff0000'),
    belowThreshold: normalizeColor(colors.belowThreshold, '#00ff00'),
    muted: normalizeColor(colors.muted, '#00008b')
  };
}

function getKnownMacs(snapshot = state.snapshot) {
  if (!snapshot) {
    return [];
  }

  return Array.from(
    new Set(
      (snapshot.tallyLights || [])
        .map((item) => normalizeMac(item.deviceId))
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function getTallyStatus(tally, snapshot) {
  const device = snapshot.devices.find((d) => d.id === tally.deviceId);
  if (!device) {
    return {
      key: 'disconnected',
      label: 'Disconnected',
      color: '#475569',
      device
    };
  }

  const colors = getTallyColors(snapshot);
  const fader = snapshot.faders[tally.channelKey] || { level: 0, muted: true };
  const thresholdPercent = getThresholdPercent(tally);

  if (fader.muted) {
    return {
      key: 'muted',
      label: 'Muted',
      color: colors.muted,
      fader,
      thresholdPercent,
      device
    };
  }

  if ((fader.level || 0) > thresholdPercent / 100) {
    return {
      key: 'active',
      label: 'Active',
      color: colors.active,
      fader,
      thresholdPercent,
      device
    };
  }

  return {
    key: 'below-threshold',
    label: 'Below Threshold',
    color: colors.belowThreshold,
    fader,
    thresholdPercent,
    device
  };
}

function populateChannelTypeSelect(snapshot, selectedType = 'input') {
  const types = buildChannelTypeOptions(snapshot);
  channelTypeEl.innerHTML = '';

  for (const item of types) {
    const option = document.createElement('option');
    option.value = item.type;
    option.textContent = item.label;
    channelTypeEl.appendChild(option);
  }

  if (types.some((x) => x.type === selectedType)) {
    channelTypeEl.value = selectedType;
  } else if (types.length > 0) {
    channelTypeEl.value = types[0].type;
  }
}

function populateChannelIndexSelect(snapshot, channelType, selectedKey = '') {
  const types = buildChannelTypeOptions(snapshot);
  const selectedType = types.find((item) => item.type === channelType) || types[0];
  channelIndexEl.innerHTML = '';

  if (!selectedType) {
    const option = document.createElement('option');
    option.value = 'input:1';
    option.textContent = 'Input 1';
    channelIndexEl.appendChild(option);
    return;
  }

  for (const channel of selectedType.channels) {
    const option = document.createElement('option');
    option.value = channel.key;
    option.textContent = channel.name;
    channelIndexEl.appendChild(option);
  }

  if (selectedKey && selectedType.channels.some((x) => x.key === selectedKey)) {
    channelIndexEl.value = selectedKey;
  } else if (selectedType.channels.length > 0) {
    channelIndexEl.value = selectedType.channels[0].key;
  }
}

function applyState(snapshot) {
  state.snapshot = snapshot;

  statusEl.textContent = snapshot.console.connected ? 'Connected' : 'Disconnected';
  statusEl.dataset.connected = String(snapshot.console.connected);

  const summary = snapshot.console.address
    ? `${snapshot.console.address}:${snapshot.console.port}`
    : 'Not configured';
  consoleSummaryEl.textContent = summary;

  baseChannelEl.textContent = String(snapshot.console.baseMidiChannel || 12);
  wsSummaryEl.textContent = `Port ${snapshot.websocketPort}`;
  deviceCountEl.textContent = String(snapshot.devices.length);

  disconnectButtonEl.disabled = !snapshot.console.connected;

  const errorLines = [];
  if (snapshot.console.connectError) {
    errorLines.push(`Console: ${snapshot.console.connectError}`);
  }
  if (snapshot.websocketError) {
    errorLines.push(`WebSocket: ${snapshot.websocketError}`);
  }
  errorTextEl.textContent = errorLines.join(' | ');

  renderUnifiedList(snapshot);
  refillDeviceSelect(snapshot);
  renderSyncResults();
}

function renderUnifiedList(snapshot) {
  tallyListEl.innerHTML = '';

  if (snapshot.tallyLights.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tally lights configured. Use Sync Tally Lights to add a hardware device first.';
    tallyListEl.appendChild(li);
    return;
  }

  for (const tally of snapshot.tallyLights) {
    const status = getTallyStatus(tally, snapshot);
    const fader = status.fader || { level: 0, muted: true };
    const thresholdPercent = Number.isFinite(status.thresholdPercent) ? status.thresholdPercent : getThresholdPercent(tally);

    const li = document.createElement('li');
    li.className = 'tally-item';
    li.innerHTML = `
      <div class="tally-main">
        <div class="name-row">
          <span class="name">${escapeHtml(tally.name)}</span>
          <span class="light status-${escapeHtml(status.key)}" style="--status-color: ${escapeHtml(status.color)}">${escapeHtml(status.label)}</span>
        </div>
        <div class="meta">
          <span>MAC: ${escapeHtml(tally.deviceId)}</span>
          <span>Channel: ${escapeHtml(tally.channelKey)}</span>
          <span>Threshold: ${Math.round(thresholdPercent)}%</span>
          <span>Level: ${Math.round((fader.level || 0) * 100)}%</span>
          <span>Muted: ${fader.muted ? 'Yes' : 'No'}</span>
        </div>
      </div>
      <div class="actions">
        <button data-action="edit" data-id="${tally.id}">Edit</button>
      </div>
    `;

    tallyListEl.appendChild(li);
  }
}

function refillDeviceSelect(snapshot) {
  const previous = editorFormEl.elements.deviceId.value;
  const knownMacs = getKnownMacs(snapshot);
  deviceSelectEl.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = knownMacs.length > 0 ? 'Select a provisioned MAC' : 'No provisioned tally devices';
  deviceSelectEl.appendChild(placeholder);

  for (const mac of knownMacs) {
    const option = document.createElement('option');
    option.value = mac;
    option.textContent = mac;
    deviceSelectEl.appendChild(option);
  }

  if (previous && knownMacs.includes(previous)) {
    editorFormEl.elements.deviceId.value = previous;
  }
}

function openConsoleModal(snapshot = state.snapshot) {
  if (!snapshot) {
    return;
  }

  consoleFormEl.elements.address.value = snapshot.console.address || '';
  consoleFormEl.elements.port.value = String(snapshot.console.port || 51325);
  consoleFormEl.elements.baseMidiChannel.value = String(snapshot.console.baseMidiChannel || 12);
  if (!consoleModalEl.open) {
    consoleModalEl.showModal();
  }
}

function openTallyConnectionModal(snapshot = state.snapshot) {
  if (!snapshot) {
    return;
  }

  tallyConnectionFormEl.elements.proxyAddress.value = snapshot.tallyConnection?.proxyAddress || '';
  tallyConnectionFormEl.elements.wifiSsid.value = snapshot.tallyConnection?.wifiSsid || '';
  tallyConnectionFormEl.elements.wifiPassword.value = snapshot.tallyConnection?.wifiPassword || '';

  if (!tallyConnectionModalEl.open) {
    tallyConnectionModalEl.showModal();
  }
}

function openTallyColorsModal(snapshot = state.snapshot) {
  if (!snapshot) {
    return;
  }

  const colors = getTallyColors(snapshot);
  tallyColorsFormEl.elements.active.value = colors.active;
  tallyColorsFormEl.elements.belowThreshold.value = colors.belowThreshold;
  tallyColorsFormEl.elements.muted.value = colors.muted;

  if (!tallyColorsModalEl.open) {
    tallyColorsModalEl.showModal();
  }
}

async function scanBeacons() {
  syncDeviceListEl.innerHTML = '<p class="sync-note">Scanning serial ports...</p>';
  const response = await window.avantisApi.scanTallyBeacons();
  state.scanResults = Array.isArray(response?.results) ? response.results : [];
  renderSyncResults();
}

function renderSyncResults() {
  if (!syncDeviceListEl) {
    return;
  }

  const results = state.scanResults || [];
  syncDeviceListEl.innerHTML = '';

  if (!results.length) {
    const empty = document.createElement('p');
    empty.className = 'sync-note';
    empty.textContent = 'No tally beacons detected.';
    syncDeviceListEl.appendChild(empty);
    return;
  }

  const known = new Set(getKnownMacs());

  for (const item of results) {
    const row = document.createElement('div');
    row.className = 'sync-row';

    const supported = Boolean(item.supported && item.mac);
    const alreadyAdded = supported && known.has(item.mac);
    const actionLabel = alreadyAdded ? 'Sync' : 'Add';
    const reason = supported ? (alreadyAdded ? 'Already added' : 'Ready') : (item.reason || 'Unsupported');

    row.innerHTML = `
      <div class="sync-main">
        <div><strong>${escapeHtml(item.mac || 'Unknown MAC')}</strong></div>
        <div class="meta">
          <span>Port: ${escapeHtml(item.port || 'Unknown')}</span>
          <span>Model: ${escapeHtml(item.model || '(empty)')}</span>
          <span>FW: ${escapeHtml(item.fw || '(empty)')}</span>
          <span>Status: ${escapeHtml(reason)}</span>
        </div>
      </div>
      <div class="actions">
        ${supported ? `<button data-action="provision" data-port="${escapeHtml(item.port)}" data-mac="${escapeHtml(item.mac)}">${actionLabel}</button>` : ''}
      </div>
    `;

    syncDeviceListEl.appendChild(row);
  }
}

async function openSyncModal() {
  if (!syncModalEl.open) {
    syncModalEl.showModal();
  }

  await scanBeacons();
}

function openTallyEditor(mode, tally = null, preferredDeviceId = '') {
  state.editorMode = mode;
  state.editingId = tally?.id || null;

  editorTitleEl.textContent = mode === 'add' ? 'Add Tally Light' : 'Edit Tally Light';
  editorDeleteEl.hidden = mode === 'add';

  const parsedChannel = parseChannelKey(tally?.channelKey || 'input:1');
  const selectedMac = normalizeMac(tally?.deviceId || preferredDeviceId);

  editorFormEl.elements.id.value = tally?.id || '';
  editorFormEl.elements.name.value = tally?.name || selectedMac || 'Tally Light';
  editorFormEl.elements.deviceId.value = selectedMac;
  editorFormEl.elements.activeThresholdPercent.value = String(Math.round(getThresholdPercent(tally)));

  if (mode === 'edit') {
    deviceFieldEl.hidden = true;
    editorMacEl.hidden = false;
    editorMacEl.textContent = `MAC: ${selectedMac || 'Unknown'}`;
  } else {
    deviceFieldEl.hidden = false;
    editorMacEl.hidden = true;
    editorMacEl.textContent = '';
  }

  populateChannelTypeSelect(state.snapshot, parsedChannel.type);
  populateChannelIndexSelect(state.snapshot, channelTypeEl.value, parsedChannel.key);

  if (!editorEl.open) {
    editorEl.showModal();
  }
}

function closeTallyEditor() {
  editorEl.close();
  state.editorMode = 'add';
  state.editingId = null;
}

async function handleMenuAction(action) {
  if (!state.snapshot) {
    const snapshot = await window.avantisApi.getState();
    applyState(snapshot);
  }

  if (action === 'open-console-modal') {
    openConsoleModal();
    return;
  }

  if (action === 'open-tally-connection-modal') {
    openTallyConnectionModal();
    return;
  }

  if (action === 'open-tally-color-modal') {
    openTallyColorsModal();
    return;
  }

  if (action === 'open-add-tally') {
    if (getKnownMacs().length === 0) {
      await window.avantisApi.showInfo({
        title: 'No Provisioned Devices',
        message: 'Use Sync Tally Lights first so a hardware MAC is provisioned and added.'
      });
      return;
    }
    openTallyEditor('add');
    return;
  }

  if (action === 'open-sync-modal') {
    await openSyncModal();
  }
}

async function boot() {
  window.avantisApi.onState((snapshot) => {
    applyState(snapshot);

    if (!snapshot.console.address && !consoleModalEl.open) {
      openConsoleModal(snapshot);
    }
  });

  window.avantisApi.onMenuAction((action) => {
    handleMenuAction(action).catch(async (error) => {
      await window.avantisApi.showError({ message: error.message });
    });
  });

  channelTypeEl.addEventListener('change', () => {
    if (!state.snapshot) {
      return;
    }

    populateChannelIndexSelect(state.snapshot, channelTypeEl.value);
  });

  addTallyEl.addEventListener('click', async () => {
    if (getKnownMacs().length === 0) {
      await window.avantisApi.showInfo({
        title: 'No Provisioned Devices',
        message: 'Use Sync Tally Lights first so a hardware MAC is provisioned and added.'
      });
      return;
    }

    openTallyEditor('add');
  });

  syncTalliesEl.addEventListener('click', async () => {
    try {
      await openSyncModal();
    } catch (error) {
      await window.avantisApi.showError({ message: error.message });
    }
  });

  syncRescanEl.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      await scanBeacons();
    } catch (error) {
      await window.avantisApi.showError({ message: error.message });
    }
  });

  syncCloseEl.addEventListener('click', (event) => {
    event.preventDefault();
    syncModalEl.close();
  });

  syncDeviceListEl.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) {
      return;
    }

    if (target.dataset.action !== 'provision') {
      return;
    }

    const port = String(target.dataset.port || '').trim();
    const mac = normalizeMac(target.dataset.mac);
    if (!port || !mac) {
      return;
    }

    target.disabled = true;
    try {
      const response = await window.avantisApi.provisionTallyDevice({ port, mac });
      if (response?.snapshot) {
        applyState(response.snapshot);
      }
      await scanBeacons();
    } catch (error) {
      await window.avantisApi.showError({ message: error.message });
    } finally {
      target.disabled = false;
    }
  });

  disconnectButtonEl.addEventListener('click', async () => {
    await window.avantisApi.disconnectConsole();
  });

  consoleFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();

    try {
      await window.avantisApi.saveConsole({
        address: consoleFormEl.elements.address.value,
        port: Number(consoleFormEl.elements.port.value || 51325),
        baseMidiChannel: Number(consoleFormEl.elements.baseMidiChannel.value || 12)
      });
      consoleModalEl.close();
    } catch (error) {
      await window.avantisApi.showError({ message: error.message });
    }
  });

  consoleCancelEl.addEventListener('click', (event) => {
    event.preventDefault();
    consoleModalEl.close();
  });

  tallyConnectionFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();

    await window.avantisApi.saveTallyConnection({
      proxyAddress: tallyConnectionFormEl.elements.proxyAddress.value,
      wifiSsid: tallyConnectionFormEl.elements.wifiSsid.value,
      wifiPassword: tallyConnectionFormEl.elements.wifiPassword.value
    });

    tallyConnectionModalEl.close();
  });

  tallyConnectionCancelEl.addEventListener('click', (event) => {
    event.preventDefault();
    tallyConnectionModalEl.close();
  });

  tallyColorsFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();

    await window.avantisApi.saveTallyColors({
      active: tallyColorsFormEl.elements.active.value,
      belowThreshold: tallyColorsFormEl.elements.belowThreshold.value,
      muted: tallyColorsFormEl.elements.muted.value
    });

    tallyColorsModalEl.close();
  });

  tallyColorsCancelEl.addEventListener('click', (event) => {
    event.preventDefault();
    tallyColorsModalEl.close();
  });

  tallyListEl.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !state.snapshot) {
      return;
    }

    const id = target.dataset.id;
    const action = target.dataset.action;
    if (!id || !action) {
      return;
    }

    const tally = state.snapshot.tallyLights.find((item) => item.id === id);
    if (!tally) {
      return;
    }

    if (action === 'edit') {
      openTallyEditor('edit', tally);
    }
  });

  editorFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      id: editorFormEl.elements.id.value || undefined,
      name: editorFormEl.elements.name.value,
      deviceId: editorFormEl.elements.deviceId.value,
      channelKey: channelIndexEl.value,
      activeThresholdPercent: Number(editorFormEl.elements.activeThresholdPercent.value || 5)
    };

    try {
      if (state.editorMode === 'add') {
        await window.avantisApi.addTally(payload);
      } else {
        await window.avantisApi.updateTally(payload);
      }
      closeTallyEditor();
    } catch (error) {
      await window.avantisApi.showError({ message: error.message });
    }
  });

  editorCancelEl.addEventListener('click', (event) => {
    event.preventDefault();
    closeTallyEditor();
  });

  editorDeleteEl.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!state.editingId) {
      return;
    }
    await window.avantisApi.removeTally({ id: state.editingId });
    closeTallyEditor();
  });

  syncFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
  });

  const snapshot = await window.avantisApi.getState();
  applyState(snapshot);

  if (!snapshot.console.address) {
    openConsoleModal(snapshot);
  }
}

boot();