import { EventEmitter } from 'node:events';
import net from 'node:net';

function clamp7(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) {
    return 0;
  }
  return Math.max(0, Math.min(127, Math.round(v)));
}

function makeChannel(type, index, midiOffset, note) {
  return {
    type,
    index,
    midiOffset,
    note,
    key: `${type}:${index}`,
    label: `${type} ${index}`
  };
}

function createChannelCollection(type, count, midiOffset, noteStart) {
  const items = [];
  items[0] = null;

  for (let i = 1; i <= count; i += 1) {
    items[i] = makeChannel(type, i, midiOffset, noteStart + i - 1);
  }

  return items;
}

function buildChannelCatalog() {
  const catalog = {
    Inputs: createChannelCollection('input', 64, 0, 0x00),
    MonoGroups: createChannelCollection('mono-group', 40, 1, 0x00),
    StereoGroups: createChannelCollection('stereo-group', 20, 1, 0x40),
    MonoAux: createChannelCollection('mono-aux', 40, 2, 0x00),
    StereoAux: createChannelCollection('stereo-aux', 20, 2, 0x40),
    MonoMatrix: createChannelCollection('mono-matrix', 40, 3, 0x00),
    StereoMatrix: createChannelCollection('stereo-matrix', 20, 3, 0x40),
    MonoFxSend: createChannelCollection('mono-fx-send', 12, 4, 0x00),
    StereoFxSend: createChannelCollection('stereo-fx-send', 12, 4, 0x10),
    FxReturn: createChannelCollection('fx-return', 12, 4, 0x20),
    Main: createChannelCollection('main', 3, 4, 0x30),
    Dca: createChannelCollection('dca', 16, 4, 0x36),
    MuteGroup: createChannelCollection('mute-group', 8, 4, 0x46)
  };

  const all = [];
  const byKey = new Map();
  const byOffsetAndNote = new Map();

  const addCollection = (list) => {
    for (const channel of list) {
      if (!channel) {
        continue;
      }

      all.push(channel);
      byKey.set(channel.key, channel);
      byOffsetAndNote.set(`${channel.midiOffset}:${channel.note}`, channel);
    }
  };

  addCollection(catalog.Inputs);
  addCollection(catalog.MonoGroups);
  addCollection(catalog.StereoGroups);
  addCollection(catalog.MonoAux);
  addCollection(catalog.StereoAux);
  addCollection(catalog.MonoMatrix);
  addCollection(catalog.StereoMatrix);
  addCollection(catalog.MonoFxSend);
  addCollection(catalog.StereoFxSend);
  addCollection(catalog.FxReturn);
  addCollection(catalog.Main);
  addCollection(catalog.Dca);
  addCollection(catalog.MuteGroup);

  return {
    ...catalog,
    all,
    fromKey(key) {
      return byKey.get(String(key || '').toLowerCase()) || null;
    },
    fromMidi(baseMidiChannel, midiChannel, note) {
      const offset = Number(midiChannel) - Number(baseMidiChannel);
      return byOffsetAndNote.get(`${offset}:${note}`) || null;
    }
  };
}

export const AvantisChannels = buildChannelCatalog();

class MidiParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.runningStatus = null;
    this.pendingData = [];
    this.inSysex = false;
  }

  push(buffer) {
    for (const byte of buffer) {
      this.consumeByte(byte);
    }
  }

  consumeByte(byte) {
    if (this.inSysex) {
      if (byte === 0xf7) {
        this.inSysex = false;
      }
      return;
    }

    if ((byte & 0x80) !== 0) {
      this.handleStatusByte(byte);
      return;
    }

    if (this.runningStatus === null) {
      return;
    }

    this.pendingData.push(byte);
    const required = MidiParser.requiredDataBytes(this.runningStatus);
    if (this.pendingData.length < required) {
      return;
    }

    const status = this.runningStatus;
    const typeNibble = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    const data1 = this.pendingData[0] ?? 0;
    const data2 = this.pendingData[1] ?? 0;

    this.pendingData = [];

    this.onMessage({
      status,
      channel,
      data1,
      data2,
      type: MidiParser.typeName(typeNibble, data2)
    });
  }

  handleStatusByte(byte) {
    if (byte === 0xf0) {
      this.inSysex = true;
      this.runningStatus = null;
      this.pendingData = [];
      return;
    }

    if (byte >= 0xf8) {
      return;
    }

    if (byte >= 0xf0) {
      this.runningStatus = null;
      this.pendingData = [];
      return;
    }

    this.runningStatus = byte;
    this.pendingData = [];
  }

  static requiredDataBytes(status) {
    const type = status & 0xf0;
    if (type === 0xc0 || type === 0xd0) {
      return 1;
    }
    return 2;
  }

  static typeName(typeNibble, velocity) {
    if (typeNibble === 0x80) {
      return 'noteoff';
    }
    if (typeNibble === 0x90 && velocity === 0) {
      return 'noteoff';
    }
    if (typeNibble === 0x90) {
      return 'noteon';
    }
    if (typeNibble === 0xb0) {
      return 'cc';
    }
    if (typeNibble === 0xc0) {
      return 'pc';
    }
    return 'other';
  }
}

class NrpnDecoder {
  constructor(onNrpn) {
    this.onNrpn = onNrpn;
    this.perChannel = new Map();
  }

  consume(message) {
    if (message.type !== 'cc') {
      return;
    }

    const channel = message.channel;
    if (!this.perChannel.has(channel)) {
      this.perChannel.set(channel, {
        selector: null,
        parameter: null
      });
    }

    const state = this.perChannel.get(channel);

    if (message.data1 === 0x63) {
      state.selector = message.data2;
      return;
    }

    if (message.data1 === 0x62) {
      state.parameter = message.data2;
      return;
    }

    if (message.data1 === 0x06 && state.selector !== null && state.parameter !== null) {
      this.onNrpn({
        midiChannel: channel,
        selector: state.selector,
        parameter: state.parameter,
        value: message.data2
      });
    }
  }
}

export class AvantisClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.socket = null;
    this.connected = false;
    this.host = '';
    this.port = 51325;
    this.baseMidiChannel = this.normalizeBaseMidiChannel(options.baseMidiChannel ?? 12);
    this.channelState = new Map();

    this.nrpnDecoder = new NrpnDecoder((nrpn) => this.handleNrpn(nrpn));
    this.parser = new MidiParser((message) => this.handleMidiMessage(message));
  }

  normalizeBaseMidiChannel(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) {
      return 12;
    }
    return Math.min(12, Math.max(1, Math.round(v)));
  }

  setBaseMidiChannel(channel) {
    this.baseMidiChannel = this.normalizeBaseMidiChannel(channel);
  }

  connect(host, port = 51325) {
    this.disconnect();

    this.host = String(host || '').trim();
    this.port = Number(port || 51325);

    const socket = net.createConnection({ host: this.host, port: this.port }, () => {
      this.connected = true;
      this.emit('connection', { connected: true, host: this.host, port: this.port });
    });

    socket.on('data', (data) => {
      this.parser.push(data);
      this.emit('raw-data', data);
    });

    socket.on('error', (error) => {
      this.emit('error', error);
    });

    socket.on('close', () => {
      this.connected = false;
      this.emit('connection', { connected: false, host: this.host, port: this.port });
    });

    this.socket = socket;
  }

  disconnect() {
    if (!this.socket) {
      return;
    }

    try {
      this.socket.destroy();
    } finally {
      this.socket = null;
      this.connected = false;
    }
  }

  resolveChannel(channelOrKey) {
    if (!channelOrKey) {
      return null;
    }

    if (typeof channelOrKey === 'string') {
      return AvantisChannels.fromKey(channelOrKey);
    }

    if (typeof channelOrKey === 'object' && typeof channelOrKey.key === 'string') {
      return AvantisChannels.fromKey(channelOrKey.key) || channelOrKey;
    }

    return null;
  }

  toMidiChannel(channelRef) {
    return this.baseMidiChannel + Number(channelRef.midiOffset || 0);
  }

  sendMidi(status, data1 = 0, data2 = 0) {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to Avantis console.');
    }

    const bytes = [clamp7(status), clamp7(data1), clamp7(data2)];
    bytes[0] = Number(status) & 0xff;

    this.socket.write(Buffer.from(bytes));
  }

  sendControlChange(midiChannel, controller, value) {
    const channelNibble = (Number(midiChannel) - 1) & 0x0f;
    const status = 0xb0 | channelNibble;
    this.sendMidi(status, controller, value);
  }

  sendNoteOn(midiChannel, note, velocity) {
    const channelNibble = (Number(midiChannel) - 1) & 0x0f;
    const status = 0x90 | channelNibble;
    this.sendMidi(status, note, velocity);
  }

  sendNrpn(channelOrKey, parameter, value) {
    const channelRef = this.resolveChannel(channelOrKey);
    if (!channelRef) {
      throw new Error('Invalid Avantis channel reference.');
    }

    const midiChannel = this.toMidiChannel(channelRef);
    this.sendControlChange(midiChannel, 0x63, channelRef.note);
    this.sendControlChange(midiChannel, 0x62, parameter);
    this.sendControlChange(midiChannel, 0x06, value);
  }

  setFaderLevel(channelOrKey, level) {
    this.sendNrpn(channelOrKey, 0x17, clamp7(level));
  }

  setMute(channelOrKey, muted) {
    const channelRef = this.resolveChannel(channelOrKey);
    if (!channelRef) {
      throw new Error('Invalid Avantis channel reference.');
    }

    const midiChannel = this.toMidiChannel(channelRef);
    const velocity = muted ? 0x7f : 0x3f;

    this.sendNoteOn(midiChannel, channelRef.note, velocity);
    this.sendNoteOn(midiChannel, channelRef.note, 0x00);
  }

  mute(channelOrKey) {
    this.setMute(channelOrKey, true);
  }

  unmute(channelOrKey) {
    this.setMute(channelOrKey, false);
  }

  handleMidiMessage(message) {
    this.emit('midi-message', message);
    this.nrpnDecoder.consume(message);

    if (message.type === 'noteon' && message.data2 > 0) {
      const channelRef = AvantisChannels.fromMidi(this.baseMidiChannel, message.channel, message.data1);
      if (!channelRef) {
        return;
      }

      const muted = message.data2 >= 0x40;
      this.updateChannelState(channelRef, {
        muted,
        muteVelocity: message.data2
      });

      this.emit('channel-mute', {
        channel: channelRef,
        muted,
        velocity: message.data2
      });
    }
  }

  handleNrpn(nrpn) {
    this.emit('nrpn', nrpn);

    if (nrpn.parameter !== 0x17) {
      return;
    }

    const channelRef = AvantisChannels.fromMidi(this.baseMidiChannel, nrpn.midiChannel, nrpn.selector);
    if (!channelRef) {
      return;
    }

    const levelRaw = clamp7(nrpn.value);
    const level = levelRaw / 127;

    this.updateChannelState(channelRef, {
      level,
      levelRaw
    });

    this.emit('channel-level', {
      channel: channelRef,
      level,
      levelRaw
    });
  }

  updateChannelState(channel, patch) {
    const existing = this.channelState.get(channel.key) || {
      channel,
      level: 0,
      levelRaw: 0,
      muted: true,
      updatedAt: new Date().toISOString()
    };

    const next = {
      ...existing,
      ...patch,
      channel,
      updatedAt: new Date().toISOString()
    };

    this.channelState.set(channel.key, next);

    this.emit('channel-state', {
      channel,
      state: {
        level: next.level,
        muted: next.muted,
        updatedAt: next.updatedAt
      }
    });
  }
}
