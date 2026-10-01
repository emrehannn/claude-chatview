#!/usr/bin/env bash
# Install claude-chatview for the current user.
#
#   ./install.sh          ask before each optional step (default: no)
#   ./install.sh --yes    answer yes to every optional step
#
# Always: checks node >= 18, installs the one npm dependency (node-pty),
# links bin/ into ~/.local/bin. Optional, asked first, never silent:
#   * the statusLine relay in ~/.claude/settings.json (the context bar),
#     keeping your previous statusLine so the relay can still draw it;
#   * `claude` -> claude-chatview in ~/.bashrc / ~/.zshrc, plus
#     `claude-plain` for plain Claude Code.
# ./uninstall.sh reverses all of it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-chatview"
MARK_BEGIN='# >>> claude-chatview >>>'
MARK_END='# <<< claude-chatview <<<'

YES=0
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "claude-chatview: $*"; }
die() { printf '%s\n' "claude-chatview: $*" >&2; exit 1; }

ask() {   # ask "question" -> 0 for yes
  if [ "$YES" = 1 ]; then return 0; fi
  local reply=''
  if [ -r /dev/tty ]; then
    printf '%s [y/N] ' "$1" > /dev/tty
    read -r reply < /dev/tty || reply=''
  fi
  case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

build_deps_hint() {
  if [ "$(uname -s)" = Darwin ]; then
    echo "  xcode-select --install"
  elif command -v apt-get >/dev/null 2>&1; then
    echo "  sudo apt-get install -y python3 make g++"
  elif command -v dnf >/dev/null 2>&1; then
    echo "  sudo dnf install -y python3 make gcc-c++"
  elif command -v pacman >/dev/null 2>&1; then
    echo "  sudo pacman -S --needed python make gcc"
  elif command -v zypper >/dev/null 2>&1; then
    echo "  sudo zypper install -y python3 make gcc-c++"
  else
    echo "  (install python3, make and a C++ compiler with your package manager)"
  fi
}

# ── node ────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "node is not installed (need 18 or newer)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node $(node --version) is too old (need 18 or newer)."
command -v npm >/dev/null 2>&1 || die "npm is not installed."
say "node $(node --version) OK"

# ── node-pty ───────────────────────────────────────────────────────────
say "installing node-pty (on Linux this compiles it: python3, make, g++) ..."
if ! ( cd "$ROOT" && npm ci --omit=dev --no-audit --no-fund ); then
  echo
  say "npm ci failed. node-pty is a native module; on Linux it is built from"
  say "source and needs python3, make and a C++ compiler. Install them with:"
  build_deps_hint
  say "then run ./install.sh again."
  exit 1
fi

# node-pty 1.1.0 publishes its prebuilt spawn-helper without the execute bit
for helper in "$ROOT"/node_modules/node-pty/prebuilds/*/spawn-helper \
              "$ROOT"/node_modules/node-pty/build/Release/spawn-helper; do
  [ -f "$helper" ] && chmod +x "$helper"
done

if ! ( cd "$ROOT" && node -e '
  import("node-pty").then((m) => {
    const pty = m.default?.spawn ? m.default : m;
    const p = pty.spawn("/bin/sh", ["-c", "exit 0"], { cols: 80, rows: 24 });
    const t = setTimeout(() => process.exit(1), 5000);
    p.onExit(() => { clearTimeout(t); process.exit(0); });
  }).catch(() => process.exit(1));' ); then
  say "node-pty is installed but cannot open a pseudo-terminal. Rebuild it:"
  build_deps_hint
  echo "  (cd \"$ROOT\" && npm rebuild node-pty --foreground-scripts)"
  exit 1
fi
say "node-pty OK (opened a real pty)"

# ── commands on PATH ───────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
for f in claude-chatview claude-chatview-statusline; do
  chmod +x "$ROOT/bin/$f"
  ln -sfn "$ROOT/bin/$f" "$BIN_DIR/$f"
done
say "linked claude-chatview and claude-chatview-statusline into $BIN_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH — add it in your shell's rc file." ;;
esac

# ── optional: the statusLine relay (context bar) ───────────────────────
SETTINGS="$CLAUDE_DIR/settings.json"
RELAY="$BIN_DIR/claude-chatview-statusline"
echo
say "Optional: the context bar. Claude Code tells its statusLine command how"
say "full the context window is; the relay passes that to the window, then"
say "runs your current statusLine unchanged. This edits $SETTINGS"
say "(a backup is written next to it)."
if ask "Set claude-chatview-statusline as your statusLine?"; then
  mkdir -p "$CLAUDE_DIR" "$CONF_DIR"
  SETTINGS="$SETTINGS" RELAY="$RELAY" SAVED="$CONF_DIR/previous-statusline.json" node -e '
    const fs = require("fs");
    const { SETTINGS, RELAY, SAVED } = process.env;
    let s = {};
    if (fs.existsSync(SETTINGS)) {
      const text = fs.readFileSync(SETTINGS, "utf8");
      try { s = JSON.parse(text); } catch (e) {
        console.error("claude-chatview: " + SETTINGS + " is not valid JSON; left untouched."); process.exit(1);
      }
      fs.writeFileSync(SETTINGS + ".claude-chatview.bak", text);
    }
    const cur = s.statusLine;
    const ours = cur && typeof cur.command === "string" && cur.command.includes("claude-chatview-statusline");
    if (!ours) fs.writeFileSync(SAVED, JSON.stringify({ statusLine: cur ?? null }, null, 2) + "\n");
    s.statusLine = { ...(cur && !ours && typeof cur === "object" ? cur : {}), type: "command", command: RELAY };
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  ' && say "statusLine set; your previous one is saved in $CONF_DIR/previous-statusline.json"
else
  say "skipped — the window simply shows no context bar."
fi

# ── optional: `claude` opens the window ────────────────────────────────
add_block() {   # add_block <rc file>
  local rc="$1"
  if [ -f "$rc" ] && grep -qF "$MARK_BEGIN" "$rc"; then
    say "$rc already has the claude-chatview block."
    return
  fi
  {
    printf '\n%s\n' "$MARK_BEGIN"
    printf '%s\n' "unalias claude 2>/dev/null"
    printf '%s\n' 'claude() { claude-chatview "$@"; }'
    printf '%s\n' "alias claude-plain='command claude'"
    printf '%s\n' "$MARK_END"
  } >> "$rc"
  say "added to $rc"
}

RCS=()
[ -f "$HOME/.bashrc" ] && RCS+=("$HOME/.bashrc")
[ -f "$HOME/.zshrc" ] && RCS+=("$HOME/.zshrc")
if [ "${#RCS[@]}" -eq 0 ]; then
  case "${SHELL:-}" in
    */zsh) RCS+=("$HOME/.zshrc") ;;
    *) RCS+=("$HOME/.bashrc") ;;
  esac
fi
echo
say "Optional: make \`claude\` open the window, with \`claude-plain\` for plain"
say "Claude Code. (Non-interactive uses — claude -p, claude mcp, pipes, ssh"
say "without a display — still run plain claude.)"
if ask "Add this to ${RCS[*]}?"; then
  for rc in "${RCS[@]}"; do add_block "$rc"; done
  say "open a new shell (or: source ${RCS[0]}) to use it."
else
  say "skipped — run claude-chatview directly."
fi

echo
say "done. Try it: cd into a project and run claude-chatview"
