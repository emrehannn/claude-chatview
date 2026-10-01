/**
 * The tab strip. One frame per tab, each the ordinary one-session page at
 * /t/<id>/. The frames hand their tab keys here (see `tabKey` in app.mjs),
 * because a key pressed in a frame never reaches this page.
 */

const strip = document.getElementById('strip');
const newBtn = document.getElementById('newTab');
const frames = document.getElementById('frames');

/** id -> {id, frame, btn, label, project, running, ended} */
const tabs = new Map();
let active = null;
let creating = false;

const api = (path, method = 'GET') => fetch(path, { method }).then((r) => r.json());
const order = () => [...tabs.keys()];

function paint(t) {
  const n = order().indexOf(t.id) + 1;
  t.label.textContent = `${n} · ${t.project || 'chat'}`;
  t.btn.dataset.tone = t.ended ? 'ended' : t.running ? 'working' : 'idle';
  t.btn.title = `${t.project || 'chat'}${t.ended ? ' — ended' : t.running ? ' — working' : ''}`
    + (n <= 9 ? `  (Ctrl+${n})` : '');
}

function add(id) {
  const frame = document.createElement('iframe');
  frame.src = `t/${id}/`;
  frame.title = `Claude Code chat ${id}`;
  const btn = document.createElement('div');
  btn.className = 'tab';
  btn.setAttribute('role', 'tab');
  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.textContent = '●';
  const label = document.createElement('span');
  label.className = 'tab-label';
  const x = document.createElement('span');
  x.className = 'tab-x';
  x.textContent = '×';
  x.title = 'Close chat (Ctrl+W)';
  btn.append(dot, label, x);
  const t = { id, frame, btn, label, project: '', running: false, ended: false };
  btn.addEventListener('mousedown', (ev) => {
    if (ev.button === 1) { ev.preventDefault(); close(id); return; }
    if (ev.target === x) return;
    activate(id);
  });
  x.addEventListener('click', () => close(id));
  strip.insertBefore(btn, newBtn);
  frames.append(frame);
  tabs.set(id, t);
  paint(t);
  return t;
}

function activate(id) {
  const t = tabs.get(id);
  if (!t) return;
  active = id;
  for (const o of tabs.values()) {
    const on = o.id === id;
    o.frame.classList.toggle('active', on);
    o.btn.classList.toggle('active', on);
    o.btn.setAttribute('aria-selected', String(on));
  }
  t.btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.title = `Claude Code · ${t.project || 'chat'}`;
  t.frame.focus();
  t.frame.contentWindow?.postMessage({ t: 'focus' }, location.origin);
}

async function create() {
  if (creating) return;
  creating = true;
  try {
    const { id } = await api('api/tabs', 'POST');
    if (id) activate(add(String(id)).id);
  } finally { creating = false; }
}

function close(id) {
  const t = tabs.get(id);
  if (!t) return;
  const ids = order();
  const at = ids.indexOf(id);
  tabs.delete(id);
  t.frame.remove();
  t.btn.remove();
  api(`api/tabs/${id}/close`, 'POST').catch(() => {});
  if (!tabs.size) { window.close(); return; }
  for (const o of tabs.values()) paint(o);
  if (active === id) {
    const rest = order();
    activate(rest[Math.min(at, rest.length - 1)]);
  }
}

function step(d) {
  const ids = order();
  if (ids.length < 2) return;
  const i = ids.indexOf(active);
  activate(ids[(i + d + ids.length) % ids.length]);
}

function onKey(k) {
  if (k.op === 'new') create();
  else if (k.op === 'close') close(active);
  else if (k.op === 'next') step(1);
  else if (k.op === 'prev') step(-1);
  else if (k.op === 'go') {
    const ids = order();
    activate(k.n === 9 ? ids[ids.length - 1] : ids[k.n - 1]);
  }
}

window.addEventListener('message', (ev) => {
  if (ev.origin !== location.origin) return;
  const t = [...tabs.values()].find((o) => o.frame.contentWindow === ev.source);
  if (!t || !ev.data || typeof ev.data !== 'object') return;
  const m = ev.data;
  if (m.t === 'key') onKey(m);
  else if (m.t === 'close') close(t.id);
  else if (m.t === 'info') {
    if (typeof m.project === 'string' && m.project) t.project = m.project;
    if (typeof m.running === 'boolean') t.running = m.running;
    if (m.ended) t.ended = true;
    paint(t);
    if (t.id === active) document.title = `Claude Code · ${t.project || 'chat'}`;
  }
});

// the same keys when this page itself has the keyboard (the strip)
window.addEventListener('keydown', (ev) => {
  if (!ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  let op = null;
  if (!ev.shiftKey && k === 't') op = { op: 'new' };
  else if (!ev.shiftKey && k === 'w') op = { op: 'close' };
  else if (k === 'Tab') op = { op: ev.shiftKey ? 'prev' : 'next' };
  else if (k === 'PageDown') op = { op: 'next' };
  else if (k === 'PageUp') op = { op: 'prev' };
  else if (/^Digit[1-9]$/.test(ev.code)) op = { op: 'go', n: Number(ev.code.slice(5)) };
  if (!op) return;
  ev.preventDefault();
  onKey(op);
}, true);

newBtn.addEventListener('click', () => create());

const { tabs: list = [] } = await api('api/tabs');
for (const t of list) add(String(t.id));
if (tabs.size) activate(order()[0]);
