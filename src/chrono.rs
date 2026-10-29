//! Franchise watch order ("chronology"). The old app asked GPT to invent it, which produced wrong or empty lists.
//! Anime walks AniList's relation graph; movie hubs use TMDB collections, shows use TMDB seasons.

use crate::ai::{HTTP, key, read_json};
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_TTL_SECS: u64 = 7 * 24 * 3600;
/// Same public key the UI ships with; keys.json TMDB_API_KEY overrides it.
const TMDB_BUILTIN_KEY: &str = "3d1cb94d909aab088231f5af899dffdc";

pub fn franchise_info(title: &str, category: &str, id: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        return json!({ "status": "error", "message": "empty title" }).to_string();
    }
    let cache_key = format!("{category}|{id}|{}", title.to_lowercase());
    if let Some(hit) = cache(&cache_key, None) {
        return hit.to_string();
    }
    let result = match category {
        "movie" => tmdb_collection(title),
        "show" => tmdb_seasons(title),
        _ => crate::anime::franchise(id.parse().ok(), title),
    };
    match result {
        Ok(v) => {
            cache(&cache_key, Some(&v));
            v.to_string()
        }
        Err(e) => {
            crate::log(&format!("Chronology for {title} failed: {e}"));
            json!({ "status": "error", "message": e }).to_string()
        }
    }
}

/// Disk cache in the data folder: read when `put` is None, write otherwise.
fn cache(key: &str, put: Option<&Value>) -> Option<Value> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = crate::data_dir().join("chronology_cache.json");
    let mut all: Value = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    match put {
        None => {
            let hit = &all[key];
            (hit["ts"].as_u64().is_some_and(|ts| now.saturating_sub(ts) < CACHE_TTL_SECS)).then(|| hit["data"].clone())
        }
        Some(data) => {
            all[key] = json!({ "ts": now, "data": data });
            let _ = std::fs::write(&path, all.to_string());
            None
        }
    }
}

fn names(list: &Value) -> String {
    let all: Vec<&str> = list.as_array().into_iter().flatten().filter_map(|x| x["name"].as_str()).collect();
    all.join(", ")
}

fn year_of(date: &Value) -> u64 {
    date.as_str().and_then(|d| d.get(..4)).and_then(|y| y.parse().ok()).unwrap_or(0)
}

fn tmdb(path: &str, query: &[(&str, &str)]) -> Result<Value, String> {
    let api_key = Some(key("TMDB_API_KEY")).filter(|k| !k.is_empty()).unwrap_or_else(|| TMDB_BUILTIN_KEY.to_owned());
    let mut req = HTTP.get(format!("https://api.themoviedb.org/3{path}")).query("api_key", &api_key);
    for (k, v) in query {
        req = req.query(*k, *v);
    }
    read_json(req.call().map_err(|e| e.to_string())?)
}

/// "Spider-Man Franchise" -> "Spider-Man".
fn hub_query(title: &str) -> String {
    let mut q = title.trim().to_owned();
    for suffix in [" franchise", " collection", " saga", " watch order"] {
        if q.to_ascii_lowercase().ends_with(suffix) {
            q.truncate(q.len() - suffix.len());
        }
    }
    q.trim().to_owned()
}

fn tmdb_collection(title: &str) -> Result<Value, String> {
    let found = tmdb("/search/collection", &[("query", &hub_query(title))])?;
    let id = found["results"][0]["id"].as_u64().ok_or("no TMDB collection")?;
    let col = tmdb(&format!("/collection/{id}"), &[])?;
    let mut movies = col["parts"].as_array().cloned().unwrap_or_default();
    movies.retain(|m| m["release_date"].as_str().is_some_and(|d| !d.is_empty()));
    movies.sort_by_key(|m| m["release_date"].as_str().unwrap_or("").to_owned());
    let franchise: Vec<Value> = movies
        .iter()
        .enumerate()
        .map(|(i, m)| json!({
            "id": m["id"], "order": i + 1, "name": m["title"], "relation": "Movie", "type": "Movie",
            "year": year_of(&m["release_date"]), "episodes": 1, "confidence": 0.9,
        }))
        .collect();
    Ok(json!({ "status": "success", "confidence": 0.9, "media_kind": "movie", "synopsis": col["overview"], "franchise": franchise }))
}

fn tmdb_seasons(title: &str) -> Result<Value, String> {
    let found = tmdb("/search/tv", &[("query", &hub_query(title))])?;
    let id = found["results"][0]["id"].as_u64().ok_or("no TMDB show")?;
    let show = tmdb(&format!("/tv/{id}"), &[])?;
    let franchise: Vec<Value> = show["seasons"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["season_number"].as_u64().unwrap_or(0) > 0)
        .enumerate()
        .map(|(i, s)| json!({
            "id": s["id"], "order": i + 1, "name": s["name"], "relation": format!("Season {}", s["season_number"]),
            "type": "TV", "year": year_of(&s["air_date"]), "episodes": s["episode_count"].as_u64().unwrap_or(1).max(1), "confidence": 0.9,
        }))
        .collect();
    Ok(json!({
        "status": "success", "confidence": 0.9, "media_kind": "show", "synopsis": show["overview"],
        "studios_str": names(&show["networks"]), "genres_str": names(&show["genres"]),
        "airing_status": show["status"], "score": show["vote_average"],
        "franchise": if franchise.len() < 2 { vec![] } else { franchise },
    }))
}
