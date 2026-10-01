/**
 * Open the page in the claude-chatview window (`shell/`, a transparent
 * WebKitGTK window built with Tauri) when it is built, else in an app-style
 * Chromium window (no tabs, no address bar), else in a plain browser tab.
 * `CLAUDE_CHATVIEW_SHELL=off` skips the transparent window.
 *
 * `CLAUDE_CHATVIEW_BROWSER` overrides the search: a command line, with `%u`
 * where the URL goes (appended when there is no `%u`), run through `sh -c`.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHELL_NAME = 'claude-chatview-shell';

/** The transparent window: built in-tree, else installed on PATH. */
export function shellBinary(env = process.env) {
  if (['off', '0', 'no', 'false'].includes(String(env.CLAUDE_CHATVIEW_SHELL || '').toLowerCase())) return null;
  const own = path.join(ROOT, 'shell', 'target', 'release', SHELL_NAME);
  try { accessSync(own, constants.X_OK); return own; } catch { /* not built */ }
  return onPath(SHELL_NAME, env.PATH);
}

/** WebKitGTK renders through EGL; glvnd would load NVIDIA's vendor library
 *  too, which wakes the dGPU from D3cold for seconds. Mesa only. */
const MESA_EGL = '/usr/share/glvnd/egl_vendor.d/50_mesa.json';

/** The first executable called `name` on PATH, or null. No process spawned. */
export function onPath(name, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try { accessSync(p, constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

const LINUX_APP_BROWSERS = [
  'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable',
  'brave-browser', 'brave', 'microsoft-edge', 'vivaldi',
];
const MAC_APP_BROWSERS = ['Google Chrome', 'Chromium', 'Brave Browser', 'Microsoft Edge'];

function macApp(name) {
  return [path.join('/Applications', `${name}.app`),
          path.join(os.homedir(), 'Applications', `${name}.app`)].some((p) => existsSync(p));
}

/** The command to run, as `[file, args, label, env?]`, or null. */
export function pickBrowser(url, { platform = process.platform, env = process.env } = {}) {
  const custom = (env.CLAUDE_CHATVIEW_BROWSER || '').trim();
  if (custom) {
    const q = `'${url.replace(/'/g, "'\\''")}'`;
    const line = custom.includes('%u') ? custom.split('%u').join(q) : `${custom} ${q}`;
    return ['/bin/sh', ['-c', line], `CLAUDE_CHATVIEW_BROWSER (${custom})`];
  }
  const size = '--window-size=1100,900';
  if (platform === 'darwin') {
    for (const app of MAC_APP_BROWSERS) {
      if (macApp(app)) return ['open', ['-na', app, '--args', `--app=${url}`, size], `${app} (app window)`];
    }
    return ['open', [url], 'default browser (tab)'];
  }
  const shell = shellBinary(env);
  if (shell) {
    const extra = existsSync(MESA_EGL) ? { __EGL_VENDOR_LIBRARY_FILENAMES: MESA_EGL } : {};
    return [shell, [url], `${SHELL_NAME} (transparent window)`, extra];
  }
  for (const name of LINUX_APP_BROWSERS) {
    const bin = onPath(name, env.PATH);
    if (bin) return [bin, [`--app=${url}`, size], `${name} (app window)`];
  }
  const opener = onPath('xdg-open', env.PATH);
  if (opener) return [opener, [url], 'xdg-open (tab)'];
  return null;
}

/** Launch it detached; resolves to the label, or null when nothing could. */
export function openWindow(url, opts = {}) {
  const pick = pickBrowser(url, opts);
  if (!pick) return Promise.resolve(null);
  const [file, args, label, extraEnv] = pick;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: 'ignore',
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env });
    } catch { resolve(null); return; }
    child.once('error', () => resolve(null));
    child.once('spawn', () => { child.unref(); resolve(label); });
  });
}
