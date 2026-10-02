// In the claude-chatview window (shell/, a transparent window) the page drops
// its opaque backdrop for a translucent one. ` NoBlur` = nothing blurs behind
// the window there, so the page stays nearly opaque. Classic script in
// <head>, so the first paint already has the right background.
if (/\bClaudeChatviewShell\//.test(navigator.userAgent)) {
  document.documentElement.dataset.shell = 'glass';
  if (/\bNoBlur\b/.test(navigator.userAgent)) document.documentElement.dataset.blur = 'off';
}
