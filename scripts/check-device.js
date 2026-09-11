'use strict';

/**
 * Connectivity probe for every configured terminal. Reports which machines
 * answer, how many logs they hold, and how long a full download takes.
 * Run with `npm run check:device`, optionally naming devices:
 *
 *   npm run check:device -- lantai-1 lantai-2
 */

const devices = require('../src/devices');
const client = require('../src/zk/client');
const { formatDateTime } = require('../src/utils/datetime');

const checkDevice = async (device) => {
  console.log(`\n=== ${device.id} (${device.name}) ${device.ip}:${device.port} ===`);

  const info = await client.fetchInfo(device);
  console.log(`User: ${info.userCounts} | Log: ${info.logCounts} | Kapasitas: ${info.logCapacity}`);

  let lastLogged = 0;
  const started = Date.now();
  const { records, warning } = await client.fetchAttendances(device, {
    onProgress: (received, total) => {
      const percent = Math.floor((received / total) * 100);
      if (percent >= lastLogged + 25) {
        lastLogged = percent;
        console.log(`  unduh ${percent}%`);
      }
    },
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`Terunduh: ${records.length} log dalam ${elapsed} detik`);
  if (warning) console.log(`Peringatan: ${warning}`);

  if (records.length > 0) {
    const sorted = [...records].sort((a, b) => a.time - b.time);
    console.log(`Log terlama: ${formatDateTime(sorted[0].time)}`);
    console.log(`Log terbaru: ${formatDateTime(sorted[sorted.length - 1].time)}`);
  }

  return { deviceId: device.id, ok: true, records: records.length, seconds: Number(elapsed) };
};

const main = async () => {
  const requested = process.argv.slice(2).filter(Boolean);
  const targets = requested.length > 0 ? requested.map((id) => devices.byId(id)) : devices.enabled();

  const missing = requested.filter((id) => !devices.byId(id));
  if (missing.length > 0) {
    throw new Error(`Perangkat tidak dikenal: ${missing.join(', ')}`);
  }
  if (targets.length === 0) {
    throw new Error('Tidak ada perangkat aktif di devices.json');
  }

  console.log(`Memeriksa ${targets.length} perangkat secara paralel...`);

  // Each terminal is an independent connection, so they are probed at once.
  const results = await Promise.allSettled(targets.map(checkDevice));

  console.log('\n=== Ringkasan ===');
  let failed = 0;

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      const { deviceId, records, seconds } = result.value;
      console.log(`OK    ${deviceId}: ${records} log, ${seconds} detik`);
    } else {
      failed += 1;
      console.log(`GAGAL ${targets[index].id}: ${result.reason.message}`);
    }
  });

  if (failed > 0) throw new Error(`${failed} dari ${targets.length} perangkat tidak bisa dihubungi`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nGagal: ${err.message || err}`);
    process.exit(1);
  });
