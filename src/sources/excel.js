'use strict';

const fs = require('fs');
const XLSX = require('xlsx');

const config = require('../config');

/**
 * Offline source: reads an "Attendance Management" export and emits the same
 * record shape as the live device, so the API can be exercised without the
 * terminal on the network.
 */

// Header label -> internal field. Matching is case-insensitive and ignores
// spaces, so "Tgl/Waktu", "TGL / WAKTU" and "tglwaktu" all resolve.
const HEADER_MAP = {
  departemen: 'department',
  department: 'department',
  nama: 'name',
  name: 'name',
  noid: 'userId',
  userid: 'userId',
  tglwaktu: 'time',
  datetime: 'time',
  lokasiid: 'locationId',
  kodeverifikasi: 'verify',
  verifycode: 'verify',
  nokartu: 'cardNo',
};

const normaliseHeader = (value) =>
  String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s./_-]/g, '');

const DATETIME_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/;

const parseCellDate = (value) => {
  if (value instanceof Date) return value;

  const match = DATETIME_PATTERN.exec(String(value).trim());
  if (!match) return null;

  const [, day, month, year, hour, minute, second] = match;
  return new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second || 0)
  );
};

const buildColumnIndex = (headerRow) => {
  const index = {};
  headerRow.forEach((cell, position) => {
    const field = HEADER_MAP[normaliseHeader(cell)];
    if (field && index[field] === undefined) index[field] = position;
  });
  return index;
};

const readSheetRows = () => {
  if (!fs.existsSync(config.excel.file)) {
    throw new Error(`Excel file not found: ${config.excel.file}`);
  }

  const workbook = XLSX.readFile(config.excel.file);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
};

const fetchAttendances = async (device) => {
  const rows = readSheetRows();
  const headerPosition = rows.findIndex(
    (row) => Array.isArray(row) && row.some((cell) => normaliseHeader(cell) === 'tglwaktu')
  );

  if (headerPosition === -1) {
    throw new Error('Column "Tgl/Waktu" not found in the Excel export');
  }

  const columns = buildColumnIndex(rows[headerPosition]);
  const records = [];
  let skipped = 0;

  for (let i = headerPosition + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!Array.isArray(row) || row.length === 0) continue;

    const time = parseCellDate(row[columns.time]);
    if (!time || Number.isNaN(time.getTime())) {
      skipped += 1;
      continue;
    }

    const verify = columns.verify !== undefined ? String(row[columns.verify] || '').trim() : '';

    records.push({
      uid: null,
      userId: String(row[columns.userId] == null ? '' : row[columns.userId]).trim(),
      name: columns.name !== undefined ? String(row[columns.name] || '').trim() : '',
      department: columns.department !== undefined ? String(row[columns.department] || '').trim() : '',
      time,
      verifyMode: null,
      verify: verify || null,
      state: null,
      status: null,
      deviceIp: null,
      deviceId: device.id,
      deviceName: device.name,
    });
  }

  return {
    records,
    warning: skipped > 0 ? `${skipped} baris dilewati karena kolom Tgl/Waktu tidak terbaca` : null,
  };
};

const fetchUsers = async (device) => {
  const { records } = await fetchAttendances(device);
  const users = new Map();

  for (const record of records) {
    if (!record.userId || users.has(record.userId)) continue;
    users.set(record.userId, {
      uid: null,
      userId: record.userId,
      name: record.name,
      role: null,
      cardNo: '',
      deviceId: device.id,
    });
  }

  return [...users.values()].sort((a, b) => a.userId.localeCompare(b.userId, 'en', { numeric: true }));
};

const fetchInfo = async (device) => {
  const { records } = await fetchAttendances(device);
  return {
    deviceId: device.id,
    name: device.name,
    source: 'excel',
    file: config.excel.file,
    logCounts: records.length,
  };
};

module.exports = { fetchAttendances, fetchUsers, fetchInfo };
