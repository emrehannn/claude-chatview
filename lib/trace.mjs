/**
 * `CLAUDE_CHATVIEW_TRACE=1`: milliseconds since launch for each step of
 * starting up, on stderr — where a slow start spends its time.
 */
const on = /^(1|on|yes|true)$/i.test(process.env.CLAUDE_CHATVIEW_TRACE || '');
const seen = new Set();

/** Log `what` once (`always` = every time). */
export function trace(what, always = false) {
  if (!on || (!always && seen.has(what))) return;
  seen.add(what);
  process.stderr.write(`claude-chatview: +${Math.round(performance.now())} ms ${what}\n`);
}
