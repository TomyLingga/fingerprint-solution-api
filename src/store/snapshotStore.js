'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../config');
const { formatDateTime, parseBoundary } = require('../utils/datetime');

/**
 * Disk-backed accumulator for attendance records, one file per device.
 *
 * A full download from a busy terminal takes minutes and can still come back
 * truncated. Persisting the merged result means restarts are instant and every
 * partial sync adds to what is already known instead of replacing it.
 *
 * Keeping devices in separate files means a sync for one terminal never
 * rewrites the others, and a corrupt file costs only that one device.
 *
 * Timestamps are stored as local wall-clock strings, matching how the device
 * reports them, so reloading never shifts a punch across a timezone boundary.
 */

const VERSION = 2;

const deviceDir = () => path.join(config.cache.dir, 'devices');

const filePath = (deviceId) => path.join(deviceDir(), `${deviceId}.json`);

// A punch is uniquely identified by which machine saw it, who, when, and which
// punch type. The same person scanning on two terminals is two real events.
const recordKey = (record) =>
  `${record.deviceId}|${record.userId}|${record.time.getTime()}|${record.state === null ? '' : record.state}`;

const toRow = (record) => ({
  u: record.uid,
  i: record.userId,
  t: formatDateTime(record.time),
  v: record.verifyMode,
  vl: record.verify,
  s: record.state,
  sl: record.status,
  n: record.name || '',
  d: record.department || '',
  ip: record.deviceIp,
});

const fromRow = (row, device) => {
  const time = parseBoundary(row.t, 'start');
  if (!time) return null;

  return {
    uid: row.u === undefined ? null : row.u,
    userId: String(row.i),
    time,
    verifyMode: row.v === undefined ? null : row.v,
    verify: row.vl || null,
    state: row.s === undefined ? null : row.s,
    status: row.sl || null,
    name: row.n || '',
    department: row.d || '',
    deviceIp: row.ip || null,
    deviceId: device.id,
    deviceName: device.name,
  };
};

const load = (device) => {
  if (!config.cache.persist) return null;

  const file = filePath(device.id);
  if (!fs.existsSync(file)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.version !== VERSION || parsed.source !== config.source) return null;

    const records = (parsed.records || []).map((row) => fromRow(row, device)).filter(Boolean);
    records.sort((a, b) => a.time - b.time);

    return {
      deviceId: device.id,
      records,
      users: parsed.users || [],
      warning: parsed.warning || null,
      fetchedAt: parsed.fetchedAt || 0,
      source: parsed.source,
    };
  } catch (err) {
    console.warn(`[store] cache ${device.id} tidak terbaca, mulai dari kosong: ${err.message}`);
    return null;
  }
};

const save = (device, snapshot) => {
  if (!config.cache.persist) return;

  const payload = {
    version: VERSION,
    source: snapshot.source,
    deviceId: device.id,
    deviceName: device.name,
    fetchedAt: snapshot.fetchedAt,
    updatedAt: formatDateTime(new Date()),
    warning: snapshot.warning,
    users: snapshot.users,
    records: snapshot.records.map(toRow),
  };

  const file = filePath(device.id);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write then rename so a crash mid-write cannot leave a truncated cache.
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    fs.renameSync(temporary, file);
  } catch (err) {
    console.warn(`[store] gagal menyimpan cache ${device.id}: ${err.message}`);
  }
};

/**
 * Folds freshly downloaded records into the known set for one device.
 * Returns the merged list plus how many records were new.
 */
const merge = (existing, incoming) => {
  const byKey = new Map(existing.map((record) => [recordKey(record), record]));
  let added = 0;

  for (const record of incoming) {
    const key = recordKey(record);
    if (byKey.has(key)) {
      // Keep whichever copy carries a name, the device log itself has none.
      const current = byKey.get(key);
      if (!current.name && record.name) current.name = record.name;
      continue;
    }
    byKey.set(key, record);
    added += 1;
  }

  const records = [...byKey.values()].sort((a, b) => a.time - b.time);
  return { records, added };
};

module.exports = { load, save, merge, VERSION };
