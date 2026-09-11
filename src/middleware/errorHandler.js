'use strict';

const { ApiError } = require('../utils/errors');

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  const status = err instanceof ApiError ? err.status : 500;

  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    code: status,
    success: false,
    message: err.message || 'Terjadi kesalahan pada server',
    details: err.details || null,
  });
};
