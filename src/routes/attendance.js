'use strict';

const express = require('express');

const devices = require('../devices');
const service = require('../services/attendance');
const { parseFilter, parseDeviceIds, asBool } = require('../utils/query');
const { formatDateTime } = require('../utils/datetime');

const router = express.Router();

// Wraps an async handler so rejected promises reach the error middleware.
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const buildMeta = (filter, total, count) => {
  const status = service.getStatus();

  return {
    start: formatDateTime(filter.start),
    end: formatDateTime(filter.end),
    userId: filter.userIds ? [...filter.userIds] : null,
    deviceId: filter.deviceIds ? [...filter.deviceIds] : null,
    order: filter.order,
    page: filter.page,
    limit: filter.limit,
    count,
    total,
    totalPages: Math.max(1, Math.ceil(total / filter.limit)),
    source: status.source,
    // False while any enabled terminal has not contributed a sync yet, so a
    // caller can tell a genuinely empty result from a partial one.
    complete: status.complete,
    pendingDevices: status.pending,
    devices: status.devices
      .filter((device) => device.enabled)
      .map((device) => ({
        deviceId: device.deviceId,
        synced: device.synced,
        lastSyncAt: device.lastSyncAt,
        warning: device.warning,
        error: device.lastError,
      })),
  };
};

// GET /api/v1/attendance
// Raw punch log within a date range, across every configured terminal.
router.get(
  '/attendance',
  handle(async (req, res) => {
    const filter = parseFilter(req.query);
    const { logs, total } = await service.queryLogs(filter);

    res.json({ code: 200, success: true, meta: buildMeta(filter, total, logs.length), data: logs });
  })
);

// GET /api/v1/attendance/daily
// One row per employee per day: first punch in, last punch out.
router.get(
  '/attendance/daily',
  handle(async (req, res) => {
    const filter = parseFilter(req.query);
    const { rows, total } = await service.queryDaily(filter);

    res.json({ code: 200, success: true, meta: buildMeta(filter, total, rows.length), data: rows });
  })
);

// GET /api/v1/employees
router.get(
  '/employees',
  handle(async (req, res) => {
    const deviceIds = parseDeviceIds(req.query.deviceId || req.query.device);
    const { users } = await service.listEmployees({ refresh: asBool(req.query.refresh), deviceIds });
    const status = service.getStatus();

    res.json({
      code: 200,
      success: true,
      meta: {
        total: users.length,
        deviceId: deviceIds ? [...deviceIds] : null,
        source: status.source,
        devices: status.devices.map((device) => ({ deviceId: device.deviceId, lastSyncAt: device.lastSyncAt })),
      },
      data: users,
    });
  })
);

// GET /api/v1/devices
// The configured terminals plus their cache and sync state. Reads from memory
// only, so it stays instant and never touches the network.
router.get(
  '/devices',
  handle(async (req, res) => {
    const status = service.getStatus();

    res.json({
      code: 200,
      success: true,
      meta: { ...devices.describe(), totalRecords: status.totalRecords, totalUsers: status.totalUsers },
      data: status.devices,
    });
  })
);

// GET /api/v1/devices/info
// Connects to every enabled terminal and reports what it says about itself.
// Unreachable machines come back with reachable false rather than failing.
router.get(
  '/devices/info',
  handle(async (req, res) => {
    const data = await service.probeDevices();

    res.json({
      code: 200,
      success: true,
      meta: { total: data.length, reachable: data.filter((device) => device.reachable).length },
      data,
    });
  })
);

// POST /api/v1/devices/reload
// Re-reads devices.json so a terminal can be added, re-addressed, or disabled
// without restarting the service. Only the local file is read; nothing about
// the device list can be set through the request itself.
router.post(
  '/devices/reload',
  handle(async (req, res) => {
    const result = devices.reload();
    const removed = service.forgetUnknownDevices();

    res.json({
      code: 200,
      success: true,
      data: {
        loadedFrom: result.source,
        file: result.error ? devices.describe().file : undefined,
        total: result.devices.length,
        removedFromCache: removed,
        devices: result.devices.map((device) => ({
          deviceId: device.id,
          name: device.name,
          ip: device.ip,
          port: device.port,
          enabled: device.enabled,
        })),
        error: result.error,
      },
    });
  })
);

// POST /api/v1/cache/refresh
// Forces a fresh download from every enabled terminal.
router.post(
  '/cache/refresh',
  handle(async (req, res) => {
    res.json({ code: 200, success: true, data: await service.refresh() });
  })
);

module.exports = router;
