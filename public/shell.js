// In the claude-chatview window (shell/, a transparent WebKitGTK window) the
// page drops its opaque backdrop for a translucent one. Classic script in
// <head>, so the first paint already has the right background.
if (/\bClaudeChatviewShell\//.test(navigator.userAgent)) {
  document.documentElement.dataset.shell = 'glass';
}
