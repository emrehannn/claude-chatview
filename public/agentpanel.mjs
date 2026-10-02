/**
 * Message a background agent through Claude Code's own subagent panel.
 *
 * Claude Code (2.1.286) lists the main conversation and its agents in a
 * panel under the prompt box:
 *
 *     ❯ ⏺ main
 *       ◯ general-purpose  sleepy waiter                8s · ↓ 27.0k tokens
 *
 * and a message typed into an agent's open transcript goes to that agent.
 * Nothing here re-implements that: it presses the keys a person would, and
 * reads the screen after every key. Measured on the real TUI:
 *
 *   ↓ from the empty prompt   focus moves down: first onto a footer pill
 *                             (`1 shell`) when there is one, then into the
 *                             panel — the selected row starts `❯ `
 *   ↓ / ↑ in the panel        the selection moves one row
 *   Enter on an agent row     its transcript opens: the rule above the prompt
 *                             carries the agent's description
 *                             (`──── sleepy waiter ─`), focus stays in the panel
 *   Esc in the panel          focus back to the prompt (cursor on the `❯` line);
 *                             the prompt now sends to the open agent
 *   Enter on the `main` row   the main conversation again
 *
 * The row on screen carries a filled dot (`⏺`; `●` as of Claude Code
 * 2.1.287), the others the hollow `◯`. The panel is only there
 * while something runs in the background: once an agent has finished and
 * nothing else runs, its row is gone (the footer says `/tasks to see
 * subagents`) and it cannot be reached this way. `←` on the empty prompt is
 * NOT the panel — it opens Claude Code's background-sessions screen; never
 * sent.
 *
 * Esc is only ever sent while the focus is OFF the prompt line: on the prompt
 * it would interrupt Claude. Every step is confirmed on screen before the
 * next; anything unconfirmed backs out to the main prompt and reports why —
 * the text is never typed anywhere it was not confirmed to belong.
 *
 * No imports: the module also runs in node against `@xterm/headless`, the
 * way it was checked against a real `claude`.
 */

const DOWN = '\x1b[B';
const UP = '\x1b[A';
const ESC = '\x1b';
const ENTER = '\r';

/** a rule line, optionally labelled: `──── sleepy waiter ─` */
const RULE = /^─{2,}(?:\s(.+?)\s─+)?\s*$/;
/** a panel row: selection mark, a glyph, the rest */
const ROW = /^(❯| ) (\S) +(.*?)\s*$/;
/** the glyph of a row that is NOT on screen; any other glyph (`⏺`, `●`) is */
const HOLLOW = '◯';

export const UNREACHABLE = 'Couldn\'t reach this agent from here — its row is no longer in Claude Code\'s panel.';

/** The visible screen of an xterm (browser or headless): lines + cursor. */
export function readScreen(term) {
  const buf = term?.buffer?.active;
  if (!buf) return { lines: [], cx: 0, cy: -1 };
  const lines = [];
  for (let i = 0; i < term.rows; i += 1) {
    lines.push(buf.getLine(buf.baseY + i)?.translateToString(true) ?? '');
  }
  return { lines, cx: buf.cursorX, cy: buf.cursorY };
}

/**
 * What the bottom of the TUI shows.
 *
 *   prompt  index of the `❯` input line (between two rules), -1 if none
 *   label   the label in the rule above the prompt, or null. An open
 *           agent's description — but also the session's own title (a
 *           session sent to the background comes back named), so it is
 *           never read alone
 *   onMain  the main conversation is on screen: its panel row carries the
 *           filled dot (the row on screen does; the others `◯`), or no panel at all
 *   focus   'prompt' (cursor on the input line), 'panel' (a row is selected),
 *           'other' (a footer pill, or unknown)
 *   empty   the input is empty (cursor right after `❯ ` on a one-line input)
 *   rows    the panel's rows: {sel, main, shown, type, desc}
 */
export function panelState({ lines, cx, cy }) {
  let prompt = -1;
  let below = -1;
  let label = null;
  for (let i = lines.length - 1; i > 0; i -= 1) {
    if (!lines[i].startsWith('❯')) continue;
    const above = RULE.exec(lines[i - 1]);
    if (!above) continue;
    let b = -1;
    for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
      if (/^─{2,}\s*$/.test(lines[j])) { b = j; break; }
    }
    if (b < 0) continue;
    prompt = i; below = b; label = above[1] ? above[1].trim() : null;
    break;
  }
  const rows = [];
  if (below >= 0) {
    // the panel starts at its `main` row, under the footer
    let start = -1;
    for (let j = below + 1; j < lines.length; j += 1) {
      const m = ROW.exec(lines[j]);
      if (m && m[3] === 'main') { start = j; break; }
    }
    for (let j = start; start >= 0 && j < lines.length; j += 1) {
      const m = ROW.exec(lines[j]);
      if (!m) break;
      const main = m[3] === 'main';
      // `general-purpose  sleepy waiter      8s · ↓ 27.0k tokens`
      const parts = m[3].split(/\s{2,}/);
      rows.push({ sel: m[1] === '❯', main, shown: m[2] !== HOLLOW,
                  type: main ? '' : parts[0] || '', desc: main ? 'main' : parts[1] || '' });
    }
  }
  const focus = prompt >= 0 && cy === prompt ? 'prompt'
    : rows.some((r) => r.sel) ? 'panel' : 'other';
  const empty = focus === 'prompt' && cx === 2 && below === prompt + 1;
  const onMain = !rows.length || Boolean(rows.find((r) => r.main)?.shown);
  return { prompt, label, onMain, focus, empty, rows };
}

/** Does a panel row's (maybe truncated) description name this agent? */
export function descMatches(rowDesc, label) {
  const a = String(rowDesc || '').trim();
  const b = String(label || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const cut = a.replace(/…$/, '');
  return a.endsWith('…') && cut.length >= 3 && b.startsWith(cut);
}

/** The one row naming `label`; null when none or ambiguous. */
export function findAgentRow(st, label) {
  const hits = st.rows.filter((r) => !r.main && descMatches(r.desc, label));
  return hits.length === 1 ? hits[0] : null;
}

/** Is the agent's row in the panel? true / false / null (screen not readable). */
export function agentReachable(screen, label) {
  const st = panelState(screen);
  if (st.prompt < 0) return null;
  return Boolean(findAgentRow(st, label));
}

/**
 * Send `text` to the agent whose panel row reads `label`, then put the TUI
 * back on the main conversation.
 *
 * @param {object} io
 * @param {() => {lines: string[], cx: number, cy: number}} io.screen
 * @param {(data: string) => void} io.send   bytes into the pty
 * @param {(ms: number) => Promise<void>} [io.sleep]
 * @param {object} o
 * @param {string} o.label     the agent's description (its chip's label)
 * @param {string} o.text
 * @param {boolean} [o.bracketed]  the TUI takes bracketed paste
 * @returns {Promise<{ok: boolean, sent: boolean, reason?: string, step?: string}>}
 *          `sent` = the text was typed into the agent's prompt
 */
export async function messageAgent(io, { label, text, bracketed = true }) {
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = () => panelState(io.screen());
  /** poll the screen until `pred` holds; the state, or null on timeout */
  async function until(pred, ms = 1500) {
    const end = Date.now() + ms;
    for (;;) {
      const st = now();
      if (pred(st)) return st;
      if (Date.now() > end) return null;
      await sleep(40);
    }
  }
  const selIndex = (st) => st.rows.findIndex((r) => r.sel);
  /** this agent's transcript is on screen: its row has the filled dot and the
   *  rule above the prompt names it (maybe truncated either way) */
  const open = (s) => !s.onMain && Boolean(findAgentRow(s, label)?.shown)
    && s.label !== null && (descMatches(s.label, label) || descMatches(label, s.label));

  /** focus into the panel from the prompt (a pill may come first) */
  async function intoPanel() {
    for (let i = 0; i < 4; i += 1) {
      const st = now();
      if (st.focus === 'panel') return st;
      if (st.focus === 'prompt' && !st.empty) return null;   // ↓ would walk the text
      const was = `${st.focus}|${io.screen().cy}`;
      io.send(DOWN);
      await until((s) => s.focus === 'panel' || `${s.focus}|${io.screen().cy}` !== was, 800);
    }
    const st = now();
    return st.focus === 'panel' ? st : null;
  }

  /** move the selection onto the row `want` picks; the state, or null */
  async function select(want) {
    for (let step = 0; step < 40; step += 1) {
      const st = now();
      if (st.focus !== 'panel') return null;
      const at = selIndex(st);
      const to = st.rows.findIndex(want);
      if (to < 0 || at < 0) return null;
      if (at === to) return st;
      io.send(to > at ? DOWN : UP);
      const moved = await until((s) => s.focus === 'panel' && selIndex(s) !== at, 800);
      if (!moved) return null;
    }
    return null;
  }

  /** back to the main conversation with the focus on its prompt — never
   *  an Esc while the cursor is on the prompt line */
  async function backToMain() {
    let st = now();
    if (!st.onMain) {
      if (st.focus !== 'panel') st = await intoPanel();
      if (st) st = await select((r) => r.main);
      if (st) {
        io.send(ENTER);
        st = await until((s) => s.onMain);
      }
      if (!st) return false;
    }
    for (let i = 0; i < 3; i += 1) {
      st = now();
      if (st.focus === 'prompt') return st.onMain;
      io.send(ESC);
      await until((s) => s.focus === 'prompt', 800);
    }
    st = now();
    return st.focus === 'prompt' && st.onMain;
  }

  async function fail(step, reason = UNREACHABLE) {
    await backToMain();
    return { ok: false, sent: false, step, reason };
  }

  // 0. the main conversation's prompt, empty, with the agent's row listed
  let st = now();
  if (st.prompt < 0) return { ok: false, sent: false, step: 'screen', reason: 'Claude Code is showing a dialog — answer it in the terminal view first.' };
  if (st.focus !== 'prompt' || !st.onMain) {
    if (!(await backToMain())) return { ok: false, sent: false, step: 'reset', reason: UNREACHABLE };
    st = now();
  }
  if (!st.empty) return { ok: false, sent: false, step: 'prompt', reason: 'Claude Code\'s own prompt has text in it — clear it in the terminal view first.' };
  if (!findAgentRow(st, label)) return { ok: false, sent: false, step: 'row', reason: UNREACHABLE };

  // 1. into the panel, onto the agent's row
  st = await intoPanel();
  if (!st) return fail('panel');
  st = await select((r) => !r.main && descMatches(r.desc, label));
  if (!st || !findAgentRow(st, label)?.sel) return fail('select');

  // 2. open its transcript: the rule above the prompt names it
  io.send(ENTER);
  st = await until(open);
  if (!st) return fail('open');

  // 3. focus back to the prompt — which now sends to the agent
  if (st.focus !== 'prompt') {
    io.send(ESC);
    st = await until((s) => s.focus === 'prompt');
  }
  if (!st || !st.empty || !open(st)) {
    return fail('focus');
  }

  // 4. the message, as one paste, then Enter once it shows in the input
  io.send(bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\n/g, ' '));
  st = await until((s) => s.focus !== 'prompt' || !s.empty, 2000);
  if (!st || !open(st)) return fail('paste');
  await sleep(text.length > 200 ? 250 : 60);
  io.send(ENTER);
  // taken: the input is empty again, still on the agent's view
  st = await until((s) => s.focus === 'prompt' && s.empty && open(s), 4000);
  if (!st) {
    return { ok: false, sent: true, step: 'submit',
             reason: 'Sent to the agent\'s prompt, but Claude Code did not confirm it — check the terminal view.' };
  }

  // 5. the main conversation again, where the person left it
  const back = await backToMain();
  return back ? { ok: true, sent: true }
    : { ok: true, sent: true, step: 'return',
        reason: 'Message sent; Claude Code is still on the agent\'s view — press Esc / pick main in the terminal view.' };
}
