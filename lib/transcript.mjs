/**
 * The chat view's data. The engine stays the real `claude` in its pty
 * (`session.mjs`, argv as the person typed it); this file only READS what
 * Claude Code already writes: its session transcript, one JSON record per
 * line, appended as the conversation happens, at
 * `<config dir>/projects/<cwd slug>/<session id>.jsonl` (`transcriptPath`).
 * Nothing here scrapes the TUI, and nothing here can write to the session.
 *
 * Two parts:
 *   * `recordItems(rec)` turns one transcript record into the few display
 *     items the pane draws — a prompt, a reply, a tool call, a result line.
 *     Everything else (thinking, hooks, snapshots, sidechains) is dropped.
 *     Results are SUMMARISED here, so a 2 MB tool result never crosses the
 *     socket.
 *   * `followTranscript()` tails one chat's file by polling: the last
 *     `TAIL_BYTES` on the first look, then whatever was appended. The path
 *     is asked for on every poll, because a `/clear` or `/resume` moves the
 *     chat to another session id (`Session` tracks it) — a new
 *     path is a fresh start (`reset`).
 */
import { open, stat, realpath, readdir } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';

/** How much of an existing transcript the first look reads (its end). */
export const TAIL_BYTES = 2 << 20;
/** Most items a first look sends; older ones are Claude Code's own `/resume`. */
export const MAX_ITEMS = 400;
/** Longest text an item carries. */
export const MAX_TEXT = 24000;
/** A result line is a summary, not the output. */
const RESULT_CHARS = 220;
/** Read at most this much per poll; the rest arrives on the next one. */
const READ_CAP = 8 << 20;
export const POLL_MS = 250;

const clip = (s, n = MAX_TEXT) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The tool's display name: `mcp__server__some_tool` -> `some_tool`. */
export function toolName(name) {
  const n = String(name || 'tool');
  const m = /^mcp__.+?__(.+)$/.exec(n);
  return m ? m[1] : n;
}

function oneLine(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/\s+/g, ' ').trim();
}

/** A tool call's arguments as one short line, the way Claude Code shows it. */
export function toolArgs(name, input, cwd = '') {
  const inp = input && typeof input === 'object' ? input : {};
  const rel = (p) => {
    const s = String(p || '');
    return cwd && s.startsWith(cwd + path.sep) ? s.slice(cwd.length + 1) : s;
  };
  const n = String(name || '');
  let line;
  // what the call is FOR (the tool's own description); the command opens on click
  if (n === 'Bash') line = inp.description || String(inp.command || '').split('\n')[0];
  else if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(n)) line = rel(inp.file_path || inp.notebook_path);
  else if (n === 'Grep' || n === 'Glob') line = `${inp.pattern || ''}${inp.path ? `  in ${rel(inp.path)}` : ''}`;
  else if (n === 'Agent' || n === 'Task') line = inp.description || inp.prompt;
  else if (n === 'AskUserQuestion') {
    const qs = Array.isArray(inp.questions) ? inp.questions : [];
    line = qs.map((x) => x?.question).filter(Boolean).join('  ·  ');
  } else if (n === 'SendMessage') line = `to ${inp.to || inp.recipient || ''}${inp.summary ? ` · ${inp.summary}` : ''}`;
  else if (n === 'Skill') line = `${inp.skill || ''}${inp.args ? ` ${inp.args}` : ''}`;
  else if (n === 'WebFetch') line = inp.url;
  else if (n === 'WebSearch') line = inp.query;
  else if (n === 'ToolSearch') line = inp.query;
  else {
    line = Object.entries(inp)
      .filter(([k]) => k !== 'reason')
      .map(([k, v]) => `${k}: ${oneLine(v)}`)
      .join(' · ');
  }
  return clip(oneLine(line), 240);
}

/** Images the chat view may draw, and the largest one it is sent inline. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_MAX = 6 << 20;   // base64 characters (~4.5 MB of image)

/** An image block -> a data: URL the page can draw, or a placeholder note. */
export function imageOf(b) {
  const src = b?.source;
  if (src?.type !== 'base64' || !IMAGE_TYPES.has(src.media_type) || typeof src.data !== 'string') {
    return { note: 'image' };
  }
  if (src.data.length > IMAGE_MAX) return { note: `image too large to show (${Math.round(src.data.length * 0.75 / 1048576)} MB)` };
  return { url: `data:${src.media_type};base64,${src.data}` };
}

/** Every image inside a tool result's content. */
function resultImages(content) {
  return Array.isArray(content) ? content.filter((b) => b?.type === 'image').map(imageOf) : [];
}

/** The full text behind a tool line that is worth expanding: what an Agent
 *  was briefed with, what a SendMessage said. Null for every other tool. */
export function toolDetail(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const n = String(name || '');
  let d = null;
  if (n === 'Agent' || n === 'Task') d = inp.prompt;
  else if (n === 'AskUserQuestion' && Array.isArray(inp.questions)) {
    d = inp.questions.map((x) => `**${x?.question || ''}**\n`
      + (Array.isArray(x?.options) ? x.options.map((o) => `- ${o?.label || ''}${o?.description ? ` — ${o.description}` : ''}`).join('\n') : '')).join('\n\n');
  } else if (n === 'Bash' && inp.command) d = '```bash\n' + String(inp.command) + '\n```';
  else if (n === 'SendMessage') d = typeof inp.message === 'string' ? inp.message : inp.content;
  return typeof d === 'string' && d.trim() ? clip(d.trim(), 20000) : null;
}

/** A message an agent sent this session (`<agent-message from=…>`): who, and
 *  its own words — the harness preamble and indentation stripped. */
export function peerItem(text) {
  const t = String(text || '');
  const from = /<agent-message from="([^"]*)"/.exec(t)?.[1] || '';
  let body = t.replace(/^[\s\S]*?<agent-message[^>]*>/, '').replace(/<\/agent-message>[\s\S]*$/, '');
  const at = body.indexOf('The report follows:');
  if (at >= 0) body = body.slice(at + 'The report follows:'.length);
  const lines = body.split('\n').filter((l) => !/^\s*\[harness:/.test(l));
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length), 99);
  body = lines.map((l) => l.slice(Math.min(pad, /^ */.exec(l)[0].length))).join('\n').trim();
  return { k: 'peer', from, text: clip(body, 20000) };
}

/** Results that are Claude Code's bookkeeping, as the plain status they mean
 *  (the launch notice and SendMessage's JSON otherwise show raw). */
function plainStatus(text) {
  const t = String(text || '').trim();
  if (/^Async agent launched successfully/.test(t)) return 'launched in the background';
  if (/^Your questions have been answered:/.test(t)) {
    // 'Your questions have been answered: "Q"="A", "Q2"="B". You can now …'
    const answers = [...t.matchAll(/"(?:[^"\\]|\\.)*"="((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    return answers.length ? `answered: ${answers.join(' · ')}` : 'answered';
  }
  if (/^User declined to answer|^The user doesn't want to proceed/.test(t)) return 'not answered';
  if (/^\{.*"success"\s*:/.test(t)) {
    try {
      const j = JSON.parse(t);
      if (j.success === false) return `not delivered${j.message ? ` — ${String(j.message).replace(/\b[a-f0-9]{16,}\b/g, '').trim()}` : ''}`;
      if (/queued for delivery/i.test(j.message || '')) return 'message queued — the agent reads it at its next step';
      return 'message delivered';
    } catch { /* not that JSON */ }
  }
  return null;
}

/** A tool result as one dim line: its first line, and how much more there is. */
export function resultSummary(content) {
  let text = '';
  let images = 0;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b?.type === 'text') parts.push(String(b.text || ''));
      else if (b?.type === 'image') images += 1;
      else if (b?.type === 'tool_reference') parts.push(String(b.tool_name || ''));
    }
    text = parts.join('\n');
  }
  const plain = plainStatus(text);
  if (plain) return plain;
  // a notice Claude Code adds for the model, never meant for the person
  text = text.replace(/\s*\(This tool result is internal metadata[^)]*\)/g, '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let out = lines[0] ? clip(lines[0].replace(/\s+/g, ' '), RESULT_CHARS) : '';
  if (lines.length > 1) out += `${out ? ' ' : ''}(+${lines.length - 1} lines)`;
  if (images) out += `${out ? ' · ' : ''}${images} image${images > 1 ? 's' : ''}`;
  return out || '(no output)';
}

const tag = (text, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1].trim() : null;
};


// ── background tasks ─────────────────────────────────────────────────
// Claude Code's TUI shows them in its
// footer, which the chat view hides — so the transcript's own records are
// turned into `{k:'task'}` items the view folds into a strip of chips:
//   * the tool_use that starts one: an Agent/Task or Bash call with
//     `run_in_background` (description, start time);
//   * its tool_result: "Async agent launched … agentId: X … output_file: P",
//     or "Command running in background with ID: X … written to: P"
//     (`toolUseResult.agentId` / `.backgroundTaskId` carry the same);
//   * the `<task-notification>` that ends it (task-id, tool-use-id, status
//     completed / failed / killed / stopped, summary) — a user record, a
//     queued_command attachment or a queue enqueue; the view merges repeats.
// Several items may describe one task; the view keys them by tool-use id.

const bgFlag = (v) => v === true || v === 'true';
/** An agent id as Claude Code mints them (`a` + hex), for SendMessage. */
const AGENT_ID = /^a[0-9a-f]{8,40}$/;

/** `<task-notification>…</task-notification>` -> a task item, or null. */
export function notificationItem(text) {
  const t = String(text || '');
  if (!t.includes('<task-notification>')) return null;
  const id = tag(t, 'task-id');
  const tool = tag(t, 'tool-use-id');
  const status = tag(t, 'status');
  if (!id && !tool) return null;
  const it = { k: 'task', id: id || '', tool: tool || '', status: (status || 'completed').toLowerCase() };
  const summary = tag(t, 'summary');
  if (summary) it.summary = clip(summary, 300);
  const out = tag(t, 'output-file');
  if (out) it.out = out;
  return it;
}

/** The tool_use that starts a background task -> a task item, or null. */
function taskStart(b) {
  const n = String(b?.name || '');
  const inp = b?.input && typeof b.input === 'object' ? b.input : {};
  if ((n === 'Agent' || n === 'Task') && bgFlag(inp.run_in_background)) {
    return { k: 'task', tool: String(b.id || ''), kind: 'agent', status: 'running',
             label: clip(oneLine(inp.description || inp.prompt || 'agent'), 120) };
  }
  if (n === 'Bash' && bgFlag(inp.run_in_background)) {
    const cmd = oneLine(String(inp.command || '').split('\n')[0]);
    return { k: 'task', tool: String(b.id || ''), kind: 'shell', status: 'running',
             label: clip(oneLine(inp.description || '') || cmd, 120), cmd: clip(cmd, 240) };
  }
  // a message to a finished agent resumes it
  if (n === 'SendMessage') {
    const to = String(inp.to || inp.recipient || '');
    if (AGENT_ID.test(to)) return { k: 'task', id: to, status: 'running', resumed: true };
  }
  return null;
}

/** A tool_result that reports a launched background task -> item, or null. */
function taskLaunch(b, meta) {
  let text = '';
  if (typeof b.content === 'string') text = b.content;
  else if (Array.isArray(b.content)) {
    text = b.content.filter((x) => x?.type === 'text').map((x) => String(x.text || '')).join('\n');
  }
  const tool = String(b.tool_use_id || '');
  const m = meta && typeof meta === 'object' ? meta : {};
  const outOf = (re) => re.exec(text)?.[1];
  if (m.isAsync || m.status === 'async_launched' || /^Async agent launched/.test(text)) {
    const id = m.agentId || outOf(/agentId:\s*([A-Za-z0-9_-]+)/);
    if (!id) return null;
    const it = { k: 'task', tool, id: String(id), kind: 'agent', status: 'running' };
    if (m.description) it.label = clip(oneLine(m.description), 120);
    const out = m.outputFile || outOf(/output_file:\s*(\S+)/);
    if (out) it.out = String(out);
    return it;
  }
  const sid = m.backgroundTaskId || outOf(/^Command running in background with ID:\s*([A-Za-z0-9_-]+)/);
  if (sid) {
    const it = { k: 'task', tool, id: String(sid), kind: 'shell', status: 'running' };
    const out = outOf(/(\/\S+?\.output)\b/);
    if (out) it.out = out;
    return it;
  }
  return null;
}

/** The wrapper Claude Code puts round a message sent to an agent. */
const FOLLOW_UP = /^The user sent a new message while you were working:\n([\s\S]*?)\n\nThis is how Claude Code surfaces/;

/** A user record whose content is a string. */
function userString(text, rec) {
  if (rec?.origin?.kind === 'peer' && text.includes('<agent-message')) return [peerItem(text)];
  const name = tag(text, 'command-name');
  if (name !== null) {
    const args = tag(text, 'command-args');
    return [{ k: 'cmd', text: clip(`${name}${args ? ` ${args}` : ''}`) }];
  }
  const stdout = tag(text, 'local-command-stdout');
  if (stdout !== null) return stdout ? [{ k: 'out', text: clip(stdout, 2000) }] : [];
  const bash = tag(text, 'bash-input');
  if (bash !== null) return [{ k: 'user', text: clip(`! ${bash}`) }];
  const bout = tag(text, 'bash-stdout');
  if (bout !== null) {
    const berr = tag(text, 'bash-stderr');
    const all = [bout, berr].filter(Boolean).join('\n');
    const items = all ? [{ k: 'out', text: clip(all, 2000) }] : [];
    // a `!` command sent to the background (Ctrl+B) is a background shell
    // like any `run_in_background` one, ended by its task-notification;
    // `bang`: the view names it after the `! command` just before it
    const bg = /^Command was manually backgrounded by user with ID:\s*([A-Za-z0-9_-]+)/.exec(bout);
    if (bg) {
      const it = { k: 'task', id: bg[1], kind: 'shell', status: 'running', bang: true };
      const out = /(\/\S+?\.output)\b/.exec(bout)?.[1];
      if (out) it.out = out;
      items.push(it);
    }
    return items;
  }
  // a background task finished: the task strip's item, never a prompt
  const kind = rec?.origin?.kind;
  if (kind === 'task-notification' || text.trimStart().startsWith('<task-notification>')) {
    const n = notificationItem(text);
    return n ? [n] : [];
  }
  // a hook, a skill body: not something the person typed
  if (kind && kind !== 'human') return [];
  if (/^<[a-z-]+>/.test(text.trim())) return [];
  // a paste is the person's own text; its wrapper tags are not
  const shown = text.replace(/<\/?pasted_content[^>]*>/g, '').trim();
  return shown ? [{ k: 'user', text: clip(shown) }] : [];
}

/**
 * An API request's prompt-cache footprint, from an assistant record's
 * `usage`: `tokens` is the whole prompt it sent (what the next request
 * re-reads from the cache, or re-writes once the cache has expired), `ttl`
 * the lifetime Claude Code asked for (1 h or 5 min; null when this request
 * wrote nothing new and so does not say). Every record of one request
 * carries the same usage — `req` lets the page count the request once.
 */
export function cacheItem(rec) {
  const u = rec.message?.usage;
  if (!u || typeof u !== 'object' || rec.message?.model === '<synthetic>') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const tokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  if (!tokens) return null;
  const c = u.cache_creation || {};
  const ttl = n(c.ephemeral_1h_input_tokens) > 0 ? 3600_000
    : n(c.ephemeral_5m_input_tokens) > 0 ? 300_000 : null;
  return { k: 'cache', req: String(rec.requestId || rec.message?.id || ''), tokens, ttl };
}

/** The newest request's `cache` item from a run of items, timed from that
 *  request's first record and with the newest TTL any request stated. */
export function lastCache(items) {
  let last = null;
  let ttl = null;
  for (const it of items) {
    if (it.k !== 'cache') continue;
    if (it.ttl) ttl = it.ttl;
    if (!last || it.req !== last.req) last = { ...it };
    else last.tokens = it.tokens;
  }
  if (last && ttl) last.ttl = ttl;
  return last;
}

/**
 * One transcript record -> the display items it carries (often none).
 * `cwd` makes file paths in tool lines relative. `sidechain` keeps an
 * agent's own records (its transcript is all sidechain) — the task view.
 */
export function recordItems(rec, cwd = '', { sidechain = false } = {}) {
  if (!rec || typeof rec !== 'object' || (rec.isSidechain && !sidechain)) return [];
  const at = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
  const items = [];
  // a message the person sent an idle agent through Claude Code's subagent
  // panel is a meta record too, wrapped: its own words only
  const followUp = rec.type === 'user' && rec.isMeta && rec.origin?.kind === 'human'
    && typeof rec.message?.content === 'string'
    ? FOLLOW_UP.exec(rec.message.content) : null;
  if (followUp) {
    const text = followUp[1].trim();
    if (text) items.push({ k: 'user', text: clip(text) });
  // an agent's message is a meta record; nothing else meta is shown
  } else if (rec.type === 'user' && (!rec.isMeta || rec.origin?.kind === 'peer')) {
    const c = rec.message?.content;
    if (typeof c === 'string') items.push(...userString(c, rec));
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === 'tool_result') {
          const res = { k: 'result', id: String(b.tool_use_id || ''),
                        text: resultSummary(b.content), error: Boolean(b.is_error) };
          const imgs = resultImages(b.content);
          if (imgs.length) res.images = imgs;
          items.push(res);
          const launched = taskLaunch(b, c.length === 1 ? rec.toolUseResult : null);
          if (launched) items.push(launched);
        } else if (b?.type === 'text') {
          const t = String(b.text || '');
          if (/^\[Request interrupted by user/.test(t)) items.push({ k: 'interrupt' });
          else items.push(...userString(t, rec));
        } else if (b?.type === 'image') {
          // drawn under the prompt it came with (attached after the loop)
          (c.images ||= []).push(imageOf(b));
        }
      }
      if (c.images) {
        const prompt = items.findLast((x) => x.k === 'user');
        if (prompt) prompt.images = c.images;
        else items.push({ k: 'user', text: '', images: c.images });
        delete c.images;
      }
    }
  } else if (rec.type === 'assistant') {
    for (const b of Array.isArray(rec.message?.content) ? rec.message.content : []) {
      if (b?.type === 'text' && String(b.text || '').trim()) {
        items.push({ k: 'text', text: clip(b.text) });
      } else if (b?.type === 'tool_use') {
        const tool = { k: 'tool', id: String(b.id || ''), name: toolName(b.name),
                       args: toolArgs(b.name, b.input, cwd) };
        const detail = toolDetail(b.name, b.input);
        if (detail) tool.detail = detail;
        items.push(tool);
        const started = taskStart(b);
        if (started) items.push(started);
      }
    }
    const cache = cacheItem(rec);
    if (cache) items.push(cache);
  } else if (rec.type === 'system') {
    if (rec.subtype === 'compact_boundary') items.push({ k: 'note', text: 'conversation compacted' });
    else if (rec.subtype === 'turn_duration') items.push({ k: 'turn', ms: Number(rec.durationMs) || 0 });
    else if (rec.subtype === 'local_command' && typeof rec.content === 'string') {
      items.push(...userString(rec.content, { origin: { kind: 'human' } }));
    }
  } else if (rec.type === 'queue-operation') {
    const n = rec.operation === 'enqueue' ? notificationItem(rec.content) : null;
    if (n) items.push(n);
    else if (rec.operation === 'enqueue' && typeof rec.content === 'string'
        && !/^<[a-z-]+[\s>]/.test(rec.content.trim())) {
      // only what the person typed — agent and task notifications queue too
      items.push({ k: 'queued', text: clip(rec.content) });
    } else if (rec.operation === 'remove' && typeof rec.content === 'string') {
      // taken mid-turn: it arrives as a queued_command attachment, not a user record
      items.push({ k: 'unqueue', text: clip(rec.content) });
    }
  } else if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
    // a prompt the person sent while Claude was working, delivered mid-turn
    const a = rec.attachment;
    if (a.origin?.kind === 'human' && typeof a.prompt === 'string' && a.prompt.trim()) {
      items.push({ k: 'user', text: clip(a.prompt) });
    } else if (a.origin?.kind === 'task-notification' || a.commandMode === 'task-notification') {
      const n = notificationItem(a.prompt);
      if (n) items.push(n);
    }
  }
  if (at) for (const it of items) it.at = at;
  return items;
}

/** Complete lines of `buf` -> items; returns the unfinished tail as a Buffer. */
function parseLines(buf, cwd, out, opts) {
  let start = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    const line = buf.subarray(start, nl).toString('utf8').trim();
    start = nl + 1;
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    out.push(...recordItems(rec, cwd, opts));
  }
  return buf.subarray(start);
}

async function readRange(file, from, to) {
  const fh = await open(file, 'r');
  try {
    const len = Math.max(0, to - from);
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, from + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

/** How much of a background shell's output the first look reads. */
export const TEXT_TAIL_BYTES = 256 << 10;
/** Colour and cursor escapes in a shell's output file: not drawable text. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const plain = (s) => s.replace(ANSI, '');

/**
 * Tail one chat's transcript — or, for the task view, an agent's own
 * transcript (`sidechain`) or a background shell's output file (`text`).
 *
 * @param {object} o
 * @param {() => string|null} o.pathFor  the file NOW (asked every poll)
 * @param {(frame: {reset?: boolean, items?: object[], text?: string,
 *                  missing?: boolean, project?: string}) => void} o.onItems
 * @param {string} [o.cwd]  for relative paths in tool lines, and the project name
 * @param {boolean} [o.sidechain]  keep sidechain records (an agent's transcript)
 * @param {boolean} [o.text]  the file is plain output, sent as `text`
 * @returns {{stop(): void}}
 */
export function followTranscript({ pathFor, onItems, cwd = '', pollMs = POLL_MS,
                                   sidechain = false, text = false }) {
  let file = undefined;      // undefined = never looked; null = no path
  let offset = null;         // null = not read yet
  let rest = Buffer.alloc(0);
  let decoder = null;
  let busy = false;
  let stopped = false;
  const project = cwd ? path.basename(cwd) : '';
  const opts = { sidechain };

  /** A first look's items: the newest MAX_ITEMS, and every task item —
   *  a task launched before them is still on the strip — plus one `cache`
   *  item standing for all of them (they would crowd out the chat). */
  const firstItems = (items) => {
    const shown = items.filter((it) => it.k !== 'cache');
    const out = shown.filter((it, i) => i >= shown.length - MAX_ITEMS || it.k === 'task');
    const cache = lastCache(items);
    if (cache) out.push(cache);
    return out;
  };

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      let p = null;
      try { p = pathFor(); } catch { p = null; }
      if (p !== file) {
        file = p;
        offset = null;
        rest = Buffer.alloc(0);
      }
      let size = -1;
      if (file) {
        try { size = (await stat(file)).size; } catch { size = -1; }
      }
      if (size < 0) {
        // no transcript yet (a chat that has not been spoken to): say so once
        if (offset === null) {
          offset = -1;
          onItems(text ? { reset: true, text: '', missing: true }
                       : { reset: true, items: [], project, missing: true });
        }
        return;
      }
      if (offset === null || offset === -1 || size < offset) {
        const tailBytes = text ? TEXT_TAIL_BYTES : TAIL_BYTES;
        const from = offset === -1 ? 0 : Math.max(0, size - tailBytes);
        let buf = await readRange(file, from, size);
        if (from > 0) {
          const nl = buf.indexOf(0x0a);
          buf = nl >= 0 ? buf.subarray(nl + 1) : Buffer.alloc(0);
        }
        offset = size;
        if (text) {
          decoder = new StringDecoder('utf8');
          const out = plain(decoder.write(buf));
          if (!stopped) onItems({ reset: true, text: out, cut: from > 0 });
          return;
        }
        const items = [];
        rest = Buffer.from(parseLines(buf, cwd, items, opts));
        if (!stopped) onItems({ reset: true, items: firstItems(items), project });
        return;
      }
      if (size === offset) return;
      const to = Math.min(size, offset + READ_CAP);
      const chunk = await readRange(file, offset, to);
      offset += chunk.length;
      if (text) {
        const out = plain(decoder.write(chunk));
        if (out && !stopped) onItems({ text: out });
        return;
      }
      const items = [];
      rest = Buffer.from(parseLines(Buffer.concat([rest, chunk]), cwd, items, opts));
      if (items.length && !stopped) onItems({ items });
    } catch {
      /* a transcript mid-rotation: the next poll tries again */
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  return {
    stop() { stopped = true; clearInterval(timer); },
  };
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function real(p) {
  try { return await realpath(p); } catch { return null; }
}

const inside = (child, root) => Boolean(child && root) && child.startsWith(root + path.sep);

/**
 * The file a task view tails, or null. Nothing the page sends is opened as
 * given: the id is checked against Claude Code's id shape, and the file
 * must resolve (symlinks followed) under
 *   * an agent: `<config>/projects/<cwd slug>/<session id>/subagents/
 *     agent-<id>.jsonl` — the chat's own session first, then any session
 *     of the same project (a `/clear` moved the chat on);
 *   * a shell: the output path the transcript named, whose last two parts
 *     must be `tasks/<id>.output`, and which must resolve under the config
 *     dir or Claude Code's temp dir (`<tmp>/claude-<uid>/`).
 *
 * @param {{kind: string, id: string, out?: string}} task
 * @param {{projectDir: string, claudeId: string, configDir: string}} where
 */
export async function taskFile(task, { projectDir, claudeId, configDir }) {
  const kind = String(task?.kind || '');
  const id = String(task?.id || '');
  if (!TASK_ID.test(id)) return null;
  const projects = await real(path.join(configDir, 'projects'));
  if (kind === 'agent') {
    const name = `agent-${id}.jsonl`;
    const sessions = [];
    if (UUID.test(String(claudeId || ''))) sessions.push(claudeId);
    let found = null;
    for (const sid of sessions) {
      found = await real(path.join(projectDir, sid, 'subagents', name));
      if (found) break;
    }
    if (!found) {
      let dirs = [];
      try { dirs = await readdir(projectDir); } catch { dirs = []; }
      for (const d of dirs.filter((x) => UUID.test(x) && x !== claudeId).slice(0, 2000)) {
        found = await real(path.join(projectDir, d, 'subagents', name));
        if (found) break;
      }
    }
    return inside(found, projects) && path.basename(found) === name ? found : null;
  }
  if (kind === 'shell') {
    const out = String(task?.out || '');
    if (!path.isAbsolute(out) || out.includes('\0')) return null;
    if (path.basename(out) !== `${id}.output` || path.basename(path.dirname(out)) !== 'tasks') return null;
    const found = await real(out);
    if (!found) return null;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const roots = [await real(configDir)];
    if (uid !== null) {
      for (const t of new Set(['/tmp', os.tmpdir()])) roots.push(await real(path.join(t, `claude-${uid}`)));
    }
    return roots.some((r) => inside(found, r)) ? found : null;
  }
  return null;
}

// ── what each running background task is doing now ─────────────────
// A task row should not keep showing the brief it started with: it shows
// the task's LATEST activity. For every running task the chat's transcript
// names, its own file (`taskFile`, same checks) is stat'ed once a poll;
// only a changed mtime reads its end, and only a changed line is sent.

/** How much of an agent's transcript one peek reads (its end). */
export const PEEK_AGENT_BYTES = 64 << 10;
/** …and of a shell's output. */
export const PEEK_SHELL_BYTES = 16 << 10;
/** Most tasks one chat peeks at (the newest). */
const PEEK_MAX = 12;
/** A task whose file is not there yet is looked for again this often. */
const PEEK_RETRY_MS = 5000;

/** The newest tool call or reply line in an agent transcript's tail. */
export function agentActivity(buf, cwd = '') {
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec?.type !== 'assistant') continue;
    const items = recordItems(rec, cwd, { sidechain: true });
    for (let j = items.length - 1; j >= 0; j -= 1) {
      const it = items[j];
      if (it.k === 'tool') return { text: clip(`${it.name}${it.args ? ` ${it.args}` : ''}`, 200), at: it.at };
      if (it.k === 'text') {
        const first = it.text.split('\n').map((s) => s.trim()).find(Boolean);
        if (first) return { text: clip(first, 200), at: it.at };
      }
    }
  }
  return null;
}

/** The last non-empty line of a shell's output tail. */
export function shellActivity(buf, cut = false) {
  const lines = plain(buf.toString('utf8')).split(/\r?\n|\r/);
  // a tail that starts mid-line: its first line is a fragment
  for (let i = lines.length - 1; i >= (cut ? 1 : 0); i -= 1) {
    const l = lines[i].trim();
    if (l) return { text: clip(l, 200) };
  }
  return null;
}

/**
 * Peek at the running background tasks of one chat.
 *
 * `take(frame)` is fed the chat's transcript frames (the same ones the page
 * gets): task items add, update and finish tasks; a `reset` starts over.
 * `onPeek({id, text, at?})` fires when a task's latest activity changed.
 *
 * @param {object} o
 * @param {() => {projectDir: string, claudeId: string, configDir: string}|null} o.where
 * @param {(p: {id: string, text: string, at?: string}) => void} o.onPeek
 * @param {string} [o.cwd]
 * @returns {{take(frame: object): void, stop(): void}}
 */
export function peekTasks({ where, onPeek, cwd = '', pollMs = 1000 }) {
  /** task id -> {kind, out, running, start, file, lookedAt, mtime, last, final} */
  const tasks = new Map();
  /** tool-use id -> task id, for notifications that only carry the tool */
  const byTool = new Map();
  let busy = false;
  let stopped = false;

  function take(frame) {
    if (frame?.reset) { tasks.clear(); byTool.clear(); }
    for (const it of frame?.items || []) {
      if (it?.k !== 'task') continue;
      const id = String(it.id || (it.tool && byTool.get(it.tool)) || '');
      if (!TASK_ID.test(id)) continue;
      if (it.tool) byTool.set(it.tool, id);
      let t = tasks.get(id);
      if (!t) {
        if (it.resumed) continue;
        t = { kind: '', out: '', running: true, start: Date.now(), file: null, lookedAt: 0,
              mtime: 0, last: '', final: false };
        tasks.set(id, t);
      }
      if (it.kind) t.kind = it.kind;
      if (!t.kind) t.kind = /^a[0-9a-f]{8,}$/.test(id) ? 'agent' : 'shell';
      if (it.out) t.out = it.out;
      const running = (it.status || 'running') === 'running';
      // finished: one last look, so the row keeps its true last activity
      if (t.running && !running) t.final = true;
      if (running) t.final = false;
      t.running = running;
    }
  }

  async function peek(id, t) {
    const w = where();
    if (!w) return;
    if (!t.file) {
      if (Date.now() - t.lookedAt < PEEK_RETRY_MS) return;
      t.lookedAt = Date.now();
      try { t.file = await taskFile({ kind: t.kind, id, out: t.out }, w); } catch { t.file = null; }
      if (!t.file) return;
    }
    let st;
    try { st = await stat(t.file); } catch { return; }
    if (st.mtimeMs === t.mtime) return;
    t.mtime = st.mtimeMs;
    const n = t.kind === 'shell' ? PEEK_SHELL_BYTES : PEEK_AGENT_BYTES;
    const buf = await readRange(t.file, Math.max(0, st.size - n), st.size);
    const got = t.kind === 'shell' ? shellActivity(buf, st.size > n) : agentActivity(buf, cwd);
    if (!got || got.text === t.last || stopped) return;
    t.last = got.text;
    onPeek({ id, ...got });
  }

  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const live = [...tasks.entries()].filter(([, t]) => t.running || t.final)
        .sort((a, b) => b[1].start - a[1].start).slice(0, PEEK_MAX);
      for (const [id, t] of live) {
        try { await peek(id, t); } catch { /* mid-write: next poll */ }
        if (!t.running && t.final) t.final = false;
      }
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  return {
    take(frame) { take(frame); tick(); },
    stop() { stopped = true; clearInterval(timer); },
  };
}
