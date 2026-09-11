'use strict';

const fs = require('fs');

const config = require('./config');

/**
 * Device registry.
 *
 * Terminals are listed in devices.json, so a machine can be added, moved to a
 * new address, or taken out of rotation without touching code. When that file
 * is absent the single DEVICE_IP / DEVICE_PORT pair from .env is used instead,
 * which keeps a one-machine setup working with no extra configuration.
 */

const IP_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const isValidIp = (value) => {
  const match = IP_PATTERN.exec(String(value).trim());
  return Boolean(match) && match.slice(1).every((part) => Number(part) <= 255);
};

/** The Excel source behaves as a single pseudo device so the rest of the code stays uniform. */
const excelDevice = () => [
  {
    id: 'excel',
    name: 'Berkas export Excel',
    ip: null,
    port: null,
    timeout: null,
    inport: null,
    chunkTimeoutMs: null,
    chunkSize: null,
    chunkRetries: null,
    enabled: true,
  },
];

const fromEnv = () => {
  const defaults = config.deviceDefaults;
  return [
    {
      id: slugify(defaults.ip) || 'device-1',
      name: `Mesin ${defaults.ip}`,
      ip: defaults.ip,
      port: defaults.port,
      timeout: defaults.timeout,
      inport: defaults.inport,
      chunkTimeoutMs: defaults.chunkTimeoutMs,
      chunkSize: defaults.chunkSize,
      chunkRetries: defaults.chunkRetries,
      enabled: true,
    },
  ];
};

/**
 * Fills in defaults and rejects entries that could not be talked to.
 * `index` only feeds the fallback inport, so two terminals never try to bind
 * the same local UDP port if a TCP connection ever falls back.
 */
const normalise = (entry, index) => {
  const defaults = config.deviceDefaults;

  if (!entry || typeof entry !== 'object') {
    throw new Error(`devices.json entry ${index + 1} bukan objek`);
  }
  if (!isValidIp(entry.ip)) {
    throw new Error(`devices.json entry ${index + 1} punya IP tidak valid: ${JSON.stringify(entry.ip)}`);
  }

  const name = String(entry.name || `Mesin ${entry.ip}`).trim();
  const id = slugify(entry.id || name || entry.ip);

  if (!id) {
    throw new Error(`devices.json entry ${index + 1} tidak bisa dibuatkan id`);
  }

  return {
    id,
    name,
    ip: String(entry.ip).trim(),
    port: Number(entry.port) || defaults.port,
    timeout: Number(entry.timeout) || defaults.timeout,
    inport: Number(entry.inport) || defaults.inport + index,
    chunkTimeoutMs: Number(entry.chunkTimeoutMs) || defaults.chunkTimeoutMs,
    chunkSize: Number(entry.chunkSize) || defaults.chunkSize,
    chunkRetries: entry.chunkRetries === undefined ? defaults.chunkRetries : Number(entry.chunkRetries),
    enabled: entry.enabled !== false,
  };
};

const readFile = () => {
  const raw = fs.readFileSync(config.devicesFile, 'utf8');
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed.devices;

  if (!Array.isArray(entries)) {
    throw new Error('devices.json harus berupa array, atau objek dengan field "devices"');
  }
  if (entries.length === 0) {
    throw new Error('devices.json tidak memuat satu perangkat pun');
  }

  const devices = entries.map(normalise);
  const seen = new Set();

  for (const device of devices) {
    if (seen.has(device.id)) {
      throw new Error(`devices.json memuat id ganda: "${device.id}"`);
    }
    seen.add(device.id);
  }

  return devices;
};

let devices = [];
let loadedFrom = null;

/**
 * Reads the registry from disk. A malformed file never takes the running
 * service down: the previous list stays in effect and the error is reported.
 */
const reload = () => {
  if (config.source === 'excel') {
    devices = excelDevice();
    loadedFrom = 'excel';
    return { devices, source: loadedFrom, error: null };
  }

  if (!fs.existsSync(config.devicesFile)) {
    devices = fromEnv();
    loadedFrom = 'env';
    return { devices, source: loadedFrom, error: null };
  }

  try {
    devices = readFile();
    loadedFrom = 'file';
    return { devices, source: loadedFrom, error: null };
  } catch (err) {
    if (devices.length === 0) {
      // Nothing usable was ever loaded, so fall back rather than start empty.
      devices = fromEnv();
      loadedFrom = 'env';
    }
    return { devices, source: loadedFrom, error: err.message };
  }
};

const list = () => devices;

const enabled = () => devices.filter((device) => device.enabled);

const byId = (id) => devices.find((device) => device.id === id) || null;

const describe = () => ({ loadedFrom, file: config.devicesFile, total: devices.length });

const initial = reload();
if (initial.error) {
  console.warn(`[devices] devices.json tidak terbaca, memakai ${initial.source}: ${initial.error}`);
}
console.log(
  `[devices] ${devices.length} perangkat dimuat dari ${loadedFrom}: ${devices.map((d) => d.id).join(', ')}`
);

module.exports = { reload, list, enabled, byId, describe, slugify };
