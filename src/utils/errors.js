'use strict';

class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, message, details);
const notFound = (message) => new ApiError(404, message);
const badGateway = (message, details) => new ApiError(502, message, details);

module.exports = { ApiError, badRequest, notFound, badGateway };
