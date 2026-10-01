/**
 * The page's one socket: both directions, JSON text frames.
 *
 * Browser -> server
 *   {t:'attach', cols, rows, replay}  follow the session; `replay` asks for
 *        its recent output first (the page has a fresh terminal). Starts
 *        `claude` on the first attach, at the page's size.
 *   {t:'input', data}                 keystrokes, in order
 *   {t:'submit', data}                a chat message: the text, then Enter once
 *                                     the TUI has drawn it (`Session.submit`)
 *   {t:'resize', cols, rows}
 *   {t:'follow'}                      tail the transcript for the chat view
 *   {t:'task', task:{kind, id, out?}} the task view: one background agent's
 *        transcript or shell's output, read-only (`taskFile` picks the file)
 *   {t:'untask'}
 *
 * Server -> browser
 *   {t:'hello', cwd, project, argv}
 *   {t:'out', data, replay?}
 *   {t:'state' | 'exit' | 'notice' | 'size', ...}
 *   {t:'resync'}           the page fell too far behind: re-attach with replay
 *   {t:'tx', items, reset?, project?}     transcript display items
 *   {t:'ttx', task, items?|text?, reset?, missing?}
 *   {t:'tpeek', id, text, at?}  a background task's latest activity (its
 *                          newest tool call / reply line, a shell's last
 *                          output line) — sent only when it changed
 *   {t:'ctx', used, left}  the context window, from the statusLine relay
 *   {t:'error', message}
 *
 * Output is COALESCED: a streaming TUI writes hundreds of small chunks a
 * second. Chunks are gathered for `FLUSH_MS` or until `MAX_FRAME` bytes. Any
 * other event flushes the output first, so the pty's order is the page's.
 * While the socket's queue is past `HIGH_WATER`, output is held; past
 * `RESYNC_BYTES` held, it is dropped and the page told to `resync`.
 */

import os from 'node:os';
import path from 'node:path';
import { followTranscript, taskFile, peekTasks } from './transcript.mjs';
import { configDir, projectDir } from './session.mjs';

export const FLUSH_MS = 8;
export const MAX_FRAME = 64 * 1024;
export const HIGH_WATER = 1 << 20;
export const RESYNC_BYTES = 4 << 20;

const isDim = (n) => Number.isInteger(n) && n > 0 && n <= 1000;

export function serveSocket(session, conn) {
  const sub = { off: null, chunks: [], bytes: 0, timer: null, lost: false };
  let tail = null;
  let taskTail = null;
  let blocked = false;

  const send = (msg) => conn.send(JSON.stringify(msg));

  function flush() {
    if (!sub.off) return;
    if (sub.timer) { clearTimeout(sub.timer); sub.timer = null; }
    if (sub.lost) {
      if (blocked) return;
      sub.lost = false;
      send({ t: 'resync' });
      return;
    }
    if (!sub.bytes) return;
    if (blocked || conn.buffered > HIGH_WATER) {
      blocked = true;
      if (sub.bytes > RESYNC_BYTES) {
        sub.chunks = [];
        sub.bytes = 0;
        sub.lost = true;
      }
      return;
    }
    const data = sub.chunks.length === 1 ? sub.chunks[0] : sub.chunks.join('');
    sub.chunks = [];
    sub.bytes = 0;
    if (!send({ t: 'out', data })) blocked = conn.buffered > HIGH_WATER;
  }

  const offDrain = conn.onDrain(() => { blocked = false; flush(); });

  function onEvent(ev) {
    if (ev.kind === 'out') {
      if (sub.lost) return;
      sub.chunks.push(ev.data);
      sub.bytes += ev.data.length;
      if (sub.bytes >= MAX_FRAME) flush();
      else if (!sub.timer) sub.timer = setTimeout(flush, FLUSH_MS);
      return;
    }
    flush();
    const { kind, ...rest } = ev;
    send({ t: kind, ...rest });
  }

  function attach(msg) {
    const cols = Number(msg.cols);
    const rows = Number(msg.rows);
    if (!sub.off) sub.off = session.subscribe(onEvent);
    sub.chunks = [];
    sub.bytes = 0;
    sub.lost = false;
    send({ t: 'state', state: session.state, alive: session.alive,
           cols: session.cols, rows: session.rows, attach: true });
    if (session.exit) send({ t: 'exit', ...session.exit });
    if (session.context) send({ t: 'ctx', ...session.context });
    const backlog = msg.replay ? session.replay() : '';
    if (backlog) send({ t: 'out', data: backlog, replay: true });
    session.start(isDim(cols) && isDim(rows) ? { cols, rows } : null);
    if (!session.resize(cols, rows) && backlog) session.redraw();
  }

  function follow() {
    unfollow();
    // the task rows' latest activity: each running task's own file
    const peeks = peekTasks({
      cwd: session.cwd,
      where: () => ({ projectDir: projectDir(session.cwd), claudeId: session.claudeId,
                      configDir: configDir() }),
      onPeek: (pk) => send({ t: 'tpeek', ...pk }),
    });
    const t = followTranscript({
      cwd: session.cwd,
      pathFor: () => session.transcriptFile(),
      onItems: (frame) => { send({ t: 'tx', ...frame }); peeks.take(frame); },
    });
    tail = { stop() { t.stop(); peeks.stop(); } };
  }

  function unfollow() {
    if (tail) { tail.stop(); tail = null; }
  }

  async function followTask(msg) {
    untask();
    const task = msg.task && typeof msg.task === 'object' ? msg.task : {};
    const tid = String(task.id || '').slice(0, 64);
    const marker = { stop() { this.stopped = true; }, stopped: false };
    taskTail = marker;
    let file = null;
    try {
      file = await taskFile(task, { projectDir: projectDir(session.cwd),
                                    claudeId: session.claudeId, configDir: configDir() });
    } catch { file = null; }
    if (marker.stopped || taskTail !== marker) return;
    if (!file) {
      taskTail = null;
      send({ t: 'ttx', task: tid, reset: true, missing: true });
      return;
    }
    taskTail = followTranscript({
      cwd: session.cwd,
      pathFor: () => file,
      sidechain: true,
      text: task.kind === 'shell',
      onItems: (frame) => send({ t: 'ttx', task: tid, ...frame }),
    });
  }

  function untask() {
    if (taskTail) { taskTail.stop(); taskTail = null; }
  }

  conn.onMessage = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch {
      send({ t: 'error', message: 'frames are JSON objects' });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'attach': attach(msg); return;
      case 'follow': follow(); return;
      case 'unfollow': unfollow(); return;
      case 'task': followTask(msg); return;
      case 'untask': untask(); return;
      case 'input':
        if (typeof msg.data === 'string' && msg.data) session.write(msg.data);
        return;
      case 'submit':
        if (typeof msg.data === 'string' && msg.data) session.submit(msg.data);
        return;
      case 'resize': {
        const cols = Number(msg.cols);
        const rows = Number(msg.rows);
        if (isDim(cols) && isDim(rows)) session.resize(cols, rows);
        return;
      }
      default:
        send({ t: 'error', message: `unknown frame type ${JSON.stringify(msg.t)}` });
    }
  };

  const home = os.homedir();
  const cwdShown = session.cwd === home || session.cwd.startsWith(home + path.sep)
    ? `~${session.cwd.slice(home.length)}` : session.cwd;
  send({ t: 'hello', submit: true, cwd: session.cwd, cwdShown, project: path.basename(session.cwd),
         argv: session.argv });

  conn.onClose = () => {
    offDrain();
    if (sub.off) sub.off();
    if (sub.timer) clearTimeout(sub.timer);
    unfollow();
    untask();
  };
}
