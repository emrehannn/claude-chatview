//! Blur behind the window, done by KWin.
//!
//! KWin's blur effect is a GPU dual-Kawase blur that only re-runs where the
//! screen behind the window changed; a window gets it by asking. WebKitGTK
//! never asks, so this does, on GTK's own connection and surface — no KWin
//! plugin involved. The request is the standard `ext_background_effect_v1`
//! (what current KWin offers), else KDE's older `org_kde_kwin_blur`.
//!
//! The blurred region is the window's content (the GTK child's allocation),
//! not the whole surface: on Wayland GTK draws client-side decorations, and
//! their translucent drop shadow is part of the surface — blurring that would
//! put a frosted halo around the window. Re-sent whenever the content moves
//! or resizes.
//!
//! Anything missing (X11, a compositor without the protocol) = no blur, and
//! the window still works.

use std::cell::Cell;
use std::rc::Rc;

use gtk::prelude::*;
use wayland_backend::client::{Backend, ObjectId};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_compositor::WlCompositor, wl_region::WlRegion,
                               wl_registry::WlRegistry, wl_surface::WlSurface};
use wayland_client::{delegate_noop, Connection, Dispatch, EventQueue, Proxy, QueueHandle};
use wayland_protocols::ext::background_effect::v1::client::{
    ext_background_effect_manager_v1::ExtBackgroundEffectManagerV1,
    ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1,
};
use wayland_protocols_plasma::blur::client::org_kde_kwin_blur::OrgKdeKwinBlur;
use wayland_protocols_plasma::blur::client::org_kde_kwin_blur_manager::OrgKdeKwinBlurManager;

struct State;

impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(_: &mut Self, _: &WlRegistry, _: <WlRegistry as Proxy>::Event,
             _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}
delegate_noop!(State: ignore WlCompositor);
delegate_noop!(State: ignore WlRegion);
delegate_noop!(State: ignore OrgKdeKwinBlurManager);
delegate_noop!(State: ignore OrgKdeKwinBlur);
delegate_noop!(State: ignore ExtBackgroundEffectManagerV1);
delegate_noop!(State: ignore ExtBackgroundEffectSurfaceV1);

/// Whichever blur request the compositor speaks.
enum Effect {
    Ext(ExtBackgroundEffectSurfaceV1),
    Kde(OrgKdeKwinBlur),
}

struct Blur {
    conn: Connection,
    qh: QueueHandle<State>,
    // the queue the objects below belong to; kept alive with them
    _queue: EventQueue<State>,
    compositor: WlCompositor,
    effect: Effect,
    window: gtk::ApplicationWindow,
}

impl Blur {
    /// Blur exactly `rect` (surface coordinates). Takes effect on GTK's next
    /// commit of the surface, which `queue_draw` asks for.
    fn set(&self, (x, y, w, h): (i32, i32, i32, i32)) {
        let region: WlRegion = self.compositor.create_region(&self.qh, ());
        region.add(x, y, w, h);
        match &self.effect {
            Effect::Ext(e) => e.set_blur_region(Some(&region)),
            Effect::Kde(b) => {
                b.set_region(Some(&region));
                b.commit();
            }
        }
        region.destroy();
        let _ = self.conn.flush();
        self.window.queue_draw();
    }
}

/// The content rect: the window's child, in the surface's coordinates.
fn content_rect(window: &gtk::ApplicationWindow) -> Option<(i32, i32, i32, i32)> {
    let a = window.child()?.allocation();
    (a.width() > 0 && a.height() > 0).then(|| (a.x(), a.y(), a.width(), a.height()))
}

fn attach(window: &gtk::ApplicationWindow) -> Result<Blur, String> {
    let gdk_window = window.window().ok_or("not realized")?;
    let display = gdk_window.display();
    if display.type_().name() != "GdkWaylandDisplay" {
        return Err("not a Wayland session".into());
    }
    unsafe {
        let wl_display = gdk_wayland_sys::gdk_wayland_display_get_wl_display(
            display.as_ptr() as *mut _);
        let wl_surface = gdk_wayland_sys::gdk_wayland_window_get_wl_surface(
            gdk_window.as_ptr() as *mut _);
        if wl_display.is_null() || wl_surface.is_null() {
            return Err("no Wayland surface yet".into());
        }
        let backend = Backend::from_foreign_display(wl_display as *mut _);
        let conn = Connection::from_backend(backend);
        let (globals, queue) = registry_queue_init::<State>(&conn).map_err(|e| e.to_string())?;
        let qh = queue.handle();
        let compositor: WlCompositor = globals.bind(&qh, 1..=4, ()).map_err(|e| e.to_string())?;
        let id = ObjectId::from_ptr(WlSurface::interface(), wl_surface as *mut _)
            .map_err(|e| format!("{e:?}"))?;
        let surface = WlSurface::from_id(&conn, id).map_err(|e| format!("{e:?}"))?;
        let effect = if let Ok(m) = globals.bind::<ExtBackgroundEffectManagerV1, _, _>(&qh, 1..=1, ()) {
            Effect::Ext(m.get_background_effect(&surface, &qh, ()))
        } else if let Ok(m) = globals.bind::<OrgKdeKwinBlurManager, _, _>(&qh, 1..=1, ()) {
            Effect::Kde(m.create(&surface, &qh, ()))
        } else {
            return Err("the compositor offers no blur protocol".into());
        };
        Ok(Blur { conn, qh, _queue: queue, compositor, effect, window: window.clone() })
    }
}

/// Whether the window will get a blur at all: GTK will be on Wayland and the
/// compositor offers one of the two protocols. Asked on a connection of its
/// own before the window exists, so the page can be told in its user agent
/// (no blur = a near-opaque page instead of a see-through one).
pub fn available() -> bool {
    let backend = std::env::var("GDK_BACKEND").unwrap_or_default();
    if !backend.is_empty() && !backend.trim_start().starts_with("wayland") {
        return false;
    }
    let Ok(conn) = Connection::connect_to_env() else { return false };
    let Ok((globals, _queue)) = registry_queue_init::<State>(&conn) else { return false };
    globals.contents().with_list(|list| list.iter().any(|g| {
        g.interface == ExtBackgroundEffectManagerV1::interface().name
            || g.interface == OrgKdeKwinBlurManager::interface().name
    }))
}

/// Ask KWin to blur behind `window`'s content, now and on every resize.
pub fn enable(window: gtk::ApplicationWindow) {
    let start = move |w: &gtk::ApplicationWindow| -> bool {
        let blur = match attach(w) {
            Ok(b) => Rc::new(b),
            Err(why) => {
                eprintln!("claude-chatview-shell: no blur behind the window ({why})");
                return true;
            }
        };
        let last = Rc::new(Cell::new((0, 0, 0, 0)));
        let apply = {
            let (blur, last) = (blur.clone(), last.clone());
            move |w: &gtk::ApplicationWindow| {
                if let Some(r) = content_rect(w) {
                    if r != last.get() {
                        last.set(r);
                        blur.set(r);
                    }
                }
            }
        };
        apply(w);
        // the content rect is only known once GTK has laid the window out
        w.connect_size_allocate(move |w, _| apply(w));
        true
    };
    // the Wayland surface exists once the window is mapped
    if window.is_mapped() {
        start(&window);
    } else {
        let done = Rc::new(Cell::new(false));
        window.connect_map_event(move |w, _| {
            if !done.replace(true) {
                start(w);
            }
            gtk::glib::Propagation::Proceed
        });
    }
}
