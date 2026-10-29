//! Anime data from AniList, served in Jikan's JSON shape.
//! api.jikan.moe is unreachable on this network (connect timeout), and the old UI was written against Jikan,
//! so the shim reroutes its `api.jikan.moe/v4/...` fetches to `/jikan/v4/...` here.

use crate::ai::{HTTP, read_json};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const MEDIA: &str = "id idMal title{romaji english native} synonyms format episodes duration status source averageScore popularity \
season seasonYear startDate{year month day} endDate{year month day} description(asHtml:false) coverImage{medium large extraLarge} \
genres studios(isMain:true){nodes{name}} rankings{rank type allTime} trailer{id site}";
const NODE: &str = "id idMal type format title{romaji} episodes startDate{year month day}";
/// Relations that belong to one watch order. Alternatives, spin-offs, adaptations and "other" are left out.
const FOLLOW: [&str; 5] = ["PREQUEL", "SEQUEL", "SIDE_STORY", "PARENT", "SUMMARY"];
const MAX_PARTS: usize = 40;

/// AniList allows 30 requests/min: calls are spaced 700 ms apart and 429s wait for Retry-After.
fn anilist(query: &str, variables: Value) -> Result<Value, String> {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    for _ in 0..3 {
        {
            let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(t) = *last {
                std::thread::sleep(Duration::from_millis(700).saturating_sub(t.elapsed()));
            }
            *last = Some(Instant::now());
        }
        let res = HTTP
            .post("https://graphql.anilist.co")
            .header("Accept", "application/json")
            .send_json(json!({ "query": query, "variables": variables }))
            .map_err(|e| e.to_string())?;
        if res.status().as_u16() == 429 {
            let wait = res.headers().get("retry-after").and_then(|v| v.to_str().ok()?.parse().ok()).unwrap_or(5u64);
            std::thread::sleep(Duration::from_secs(wait.min(15)));
            continue;
        }
        let body = read_json(res)?;
        if let Some(msg) = body["errors"][0]["message"].as_str() {
            return Err(format!("AniList: {msg}"));
        }
        return Ok(body["data"].clone());
    }
    Err("AniList is rate limiting; try again in a minute".into())
}

fn titled(s: &str) -> String {
    let lower = s.replace('_', " ").to_lowercase();
    let mut c = lower.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

fn jikan_type(format: &Value) -> String {
    match format.as_str().unwrap_or("") {
        "TV" | "TV_SHORT" => "TV".into(),
        "MOVIE" => "Movie".into(),
        "OVA" | "ONA" => format.as_str().unwrap().into(),
        other => titled(other),
    }
}

fn jikan_relation(r: &str) -> String {
    match r {
        "PARENT" => "Parent story".into(),
        "SPIN_OFF" => "Spin-off".into(),
        "ALTERNATIVE" => "Alternative version".into(),
        "CONTAINS" => "Full story".into(),
        other => titled(other),
    }
}

fn date(d: &Value) -> Value {
    match (d["year"].as_u64(), d["month"].as_u64(), d["day"].as_u64()) {
        (Some(y), m, day) => json!(format!("{y:04}-{:02}-{:02}T00:00:00+00:00", m.unwrap_or(1), day.unwrap_or(1))),
        _ => Value::Null,
    }
}

fn sort_key(d: &Value) -> (u64, u64, u64) {
    (d["year"].as_u64().unwrap_or(9999), d["month"].as_u64().unwrap_or(12), d["day"].as_u64().unwrap_or(31))
}

fn plain_text(html: &str) -> String {
    static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    let text = html.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n");
    let text = TAG.replace_all(&text, "");
    let text = text.replace("&amp;", "&").replace("&quot;", "\"").replace("&#039;", "'").replace("&lt;", "<").replace("&gt;", ">");
    text.lines().map(str::trim).collect::<Vec<_>>().join("\n").replace("\n\n\n", "\n\n").trim().to_owned()
}

fn names(nodes: &Value) -> Vec<Value> {
    nodes.as_array().into_iter().flatten().filter_map(|n| n["name"].as_str().or(n.as_str())).map(|n| json!({ "mal_id": 0, "name": n })).collect()
}

/// One AniList media object -> the fields of a Jikan anime object the UI reads.
fn to_jikan(m: &Value) -> Value {
    let id = m["idMal"].as_u64().unwrap_or(0);
    let title = m["title"]["romaji"].as_str().or(m["title"]["english"].as_str()).unwrap_or("");
    let mut titles = vec![json!({ "type": "Default", "title": title })];
    for (kind, key) in [("English", "english"), ("Japanese", "native")] {
        if let Some(t) = m["title"][key].as_str() {
            titles.push(json!({ "type": kind, "title": t }));
        }
    }
    titles.extend(m["synonyms"].as_array().into_iter().flatten().map(|s| json!({ "type": "Synonym", "title": s })));
    let cover = &m["coverImage"];
    let jpg = json!({ "image_url": cover["large"], "small_image_url": cover["medium"], "large_image_url": cover["extraLarge"] });
    let rank = m["rankings"].as_array().into_iter().flatten().find(|r| r["type"] == "RATED" && r["allTime"] == true).map(|r| r["rank"].clone());
    let status = match m["status"].as_str().unwrap_or("") {
        "FINISHED" => "Finished Airing",
        "RELEASING" => "Currently Airing",
        "NOT_YET_RELEASED" => "Not yet aired",
        "HIATUS" => "On Hiatus",
        "CANCELLED" => "Cancelled",
        _ => "Unknown",
    };
    let trailer = (m["trailer"]["site"] == "youtube").then(|| {
        let yt = m["trailer"]["id"].as_str().unwrap_or("");
        json!({ "youtube_id": yt, "url": format!("https://www.youtube.com/watch?v={yt}"), "embed_url": format!("https://www.youtube.com/embed/{yt}") })
    });
    json!({
        "mal_id": id, "url": format!("https://myanimelist.net/anime/{id}"),
        "images": { "jpg": jpg, "webp": jpg },
        "trailer": trailer,
        "title": title, "title_english": m["title"]["english"], "title_japanese": m["title"]["native"], "titles": titles,
        "type": jikan_type(&m["format"]), "source": m["source"].as_str().map(titled),
        "episodes": m["episodes"], "status": status, "airing": m["status"] == "RELEASING",
        "aired": { "from": date(&m["startDate"]), "to": date(&m["endDate"]) },
        "duration": m["duration"].as_u64().map(|d| format!("{d} min per ep")),
        "rating": Value::Null,
        "score": m["averageScore"].as_f64().map(|s| s / 10.0), "rank": rank, "popularity": m["popularity"],
        "synopsis": m["description"].as_str().map(plain_text),
        "season": m["season"].as_str().map(str::to_lowercase), "year": m["seasonYear"].as_u64().or(m["startDate"]["year"].as_u64()),
        "studios": names(&m["studios"]["nodes"]), "genres": names(&m["genres"]),
    })
}

fn by_mal_id(id: u64, extra: &str) -> Result<Value, String> {
    let q = format!("query($id:Int){{Media(idMal:$id,type:ANIME){{{MEDIA} {extra}}}}}");
    let m = anilist(&q, json!({ "id": id }))?["Media"].clone();
    if m.is_null() { Err("not found".into()) } else { Ok(m) }
}

fn page(sort: &str, search: Option<&str>, limit: u64) -> Result<Value, String> {
    let q = format!("query($n:Int,$q:String,$s:[MediaSort]){{Page(perPage:$n){{media(search:$q,type:ANIME,sort:$s,isAdult:false){{{MEDIA}}}}}}}");
    let list = anilist(&q, json!({ "n": limit.clamp(1, 50), "q": search, "s": [sort] }))?;
    let data: Vec<Value> = list["Page"]["media"].as_array().into_iter().flatten().map(to_jikan).collect();
    Ok(json!({ "data": data, "pagination": { "last_visible_page": 1, "has_next_page": false } }))
}

/// `/jikan/v4/...` -> (HTTP status, Jikan-shaped body) for the endpoints the UI uses.
pub fn jikan_compat(path: &str, q: &HashMap<String, String>) -> (u16, Value) {
    let limit = q.get("limit").and_then(|l| l.parse().ok()).unwrap_or(25);
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let result = match parts.as_slice() {
        ["v4", "anime"] => page("SEARCH_MATCH", q.get("q").map(String::as_str).filter(|s| !s.is_empty()), limit),
        ["v4", "top", "anime"] => page("SCORE_DESC", None, limit),
        ["v4", "anime", id, rest @ ..] => match (id.parse::<u64>(), rest) {
            (Ok(id), [] | ["full"]) => by_mal_id(id, "").map(|m| json!({ "data": to_jikan(&m) })),
            (Ok(id), ["relations"]) => relations(id),
            (Ok(id), ["episodes"]) => episodes(id),
            _ => Err("not supported".into()),
        },
        _ => Err("not supported".into()),
    };
    match result {
        Ok(v) => (200, v),
        Err(e) if e == "not found" || e == "not supported" => (404, json!({ "status": 404, "message": e })),
        Err(e) => {
            crate::log(&format!("Anime data request {path} failed: {e}"));
            (502, json!({ "status": 502, "message": e }))
        }
    }
}

fn relations(id: u64) -> Result<Value, String> {
    let m = by_mal_id(id, &format!("relations{{edges{{relationType node{{{NODE}}}}}}}"))?;
    let mut grouped: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for e in m["relations"]["edges"].as_array().into_iter().flatten() {
        let n = &e["node"];
        grouped.entry(jikan_relation(e["relationType"].as_str().unwrap_or("OTHER"))).or_default().push(json!({
            "mal_id": n["idMal"], "type": n["type"].as_str().unwrap_or("").to_lowercase(), "name": n["title"]["romaji"],
            "url": format!("https://myanimelist.net/anime/{}", n["idMal"]),
        }));
    }
    let data: Vec<Value> = grouped.into_iter().map(|(relation, entry)| json!({ "relation": relation, "entry": entry })).collect();
    Ok(json!({ "data": data }))
}

/// Episode titles come from AniList's streaming list, air dates from its airing schedule.
fn episodes(id: u64) -> Result<Value, String> {
    static NUMBERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^episode\s+(\d+)\s*[-:–]\s*(.+)$").unwrap());
    let m = by_mal_id(id, "streamingEpisodes{title} airingSchedule(perPage:500){nodes{episode airingAt}}")?;
    let mut titles = HashMap::new();
    for e in m["streamingEpisodes"].as_array().into_iter().flatten() {
        if let Some(c) = e["title"].as_str().and_then(|t| NUMBERED.captures(t)) {
            titles.insert(c[1].parse::<u64>().unwrap_or(0), c[2].trim().to_owned());
        }
    }
    let mut aired = HashMap::new();
    for n in m["airingSchedule"]["nodes"].as_array().into_iter().flatten() {
        if let (Some(ep), Some(at)) = (n["episode"].as_u64(), n["airingAt"].as_i64()) {
            aired.insert(ep, at);
        }
    }
    let count = m["episodes"].as_u64().or(aired.keys().max().copied()).unwrap_or(titles.len() as u64);
    let data: Vec<Value> = (1..=count)
        .map(|n| json!({
            "mal_id": n, "title": titles.get(&n), "title_japanese": Value::Null,
            // JS `new Date(...)` accepts epoch milliseconds.
            "aired": aired.get(&n).map(|s| s * 1000), "filler": false, "recap": false,
        }))
        .collect();
    Ok(json!({ "data": data, "pagination": { "last_visible_page": 1, "has_next_page": false } }))
}

/// Watch order from AniList's relation graph, in release order. Same shape the old GPT compiler returned.
pub fn franchise(mal_id: Option<u64>, title: &str) -> Result<Value, String> {
    let two_levels = "relations{edges{relationType node{NODE relations{edges{relationType node{NODE}}}}}}".replace("NODE", NODE);
    let root_q = format!("query($mal:Int,$q:String){{Media(idMal:$mal,search:$q,type:ANIME){{{MEDIA} {two_levels}}}}}");
    let by_id_q = format!("query($id:Int){{Media(id:$id){{{NODE} {two_levels}}}}}");
    let vars = match mal_id {
        Some(id) => json!({ "mal": id }),
        None => json!({ "q": title }),
    };
    let root = anilist(&root_q, vars)?["Media"].clone();
    if root.is_null() {
        return Err("not found on AniList".into());
    }

    // Each query returns two levels of relations; deeper nodes are queued and fetched on their own.
    struct Walk {
        parts: BTreeMap<i64, (Value, String)>,
        expanded: HashSet<i64>,
        queue: VecDeque<i64>,
    }
    fn absorb(w: &mut Walk, node: &Value, relation: &str) {
        let Some(id) = node["id"].as_i64() else { return };
        w.parts.entry(id).or_insert_with(|| (node.clone(), relation.to_owned()));
        match node["relations"]["edges"].as_array() {
            Some(edges) if w.expanded.insert(id) => {
                for e in edges {
                    let kind = e["relationType"].as_str().unwrap_or("");
                    if FOLLOW.contains(&kind) && e["node"]["type"] == "ANIME" {
                        absorb(w, &e["node"], kind);
                    }
                }
            }
            Some(_) => {}
            None if !w.expanded.contains(&id) => w.queue.push_back(id),
            None => {}
        }
    }
    let mut w = Walk { parts: BTreeMap::new(), expanded: HashSet::new(), queue: VecDeque::new() };
    absorb(&mut w, &root, "");
    while let Some(id) = w.queue.pop_front() {
        if w.parts.len() >= MAX_PARTS {
            break;
        }
        if w.expanded.contains(&id) {
            continue;
        }
        let relation = w.parts.get(&id).map(|p| p.1.clone()).unwrap_or_default();
        match anilist(&by_id_q, json!({ "id": id })) {
            Ok(d) => absorb(&mut w, &d["Media"], &relation),
            Err(e) => {
                crate::log(&format!("Chronology: skipping AniList {id}: {e}"));
                w.expanded.insert(id);
            }
        }
    }

    let mut parts: Vec<(Value, String)> = w.parts.into_values().filter(|(n, _)| n["format"] != "MUSIC").collect();
    parts.sort_by_key(|(n, _)| sort_key(&n["startDate"]));
    let mut season = 0;
    let list: Vec<Value> = parts
        .iter()
        .enumerate()
        .map(|(i, (n, rel))| {
            let kind = jikan_type(&n["format"]);
            let relation = match kind.as_str() {
                "TV" => {
                    season += 1;
                    format!("Season {season}")
                }
                "Movie" => "Movie".to_owned(),
                _ if !rel.is_empty() && rel != "SEQUEL" && rel != "PREQUEL" => jikan_relation(rel),
                _ => kind.clone(),
            };
            json!({
                "id": n["idMal"].as_u64().unwrap_or(n["id"].as_u64().unwrap_or(0)), "order": i + 1,
                "name": n["title"]["romaji"], "relation": relation, "type": kind,
                "year": n["startDate"]["year"].as_u64().unwrap_or(0),
                "episodes": n["episodes"].as_u64().unwrap_or(1).max(1), "confidence": 0.95,
            })
        })
        .collect();
    let meta = to_jikan(&root);
    let joined = |v: &Value| v.as_array().into_iter().flatten().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", ");
    Ok(json!({
        "status": "success", "confidence": 0.95, "media_kind": "anime",
        "synopsis": meta["synopsis"], "studios_str": joined(&meta["studios"]), "genres_str": joined(&meta["genres"]),
        "source": meta["source"], "score": meta["score"], "airing_status": meta["status"],
        // A single entry means standalone: the UI then shows "no required franchise watch order".
        "franchise": if list.len() < 2 { vec![] } else { list },
    }))
}
