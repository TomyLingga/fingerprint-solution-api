'use strict';

const app = require('./app');
const config = require('./config');
const devices = require('./devices');
const scheduler = require('./services/scheduler');

const server = app.listen(config.port, () => {
  console.log(`fingerprint-api listening on http://localhost:${config.port}`);
  console.log(`data source: ${config.source}`);
  for (const device of devices.list()) {
    const address = device.ip ? `${device.ip}:${device.port}` : config.source;
    console.log(`device ${device.id}: ${address}${device.enabled ? '' : ' (nonaktif)'}`);
  }
  console.log(`timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  scheduler.start();
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, closing server`);
  scheduler.stop();
  server.close(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
