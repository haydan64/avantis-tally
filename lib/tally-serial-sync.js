import { TextDecoder } from 'node:util';

const BEACON_PREFIX = 'AVANTIS_TALLY_ESP32 ';

async function loadSerialPortModule() {
  try {
    const mod = await import('serialport');
    if (mod?.SerialPort) {
      return mod.SerialPort;
    }
  } catch {
    // fall through
  }

  throw new Error('The `serialport` package is required. Install dependencies and restart the app.');
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

function compareVersionPrefix(fw, expectedPrefix) {
  const actual = String(fw || '').trim();
  const prefix = String(expectedPrefix || '').trim();
  if (!prefix) {
    return true;
  }

  return actual.startsWith(prefix);
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    port.open((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closePort(port) {
  return new Promise((resolve) => {
    if (!port?.isOpen) {
      resolve();
      return;
    }

    port.close(() => resolve());
  });
}

function writeLine(port, line) {
  return new Promise((resolve, reject) => {
    port.write(`${line}\n`, (error) => {
      console.log('Serial write:', line);
      if (error) {
        reject(error);
        return;
      }

      port.drain((drainError) => {
        if (drainError) {
          reject(drainError);
          return;
        }

        resolve();
      });
    });
  });
}

function createBaseResult(path) {
  return {
    port: path,
    beacon: false,
    supported: false,
    mac: '',
    model: '',
    fw: '',
    reason: ''
  };
}

function parseBeaconLine(line) {
  if (!line.startsWith(BEACON_PREFIX)) {
    return null;
  }

  let json;
  try {
    json = JSON.parse(line.slice(BEACON_PREFIX.length));
  } catch {
    return { invalid: true };
  }

  return {
    invalid: false,
    mac: normalizeMac(json?.mac),
    model: String(json?.model || ''),
    fw: String(json?.fw || '')
  };
}

async function readLinesUntil({ port, timeoutMs, onLine }) {
  const decoder = new TextDecoder();
  let buffer = '';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      port.off('data', onData);
      port.off('error', onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onData = async (chunk) => {
      try {
        buffer += decoder.decode(chunk, { stream: true });

        while (true) {
          const newlineIndex = buffer.indexOf('\n');
          if (newlineIndex < 0) {
            break;
          }

          const line = buffer.slice(0, newlineIndex).replace(/\r/g, '').trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line) {
            continue;
          }

          const done = await onLine(line);
          if (done) {
            cleanup();
            resolve(true);
            return;
          }
        }
      } catch (error) {
        onError(error);
      }
    };

    port.on('data', onData);
    port.on('error', onError);
  });
}

export async function scanTallyBeacons({
  timeoutMs = 5000,
  baudRate = 115200,
  supportedModel = 'tally',
  supportedFirmwarePrefix = '1.'
}) {
  const SerialPort = await loadSerialPortModule();
  const ports = await SerialPort.list();
  const paths = ports
    .map((port) => String(port.path || '').trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const results = [];

  for (const path of paths) {
    const result = createBaseResult(path);
    const port = new SerialPort({
      path,
      baudRate: Math.max(9600, Number(baudRate) || 115200),
      autoOpen: false
    });

    try {
      await openPort(port);

      const found = await readLinesUntil({
        port,
        timeoutMs: Math.max(250, Number(timeoutMs) || 2000),
        onLine: async (line) => {
          const beacon = parseBeaconLine(line);
          if (!beacon) {
            return false;
          }

          result.beacon = true;
          if (beacon.invalid) {
            result.reason = 'invalid beacon json';
            return true;
          }

          result.mac = beacon.mac;
          result.model = beacon.model;
          result.fw = beacon.fw;

          if (beacon.model !== supportedModel) {
            result.reason = `unsupported model ${beacon.model || '(empty)'}`;
            return true;
          }

          if (!compareVersionPrefix(beacon.fw, supportedFirmwarePrefix)) {
            result.reason = `unsupported fw ${beacon.fw || '(empty)'}`;
            return true;
          }

          if (!beacon.mac) {
            result.reason = 'beacon missing valid mac';
            return true;
          }

          result.supported = true;
          result.reason = 'ready';
          return true;
        }
      });

      if (!found && !result.reason) {
        result.reason = 'no beacon within timeout';
      }
    } catch (error) {
      result.reason = error?.message ? String(error.message) : 'port error';
    } finally {
      await closePort(port);
    }

    results.push(result);
  }

  return results;
}

export async function provisionTallyOverSerial({
  portPath,
  expectedMac,
  provisionPayload,
  timeoutMs = 2500,
  baudRate = 115200,
  supportedModel = 'tally',
  supportedFirmwarePrefix = '1.'
}) {
  const SerialPort = await loadSerialPortModule();

  const result = {
    port: String(portPath || ''),
    mac: normalizeMac(expectedMac),
    model: '',
    fw: '',
    acknowledged: false,
    reason: ''
  };

  if (!result.port) {
    throw new Error('Serial port is required.');
  }

  if (!result.mac) {
    throw new Error('A valid MAC address is required.');
  }

  const port = new SerialPort({
    path: result.port,
    baudRate: Math.max(9600, Number(baudRate) || 115200),
    autoOpen: false
  });

  let provisionSent = false;

  try {
    await openPort(port);

    const completed = await readLinesUntil({
      port,
      timeoutMs: Math.max(500, Number(timeoutMs) || 2500),
      onLine: async (line) => {
        const beacon = parseBeaconLine(line);
        if (beacon) {
          if (beacon.invalid) {
            result.reason = 'invalid beacon json';
            return true;
          }

          result.model = beacon.model;
          result.fw = beacon.fw;

          if (beacon.model !== supportedModel) {
            result.reason = `unsupported model ${beacon.model || '(empty)'}`;
            return true;
          }

          if (!compareVersionPrefix(beacon.fw, supportedFirmwarePrefix)) {
            result.reason = `unsupported fw ${beacon.fw || '(empty)'}`;
            return true;
          }

          if (beacon.mac !== result.mac) {
            return false;
          }

          if (!provisionSent) {
            await writeLine(port, JSON.stringify(provisionPayload));
            provisionSent = true;
          }

          return false;
        }

        if (/^OKAY$/i.test(line.trim())) {
          if (!provisionSent) {
            return false;
          }

          result.acknowledged = true;
          result.reason = 'synced';
          return true;
        }

        if (/^ERROR\b/i.test(line.trim())) {
          result.reason = line;
          return true;
        }

        return false;
      }
    });

    if (!completed) {
      result.reason = provisionSent ? 'no OKAY response within timeout' : 'no matching beacon within timeout';
    }
  } catch (error) {
    result.reason = error?.message ? String(error.message) : 'port error';
  } finally {
    await closePort(port);
  }

  return result;
}

export function normalizeTallyMac(value) {
  return normalizeMac(value);
}