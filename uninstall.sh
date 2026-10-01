#!/usr/bin/env bash
# Reverse ./install.sh: the ~/.local/bin links (only ones pointing here), the
# claude-chatview block in ~/.bashrc / ~/.zshrc, the fish functions, and the statusLine (put back
# to what it was before install.sh, only if it is still the relay).
#
#   ./uninstall.sh          show the plan, ask once
#   ./uninstall.sh --yes    do it without asking
#
# node_modules and this checkout are left alone; delete the folder yourself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="$CLAUDE_DIR/settings.json"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-chatview"
SAVED="$CONF_DIR/previous-statusline.json"
MARK_BEGIN='# >>> claude-chatview >>>'
MARK_END='# <<< claude-chatview <<<'

YES=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
say() { printf '%s\n' "claude-chatview: $*"; }

LINKS=()
for f in claude-chatview claude-chatview-statusline; do
  l="$BIN_DIR/$f"
  if [ -L "$l" ] && [ "$(readlink "$l")" = "$ROOT/bin/$f" ]; then LINKS+=("$l"); fi
done
RCS=()
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] && grep -qF "$MARK_BEGIN" "$rc" && RCS+=("$rc")
done
FISHF=()
for f in claude claude-plain; do
  ff="${XDG_CONFIG_HOME:-$HOME/.config}/fish/functions/$f.fish"
  [ -f "$ff" ] && grep -qF "$MARK_BEGIN" "$ff" && FISHF+=("$ff")
done
STATUS=0
if [ -f "$SETTINGS" ] && grep -q 'claude-chatview-statusline' "$SETTINGS"; then STATUS=1; fi

if [ "${#LINKS[@]}" -eq 0 ] && [ "${#RCS[@]}" -eq 0 ] && [ "${#FISHF[@]}" -eq 0 ] && [ "$STATUS" = 0 ]; then
  say "nothing to undo."
  exit 0
fi
say "will:"
for l in ${LINKS[@]+"${LINKS[@]}"}; do echo "  remove link $l"; done
for ff in ${FISHF[@]+"${FISHF[@]}"}; do echo "  remove $ff"; done
for rc in ${RCS[@]+"${RCS[@]}"}; do echo "  remove the claude-chatview block from $rc (backup: $rc.claude-chatview.bak)"; done
[ "$STATUS" = 1 ] && echo "  restore your previous statusLine in $SETTINGS (backup: $SETTINGS.claude-chatview.bak)"

if [ "$YES" != 1 ]; then
  reply=''
  if [ -r /dev/tty ]; then printf 'Go ahead? [y/N] ' > /dev/tty; read -r reply < /dev/tty || reply=''; fi
  case "$reply" in y|Y|yes|YES) ;; *) say "nothing changed."; exit 0 ;; esac
fi

for l in ${LINKS[@]+"${LINKS[@]}"}; do rm -f "$l"; done
for ff in ${FISHF[@]+"${FISHF[@]}"}; do rm -f "$ff"; done
for rc in ${RCS[@]+"${RCS[@]}"}; do
  cp "$rc" "$rc.claude-chatview.bak"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip' "$rc.claude-chatview.bak" > "$rc"
done
if [ "$STATUS" = 1 ]; then
  SETTINGS="$SETTINGS" SAVED="$SAVED" node -e '
    const fs = require("fs");
    const { SETTINGS, SAVED } = process.env;
    const text = fs.readFileSync(SETTINGS, "utf8");
    let s;
    try { s = JSON.parse(text); } catch { console.error("claude-chatview: settings.json is not valid JSON; left untouched."); process.exit(1); }
    const cur = s.statusLine;
    if (!(cur && typeof cur.command === "string" && cur.command.includes("claude-chatview-statusline"))) process.exit(0);
    fs.writeFileSync(SETTINGS + ".claude-chatview.bak", text);
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(SAVED, "utf8")).statusLine ?? null; } catch { prev = null; }
    if (prev) s.statusLine = prev; else delete s.statusLine;
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  '
  rm -f "$SAVED"
fi
say "done."
