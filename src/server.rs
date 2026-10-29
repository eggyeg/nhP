use axum::extract::{Path, Query, Request};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::collections::HashMap;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

/// Every PlayerAPI method the old UI knows. It checks `typeof api[name] === 'function'` before booting,
/// so all of them exist; the ones not rebuilt yet answer with a clean error instead of hanging.
const METHODS: &[&str] = &[
    "get_app_version", "load_all_databases", "load_db_data", "save_db_data",
    "process_file", "get_file_duration", "analyze_media_compat", "check_playback_fixes",
    "prepare_media_for_playback", "media_task_status", "safe_delete_replaced_media",
    "select_files", "select_link_file", "select_link_folder", "toggle_native_fullscreen",
    "open_external_url", "start_magnet_link", "ai_assistant_chat",
    "get_ai_franchise_search_plan", "get_ai_franchise_info",
    // Not wired yet.
    "torrent_add_raw", "torrent_status", "search_nyaa_torrents", "download_torrent_to_watch",
    "movie_raw_search", "ensure_flaresolverr", "watch_share_download_start",
    "chromecast_list_devices", "chromecast_play_url", "dub_provider_list_voices",
    "dub_provider_download_episode", "dub_browser_inject_helper", "dub_browser_clean_ads",
    "open_internal_url", "open_chromium_dub_browser", "merger_open_folder", "merger_get_config",
    "merger_scan", "merger_autosync", "merger_run", "merger_import_downloads",
    "merger_list_outputs", "merger_autosync_merge_all",
];

/// Injected before the page loads: recreates `window.pywebview.api` on top of `/api/rpc`.
pub fn shim() -> String {
    let methods = serde_json::to_string(METHODS).unwrap();
    format!(
        r#"(() => {{
  if (location.hostname !== '127.0.0.1' || window.pywebview) return;
  // The old cloud server (54.235.4.93) is gone; a saved URL pointing at it would hijack the assistant.
  try {{ if ((localStorage.getItem('modernplayer_api_url') || '').includes('54.235.4.93')) localStorage.removeItem('modernplayer_api_url'); }} catch (e) {{}}
  // api.jikan.moe is unreachable here; the backend answers the same URLs with AniList data.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {{
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    return url.startsWith('https://api.jikan.moe/') ? nativeFetch('/jikan/' + url.slice(22), init) : nativeFetch(input, init);
  }};
  const call = async (name, args) => {{
    const r = await fetch('/api/rpc/' + name, {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }}, body: JSON.stringify(args) }});
    const res = await r.json();
    if (!res.ok) throw new Error(res.error);
    return res.value;
  }};
  const api = {{}};
  for (const name of {methods}) api[name] = (...args) => call(name, args);
  window.pywebview = {{ api, platform: 'rust', token: '' }};
  const ready = () => window.dispatchEvent(new Event('pywebviewready'));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
}})();"#
    )
}

pub fn run(listener: std::net::TcpListener) {
    listener.set_nonblocking(true).expect("nonblocking listener");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
        let templates = crate::app_root().join("templates");
        let app = Router::new()
            .route_service("/", ServeFile::new(templates.join("index.html")))
            .nest_service("/static", ServeDir::new(&templates))
            .route("/media", get(media))
            .route("/api/health", get(health))
            .route("/api/load_all_databases", get(load_all))
            .route("/api/save_db_data", post(save_db))
            .route("/api/assistant_chat", post(assistant))
            .route("/api/rpc/{method}", post(rpc))
            .route("/jikan/{*path}", get(jikan))
            .layer(SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("no-store")));
        axum::serve(listener, app).await.expect("http server");
    });
}

fn json_text(body: String) -> Response {
    ([(header::CONTENT_TYPE, "application/json; charset=utf-8")], body).into_response()
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Local files for the player, with Range support (seeking).
async fn media(Query(q): Query<HashMap<String, String>>, req: Request) -> Response {
    let Some(raw) = q.get("path") else {
        return (StatusCode::BAD_REQUEST, "Missing path parameter").into_response();
    };
    let Some(path) = crate::media::resolve(raw) else {
        return (StatusCode::NOT_FOUND, format!("File not found: {raw}")).into_response();
    };
    let mime = match crate::media::ext(&path).as_str() {
        "m4a" | "mp4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "mkv" => Some("video/x-matroska"),
        "mp4" => Some("video/mp4"),
        "ts" => Some("video/mp2t"),
        _ => None,
    };
    let mut res = ServeFile::new(path).oneshot(req).await.into_response();
    if let (Some(mime), true) = (mime, res.status().is_success()) {
        res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    }
    res
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "success", "api_ready": true, "methods": METHODS, "version": env!("CARGO_PKG_VERSION") }))
}

async fn load_all() -> Response {
    json_text(blocking(crate::db::load_all).await.unwrap_or_else(|_| "{}".into()))
}

async fn save_db(Json(p): Json<Value>) -> Json<Value> {
    let (key, data) = (arg_str(&p["key"]), arg_str(&p["data"]));
    let ok = blocking(move || crate::db::save(&key, &data)).await.unwrap_or(false);
    Json(json!({ "status": if ok { "success" } else { "error" }, "ok": ok }))
}

async fn assistant(Json(p): Json<Value>) -> Response {
    let (msg, ctx) = (arg_str(&p["message"]), arg_str(&p["context"]));
    let out = blocking(move || crate::ai::assistant(&msg, &ctx)).await;
    json_text(out.unwrap_or_else(|e| json!({ "status": "error", "answer": e, "actions": [] }).to_string()))
}

async fn jikan(Path(path): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let (status, body) = blocking(move || crate::anime::jikan_compat(&path, &q)).await.unwrap_or_else(|e| (500, json!({ "message": e })));
    (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), Json(body)).into_response()
}

async fn rpc(Path(method): Path<String>, Json(args): Json<Vec<Value>>) -> Json<Value> {
    Json(match blocking(move || call(&method, &args)).await {
        Ok(Ok(value)) => json!({ "ok": true, "value": value }),
        Ok(Err(e)) | Err(e) => json!({ "ok": false, "error": e }),
    })
}

/// pywebview passed JS numbers and strings straight to Python; accept both.
fn arg_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Methods that returned `json.dumps(...)` in Python return a JSON *string* here too: the UI calls JSON.parse on them.
fn text(v: Value) -> Value {
    Value::String(v.to_string())
}

fn call(method: &str, a: &[Value]) -> Result<Value, String> {
    use crate::{ai, chrono, db, media};
    let s = |i: usize| a.get(i).map(arg_str).unwrap_or_default();
    let raw = |i: usize| a.get(i).cloned().unwrap_or(Value::Null);
    Ok(match method {
        "get_app_version" => json!(concat!("ModernPlayer-Rust-", env!("CARGO_PKG_VERSION"))),
        "load_all_databases" => Value::String(db::load_all()),
        "load_db_data" => Value::String(db::load(&s(0))),
        "save_db_data" => json!(db::save(&s(0), &s(1))),
        "process_file" => media::process_file(&s(0), &s(1)),
        "get_file_duration" => json!(media::duration(&s(0))),
        "analyze_media_compat" => text(media::analyze(&s(0))),
        "check_playback_fixes" => text(media::check_playback_fixes(&s(0))),
        "prepare_media_for_playback" => {
            let mode = if s(1).is_empty() { "sidecar".to_string() } else { s(1) };
            text(media::prepare(&s(0), &mode))
        }
        "media_task_status" => text(media::task_status(&s(0))),
        "safe_delete_replaced_media" => text(media::safe_delete(&s(0), &s(1))),
        "select_files" => {
            media::select_files();
            json!([])
        }
        "select_link_file" => {
            media::link_file(raw(0), raw(1), s(2));
            Value::Null
        }
        "select_link_folder" => {
            media::link_folder(raw(0), s(1));
            Value::Null
        }
        "toggle_native_fullscreen" => {
            crate::toggle_fullscreen();
            Value::Null
        }
        "open_external_url" | "start_magnet_link" => json!(open::that_detached(s(0)).is_ok()),
        "ai_assistant_chat" => Value::String(ai::assistant(&s(0), &s(1))),
        "get_ai_franchise_search_plan" => Value::String(ai::search_plan(&s(0), &s(1), &s(2))),
        "get_ai_franchise_info" => Value::String(chrono::franchise_info(&s(0), &s(1), &s(2))),
        // Not wired yet. These two are checked for truthiness, the rest are JSON.parse'd and show `message`.
        "open_internal_url" | "open_chromium_dub_browser" => json!(false),
        "download_torrent_to_watch" => Value::Null,
        m if METHODS.contains(&m) => text(json!({
            "status": "error",
            "message": "This feature is not wired into the new Rust backend yet.",
        })),
        m => return Err(format!("unknown method: {m}")),
    })
}
