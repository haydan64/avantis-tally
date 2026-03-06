const state = {
  snapshot: null,
  editorMode: 'add',
  editingId: null
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

const consoleModalEl = document.getElementById('console-modal');
const consoleFormEl = document.getElementById('console-form');
const consoleCancelEl = document.getElementById('console-cancel');

const tallyConnectionModalEl = document.getElementById('tally-connection-modal');
const tallyConnectionFormEl = document.getElementById('tally-connection-form');
const tallyConnectionCancelEl = document.getElementById('tally-connection-cancel');

const editorEl = document.getElementById('tally-editor');
const editorTitleEl = document.getElementById('editor-title');
const editorFormEl = document.getElementById('editor-form');
const editorCancelEl = document.getElementById('editor-cancel');
const editorSyncEl = document.getElementById('editor-sync');
const editorDeleteEl = document.getElementById('editor-delete');
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

  return 0;
}

function buildChannelTypeOptions(snapshot) {
  return Array.isArray(snapshot?.channelCatalog) ? snapshot.channelCatalog : [];
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
  refillDeviceSelect(snapshot.devices);
}

function renderUnifiedList(snapshot) {
  tallyListEl.innerHTML = '';

  const assignedDeviceIds = new Set(snapshot.tallyLights.map((tally) => tally.deviceId).filter(Boolean));

  if (snapshot.tallyLights.length === 0 && snapshot.devices.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No tally lights configured and no WebSocket devices connected.';
    tallyListEl.appendChild(li);
    return;
  }

  for (const tally of snapshot.tallyLights) {
    const fader = snapshot.faders[tally.channelKey] || { level: 0, muted: true };
    const thresholdPercent = getThresholdPercent(tally);
    const on = !fader.muted && fader.level > thresholdPercent / 100;
    const device = snapshot.devices.find((d) => d.id === tally.deviceId);

    const li = document.createElement('li');
    li.className = 'tally-item';
    li.innerHTML = `
      <div class="tally-main">
        <div class="name-row">
          <span class="name">${escapeHtml(tally.name)}</span>
          <span class="light ${on ? 'on' : 'off'}">${on ? 'ON' : 'OFF'}</span>
        </div>
        <div class="meta">
          <span>Device: ${escapeHtml(device?.name || tally.deviceId || 'Unassigned')} ${device?.mac ? '(' + escapeHtml(device.mac) + ')' : ''}</span>
          <span>Channel: ${escapeHtml(tally.channelKey)}</span>
          <span>Threshold: ${Math.round(thresholdPercent)}%</span>
          <span>Level: ${Math.round((fader.level || 0) * 100)}%</span>
          <span>Muted: ${fader.muted ? 'Yes' : 'No'}</span>
        </div>
      </div>
      <div class="actions">
        <button data-action="edit" data-id="${tally.id}">Edit</button>
        <button data-action="sync" data-id="${tally.id}" title="Sends tally connection settings to the selected tally device.">Sync Proxy</button>
      </div>
    `;

    tallyListEl.appendChild(li);
  }

  for (const device of snapshot.devices) {
    if (assignedDeviceIds.has(device.id)) {
      continue;
    }

    const li = document.createElement('li');
    li.className = 'device-item';
    li.innerHTML = `
      <div class="tally-main">
        <div class="name-row">
          <span class="name">${escapeHtml(device.name)}</span>
          <span class="light off">UNASSIGNED</span>
        </div>
        <div class="meta">
          <span>MAC: ${escapeHtml(device.mac || 'Unknown')}</span>
          <span>Address: ${escapeHtml(device.address || 'Unknown')}</span>
        </div>
      </div>
      <div class="actions">
        <button data-action="add-for-device" data-device-id="${device.id}">Add Tally</button>
      </div>
    `;

    tallyListEl.appendChild(li);
  }
}

function refillDeviceSelect(devices) {
  const previous = editorFormEl.elements.deviceId.value;
  deviceSelectEl.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = devices.length > 0 ? 'Select a connected device' : 'No connected devices';
  deviceSelectEl.appendChild(placeholder);

  for (const device of devices) {
    const option = document.createElement('option');
    option.value = device.id;
    option.textContent = `${device.name}${device.mac ? ` (${device.mac})` : ` (${device.id})`}`;
    deviceSelectEl.appendChild(option);
  }

  if (previous) {
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

function openTallyEditor(mode, tally = null, preferredDeviceId = '') {
  state.editorMode = mode;
  state.editingId = tally?.id || null;

  editorTitleEl.textContent = mode === 'add' ? 'Add Tally Light' : 'Edit Tally Light';
  editorSyncEl.hidden = mode === 'add';
  editorDeleteEl.hidden = mode === 'add';

  const parsedChannel = parseChannelKey(tally?.channelKey || 'input:1');

  editorFormEl.elements.id.value = tally?.id || '';
  editorFormEl.elements.name.value = tally?.name || 'Tally Light';
  editorFormEl.elements.deviceId.value = tally?.deviceId || preferredDeviceId;
  editorFormEl.elements.activeThresholdPercent.value = String(Math.round(getThresholdPercent(tally)));

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

  if (action === 'open-add-tally') {
    openTallyEditor('add');
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

  addTallyEl.addEventListener('click', () => openTallyEditor('add'));

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

  tallyListEl.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || !state.snapshot) {
      return;
    }

    const addForDevice = target.dataset.deviceId;
    if (target.dataset.action === 'add-for-device' && addForDevice) {
      openTallyEditor('add', null, addForDevice);
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
      return;
    }

    if (action === 'sync') {
      try {
        await window.avantisApi.syncTally({ id });
      } catch (error) {
        await window.avantisApi.showError({ message: error.message });
      }
    }
  });

  editorFormEl.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      id: editorFormEl.elements.id.value || undefined,
      name: editorFormEl.elements.name.value,
      deviceId: editorFormEl.elements.deviceId.value,
      channelKey: channelIndexEl.value,
      activeThresholdPercent: Number(editorFormEl.elements.activeThresholdPercent.value || 0)
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

  editorSyncEl.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!state.editingId) {
      return;
    }

    try {
      await window.avantisApi.syncTally({ id: state.editingId });
    } catch (error) {
      await window.avantisApi.showError({ message: error.message });
    }
  });

  const snapshot = await window.avantisApi.getState();
  applyState(snapshot);

  if (!snapshot.console.address) {
    openConsoleModal(snapshot);
  }
}

boot();
