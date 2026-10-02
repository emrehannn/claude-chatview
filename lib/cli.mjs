/**
 * claude-chatview [claude args…]
 *
 * Runs the real Claude Code in a pseudo-terminal in the current directory,
 * with your arguments passed through, and opens a window that draws the
 * conversation as a chat — with Claude Code's own terminal one key away
 * (Ctrl+`) and shown by itself whenever Claude Code puts up a dialog.
 *
 * One window, one Claude session per tab (Ctrl+T opens another). Every
 * tab's Claude has exited -> this process exits with the last code. The window closes -> Claude is
 * stopped and this process exits (a browser window: after ~10 s with no connection).
 * Claude Code starts at once, alongside the window, at the window's last size.
 *
 * Anything that is not an interactive session (`-p`, `--help`, `--version`,
 * a subcommand like `mcp` or `update`, piped stdin, no display) runs plain
 * `claude` in this terminal instead, so it is safe to alias `claude` to this.
 */

import { trace } from './trace.mjs';
import { spawnSync } from 'node:child_process';
import { Session, resolveClaude } from './session.mjs';
import { createChatServer } from './server.mjs';
import { openWindow } from './browser.mjs';
import { writeInstance, removeInstance, lastSize } from './runtime.mjs';
import { hideTerminal } from './hideterm.mjs';

const NAME = 'claude-chatview';
/** No socket for this long after the window had one = the window is gone. */
const WINDOW_GONE_MS = 10_000;
/** Nobody ever connected and Claude never started: give up after this. */
const FIRST_CONNECT_MS = 120_000;
/** Let the page receive the exit frame before the server goes. */
const EXIT_LINGER_MS = 1200;

const SUBCOMMANDS = new Set([
  'agents', 'attach', 'auth', 'auto-mode', 'config', 'doctor', 'gateway', 'import',
  'install', 'kill', 'logs', 'mcp', 'migrate-installer', 'plugin', 'plugins',
  'project', 'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update', 'upgrade',
]);
const PLAIN_FLAGS = new Set(['-p', '--print', '-h', '--help', '-v', '--version',
  '--bg', '--background']);

const say = (msg) => process.stderr.write(`${NAME}: ${msg}\n`);

let args = process.argv.slice(2);
let noOpen = false;
args = args.filter((a) => {
  if (a === '--chatview-no-open') { noOpen = true; return false; }
  return true;
});
if (args.includes('--chatview-help')) {
  process.stdout.write(`usage: ${NAME} [claude args…]

Runs Claude Code in a chat-style window. Every argument goes to claude.
  Ctrl+\`                switch between the chat view and Claude Code's terminal
  --chatview-no-open    print the link instead of opening a window

Environment:
  CLAUDE_CHATVIEW=off|force       always plain claude | always the window
  CLAUDE_CHATVIEW_BROWSER=cmd     open the window with cmd (%u = the URL)
  CLAUDE_CHATVIEW_CLAUDE=path     the claude binary to run
`);
  process.exit(0);
}

const bin = resolveClaude();
if (!bin) {
  say('`claude` is not on PATH. Install Claude Code first: curl -fsSL https://claude.ai/install.sh | bash');
  process.exit(127);
}

function plainReason() {
  const mode = String(process.env.CLAUDE_CHATVIEW || '').toLowerCase();
  if (['off', '0', 'no', 'false', 'plain'].includes(mode)) return 'CLAUDE_CHATVIEW=off';
  if (args.some((a) => PLAIN_FLAGS.has(a) || a.startsWith('--print='))) return 'not interactive';
  if (args[0] && SUBCOMMANDS.has(args[0])) return 'subcommand';
  if (mode === 'force') return null;
  if (!process.stdin.isTTY) return 'stdin is not a terminal';
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return 'no display';
  }
  return null;
}

if (plainReason()) {
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  if (r.error) { say(r.error.message); process.exit(127); }
  process.exit(r.status ?? (r.signal ? 128 : 1));
}

// ── the window ────────────────────────────────────────────────────────
//
// One window, one or more tabs, one Claude session per tab. The first tab
// runs with the arguments typed; a new tab (Ctrl+T) is a fresh `claude` in
// the same directory. The process lives until every tab's Claude is gone.

let chat = null;
const tabs = new Map();      // id -> Session
let nextTab = 1;
let lastCode = 0;

const relayEnv = () => (chat
  ? { CLAUDE_CHATVIEW_URL: chat.base, CLAUDE_CHATVIEW_TOKEN: chat.secret } : null);
const register = (s) => {
  if (chat && s.claudeId) writeInstance(s.claudeId, { url: chat.base, token: chat.secret, pid: process.pid });
};

function addTab(userArgs = []) {
  const id = String(nextTab++);
  const s = new Session({
    cwd: process.cwd(),
    bin,
    userArgs,
    onId: (sid, old) => {
      if (old) removeInstance(old);
      if (sid) register(s);
    },
  });
  const env = relayEnv();
  if (env) { s.extraEnv = env; register(s); }
  s.subscribe((ev) => {
    if (ev.kind !== 'exit') return;
    lastCode = Number.isInteger(ev.code) ? ev.code : (ev.signal ? 128 : 0);
    if (s.claudeId) removeInstance(s.claudeId);
    // every tab ended: nothing is left to serve
    if ([...tabs.values()].every((t) => t.state === 'dead')) {
      setTimeout(() => {
        if ([...tabs.values()].every((t) => t.state === 'dead')) finish(lastCode);
      }, stopping ? 0 : EXIT_LINGER_MS);
    }
  });
  tabs.set(id, s);
  return id;
}

function closeTab(id) {
  const s = tabs.get(id);
  if (!s) return false;
  const live = s.alive;
  tabs.delete(id);
  if (s.claudeId) removeInstance(s.claudeId);
  if (live) s.stop();
  // the last tab closed while its Claude ran is the window closed; a tab
  // whose Claude exited closes itself, and that is Claude exiting
  if (tabs.size === 0) {
    if (live) windowClosed('');
    else shutdown(null);
  }
  return true;
}

const hub = {
  cwd: process.cwd(),
  get: (id) => (id != null ? tabs.get(String(id)) ?? null : null),
  list: () => [...tabs].map(([id, s]) => ({ id, state: s.state })),
  create: () => addTab([]),
  close: (id) => closeTab(String(id)),
};

addTab(args);

let finishing = false;
function finish(code = 0) {
  if (finishing) return;
  finishing = true;
  for (const s of tabs.values()) if (s.claudeId) removeInstance(s.claudeId);
  try { chat?.server.close(); } catch { /* closing */ }
  // the sockets keep the server alive; nothing else is left to do
  setTimeout(() => process.exit(code), 50).unref();
}

/** The person closed the window (not Claude exiting): the terminal it was
 *  started from goes with it (`hideterm.mjs`). */
let closedByWindow = false;
function windowClosed(why) {
  if (stopping || finishing) return;
  closedByWindow = true;
  shutdown(why || null);
}

let stopping = false;
function shutdown(why) {
  if (stopping) return;
  stopping = true;
  if (why) say(why);
  const live = [...tabs.values()].filter((s) => s.alive);
  if (live.length) {
    for (const s of live) s.stop();
    setTimeout(() => finish(lastCode), 6000).unref();
  } else {
    finish(lastCode);
  }
}

let everConnected = false;
let goneTimer = null;
chat = createChatServer(hub, {
  onClients: (n) => {
    if (n > 0) {
      everConnected = true;
      clearTimeout(goneTimer);
      goneTimer = null;
      return;
    }
    if (everConnected && !goneTimer && !stopping) {
      goneTimer = setTimeout(() => windowClosed('the window was closed; stopping Claude Code'), WINDOW_GONE_MS);
    }
  },
});

try {
  await chat.listen();
} catch (err) {
  say(`could not start the local server: ${err.message}`);
  process.exit(1);
}

// what the statusLine relay needs to find this window
for (const s of tabs.values()) { s.extraEnv = relayEnv(); register(s); }

// Claude Code boots while the window does (~1.2 s for WebKit alone), at the
// size the window last had; the window's first attach resizes it if need be
if (!noOpen) for (const s of tabs.values()) s.start(lastSize());

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig === 'SIGINT' ? 'interrupted; stopping Claude Code' : null));
}

const link = chat.link;
trace('server listening');
const opened = noOpen ? null : await openWindow(link, {
  onClose: () => windowClosed('the window was closed; stopping Claude Code'),
});
trace('window spawned');
if (opened) {
  say(`Claude Code is in a window (${opened}). Close it, or press Ctrl+C here, to end the session.`);
  // this terminal has nothing to show while the window is open: out of the
  // way until the window's last Claude exits — then it comes back — or the
  // window is closed — then it closes too (`hideterm.mjs`)
  const term = hideTerminal();
  if (term) process.on('exit', () => (closedByWindow ? term.close() : term.restore()));
} else {
  if (!noOpen) say('no browser could be opened.');
  say(`open this link (it works once): ${link}`);
}

setTimeout(() => {
  // Claude starts before the window now: a window that never came is the test
  if (!everConnected && ![...tabs.values()].some((s) => s.state === 'dead')) {
    shutdown('no window connected within 2 minutes; giving up');
  }
}, FIRST_CONNECT_MS).unref();
