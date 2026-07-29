'use strict';

/** Typed error whose `code` maps 1:1 onto the IPC error envelope sent to the renderer. */
class AppError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

module.exports = { AppError };
