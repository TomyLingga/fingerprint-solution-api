'use strict';

const { COMMANDS, MAX_CHUNK } = require('node-zklib/constants');
const { createTCPHeader, decodeTCPHeader, checkNotEventTCP } = require('node-zklib/utils');

/**
 * Reliable bulk reader for ZK terminals.
 *
 * node-zklib fires every chunk request in one burst. On a terminal holding a
 * six-figure log count that floods the firmware, packets are dropped, and the
 * transfer dies half way through with "TIME OUT !! n PACKETS REMAIN". This
 * reader asks for one chunk at a time and only requests the next after the
 * previous one has fully arrived, which is what the device expects.
 *
 * Wire framing per TCP frame:
 *   bytes 0..3   magic
 *   bytes 4..5   payload length (counted from byte 8)
 *   bytes 8..15  command header (commandId, checksum, sessionId, replyId)
 *   bytes 16..   data
 *
 * Each chunk reply is preceded by a CMD_PREPARE_DATA frame carrying 8 bytes of
 * data, hence the 8-byte lead-in that gets stripped from every chunk.
 */

const PREPARE_LEAD_IN = 8;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Frames the raw socket stream and hands complete chunks to whoever is waiting.
 */
class ChunkCollector {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.stream = Buffer.alloc(0);
    this.payload = Buffer.alloc(0);
    this.waiter = null;
    this.closed = false;

    this.onData = (frame) => this.handleData(frame);
    this.onClose = () => this.handleClose();

    socket.on('data', this.onData);
    socket.once('close', this.onClose);
  }

  handleData(frame) {
    if (checkNotEventTCP(frame)) return;

    this.armTimer();
    this.stream = Buffer.concat([this.stream, frame]);

    while (this.stream.length >= 8) {
      const payloadSize = this.stream.readUIntLE(4, 2);
      if (this.stream.length < 8 + payloadSize) break;

      // An ACK frame has no data past the command header and contributes nothing.
      this.payload = Buffer.concat([this.payload, this.stream.subarray(16, 8 + payloadSize)]);
      this.stream = this.stream.subarray(8 + payloadSize);
    }

    this.settle();
  }

  handleClose() {
    this.closed = true;
    if (this.waiter) this.rejectWaiter(new Error('Koneksi ke mesin terputus saat mengunduh data'));
  }

  armTimer() {
    if (!this.waiter) return;
    clearTimeout(this.waiter.timer);
    this.waiter.timer = setTimeout(
      () => this.rejectWaiter(new Error(`Timeout menunggu data pada offset ${this.waiter.start}`)),
      this.timeoutMs
    );
  }

  settle() {
    if (!this.waiter || this.payload.length < this.waiter.target) return;

    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);

    const chunk = this.payload.subarray(PREPARE_LEAD_IN, waiter.target);
    this.payload = this.payload.subarray(waiter.target);
    waiter.resolve(chunk);
  }

  rejectWaiter(error) {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  /** Discards anything half-received so a retry starts from a clean slate. */
  reset() {
    this.stream = Buffer.alloc(0);
    this.payload = Buffer.alloc(0);
  }

  expect(start, size) {
    if (this.closed) return Promise.reject(new Error('Koneksi ke mesin sudah tertutup'));

    return new Promise((resolve, reject) => {
      this.waiter = { start, target: size + PREPARE_LEAD_IN, resolve, reject, timer: null };
      this.armTimer();
    });
  }

  dispose() {
    this.rejectWaiter(new Error('Pembacaan dibatalkan'));
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('close', this.onClose);
  }
}

/**
 * Requests `reqData` and returns the full payload.
 * Resolves with { data, warning } — a warning means the payload is a partial
 * read that the caller may still decode.
 */
const readAll = async (tcp, reqData, options = {}) => {
  const chunkSize = Math.min(options.chunkSize || MAX_CHUNK, MAX_CHUNK);
  const timeoutMs = options.timeoutMs || 20000;
  const retries = options.retries === undefined ? 2 : options.retries;
  const onProgress = options.onProgress || (() => {});

  tcp.replyId += 1;
  const header = createTCPHeader(COMMANDS.CMD_DATA_WRRQ, tcp.sessionId, tcp.replyId, reqData);
  const reply = await tcp.requestData(header);
  const decoded = decodeTCPHeader(reply.subarray(0, 16));

  // Small payloads come back inline, no chunking involved.
  if (decoded.commandId === COMMANDS.CMD_DATA) {
    return { data: reply.subarray(16), warning: null };
  }

  if (decoded.commandId !== COMMANDS.CMD_ACK_OK && decoded.commandId !== COMMANDS.CMD_PREPARE_DATA) {
    throw new Error(`Perangkat membalas perintah tak terduga: ${decoded.commandId}`);
  }

  const totalSize = reply.subarray(16).readUIntLE(1, 4);
  const collector = new ChunkCollector(tcp.socket, timeoutMs);
  const parts = [];
  let received = 0;
  let warning = null;

  try {
    while (received < totalSize) {
      const size = Math.min(chunkSize, totalSize - received);
      let chunk = null;
      let lastError = null;

      for (let attempt = 0; attempt <= retries && !chunk; attempt += 1) {
        try {
          if (attempt > 0) {
            collector.reset();
            await wait(300);
          }
          const pending = collector.expect(received, size);
          tcp.sendChunkRequest(received, size);
          chunk = await pending;
        } catch (err) {
          lastError = err;
        }
      }

      if (!chunk) {
        warning = `Unduhan berhenti di ${received}/${totalSize} byte: ${lastError.message}`;
        break;
      }

      parts.push(chunk);
      received += chunk.length;
      onProgress(received, totalSize);
    }
  } finally {
    collector.dispose();
  }

  return { data: Buffer.concat(parts), warning, totalSize, received };
};

module.exports = { readAll };
