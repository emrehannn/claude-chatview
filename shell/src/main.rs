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
//! On KDE Plasma (Wayland) the window also asks KWin to blur what is behind
//! it (`blur.rs`); `CLAUDE_CHATVIEW_BLUR=off` leaves it a clear tint. The
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

/// What the page looks for to switch to its see-through look (`glass.mjs`).
const UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 \
                  (KHTML, like Gecko) Version/18.0 Safari/605.1.15 ClaudeChatviewShell/1";
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

    tauri::Builder::default()
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.clone()))
                .title("Claude Code")
                .inner_size(1100.0, 900.0)
                .transparent(true)
                .user_agent(UA)
                .build()?;
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
