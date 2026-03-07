import net from 'node:net';
import readline from 'node:readline';

const PORT = 51325;
const HOST = '0.0.0.0';
const BASE_MIDI_CHANNEL = 12;

const INPUT_1_NOTE = 0x00;
const NRPN_FADER_PARAMETER = 0x17;

let level = 0;
let muted = true;

const clients = new Set();

function clamp7(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(127, Math.round(n)));
}

function midiStatusForChannel(channel, baseStatus) {
  const nibble = (Number(channel) - 1) & 0x0f;
  return baseStatus | nibble;
}

function sendBytes(socket, bytes) {
  if (!socket || socket.destroyed) {
    return;
  }

  socket.write(Buffer.from(bytes));
}

function sendControlChange(socket, midiChannel, controller, value) {
  sendBytes(socket, [midiStatusForChannel(midiChannel, 0xb0), controller & 0x7f, clamp7(value)]);
}

function sendNoteOn(socket, midiChannel, note, velocity) {
  sendBytes(socket, [midiStatusForChannel(midiChannel, 0x90), note & 0x7f, clamp7(velocity)]);
}

function sendInput1Level(socket, nextLevel) {
  sendControlChange(socket, BASE_MIDI_CHANNEL, 0x63, INPUT_1_NOTE);
  sendControlChange(socket, BASE_MIDI_CHANNEL, 0x62, NRPN_FADER_PARAMETER);
  sendControlChange(socket, BASE_MIDI_CHANNEL, 0x06, nextLevel);
}

function sendInput1Mute(socket, isMuted) {
  const velocity = isMuted ? 0x7f : 0x3f;
  sendNoteOn(socket, BASE_MIDI_CHANNEL, INPUT_1_NOTE, velocity);
  sendNoteOn(socket, BASE_MIDI_CHANNEL, INPUT_1_NOTE, 0x00);
}

function broadcastState() {
  for (const socket of clients) {
    sendInput1Level(socket, level);
    sendInput1Mute(socket, muted);
  }

  printState();
}

function printState() {
  const pct = Math.round((level / 127) * 100);
  console.log(`State -> input:1 level=${level} (${pct}%) muted=${muted}`);
}

function showHelp() {
  console.log('Commands:');
  console.log('  up            Increase fader by 10');
  console.log('  down          Decrease fader by 10');
  console.log('  set <0-127>   Set exact fader value');
  console.log('  mute          Set input 1 muted');
  console.log('  unmute        Set input 1 unmuted');
  console.log('  toggle        Toggle mute');
  console.log('  send          Re-send current state to all clients');
  console.log('  state         Print current state');
  console.log('  help          Show commands');
  console.log('  quit          Exit simulator');
}

function handleCommand(line) {
  const text = String(line || '').trim();
  if (!text) {
    return;
  }

  const [command, arg] = text.split(/\s+/, 2);
  const cmd = command.toLowerCase();

  if (cmd === 'up' || cmd === 'u') {
    level = clamp7(level + 10);
    broadcastState();
    return;
  }

  if (cmd === 'down' || cmd === 'd') {
    level = clamp7(level - 10);
    broadcastState();
    return;
  }

  if (cmd === 'set' || cmd === 's') {
    level = clamp7(arg);
    broadcastState();
    return;
  }

  if (cmd === 'mute' || cmd === 'm') {
    muted = true;
    broadcastState();
    return;
  }

  if (cmd === 'unmute' || cmd === 'um') {
    muted = false;
    broadcastState();
    return;
  }

  if (cmd === 'toggle' || cmd === 't') {
    muted = !muted;
    broadcastState();
    return;
  }

  if (cmd === 'send') {
    broadcastState();
    return;
  }

  if (cmd === 'state') {
    printState();
    return;
  }

  if (cmd === 'help' || cmd === 'h' || cmd === '?') {
    showHelp();
    return;
  }

  if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
    process.exit(0);
    return;
  }

  console.log(`Unknown command: ${text}`);
  showHelp();
}

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || '?'}`;
  clients.add(socket);

  console.log(`Client connected: ${remote} (clients: ${clients.size})`);

  sendInput1Level(socket, level);
  sendInput1Mute(socket, muted);

  socket.on('close', () => {
    clients.delete(socket);
    console.log(`Client disconnected: ${remote} (clients: ${clients.size})`);
  });

  socket.on('error', (error) => {
    clients.delete(socket);
    console.log(`Client error: ${remote} ${error.message}`);
  });

  socket.on('data', () => {
    // Incoming data from Avantis Tally app is ignored in this simple simulator.
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Avantis test simulator listening on ${HOST}:${PORT}`);
  console.log(`Using hard-coded INPUT 1 on MIDI channel ${BASE_MIDI_CHANNEL}`);
  showHelp();
  printState();
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true
});

rl.on('line', (line) => {
  handleCommand(line);
});

rl.on('close', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nShutting down simulator...');
  process.exit(0);
});