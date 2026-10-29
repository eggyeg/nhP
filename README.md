# Minimal Media Player Pro

Desktop player for anime, movies and shows. The UI in `templates/` is the original design; the backend is Rust
(WebView2 window via `wry`/`tao`, local HTTP API via `axum` on `127.0.0.1:8765`).

## Run

```bash
cargo run --release
```

The exe finds `templates/` and `keys.json` next to itself or up to three folders above (so `target/release` works).
FFmpeg/ffprobe on PATH (or `ffmpeg.exe`/`ffprobe.exe` next to the app) enables TS remux, playback fixes and durations.
Data (library, progress, history, playlist, WebView profile) lives in `%APPDATA%\MinimalMediaPlayerPro`, same as before.

## keys.json

Created on first launch, never committed.

| Key | Use |
|---|---|
| `OPENAI_API_KEY` | :3 assistant and catalog franchise detection |
| `OPENAI_BASE_URL`, `OPENAI_MODEL` | any OpenAI-compatible provider (default `https://api.openai.com/v1`, `gpt-4o-mini`) |
| `TAVILY_API_KEY` | optional web context for the assistant |
| `TMDB_API_KEY` | optional, overrides the built-in TMDB key |

## Layout

| File | What |
|---|---|
| `src/main.rs` | window, WebView, event loop |
| `src/server.rs` | HTTP routes, `window.pywebview.api` shim the old UI talks to, RPC dispatch |
| `src/db.rs` | JSON databases (atomic writes, `.bak`) |
| `src/media.rs` | file dialogs, linking, TS remux and duration, playback fixes (AAC sidecar, AAC copy, H.264 transcode) |
| `src/anime.rs` | anime data from AniList in Jikan's JSON shape (api.jikan.moe is unreachable here) |
| `src/chrono.rs` | franchise watch order: AniList relations for anime, TMDB collections/seasons otherwise |
| `src/ai.rs` | :3 assistant, franchise search plan |

## Not wired yet

Downloader (Nyaa/Prowlarr/torrents), Merger and the DUB browser, Watch Together, TV mode, live stream, Chromecast.
Their buttons answer "not wired into the new Rust backend yet".
