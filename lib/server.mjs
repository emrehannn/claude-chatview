/**
 * The local HTTP + WebSocket server behind one window.
 *
 * Loopback only, a random port, and two secrets minted per run:
 *   * a ONE-TIME link token (`/?k=…`, what the window is opened with). The
 *     first request that presents it gets the session cookie and the token
 *     is spent — a link read off the process list is worthless afterwards;
 *   * the session secret, carried by an HttpOnly, SameSite=Strict cookie
 *     named after the port (cookies ignore ports, so two windows must not
 *     share a name), and handed to `claude`'s environment for the
 *     statusLine relay as a Bearer token.
 * Every request, the socket included, needs the secret; the socket and the
 * POSTs also need an Origin that is this server (or none, for the relay).
 */

import { createServer } from 'node:http';
import { trace } from './trace.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.mjs';
import { serveSocket } from './socket.mjs';
import { commandCache } from './commands.mjs';

const PUBLIC = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public');

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
]);

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
  + "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";


const same = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The window holds tabs, one Claude session each. `/` is the tab strip
 * (`tabs.html`); a tab's page is `/t/<id>/` (`index.html`, its assets and
 * its socket relative to that). A bare `/ws` is the first tab.
 *
 * @param {object} hub  the tabs: `cwd`, `get(id)`, `list()`, `create()`, `close(id)`
 * @param {object} [o]
 * @param {(n: number) => void} [o.onClients]  the number of open sockets changed
 */
export function createChatServer(hub, { onClients = () => {} } = {}) {
  let linkToken = randomBytes(24).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const commands = commandCache({ cwd: hub.cwd });
  let clients = 0;
  let port = 0;

  const cookieName = () => `ccv_${port}`;
  const originOk = (req) => {
    const o = req.headers.origin;
    return !o || o === `http://127.0.0.1:${port}`;
  };
  const authed = (req) => {
    if (same(cookies(req)[cookieName()], secret)) return true;
    const auth = String(req.headers.authorization || '');
    return auth.startsWith('Bearer ') && same(auth.slice(7), secret);
  };

  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
      ...extra,
    });
    res.end(data);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    trace(`first request ${url.pathname}`);
    // the one-time link: trade it for the cookie, then forget it
    if (url.pathname === '/' && url.searchParams.has('k')) {
      if (linkToken && same(url.searchParams.get('k'), linkToken)) {
        linkToken = null;
        res.writeHead(303, {
          Location: '/',
          'Set-Cookie': `${cookieName()}=${secret}; HttpOnly; SameSite=Strict; Path=/`,
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (!authed(req)) {
        send(res, 403, 'This link has already been used. Close this tab and run claude-chatview again.',
          'text/plain; charset=utf-8');
        return;
      }
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (!authed(req)) {
      send(res, 403, 'forbidden', 'text/plain; charset=utf-8');
      return;
    }

    // a tab's page: /t/<id>/… -> the same files, that tab's session
    let pathname = url.pathname;
    let tab = null;
    const tm = /^\/t\/(\d{1,6})(\/.*)?$/.exec(pathname);
    if (tm) {
      tab = tm[1];
      if (!tm[2]) {
        res.writeHead(303, { Location: `/t/${tab}/`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      pathname = tm[2];
    }

    if (pathname === '/api/tabs') {
      if (!originOk(req)) return send(res, 403, { error: 'bad_origin' });
      if (req.method === 'GET') return send(res, 200, { tabs: hub.list() });
      if (req.method === 'POST') return send(res, 200, { id: hub.create() });
      return send(res, 405, { error: 'method_not_allowed' });
    }
    const close = /^\/api\/tabs\/(\d{1,6})\/close$/.exec(pathname);
    if (close) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      if (!originOk(req)) return send(res, 403, { error: 'bad_origin' });
      return send(res, 200, { ok: hub.close(close[1]) });
    }

    if (pathname === '/api/context') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      if (!originOk(req)) return send(res, 403, { error: 'bad_origin' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch {
        return send(res, 400, { error: 'bad_request' });
      }
      // only this window's conversation — a nested `claude` inherits the
      // relay's environment and must not paint its numbers here
      const sid = typeof body?.session_id === 'string' ? body.session_id : null;
      const all = hub.list().map((t) => hub.get(t.id)).filter(Boolean);
      const session = (sid && all.find((x) => x.claudeId === sid))
        || all.find((x) => !x.claudeId)
        || (!sid && all.length === 1 ? all[0] : null);
      if (!session) return send(res, 200, { ok: true, taken: false });
      const cw = body?.context_window || {};
      const taken = session.setContext(cw.used_percentage, cw.remaining_percentage);
      return send(res, 200, { ok: true, taken });
    }

    if (pathname === '/api/commands') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
      return send(res, 200, { commands: await commands.get() });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'method_not_allowed' });
    }
    let rel;
    try {
      if (pathname === '/favicon.ico') {
        rel = 'favicon.svg';
      } else if (pathname === '/') {
        if (tab && !hub.get(tab)) return send(res, 404, 'This chat is closed.', 'text/plain; charset=utf-8');
        rel = tab ? 'index.html' : 'tabs.html';
      } else {
        rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      }
    } catch { return send(res, 404, { error: 'not_found' }); }
    const target = path.resolve(PUBLIC, rel);
    if (!target.startsWith(PUBLIC + path.sep)) return send(res, 404, { error: 'not_found' });
    const type = MIME.get(path.extname(target).toLowerCase());
    if (!type) return send(res, 404, { error: 'not_found' });
    try {
      const buf = await readFile(target);
      return send(res, 200, buf, type);
    } catch {
      return send(res, 404, { error: 'not_found' });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const tm = /^\/t\/(\d{1,6})\/ws$/.exec(url.pathname);
    if (!tm && url.pathname !== '/ws') return refuse('404 Not Found');
    const session = hub.get(tm ? tm[1] : hub.list()[0]?.id);
    if (!session) return refuse('404 Not Found');
    // a browser always sends an Origin on a WebSocket handshake
    if (!req.headers.origin || !originOk(req) || !authed(req)) return refuse('403 Forbidden');
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    clients += 1;
    onClients(clients);
    serveSocket(session, conn);
    const inner = conn.onClose;
    conn.onClose = (...a) => {
      try { inner?.(...a); } finally {
        clients -= 1;
        onClients(clients);
      }
    };
  });

  return {
    server,
    secret,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      port = server.address().port;
      return port;
    },
    get port() { return port; },
    get base() { return `http://127.0.0.1:${port}/`; },
    /** The link the window opens — valid once. */
    get link() { return `http://127.0.0.1:${port}/?k=${linkToken}`; },
  };
}
