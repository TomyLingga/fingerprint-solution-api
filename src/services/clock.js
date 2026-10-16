'use strict';

const config = require('../config');
const devices = require('../devices');
const client = require('../zk/client');
const { formatDateTime, diffMinutes } = require('../utils/datetime');
const { badRequest, badGateway, notFound } = require('../utils/errors');

/**
 * Device clock administration.
 *
 * A ZK terminal stamps every punch with its own internal clock. If that clock
 * drifts, logs come back hours off and no amount of correcting the API process
 * timezone fixes it. These operations read and set the terminal clock so it can
 * be kept in step with real time.
 *
 * Device source only: the Excel pseudo-device has no clock to talk to.
 */

const ensureDeviceSource = () => {
  if (config.source !== 'device') {
    throw badRequest(
      'Penyetelan jam hanya tersedia saat DATA_SOURCE=device',
      `Sumber data aktif saat ini: ${config.source}`
    );
  }
};

const resolveDevice = (deviceId) => {
  ensureDeviceSource();

  const device = devices.byId(deviceId);
  if (!device) {
    const known = devices.list().map((entry) => entry.id);
    throw notFound(`Perangkat "${deviceId}" tidak ditemukan. Tersedia: ${known.join(', ')}`);
  }
  if (!device.enabled) {
    throw badRequest(`Perangkat "${deviceId}" nonaktif di devices.json`);
  }
  return device;
};

/** Reads the device clock and reports how far it drifts from the server clock. */
const readClock = async (deviceId) => {
  const device = resolveDevice(deviceId);

  let deviceTime;
  try {
    deviceTime = await client.readClock(device);
  } catch (err) {
    throw badGateway(`Gagal membaca jam ${device.name} (${device.ip})`, err.message);
  }

  const serverTime = new Date();

  return {
    deviceId: device.id,
    name: device.name,
    ip: device.ip,
    deviceTime: formatDateTime(deviceTime),
    serverTime: formatDateTime(serverTime),
    driftSeconds: Math.round((deviceTime.getTime() - serverTime.getTime()) / 1000),
    driftMinutes: diffMinutes(serverTime, deviceTime),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
};

/**
 * Sets the device clock. With a target Date the clock is set to exactly that
 * value; without one it is synced to the server's current time. Returns the
 * clock as read back from the machine afterwards.
 */
const setClock = async (deviceId, { target = null } = {}) => {
  const device = resolveDevice(deviceId);
  const requested = target || new Date();

  const before = await client.readClock(device).catch(() => null);

  let appliedTime;
  try {
    appliedTime = await client.writeClock(device, requested);
  } catch (err) {
    throw badGateway(`Gagal menyetel jam ${device.name} (${device.ip})`, err.message);
  }

  const serverTime = new Date();

  return {
    deviceId: device.id,
    name: device.name,
    ip: device.ip,
    mode: target ? 'manual' : 'sync-server',
    requestedTime: formatDateTime(requested),
    previousDeviceTime: before ? formatDateTime(before) : null,
    deviceTime: formatDateTime(appliedTime),
    serverTime: formatDateTime(serverTime),
    driftSeconds: Math.round((appliedTime.getTime() - serverTime.getTime()) / 1000),
  };
};

module.exports = { readClock, setClock };
