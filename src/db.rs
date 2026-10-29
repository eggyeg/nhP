use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const KEYS: [&str; 5] = ["library", "watching_progress", "viewing_history", "playlist", "playlist_index"];

// ponytail: one lock for every DB write. Saves are small; the old app raced two writers on one .tmp file.
static WRITE: Mutex<()> = Mutex::new(());

fn file(key: &str) -> Option<PathBuf> {
    let key: String = key.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    (!key.is_empty()).then(|| crate::data_dir().join(format!("db_{key}.json")))
}

fn bak(p: &Path) -> PathBuf {
    p.with_extension("json.bak")
}

fn read_valid(p: &Path) -> Option<String> {
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str::<Value>(&s).ok()?;
    Some(s)
}

/// The primary file wins even when it is empty, so a deleted library stays deleted.
/// `.bak` and the project `data/db` copy are only used when the primary is missing or corrupt.
pub fn load(key: &str) -> String {
    let Some(p) = file(key) else { return "{}".into() };
    let legacy = crate::app_root().join("data").join("db").join(p.file_name().unwrap());
    [p.clone(), bak(&p), legacy].iter().find_map(|c| read_valid(c)).unwrap_or_else(|| "{}".into())
}

pub fn load_all() -> String {
    let all: Map<String, Value> = KEYS.iter().map(|k| (k.to_string(), Value::String(load(k)))).collect();
    Value::Object(all).to_string()
}

pub fn save(key: &str, data: &str) -> bool {
    let Some(p) = file(key) else { return false };
    let _guard = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = p.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data.as_bytes())?;
        f.sync_all()?;
        drop(f);
        if p.exists() {
            let _ = std::fs::copy(&p, bak(&p));
        }
        // Antivirus or the indexer can hold the file for a moment; retry instead of dropping the save.
        let mut attempt = 0;
        loop {
            match std::fs::rename(&tmp, &p) {
                Ok(()) => return Ok(()),
                Err(_) if attempt < 5 => {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(80 * attempt));
                }
                Err(e) => return Err(e),
            }
        }
    })();
    if let Err(e) = &result {
        let _ = std::fs::remove_file(&tmp);
        crate::log(&format!("Failed to save database file {}: {e}", p.display()));
    }
    result.is_ok()
}
