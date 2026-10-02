/**
 * Where a running window can be found by the statusLine relay, and where
 * the relay keeps the person's own statusLine command.
 *
 *   runtime  `$XDG_RUNTIME_DIR/claude-chatview/`, else
 *            `~/.cache/claude-chatview/run/` — one `<session id>.json` per
 *            running window ({url, token, pid}), mode 0600 in a 0700 dir.
 *   config   `$XDG_CONFIG_HOME/claude-chatview/`, else
 *            `~/.config/claude-chatview/` — `previous-statusline.json`, the
 *            statusLine install.sh replaced (the relay runs it unchanged).
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function runtimeDir(env = process.env) {
  if (env.XDG_RUNTIME_DIR) return path.join(env.XDG_RUNTIME_DIR, 'claude-chatview');
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'claude-chatview', 'run');
}

export function configHome(env = process.env) {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude-chatview');
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function instanceFile(sessionId, env = process.env) {
  if (!SAFE_ID.test(String(sessionId || ''))) return null;
  return path.join(runtimeDir(env), `${sessionId}.json`);
}

export function writeInstance(sessionId, rec) {
  const file = instanceFile(sessionId);
  if (!file) return null;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  } catch { return null; }
}

export function readInstance(sessionId) {
  const file = instanceFile(sessionId);
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function removeInstance(sessionId) {
  const file = instanceFile(sessionId);
  if (file) { try { rmSync(file, { force: true }); } catch { /* gone */ } }
}

/** `$XDG_STATE_HOME/claude-chatview/`, else `~/.local/state/claude-chatview/`. */
export function stateHome(env = process.env) {
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'claude-chatview');
}

const SIZE_FILE = () => path.join(stateHome(), 'size.json');
const isDim = (n) => Number.isInteger(n) && n > 0 && n <= 1000;
let savedSize = '';

/** The terminal size the window last had: Claude Code starts at it before
 *  the window is up, so it rarely has to redraw once the window attaches. */
export function lastSize() {
  try {
    const s = JSON.parse(readFileSync(SIZE_FILE(), 'utf8'));
    return isDim(s.cols) && isDim(s.rows) ? { cols: s.cols, rows: s.rows } : null;
  } catch { return null; }
}

export function saveSize(cols, rows) {
  if (!isDim(cols) || !isDim(rows)) return;
  const text = JSON.stringify({ cols, rows });
  if (text === savedSize) return;
  savedSize = text;
  try {
    mkdirSync(stateHome(), { recursive: true });
    writeFileSync(SIZE_FILE(), text);
  } catch { /* only a head start */ }
}
