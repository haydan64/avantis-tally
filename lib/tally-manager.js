import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeMac(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const hex = value.toLowerCase().replace(/[^a-f0-9]/g, '');
  if (hex.length !== 12) {
    return '';
  }

  const parts = [];
  for (let i = 0; i < 12; i += 2) {
    parts.push(hex.slice(i, i + 2));
  }

  return parts.join(':');
}

function resolveDeviceIdentity(url, payload) {
  const queryMac = normalizeMac(url.searchParams.get('mac') || url.searchParams.get('macAddress') || '');
  const payloadMac = normalizeMac(payload?.mac || payload?.macAddress || payload?.id || '');
  const mac = payloadMac || queryMac;

  const payloadId = typeof payload?.id === 'string' && payload.id.trim().length > 0 ? payload.id.trim() : '';
  const queryId = typeof url.searchParams.get('id') === 'string' ? String(url.searchParams.get('id')).trim() : '';

  const id = mac || payloadId || queryId || randomUUID();
  return {
    id,
    mac
  };
}

export class TallyManager extends EventEmitter {
  constructor(websocketPort = 19188) {
    super();
    this.websocketPort = websocketPort;
    this.wss = null;
    this.devices = new Map();
  }

  start() {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocketServer({ port: this.websocketPort });
    this.wss.on('connection', (socket, request) => {
      const url = new URL(request.url || '/', 'ws://localhost');
      const identity = resolveDeviceIdentity(url, null);
      const queryName = url.searchParams.get('name');

      const device = {
        id: identity.id,
        mac: identity.mac,
        name: queryName || identity.mac || identity.id,
        address: request.socket.remoteAddress || '',
        connectedAt: new Date().toISOString(),
        socket
      };

      this.devices.set(device.id, device);
      this.emitDevicesChanged();

      socket.on('message', (message) => {
        const text = String(message);
        const payload = safeParseJson(text);

        if (payload?.type === 'hello' || payload?.type === 'register') {
          const nextIdentity = resolveDeviceIdentity(url, payload);

          if (nextIdentity.id !== device.id) {
            this.devices.delete(device.id);
            device.id = nextIdentity.id;
            this.devices.set(device.id, device);
          }

          if (nextIdentity.mac) {
            device.mac = nextIdentity.mac;
          }

          if (typeof payload.name === 'string' && payload.name.trim().length > 0) {
            device.name = payload.name.trim();
          } else if (!device.name) {
            device.name = device.mac || device.id;
          }

          this.emitDevicesChanged();
        }
      });

      socket.on('close', () => {
        this.devices.delete(device.id);
        this.emitDevicesChanged();
      });

      socket.on('error', (error) => {
        this.emit('device-error', { deviceId: device.id, error });
      });
    });

    this.wss.on('listening', () => {
      this.emit('server-status', {
        listening: true,
        port: this.websocketPort
      });
    });

    this.wss.on('error', (error) => {
      this.emit('server-error', error);
    });
  }

  async stop() {
    if (!this.wss) {
      return;
    }

    for (const device of this.devices.values()) {
      try {
        device.socket.close();
      } catch {
        // Ignore close errors during shutdown.
      }
    }

    await new Promise((resolve) => {
      this.wss.close(() => resolve());
    });

    this.devices.clear();
    this.wss = null;
    this.emitDevicesChanged();
  }

  listDevices() {
    return Array.from(this.devices.values()).map((device) => ({
      id: device.id,
      mac: device.mac,
      name: device.name,
      address: device.address,
      connectedAt: device.connectedAt
    }));
  }

  async syncProxy(tally, options) {
    const device = this.devices.get(tally.deviceId);
    if (!device || device.socket.readyState !== 1) {
      throw new Error('Tally device is not connected over WebSocket.');
    }

    const proxyAddress = String(options?.proxyAddress ?? '').trim();
    const fallbackAddress = String(options?.fallbackAddress ?? '').trim();
    const wifiSsid = String(options?.wifiSsid ?? '').trim();
    const wifiPassword = String(options?.wifiPassword ?? '');

    const resolvedAddress = proxyAddress || fallbackAddress;
    if (!resolvedAddress) {
      throw new Error('Proxy address is not set and console address is empty.');
    }

    await this.send(device.socket, JSON.stringify({
      type: 'connection-settings',
      proxyAddress: resolvedAddress,
      proxyPort: this.websocketPort,
      wifiSsid,
      wifiPassword
    }));

    await this.send(device.socket, JSON.stringify({
      type: 'proxy',
      address: resolvedAddress,
      port: this.websocketPort
    }));

    await this.send(device.socket, `PROXY ${resolvedAddress}`);

    if (wifiSsid) {
      await this.send(device.socket, `WIFI ${wifiSsid}`);
    }
  }

  async updateTallyOutput(tally, faderState) {
    const device = this.devices.get(tally.deviceId);
    if (!device || device.socket.readyState !== 1) {
      return;
    }

    const thresholdPercent = Number(tally.activeThresholdPercent ?? tally.onThreshold ?? 0);
    const threshold = (thresholdPercent <= 1 ? thresholdPercent * 100 : thresholdPercent) / 100;
    const level = Number(faderState?.level ?? 0);
    const muted = Boolean(faderState?.muted);
    const on = !muted && level > threshold;

    await this.send(device.socket, JSON.stringify({
      type: 'tally-state',
      tallyId: tally.id,
      name: tally.name,
      channelKey: tally.channelKey,
      on,
      muted,
      level
    }));

    await this.send(device.socket, on ? 'ON' : 'OFF');
  }

  async clearMissing() {
    // No-op for WebSocket devices; connection lifecycle is managed by socket state.
  }

  emitDevicesChanged() {
    this.emit('devices-changed', this.listDevices());
  }

  async send(socket, payload) {
    await new Promise((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}
