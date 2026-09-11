'use strict';

const express = require('express');

const config = require('./config');
const errorHandler = require('./middleware/errorHandler');
const attendanceRoutes = require('./routes/attendance');
const attendance = require('./services/attendance');
const scheduler = require('./services/scheduler');
const { notFound } = require('./utils/errors');

const app = express();

app.disable('x-powered-by');
app.use(express.json());

// Answers from memory only: never touches the terminal, so it stays instant
// even while a sync is running.
app.get('/health', (req, res) => {
  res.json({
    code: 200,
    success: true,
    data: {
      status: 'ok',
      source: config.source,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      uptimeSeconds: Math.round(process.uptime()),
      cache: attendance.getStatus(),
      scheduler: scheduler.getStatus(),
    },
  });
});

app.use('/api/v1', attendanceRoutes);

app.use((req, res, next) => next(notFound(`Endpoint ${req.method} ${req.originalUrl} tidak ditemukan`)));
app.use(errorHandler);

module.exports = app;
