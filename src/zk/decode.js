'use strict';

/**
 * Attendance log decoder for the 40-byte ZKTeco record format used by
 * Solution / ZKTeco terminals.
 *
 *   offset  0..1    uint16   uid          internal record serial
 *   offset  2..25   ascii    userId       enrolment id, NUL padded
 *   offset  26      uint8    verifyMode   how the punch was verified
 *   offset  27..30  uint32   time         packed date-time
 *   offset  31      uint8    state        in / out / break punch state
 *   offset  32..39  -        reserved
 *
 * node-zklib only exposes uid, userId and time, so we decode the buffer here
 * to keep verifyMode and state as well.
 */

const RECORD_SIZE = 40;

// Best effort labels. Firmware families disagree on the higher numbers, so the
// raw value is always returned next to the label and unknown codes fall through.
const VERIFY_LABELS = {
  0: 'Password',
  1: 'Sidik Jari',
  2: 'Sidik Jari',
  3: 'Kartu',
  4: 'Kartu',
  5: 'Sidik Jari + Password',
  15: 'Wajah',
  16: 'Wajah',
  25: 'Telapak Tangan',
};

const STATE_LABELS = {
  0: 'Check In',
  1: 'Check Out',
  2: 'Break Out',
  3: 'Break In',
  4: 'Overtime In',
  5: 'Overtime Out',
};

const verifyLabel = (code) =>
  VERIFY_LABELS[code] !== undefined ? VERIFY_LABELS[code] : `Kode ${code}`;

const stateLabel = (code) =>
  STATE_LABELS[code] !== undefined ? STATE_LABELS[code] : `Kode ${code}`;

/**
 * Unpacks the device's 32-bit timestamp into a local-time Date.
 * Mirrors node-zklib's parseTimeToDate so both paths agree.
 */
const decodeDeviceTime = (packed) => {
  const second = packed % 60;
  let rest = (packed - second) / 60;
  const minute = rest % 60;
  rest = (rest - minute) / 60;
  const hour = rest % 24;
  rest = (rest - hour) / 24;
  const day = (rest % 31) + 1;
  rest = (rest - (day - 1)) / 31;
  const month = rest % 12;
  rest = (rest - month) / 12;
  const year = rest + 2000;

  return new Date(year, month, day, hour, minute, second);
};

const readAscii = (buffer, start, end) =>
  buffer.subarray(start, end).toString('ascii').split('\0').shift().trim();

/**
 * Decodes the raw attendance payload (already stripped of the 4-byte size
 * prefix) into normalised records.
 *
 * Empty slots in the device buffer decode to a packed time of 0, i.e.
 * "2000-01-01 00:00:00". Those are dropped and reported as `skipped`.
 */
const decodeAttendanceBuffer = (buffer, deviceIp = null) => {
  const records = [];
  let cursor = buffer;
  let skipped = 0;

  while (cursor.length >= RECORD_SIZE) {
    const chunk = cursor.subarray(0, RECORD_SIZE);
    cursor = cursor.subarray(RECORD_SIZE);

    const packedTime = chunk.readUInt32LE(27);
    if (packedTime === 0) {
      skipped += 1;
      continue;
    }

    const verifyMode = chunk.readUInt8(26);
    const state = chunk.readUInt8(31);

    records.push({
      uid: chunk.readUInt16LE(0),
      userId: readAscii(chunk, 2, 11),
      time: decodeDeviceTime(packedTime),
      verifyMode,
      verify: verifyLabel(verifyMode),
      state,
      status: stateLabel(state),
      deviceIp,
    });
  }

  return { records, skipped };
};

module.exports = {
  RECORD_SIZE,
  decodeAttendanceBuffer,
  decodeDeviceTime,
  verifyLabel,
  stateLabel,
};
