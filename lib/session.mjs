/**
 * The one Claude Code this window runs: one `claude` process in a
 * pseudo-terminal, started with exactly the arguments the person typed.
 *
 * The way to look exactly like Claude Code is to run Claude Code. Modes,
 * slash commands, permission prompts, subagents, `/resume`, the token
 * counter — all of it works because it is the real thing; the chat view only
 * draws the transcript Claude Code writes and types into this pty.
 *
 * Also here: which conversation the process is in (`claudeId`), so the
 * transcript can be found. Known up front when the person named one
 * (`--session-id`, `--resume <uuid>`) or when we add `--session-id <new>`;
 * otherwise (`--continue`, a bare `--resume` picker, `--fork-session`) it is
 * discovered — from Claude Code's own `<config>/sessions/<pid>.json`, which
 * also follows `/clear` and an in-session `/resume`, else from the newest
 * transcript in the project directory written since the start.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync, realpathSync, accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** argv[0]: the person's own installed CLI, found on PATH (`resolveClaude`).
 *  `CLAUDE_CHATVIEW_CLAUDE` names another one — a wrapper, or a test double. */
export const CLAUDE_NAME = 'claude';

/**
 * The real `claude`: `CLAUDE_CHATVIEW_CLAUDE` if set, else the first `claude`
 * on PATH that is not this tool itself (someone may have linked
 * `claude -> claude-chatview`; spawning that would loop forever).
 */
export function resolveClaude({ env = process.env, self = process.argv[1] } = {}) {
  if (env.CLAUDE_CHATVIEW_CLAUDE) return env.CLAUDE_CHATVIEW_CLAUDE;
  let me = null;
  try { me = realpathSync(self); } catch { me = null; }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, CLAUDE_NAME);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isDirectory()) continue;
      const real = realpathSync(p);
      if (me && real === me) continue;
      return p;
    } catch { /* next */ }
  }
  return null;
}

const INSTALL_HINT = 'curl -fsSL https://claude.ai/install.sh | bash';

/** One write from the browser. A megabyte of paste is a mistake, not a paste. */
export const MAX_INPUT = 1 << 18;          // 256 KiB
/** pty input chunking (see `_writeChunked`): chunk size and the gap between. */
const WRITE_CHUNK = 50;
const WRITE_GAP_MS = 5;
/** One escape sequence (CSI or a two-byte ESC pair) or one code point. */
const INPUT_TOKENS = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\s\S]|[\s\S]/gu;

/**
 * Ctrl+Z — the one byte never passed on. Claude Code answers 0x1A by
 * suspending itself with SIGTSTP; a real terminal has a shell to `fg` it
 * back, this window has none, so the session would look dead for good.
 */
export const SUSPEND_BYTE = '\x1a';

/** How much TUI output is kept for a page that (re)attaches. A screenful,
 *  not a history: the conversation itself is Claude Code's transcript. */
export const SCROLLBACK_BYTES = 256 * 1024;
/** A complete wipe (RIS, or erase-scrollback): a replay can begin there. */
const WIPES = ['\x1bc', '\x1b[3J'];
/** Claude Code wraps every repaint in a synchronized update (CSI ? 2026 h). */
const FRAME_START = '\x1b[?2026h';

/** Where a replay of `text` should begin — see the constants above. */
export function replayStart(text, limit = SCROLLBACK_BYTES, { whole = false } = {}) {
  const cut = Math.max(0, text.length - limit);
  const wiped = Math.max(...WIPES.map((w) => text.lastIndexOf(w)));
  if (wiped >= cut) return wiped;
  if (cut === 0 && whole) return 0;
  const frame = text.indexOf(FRAME_START, cut);
  if (frame >= 0) return frame;
  const line = text.indexOf('\n', cut);
  return line >= 0 ? line + 1 : cut;
}

const KILL_GRACE_MS = 4000;
/** How long `redraw()` holds the narrower width before restoring it. */
const REDRAW_NUDGE_MS = 60;
/** How often the conversation id is re-read from Claude Code's own files. */
const TRACK_MS = 1000;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function configDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** `<config>/projects/<cwd with every non-alphanumeric as ->`. */
export function projectDir(cwd, env = process.env) {
  const slug = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(configDir(env), 'projects', slug);
}

/** Where Claude Code keeps a conversation's transcript. */
export function transcriptPath(cwd, sessionId, env = process.env) {
  return path.join(projectDir(cwd, env), `${sessionId}.jsonl`);
}

/** What a running Claude Code says it is doing (not a documented
 *  interface, so read soft: anything odd is "no answer"). */
export function liveSessionId(pid, env = process.env) {
  if (!pid) return null;
  try {
    const rec = JSON.parse(readFileSync(path.join(configDir(env), 'sessions', `${pid}.json`), 'utf8'));
    if (rec && Number(rec.pid) === Number(pid) && typeof rec.sessionId === 'string'
        && UUID_RE.test(rec.sessionId)) return rec.sessionId;
  } catch { /* none, or not ours */ }
  return null;
}

/** The newest `<uuid>.jsonl` in `dir` modified at or after `sinceMs`. */
export function newestTranscript(dir, sinceMs = 0) {
  let best = null;
  let bestAt = -1;
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || !UUID_RE.test(name.slice(0, -6))) continue;
    let at;
    try { at = statSync(path.join(dir, name)).mtimeMs; } catch { continue; }
    if (at >= sinceMs && at > bestAt) { best = name.slice(0, -6); bestAt = at; }
  }
  return best;
}

const valueOf = (args, i) => {
  const a = args[i];
  const eq = a.indexOf('=');
  if (a.startsWith('--') && eq > 0) return { value: a.slice(eq + 1), used: 0 };
  const next = args[i + 1];
  if (next === undefined || next.startsWith('-')) return { value: null, used: 0 };
  return { value: next, used: 1 };
};

/**
 * Decide the command line and how the conversation id is known.
 *
 *   * `--session-id <uuid>`         -> that id
 *   * `--resume <uuid>` / `-r`      -> that id (unless `--fork-session`)
 *   * `--continue`, bare `--resume`, `--resume <search>`, `--fork-session`
 *                                   -> discovered (`mode: 'watch'`)
 *   * nothing                       -> `--session-id <new uuid>` is added
 *
 * Returns `{argv, claudeId, mode}`, mode `known` | `watch`, and for
 * `--continue` `continue: true` (the newest transcript at start is what it
 * continues, until something newer is written).
 */
export function planArgs(userArgs, { newId = randomUUID } = {}) {
  const args = [...userArgs];
  let sessionId = null;
  let resume = null;
  let resumeBare = false;
  let cont = false;
  let fork = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') break;
    if (a === '--session-id' || a.startsWith('--session-id=')) {
      const v = valueOf(args, i);
      sessionId = v.value;
      i += v.used;
    } else if (a === '--resume' || a === '-r' || a.startsWith('--resume=')) {
      const v = valueOf(args, i);
      if (v.value && UUID_RE.test(v.value)) resume = v.value;
      else resumeBare = true;
      i += v.used;
    } else if (a === '--continue' || a === '-c') {
      cont = true;
    } else if (a === '--fork-session') {
      fork = true;
    }
  }
  if (sessionId && UUID_RE.test(sessionId) && !resume && !resumeBare && !cont) {
    return { argv: args, claudeId: sessionId, mode: 'known' };
  }
  if (resume && !fork) return { argv: args, claudeId: resume, mode: 'known' };
  if (resume || resumeBare || cont || fork || sessionId) {
    return { argv: args, claudeId: null, mode: 'watch', continue: cont && !fork };
  }
  const id = newId();
  return { argv: ['--session-id', id, ...args], claudeId: id, mode: 'known' };
}

/**
 * Markers Claude Code sets for processes IT starts. This window's session is
 * not anybody's child — but the tool may have been started from inside a
 * Claude session, and an inherited `CLAUDE_CODE_CHILD_SESSION` switches
 * transcript saving off, which would leave the chat view empty.
 */
const INHERITED_SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
];

/** The UTF-8 character type, when the environment has none (a launcher
 *  that sets no LANG makes clipboard tools read input as a legacy charset). */
export function utf8Locale(env) {
  const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (/utf-?8/i.test(effective)) return {};
  const out = { LC_CTYPE: process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8' };
  if (!env.LANG) out.LANG = out.LC_CTYPE;
  return out;
}

export function buildEnv(base = process.env, extra = {}) {
  const env = { ...base };
  for (const key of INHERITED_SESSION_MARKERS) delete env[key];
  delete env.CLAUDE_CHATVIEW_CLAUDE;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  Object.assign(env, utf8Locale(env), extra);
  return env;
}

const isDim = (n) => Number.isInteger(n) && n > 0 && n <= 1000;

export class Session {
  /**
   * @param {object} o
   * @param {string} o.cwd
   * @param {string} [o.bin]    the `claude` to run (`resolveClaude`)
   * @param {string[]} o.userArgs  what the person typed after `claude`
   * @param {object} [o.env]       extra environment for the child
   * @param {(id: string|null, old: string|null) => void} [o.onId]
   */
  constructor({ cwd, bin, userArgs = [], env = {}, onId = null }) {
    this.cwd = cwd;
    this.bin = bin || CLAUDE_NAME;
    this.plan = planArgs(userArgs);
    this.argv = this.plan.argv;
    this.claudeId = this.plan.claudeId;
    this.extraEnv = env;
    this.onId = onId || (() => {});
    this.cols = 100;
    this.rows = 30;
    this.pid = null;
    this.state = 'idle';           // idle | live | dead
    this.startedAt = null;
    this.exit = null;
    this.context = null;           // {used, left} from the statusLine relay
    this._pty = null;
    this._term = null;
    this._chunks = [];
    this._bytes = 0;
    this._dropped = false;
    this._subs = new Set();
    this._sized = false;
    this._loading = null;
    this._pending = [];
    this._wq = [];
    this._wqTimer = null;
    this._track = null;
  }

  get alive() { return this.state === 'live'; }

  transcriptFile() {
    return this.claudeId ? transcriptPath(this.cwd, this.claudeId) : null;
  }

  replay() {
    const all = this._chunks.join('');
    this._chunks = all ? [all] : [];
    this._bytes = all.length;
    return all.slice(replayStart(all, SCROLLBACK_BYTES, { whole: !this._dropped }));
  }

  _keep(text) {
    this._chunks.push(text);
    this._bytes += text.length;
    while (this._chunks.length > 1
           && this._bytes - this._chunks[0].length >= SCROLLBACK_BYTES) {
      this._bytes -= this._chunks.shift().length;
      this._dropped = true;
    }
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(ev) {
    for (const fn of [...this._subs]) {
      try { fn(ev); } catch { /* one dead listener must not stop the stream */ }
    }
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this._emit({ kind: 'state', state, alive: this.alive });
  }

  _notice(level, message) { this._emit({ kind: 'notice', level, message }); }

  /** Fork the process, once. `geom` is the page's size at its first attach. */
  start(geom = null) {
    if (this._term || this.state === 'dead' || this._loading) return this;
    if (geom && isDim(geom.cols) && isDim(geom.rows) && !this._sized) {
      this.cols = geom.cols;
      this.rows = geom.rows;
    }
    if (!this._pty) {
      this._loading = import('node-pty').then((mod) => {
        this._loading = null;
        this._pty = mod.default?.spawn ? mod.default : mod;
        this._spawn();
      }).catch((err) => {
        this._loading = null;
        this._fail(`the terminal backend (node-pty) is not usable: ${err?.message || err}`
          + '\r\n\r\nRe-run ./install.sh — it rebuilds node-pty and names the '
          + 'compiler packages your system needs.\r\n');
      });
      return this;
    }
    this._spawn();
    return this;
  }

  _fail(message) {
    this._term = null;
    this.pid = null;
    this.exit = { code: 127, signal: null };
    this._setState('dead');
    this._notice('error', message);
    this._emit({ kind: 'exit', code: 127, signal: null });
  }

  _spawn() {
    let term;
    try {
      term = this._pty.spawn(this.bin, this.argv, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: buildEnv(process.env, this.extraEnv),
      });
    } catch (err) {
      this._fail(`\`${this.bin}\` did not start: ${err?.message || err}\r\n\r\n`
        + `If it is not installed:\r\n\r\n  ${INSTALL_HINT}\r\n`);
      return;
    }
    this._term = term;
    this.pid = term.pid ?? null;
    this.startedAt = Date.now();
    this._setState('live');
    if (this._pending.length) {
      for (const text of this._pending.splice(0)) {
        try { this._writeChunked(text); } catch { /* it just died */ }
      }
    }
    term.onData((data) => {
      const text = String(data);
      this._keep(text);
      this._emit({ kind: 'out', data: text });
    });
    term.onExit(({ exitCode, signal }) => {
      this._term = null;
      this.pid = null;
      this.exit = { code: exitCode ?? null, signal: signal ?? null };
      clearInterval(this._track);
      this._setState('dead');
      this._emit({ kind: 'exit', code: exitCode ?? null, signal: signal ?? null });
    });
    this._startTracking();
  }

  /** Follow which conversation the process is in. */
  _startTracking() {
    const since = this.startedAt - 2000;
    const dir = projectDir(this.cwd);
    // `--continue` continues the newest conversation there is: show it until
    // something newer is written
    if (!this.claudeId && this.plan.continue) this._setId(newestTranscript(dir, 0));
    const tick = () => {
      let id = liveSessionId(this.pid);
      if (!id && this.plan.mode === 'watch') {
        const fresh = newestTranscript(dir, since);
        if (fresh) id = fresh;
      }
      if (id) this._setId(id);
    };
    tick();
    this._track = setInterval(tick, TRACK_MS);
    this._track.unref?.();
  }

  _setId(id) {
    if (!id || id === this.claudeId) return;
    const old = this.claudeId;
    this.claudeId = id;
    try { this.onId(id, old); } catch { /* the caller's problem */ }
  }

  /** Bytes from the browser, untouched but for `SUSPEND_BYTE`. */
  write(data) {
    const raw = String(data ?? '');
    const text = raw.split(SUSPEND_BYTE).join('');
    if (!text) return Boolean(raw);
    if (text.length > MAX_INPUT) {
      this._notice('warn', `input of ${text.length} characters refused (the limit is ${MAX_INPUT}). `
        + 'Put the bulk in a file and ask Claude to read it.');
      return false;
    }
    if (!this._term) {
      if (this.state !== 'dead' && this._pending.length < 64) this._pending.push(text);
      return false;
    }
    this._writeChunked(text);
    return true;
  }

  /**
   * Into the pty in small pieces, in order. macOS's pty input queue holds
   * about 1 KB; a bigger single write overflows it and the start of a long
   * prompt vanishes. An escape sequence is never split across chunks: a lone
   * ESC arriving on its own reads as the Esc key.
   */
  _writeChunked(text) {
    if (!this._wq.length && text.length <= WRITE_CHUNK) {
      this._term.write(text);
      return;
    }
    let cur = '';
    for (const tok of text.match(INPUT_TOKENS) || []) {
      if (cur && cur.length + tok.length > WRITE_CHUNK) { this._wq.push(cur); cur = ''; }
      cur += tok;
    }
    if (cur) this._wq.push(cur);
    if (this._wqTimer) return;
    const pump = () => {
      this._wqTimer = null;
      const next = this._wq.shift();
      if (next === undefined || !this._term) { this._wq.length = 0; return; }
      try { this._term.write(next); } catch { this._wq.length = 0; return; }
      if (this._wq.length) this._wqTimer = setTimeout(pump, WRITE_GAP_MS);
    };
    pump();
  }

  /** SIGWINCH, so the TUI lays itself out to the page. */
  resize(cols, rows) {
    if (!isDim(cols) || !isDim(rows)) return false;
    if (cols === this.cols && rows === this.rows) return false;
    this.cols = cols;
    this.rows = rows;
    this._sized = true;
    this._emit({ kind: 'size', cols, rows });
    if (this._term) {
      try { this._term.resize(cols, rows); } catch { /* the pty is going */ }
    }
    return true;
  }

  /** Make the TUI repaint at its current size: one column narrower, then
   *  back — a replayed byte tail cannot lay itself out, a SIGWINCH can. */
  redraw() {
    const term = this._term;
    if (!term) return false;
    const nudge = this.cols > 1 ? this.cols - 1 : this.cols + 1;
    try { term.resize(nudge, this.rows); } catch { return false; }
    setTimeout(() => {
      if (this._term !== term) return;
      try { term.resize(this.cols, this.rows); } catch { /* the pty is going */ }
    }, REDRAW_NUDGE_MS).unref?.();
    return true;
  }

  setContext(used, left) {
    const pct = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
      ? Math.round(v * 10) / 10 : null);
    let u = pct(used);
    let l = pct(left);
    if (u === null && l !== null) u = Math.round((100 - l) * 10) / 10;
    if (l === null && u !== null) l = Math.round((100 - u) * 10) / 10;
    if (u === null) return false;
    if (this.context?.used === u && this.context?.left === l) return true;
    this.context = { used: u, left: l };
    this._emit({ kind: 'ctx', used: u, left: l });
    return true;
  }

  /** End the whole tree: node-pty puts the child in its own session, so the
   *  process group is exactly this Claude and whatever it spawned. */
  stop(signal = 'SIGHUP') {
    const term = this._term;
    if (!term) return false;
    const pid = term.pid;
    const end = (sig) => {
      try { process.kill(-pid, sig); } catch {
        try { term.kill(sig); } catch { /* gone */ }
      }
    };
    end(signal);
    setTimeout(() => {
      if (this._term && this._term.pid === pid) end('SIGKILL');
    }, KILL_GRACE_MS).unref?.();
    return true;
  }
}
