/**
 * statusLine relay: hand the context window to the running chatview window,
 * then draw your OWN status line exactly as before.
 *
 * The exact context percentage exists in one place only — the JSON Claude
 * Code pipes to its statusLine command (`context_window.used_percentage` /
 * `.remaining_percentage`). Set as your statusLine (install.sh offers to),
 * this does two things on every refresh:
 *
 *   1. Find the window running this session — `CLAUDE_CHATVIEW_URL` +
 *      `CLAUDE_CHATVIEW_TOKEN` in the environment (a session the window
 *      started), else the runtime file keyed by the payload's session id —
 *      and POST the two percentages to it (loopback, 150 ms timeout, every
 *      failure ignored). A plain `claude` session has neither: nothing sent.
 *   2. Run the statusLine command you had before (saved by install.sh in
 *      `~/.config/claude-chatview/previous-statusline.json`) with the same
 *      stdin, and print its output unchanged. None saved: print nothing.
 *
 * It never prints an error into the status line and always exits 0.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { configHome, readInstance } from './runtime.mjs';

const POST_TIMEOUT_MS = 150;
const USER_CMD_TIMEOUT_MS = 10_000;

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(Buffer.alloc(0)); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function previousCommand() {
  try {
    const saved = JSON.parse(readFileSync(path.join(configHome(), 'previous-statusline.json'), 'utf8'));
    const cmd = saved?.statusLine?.command;
    if (typeof cmd === 'string' && cmd.trim() && !cmd.includes('claude-chatview-statusline')) return cmd;
  } catch { /* none saved */ }
  return null;
}

const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);

async function relay(raw) {
  let event;
  try { event = JSON.parse(raw.toString('utf8') || '{}'); } catch { return; }
  const cw = event?.context_window;
  if (!cw || typeof cw !== 'object') return;
  const used = pct(cw.used_percentage);
  const left = pct(cw.remaining_percentage);
  if (used === null && left === null) return;
  const sid = typeof event.session_id === 'string' ? event.session_id.slice(0, 80) : null;
  let url = process.env.CLAUDE_CHATVIEW_URL;
  let token = process.env.CLAUDE_CHATVIEW_TOKEN;
  if (!url || !token) {
    const inst = sid ? readInstance(sid) : null;
    url = inst?.url;
    token = inst?.token;
  }
  if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) return;
  const body = JSON.stringify({ session_id: sid,
    context_window: { used_percentage: used, remaining_percentage: left } });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(`${url}api/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      signal: ctl.signal,
    });
  } catch { /* the window is a convenience */ } finally { clearTimeout(t); }
}

function runPrevious(cmd, raw) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    const out = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, USER_CMD_TIMEOUT_MS);
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(out)); });
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
  });
}

try {
  const raw = await readStdin();
  const cmd = previousCommand();
  // the person's command starts first; the POST happens while it runs
  const prev = cmd ? runPrevious(cmd, raw) : Promise.resolve(null);
  await relay(raw).catch(() => {});
  const out = await prev;
  if (out && out.length) process.stdout.write(out);
} catch { /* never an error in the status line */ }
process.exitCode = 0;
