/**
 * The chat view's slash-command list — the dropdown that shows up when you
 * type `/`. The dropdown only COMPLETES text: picking an entry puts
 * `/name ` in the input, and sending types it into the real Claude Code as
 * before — so a wrong or missing entry here costs a keystroke, never a
 * behaviour.
 *
 * Sources, in the order they are listed:
 *   * Claude Code's built-ins — a static list (`BUILTINS`), the ones we are
 *     sure exist. Claude Code itself is the authority; this is a hint.
 *   * the project's `.claude/skills/<dir>/SKILL.md` and
 *     `.claude/commands/**.md`, then the same under the user's Claude config
 *     dir (`CLAUDE_CONFIG_DIR`, else `~/.claude` — as `transcriptPath`);
 *   * enabled plugins' `skills/` and `commands/`, named `plugin:name` the way
 *     Claude Code shows them. Enabled = `enabledPlugins` in the user, project
 *     and project-local settings (later wins); where = `plugins/
 *     installed_plugins.json`'s `installPath`.
 *
 * Name from frontmatter `name` (else the directory / file name), description
 * from frontmatter `description` (a command without one: its first line),
 * cut to one line. A skill with `user-invocable: false` is left out, as
 * Claude Code leaves it out of its own menu. Cached for `TTL_MS`; every read
 * fails soft — an unreadable file is a missing entry, never an error.
 */
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const TTL_MS = 30_000;
const DESC_CHARS = 160;
const MAX_FILE = 64 * 1024;

/** Claude Code's own commands — the ones we are sure of. */
export const BUILTINS = [
  ['add-dir', 'Add a new working directory'],
  ['agents', 'Manage agent configurations'],
  ['bashes', 'List and manage background tasks'],
  ['clear', 'Clear conversation history and free up context'],
  ['color', 'Set the prompt bar colour for this session'],
  ['compact', 'Clear history but keep a summary in context'],
  ['config', 'Open the settings panel'],
  ['context', 'Visualize current context usage'],
  ['copy', 'Copy Claude\'s last response to the clipboard'],
  ['cost', 'Show the total cost and duration of this session'],
  ['doctor', 'Diagnose and verify the Claude Code installation'],
  ['exit', 'Exit the REPL'],
  ['export', 'Export the conversation to a file or the clipboard'],
  ['fast', 'Toggle fast mode'],
  ['help', 'Show help and available commands'],
  ['hooks', 'Manage hook configurations for tool events'],
  ['ide', 'Manage IDE integrations and show status'],
  ['init', 'Initialize a CLAUDE.md file with codebase documentation'],
  ['install-github-app', 'Set up Claude GitHub Actions for a repository'],
  ['login', 'Sign in with your Anthropic account'],
  ['logout', 'Sign out from your Anthropic account'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit Claude memory files'],
  ['model', 'Set the AI model for Claude Code'],
  ['output-style', 'Set the output style'],
  ['permissions', 'Manage allow & deny tool permission rules'],
  ['plugin', 'Manage Claude Code plugins'],
  ['pr-comments', 'Get comments from a GitHub pull request'],
  ['privacy-settings', 'View and update your privacy settings'],
  ['release-notes', 'View release notes'],
  ['rename', 'Rename the current conversation'],
  ['resume', 'Resume a conversation'],
  ['review', 'Review a pull request'],
  ['rewind', 'Restore the code and/or conversation to a previous point'],
  ['status', 'Show Claude Code status: version, model, account, connectivity'],
  ['statusline', 'Set up Claude Code\'s status line UI'],
  ['terminal-setup', 'Install the Shift+Enter key binding for newlines'],
  ['todos', 'List the current todo items'],
  ['upgrade', 'Upgrade to a higher plan'],
  ['usage', 'Show plan usage limits'],
  ['vim', 'Toggle between Vim and Normal editing modes'],
].map(([name, desc]) => ({ name, desc, src: 'built-in' }));

/** The front matter's flat keys: `key: value`, quoted values unquoted, a
 *  folded / literal block (`>`, `|`, or nothing on the line) joined. */
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const out = {};
  if (!m) return { meta: out, body: text };
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '' || /^[>|][+-]?$/.test(val)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1])) {
        i += 1;
        if (lines[i].trim()) parts.push(lines[i].trim());
      }
      val = parts.join(' ');
    } else if (/^(['"]).*\1$/.test(val)) {
      val = val.slice(1, -1);
    }
    out[kv[1]] = val;
  }
  return { meta: out, body: text.slice(m[0].length) };
}

const oneLine = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > DESC_CHARS ? `${t.slice(0, DESC_CHARS - 1)}…` : t;
};

async function readSmall(file) {
  try {
    const buf = await readFile(file);
    return buf.subarray(0, MAX_FILE).toString('utf8');
  } catch { return null; }
}

async function dirs(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name).sort();
  } catch { return []; }
}

/** `<dir>/<skill>/SKILL.md` -> entries */
async function skillsIn(dir, ns, src) {
  const out = [];
  for (const d of await dirs(dir)) {
    const text = await readSmall(path.join(dir, d, 'SKILL.md'));
    if (text === null) continue;
    const { meta } = frontmatter(text);
    if (String(meta['user-invocable']).toLowerCase() === 'false') continue;
    const name = meta.name || d;
    out.push({ name: ns ? `${ns}:${name}` : name, desc: oneLine(meta.description), src });
  }
  return out;
}

/** `<dir>/**.md` -> entries; a subdirectory namespaces its commands `dir:name`. */
async function commandsIn(dir, ns, src, depth = 0) {
  const out = [];
  let ents;
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    if (e.isDirectory() && depth < 3) {
      out.push(...await commandsIn(path.join(dir, e.name),
        ns ? `${ns}:${e.name}` : e.name, src, depth + 1));
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    const text = await readSmall(path.join(dir, e.name));
    if (text === null) continue;
    const { meta, body } = frontmatter(text);
    const name = e.name.slice(0, -3);
    const first = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
    out.push({ name: ns ? `${ns}:${name}` : name,
               desc: oneLine(meta.description || first), src });
  }
  return out;
}

async function readJson(file) {
  const text = await readSmall(file);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Every enabled plugin's install dir and display name. */
async function plugins(cfg, cwd) {
  const enabled = {};
  for (const f of [path.join(cfg, 'settings.json'),
                   path.join(cwd, '.claude', 'settings.json'),
                   path.join(cwd, '.claude', 'settings.local.json')]) {
    const s = await readJson(f);
    if (s && typeof s.enabledPlugins === 'object' && s.enabledPlugins) {
      Object.assign(enabled, s.enabledPlugins);
    }
  }
  const installed = (await readJson(path.join(cfg, 'plugins', 'installed_plugins.json')))?.plugins || {};
  const out = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const rows = Array.isArray(installed[key]) ? installed[key] : [];
    const row = rows.find((r) => r?.projectPath && path.resolve(r.projectPath) === path.resolve(cwd))
      || rows.find((r) => r?.scope === 'user') || rows[0];
    if (!row || typeof row.installPath !== 'string') continue;
    const manifest = await readJson(path.join(row.installPath, '.claude-plugin', 'plugin.json'));
    const name = (typeof manifest?.name === 'string' && manifest.name) || key.split('@')[0];
    out.push({ name, dir: row.installPath });
  }
  return out;
}

/** The whole list, uncached. */
export async function listCommands({ cwd, env = process.env } = {}) {
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const all = [...BUILTINS];
  all.push(...await skillsIn(path.join(cwd, '.claude', 'skills'), '', 'project'));
  all.push(...await commandsIn(path.join(cwd, '.claude', 'commands'), '', 'project'));
  all.push(...await skillsIn(path.join(cfg, 'skills'), '', 'user'));
  all.push(...await commandsIn(path.join(cfg, 'commands'), '', 'user'));
  for (const p of await plugins(cfg, cwd)) {
    all.push(...await skillsIn(path.join(p.dir, 'skills'), p.name, 'plugin'));
    all.push(...await commandsIn(path.join(p.dir, 'commands'), p.name, 'plugin'));
  }
  // the first of a name wins (a project skill over a user one of that name)
  const seen = new Set();
  return all.filter((c) => c.name && !seen.has(c.name) && seen.add(c.name));
}

/** `get()` answers from a cache at most `ttl` old; a stale cache is served
 *  while the refresh runs, so nothing ever waits on the disk twice. */
export function commandCache({ cwd, env = process.env, ttl = TTL_MS } = {}) {
  let value = null;
  let at = 0;
  let pending = null;
  const refresh = () => {
    if (!pending) {
      pending = listCommands({ cwd, env })
        .then((v) => { value = v; at = Date.now(); return v; })
        .catch(() => value || BUILTINS)
        .finally(() => { pending = null; });
    }
    return pending;
  };
  return {
    async get() {
      if (value && Date.now() - at < ttl) return value;
      if (value) { refresh(); return value; }
      return refresh();
    },
  };
}
