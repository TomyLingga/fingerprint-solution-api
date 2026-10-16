'use strict';

const { COMMANDS } = require('node-zklib/constants');
const { createTCPHeader } = require('node-zklib/utils');

const { decodeDeviceTime } = require('./decode');

/**
 * Device clock access and real-time punch events on one ZK session.
 *
 * node-zklib knows nothing about the clock, and its request helpers resolve on
 * whatever frame comes off the socket next. Once a terminal has been asked to
 * stream punch events, that next frame may well be an event rather than the
 * reply being waited for. So this module takes the socket over for the length
 * of a clock operation: it frames the stream itself, routes event frames to a
 * listener and reply frames to the one command that is pending.
 *
 * Wire framing per TCP frame:
 *   bytes 0..3   magic 50 50 82 7d
 *   bytes 4..5   payload length (counted from byte 8)
 *   bytes 8..15  command header (commandId, checksum, sessionId, replyId)
 *   bytes 16..   data
 *
 * For frames the terminal pushes on its own (CMD_REG_EVENT), the sessionId
 * slot carries the event type instead.
 */

const MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const PREFIX_SIZE = 8;
const HEADER_SIZE = 8;

const ACK_NAMES = {
  [COMMANDS.CMD_ACK_OK]: 'ACK_OK',
  [COMMANDS.CMD_ACK_ERROR]: 'ACK_ERROR',
  [COMMANDS.CMD_ACK_DATA]: 'ACK_DATA',
  [COMMANDS.CMD_ACK_RETRY]: 'ACK_RETRY',
  [COMMANDS.CMD_ACK_REPEAT]: 'ACK_REPEAT',
  [COMMANDS.CMD_ACK_UNAUTH]: 'ACK_UNAUTH (mesin memakai Comm Key, perintah tulis ditolak)',
  [COMMANDS.CMD_ACK_UNKNOWN]: 'ACK_UNKNOWN (perintah tidak dikenal firmware)',
  [COMMANDS.CMD_ACK_ERROR_CMD]: 'ACK_ERROR_CMD',
  [COMMANDS.CMD_ACK_ERROR_INIT]: 'ACK_ERROR_INIT',
  [COMMANDS.CMD_ACK_ERROR_DATA]: 'ACK_ERROR_DATA',
};

const ackName = (commandId) => ACK_NAMES[commandId] || `kode ${commandId}`;

/**
 * Packs a local wall-clock Date into the terminal's 32-bit time. This is the
 * exact inverse of decodeDeviceTime: months are zero based, days one based.
 */
const encodeDeviceTime = (date) => {
  let packed = (date.getFullYear() - 2000) * 12 + date.getMonth();
  packed = packed * 31 + (date.getDate() - 1);
  packed = packed * 24 + date.getHours();
  packed = packed * 60 + date.getMinutes();
  packed = packed * 60 + date.getSeconds();
  return packed;
};

const uint32 = (value) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
};

// Event timestamps come as six plain bytes: YY MM DD hh mm ss.
const decodeHexTime = (bytes) => {
  const date = new Date(2000 + bytes[0], bytes[1] - 1, bytes[2], bytes[3], bytes[4], bytes[5]);
  return Number.isNaN(date.getTime()) ? null : date;
};

const readAscii = (buffer, start, end) =>
  buffer.subarray(start, end).toString('ascii').split('\0').shift().trim();

/**
 * Decodes the data part of a pushed punch event. Firmware families disagree on
 * the layout, so the length decides: modern terminals send a 24-byte ASCII
 * user id, older ones a 2 or 4 byte integer. Returns null for anything else.
 */
const decodePunchEvent = (data) => {
  if (data.length >= 32) {
    return {
      userId: readAscii(data, 0, 24),
      verifyMode: data[24],
      state: data[25],
      time: decodeHexTime(data.subarray(26, 32)),
    };
  }
  if (data.length === 12) {
    return {
      userId: String(data.readUInt32LE(0)),
      verifyMode: data[4],
      state: data[5],
      time: decodeHexTime(data.subarray(6, 12)),
    };
  }
  if (data.length === 10 || data.length === 14) {
    return {
      userId: String(data.readUInt16LE(0)),
      verifyMode: data[2],
      state: data[3],
      time: decodeHexTime(data.subarray(4, 10)),
    };
  }
  return null;
};

/**
 * Enrolment ids are strings on the wire but people type them as numbers, so
 * "0123" and "123" are the same person when both are purely numeric.
 */
const sameUser = (a, b) => {
  const left = String(a === null || a === undefined ? '' : a).trim();
  const right = String(b === null || b === undefined ? '' : b).trim();
  if (!left || !right) return false;
  if (left === right) return true;
  return /^\d+$/.test(left) && /^\d+$/.test(right) && Number(left) === Number(right);
};

class CommandChannel {
  /**
   * @param tcp  the ZKLibTCP instance behind an open ZKLib session
   */
  constructor(tcp, { timeoutMs = 10000 } = {}) {
    this.tcp = tcp;
    this.socket = tcp.socket;
    this.timeoutMs = timeoutMs;
    this.stream = Buffer.alloc(0);
    this.pending = null;
    this.closed = false;
    this.onEvent = null;
    this.onClosed = null;

    this.handleData = (chunk) => this.receive(chunk);
    this.handleClose = () => {
      this.closed = true;
      this.fail(new Error('Koneksi ke mesin terputus'));
      if (this.onClosed) this.onClosed();
    };

    this.socket.on('data', this.handleData);
    this.socket.once('close', this.handleClose);
  }

  receive(chunk) {
    this.stream = Buffer.concat([this.stream, chunk]);

    while (this.stream.length >= PREFIX_SIZE) {
      if (this.stream.compare(MAGIC, 0, 4, 0, 4) !== 0) {
        // Framing lost. Half a frame cannot be recovered, so start over.
        this.stream = Buffer.alloc(0);
        break;
      }
      const size = this.stream.readUInt16LE(4);
      if (this.stream.length < PREFIX_SIZE + size) break;

      const frame = this.stream.subarray(PREFIX_SIZE, PREFIX_SIZE + size);
      this.stream = this.stream.subarray(PREFIX_SIZE + size);
      if (frame.length >= HEADER_SIZE) this.dispatch(frame);
    }
  }

  dispatch(frame) {
    const commandId = frame.readUInt16LE(0);
    const data = frame.subarray(HEADER_SIZE);

    if (commandId === COMMANDS.CMD_REG_EVENT) {
      if (this.onEvent) this.onEvent(frame.readUInt16LE(4), data);
      return;
    }

    // A reply nobody is waiting for is a late duplicate; drop it.
    if (!this.pending) return;

    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve({ commandId, data });
  }

  fail(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  send(command, data = Buffer.alloc(0)) {
    if (this.closed) return Promise.reject(new Error('Koneksi ke mesin sudah tertutup'));
    if (this.pending) return Promise.reject(new Error('Masih ada perintah yang menunggu balasan'));

    this.tcp.replyId += 1;
    const frame = createTCPHeader(command, this.tcp.sessionId, this.tcp.replyId, data);

    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(
          () => this.fail(new Error(`Timeout ${this.timeoutMs} ms menunggu balasan perintah ${command}`)),
          this.timeoutMs
        ),
      };
      this.socket.write(frame, (err) => {
        if (err) this.fail(err);
      });
    });
  }

  async expectOk(command, data, label) {
    const reply = await this.send(command, data);
    if (reply.commandId !== COMMANDS.CMD_ACK_OK) {
      throw new Error(`Mesin menolak ${label}: ${ackName(reply.commandId)}`);
    }
    return reply.data;
  }

  async getTime() {
    const data = await this.expectOk(COMMANDS.CMD_GET_TIME, Buffer.alloc(0), 'pembacaan jam');
    if (data.length < 4) throw new Error('Balasan jam mesin terlalu pendek');
    return decodeDeviceTime(data.readUInt32LE(0));
  }

  async setTime(date) {
    await this.expectOk(COMMANDS.CMD_SET_TIME, uint32(encodeDeviceTime(date)), 'pengubahan jam');
  }

  async registerPunchEvents() {
    await this.expectOk(COMMANDS.CMD_REG_EVENT, uint32(COMMANDS.EF_ATTLOG), 'pendaftaran event');
  }

  async unregisterEvents() {
    await this.expectOk(COMMANDS.CMD_REG_EVENT, uint32(0), 'penghentian event');
  }

  /**
   * Arms a listener for the first punch by `userId`. Returns the promise plus
   * a cancel handle; arm it before registering events so nothing slips past
   * between the registration ACK and the handler being attached.
   *
   * Resolves with the punch, or null when `waitMs` passes. Punches by anybody
   * else go to `onOther`. A keepalive clock read every `keepAliveMs` makes a
   * dead session surface as a rejection instead of a silent wait.
   */
  waitForPunch(userId, waitMs, { onOther = () => {}, keepAliveMs = 30000 } = {}) {
    if (this.closed) {
      return { promise: Promise.reject(new Error('Koneksi ke mesin sudah tertutup')), cancel: () => {} };
    }

    let finish = null;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(resolve, null), waitMs);
      const keepAlive = setInterval(() => {
        if (this.pending) return;
        this.getTime().catch((err) =>
          finish(reject, new Error(`Sesi ke mesin mati saat menunggu scan: ${err.message}`))
        );
      }, keepAliveMs);

      finish = (settle, value) => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        this.onEvent = null;
        this.onClosed = null;
        finish = () => {};
        settle(value);
      };

      this.onEvent = (flag, data) => {
        const punch = decodePunchEvent(data);
        if (!punch) return;
        if (sameUser(punch.userId, userId)) finish(resolve, punch);
        else onOther(punch);
      };
      this.onClosed = () => finish(reject, new Error('Koneksi ke mesin terputus saat menunggu scan'));
    });

    return { promise, cancel: () => finish(() => {}, null) };
  }

  dispose() {
    this.fail(new Error('Sesi ditutup'));
    this.onEvent = null;
    this.onClosed = null;
    this.socket.removeListener('data', this.handleData);
    this.socket.removeListener('close', this.handleClose);
  }
}

module.exports = { CommandChannel, encodeDeviceTime, decodePunchEvent, sameUser, ackName };
