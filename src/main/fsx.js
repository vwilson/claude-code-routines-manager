'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write atomically: temp file in the same directory (mode 0600), fsync, then rename
 * over the target. rename() on the same volume replaces the target atomically on Windows.
 */
async function atomicWriteFile(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Antivirus/indexers briefly lock freshly-written files on Windows (EPERM/EBUSY).
      if (attempt >= 3 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // best effort cleanup
        }
        throw new AppError('IO', `failed to write ${file}: ${err.message}`);
      }
      await sleep(100);
    }
  }
}

/**
 * Read + JSON.parse with retries. The Claude desktop app rewrites its registry
 * non-atomically, so a torn read is transient — retry before calling it corrupt.
 */
async function readJsonWithRetry(file, { attempts = 3, delayMs = 150 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new AppError(err.code === 'ENOENT' ? 'NOT_FOUND' : 'IO', `cannot read ${file}: ${err.message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      if (attempt >= attempts) {
        throw new AppError('PARSE', `${file} is not valid JSON: ${err.message}`);
      }
      await sleep(delayMs);
    }
  }
}

module.exports = { atomicWriteFile, readJsonWithRetry, sleep };
