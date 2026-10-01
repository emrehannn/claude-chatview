/**
 * The chat view — a rendering layer over the real Claude Code, never a
 * replacement for it. Everything Claude Code can do still works: commands,
 * Esc to interrupt, modes; where this view has no drawing for a screen (a
 * dialog, a picker, a permission prompt), the real terminal is shown.
 *
 * So the `claude` in the pty is untouched and keeps its xterm (hidden under
 * this view, still laid out so its size stays right). This view:
 *
 *   * DRAWS the transcript Claude Code writes (`lib/transcript.mjs` sends it
 *     as display items over the pane's socket): `> prompt`, `● reply`,
 *     `● tool args` with a dim `⎿ result` line;
 *   * TYPES into the pty: the input line sends its text as keystrokes, then
 *     Enter — so `/model`, `/config`, `!cmd`, Esc (interrupt), Ctrl+C and
 *     Shift+Tab (mode) are Claude Code's own, not re-implemented here;
 *   * STEPS ASIDE: whenever the TUI's screen is not its ordinary prompt — a
 *     permission prompt, a picker, a dialog, `/config` — the pane shows the
 *     real terminal until the prompt is back (`screenState`). When in doubt
 *     the terminal is shown: nobody may be left unable to answer a prompt.
 */
import { renderMarkdown } from './markdown.mjs';
import { panelState, UNREACHABLE } from './agentpanel.mjs';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** a rule line: nothing but `─` (a narrow pane wraps it, leaving a stub) */
const RULE = /^─{2,}\s*$/;
/** the rule above the input may carry a label: the session's title, or an
 *  open agent's description (`──── night watch ─`) */
const RULE_ABOVE = /^─{2,}(?:\s.+?\s─+)?\s*$/;
/** Claude Code's spinner line while it works: `✻ Cooking… (2s · ↓ 211 tokens …)` */
const SPINNER = /^\S\s+\S.*…\s*\((?:\d+[hms]|esc|.*\btokens?\b)/;

/**
 * What the TUI's screen is showing, read from the emulator's buffer.
 *
 *   normal  — the ordinary prompt: a `❯` line at column 0 between two rule
 *             lines, near the bottom. True while Claude is working too (the
 *             input box stays up), false for every dialog and picker, which
 *             replace the input box (permission prompt, /config, /model,
 *             /resume, the trust dialog, AskUserQuestion…). False too while
 *             a background agent's transcript is open in the TUI (its row
 *             in the subagent panel carries the `⏺`): typing goes to that
 *             agent there, so the chat view must not look like main.
 *   menu    — the prompt is up AND a slash-command list sits above it (the
 *             input starts with `/`): transient while a command is typed.
 *   blank   — nothing drawn yet (the TUI is starting).
 *   running — the spinner line is on screen.
 */
export function screenState(term) {
  const buf = term?.buffer?.active;
  if (!buf) return { normal: false, blank: true, running: false, menu: false };
  const rows = term.rows;
  const lines = [];
  for (let i = 0; i < rows; i += 1) {
    lines.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? '');
  }
  const blank = lines.every((l) => !l.trim());
  let normal = false;
  let menu = false;
  // the LAST prompt line that has a rule above it and a rule below it
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (!lines[i].startsWith('❯')) continue;
    if (!RULE_ABOVE.test(lines[i - 1])) continue;
    let below = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
      if (RULE.test(lines[j])) { below = j; break; }
    }
    if (below < 0) continue;
    normal = panelState({ lines, cx: 0, cy: -1 }).onMain;
    menu = /^❯\s*\//.test(lines[i]) && /^\s+\/\S/.test(lines[i - 2] || '');
    break;
  }
  const running = lines.some((l) => SPINNER.test(l));
  return { normal, blank, running, menu };
}

/** `text` without these `[Image #N]` tokens, nor the space beside each */
function withoutTokens(text, toks) {
  let v = text;
  for (const tok of toks) {
    const esc = tok.replace(/[[\]#]/g, '\\$&');
    v = v.replace(new RegExp(`( ?)${esc}( ?)`, 'g'), (m, a, b) => (a && b ? ' ' : ''));
  }
  return v;
}

/**
 * The `[Image #N]` placeholders in the TUI's own input box, in order; null
 * when no prompt is on screen. Claude Code (2.1.286, measured) inserts one
 * per Ctrl+V — `[Image #1]`, then ` [Image #2]` — numbered on from the last
 * one ever pasted (a deleted number is not reused), and wraps a long input
 * onto `  `-indented rows, sometimes inside a token (`[Image` / `#10]`):
 * the rows are joined and whitespace dropped before matching.
 */
export function tuiImages(scr) {
  const st = panelState(scr);
  if (st.prompt < 0) return null;
  const rows = [];
  for (let j = st.prompt; j < scr.lines.length; j += 1) {
    if (j > st.prompt && RULE.test(scr.lines[j])) break;
    rows.push(scr.lines[j].slice(2));
  }
  return [...rows.join('').replace(/\s+/g, '').matchAll(/\[Image#(\d+)\]/g)]
    .map((m) => `[Image #${m[1]}]`);
}

// ── the `/` dropdown's list, shared by every chat ─────────────────────
// `GET api/commands` (server-side `lib/commands.mjs`: Claude Code's
// built-ins, project + user skills and commands, enabled plugins'), kept
// here for 30 s. Fetched on the first `/`, never on page load.
const COMMANDS_TTL_MS = 30_000;
let commandsCache = null;
let commandsAt = 0;
let commandsLoading = null;

function commandList() {
  if (commandsCache && Date.now() - commandsAt > COMMANDS_TTL_MS) loadCommands();
  return commandsCache;
}

function loadCommands() {
  if (!commandsLoading) {
    commandsLoading = fetch('api/commands')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (Array.isArray(body?.commands)) {
          commandsCache = body.commands.filter((c) => c && typeof c.name === 'string');
          commandsAt = Date.now();
        }
      })
      .catch(() => {})
      .finally(() => { commandsLoading = null; });
  }
  return commandsLoading;
}

/** Shift+Enter, Esc, Ctrl+C, Shift+Tab → the bytes the TUI expects, or null. */
function keyBytes(ev, mac) {
  if (ev.key === 'Escape') return '\x1b';
  if (ev.key === 'Tab' && ev.shiftKey) return '\x1b[Z';
  if (ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C')) {
    // Ctrl+C copies on Windows/Linux when something is selected
    if (!mac && String(globalThis.getSelection?.() || '')) return null;
    return '\x03';
  }
  return null;
}

/** `at` (ISO) -> the person's local HH:MM, or '' when there is none. */
function clock(at) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function resultLine(parent, text, error) {
  const r = el('div', `tx-result${error ? ' err' : ''}`);
  r.append(el('span', 'tx-elbow', '⎿'), el('span', 'tx-rtext', text));
  parent.append(r);
}

/** Thumbnails for images (data: URLs from the transcript); a click shows one
 *  full size over the page, a second click or Esc closes it. */
function imageStrip(parent, images, onLayout = () => {}) {
  if (!images?.length) return;
  const strip = el('div', 'tx-imgs');
  for (const im of images) {
    if (!im.url) { strip.append(el('span', 'tx-dim', `[${im.note || 'image'}]`)); continue; }
    const img = el('img', 'tx-img');
    img.src = im.url;
    img.alt = 'image';
    img.loading = 'lazy';
    img.addEventListener('load', () => onLayout(), { once: true });
    img.addEventListener('click', () => {
      const box = el('div', 'tx-lightbox');
      const big = el('img', '');
      big.src = im.url;
      box.append(big);
      const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
      const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(); } };
      box.addEventListener('click', close);
      document.addEventListener('keydown', onKey, true);
      document.body.append(box);
    });
    strip.append(img);
  }
  parent.append(strip);
}

/** A preview line that opens to the full text (markdown) on click. */
function expandable(body, label, text, onLayout = () => {}) {
  const head = el('div', 'tx-xhead');
  if (label) head.append(el('b', 'tx-tname', label), document.createTextNode(' '));
  const first = String(text).split('\n').find((l) => l.trim()) || '';
  const preview = el('span', 'tx-xprev', first.length > 160 ? `${first.slice(0, 160)}…` : first);
  const more = el('span', 'tx-xmore', '  ▸ expand');
  head.append(preview, more);
  const full = el('div', 'tx-xfull tx-md');
  full.hidden = true;
  head.addEventListener('click', () => {
    if (!full.dataset.drawn) { full.innerHTML = renderMarkdown(text); full.dataset.drawn = '1'; }
    full.hidden = !full.hidden;
    preview.hidden = !full.hidden;
    more.textContent = full.hidden ? '  ▸ expand' : '  ▾ collapse';
    onLayout();
  });
  body.append(head, full);
}

/**
 * Draws display items into one list — the chat's, or a background agent's
 * own transcript in the task view (one look for both).
 *
 * @param {HTMLElement} list
 * @param {object} [o]
 * @param {() => void} [o.onTurn]    a new turn was started
 * @param {() => void} [o.onLayout]  something changed height (an expand)
 * @param {(it: object) => void} [o.onTask]  a background-task item
 * @param {boolean} [o.briefs]  a long prompt folds to one line (an agent's brief)
 */
function createRenderer(list, { onTurn = () => {}, onLayout = () => {}, onTask = null,
                               briefs = false } = {}) {
  /** tool_use id -> its element, so a result lands under its call */
  const tools = new Map();
  let turn = null;
  // back-to-back Bash calls share one `● Bash` block: one line per call (what
  // it is for), the command and its output only on click
  let bash = null;
  // items arriving live (not a first look / replay) ease in
  let live = false;

  function newTurn() {
    bash = null;
    if (turn) turn.classList.remove('last');
    turn = el('section', 'tx-turn last');
    list.append(turn);
    onTurn();
    return turn;
  }

  /** Claude's side of a turn, between two orange lines. */
  function respBox() {
    const t = turn || newTurn();
    if (!t.resp) { t.resp = el('div', 'tx-resp'); t.append(t.resp); }
    return t.resp;
  }

  function dotLine(cls, dotCls) {
    const row = el('div', `tx-item ${cls}`);
    row.append(el('span', `tx-dot ${dotCls || ''}`.trim(), '●'));
    const body = el('div', 'tx-body');
    row.append(body);
    if (live) row.classList.add('tx-new');
    respBox().append(row);
    return body;
  }

  function bashPaint(g) {
    g.dot.classList.toggle('pending', g.pending > 0);
    g.dot.classList.toggle('err', g.err > 0);
    g.count.textContent = g.n > 1 ? ` · ${g.n} commands` : '';
    g.body.classList.toggle('multi', g.n > 1);
  }

  function bashRow(it) {
    if (!bash) {
      const body = dotLine('tx-tool tx-bash', 'pending');
      // one call: `● Bash  what it is for ▸` on one line; several: a
      // `● Bash · N commands` line with each call under it behind ⎿
      const count = el('span', 'tx-bcount', '');
      const head = el('div', 'tx-bhead');
      head.append(el('b', 'tx-tname', 'Bash'), count);
      const rows = el('div', 'tx-brows');
      body.classList.add('tx-bashbody');
      body.append(head, rows);
      bash = { body, rows, count, dot: body.parentElement.querySelector('.tx-dot'), n: 0, pending: 0, err: 0 };
    }
    const g = bash;
    const row = el('div', 'tx-brow pending');
    const line = el('div', 'tx-xhead');
    const more = el('span', 'tx-xmore', '  ▸');
    line.append(el('span', 'tx-belbow', '⎿'), el('span', 'tx-bdesc', it.args || '(command)'), more);
    const full = el('div', 'tx-xfull tx-md');
    full.hidden = true;
    row.append(line, full);
    row.group = g;
    line.addEventListener('click', () => {
      if (!full.dataset.drawn) {
        full.innerHTML = renderMarkdown(it.detail || '');
        if (row.result) {
          resultLine(full, row.result.text, row.result.error);
          imageStrip(full, row.result.images, onLayout);
        }
        full.dataset.drawn = '1';
      }
      full.hidden = !full.hidden;
      more.textContent = full.hidden ? '  ▸' : '  ▾';
      onLayout();
    });
    g.rows.append(row);
    g.n += 1; g.pending += 1;
    bashPaint(g);
    return row;
  }

  function bashResult(row, it) {
    if (row.result) return;
    row.result = { text: it.text, error: it.error, images: it.images };
    row.classList.remove('pending');
    if (it.error) row.classList.add('err');
    const g = row.group;
    g.pending = Math.max(0, g.pending - 1);
    if (it.error) g.err += 1;
    bashPaint(g);
    const full = row.querySelector('.tx-xfull');
    if (full?.dataset.drawn) resultLine(full, it.text, it.error);
  }

  /** One item; returns the turn it started, if it started one. */
  function add(it) {
    // anything Claude says or does between two Bash calls closes the block
    // (queue bookkeeping and task updates draw nothing here, so they never split a block)
    if (!['result', 'turn', 'task', 'unqueue', 'queued'].includes(it.k) && !(it.k === 'tool' && it.name === 'Bash')) {
      bash = null;
    }
    switch (it.k) {
      case 'user':
      case 'cmd': {
        // a queued prompt that has now been taken
        for (const q of list.querySelectorAll('.tx-queued')) {
          if (q.dataset.text === it.text) q.remove();
        }
        const t = newTurn();
        if (briefs && it.k === 'user' && it.text.length > 240) {
          // an agent's brief: one line, the rest on click
          const row = el('div', 'tx-item tx-user tx-brief');
          row.append(el('span', 'tx-caret', '>'));
          const body = el('div', 'tx-body');
          row.append(body);
          expandable(body, 'brief', it.text, onLayout);
          t.append(row);
          return t;
        }
        const row = el('div', `tx-item tx-user${it.k === 'cmd' ? ' tx-cmd' : ''}`);
        const utext = el('span', 'tx-utext');
        // `[Image #N]` is Claude Code's placeholder for an image sent with
        // the prompt: a small tag, the thumbnail itself is drawn underneath
        for (const part of String(it.text).split(/(\[Image #\d+\])/)) {
          if (!part) continue;
          if (/^\[Image #\d+\]$/.test(part)) utext.append(el('span', 'tx-imgtag', part));
          else utext.append(part);
        }
        row.append(el('span', 'tx-caret', '>'), utext);
        const time = clock(it.at);
        if (time) row.append(el('span', 'tx-time', time));
        t.append(row);
        if (it.images?.length) {
          // under the prompt, indented like its text
          const wrap = el('div', 'tx-uimgs');
          imageStrip(wrap, it.images, onLayout);
          t.append(wrap);
        }
        return t;
      }
      case 'unqueue':
        for (const q of list.querySelectorAll('.tx-queued')) {
          if (q.dataset.text === it.text) q.remove();
        }
        break;
      case 'queued': {
        const row = el('div', 'tx-item tx-user tx-queued');
        row.dataset.text = it.text;
        row.append(el('span', 'tx-caret', '>'), el('span', 'tx-utext', it.text),
                   el('span', 'tx-dim', '  queued'));
        list.append(row);
        break;
      }
      case 'text': {
        const body = dotLine('tx-text');
        body.classList.add('tx-md');
        body.innerHTML = renderMarkdown(it.text);
        if (live) {
          // a reply is logged whole, so it cannot stream token by token: its
          // paragraphs, lists and code blocks flow in one after another instead
          body.classList.add('tx-reveal');
          [...body.children].forEach((ch, i) => ch.style.setProperty('--i', String(Math.min(i, 14))));
        }
        break;
      }
      case 'tool': {
        if (it.name === 'Bash') {
          const row = bashRow(it);
          if (it.id) tools.set(it.id, row);
          break;
        }
        const body = dotLine('tx-tool', 'pending');
        if (it.detail) {
          // an Agent brief / a SendMessage: the line opens to the full text
          expandable(body, it.name, it.args ? `${it.args}\n\n${it.detail}` : it.detail, onLayout);
          body.querySelector('.tx-xprev').textContent = ` ${it.args || ''}`;
        } else {
          body.append(el('b', 'tx-tname', it.name));
          if (it.args) body.append(el('span', 'tx-targs', ` ${it.args}`));
        }
        body.dataset.args = it.args || '';
        if (it.id) tools.set(it.id, body);
        break;
      }
      case 'peer': {
        // a message an agent sent back: one line, the rest on click
        const body = dotLine('tx-peer');
        expandable(body, 'agent', it.text, onLayout);
        break;
      }
      case 'result': {
        const body = tools.get(it.id);
        if (body?.group) { bashResult(body, it); break; }
        if (body) {
          const dot = body.parentElement?.querySelector('.tx-dot');
          dot?.classList.remove('pending');
          if (it.error) dot?.classList.add('err');
          resultLine(body, it.text, it.error);
          imageStrip(body, it.images, onLayout);
        } else {
          resultLine(respBox(), it.text, it.error);
          imageStrip(respBox(), it.images, onLayout);
        }
        break;
      }
      case 'out':
        resultLine(respBox(), it.text, false);
        break;
      case 'interrupt':
        resultLine(respBox(), 'Interrupted · What should Claude do instead?', true);
        break;
      case 'note':
        respBox().append(el('div', 'tx-note', `— ${it.text} —`));
        break;
      case 'turn':
        // a finished turn: tools that never got a result were cut off
        for (const d of (turn || list).querySelectorAll('.tx-dot.pending')) {
          d.classList.remove('pending');
        }
        break;
      case 'task':
        onTask?.(it);
        break;
      default:
        break;
    }
    return null;
  }

  return {
    setLive(v) { live = Boolean(v); },
    add,
    reset() { list.replaceChildren(); tools.clear(); turn = null; },
    get turn() { return turn; },
    /** a tool call's args line — a task chip's label when it has none */
    toolArgs: (id) => tools.get(id)?.dataset.args || '',
  };
}

// ── background tasks ──────────────────────────────────────────────────
/** A finished task stays on the strip this long. */
const TASK_LINGER_MS = 5 * 60_000;
/** A task "running" this long is from a Claude that is gone: not shown. */
const TASK_STALE_MS = 24 * 3600_000;
/** Most output text the task view holds for a shell. */
const TASK_TEXT_MAX = 400_000;

/** 3s · 4m 05s · 1h 12m */
function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** completed -> done; failed / killed / stopped -> failed */
const taskTone = (status) => (status === 'running' ? 'running'
  : status === 'completed' ? 'done' : 'failed');

/**
 * One chat's view.
 *
 * @param {object} o
 * @param {(data: string) => void} o.send   keystrokes into this chat's pty
 * @param {(data: string) => void} [o.submitText]  a chat message: text the server types, then Enter once drawn
 * @param {() => boolean} o.bracketed       does the TUI accept bracketed paste
 * @param {boolean} o.mac
 * @param {(ev: KeyboardEvent) => boolean} [o.keyFilter]  the pane's own keys
 *        (zoom); true = handled, do nothing more
 * @param {(task: {kind: string, id: string, out?: string}) => void} [o.onOpenTask]
 *        a task chip was opened: tail that task (`{t:'task'}` on the socket)
 * @param {() => void} [o.onCloseTask]  the task view was closed
 * @param {(label: string, text: string) => Promise<{ok: boolean, sent: boolean, reason?: string}>} [o.messageAgent]
 *        send to a background agent through Claude Code's subagent panel
 *        (`agentpanel.mjs`, driven by the page)
 * @param {(label: string) => boolean|null} [o.agentReachable]  is its row
 *        in that panel now (null: the screen cannot tell)
 * @param {() => {lines: string[], cx: number, cy: number}} [o.screen]  the
 *        TUI's screen (`readScreen`): image paste reads its `[Image #N]`
 */
/** A prompt longer than this is sent as a paste, never as typed keys. */
const PASTE_OVER = 200;

export function createChatView({ send, submitText = null, bracketed = () => true, mac = false, keyFilter = null,
                                 onOpenTask = null, onCloseTask = null,
                                 messageAgent = null, agentReachable = null, screen = null }) {
  const root = el('div', 'cchat');
  const scroll = el('div', 'cchat-scroll');
  const head = el('div', 'tx-head');
  const list = el('div', 'cchat-list');
  const empty = el('div', 'tx-empty', 'Ask Claude anything.');
  const status = el('div', 'cchat-status');
  const inputRow = el('div', 'cchat-input');
  // blank room UNDER the prompt line, so a new prompt can scroll to the top
  // while the input stays right under the last reply
  const tail = el('div', 'cchat-tail');
  const caret = el('span', 'tx-caret', '>');
  const input = el('textarea', 'cchat-ta');
  input.rows = 1;
  input.spellcheck = false;
  const PLACEHOLDER = 'Message Claude…';
  input.placeholder = PLACEHOLDER;
  input.title = 'Enter sends · Shift+Enter new line · Esc interrupts · / commands are Claude Code\'s own';
  // the context window, as Claude Code told its statusLine (the relay):
  // a small bar, used part filled, green -> yellow -> peach -> red
  const ctx = el('span', 'cchat-ctx');
  const ctxFill = el('span', 'cchat-ctx-fill');
  const ctxBar = el('span', 'cchat-ctx-bar');
  ctxBar.append(ctxFill);
  const ctxPct = el('span', 'cchat-ctx-pct');
  ctx.append(el('span', 'cchat-ctx-label', 'ctx'), ctxBar, ctxPct);
  ctx.hidden = true;
  inputRow.append(caret, input, ctx);
  // background tasks: a strip of chips above the prompt line, and the task
  // view (one agent's transcript / one shell's output) in place of the chat
  const strip = el('div', 'cchat-tasks');
  strip.hidden = true;
  const tview = el('div', 'cchat-tview');
  tview.hidden = true;
  const tvHead = el('div', 'cchat-tview-head');
  const tvBack = el('button', 'cchat-tview-back', '← back to chat');
  tvBack.type = 'button';
  const tvTitle = el('b', 'cchat-tview-title', '');
  const tvState = el('span', 'cchat-tview-state', '');
  tvHead.append(tvBack, tvTitle, tvState);
  const tvList = el('div', 'cchat-list');
  const tvPre = el('pre', 'cchat-tview-out');
  tvPre.hidden = true;
  const tvNote = el('div', 'tx-empty', '');
  // a send to the agent that did not go through: one line, until the next try
  const tvMsg = el('div', 'cchat-tview-msg', '');
  tvMsg.hidden = true;
  tview.append(tvHead, tvList, tvPre, tvNote, tvMsg);
  const tvRender = createRenderer(tvList, { briefs: true });
  // a one-off line under the prompt (image paste / removal), gone in seconds
  const imgNote = el('div', 'cchat-imgnote', '');
  imgNote.hidden = true;
  scroll.append(head, list, empty, tview, status, strip, inputRow, imgNote, tail);
  // the `/` dropdown lies over the transcript, next to the prompt line
  const menu = el('div', 'cchat-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'listbox');
  root.append(scroll, menu);
  head.append(el('span', 'tx-star', '✻'), el('b', '', ' Claude Code'));
  const headProject = el('span', 'tx-dim', '');
  head.append(headProject);

  // follow new output while the prompt line is on screen; scrolling down
  // into the blank room under it never pulls the view back up
  let stick = true;
  const inputVisible = () =>
    inputRow.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 40;

  scroll.addEventListener('scroll', () => { stick = inputVisible(); });

  /** The chat's own items. */
  const main = createRenderer(list, {
    onTurn: () => sizeLast(),
    onLayout: () => sizeLast(),
    onTask: (it) => taskItem(it),
  });

  /** The newest turn, the status line and the prompt line together fill at
   *  least the pane, padded by `tail` below the prompt line — so the turn's
   *  prompt can sit at the TOP while the reply flows down under it (the
   *  video's shape) and the input still follows the last reply directly. */
  // …and always at least this share of the pane, so the person can scroll
  // past the end to a blank view while typing
  const TAIL_MIN = 0.6;
  function sizeLast() {
    // the task view follows its end instead: no blank room under it
    if (openTask) { tail.style.height = '0px'; return; }
    const floor = scroll.clientHeight * TAIL_MIN;
    const turn = main.turn;
    if (!turn) { tail.style.height = `${Math.round(floor)}px`; return; }
    const used = inputRow.getBoundingClientRect().bottom - turn.getBoundingClientRect().top;
    const h = scroll.clientHeight - used - 8;
    tail.style.height = `${Math.round(Math.max(floor, h))}px`;
  }

  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => sizeLast());
    ro.observe(scroll); ro.observe(list); ro.observe(inputRow);
  }

  /** A frame of items from the server. */
  function take(frame) {
    if (frame.reset) {
      main.reset();
      tasks.clear();
      stick = !openTask;
      if (frame.project !== undefined) {
        headProject.textContent = frame.project ? ` · ${frame.project}` : '';
      }
    }
    let snapTurn = null;   // a turn that just started: bring its prompt to the top
    main.setLive(!frame.reset);
    for (const it of frame.items || []) {
      const t = main.add(it);
      if (t) snapTurn = t;
    }
    main.setLive(false);
    paintTasks();
    empty.hidden = list.childElementCount > 0;
    sizeLast();
    // the task view is on screen: the chat fills in underneath, unscrolled
    if (openTask) return;
    if (frame.reset) { toBottom(); return; }
    if (snapTurn) {
      // the video's shape: a new prompt starts at the TOP of the pane and
      // the reply flows down under it (`tail` makes the room for it)
      const t = snapTurn;
      requestAnimationFrame(() => {
        scroll.scrollTop = t.offsetTop - 8;
        stick = inputVisible();
      });
      return;
    }
    if (stick) toBottom();
  }

  /** Bring the prompt line into view by scrolling DOWN only — never into
   *  the blank room, never up out of it. */
  function toBottom() {
    requestAnimationFrame(() => {
      const over = inputRow.getBoundingClientRect().bottom + 12 - scroll.getBoundingClientRect().bottom;
      if (over > 0) scroll.scrollTop += over;
    });
  }

  // ── background tasks: the strip above the prompt line, and the task view
  //
  // The transcript's
  // task items (`transcript.mjs`) are folded into one record per task, keyed
  // by the tool-use id that started it. A chip opens that task's own view —
  // read-only: what is typed still goes to the chat's Claude.

  /** key (tool-use id, else task id) -> {key, id, kind, label, status, start, end, out, summary} */
  const tasks = new Map();
  let openTask = null;       // {key, id, kind, out} while the task view is up
  let taskTimer = null;

  function taskKey(it) {
    if (it.tool && tasks.has(it.tool)) return it.tool;
    if (it.id) for (const [k, t] of tasks) if (t.id === it.id) return k;
    return it.tool || null;
  }

  function taskItem(it) {
    const key = taskKey(it);
    if (!key) return;
    let t = tasks.get(key);
    if (!t) {
      // a message to an agent this view never saw start: nothing to update
      if (it.resumed) return;
      t = { key, id: '', kind: '', label: '', status: 'running', start: null, end: null, out: '', summary: '', peek: '' };
      tasks.set(key, t);
    }
    if (it.id) t.id = it.id;
    if (it.kind) t.kind = it.kind;
    if (it.label && !t.label) t.label = it.label;
    if (it.out) t.out = it.out;
    if (it.summary) t.summary = it.summary;
    if (!t.kind && t.id) t.kind = /^a[0-9a-f]{8,}$/.test(t.id) ? 'agent' : 'shell';
    const at = Date.parse(it.at || '') || Date.now();
    if (t.start === null) t.start = at;
    const status = it.status || t.status;
    if (status === 'running') t.end = null;
    else if (status !== t.status || t.end === null) t.end = at;
    t.status = status;
    if (openTask?.key === key) paintTaskHead();
  }

  const taskLabel = (t) => t.label || main.toolArgs(t.key) || t.summary || t.id || 'task';

  function visibleTasks(now = Date.now()) {
    return [...tasks.values()]
      .filter((t) => (t.status === 'running'
        ? now - t.start < TASK_STALE_MS
        : t.end !== null && now - t.end < TASK_LINGER_MS) || openTask?.key === t.key)
      .sort((x, y) => x.start - y.start);
  }

  function paintTasks() {
    const now = Date.now();
    const shown = visibleTasks(now);
    strip.hidden = shown.length === 0;
    strip.replaceChildren(...shown.map((t) => {
      const chip = el('button', 'cchat-task');
      chip.type = 'button';
      chip.dataset.tone = taskTone(t.status);
      if (openTask?.key === t.key) chip.classList.add('open');
      const label = taskLabel(t);
      // what it is doing NOW (`tpeek`), after a short dim name; the brief
      // alone only until the first activity arrives
      const text = el('span', 'cchat-task-label');
      if (t.peek) {
        const short = label.length > 24 ? `${label.slice(0, 24).trimEnd()}…` : label;
        text.append(el('span', 'cchat-task-desc', short), el('span', 'cchat-task-sep', ' · '), t.peek);
      } else {
        text.textContent = label;
      }
      chip.append(el('span', 'cchat-task-dot', '●'),
                  el('span', 'cchat-task-kind', t.kind === 'shell' ? '$' : '⧉'),
                  text,
                  el('span', 'cchat-task-time', duration((t.end ?? now) - t.start)));
      const what = t.kind === 'shell' ? 'background shell' : 'background agent';
      chip.title = `${label}${t.peek ? `\n${t.peek}` : ''}\n${what} · ${t.status}${t.summary ? `\n${t.summary}` : ''}`
        + (t.id ? '\nclick to view' : '\nnot started yet');
      chip.disabled = !t.id;
      // mousedown, not click: the input keeps the keyboard
      chip.addEventListener('mousedown', (ev) => ev.preventDefault());
      chip.addEventListener('click', () => {
        if (openTask?.key === t.key) closeTaskView();
        else openTaskView(t);
      });
      return chip;
    }));
    // a clock while anything is on the strip: elapsed time, and lingering
    // chips leaving on time
    paintAgentInput();
    if (shown.length && !taskTimer) taskTimer = setInterval(paintTasks, 1000);
    else if (!shown.length && taskTimer) { clearInterval(taskTimer); taskTimer = null; }
  }

  // ── messaging the open agent ───────────────────────────────────────
  // With an agent's view open, the prompt line sends to THAT agent —
  // through Claude Code's own subagent panel, driven by the page
  // (`agentpanel.mjs`), so it is Claude Code's mechanism, not a new one.
  // A shell's view stays read-only: what is typed goes to the main chat.
  let agentBusy = false;
  const agentOpen = () => Boolean(openTask && openTask.kind === 'agent' && messageAgent);

  function agentPlaceholder() {
    const t = openTask && tasks.get(openTask.key);
    return `Message ${t ? taskLabel(t) : 'this agent'}…`;
  }

  /** The input follows whether the agent's row is in Claude Code's panel. */
  function paintAgentInput() {
    if (!agentOpen() || agentBusy) return;
    const t = tasks.get(openTask.key);
    const r = agentReachable?.(t ? taskLabel(t) : '');
    if (r === false) {
      input.disabled = true;
      input.placeholder = t?.status === 'running'
        ? 'Can\'t message this agent from here — its row is not in Claude Code\'s panel.'
        : 'This agent has finished and its row is no longer in Claude Code\'s panel — it can\'t be messaged from here.';
    } else if (r === true && input.disabled) {
      input.disabled = false;
      input.placeholder = agentPlaceholder();
    }
  }

  function agentNotice(text) {
    tvMsg.textContent = text || '';
    tvMsg.hidden = !text;
  }

  /** Enter in an agent's view: the text goes to that agent, or stays here. */
  function submitToAgent() {
    const text = input.value;
    if (!text.trim() || agentBusy) return;
    const t = tasks.get(openTask.key);
    const label = t ? taskLabel(t) : '';
    const key = openTask.key;
    agentBusy = true;
    agentNotice('');
    input.readOnly = true;
    input.placeholder = `Sending to ${label}…`;
    Promise.resolve()
      .then(() => messageAgent(label, text))
      .catch(() => ({ ok: false, sent: false, reason: UNREACHABLE }))
      .then((r) => {
        agentBusy = false;
        input.readOnly = false;
        // sent = it is in the agent's prompt: never offered for a second send
        if (r?.sent && input.value === text) { input.value = ''; autosize(); }
        if (openTask?.key === key) {
          agentNotice(r?.ok && !r.reason ? '' : r?.reason || UNREACHABLE);
          input.placeholder = agentPlaceholder();
          paintAgentInput();
          tvStick = true;
          toBottom();
        }
        input.focus({ preventScroll: true });
      });
  }

  function paintTaskHead() {
    const t = openTask && tasks.get(openTask.key);
    if (!t) return;
    tvTitle.textContent = taskLabel(t);
    tvState.textContent = ` · ${t.kind === 'shell' ? 'shell' : 'agent'} · ${t.status}`;
    tvState.dataset.tone = taskTone(t.status);
  }

  let tvStick = true;

  function openTaskView(t) {
    if (!t.id) return;
    openTask = { key: t.key, id: t.id, kind: t.kind, out: t.out };
    tvRender.reset();
    tvPre.textContent = '';
    tvPre.hidden = t.kind !== 'shell';
    tvNote.textContent = 'loading…';
    tvNote.hidden = false;
    tview.hidden = false;
    head.hidden = true;
    list.hidden = true;
    empty.hidden = true;
    agentNotice('');
    input.placeholder = agentOpen() ? agentPlaceholder()
      : 'Message the main chat — this view is read-only…';
    paintAgentInput();
    paintTaskHead();
    paintTasks();
    sizeLast();
    tvStick = true;
    scroll.scrollTop = 0;
    onOpenTask?.({ kind: t.kind, id: t.id, out: t.out || undefined });
  }

  function closeTaskView() {
    if (!openTask) return;
    openTask = null;
    tview.hidden = true;
    tvRender.reset();
    tvPre.textContent = '';
    head.hidden = false;
    list.hidden = false;
    empty.hidden = list.childElementCount > 0;
    input.placeholder = PLACEHOLDER;
    input.disabled = false;
    agentNotice('');
    onCloseTask?.();
    paintTasks();
    sizeLast();
    stick = true;
    toBottom();
    input.focus({ preventScroll: true });
  }

  /** A task's latest activity (`tpeek`): the row shows it from now on,
   *  and keeps the last one once the task has finished. */
  function takePeek(msg) {
    const key = taskKey({ id: String(msg.id || '') });
    const t = key && tasks.get(key);
    if (!t || !msg.text || t.peek === msg.text) return;
    t.peek = String(msg.text);
    paintTasks();
  }

  /** A `ttx` frame: the open task's content. */
  function takeTask(frame) {
    if (!openTask || String(frame.task) !== openTask.id) return;
    if (frame.reset) {
      tvRender.reset();
      tvPre.textContent = '';
      tvStick = true;
    }
    if (frame.missing) {
      tvNote.textContent = openTask.kind === 'shell'
        ? 'output not available — the file is gone or outside Claude Code\'s own directories'
        : 'transcript not available';
      tvNote.hidden = false;
      return;
    }
    if (typeof frame.text === 'string') {
      let txt = tvPre.textContent + frame.text;
      if (frame.reset && frame.cut) txt = `…\n${txt}`;
      if (txt.length > TASK_TEXT_MAX) txt = `…\n${txt.slice(-TASK_TEXT_MAX)}`;
      tvPre.textContent = txt;
      tvNote.hidden = Boolean(txt);
      if (!txt) { tvNote.textContent = '(no output yet)'; tvNote.hidden = false; }
    }
    for (const it of frame.items || []) tvRender.add(it);
    if (frame.items) {
      tvNote.hidden = tvList.childElementCount > 0;
      if (!tvNote.hidden) tvNote.textContent = '(nothing yet)';
    }
    if (tvStick) toBottom();
  }

  scroll.addEventListener('scroll', () => { if (openTask) tvStick = inputVisible(); });
  tvBack.addEventListener('mousedown', (ev) => ev.preventDefault());
  tvBack.addEventListener('click', () => closeTaskView());

  function setRunning(on) {
    status.textContent = on ? '✻ working…  esc to interrupt' : '';
    status.classList.toggle('on', Boolean(on));
  }

  /** `{used, left}` percentages from the server's `ctx` frame; nothing
   *  arrived = nothing shown (a window size is never guessed). */
  function setContext(c) {
    const used = Number(c?.used);
    if (!c || !Number.isFinite(used)) { ctx.hidden = true; return; }
    const u = Math.max(0, Math.min(100, used));
    const left = Number.isFinite(Number(c.left)) ? Number(c.left) : 100 - u;
    ctx.hidden = false;
    ctxFill.style.width = `${u}%`;
    ctx.dataset.level = u < 50 ? 'ok' : u < 70 ? 'warn' : u < 85 ? 'high' : 'full';
    ctxPct.textContent = `${Math.round(u)}%`;
    ctx.title = `Context: ${Math.round(u)}% used · ${Math.round(left)}% left`;
  }

  // ── the `/` dropdown: completes a command name, never runs one ──────

  let menuItems = [];
  let menuSel = 0;
  let menuShown = false;

  function menuQuery() {
    const m = /^\/(\S*)$/.exec(input.value);
    return m ? m[1].toLowerCase() : null;
  }

  function updateMenu() {
    const q = menuQuery();
    if (q === null) { closeMenu(); return; }
    const all = commandList();
    if (!all) {
      // a failed fetch leaves no list: no retry loop, the next `/` asks again
      loadCommands().then(() => { if (commandList() && menuQuery() !== null) updateMenu(); });
      closeMenu();
      return;
    }
    const prefix = [];
    const sub = [];
    for (const c of all) {
      const n = c.name.toLowerCase();
      const bare = n.includes(':') ? n.slice(n.indexOf(':') + 1) : n;
      if (n.startsWith(q) || bare.startsWith(q)) prefix.push(c);
      else if (q && n.includes(q)) sub.push(c);
    }
    menuItems = prefix.concat(sub).slice(0, 60);
    if (!menuItems.length) { closeMenu(); return; }
    menuSel = 0;
    menu.replaceChildren(...menuItems.map((c, i) => {
      const row = el('div', 'cchat-menu-item');
      row.setAttribute('role', 'option');
      row.append(el('span', 'cchat-menu-name', `/${c.name}`),
                 el('span', 'cchat-menu-desc', c.desc || ''));
      row.title = c.desc ? `/${c.name} — ${c.desc}` : `/${c.name}`;
      // mousedown, not click: the textarea keeps the keyboard
      row.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        menuSel = i;
        completeMenu();
      });
      return row;
    }));
    menu.hidden = false;
    menuShown = true;
    paintSel();
    placeMenu();
  }

  function paintSel() {
    menuItems.forEach((_, i) => {
      menu.children[i]?.classList.toggle('sel', i === menuSel);
      menu.children[i]?.setAttribute('aria-selected', String(i === menuSel));
    });
    const node = menu.children[menuSel];
    if (node) {
      if (node.offsetTop < menu.scrollTop) menu.scrollTop = node.offsetTop;
      else if (node.offsetTop + node.offsetHeight > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = node.offsetTop + node.offsetHeight - menu.clientHeight;
      }
    }
  }

  /** Below the prompt line when it fits, above it otherwise. */
  function placeMenu() {
    if (!menuShown) return;
    const r = root.getBoundingClientRect();
    const row = inputRow.getBoundingClientRect();
    const left = Math.max(0, input.getBoundingClientRect().left - r.left - 4);
    menu.style.left = `${left}px`;
    menu.style.right = '10px';
    const h = menu.offsetHeight;
    const below = r.bottom - row.bottom;
    if (below >= h + 4 || below >= row.top - r.top) {
      menu.style.top = `${Math.round(row.top - r.top + Math.min(input.offsetHeight + 4, row.height))}px`;
      menu.style.bottom = '';
    } else {
      menu.style.top = '';
      menu.style.bottom = `${Math.round(r.bottom - row.top + 2)}px`;
    }
  }

  function closeMenu() {
    if (!menuShown) return;
    menuShown = false;
    menu.hidden = true;
    menu.replaceChildren();
    menuItems = [];
  }

  /** The picked name + a space in the input; the next Enter sends it. */
  function completeMenu() {
    const c = menuItems[menuSel];
    if (!c) return;
    input.value = `/${c.name} `;
    closeMenu();
    autosize();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function menuKey(ev) {
    if (!menuShown) return false;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const n = menuItems.length;
      menuSel = (menuSel + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n;
      paintSel();
      return true;
    }
    if (ev.key === 'Escape') { closeMenu(); return true; }
    if (ev.key === 'Tab' && !ev.shiftKey) { completeMenu(); return true; }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.altKey) {
      // the whole name typed already: Enter runs it, as in Claude Code
      if (input.value.trim().toLowerCase() === `/${menuItems[menuSel]?.name}`.toLowerCase()) {
        closeMenu();
        return false;
      }
      completeMenu();
      return true;
    }
    return false;
  }

  scroll.addEventListener('scroll', () => placeMenu());
  input.addEventListener('blur', () => closeMenu());

  // ── input: keystrokes into the real TUI ─────────────────────────────

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
  input.addEventListener('input', () => { autosize(); updateMenu(); checkImages(); });

  function submit() {
    // the page is walking Claude Code's panel: no key of ours in between
    if (agentBusy) return;
    if (agentOpen()) { submitToAgent(); return; }
    // an image paste / removal still talking to the TUI: send after it
    if (imgBusy) { imgChain.then(() => submit()); return; }
    let text = input.value;
    input.value = '';
    autosize();
    // the [Image #N] tokens are in the TUI's input already (Ctrl+V put them
    // there): the prompt Claude Code sends is those tokens, then this text
    const inTui = (screen && tuiImages(screen())) || [];
    text = withoutTokens(text, images);
    images = [];
    if (inTui.length) text = text.replace(/^[ \t]+/, '');
    if (!text.trim()) { send('\r'); return; }
    // typed after a token, Claude Code adds the space itself; a paste
    // does not — one leading space covers both (measured, 2.1.286), unless
    // the TUI's input already ends in one (a token was deleted after it)
    if (inTui.length && !tuiEndsInSpace(inTui[inTui.length - 1])) text = ` ${text}`;
    // A multi-line message goes as one bracketed paste — a bare newline
    // would submit the first line on its own. Enter follows separately: in
    // the same chunk, Claude Code can take it for part of a paste.
    // Anything long goes as a bracketed PASTE too, not as typing: a long
    // single-line prompt typed in one burst reached Claude Code as its last
    // 56 characters only, while a 13-line paste arrived whole.
    const payload = text.includes('\n') || text.length > PASTE_OVER
      ? (bracketed() ? `\x1b[200~${text}\x1b[201~` : text.replace(/\n/g, ' '))
      : text;
    // The Enter is the server's to send (`Session.submit`): only once Claude
    // Code has drawn the text, or it lands inside the paste as a newline.
    if (submitText) submitText(payload);
    else {
      send(payload);
      setTimeout(() => send('\r'), text.length > PASTE_OVER ? 250 : 60);
    }
    stick = true;
  }

  // ── pasted images: Claude Code's own [Image #N] ────────────────────
  // Claude Code attaches an image by reading the clipboard itself on Ctrl+V
  // and puts `[Image #N]` in ITS input box; deleting that text there drops
  // the image. So a paste here sends Ctrl+V, reads the token the TUI
  // inserted, and puts the same token here; `images` is the TUI's input,
  // which holds nothing else (what is typed here only reaches it on send).
  // Measured on 2.1.286: Backspace right after a token deletes it whole, the
  // space before it takes a Backspace of its own.
  let images = [];
  let imgBusy = false;
  let imgChain = Promise.resolve();
  let noteTimer = null;

  function note(text) {
    imgNote.textContent = text;
    imgNote.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { imgNote.hidden = true; }, 4000);
  }

  /** one image step at a time, in order; submit waits for the chain */
  function imgStep(fn) {
    imgChain = imgChain.then(async () => {
      imgBusy = true;
      try { await fn(); } catch { /* the screen moved on: reconciled next time */ }
      imgBusy = false;
    });
    return imgChain;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tuiNow = () => (screen ? tuiImages(screen()) : null);
  const screenKey = () => { const s = screen(); return `${s.lines.join('\n')}|${s.cx},${s.cy}`; };
  /** one key, then wait for the screen to change AND hold still (Ink can
   *  draw a frame in pieces; a half-drawn one has the cursor elsewhere) */
  async function key(bytes) {
    const was = screenKey();
    send(bytes);
    if (!(await until(() => screenKey() !== was, 800))) return;
    let last = screenKey();
    await until(async () => {
      await sleep(40);
      const k = screenKey();
      if (k === last) return true;
      last = k;
      return false;
    }, 500);
  }
  async function until(pred, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await pred();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(30);
    }
  }

  /** the TUI's cursor sits past the end of its last token: a space there
   *  (the cell may look blank or not — Ink leaves stale cells; the cursor
   *  is what counts) */
  function tuiEndsInSpace(last) {
    const s = screen();
    const st = panelState(s);
    if (st.prompt < 0 || s.cy !== st.prompt) return false;
    const end = (s.lines[st.prompt] || '').lastIndexOf(last);
    return end >= 0 && s.cx > end + last.length;
  }

  /** take tokens out of the input here, each with one space after it */
  function stripTokens(toks) {
    const v = withoutTokens(input.value, toks);
    if (v !== input.value) { input.value = v; autosize(); }
  }

  /** the TUI is the truth: tokens gone from it leave the input here too */
  function syncImages() {
    const now = tuiNow();
    if (now === null) return;
    stripTokens(images.filter((t) => !now.includes(t)));
    images = now;
  }

  input.addEventListener('paste', (ev) => {
    const items = [...(ev.clipboardData?.items || [])];
    const hasImage = items.some((i) => i.kind === 'file' && i.type.startsWith('image/'));
    const hasText = items.some((i) => i.kind === 'string' && i.type === 'text/plain');
    if (!hasImage || hasText || agentBusy || agentOpen()) return;
    ev.preventDefault();
    if (!screen) { send('\x16'); return; }
    imgStep(async () => {
      const before = tuiNow();
      if (before === null) { note('image paste failed'); return; }
      send('\x16');
      const tok = await until(() => (tuiNow() || []).find((t) => !before.includes(t)), 1500);
      if (!tok) { note('image paste failed'); return; }
      images = tuiNow() || [...before, tok];
      // at the caret, set apart by spaces
      const s = input.selectionStart ?? input.value.length;
      const e = input.selectionEnd ?? s;
      const pre = input.value.slice(0, s);
      input.setRangeText(`${pre && !/\s$/.test(pre) ? ' ' : ''}${tok} `, s, e, 'end');
      autosize();
    });
  });

  /** A token deleted here: delete it in the TUI too. Only the last one can
   *  go on its own (the TUI's cursor is after the last token, and is never
   *  moved); for an earlier one the later ones go with it. */
  function checkImages() {
    if (imgBusy || !images.length) return;
    const gone = images.findIndex((t) => !input.value.includes(t));
    if (gone < 0) return;
    imgStep(() => dropFrom(gone));
  }

  async function dropFrom(i) {
    const drop = images.slice(i);
    for (const tok of [...drop].reverse()) {
      for (let n = 0; n < 8; n += 1) {
        const now = tuiNow();
        if (now === null || !now.includes(tok)) break;
        await key('\x7f');
      }
    }
    const now = tuiNow() ?? [];
    const stuck = drop.filter((t) => now.includes(t));
    const later = drop.slice(1).filter((t) => input.value.includes(t));
    images = now;
    stripTokens(drop.filter((t) => !now.includes(t)));
    if (stuck.length) {
      note(`couldn't remove ${stuck[0].slice(1, -1).toLowerCase()} — clear it in the terminal view`);
    } else if (later.length) {
      note(`removed ${later[0].slice(1, -1).toLowerCase()}${later.length > 1 ? ' and later images' : ''} — paste ${later.length > 1 ? 'them' : 'it'} again`);
    }
  }

  input.addEventListener('keydown', (ev) => {
    if (keyFilter?.(ev)) return;
    if (ev.isComposing) return;
    if (agentBusy) { if (ev.key === 'Enter' || keyBytes(ev, mac)) ev.preventDefault(); return; }
    if (menuKey(ev)) { ev.preventDefault(); return; }
    // Ctrl+Z suspends Claude Code with no shell to resume it: never sent
    if (ev.ctrlKey && !ev.metaKey && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      submit();
      return;
    }
    const bytes = keyBytes(ev, mac);
    if (bytes) {
      ev.preventDefault();
      send(bytes);
      // Esc / Ctrl+C can clear the TUI's input, images and all
      if (images.length) setTimeout(() => { if (!imgBusy) syncImages(); }, 400);
    }
  });

  // a click on the transcript that is not a text selection focuses the input
  scroll.addEventListener('mouseup', () => {
    if (String(globalThis.getSelection?.() || '')) return;
    input.focus({ preventScroll: true });
  });

  return {
    root,
    take,
    takeTask,
    takePeek,
    /** the open task view's task, to re-follow after a reconnect */
    currentTask: () => (openTask ? { kind: openTask.kind, id: openTask.id, out: openTask.out || undefined } : null),
    setRunning,
    setContext,
    focus: () => input.focus({ preventScroll: true }),
    /** the person has a half-written message here */
    hasDraft: () => input.value.trim().length > 0,
    /** a key typed somewhere on the page that belongs to Claude */
    typeInto(data) {
      if (agentBusy) return;
      input.focus({ preventScroll: true });
      if (/^[^\x00-\x1f\x7f]+$/.test(data)) {
        input.value += data;
        autosize();
        updateMenu();
      } else {
        send(data);
      }
    },
  };
}
