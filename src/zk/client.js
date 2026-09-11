'use strict';

const ZKLib = require('node-zklib');
const { REQUEST_DATA } = require('node-zklib/constants');
const { decodeUserData72 } = require('node-zklib/utils');

const { readAll } = require('./reader');
const { decodeAttendanceBuffer, verifyLabel, stateLabel } = require('./decode');

/**
 * A ZK terminal accepts a single control session at a time, so calls to the
 * same machine are queued. The queue is per device: three terminals are three
 * independent TCP conversations and can be talked to at the same time.
 */
const queues = new Map();

const serialise = (deviceId, task) => {
  const previous = queues.get(deviceId) || Promise.resolve();
  const run = previous.then(task, task);

  queues.set(
    deviceId,
    run.then(
      () => undefined,
      () => undefined
    )
  );

  return run;
};

/**
 * node-zklib rejects with ZKError, which is not an Error subclass and carries
 * no `message`. Left as is, every failure downstream reads as "undefined", so
 * everything thrown from this module is normalised into a real Error here.
 */
const toError = (raw) => {
  if (raw instanceof Error) return raw;

  if (raw && typeof raw.toast === 'function') {
    try {
      const code = raw.err && raw.err.code ? ` (${raw.err.code})` : '';
      return new Error(`${raw.toast() || 'koneksi ke mesin gagal'}${code}`);
    } catch (err) {
      return new Error('koneksi ke mesin gagal');
    }
  }

  return new Error(String(raw && raw.message ? raw.message : raw));
};

const withDevice = (device, task) =>
  serialise(device.id, async () => {
    const zk = new ZKLib(device.ip, device.port, device.timeout, device.inport);
    let connected = false;

    try {
      await zk.createSocket();
      connected = true;

      if (zk.connectionType !== 'tcp') {
        throw new Error(`Hanya koneksi TCP yang didukung; ${device.ip} menjawab lewat UDP`);
      }

      return await task(zk);
    } catch (raw) {
      throw toError(raw);
    } finally {
      // Skipped when the socket never came up, otherwise the exit command sits
      // waiting for the full device timeout on a machine that is simply off.
      if (connected) {
        try {
          await zk.disconnect();
        } catch (err) {
          console.warn(`[zk] ${device.id} disconnect warning: ${toError(err).message}`);
        }
      }
    }
  });

const readerOptions = (device, onProgress) => ({
  chunkSize: device.chunkSize,
  timeoutMs: device.chunkTimeoutMs,
  retries: device.chunkRetries,
  onProgress,
});

const fetchAttendances = (device, { onProgress } = {}) =>
  withDevice(device, async (zk) => {
    await zk.freeData();
    const payload = await readAll(zk.zklibTcp, REQUEST_DATA.GET_ATTENDANCE_LOGS, readerOptions(device, onProgress));
    await zk.freeData();

    // The first four bytes of the payload carry the record area size.
    const { records, skipped } = decodeAttendanceBuffer(payload.data.subarray(4), device.ip);

    const notes = [];
    if (payload.warning) notes.push(payload.warning);
    if (skipped > 0) notes.push(`${skipped} slot kosong diabaikan`);

    return {
      records: records.map((record) => ({ ...record, deviceId: device.id, deviceName: device.name })),
      warning: notes.length > 0 ? notes.join('; ') : null,
    };
  });

const fetchUsers = (device) =>
  withDevice(device, async (zk) => {
    await zk.freeData();
    const payload = await readAll(zk.zklibTcp, REQUEST_DATA.GET_USERS, readerOptions(device));
    await zk.freeData();

    const USER_PACKET_SIZE = 72;
    let cursor = payload.data.subarray(4);
    const users = [];

    while (cursor.length >= USER_PACKET_SIZE) {
      const user = decodeUserData72(cursor.subarray(0, USER_PACKET_SIZE));
      cursor = cursor.subarray(USER_PACKET_SIZE);

      users.push({
        uid: user.uid,
        userId: String(user.userId || user.uid).trim(),
        name: (user.name || '').trim(),
        role: user.role,
        cardNo: user.cardno ? String(user.cardno) : '',
        deviceId: device.id,
      });
    }

    return users;
  });

const fetchInfo = (device) =>
  withDevice(device, async (zk) => {
    const info = await zk.getInfo();
    return { deviceId: device.id, name: device.name, ip: device.ip, port: device.port, ...info };
  });

module.exports = {
  fetchAttendances,
  fetchUsers,
  fetchInfo,
  verifyLabel,
  stateLabel,
};
