'use strict';

const config = require('../config');
const devices = require('../devices');
const { parseBoundary, startOfDay, endOfDay } = require('./datetime');
const { badRequest } = require('./errors');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'y', 'on']);

const asBool = (value) => TRUE_VALUES.has(String(value || '').toLowerCase());

const asPositiveInt = (value, fallback, max, field) => {
  if (value === undefined || value === '') return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw badRequest(`Parameter "${field}" harus bilangan bulat >= 1`);
  }
  if (max && parsed > max) {
    throw badRequest(`Parameter "${field}" maksimal ${max}`);
  }
  return parsed;
};

/** Splits a comma separated query value into a Set, or null when absent. */
const parseList = (raw, field) => {
  if (raw === undefined || raw === '') return null;

  const values = String(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw badRequest(`Parameter "${field}" kosong`);
  }
  return new Set(values);
};

/**
 * Device ids are validated against the registry so a typo fails loudly instead
 * of silently returning an empty result set.
 */
const parseDeviceIds = (raw) => {
  const requested = parseList(raw, 'deviceId');
  if (!requested) return null;

  const known = new Set(devices.list().map((device) => device.id));
  const unknown = [...requested].filter((id) => !known.has(id));

  if (unknown.length > 0) {
    throw badRequest(
      `Perangkat tidak dikenal: ${unknown.join(', ')}`,
      `Perangkat yang tersedia: ${[...known].join(', ')}`
    );
  }
  return requested;
};

/**
 * Builds the range + paging filter shared by the log and daily endpoints.
 * With no start/end supplied the range defaults to today.
 */
const parseFilter = (query) => {
  const today = new Date();

  const start = query.start
    ? parseBoundary(query.start, 'start')
    : query.end
      ? startOfDay(parseBoundary(query.end, 'start') || today)
      : startOfDay(today);

  if (!start) {
    throw badRequest('Parameter "start" tidak valid. Format: YYYY-MM-DD atau YYYY-MM-DD HH:mm:ss');
  }

  const end = query.end ? parseBoundary(query.end, 'end') : endOfDay(query.start ? start : today);

  if (!end) {
    throw badRequest('Parameter "end" tidak valid. Format: YYYY-MM-DD atau YYYY-MM-DD HH:mm:ss');
  }

  if (end < start) {
    throw badRequest('Parameter "end" tidak boleh lebih awal dari "start"');
  }

  const userIds = parseList(query.userId || query.user_id || query.pin, 'userId');
  const deviceIds = parseDeviceIds(query.deviceId || query.device);

  const order = String(query.order || 'asc').toLowerCase();
  if (!['asc', 'desc'].includes(order)) {
    throw badRequest('Parameter "order" hanya menerima "asc" atau "desc"');
  }

  return {
    start,
    end,
    userIds,
    deviceIds,
    search: query.name ? String(query.name).toLowerCase().trim() : null,
    order,
    page: asPositiveInt(query.page, 1, null, 'page'),
    limit: asPositiveInt(query.limit, config.pagination.defaultLimit, config.pagination.maxLimit, 'limit'),
    refresh: asBool(query.refresh),
  };
};

module.exports = { parseFilter, parseDeviceIds, asBool };
