#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod anime;
mod chrono;
mod db;
mod media;
mod server;

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::platform::windows::WindowExtWindows;
use tao::window::{Fullscreen, WindowBuilder};
use wry::{NewWindowResponse, WebContext, WebViewBuilder, WebViewBuilderExtWindows};

enum UiEvent {
    Eval(String),
    ToggleFullscreen,
}

static UI: OnceLock<Mutex<EventLoopProxy<UiEvent>>> = OnceLock::new();
static HWND: OnceLock<isize> = OnceLock::new();

fn send(event: UiEvent) {
    if let Some(proxy) = UI.get() {
        let _ = proxy.lock().unwrap().send_event(event);
    }
}

/// Runs JS in the page, like pywebview's `window.evaluate_js`.
pub fn eval_js(js: String) {
    send(UiEvent::Eval(js));
}

pub fn toggle_fullscreen() {
    send(UiEvent::ToggleFullscreen);
}

pub fn hwnd() -> Option<isize> {
    HWND.get().copied()
}

/// `%APPDATA%\MinimalMediaPlayerPro`: the old app's DB files and WebView2 profile (localStorage) live here.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = base.join("MinimalMediaPlayerPro");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Folder holding `templates/` and `keys.json`: next to the exe, or the project root when run from `target/`.
pub fn app_root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from))
            .unwrap_or_default();
        exe_dir
            .ancestors()
            .take(4)
            .find(|d| d.join("templates").is_dir())
            .map(PathBuf::from)
            .unwrap_or(exe_dir)
    })
}

pub fn log(msg: &str) {
    let path = app_root().join("player_log.txt");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{msg}");
    }
}

fn main() -> wry::Result<()> {
    // Stable port keeps the WebView origin (and its localStorage) the same as the old app.
    let listener = std::net::TcpListener::bind("127.0.0.1:8765")
        .or_else(|_| std::net::TcpListener::bind("127.0.0.1:0"))
        .expect("bind local port");
    let port = listener.local_addr().expect("local addr").port();
    std::thread::spawn(move || server::run(listener));
    ai::ensure_keys_file();
    log(&format!("Rust backend started on 127.0.0.1:{port}"));

    let event_loop = EventLoopBuilder::<UiEvent>::with_user_event().build();
    UI.set(Mutex::new(event_loop.create_proxy())).ok();
    let mut builder = WindowBuilder::new()
        .with_title("Minimal Media Player Pro")
        .with_inner_size(LogicalSize::new(1000.0, 680.0))
        .with_min_inner_size(LogicalSize::new(800.0, 520.0));
    // Centered on the primary monitor, like the pywebview window was.
    if let Some(m) = event_loop.primary_monitor() {
        let (size, pos, scale) = (m.size(), m.position(), m.scale_factor());
        let x = pos.x + ((size.width as f64 - 1000.0 * scale) / 2.0) as i32;
        let y = pos.y + ((size.height as f64 - 680.0 * scale) / 2.0) as i32;
        builder = builder.with_position(PhysicalPosition::new(x, y));
    }
    let window = builder.build(&event_loop).expect("create window");
    HWND.set(window.hwnd()).ok();

    let mut context = WebContext::new(Some(data_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url(format!("http://127.0.0.1:{port}/"))
        .with_initialization_script(server::shim())
        .with_background_color((2, 2, 4, 255))
        .with_devtools(cfg!(debug_assertions))
        .with_new_window_req_handler(|url, _| {
            let _ = open::that_detached(url);
            NewWindowResponse::Deny
        })
        .with_additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-hardware-overlays",
        )
        .build(&window)?;

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        let _ = &context;
        match event {
            Event::UserEvent(UiEvent::Eval(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(UiEvent::ToggleFullscreen) => {
                let next = match window.fullscreen() {
                    Some(_) => None,
                    None => Some(Fullscreen::Borderless(None)),
                };
                window.set_fullscreen(next);
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            _ => {}
        }
    })
}
