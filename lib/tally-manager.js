import { EventEmitter } from 'node:events';
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

function normalizeColor(value, fallback) {
  const text = String(value ?? '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(text)) {
    return text.toLowerCase();
  }

  if (/^[0-9a-fA-F]{6}$/.test(text)) {
    return `#${text.toLowerCase()}`;
  }

  return fallback;
}

function hexToLedPayload(color) {
  const sixHex = color.replace('#', '').toLowerCase();
  return sixHex.repeat(8);
}

export class TallyManager extends EventEmitter {
  constructor(websocketPort = 19188, options = {}) {
    super();
    this.websocketPort = websocketPort;
    this.isDeviceAllowed = typeof options.isDeviceAllowed === 'function' ? options.isDeviceAllowed : () => true;
    this.heartbeatIntervalMs = Math.max(1000, Number(options.heartbeatIntervalMs) || 3000);
    this.wss = null;
    this.devices = new Map();
    this.heartbeatTimer = null;
  }

  start() {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocketServer({ port: this.websocketPort });
    this.wss.on('connection', (socket, request) => {
      const remoteAddress = request.socket.remoteAddress || '';
      let registered = false;
      let registeredId = '';
      let helloTimer = null;

      socket.isAlive = true;
      socket.on('pong', () => {
        socket.isAlive = true;
      });

      const closeUnauthorized = () => {
        try {
          socket.close(1008, 'Not provisioned');
        } catch {
          socket.terminate();
        }
      };

      const finalizeRegistration = (payload) => {
        const mac = normalizeMac(payload?.mac || payload?.macAddress || payload?.id || '');
        if (!mac) {
          closeUnauthorized();
          return;
        }

        if (!this.isDeviceAllowed(mac)) {
          closeUnauthorized();
          return;
        }

        const device = {
          id: mac,
          mac,
          name: typeof payload?.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : mac,
          model: typeof payload?.model === 'string' ? payload.model : '',
          fw: typeof payload?.fw === 'string' ? payload.fw : '',
          address: remoteAddress,
          connectedAt: new Date().toISOString(),
          socket
        };

        socket.isAlive = true;
        registered = true;
        registeredId = mac;
        this.devices.set(mac, device);
        this.emitDevicesChanged();
      };

      helloTimer = setTimeout(() => {
        if (!registered) {
          closeUnauthorized();
        }
      }, 3000);

      socket.on('message', (message) => {
        const text = String(message);
        const payload = safeParseJson(text);

        if (!registered) {
          if (payload?.op === 'hello' || payload?.type === 'hello' || payload?.type === 'register') {
            clearTimeout(helloTimer);
            helloTimer = null;
            finalizeRegistration(payload);
          }
          return;
        }

        if (payload?.op === 'hello' || payload?.type === 'hello' || payload?.type === 'register') {
          const device = this.devices.get(registeredId);
          if (!device) {
            return;
          }

          if (typeof payload.name === 'string' && payload.name.trim().length > 0) {
            device.name = payload.name.trim();
          }
          if (typeof payload.model === 'string') {
            device.model = payload.model;
          }
          if (typeof payload.fw === 'string') {
            device.fw = payload.fw;
          }

          this.emitDevicesChanged();
        }
      });

      socket.on('close', () => {
        if (helloTimer) {
          clearTimeout(helloTimer);
        }
        if (registered && registeredId) {
          this.devices.delete(registeredId);
          this.emitDevicesChanged();
        }
      });

      socket.on('error', (error) => {
        this.emit('device-error', { deviceId: registeredId, error });
      });
    });

    this.heartbeatTimer = setInterval(() => {
      for (const device of this.devices.values()) {
        const socket = device.socket;

        if (!socket || socket.readyState !== 1) {
          continue;
        }

        if (socket.isAlive === false) {
          socket.terminate();
          continue;
        }

        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }, this.heartbeatIntervalMs);

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

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
      model: device.model,
      fw: device.fw,
      address: device.address,
      connectedAt: device.connectedAt
    }));
  }

  async updateTallyOutput(tally, faderState, tallyColors = {}) {
    const device = this.devices.get(tally.deviceId);
    if (!device || device.socket.readyState !== 1) {
      return;
    }

    const thresholdPercent = Number(tally.activeThresholdPercent ?? tally.onThreshold ?? 0);
    const threshold = (thresholdPercent <= 1 ? thresholdPercent * 100 : thresholdPercent) / 100;
    const level = Number(faderState?.level ?? 0);
    const muted = Boolean(faderState?.muted);

    const colors = {
      active: normalizeColor(tallyColors.active, '#ff0000'),
      belowThreshold: normalizeColor(tallyColors.belowThreshold, '#00ff00'),
      muted: normalizeColor(tallyColors.muted, '#00008b')
    };

    let status = 'below-threshold';
    let color = colors.belowThreshold;

    if (muted) {
      status = 'muted';
      color = colors.muted;
    } else if (level > threshold) {
      status = 'active';
      color = colors.active;
    }

    const hexPayload = hexToLedPayload(color);

    await this.send(device.socket, JSON.stringify({
      type: 'tally-state',
      tallyId: tally.id,
      name: tally.name,
      channelKey: tally.channelKey,
      status,
      muted,
      level,
      threshold,
      color,
      hex: hexPayload
    }));

    await this.send(device.socket, hexPayload);
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