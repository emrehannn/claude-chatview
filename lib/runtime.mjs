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
