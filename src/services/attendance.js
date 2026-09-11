'use strict';

const config = require('../config');
const devices = require('../devices');
const deviceSource = require('../zk/client');
const excelSource = require('../sources/excel');
const store = require('../store/snapshotStore');
const { formatDate, formatTime, formatDateTime, diffMinutes } = require('../utils/datetime');
const { badGateway } = require('../utils/errors');

const source = config.source === 'excel' ? excelSource : deviceSource;

/**
 * A terminal cannot filter by date on its own: its whole log buffer has to be
 * downloaded and filtered here. Each device therefore keeps its own cached
 * snapshot, and queries run against the union of them.
 *
 * Devices are independent throughout. One machine being unplugged never stops
 * the others from answering, and a sync for one never blocks a sync for another.
 */
const snapshots = new Map(); // deviceId -> { records, users, fetchedAt, warning }
const inFlight = new Map(); // deviceId -> Promise
const lastError = new Map(); // deviceId -> string

// Bumped whenever any device snapshot changes, so the merged view is rebuilt
// only when it actually went out of date.
let revision = 0;
let mergedCache = { revision: -1, records: [], users: [] };

const bootstrap = () => {
  for (const device of devices.list()) {
    const loaded = store.load(device);
    if (!loaded) continue;

    snapshots.set(device.id, loaded);
    console.log(`[attendance] cache ${device.id} dimuat: ${loaded.records.length} log, ${loaded.users.length} karyawan`);
  }
  revision += 1;
};

bootstrap();

const isFresh = (deviceId) => {
  const snapshot = snapshots.get(deviceId);
  return Boolean(snapshot) && Date.now() - snapshot.fetchedAt < config.cache.ttlMs;
};

/**
 * The union of every device snapshot, sorted by time.
 * Records are shared by reference with the per-device snapshots, so this costs
 * one array rather than a second copy of every punch.
 */
const getMerged = () => {
  if (mergedCache.revision === revision) return mergedCache;

  // Appended one by one on purpose: push(...array) passes every element as a
  // function argument and blows the call stack past about 65k records, which a
  // single terminal reaches easily.
  const records = [];
  for (const snapshot of snapshots.values()) {
    for (const record of snapshot.records) records.push(record);
  }
  records.sort((a, b) => a.time - b.time);

  // An employee enrolled on several terminals is still one person.
  const users = new Map();
  for (const snapshot of snapshots.values()) {
    for (const user of snapshot.users) {
      const key = String(user.userId);
      const current = users.get(key);

      if (!current) {
        users.set(key, { ...user, deviceIds: [snapshot.deviceId] });
        continue;
      }
      if (!current.deviceIds.includes(snapshot.deviceId)) current.deviceIds.push(snapshot.deviceId);
      if (!current.name && user.name) current.name = user.name;
    }
  }

  mergedCache = {
    revision,
    records,
    users: [...users.values()].sort((a, b) => a.userId.localeCompare(b.userId, 'en', { numeric: true })),
  };

  return mergedCache;
};

/**
 * Pulls one device, folds the result into what is already cached, and persists.
 * A truncated download therefore still contributes everything it managed to
 * read instead of being thrown away.
 */
const syncDevice = async (device) => {
  let attendances;
  let users = [];
  const previous = snapshots.get(device.id);

  try {
    attendances = await source.fetchAttendances(device);
  } catch (err) {
    lastError.set(device.id, err.message);

    if (previous) {
      // Keep serving the stale snapshot, but annotate it and still fail the
      // call. Returning normally here would report an unreachable terminal as a
      // successful sync and leave scheduler.lastError null, hiding an outage.
      // fetchedAt is deliberately left untouched so the device stays stale and
      // the next scheduled run retries it.
      console.warn(`[attendance] ${device.id} sync gagal, cache lama tetap dipakai: ${err.message}`);
      snapshots.set(device.id, { ...previous, warning: `Sinkronisasi terakhir gagal: ${err.message}` });
      // No revision bump: the record set did not change, only the warning text,
      // so the merged view does not need re-sorting.
    }

    throw new Error(`${device.name} (${device.ip || config.source}): ${err.message}`);
  }

  try {
    users = await source.fetchUsers(device);
  } catch (err) {
    // Names are decoration; a failure here must not sink the whole sync.
    console.warn(`[attendance] ${device.id} daftar karyawan tidak tersedia: ${err.message}`);
    users = previous ? previous.users : [];
  }

  const nameByUserId = new Map(users.filter((user) => user.name).map((user) => [String(user.userId), user.name]));

  const incoming = attendances.records.map((record) => ({
    ...record,
    name: record.name || nameByUserId.get(String(record.userId)) || '',
  }));

  const { records, added } = store.merge(previous ? previous.records : [], incoming);

  const snapshot = {
    deviceId: device.id,
    records,
    users: users.length > 0 ? users : previous ? previous.users : [],
    warning: attendances.warning,
    fetchedAt: Date.now(),
    source: config.source,
    lastAdded: added,
  };

  snapshots.set(device.id, snapshot);
  lastError.delete(device.id);
  revision += 1;

  store.save(device, snapshot);
  console.log(`[attendance] ${device.id} sync selesai: ${added} log baru, total ${records.length}`);

  return snapshot;
};

/** Starts a sync for one device, or joins the one already running for it. */
const startSync = (device) => {
  if (!inFlight.has(device.id)) {
    const run = syncDevice(device).finally(() => inFlight.delete(device.id));
    inFlight.set(device.id, run);
  }
  return inFlight.get(device.id);
};

const describeFailures = (results, targets) =>
  results
    .map((result, index) => (result.status === 'rejected' ? `${targets[index].id}: ${result.reason.message}` : null))
    .filter(Boolean);

/**
 * Makes sure there is data to answer from, then returns the merged view.
 *
 * Stale-while-revalidate, decided across all devices together: as long as any
 * one terminal has something cached, the request is answered right away and
 * every refresh runs in the background. Only a completely empty cache makes a
 * request wait.
 *
 * That means a newly added machine is missing from the first few responses
 * rather than holding them up. The gap is never silent: `meta.complete` is
 * false and the device shows a null `lastSyncAt` until its first sync lands.
 * Use `?refresh=true` to wait for every terminal instead.
 */
const ensureData = async ({ force = false } = {}) => {
  const targets = devices.enabled();

  if (targets.length === 0) {
    throw badGateway('Tidak ada perangkat aktif', 'Aktifkan minimal satu perangkat di devices.json');
  }

  const pending = force ? targets : targets.filter((device) => !isFresh(device.id));

  if (force || snapshots.size === 0) {
    const results = await Promise.allSettled(pending.map((device) => startSync(device)));

    if (snapshots.size === 0) {
      throw badGateway('Gagal membaca log absensi dari semua perangkat', describeFailures(results, pending).join('; '));
    }
    return getMerged();
  }

  for (const device of pending) {
    startSync(device).catch((err) => console.warn(`[attendance] refresh latar ${device.id} gagal: ${err.message}`));
  }

  return getMerged();
};

/** Used by the scheduler: syncs only the devices whose cache has gone stale. */
const syncStaleDevices = async () => {
  const targets = devices.enabled().filter((device) => !isFresh(device.id));

  if (targets.length === 0) return { skipped: true, devices: [] };

  const results = await Promise.allSettled(targets.map((device) => startSync(device)));

  return {
    skipped: false,
    devices: results.map((result, index) => ({
      deviceId: targets[index].id,
      ok: result.status === 'fulfilled',
      added: result.status === 'fulfilled' ? result.value.lastAdded || 0 : null,
      total: result.status === 'fulfilled' ? result.value.records.length : null,
      error: result.status === 'rejected' ? result.reason.message : null,
    })),
  };
};

const deviceStatus = (device) => {
  const snapshot = snapshots.get(device.id);

  return {
    deviceId: device.id,
    name: device.name,
    ip: device.ip,
    port: device.port,
    enabled: device.enabled,
    // False until this terminal's first successful download lands.
    synced: Boolean(snapshot),
    totalRecords: snapshot ? snapshot.records.length : 0,
    totalUsers: snapshot ? snapshot.users.length : 0,
    lastSyncAt: snapshot ? formatDateTime(new Date(snapshot.fetchedAt)) : null,
    cacheFresh: isFresh(device.id),
    syncing: inFlight.has(device.id),
    warning: snapshot ? snapshot.warning : null,
    lastError: lastError.get(device.id) || null,
  };
};

const getStatus = () => {
  const merged = getMerged();
  const list = devices.list();
  const statuses = list.map(deviceStatus);
  const active = statuses.filter((device) => device.enabled);

  return {
    source: config.source,
    totalRecords: merged.records.length,
    totalUsers: merged.users.length,
    totalDevices: list.length,
    devicesOnline: active.filter((device) => device.synced && !device.lastError).length,
    // True only when every enabled terminal has contributed at least one sync.
    complete: active.length > 0 && active.every((device) => device.synced),
    pending: active.filter((device) => !device.synced).map((device) => device.deviceId),
    syncing: inFlight.size > 0,
    devices: statuses,
  };
};

const serialiseLog = (record) => ({
  uid: record.uid,
  userId: record.userId,
  name: record.name || null,
  department: record.department || null,
  timestamp: formatDateTime(record.time),
  date: formatDate(record.time),
  time: formatTime(record.time),
  verifyMode: record.verifyMode,
  verify: record.verify,
  state: record.state,
  status: record.status,
  deviceId: record.deviceId,
  deviceName: record.deviceName || null,
  deviceIp: record.deviceIp,
});

const matches = (record, filter) => {
  if (record.time < filter.start || record.time > filter.end) return false;
  if (filter.deviceIds && !filter.deviceIds.has(record.deviceId)) return false;
  if (filter.userIds && !filter.userIds.has(String(record.userId))) return false;
  if (filter.search && !String(record.name || '').toLowerCase().includes(filter.search)) return false;
  return true;
};

const queryLogs = async (filter) => {
  const merged = await ensureData({ force: filter.refresh });
  const matched = merged.records.filter((record) => matches(record, filter));

  if (filter.order === 'desc') matched.reverse();

  const offset = (filter.page - 1) * filter.limit;
  const page = matched.slice(offset, offset + filter.limit);

  return { logs: page.map(serialiseLog), total: matched.length };
};

/**
 * Collapses raw punches into one row per employee per day: first punch of the
 * day as check-in, last punch as check-out.
 *
 * Grouping ignores which terminal saw the punch, so someone who clocks in at
 * one gate and out at another still gets a single correct row. The devices
 * involved are listed alongside.
 */
const queryDaily = async (filter) => {
  const merged = await ensureData({ force: filter.refresh });
  const groups = new Map();

  for (const record of merged.records) {
    if (!matches(record, filter)) continue;

    const date = formatDate(record.time);
    const key = `${record.userId}|${date}`;
    const group = groups.get(key);

    if (!group) {
      groups.set(key, {
        userId: record.userId,
        name: record.name || null,
        department: record.department || null,
        date,
        first: record.time,
        last: record.time,
        punches: [record.time],
        deviceIds: [record.deviceId],
      });
      continue;
    }

    if (record.time < group.first) group.first = record.time;
    if (record.time > group.last) group.last = record.time;
    group.punches.push(record.time);
    if (!group.deviceIds.includes(record.deviceId)) group.deviceIds.push(record.deviceId);
  }

  let rows = [...groups.values()].map((group) => {
    const punches = group.punches.slice().sort((a, b) => a - b);

    return {
      userId: group.userId,
      name: group.name,
      department: group.department,
      date: group.date,
      checkIn: formatTime(group.first),
      checkOut: punches.length > 1 ? formatTime(group.last) : null,
      totalScan: punches.length,
      durationMinutes: punches.length > 1 ? diffMinutes(group.first, group.last) : null,
      punches: punches.map(formatTime),
      deviceIds: group.deviceIds,
    };
  });

  rows.sort((a, b) =>
    a.date === b.date ? a.userId.localeCompare(b.userId, 'en', { numeric: true }) : a.date.localeCompare(b.date)
  );
  if (filter.order === 'desc') rows.reverse();

  const total = rows.length;
  const offset = (filter.page - 1) * filter.limit;
  rows = rows.slice(offset, offset + filter.limit);

  return { rows, total };
};

const listEmployees = async ({ refresh = false, deviceIds = null } = {}) => {
  const merged = await ensureData({ force: refresh });
  const users = deviceIds
    ? merged.users.filter((user) => user.deviceIds.some((id) => deviceIds.has(id)))
    : merged.users;

  return { users };
};

/** Connects to every enabled device and reports what it says about itself. */
const probeDevices = async () => {
  const targets = devices.enabled();
  const results = await Promise.allSettled(targets.map((device) => source.fetchInfo(device)));

  return results.map((result, index) =>
    result.status === 'fulfilled'
      ? { ...result.value, reachable: true, error: null }
      : {
          deviceId: targets[index].id,
          name: targets[index].name,
          ip: targets[index].ip,
          port: targets[index].port,
          reachable: false,
          error: result.reason.message,
        }
  );
};

const refresh = async () => {
  await ensureData({ force: true });
  const status = getStatus();

  return {
    source: status.source,
    totalRecords: status.totalRecords,
    totalUsers: status.totalUsers,
    devices: status.devices.map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      totalRecords: device.totalRecords,
      lastSyncAt: device.lastSyncAt,
      warning: device.warning,
      error: device.lastError,
    })),
  };
};

/** Drops in-memory snapshots for devices that are no longer configured. */
const forgetUnknownDevices = () => {
  const known = new Set(devices.list().map((device) => device.id));
  let removed = 0;

  for (const deviceId of [...snapshots.keys()]) {
    if (known.has(deviceId)) continue;
    snapshots.delete(deviceId);
    lastError.delete(deviceId);
    removed += 1;
  }

  // Newly added devices may already have a cache file waiting on disk.
  for (const device of devices.list()) {
    if (snapshots.has(device.id)) continue;
    const loaded = store.load(device);
    if (loaded) snapshots.set(device.id, loaded);
  }

  revision += 1;
  return removed;
};

module.exports = {
  queryLogs,
  queryDaily,
  listEmployees,
  probeDevices,
  refresh,
  ensureData,
  syncStaleDevices,
  getStatus,
  forgetUnknownDevices,
};
