'use strict';

const path = require('path');
require('dotenv').config();

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() !== 'false';
};

const resolveFromRoot = (value) =>
  path.isAbsolute(value) ? value : path.resolve(__dirname, '..', value);

const source = String(process.env.DATA_SOURCE || 'device').toLowerCase();

if (!['device', 'excel'].includes(source)) {
  throw new Error(`DATA_SOURCE must be "device" or "excel", got "${source}"`);
}

module.exports = {
  port: toInt(process.env.PORT, 3000),
  source,

  // Where the list of terminals lives. Each entry may override any of the
  // defaults below; see src/devices.js.
  devicesFile: resolveFromRoot(process.env.DEVICES_FILE || 'devices.json'),

  // Used for every device that does not state its own value, and as the single
  // device definition when devices.json is absent.
  deviceDefaults: {
    ip: process.env.DEVICE_IP || '192.168.1.210',
    port: toInt(process.env.DEVICE_PORT, 4370),
    timeout: toInt(process.env.DEVICE_TIMEOUT, 10000),
    inport: toInt(process.env.DEVICE_INPORT, 5200),
    // Bulk download tuning. One chunk is requested at a time; the timeout is
    // how long to wait for a single chunk before retrying it.
    chunkTimeoutMs: toInt(process.env.DEVICE_CHUNK_TIMEOUT, 20000),
    chunkSize: toInt(process.env.DEVICE_CHUNK_SIZE, 65472),
    chunkRetries: toInt(process.env.DEVICE_CHUNK_RETRIES, 2),
  },

  excel: {
    file: resolveFromRoot(process.env.EXCEL_FILE || 'Sample Absensi.xls'),
  },

  cache: {
    ttlMs: toInt(process.env.CACHE_TTL_SECONDS, 300) * 1000,
    // One file per device, so a sync for one terminal never rewrites the
    // others and a corrupt file only costs that single device.
    dir: resolveFromRoot(process.env.CACHE_DIR || 'data'),
    persist: toBool(process.env.CACHE_PERSIST, true),
  },

  pagination: {
    defaultLimit: toInt(process.env.DEFAULT_PAGE_SIZE, 1000),
    maxLimit: toInt(process.env.MAX_PAGE_SIZE, 10000),
  },

  sync: {
    enabled: toBool(process.env.SYNC_ENABLED, true),
    // Measured from the end of the previous run, so a slow download never
    // stacks up behind itself.
    intervalMs: toInt(process.env.SYNC_INTERVAL_SECONDS, 300) * 1000,
    initialDelayMs: toInt(process.env.SYNC_INITIAL_DELAY_SECONDS, 2) * 1000,
  },
};
