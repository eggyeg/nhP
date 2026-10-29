use raw_window_handle::{
    DisplayHandle, HandleError, HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle,
    Win32WindowHandle, WindowHandle, WindowsDisplayHandle,
};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const MB: u64 = 1024 * 1024;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MEDIA_EXT: [&str; 10] = ["mp3", "wav", "ogg", "mp4", "webm", "mkv", "m4a", "aac", "flac", "ts"];
/// Primary audio codecs WebView2 can't play reliably; the fix is an AAC sidecar or copy.
const BAD_AUDIO: [&str; 10] = ["dts", "dca", "truehd", "mlp", "flac", "alac", "opus", "vorbis", "ac3", "eac3"];
const RISKY_VIDEO: [&str; 4] = ["hevc", "h265", "av1", "vp9"];

static TASKS: LazyLock<Mutex<HashMap<String, Value>>> = LazyLock::new(Default::default);

// ---------- paths & tools ----------

pub fn ext(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Paths arrive raw, percent-encoded or with `+` for spaces depending on the caller.
pub fn resolve(raw: &str) -> Option<PathBuf> {
    let s = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    if s.is_empty() {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned();
    [s.to_string(), decoded, s.replace('+', " ")].into_iter().map(PathBuf::from).find(|p| p.is_file())
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".mmp_write_test_{}.tmp", std::process::id()));
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// ASCII-only, writable temp folder (ffmpeg on some systems chokes on non-ASCII temp paths). Same as the old app.
fn temp_dir() -> &'static PathBuf {
    static DIR: LazyLock<PathBuf> = LazyLock::new(|| {
        [PathBuf::from(r"C:\Users\Public"), std::env::temp_dir()]
            .into_iter()
            .find(|d| d.to_str().is_some_and(|s| s.is_ascii()) && writable(d))
            .unwrap_or_else(std::env::temp_dir)
    });
    &DIR
}

/// Same md5-named cache files as the old app, so remuxes and sidecars it already made are reused.
fn hashed(dir: &Path, prefix: &str, source: &str, suffix: &str) -> PathBuf {
    dir.join(format!("{prefix}{:x}{suffix}", md5::compute(source.as_bytes())))
}

fn library_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    home.join("Videos").join("MinimalMediaPlayer")
}

fn tool(name: &str) -> Command {
    let local = crate::app_root().join(format!("{name}.exe"));
    let mut c = Command::new(if local.exists() { local } else { PathBuf::from(name) });
    c.creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null());
    c
}

fn wait_timeout(child: &mut Child, limit: Duration) -> bool {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn probe(path: &Path) -> Value {
    tool("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_streams", "-show_format"])
        .arg(path)
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or(Value::Null)
}

fn probe_duration(path: &Path) -> Option<f64> {
    probe(path)["format"]["duration"].as_str()?.parse().ok().filter(|d: &f64| *d > 0.0)
}

fn streams(path: &Path) -> Vec<Value> {
    probe(path)["streams"].as_array().cloned().unwrap_or_default()
}

/// TS -> MP4 stream copy. Writes a temp file first so a killed or timed-out run never leaves a half file that looks cached.
fn remux(src: &Path, target: &Path) -> bool {
    let tmp = target.with_extension("tmp.mp4");
    let ok = tool("ffmpeg")
        .args(["-y", "-loglevel", "error", "-i"])
        .arg(src)
        .args(["-c", "copy", "-map_metadata", "0"])
        .arg(&tmp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok_and(|mut c| wait_timeout(&mut c, Duration::from_secs(60)));
    let ok = ok && size(&tmp) > 1024 && std::fs::rename(&tmp, target).is_ok();
    let _ = std::fs::remove_file(&tmp);
    ok
}

// ---------- playback ----------

pub fn process_file(raw: &str, name: &str) -> Value {
    let unchanged = |path: String| json!({ "path": path, "name": name, "is_remuxed": false });
    let Some(path) = resolve(raw) else { return unchanged(raw.to_string()) };
    if ext(&path) != "ts" {
        return unchanged(lossy(&path));
    }
    let target = hashed(temp_dir(), "remux_", &lossy(&path), ".mp4");
    if size(&target) > MB || remux(&path, &target) {
        return json!({ "path": lossy(&target), "name": name_of(&target), "is_remuxed": true });
    }
    unchanged(lossy(&path))
}

pub fn duration(raw: &str) -> f64 {
    let Some(path) = resolve(raw) else { return 0.0 };
    if ext(&path) == "ts" {
        if let Some(d) = ts_duration(&path) {
            return d;
        }
    }
    // Last resort is the old app's estimate: ~1.6 Mbps.
    probe_duration(&path).unwrap_or(size(&path) as f64 / 200_000.0)
}

pub fn analyze(raw: &str) -> Value {
    match resolve(raw) {
        Some(p) => analyze_path(&p),
        None => json!({ "status": "error", "message": "file not found", "path": raw }),
    }
}

fn analyze_path(path: &Path) -> Value {
    let (mut audio, mut video) = (vec![], vec![]);
    for st in streams(path) {
        let codec = st["codec_name"].as_str().unwrap_or("").to_string();
        match st["codec_type"].as_str() {
            Some("audio") => audio.push(json!({
                "index": st["index"], "codec": codec, "channels": st["channels"],
                "language": st["tags"]["language"].as_str().unwrap_or("und"),
                "title": st["tags"]["title"].as_str().unwrap_or(""),
                "default": st["disposition"]["default"].as_i64().unwrap_or(0),
            })),
            Some("video") => video.push(json!({ "index": st["index"], "codec": codec, "width": st["width"], "height": st["height"] })),
            _ => {}
        }
    }
    let codec_of = |a: &Value| a["codec"].as_str().unwrap_or("").to_lowercase();
    // The browser plays the default (or first) audio track only; a second DTS track must not trigger a fix.
    let playback = audio.iter().find(|a| a["default"] == 1).or(audio.first()).cloned();
    let needs_audio = playback.as_ref().is_some_and(|a| BAD_AUDIO.contains(&codec_of(a).as_str()));
    let other_bad = !needs_audio && audio.iter().any(|a| BAD_AUDIO.contains(&codec_of(a).as_str()));
    let mut video_codecs: Vec<String> = video.iter().map(codec_of).filter(|c| !c.is_empty()).collect();
    video_codecs.dedup();
    let needs_video = video_codecs.iter().any(|c| RISKY_VIDEO.contains(&c.as_str()));
    let (mode, reason) = if needs_video {
        ("video_transcode", "Video codec/container may be unsupported by WebView")
    } else if needs_audio {
        ("audio_sidecar", "Primary/default audio is unsupported")
    } else {
        ("direct", "Primary/default playback audio appears browser-compatible")
    };
    json!({
        "status": "success", "path": lossy(path), "audio": audio, "video": video,
        "playback_audio": playback, "needs_audio_proxy": needs_audio, "needs_audio_sidecar": needs_audio,
        "has_non_primary_unsupported_audio": other_bad, "needs_video_transcode": needs_video,
        "video_codecs": video_codecs, "recommended_mode": mode, "reason": reason,
    })
}

fn has_av(path: &Path) -> bool {
    if size(path) <= MB {
        return false;
    }
    let s = streams(path);
    let kind = |k: &str| s.iter().any(|st| st["codec_type"] == k);
    kind("video") && kind("audio")
}

fn valid_sidecar(path: &Path) -> bool {
    size(path) > 128 * 1024
        && streams(path).iter().any(|st| st["codec_type"] == "audio" && matches!(st["codec_name"].as_str(), Some("aac" | "mp4a")))
}

fn video_proxy_path(src: &str) -> PathBuf {
    hashed(temp_dir(), "video_compat_", src, ".mp4")
}

fn full_proxy_path(src: &str) -> PathBuf {
    hashed(temp_dir(), "audio_proxy_", src, ".mkv")
}

/// Sidecar lives next to the movie when that folder is writable (a flash drive keeps its fix), else in temp.
fn sidecar_candidates(src: &Path) -> Vec<PathBuf> {
    let source = lossy(src);
    let mut out = vec![];
    if let Some(dir) = src.parent().filter(|d| writable(d)) {
        out.push(hashed(dir, "audio_sidecar_", &source, ".m4a"));
    }
    out.push(hashed(temp_dir(), "audio_sidecar_", &source, ".m4a"));
    out
}

fn existing_sidecar(src: &Path) -> Option<PathBuf> {
    sidecar_candidates(src).into_iter().find(|c| {
        if size(c) <= 128 * 1024 {
            return false;
        }
        let ok = valid_sidecar(c);
        if !ok {
            let _ = std::fs::remove_file(c); // half-written: rebuild cleanly
        }
        ok
    })
}

pub fn check_playback_fixes(raw: &str) -> Value {
    let Some(path) = resolve(raw) else { return json!({ "status": "error", "message": "file not found", "path": raw }) };
    let source = lossy(&path);
    let analysis = analyze_path(&path);
    let (video, full) = (video_proxy_path(&source), full_proxy_path(&source));
    let sidecar = existing_sidecar(&path);
    let ready = |p: Option<PathBuf>| match p {
        Some(p) => json!({ "ready": true, "path": lossy(&p) }),
        None => json!({ "ready": false, "path": "" }),
    };
    let bytes = size(&path);
    json!({
        "status": "success", "path": source, "size": bytes,
        "size_gb": (bytes as f64 / (1024f64.powi(3)) * 100.0).round() / 100.0,
        "needs_fix": analysis["needs_audio_sidecar"] == true || analysis["needs_video_transcode"] == true,
        "video_proxy": ready(has_av(&video).then_some(video)),
        "full_proxy": ready(has_av(&full).then_some(full)),
        "sidecar": ready(sidecar),
        "analysis": analysis,
    })
}

fn new_task(fields: Value) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = format!("task-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
    TASKS.lock().unwrap().insert(id.clone(), fields);
    id
}

fn update_task(id: &str, patch: Value) {
    if let (Some(Value::Object(task)), Value::Object(patch)) = (TASKS.lock().unwrap().get_mut(id), patch) {
        task.extend(patch);
    }
}

pub fn task_status(id: &str) -> Value {
    TASKS.lock().unwrap().get(id).cloned().unwrap_or_else(|| json!({ "status": "missing", "message": "task not found" }))
}

/// Runs ffmpeg with `-progress pipe:1` and maps its time to `base..base+span` percent of the task.
fn ffmpeg_with_progress(id: &str, mut c: Command, dur: Option<f64>, base: f64, span: f64, label: &str) -> bool {
    let Ok(mut child) = c.args(["-progress", "pipe:1", "-nostats"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else {
        return false;
    };
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let (Some(v), Some(d)) = (line.strip_prefix("out_time_ms="), dur) else { continue };
            if let Ok(us) = v.trim().parse::<f64>() {
                let pct = (base + us / 1e6 / d * span).clamp(base, 99.0) as u64;
                update_task(id, json!({ "progress": pct, "message": format!("{label}... {pct}%") }));
            }
        }
    }
    child.wait().is_ok_and(|s| s.success())
}

fn ffmpeg(src: &Path) -> Command {
    let mut c = tool("ffmpeg");
    c.args(["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i"]).arg(src);
    c
}

/// Full re-encode (video_proxy) or AAC-audio copy (full_proxy) into an md5-named cache file.
fn start_proxy_task(src: &Path, mode: &str, out: PathBuf, audio_map: String, analysis: Value) -> Value {
    if has_av(&out) {
        return json!({ "status": "ready", "mode": mode, "path": lossy(&out), "video_path": lossy(&out), "proxy": true, "cached": true, "analysis": analysis });
    }
    let label = if mode == "video_proxy" { "Creating H.264/AAC browser-compatible MP4" } else { "Creating full AAC-compatible copy" };
    let id = new_task(json!({ "status": "running", "mode": mode, "progress": 0, "path": lossy(&out), "source": lossy(src), "message": format!("{label}... 0%") }));
    let (src, mode_owned, task) = (src.to_path_buf(), mode.to_string(), id.clone());
    std::thread::spawn(move || {
        let tmp = out.with_extension(if mode_owned == "video_proxy" { "tmp.mp4" } else { "tmp.mkv" });
        let mut c = ffmpeg(&src);
        if mode_owned == "video_proxy" {
            c.args(["-map", "0:v:0", "-map", &audio_map, "-vf", "scale=w=min(1920\\,iw):h=-2"])
                .args(["-c:v", "libx264", "-preset", "fast", "-crf", "21", "-pix_fmt", "yuv420p"])
                .args(["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-movflags", "+faststart", "-map_metadata", "-1"]);
        } else {
            c.args(["-map", "0:v:0", "-map", &audio_map, "-map", "0:s?", "-dn", "-c:v", "copy", "-c:s", "copy"])
                .args(["-c:a", "aac", "-b:a", "384k", "-ac", "2", "-map_metadata", "0"]);
        }
        c.arg(&tmp);
        let ok = ffmpeg_with_progress(&task, c, probe_duration(&src), 0.0, 99.0, label)
            && size(&tmp) > MB
            && std::fs::rename(&tmp, &out).is_ok();
        let _ = std::fs::remove_file(&tmp);
        update_task(&task, if ok {
            json!({ "status": "ready", "progress": 100, "path": lossy(&out), "message": label.replace("Creating", "Ready:") })
        } else {
            json!({ "status": "error", "progress": 0, "message": "ffmpeg failed. Is FFmpeg installed (PATH or next to the app)?" })
        });
    });
    json!({ "status": "processing", "task_id": id, "mode": mode, "analysis": analysis })
}

fn free_space(dir: &Path) -> u64 {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
    let mut free = 0u64;
    unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut());
    }
    free
}

/// Movies on a slow external drive are copied to the local disk first (when there is room), then decoded from there.
fn stage_locally(id: &str, src: &Path, hash_src: &str) -> Option<PathBuf> {
    let bytes = size(src);
    let drive = |p: &Path| p.to_string_lossy().get(..2).map(|d| d.to_ascii_lowercase());
    // Keep a 2 GiB cushion so staging never fills the system disk.
    if bytes < 2 * 1024 * MB || drive(src) == drive(temp_dir()) || free_space(temp_dir()) < bytes + 2 * 1024 * MB {
        return None;
    }
    let staged = hashed(temp_dir(), "audio_stage_", hash_src, &format!(".{}", ext(src)));
    if size(&staged) == bytes {
        return Some(staged);
    }
    let part = staged.with_extension("part");
    let copy = || -> std::io::Result<()> {
        let (mut from, mut to) = (File::open(src)?, File::create(&part)?);
        let mut buf = vec![0u8; 16 * MB as usize];
        let mut done = 0u64;
        loop {
            let n = from.read(&mut buf)?;
            if n == 0 {
                break;
            }
            to.write_all(&buf[..n])?;
            done += n as u64;
            let pct = done * 100 / bytes;
            update_task(id, json!({ "progress": pct / 5, "message": format!("Copying movie to local SSD first... {pct}%") }));
        }
        drop(to);
        std::fs::rename(&part, &staged)
    };
    match copy() {
        Ok(()) => Some(staged),
        Err(e) => {
            // Not enough space or a read error: decode straight from the source instead.
            let _ = std::fs::remove_file(&part);
            crate::log(&format!("SSD staging failed for {}: {e}", src.display()));
            None
        }
    }
}

fn start_sidecar_task(src: &Path, audio_map: String, analysis: Value) -> Value {
    let source = lossy(src);
    let sidecar = sidecar_candidates(src).remove(0);
    let running = TASKS.lock().unwrap().iter().find_map(|(id, t)| {
        (t["source"] == source.as_str() && t["mode"] == "audio_sidecar" && t["status"] == "running").then(|| id.clone())
    });
    if let Some(id) = running {
        return json!({ "status": "processing", "task_id": id, "mode": "audio_sidecar", "analysis": analysis });
    }
    let id = new_task(json!({
        "status": "running", "mode": "audio_sidecar", "progress": 0, "path": source, "video_path": source,
        "sidecar_path": lossy(&sidecar), "source": source, "message": "Creating AAC audio sidecar... 0%",
    }));
    let (src, task) = (src.to_path_buf(), id.clone());
    std::thread::spawn(move || {
        let tmp = hashed(temp_dir(), "audio_sidecar_", &source, &format!(".{task}.tmp.m4a"));
        let staged = stage_locally(&task, &src, &source);
        let input = staged.clone().unwrap_or_else(|| src.clone());
        let base = if staged.is_some() { 20.0 } else { 0.0 };
        let mut c = ffmpeg(&input);
        c.args(["-map", &audio_map, "-vn", "-sn", "-dn", "-c:a", "aac", "-b:a", "384k", "-ac", "2"])
            .args(["-map_metadata", "-1", "-movflags", "+faststart"])
            .arg(&tmp);
        let ok = ffmpeg_with_progress(&task, c, probe_duration(&input), base, 99.0 - base, "Creating AAC audio sidecar")
            && valid_sidecar(&tmp)
            && (std::fs::rename(&tmp, &sidecar).is_ok() || std::fs::copy(&tmp, &sidecar).is_ok());
        for leftover in [Some(tmp), staged].into_iter().flatten() {
            let _ = std::fs::remove_file(leftover);
        }
        update_task(&task, if ok {
            json!({ "status": "ready", "progress": 100, "path": source, "video_path": source, "sidecar_path": lossy(&sidecar), "message": "AAC audio sidecar ready" })
        } else {
            json!({ "status": "error", "progress": 0, "message": "ffmpeg failed. Try another release with AAC/EAC3 audio or install FFmpeg." })
        });
    });
    json!({ "status": "processing", "task_id": id, "mode": "audio_sidecar", "analysis": analysis })
}

pub fn prepare(raw: &str, mode: &str) -> Value {
    let Some(path) = resolve(raw) else { return json!({ "status": "error", "message": "file not found", "path": raw }) };
    let source = lossy(&path);
    let analysis = analyze_path(&path);
    let needs_audio = analysis["needs_audio_sidecar"] == true;
    let needs_video = analysis["needs_video_transcode"] == true;
    let audio_map = analysis["playback_audio"]["index"].as_i64().map_or("0:a:0".to_string(), |i| format!("0:{i}"));
    let as_is = |mode: &str| {
        json!({ "status": "ready", "mode": mode, "path": source, "video_path": source, "proxy": false, "sidecar": false, "analysis": analysis })
    };
    match mode.to_lowercase().trim() {
        _ if !needs_audio && !needs_video => as_is("direct"),
        "original" | "skip" | "none" => as_is("original"),
        // The old app returned "direct" here whenever audio was fine, so HEVC/AV1 files never got transcoded.
        "video" | "video_transcode" | "browser" | "mp4" => {
            start_proxy_task(&path, "video_proxy", video_proxy_path(&source), audio_map, analysis)
        }
        _ if !needs_audio => as_is("direct"),
        "full" | "full_proxy" | "copy" => start_proxy_task(&path, "full_proxy", full_proxy_path(&source), audio_map, analysis),
        _ => match existing_sidecar(&path) {
            Some(sc) => json!({
                "status": "ready", "mode": "audio_sidecar", "path": source, "video_path": source,
                "sidecar_path": lossy(&sc), "sidecar": true, "cached": true, "analysis": analysis,
            }),
            None => start_sidecar_task(&path, audio_map, analysis),
        },
    }
}

/// Deletes an old file after a compatible copy replaced it, but only files this app generated.
pub fn safe_delete(old: &str, new: &str) -> Value {
    let Some(old) = resolve(old) else { return json!({ "status": "skipped", "reason": "old file missing" }) };
    if resolve(new).is_some_and(|n| n == old) {
        return json!({ "status": "skipped", "reason": "same file" });
    }
    let name = name_of(&old).to_lowercase();
    let generated = ["audio_proxy_", "audio_sidecar_", "remux_"].iter().any(|p| name.starts_with(p));
    let managed = [library_dir(), crate::app_root().join("output"), temp_dir().clone()].iter().any(|root| old.starts_with(root));
    if !(generated || managed) {
        return json!({ "status": "skipped", "reason": "old file is not app-managed; not deleting user original", "path": lossy(&old) });
    }
    match std::fs::remove_file(&old) {
        Ok(()) => json!({ "status": "success", "deleted": lossy(&old) }),
        Err(e) => json!({ "status": "error", "message": e.to_string() }),
    }
}

// ---------- TS duration (pure parser, no ffmpeg) ----------

fn pes_pts(c: &[u8], i: usize) -> Option<u64> {
    if i + 14 > c.len() || [0xBC, 0xBF, 0xF0, 0xF1, 0xFF, 0xF2, 0xF8].contains(&c[i + 3]) || (c[i + 7] & 0xC0) >> 6 < 2 {
        return None;
    }
    let b: Vec<u64> = c[i + 9..i + 14].iter().map(|&x| x as u64).collect();
    if !matches!(b[0] & 0xF1, 0x21 | 0x31) || b[2] & 1 == 0 || b[4] & 1 == 0 {
        return None;
    }
    Some(((b[0] & 0x0E) << 29) | (b[1] << 22) | ((b[2] & 0xFE) << 14) | (b[3] << 7) | ((b[4] & 0xFE) >> 1))
}

fn all_pts(c: &[u8]) -> impl Iterator<Item = u64> + '_ {
    c.windows(3).enumerate().filter(|(_, w)| *w == [0, 0, 1]).filter_map(|(i, _)| pes_pts(c, i))
}

fn packet_size(c: &[u8]) -> usize {
    let c = &c[..c.len().min(10_000)];
    let Some(pos) = c.iter().position(|&b| b == 0x47) else { return 188 };
    [188, 192, 204].into_iter().find(|&s| pos + s * 4 < c.len() && (1..4).all(|k| c[pos + s * k] == 0x47)).unwrap_or(188)
}

fn all_pcr(c: &[u8], ps: usize) -> impl Iterator<Item = u64> + '_ {
    let sync = c.iter().take(65_536).position(|&b| b == 0x47).unwrap_or(c.len());
    let start = if ps == 192 { sync.saturating_sub(4) } else { sync };
    c[start..].chunks_exact(ps).filter_map(move |p| {
        let t = if ps == 192 { &p[4..] } else { &p[..188] };
        let adaptation = (t[3] & 0x30) >> 4;
        if t[0] != 0x47 || adaptation < 2 || t[4] < 5 || t[5] & 0x10 == 0 {
            return None;
        }
        let v = |i: usize| t[i] as u64;
        Some(((v(6) << 25) | (v(7) << 17) | (v(8) << 9) | (v(9) << 1) | (v(10) >> 7)) & 0x1_FFFF_FFFF)
    })
}

/// Duration from first/last PTS (or PCR) in the first and last 5 MB. Instant even on huge TS dumps.
fn ts_duration(path: &Path) -> Option<f64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut head = vec![];
    (&mut f).take(5 * MB).read_to_end(&mut head).ok()?;
    let mut tail = vec![];
    f.seek(SeekFrom::Start(len.saturating_sub(5 * MB))).ok()?;
    f.read_to_end(&mut tail).ok()?;
    let span = |a: u64, b: u64| {
        let d = (b.wrapping_sub(a) & 0x1_FFFF_FFFF) as f64 / 90_000.0;
        (d > 0.0 && d < 86_400.0).then_some(d)
    };
    if let (Some(a), Some(b)) = (all_pts(&head).next(), all_pts(&tail).last()) {
        if let Some(d) = span(a, b) {
            return Some(d);
        }
    }
    let ps = packet_size(&head);
    span(all_pcr(&head, ps).next()?, all_pcr(&tail, ps).last()?)
}

// ---------- dialogs & linking ----------

/// Lets rfd parent its dialog to the app window from a worker thread (same as Tauri does on Windows).
struct Parent(isize);

impl HasWindowHandle for Parent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = std::num::NonZeroIsize::new(self.0).ok_or(HandleError::Unavailable)?;
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd))) })
    }
}

impl HasDisplayHandle for Parent {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        Ok(unsafe { DisplayHandle::borrow_raw(RawDisplayHandle::Windows(WindowsDisplayHandle::new())) })
    }
}

fn dialog() -> rfd::FileDialog {
    let d = rfd::FileDialog::new()
        .add_filter("Media Files", &MEDIA_EXT)
        .add_filter("Video Files", &["mp4", "webm", "mkv", "ts"])
        .add_filter("All Files", &["*"]);
    match crate::hwnd() {
        Some(h) => d.set_parent(&Parent(h)),
        None => d,
    }
}

pub fn select_files() {
    std::thread::spawn(|| {
        let Some(files) = dialog().pick_files() else { return };
        let list: Vec<Value> = files.iter().map(|p| json!({ "path": lossy(p), "name": name_of(p) })).collect();
        crate::eval_js(format!("addFilesToPlaylist({});", Value::Array(list)));
    });
}

fn title_dir(title: &str) -> PathBuf {
    let clean: String = title.chars().filter(|c| !r#"\/*?:"<>|"#.contains(*c)).collect();
    let clean = clean.trim();
    let dir = library_dir().join(if clean.is_empty() { "Unknown" } else { clean });
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Small files are copied into the library as `Episode_N`, TS is remuxed to MP4, big files (>512 MB) are linked in place.
fn link_one(src: &Path, ep: u64, dir: &Path) -> Value {
    let (bytes, kind) = (size(src), ext(src));
    let direct = json!({ "path": lossy(src), "name": name_of(src), "episode": ep, "is_remuxed": false, "linked_directly": true, "size": bytes });
    let target = dir.join(format!("Episode_{ep}.{}", if kind == "ts" { "mp4" } else { &kind }));
    let done = if kind == "ts" { remux(src, &target) } else { bytes <= 512 * MB && std::fs::copy(src, &target).is_ok() };
    if !done {
        return direct;
    }
    json!({ "path": lossy(&target), "name": name_of(&target), "episode": ep, "is_remuxed": kind == "ts", "linked_directly": false, "size": bytes })
}

pub fn link_file(mal_id: Value, ep: Value, title: String) {
    std::thread::spawn(move || {
        let Some(src) = dialog().pick_file() else {
            return crate::eval_js("if(window.cancelEpisodeLinking) window.cancelEpisodeLinking(); else if(window.hideTaskOverlay) window.hideTaskOverlay(0);".into());
        };
        crate::eval_js("if(window.showTaskOverlay) window.showTaskOverlay('Linking selected media...', 'Preparing the selected file. Large files are linked directly.');".into());
        let num = ep.as_u64().or_else(|| ep.as_str()?.trim().parse().ok()).unwrap_or(1);
        let file = link_one(&src, num, &title_dir(&title));
        crate::eval_js(format!("completeEpisodeLinking({mal_id}, {ep}, {file});"));
    });
}

pub fn link_folder(mal_id: Value, title: String) {
    std::thread::spawn(move || {
        let Some(mut files) = dialog().pick_files() else {
            return crate::eval_js("if(window.hideTaskOverlay) window.hideTaskOverlay(0);".into());
        };
        files.sort();
        crate::eval_js(format!(
            "if(window.showTaskOverlay) window.showTaskOverlay('Linking {} files...', 'Small files are copied, TS is remuxed, large files are linked in place.');",
            files.len()
        ));
        let dir = title_dir(&title);
        let list: Vec<Value> = files
            .iter()
            .enumerate()
            .map(|(i, f)| link_one(f, parse_episode(&name_of(f)).unwrap_or(i as u64 + 1), &dir))
            .collect();
        crate::eval_js(format!(
            "if(window.hideTaskOverlay) window.hideTaskOverlay(0); completeMultipleEpisodesLinking({mal_id}, {});",
            Value::Array(list)
        ));
    });
}

/// Episode number from a release file name; skips resolutions, years, codecs and CRCs.
pub fn parse_episode(file_name: &str) -> Option<u64> {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r"(?i)s\d{1,2}[ ._-]?e(\d{1,4})",                             // S01E07
            r"(?i)(?:\b|_)(?:episode|ep|серия|серии|эпизод)[ ._#-]*(\d{1,4})", // Episode 7, ep07, серия 7
            r"(?i)(\d{1,4})[ ._-]*(?:серия|эпизод)",                       // 7 серия
            r" - (\d{1,4})(?:v\d)?\b",                                     // [Group] Title - 07v2 [1080p]
            r"\[(\d{1,4})\]",                                              // Title [07]
            r"(?i)\bE(\d{2,4})\b",                                         // Title.E07
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
    });
    static NOISE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)\b\d{3,4}[pi]\b|\b[xh]\.?26[45]\b|\b(?:19|20)\d{2}\b|\[[0-9a-f]{8}\]|\b\d{1,2}bit\b|\b(?:aac|ac3|dts|ddp?|flac)\d(?:\.\d)?\b|\b\d\.\d\b").unwrap()
    });
    static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d{1,4}").unwrap());
    let stem = file_name.rsplit_once('.').map_or(file_name, |(s, _)| s);
    PATTERNS
        .iter()
        .find_map(|re| re.captures(stem))
        .and_then(|c| c[1].parse().ok())
        .or_else(|| NUMBER.find(&NOISE.replace_all(stem, " ")).and_then(|m| m.as_str().parse().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_numbers() {
        let cases = [
            ("[SubsPlease] Kill Blue - 07 (1080p) [A1B2C3D4].mkv", Some(7)),
            ("Bleach.S01E07.1080p.WEB-DL.x264.mkv", Some(7)),
            ("Bleach 2004 - 012.mkv", Some(12)),
            ("Episode_7.mp4", Some(7)),
            ("Убивая юность 7 серия.mp4", Some(7)),
            ("Kill.Blue.07.1080p.mkv", Some(7)),
            ("[Group] Title [05][1080p].mkv", Some(5)),
            ("Title - 07v2 [1080p].mkv", Some(7)),
            ("Show.E12.720p.HEVC.mkv", Some(12)),
            ("Movie 2019 1080p.mkv", None),
        ];
        for (name, want) in cases {
            assert_eq!(parse_episode(name), want, "{name}");
        }
    }

    #[test]
    fn ts_pts_span() {
        // Two PES headers with PTS 90000 (1 s) and 90000 * 61 (61 s): 60 s apart.
        fn pes(pts: u64) -> Vec<u8> {
            vec![
                0, 0, 1, 0xE0, 0, 0, 0x80, 0x80, 5,
                0x21 | ((pts >> 29) & 0x0E) as u8, (pts >> 22) as u8, ((pts >> 14) & 0xFE) as u8 | 1, (pts >> 7) as u8, ((pts << 1) & 0xFE) as u8 | 1,
            ]
        }
        let (a, b) = (pes(90_000), pes(90_000 * 61));
        assert_eq!(all_pts(&a).next(), Some(90_000));
        assert_eq!(all_pts(&b).last(), Some(90_000 * 61));
    }
}
