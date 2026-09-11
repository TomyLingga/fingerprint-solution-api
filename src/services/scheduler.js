'use strict';

const config = require('../config');
const attendance = require('./attendance');
const { formatDateTime } = require('../utils/datetime');

/**
 * Keeps the attendance cache warm in the background.
 *
 * A full download from the terminal takes about a minute. Without a scheduler
 * that cost lands on whichever request happens to arrive after the cache goes
 * stale. Here the refresh happens on its own schedule instead.
 *
 * The next delay is measured from the end of the previous run, so a slow
 * terminal can never stack runs on top of each other. Should two triggers still
 * overlap, the service dedupes them into a single download.
 */

let timer = null;
let stopped = false;
let nextRunAt = null;
let lastRunAt = null;
let lastError = null;
let runCount = 0;

const schedule = (delayMs) => {
  if (stopped) return;

  nextRunAt = Date.now() + delayMs;
  timer = setTimeout(run, delayMs);

  // Never let a pending refresh hold the process open during shutdown.
  if (timer.unref) timer.unref();
};

const run = async () => {
  timer = null;
  // Cleared while the run is in progress so the status never advertises a
  // schedule time that has already passed.
  nextRunAt = null;
  if (stopped) return;

  try {
    const result = await attendance.syncStaleDevices();
    lastRunAt = Date.now();
    runCount += 1;

    if (result.skipped) {
      lastError = null;
      console.log('[scheduler] semua cache masih segar, sinkronisasi dilewati');
    } else {
      // One unreachable terminal must not be reported as a total failure, so
      // successes and failures are summarised side by side.
      const failed = result.devices.filter((device) => !device.ok);

      for (const device of result.devices.filter((d) => d.ok)) {
        console.log(`[scheduler] ${device.deviceId}: ${device.added} log baru, total ${device.total}`);
      }
      if (failed.length > 0) {
        // The attendance service already logged the reason per device, so a
        // single summary line here is enough to see the scale of the outage.
        const names = failed.map((device) => device.deviceId).join(', ');
        console.warn(`[scheduler] ${failed.length} dari ${result.devices.length} mesin gagal: ${names}`);
      }

      lastError = failed.length > 0 ? failed.map((device) => `${device.deviceId}: ${device.error}`).join('; ') : null;
    }
  } catch (err) {
    lastError = err.message;
    console.warn(`[scheduler] sinkronisasi gagal, dicoba lagi nanti: ${err.message}`);
  }

  schedule(config.sync.intervalMs);
};

const start = () => {
  if (!config.sync.enabled) {
    console.log('[scheduler] dimatikan lewat SYNC_ENABLED=false');
    return;
  }

  stopped = false;
  schedule(config.sync.initialDelayMs);
  console.log(`[scheduler] aktif, jeda ${config.sync.intervalMs / 1000} detik antar sinkronisasi`);
};

const stop = () => {
  stopped = true;
  nextRunAt = null;

  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
};

const getStatus = () => ({
  enabled: config.sync.enabled,
  intervalSeconds: config.sync.intervalMs / 1000,
  runCount,
  lastRunAt: lastRunAt ? formatDateTime(new Date(lastRunAt)) : null,
  nextRunAt: nextRunAt ? formatDateTime(new Date(nextRunAt)) : null,
  lastError,
});

module.exports = { start, stop, getStatus };
