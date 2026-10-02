/**
 * Hide the terminal `claude` was typed in while the window is open, and
 * bring it back when the window's last Claude exits.
 *
 * KDE Plasma only: a one-off KWin script finds the terminal's window — the
 * one whose process is an ancestor of this one (Konsole, or whatever ran
 * the shell), preferring the active window when one terminal process owns
 * several — then minimizes it and keeps it out of the taskbar and the task
 * switcher. Restoring finds it the same way: an ancestor's window that is
 * still minimized and out of the taskbar.
 *
 * A Konsole window with other tabs is left alone — hiding it would hide
 * work that has nothing to do with this session.
 *
 * Closing the window closes the terminal too (its shell is hung up — the
 * terminal was only ever the launcher); Claude Code exiting by itself
 * (Ctrl+C, /exit) brings it back.
 *
 * `CLAUDE_CHATVIEW_HIDE_TERMINAL=off` turns it off. Anything missing (not
 * Plasma, no qdbus6) = nothing happens.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { onPath } from './browser.mjs';
import { runtimeDir } from './runtime.mjs';

const QDBUS = ['qdbus6', 'qdbus'];

/** This process's ancestors, nearest first (not itself). */
function ancestors() {
  const out = [];
  let pid = process.ppid;
  for (let i = 0; i < 32 && pid > 1; i++) {
    out.push(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // the command name may hold spaces and parens: parse after the last ')'
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return out;
}

function qdbus() {
  for (const name of QDBUS) {
    const bin = onPath(name);
    if (bin) return bin;
  }
  return null;
}

function enabled(env = process.env) {
  const v = String(env.CLAUDE_CHATVIEW_HIDE_TERMINAL || '').toLowerCase();
  if (['off', '0', 'no', 'false'].includes(v)) return false;
  return process.platform === 'linux' && /KDE/i.test(env.XDG_CURRENT_DESKTOP || '');
}

/** Konsole tells its children which window they are in; more than one tab = keep it. */
function konsoleHasOtherTabs(q, env = process.env) {
  const svc = env.KONSOLE_DBUS_SERVICE;
  const win = env.KONSOLE_DBUS_WINDOW;
  if (!svc || !win) return false;
  const r = spawnSync(q, [svc, win, 'org.kde.konsole.Window.sessionCount'],
    { encoding: 'utf8', timeout: 2000 });
  const n = Number(String(r.stdout || '').trim());
  return Number.isInteger(n) && n > 1;
}

/** Load, run and unload a KWin script. Synchronous: it also runs at exit. */
function runKWin(q, source) {
  const dir = runtimeDir();
  const file = path.join(dir, `hideterm-${process.pid}.js`);
  const name = `claude-chatview-hideterm-${process.pid}`;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, source, { mode: 0o600 });
    const call = (...a) => spawnSync(q, ['org.kde.KWin', ...a], { encoding: 'utf8', timeout: 3000 });
    call('/Scripting', 'org.kde.kwin.Scripting.unloadScript', name);
    const id = String(call('/Scripting', 'org.kde.kwin.Scripting.loadScript', file, name).stdout || '').trim();
    if (!/^\d+$/.test(id)) return false;
    call(`/Scripting/Script${id}`, 'org.kde.kwin.Script.run');
    call('/Scripting', 'org.kde.kwin.Scripting.unloadScript', name);
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(file, { force: true }); } catch { /* gone */ }
  }
}

const findTerminal = (pids) => `
const pids = ${JSON.stringify(pids)};
function rank(w) { const i = pids.indexOf(w.pid); return i < 0 ? 1e9 : i; }
const mine = workspace.windowList().filter((w) => w.normalWindow && rank(w) < 1e9);
`;

const SHELLS = /^-?(fish|bash|zsh|sh|dash|ksh|mksh|tcsh|csh|nu|elvish|xonsh)$/;

/** Hang up the shell `claude` was typed in, so its terminal tab — the only
 *  one in that window, or it would not have been hidden — closes. */
function hangUpShell() {
  try {
    const comm = readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim();
    if (SHELLS.test(comm)) process.kill(process.ppid, 'SIGHUP');
  } catch { /* gone already */ }
}

/**
 * Hide the terminal. Returns `{restore, close}` — bring it back, or close
 * it for good (each safe to call more than once, the first one wins) — or
 * null when nothing was hidden.
 */
export function hideTerminal() {
  if (!enabled()) return null;
  const q = qdbus();
  if (!q) return null;
  if (konsoleHasOtherTabs(q)) return null;
  const pids = ancestors();
  if (!pids.length) return null;
  const ok = runKWin(q, `${findTerminal(pids)}
let w = mine.indexOf(workspace.activeWindow) >= 0 ? workspace.activeWindow : null;
if (!w && mine.length === 1) w = mine[0];
if (w) { w.skipTaskbar = true; w.skipSwitcher = true; w.skipPager = true; w.minimized = true; }
`);
  if (!ok) return null;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    hangUpShell();
  };
  const restore = () => {
    if (done) return;
    done = true;
    runKWin(q, `${findTerminal(pids)}
for (const w of mine) {
  if (!w.minimized || !w.skipTaskbar) continue;
  w.skipTaskbar = false; w.skipSwitcher = false; w.skipPager = false; w.minimized = false;
  workspace.activeWindow = w;
}
`);
  };
  return { restore, close };
}
