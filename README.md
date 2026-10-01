# claude-chatview

A chat-style window for [Claude Code](https://claude.com/claude-code).

It is a **rendering layer over the real Claude Code, not a replacement**. The
`claude` you already have runs, unmodified, in a pseudo-terminal; the window
draws the conversation from the transcript Claude Code writes, and what you
type is typed into that terminal. So everything Claude Code does still works —
slash commands, `Esc` to interrupt, `Shift+Tab` modes, `!` shell commands,
subagents, `/resume`, your settings, hooks and MCP servers — because it *is*
Claude Code. Whenever Claude Code puts up something the chat view does not
draw (a permission prompt, a picker, `/config`, the trust dialog), the window
shows the real terminal until the prompt is back.

What the chat view draws:

- your prompts in blue, with the time they were sent;
- Claude's turn between two orange lines: replies as markdown, tool calls with
  a one-line result (`⎿`), back-to-back Bash calls folded into one block (one
  line per command — what it is for; click for the command and its output);
- agent briefs and agent messages folded to one line, click to expand;
- images (in prompts and tool results), click for full size; pasting a
  screenshot into the input attaches it (it sends Ctrl+V to Claude Code);
- background agents and shells as a stacked list above the prompt; click one
  to watch its transcript or output. In an agent's view the input messages
  that agent, through Claude Code's own subagent panel (the page presses the
  keys and reads the screen after each); a shell's view is read-only;
- a `/` dropdown with Claude Code's commands, your skills and plugins;
- the context window as a small bar (optional, see below).

Catppuccin Mocha, with JetBrains Mono Nerd Font bundled.

## Install

Needs node 18+ and npm. On Linux, node-pty (the one npm dependency) is
compiled during install, so you also need python3, make and a C++ compiler:

```sh
sudo apt-get install -y python3 make g++        # Debian / Ubuntu
sudo dnf install -y python3 make gcc-c++        # Fedora
sudo pacman -S --needed python make gcc         # Arch
```

Then:

```sh
git clone <this repo> ~/claude-chatview      # or wherever you keep it
cd ~/claude-chatview
./install.sh
```

`install.sh` checks node, runs `npm ci`, links `claude-chatview` and
`claude-chatview-statusline` into `~/.local/bin`, and then **asks** (default
no) before each optional change:

1. set the statusLine relay in `~/.claude/settings.json` (for the context bar);
2. add to `~/.bashrc` / `~/.zshrc`:

   ```sh
   claude() { claude-chatview "$@"; }
   alias claude-plain='command claude'
   ```

`./install.sh --yes` answers yes to both. `./uninstall.sh` reverses all of it
(links, rc block, statusLine) and leaves backups (`*.claude-chatview.bak`).

## Usage

```sh
cd ~/some/project
claude-chatview                     # or just `claude`, with the shell function
claude-chatview --model opus        # any claude arguments pass straight through
claude-chatview -c                  # continue the last conversation
claude-chatview --resume            # the picker shows in the window's terminal
```

One window is one Claude session, in the directory you started it from. The
window opens as an app window (no tabs or address bar) when Chromium, Chrome,
Brave, Edge or Vivaldi is installed, otherwise as a tab in your default
browser. Set `CLAUDE_CHATVIEW_BROWSER` to choose (`%u` is replaced by the URL).

- **Ctrl+`** (or the button at the top right) switches between the chat view
  and Claude Code's own terminal. The choice is remembered.
- `Enter` sends, `Shift+Enter` is a new line, `Esc` interrupts, `Ctrl+C` is
  Claude Code's Ctrl+C. Long prompts are sent as a paste so nothing is lost.
- `Ctrl` + `=` / `-` / `0` (`Cmd` on macOS) changes the font size.
- When Claude Code exits, the window says so (a clean exit closes it after a
  few seconds) and `claude-chatview` exits with Claude Code's exit code.
- Closing the window stops Claude Code about 10 seconds later. Reloading the
  window is fine — the session keeps running and the screen is restored.
- `Ctrl+C` in the terminal you started it from stops the session too.

Things that are not an interactive session run plain `claude` in your terminal
instead, so aliasing `claude` to this is safe: `-p`/`--print`, `--help`,
`--version`, subcommands (`claude mcp …`, `claude update`, …), piped stdin,
and on Linux a session with no `DISPLAY`/`WAYLAND_DISPLAY` (ssh). Force it
either way with `CLAUDE_CHATVIEW=off` or `CLAUDE_CHATVIEW=force`.
`claude-plain` always runs plain Claude Code.

## The context bar (optional)

Claude Code tells its statusLine command how full the context window is; it
tells nobody else. `claude-chatview-statusline` is a statusLine command that
passes those two numbers to the running window and then runs **your previous
statusLine command unchanged** (install.sh saves it in
`~/.config/claude-chatview/previous-statusline.json`), so your status line in a
plain terminal looks exactly as before. Without the relay, the bar simply does
not show.

## Security

The server listens on `127.0.0.1` only, on a random port. The window is opened
with a one-time link; the first request trades it for an HttpOnly,
SameSite=Strict cookie holding a per-run secret, and every request and the
WebSocket need that secret (the socket also checks the Origin). Other users on
the machine and other web pages cannot drive the terminal. The relay finds the
window through the environment Claude Code inherits from it, or through a
`0600` file in `$XDG_RUNTIME_DIR/claude-chatview/` (else
`~/.cache/claude-chatview/run/`).

## Known limits

- It depends on Claude Code's transcript format (`~/.claude/projects/…/*.jsonl`)
  and on what its prompt looks like on screen (to know when to show the
  terminal). A Claude Code update that changes either can make the chat view
  miss things — the terminal is always one key away.
- The chat view shows a conversation once Claude Code has written it; a turn
  in progress appears as its records are written (tool by tool), not token by
  token.
- `--resume` with a search term, `--continue` and `--fork-session` are
  followed by watching which conversation Claude Code reports; it can take a
  second after start to pick the right one.
- Images are drawn up to about 4.5 MB each.
- Tested on macOS. Linux is the target and should work, but the install
  (node-pty compiling on your distro) and the window opening are not verified
  there yet.
- Windows is not supported.

## Layout

```
bin/        claude-chatview, claude-chatview-statusline (small bootstraps)
lib/        cli (the command), session (the pty), server + socket + ws,
            transcript (reads Claude Code's transcript), commands (the `/` list),
            browser (opens the window), runtime, statusline (the relay)
public/     the page: app.mjs (terminal + view switching), chatview.mjs,
            agentpanel.mjs (messaging an agent via the subagent panel),
            markdown.mjs, app.css, vendor/ (xterm.js 6, fonts)
```

`npm run check` syntax-checks every file.

Bundled third-party code: xterm.js and its fit / WebGL addons (MIT), and
JetBrains Mono Nerd Font Mono (SIL OFL 1.1); their licenses are next to them
under `public/vendor/`.
