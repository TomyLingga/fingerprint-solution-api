'use strict';

/**
 * Every timestamp in this project is a wall-clock value in the device's own
 * timezone. The fingerprint machine stores plain Y/M/D H:M:S with no offset,
 * so we build and format Date objects with local getters only and never touch
 * toISOString(). Keep the process TZ identical to the device TZ (Asia/Jakarta).
 */

const pad2 = (n) => String(n).padStart(2, '0');

const formatDate = (date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

const formatTime = (date) =>
  `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;

const formatDateTime = (date) => `${formatDate(date)} ${formatTime(date)}`;

const startOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

const endOfDay = (date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

// Accepts YYYY-MM-DD or DD/MM/YYYY, optionally followed by HH:mm[:ss]
// separated by a space or "T".
const BOUNDARY_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$|^(\d{2})\/(\d{2})\/(\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Parses a user supplied range boundary.
 * When the input carries no time part, `edge` decides whether it snaps to the
 * beginning (00:00:00.000) or the end (23:59:59.999) of that day.
 */
const parseBoundary = (value, edge = 'start') => {
  const match = BOUNDARY_PATTERN.exec(String(value).trim());
  if (!match) return null;

  const isIso = match[1] !== undefined;
  const year = Number(isIso ? match[1] : match[9]);
  const month = Number(isIso ? match[2] : match[8]);
  const day = Number(isIso ? match[3] : match[7]);
  const rawHour = isIso ? match[4] : match[10];
  const rawMinute = isIso ? match[5] : match[11];
  const rawSecond = isIso ? match[6] : match[12];

  const hasTime = rawHour !== undefined;
  const hour = hasTime ? Number(rawHour) : edge === 'end' ? 23 : 0;
  const minute = hasTime ? Number(rawMinute) : edge === 'end' ? 59 : 0;
  const second = hasTime && rawSecond !== undefined ? Number(rawSecond) : edge === 'end' && !hasTime ? 59 : 0;
  const ms = edge === 'end' && !hasTime ? 999 : 0;

  const date = new Date(year, month - 1, day, hour, minute, second, ms);

  // Reject impossible calendar dates such as 2026-02-31, which Date silently rolls over.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
};

const diffMinutes = (from, to) => Math.round((to.getTime() - from.getTime()) / 60000);

module.exports = {
  pad2,
  formatDate,
  formatTime,
  formatDateTime,
  startOfDay,
  endOfDay,
  parseBoundary,
  diffMinutes,
};
