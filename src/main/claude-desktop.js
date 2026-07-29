'use strict';

// Detects whether the Claude *desktop app* is running — the process that owns the
// scheduled-task registry and clobbers external writes to it.
//
// Both the desktop app and Claude Code CLI sessions run as "claude.exe", so the
// check must be path-based: the desktop app installs under WindowsApps
// (...\WindowsApps\Claude_<version>_...\app\Claude.exe) while CLI shims live under
// %APPDATA%\Claude\claude-code\<version>\claude.exe and must NOT trip the gate.

const { execFile } = require('node:child_process');
const { AppError } = require('./errors');

const DESKTOP_PATH_RE = /\\windowsapps\\claude_/i;
const CACHE_MS = 5000;

const PS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\").ExecutablePath",
];

function createDesktopGate({ execFileImpl = execFile } = {}) {
  let cache = null; // { value: boolean, at: number }

  function query() {
    return new Promise((resolve, reject) => {
      execFileImpl('powershell.exe', PS_ARGS, { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err) {
          reject(new AppError('GATE_UNKNOWN', `cannot determine whether Claude Desktop is running: ${err.message}`));
          return;
        }
        resolve(String(stdout).split(/\r?\n/).some((line) => DESKTOP_PATH_RE.test(line)));
      });
    });
  }

  /** True when the desktop app is running. Throws GATE_UNKNOWN on detection failure (fail closed). */
  async function isDesktopRunning({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    const value = await query();
    cache = { value, at: Date.now() };
    return value;
  }

  return { isDesktopRunning };
}

module.exports = { createDesktopGate };
