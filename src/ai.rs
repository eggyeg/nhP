use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

/// Shared HTTP client. Non-2xx answers come back as responses so the API's own error text reaches the user.
pub static HTTP: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .into()
});

const SYSTEM: &str = "You are :3, the assistant built into Minimal Media Player Pro, a desktop player for anime, movies and shows. \
Working right now: Catalog search (anime from MyAnimeList, movies and shows from TMDB), the Library with episodes linked to local files, \
Watching progress and history, the player (subtitles, skip intro/outro, bookmarks, playback fixes for TS/MKV/DTS/HEVC files) and franchise watch order. \
Downloader, Merger, the DUB browser, Watch Together, TV mode and Chromecast are being rebuilt and do not work yet; say so plainly if asked. \
Help with what to watch next, watch orders, release info and how to use the player. Use app_context and web_context when given. \
Be concise and friendly, reply in the user's language, plain text without markdown. Return ONLY JSON: {\"answer\": \"...\"}";

fn keys_path() -> PathBuf {
    crate::app_root().join("keys.json")
}

pub fn ensure_keys_file() {
    let path = keys_path();
    if !path.exists() {
        let template = json!({
            "OPENAI_API_KEY": "", "OPENAI_BASE_URL": "https://api.openai.com/v1", "OPENAI_MODEL": "gpt-4o-mini",
            "TAVILY_API_KEY": "", "TMDB_API_KEY": "",
        });
        let _ = std::fs::write(path, serde_json::to_string_pretty(&template).unwrap());
    }
}

/// Environment first, then keys.json (re-read each time, so edits apply without a restart).
pub fn key(name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| {
            let v: Value = serde_json::from_str(&std::fs::read_to_string(keys_path()).ok()?).ok()?;
            v[name].as_str().map(str::to_owned)
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn key_or(name: &str, default: &str) -> String {
    Some(key(name)).filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_owned())
}

pub fn read_json(mut res: ureq::http::Response<ureq::Body>) -> Result<Value, String> {
    let status = res.status();
    let body: Value = res.body_mut().read_json().unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(body);
    }
    let msg = body["error"]["message"].as_str().or(body["detail"].as_str()).or(body["message"].as_str()).unwrap_or("");
    Err(format!("HTTP {} {msg}", status.as_u16()).trim().to_owned())
}

/// One JSON-mode chat completion against any OpenAI-compatible endpoint configured in keys.json.
fn chat_json(messages: Vec<Value>, temperature: f64) -> Result<Value, String> {
    let base = key_or("OPENAI_BASE_URL", "https://api.openai.com/v1");
    let body = json!({
        "model": key_or("OPENAI_MODEL", "gpt-4o-mini"),
        "messages": messages,
        "temperature": temperature,
        "response_format": { "type": "json_object" },
    });
    let res = HTTP
        .post(format!("{}/chat/completions", base.trim_end_matches('/')))
        .header("Authorization", format!("Bearer {}", key("OPENAI_API_KEY")))
        .send_json(body)
        .map_err(|e| e.to_string())?;
    let data = read_json(res)?;
    let text = data["choices"][0]["message"]["content"].as_str().ok_or("empty AI response")?;
    serde_json::from_str(text.trim()).map_err(|e| format!("AI returned invalid JSON: {e}"))
}

/// Optional web context. The Tavily key is often over quota (HTTP 432), so failures just mean no context.
fn tavily(query: &str, max_results: usize) -> String {
    let api_key = key("TAVILY_API_KEY");
    if api_key.is_empty() {
        return String::new();
    }
    let res = HTTP
        .post("https://api.tavily.com/search")
        .header("Authorization", format!("Bearer {api_key}"))
        .send_json(json!({ "api_key": api_key, "query": query, "search_depth": "basic", "include_answer": true, "max_results": max_results }));
    let data = match res.map_err(|e| e.to_string()).and_then(read_json) {
        Ok(d) => d,
        Err(e) => {
            crate::log(&format!("Tavily search failed: {e}"));
            return String::new();
        }
    };
    let mut parts: Vec<String> = data["answer"].as_str().map(|a| format!("Answer: {a}")).into_iter().collect();
    for r in data["results"].as_array().into_iter().flatten().take(max_results) {
        let field = |k: &str| r[k].as_str().unwrap_or("").to_owned();
        parts.push(format!("Title: {}\nURL: {}\nContent: {}", field("title"), field("url"), field("content")));
    }
    parts.join("\n\n").chars().take(8000).collect()
}

/// In-app chat. Same reply shape as the old app: {status, answer, actions}.
pub fn assistant(message: &str, context: &str) -> String {
    // ponytail: short in-memory history; it resets with the app, persist it if people want long chats.
    static HISTORY: Mutex<Vec<Value>> = Mutex::new(Vec::new());
    let reply = |answer: String| json!({ "status": "success", "answer": answer, "actions": [] }).to_string();
    let message = message.trim();
    if message.is_empty() {
        return reply("Ask me what to watch next, a franchise watch order, or how to use the player.".into());
    }
    if key("OPENAI_API_KEY").is_empty() {
        return reply(format!(
            "AI is off: put your OPENAI_API_KEY into {} and ask again. Any OpenAI-compatible provider works via OPENAI_BASE_URL and OPENAI_MODEL.",
            keys_path().display()
        ));
    }
    let lower = message.to_lowercase();
    let wants_web = ["recommend", "similar", "best", "release", "when", "news", "похож", "посовет", "атмосфер", "лучш", "когда", "выйдет", "как называется", "что за"]
        .iter()
        .any(|w| lower.contains(w));
    let web = if wants_web { tavily(&format!("{message} anime movie show"), 5) } else { String::new() };
    let app_context = serde_json::from_str::<Value>(context).unwrap_or(Value::Null);
    let user = json!({ "user_message": message, "app_context": app_context, "web_context": web }).to_string();

    let mut messages = vec![json!({ "role": "system", "content": SYSTEM })];
    messages.extend(HISTORY.lock().unwrap().iter().cloned());
    messages.push(json!({ "role": "user", "content": user }));
    match chat_json(messages, 0.4) {
        Ok(v) => {
            let answer = v["answer"].as_str().unwrap_or("Done.").to_owned();
            let mut history = HISTORY.lock().unwrap();
            history.push(json!({ "role": "user", "content": message }));
            history.push(json!({ "role": "assistant", "content": json!({ "answer": answer }).to_string() }));
            let excess = history.len().saturating_sub(12);
            history.drain(..excess);
            reply(answer)
        }
        Err(e) => {
            crate::log(&format!("Assistant request failed: {e}"));
            reply(format!("AI request failed: {e}"))
        }
    }
}

/// Decides whether catalog results should collapse into one franchise hub (UI ignores it below 0.55 confidence).
pub fn search_plan(query: &str, category: &str, candidates_json: &str) -> String {
    static CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);
    let query = query.trim();
    if query.is_empty() {
        return json!({ "status": "error", "should_collapse": false, "reason": "empty query" }).to_string();
    }
    if key("OPENAI_API_KEY").is_empty() {
        return json!({ "status": "no_keys", "should_collapse": false }).to_string();
    }
    let cache_key = format!("{category}|{}", query.to_lowercase());
    if let Some(hit) = CACHE.lock().unwrap().get(&cache_key) {
        return hit.clone();
    }
    let candidates: Vec<Value> = serde_json::from_str::<Vec<Value>>(candidates_json)
        .unwrap_or_default()
        .iter()
        .take(20)
        .enumerate()
        .map(|(i, c)| json!({
            "num": i + 1, "id": if c["mal_id"].is_null() { &c["id"] } else { &c["mal_id"] },
            "title": if c["title"].is_null() { &c["name"] } else { &c["title"] },
            "type": c["type"], "episodes": c["episodes"], "year": c["year"],
        }))
        .collect();
    let prompt = format!(
        "User query: \"{query}\"\nSearch category: \"{category}\"\n\nVisible search candidates:\n{}\n\n\
Decide if the UI should collapse these results into ONE franchise hub.\n\
Rules: collapse only when the query clearly targets a franchise/saga with several seasons, movies or spin-offs (Bleach, Fate, Spider-Man, Star Wars). \
Do not collapse a standalone title or unrelated titles that only share words. Pick the root candidate: the main series or first film. Keep labels short.\n\
Return only JSON: {{\"status\":\"success\",\"should_collapse\":true,\"confidence\":0.0,\"media_kind\":\"anime/movie/show\",\
\"hub_title\":\"...\",\"canonical_title\":\"...\",\"root_title\":\"...\",\"reason\":\"...\",\"standalone\":false}}",
        serde_json::to_string_pretty(&candidates).unwrap()
    );
    let system = "You are a media search architect deciding whether search results form one franchise. Be conservative. Output ONLY JSON.";
    let out = match chat_json(vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": prompt })], 0.05) {
        Ok(mut plan) => {
            plan["should_collapse"] = json!(plan["should_collapse"].as_bool().unwrap_or(false));
            if plan["status"].is_null() {
                plan["status"] = json!("success");
            }
            plan.to_string()
        }
        Err(e) => {
            crate::log(&format!("Franchise search plan failed: {e}"));
            return json!({ "status": "error", "should_collapse": false, "message": e }).to_string();
        }
    };
    CACHE.lock().unwrap().insert(cache_key, out.clone());
    out
}
