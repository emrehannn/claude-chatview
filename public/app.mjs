/**
 * The window: one Claude Code session, drawn two ways.
 *
 *   * the real terminal — xterm.js attached over the socket to the pty that
 *     runs `claude`. Everything in it IS Claude Code.
 *   * the chat view (`chatview.mjs`), drawn OVER the terminal by default:
 *     the transcript Claude Code writes, and an input line that types into
 *     the same pty. The terminal keeps running under it (laid out,
 *     `visibility: hidden`, so the pty keeps the window's size) and comes
 *     back by itself whenever its screen is not the ordinary prompt — a
 *     permission prompt, a picker, `/config` — until the prompt is back.
 *
 * Ctrl+` (or the header button) switches the default between the two; the
 * choice is remembered in localStorage.
 */

import { Terminal } from './vendor/xterm/xterm.mjs';
import { FitAddon } from './vendor/addon-fit/addon-fit.mjs';
import { WebglAddon } from './vendor/addon-webgl/addon-webgl.mjs';
import { createChatView, screenState } from './chatview.mjs';
import { readScreen, messageAgent, agentReachable } from './agentpanel.mjs';

const VIEW_KEY = 'claude-chatview.view';
const FONT_KEY = 'claude-chatview.fontSize';
/** A non-prompt screen must hold this long before the terminal is shown —
 *  a command's picker flashes for a frame between its name and its Enter. */
const FALLBACK_MS = 250;
const SCROLLBACK_LINES = 5000;
const RETRY_MAX_MS = 2000;
const OUTBOX_MAX = 256;
const FONT_DEFAULT = 14;
const FONT_MIN = 9;
const FONT_MAX = 28;
const FONT_FAMILY = 'JetBrainsMono NFM Pane';
const FONT_STACK = `"${FONT_FAMILY}", "JetBrainsMono Nerd Font Mono", "JetBrains Mono", `
  + 'ui-monospace, "DejaVu Sans Mono", Menlo, monospace';
/** Seconds the window waits, after Claude Code exits, before closing itself. */
const CLOSE_AFTER_S = 3;

/** Catppuccin Mocha, opaque: a transparent canvas leaves stale glyphs
 *  behind under some WebGL drivers. */
const THEME = Object.freeze({
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#585b70',
  selectionForeground: '#cdd6f4',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#a6adc8',
  brightBlack: '#585b70',
  brightRed: '#f37799',
  brightGreen: '#89d88b',
  brightYellow: '#ebd391',
  brightBlue: '#74a8fc',
  brightMagenta: '#f2aede',
  brightCyan: '#6bd7ca',
  brightWhite: '#bac2de',
});

const mac = /Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform || navigator.platform || '');

const $ = (id) => document.getElementById(id);
const els = {
  project: $('project'), view: $('viewBtn'), screen: $('screen'),
  box: $('term'), foot: $('foot'), ended: $('ended'), endedText: $('endedText'),
  keep: $('keepOpen'),
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* not remembered */ } },
};

// ── keys ──────────────────────────────────────────────────────────────

/** Ctrl+` — the view toggle. Never reaches the pty (it would be NUL). */
const isToggleKey = (ev) => ev.ctrlKey && !ev.metaKey && !ev.altKey
  && (ev.code === 'Backquote' || ev.key === '`');

/** Ctrl+Z suspends Claude Code with no shell to resume it: never sent. */
const isSuspendKey = (ev) => ev.ctrlKey && !ev.metaKey
  && (ev.key === 'z' || ev.key === 'Z' || ev.code === 'KeyZ');

/** Cmd (Mac) / Ctrl (elsewhere) + = - 0 -> the font size. On a Mac, Ctrl+-
 *  is ^_ (readline undo), a byte the TUI is owed. */
function zoomKey(ev) {
  if (ev.altKey) return null;
  if (mac ? (!ev.metaKey || ev.ctrlKey) : (!ev.ctrlKey || ev.metaKey)) return null;
  const { key, code } = ev;
  if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') return 'in';
  if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') return 'out';
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 'reset';
  return null;
}

/** Mac editing keys a web terminal never gets: Cmd+Backspace / Left / Right
 *  -> the readline bytes a real terminal sends for them. */
const MAC_KEY_BYTES = new Map([['Backspace', '\x15'], ['ArrowLeft', '\x01'], ['ArrowRight', '\x05']]);
function macKeyBytes(ev) {
  if (!mac || ev.type !== 'keydown' || !ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  return MAC_KEY_BYTES.get(ev.key) ?? null;
}

// ── state ─────────────────────────────────────────────────────────────

let viewPref = store.get(VIEW_KEY) === 'term' ? 'term' : 'chat';
let fontSize = Number(store.get(FONT_KEY)) || FONT_DEFAULT;
let tui = false;              // the terminal is showing a dialog
let oddSince = null;
let checkTimer = null;
let driving = false;          // walking Claude Code's subagent panel for the task view
let alive = false;
let ended = null;             // {code, signal} once Claude Code has exited
let cols = 0;
let rows = 0;
let ptySize = null;           // the pty's size as the server last said

document.documentElement.style.setProperty('--cfont', `${fontSize}px`);

// the font first: xterm measures its cell once, and caches glyphs
await Promise.race([
  Promise.all(['', 'bold ', 'italic ', 'italic bold '].map(
    (f) => document.fonts.load(`${f}${fontSize}px "${FONT_FAMILY}"`))).catch(() => {}),
  new Promise((r) => setTimeout(r, 1500)),
]);

const term = new Terminal({
  allowProposedApi: true,
  cursorStyle: 'block',
  cursorBlink: false,
  fontFamily: FONT_STACK,
  fontSize,
  lineHeight: 1,
  drawBoldTextInBrightColors: false,
  scrollback: SCROLLBACK_LINES,
  theme: THEME,
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(els.box);
try {
  const gl = new WebglAddon();
  term.loadAddon(gl);
  gl.onContextLoss?.(() => { try { gl.dispose(); } catch { /* gone */ } });
} catch { /* no WebGL2: the DOM renderer */ }

const view = createChatView({
  send: (data) => sendInput(data),
  bracketed: () => term.modes?.bracketedPasteMode ?? true,
  mac,
  keyFilter: (ev) => {
    const z = zoomKey(ev);
    if (!z) return false;
    ev.preventDefault();
    zoom(z);
    return true;
  },
  onOpenTask: (task) => wsSend({ t: 'task', task }),
  onCloseTask: () => wsSend({ t: 'untask' }),
  // the task view's prompt line: Claude Code's own subagent panel, walked
  // key by key with the screen read after each (`agentpanel.mjs`)
  messageAgent: (label, text) => driveAgent(label, text),
  agentReachable: (label) => agentReachable(readScreen(term), label),
  // image paste reads the `[Image #N]` Claude Code put in its input
  screen: () => readScreen(term),
});
els.screen.append(view.root);

term.onData((data) => sendInput(data));
term.attachCustomKeyEventHandler((ev) => {
  if (isToggleKey(ev) || isSuspendKey(ev)) {
    if (ev.type === 'keydown') ev.preventDefault();
    return false;
  }
  const z = zoomKey(ev);
  if (z) {
    if (ev.type === 'keydown') { ev.preventDefault(); zoom(z); }
    return false;
  }
  const bytes = macKeyBytes(ev);
  if (bytes == null) return true;
  ev.preventDefault();
  sendInput(bytes);
  return false;
});

// The toggle must work whichever element has the keyboard — the chat input,
// xterm's hidden textarea, a button, nothing. Capture phase on the window
// runs before any of them, and every event type is stopped so no path can
// still turn the key into a byte.
for (const type of ['keydown', 'keypress', 'keyup']) {
  window.addEventListener(type, (ev) => {
    if (!isToggleKey(ev)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (type === 'keydown' && !ev.repeat) toggleView();
  }, true);
}

// A printable key typed while nothing has the keyboard belongs to Claude.
window.addEventListener('keydown', (ev) => {
  if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const t = document.activeElement;
  if (t && t !== document.body && t !== document.documentElement) return;
  if (ev.key.length !== 1 && ev.key !== 'Enter') return;
  ev.preventDefault();
  if (mode() === 'chat') view.typeInto(ev.key === 'Enter' ? '\r' : ev.key);
  else { term.focus(); sendInput(ev.key === 'Enter' ? '\r' : ev.key); }
});

// ── the two views ─────────────────────────────────────────────────────

const mode = () => (viewPref === 'term' || tui ? 'term' : 'chat');

function paintViewBtn() {
  const fallback = viewPref === 'chat' && tui;
  els.view.textContent = viewPref === 'chat' ? (fallback ? 'terminal ·' : 'chat') : 'terminal';
  els.view.classList.toggle('fallback', fallback);
  els.view.title = (fallback
    ? 'Claude Code is showing a prompt or menu the chat view does not draw — answer it here; the chat view comes back by itself'
    : viewPref === 'chat' ? 'Chat view — click for Claude Code\'s own terminal'
      : 'Claude Code\'s terminal — click for the chat view') + '  (Ctrl+`)';
}

function applyView({ focus = false } = {}) {
  const m = mode();
  const hadFocus = focus || document.activeElement !== document.body;
  view.root.hidden = m !== 'chat';
  els.box.style.visibility = m === 'chat' ? 'hidden' : '';
  document.body.dataset.view = m;
  paintViewBtn();
  // never pull the keyboard off a half-written message into a dialog
  if (hadFocus && !(m === 'term' && view.hasDraft() && !focus)) {
    if (m === 'chat') view.focus();
    else term.focus();
  }
}

function toggleView() {
  viewPref = viewPref === 'chat' ? 'term' : 'chat';
  store.set(VIEW_KEY, viewPref);
  applyView({ focus: true });
}
els.view.addEventListener('click', () => toggleView());

function scheduleCheck(ms = 60) {
  if (checkTimer) return;
  checkTimer = setTimeout(() => { checkTimer = null; checkScreen(); }, ms);
}

function checkScreen() {
  let st;
  try { st = screenState(term); } catch { st = { normal: false, blank: false, running: false }; }
  view.setRunning(st.running);
  // walking the subagent panel for the chat view: the agent's transcript
  // is on the TUI for a moment, and the task view stays where it is
  if (driving) return;
  let next = tui;
  if (st.normal || st.blank) {
    oddSince = null;
    next = false;
  } else {
    const now = performance.now();
    if (oddSince == null) oddSince = now;
    if (now - oddSince >= FALLBACK_MS) next = true;
    else scheduleCheck(FALLBACK_MS + 10);
  }
  // a finished session has no prompt to come back to: stay where we are
  if (ended) return;
  if (next !== tui) {
    tui = next;
    applyView();
  }
}

// ── size and font ─────────────────────────────────────────────────────

function refit() {
  try { fit.fit(); } catch { /* not laid out yet */ }
  const c = term.cols;
  const r = term.rows;
  if (!Number.isInteger(c) || !Number.isInteger(r)) return;
  const foreign = ptySize != null && ptySize !== `${c}x${r}`;
  if (c === cols && r === rows && !foreign) {
    try { term.refresh(0, Math.max(0, r - 1)); } catch { /* no renderer yet */ }
    return;
  }
  cols = c;
  rows = r;
  if (attached) {
    wsSend({ t: 'resize', cols, rows });
    ptySize = `${cols}x${rows}`;
  }
}
new ResizeObserver(() => refit()).observe(els.screen);

function zoom(dir) {
  let n = FONT_DEFAULT;
  if (dir === 'in') n = Math.min(FONT_MAX, fontSize + 1);
  if (dir === 'out') n = Math.max(FONT_MIN, fontSize - 1);
  if (n === fontSize) return;
  fontSize = n;
  store.set(FONT_KEY, String(n));
  document.documentElement.style.setProperty('--cfont', `${n}px`);
  term.options.fontSize = n;
  refit();
}

// ── the socket ────────────────────────────────────────────────────────

let sock = null;
let ready = false;
let attached = false;
let needsReplay = true;
let outbox = [];
let retryMs = 0;

function foot(text, cls = '') {
  els.foot.textContent = text;
  els.foot.className = `foot ${cls}`.trim();
}

function connect() {
  if (sock || ended) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  sock = ws;
  ws.onopen = () => {
    if (sock !== ws) return;
    ready = true;
    retryMs = 0;
    attach();
    const queued = outbox;
    outbox = [];
    for (const text of queued) ws.send(text);
  };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg && typeof msg === 'object') onFrame(msg);
  };
  ws.onclose = () => {
    if (sock !== ws) return;
    sock = null;
    ready = false;
    attached = false;
    needsReplay = true;
    if (ended) return;
    foot('reconnecting…', 'warn');
    retryMs = Math.min(RETRY_MAX_MS, retryMs ? retryMs * 2 : 250);
    setTimeout(connect, retryMs);
  };
}

function wsSend(msg) {
  const text = JSON.stringify(msg);
  if (ready) {
    try { sock.send(text); return; } catch { /* closing: queue it */ }
  }
  if (outbox.length < OUTBOX_MAX) outbox.push(text);
  connect();
}

function attach() {
  if (!ready) return;
  try { fit.fit(); } catch { /* not laid out */ }
  cols = term.cols;
  rows = term.rows;
  sock.send(JSON.stringify({ t: 'attach', cols, rows, replay: needsReplay }));
  sock.send(JSON.stringify({ t: 'follow' }));
  const task = view.currentTask();
  if (task) sock.send(JSON.stringify({ t: 'task', task }));
  ptySize = `${cols}x${rows}`;
  attached = true;
  needsReplay = false;
}

/** One message to a background agent through the TUI's subagent panel. */
async function driveAgent(label, text) {
  if (driving) return { ok: false, sent: false, reason: 'Still sending the last message.' };
  driving = true;
  try {
    return await messageAgent({
      screen: () => readScreen(term),
      send: (data) => sendInput(data),
    }, { label, text, bracketed: term.modes?.bracketedPasteMode ?? true });
  } finally {
    driving = false;
    oddSince = null;
    scheduleCheck();
  }
}

function sendInput(data) {
  const text = String(data).split('\x1a').join('');
  if (!text || ended) return;
  if (ptySize != null && ptySize !== `${cols}x${rows}`) refit();
  wsSend({ t: 'input', data: text });
}

function onFrame(msg) {
  switch (msg.t) {
    case 'hello':
      els.project.textContent = msg.cwdShown || msg.cwd || '';
      els.project.title = `claude ${(msg.argv || []).join(' ')}`;
      document.title = `Claude Code · ${msg.project || ''}`;
      break;
    case 'out':
      if (msg.replay) term.reset();
      term.write(msg.data, () => scheduleCheck());
      break;
    case 'state':
      alive = Boolean(msg.alive);
      if (alive) foot('running');
      else if (msg.attach && !ended) foot('starting Claude Code…');
      break;
    case 'exit':
      onExit(msg);
      break;
    case 'notice':
      term.write(`\r\n${msg.message}\r\n`);
      foot(String(msg.message).split('\n')[0], msg.level === 'error' ? 'err' : 'warn');
      if (msg.level === 'error') { tui = true; applyView(); }
      break;
    case 'size':
      ptySize = `${msg.cols}x${msg.rows}`;
      break;
    case 'tx': view.take(msg); break;
    case 'ttx': view.takeTask(msg); break;
    case 'tpeek': view.takePeek(msg); break;
    case 'ctx': view.setContext(msg); break;
    case 'resync':
      needsReplay = true;
      attach();
      break;
    case 'error':
      foot(msg.message || 'the server refused a frame', 'err');
      break;
    default:
      break;
  }
}

function onExit(msg) {
  if (ended) return;
  ended = { code: msg.code ?? null, signal: msg.signal ?? null };
  alive = false;
  const how = ended.signal ? `signal ${ended.signal}` : `exit ${ended.code}`;
  foot(`Claude Code ended (${how})`, ended.code ? 'err' : '');
  view.setRunning(false);
  els.ended.hidden = false;
  let left = CLOSE_AFTER_S;
  let timer = null;
  const paint = () => {
    els.endedText.textContent = `Claude Code ended (${how}). `
      + (timer ? `This window closes in ${left} s.` : 'You can close this window.');
  };
  // a clean exit closes the window; anything else stays up to be read
  if (ended.code === 0 && !ended.signal) {
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        timer = null;
        window.close();
        paint();
        return;
      }
      paint();
    }, 1000);
  }
  els.keep.hidden = !timer;
  els.keep.onclick = () => { clearInterval(timer); timer = null; els.keep.hidden = true; paint(); };
  paint();
}

applyView();
foot('connecting…');
connect();
view.focus();

// for scripted checks: what is on screen, without reaching into closures
window.__chatview = {
  get state() {
    return { view: mode(), pref: viewPref, tui, alive, ended, cols, rows, ptySize,
             connected: ready, fontSize };
  },
  term,
};
