/**
 * claude-chatview [claude args…]
 *
 * Runs the real Claude Code in a pseudo-terminal in the current directory,
 * with your arguments passed through, and opens a window that draws the
 * conversation as a chat — with Claude Code's own terminal one key away
 * (Ctrl+`) and shown by itself whenever Claude Code puts up a dialog.
 *
 * One window = one Claude session. Claude exits -> the window says so and
 * this process exits with its code. The window closes -> after ~10 s with
 * no connection, Claude is stopped and this process exits.
 *
 * Anything that is not an interactive session (`-p`, `--help`, `--version`,
 * a subcommand like `mcp` or `update`, piped stdin, no display) runs plain
 * `claude` in this terminal instead, so it is safe to alias `claude` to this.
 */

import { spawnSync } from 'node:child_process';
import { Session, resolveClaude } from './session.mjs';
import { createChatServer } from './server.mjs';
import { openWindow } from './browser.mjs';
import { writeInstance, removeInstance } from './runtime.mjs';

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

let chat = null;
const session = new Session({
  cwd: process.cwd(),
  bin,
  userArgs: args,
  onId: (id, old) => {
    if (old) removeInstance(old);
    if (chat && id) writeInstance(id, { url: chat.base, token: chat.secret, pid: process.pid });
  },
});

let finishing = false;
function finish(code = 0) {
  if (finishing) return;
  finishing = true;
  if (session.claudeId) removeInstance(session.claudeId);
  try { chat?.server.close(); } catch { /* closing */ }
  // the sockets keep the server alive; nothing else is left to do
  setTimeout(() => process.exit(code), 50).unref();
}

let stopping = false;
function shutdown(why) {
  if (stopping) return;
  stopping = true;
  if (why) say(why);
  if (session.alive) {
    session.stop();
    setTimeout(() => finish(session.exit?.code ?? 0), 6000).unref();
  } else {
    finish(session.exit?.code ?? 0);
  }
}

session.subscribe((ev) => {
  if (ev.kind !== 'exit') return;
  const code = Number.isInteger(ev.code) ? ev.code : (ev.signal ? 128 : 0);
  setTimeout(() => finish(code), stopping ? 0 : EXIT_LINGER_MS);
});

let everConnected = false;
let goneTimer = null;
chat = createChatServer(session, {
  onClients: (n) => {
    if (n > 0) {
      everConnected = true;
      clearTimeout(goneTimer);
      goneTimer = null;
      return;
    }
    if (everConnected && !goneTimer && !stopping) {
      goneTimer = setTimeout(() => shutdown('the window was closed; stopping Claude Code'), WINDOW_GONE_MS);
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
session.extraEnv = { CLAUDE_CHATVIEW_URL: chat.base, CLAUDE_CHATVIEW_TOKEN: chat.secret };
if (session.claudeId) {
  writeInstance(session.claudeId, { url: chat.base, token: chat.secret, pid: process.pid });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => shutdown(sig === 'SIGINT' ? 'interrupted; stopping Claude Code' : null));
}

const link = chat.link;
const opened = noOpen ? null : await openWindow(link);
if (opened) {
  say(`Claude Code is in a window (${opened}). Close it, or press Ctrl+C here, to end the session.`);
} else {
  if (!noOpen) say('no browser could be opened.');
  say(`open this link (it works once): ${link}`);
}

setTimeout(() => {
  if (!everConnected && !session.alive && session.state !== 'dead') {
    shutdown('no window connected within 2 minutes; giving up');
  }
}, FIRST_CONNECT_MS).unref();
