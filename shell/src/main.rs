//! The claude-chatview window.
//!
//! `claude-chatview-shell <url>` opens the local chat page (served by the
//! Node side, `lib/server.mjs`) in a transparent WebKitGTK window, so the
//! page's translucent background shows the desktop through it. Nothing else
//! lives here: no IPC, no assets — the page is the app.
//!
//! The window closes itself once the server is gone (every tab's Claude has
//! exited), because a script's `window.close()` does not close a top-level
//! WebKitGTK window. Closing the window ends the sessions the same way a
//! closed browser window does: the server sees its sockets drop.
//!
//! Behind it the desktop is blurred: by KWin on KDE Plasma (`blur.rs`), by
//! macOS's own vibrancy on a Mac. Where no blur can be had (another Linux
//! compositor, X11) the page is told so through its user agent and draws
//! itself nearly opaque instead. `CLAUDE_CHATVIEW_BLUR=off` = a clear tint. The
//! see-through part is per pixel — the page's background alpha — never a
//! window opacity, so text and every other opaque pixel stay fully opaque.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::thread;
use std::time::Duration;

use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "linux")]
mod blur;

fn blur_wanted() -> bool {
    let v = std::env::var("CLAUDE_CHATVIEW_BLUR").unwrap_or_default().to_ascii_lowercase();
    !matches!(v.as_str(), "off" | "0" | "no" | "false")
}

/// What the page looks for to switch to its see-through look (`public/shell.js`);
/// ` NoBlur` after it = nothing blurs behind the window.
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 \
                  (KHTML, like Gecko) Version/18.0 Safari/605.1.15 ClaudeChatviewShell/1";

/// Whether something will blur behind the window (asked before it exists).
fn blur_available() -> bool {
    #[cfg(target_os = "linux")]
    return blur::available();
    #[cfg(target_os = "macos")]
    return true;
    #[allow(unreachable_code)]
    false
}
/// Consecutive failed connects before the server counts as gone.
const GONE_AFTER: u32 = 2;

fn main() {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: claude-chatview-shell <url>");
        std::process::exit(2);
    };
    let url: tauri::Url = match arg.parse() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("claude-chatview-shell: bad url: {e}");
            std::process::exit(2);
        }
    };
    let addr: Option<SocketAddr> = url
        .socket_addrs(|| None)
        .ok()
        .and_then(|a| a.into_iter().next());

    // blur deliberately off is a clear tint, as asked; blur that cannot be had
    // is a near-opaque page, so text never sits on a sharp desktop
    let ua = if blur_wanted() && !blur_available() {
        eprintln!("claude-chatview-shell: nothing can blur behind the window here; drawing it nearly opaque");
        format!("{UA} NoBlur")
    } else {
        UA.to_string()
    };

    tauri::Builder::default()
        .setup(move |app| {
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("Claude Code")
                .inner_size(1100.0, 900.0)
                .transparent(true)
                .user_agent(&ua);
            // macOS: the system's own blur behind the window, dark to match the page
            #[cfg(target_os = "macos")]
            let builder = if blur_wanted() {
                use tauri::window::{Effect, EffectState, EffectsBuilder};
                builder.effects(EffectsBuilder::new().effect(Effect::HudWindow)
                    .state(EffectState::Active).build())
            } else {
                builder
            };
            let window = builder.build()?;
            #[cfg(target_os = "linux")]
            if blur_wanted() {
                match window.gtk_window() {
                    Ok(w) => blur::enable(w),
                    Err(e) => eprintln!("claude-chatview-shell: no blur behind the window ({e})"),
                }
            }
            #[cfg(not(target_os = "linux"))]
            let _ = (window, blur_wanted());

            if let Some(addr) = addr {
                let handle = app.handle().clone();
                thread::spawn(move || {
                    let mut misses = 0;
                    loop {
                        thread::sleep(Duration::from_secs(1));
                        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
                            misses = 0;
                        } else {
                            misses += 1;
                            if misses >= GONE_AFTER {
                                handle.exit(0);
                                break;
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("claude-chatview-shell: could not start the window");
}
