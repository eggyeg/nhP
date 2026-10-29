
// State Management
let isDatabaseLoaded = false;
let activeSearchCategory = 'anime';
let playlist = [];
let currentIndex = -1;
let previousVolume = 0.8;
let isVideoMode = false;
let mpegtsPlayer = null;
let isSeeking = false; // Tracks if user is actively dragging the seekbar
let activeDuration = 0; // True duration of the active track in seconds (Pure JS state)
let nextSeekTime = null; // Serialized seek queue to prevent MSE collisions and freezes!
let isSeekingJS = false; // Synchronous seek lock to prevent event-loop race conditions!
let isPlayerSeeking = false; // Tracks if the media player is currently executing a seek!
let isSkipDismissed = false; // Tracks if the user dismissed the skip overlay for the current video!
let isAPIReady = false; // Tracks if PyWebView API is fully initialized and ready to prevent startup deadlocks!
let activeEpisodeNum = null; // Tracks current playing episode number of library item
let countdownInterval = null; // Countdown timer interval
let countdownTime = 5; // Countdown duration
let lastSaveTime = 0; // Tracks last progress save timestamp
const DEFAULT_MODERNPLAYER_API_URL = ''; // old cloud server (54.235.4.93) is gone; the assistant runs on the local backend with keys.json
let sidecarAudio = null; // External AAC audio for videos with unsupported embedded audio (DTS/TrueHD/etc.)
let sidecarSyncTimer = null;
let sidecarSyncBusy = false;
let sidecarLastHardSync = 0;
let sidecarBadgeTimer = null;
let sidecarLastObservedTime = 0;
let sidecarLastAdvancedAt = 0;
let sidecarRecovering = false;
let sidecarHoldUntil = 0;
let sidecarResumeTimer = null;
let activeSidecarUrl = '';

const DEFAULT_POSTER_DATA = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="#0b0b12"/><circle cx="150" cy="185" r="54" fill="#171724"/><path d="M118 183c10-18 54-18 64 0" stroke="#7c5cfc" stroke-width="8" fill="none" stroke-linecap="round"/><circle cx="128" cy="165" r="7" fill="#fff"/><circle cx="172" cy="165" r="7" fill="#fff"/><text x="150" y="285" fill="#777" font-family="Arial" font-size="18" text-anchor="middle">No poster</text></svg>`);

function parseAssistantEpisodeRequest(text) {
    const t = (text || '').toLowerCase();
    const aliases = [
        ['kill blue', 'Kill Blue'],
        ['kill ao', 'Kill Blue'],
        ['убивая юность', 'Kill Blue'],
        ['bleach', 'Bleach'],
        ['блич', 'Bleach'],
        ['fate', 'Fate'],
        ['фейт', 'Fate'],
        ['prison school', 'Prison School'],
        ['школа тюрьма', 'Prison School']
    ];
    let title = '';
    for (const [needle, value] of aliases) {
        if (t.includes(needle)) { title = value; break; }
    }
    let season = 1;
    const sm = t.match(/(?:season|сезон|s)\s*0*(\d{1,2})/i);
    if (sm) season = parseInt(sm[1], 10) || 1;
    let episode = null;
    const patterns = [
        /s\s*\d{1,2}\s*e\s*0*(\d{1,3})/i,
        /(?:episode|ep|сер(?:ия|ию|ии)?|эпизод)\s*0*(\d{1,3})/i,
        /\b(\d{1,3})\s*[- ]?\s*(?:st|nd|rd|th)?\s*(?:episode|ep|сер(?:ия|ию|ии)?|эпизод)\b/i
    ];
    for (const p of patterns) {
        const m = t.match(p);
        if (m) { episode = parseInt(m[1], 10); break; }
    }
    return { title, season, episode };
}

function isLocalDubAssistantRequest(text) {
    const t = (text || '').toLowerCase();
    const hasDub = ['dub', 'даб', 'дуб', 'дубляж', 'озвуч', 'voice', 'voiceover'].some(x => t.includes(x));
    const req = parseAssistantEpisodeRequest(text);
    return hasDub && !!req.title && !!req.episode;
}

document.addEventListener('error', (e) => {
    const img = e.target;
    if (img && img.tagName === 'IMG' && img.classList.contains('media-poster')) {
        img.src = DEFAULT_POSTER_DATA;
    }
}, true);

// Smart Watching Guard: prevents accidental random clicks / end-seeks from overwriting real progress.
let watchSession = null;
let lastPlaybackTick = null;

function bootStatus(text) {
    try {
        const st = document.querySelector('#app-boot-overlay .boot-subtitle');
        if (st) st.textContent = text;
    } catch(e) {}
}

function bootShowForceButton(text = 'Force open') {
    try {
        const card = document.querySelector('#app-boot-overlay .boot-card');
        if (!card || document.getElementById('boot-force-open-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'boot-force-open-btn';
        btn.textContent = text;
        btn.type = 'button';
        btn.style.cssText = 'position:relative;z-index:999999;margin-top:14px;height:34px;border-radius:17px;border:1px solid rgba(255,255,255,.18);background:#7c5cfc;color:#fff;padding:0 16px;font-size:.74rem;font-weight:900;cursor:pointer;pointer-events:auto;';
        btn.onclick = (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            console.warn('[Boot] User forced UI unlock. Some backend features may still be late.');
            window.__bootForceUnlocked = true;
            window.__dbLoadInProgress = false;
            isAPIReady = !!(window.pywebview && window.pywebview.api);
            hideBootOverlay();
            setTimeout(() => { if (!isDatabaseLoaded) loadAllDataFromPython({ background: true }).catch(() => {}); }, 50);
        };
        card.appendChild(btn);
    } catch(e) {}
}

function hideBootOverlay() {
    const boot = document.getElementById('app-boot-overlay');
    if (boot) {
        boot.classList.add('hidden');
        document.body.classList.remove('app-booting');
        setTimeout(() => { try { boot.remove(); } catch(e) {} }, 450);
    }
}

function withTimeout(promise, ms, label = 'operation') {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function hasRequiredApiMethods() {
    const api = window.pywebview && window.pywebview.api;
    if (!api) return false;
    const required = ['load_all_databases', 'save_db_data', 'open_internal_url', 'merger_scan', 'merger_autosync_merge_all', 'merger_import_downloads', 'merger_list_outputs'];
    return required.every(name => typeof api[name] === 'function');
}

async function waitForUiBindings(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (window.__uiBindingsReady && DOM && DOM.player) return true;
        await sleep(100);
    }
    return false;
}

async function waitForBackendHealth(timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch('/api/health', { cache: 'no-store' });
            const h = await r.json();
            if (h && h.api_ready) return h;
        } catch(e) {}
        await sleep(250);
    }
    return null;
}

async function waitForPywebviewApi(timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (hasRequiredApiMethods()) return true;
        if (Date.now() - start > 15000) bootShowForceButton('Open anyway');
        await sleep(250);
    }
    return false;
}

async function bootLoadDatabasesThenUnlock() {
    if (window.__bootDbStarted) return;
    window.__bootDbStarted = true;
    document.body.classList.add('app-booting');
    try {
        bootStatus('Binding interface controls...');
        const uiOk = await waitForUiBindings(12000);
        if (!uiOk) console.warn('[Boot] UI bindings readiness timed out; continuing carefully.');

        bootStatus('Starting local backend...');
        const health = await waitForBackendHealth(20000);
        if (!health) console.warn('[Boot] Backend health check timed out; pywebview may still work.');

        bootStatus('Connecting desktop API and Merger tools...');
        const apiOk = await waitForPywebviewApi(45000);
        if (!apiOk) {
            console.warn('[Boot] Required PyWebView API methods not ready after timeout.');
            bootStatus('Desktop API is still late. You can wait or Open anyway.');
            bootShowForceButton('Open anyway');
            // Wait a little more unless user forces; this is the stage that caused broken buttons before.
            for (let i = 0; i < 40 && !window.__bootForceUnlocked && !hasRequiredApiMethods(); i++) {
                await sleep(500);
            }
        }
        if (hasRequiredApiMethods()) isAPIReady = true;

        bootStatus('Loading Library / Watching progress...');
        await withTimeout(loadAllDataFromPython({ background: false, boot: true }), 20000, 'boot database load');
        bootStatus('Ready.');
    } catch (e) {
        console.warn('[Boot] Startup gate failed; unlocking UI with background retry:', e);
        window.__dbLoadInProgress = false;
        setTimeout(() => loadAllDataFromPython({ background: true }).catch(() => {}), 1200);
    } finally {
        hideBootOverlay();
    }
}

window.addEventListener('pywebviewready', () => {
    isAPIReady = !!hasRequiredApiMethods();
    setTimeout(bootLoadDatabasesThenUnlock, 150);
});

// Some WebView2 starts expose window.pywebview.api without reliably firing pywebviewready.
const apiReadyWatchdog = setInterval(() => {
    if (window.pywebview && window.pywebview.api) {
        isAPIReady = !!hasRequiredApiMethods();
        if (!window.__bootDbStarted) bootLoadDatabasesThenUnlock();
    }
    if (isAPIReady && isDatabaseLoaded) clearInterval(apiReadyWatchdog);
}, 350);
setTimeout(() => clearInterval(apiReadyWatchdog), 90000);

// Absolute safety: no silent infinite spinner. It still waits much longer than before, but exposes a manual escape.
setTimeout(() => {
    const boot = document.getElementById('app-boot-overlay');
    if (boot) {
        bootStatus('Still starting desktop API. Wait, or open anyway if you only need browsing.');
        bootShowForceButton('Open anyway');
    }
}, 18000);
setTimeout(() => {
    const boot = document.getElementById('app-boot-overlay');
    if (boot && !hasRequiredApiMethods()) {
        console.warn('[Boot] 90s fallback unlock. Backend API is not healthy.');
        window.__dbLoadInProgress = false;
        hideBootOverlay();
    }
}, 90000);

// Settings & Config
let settings = {
    rewindKey: 'ArrowLeft',
    forwardKey: 'ArrowRight',
    skipIntroKey: 'KeyS',
    introDuration: 85,
    introStart: 0,
    introEnd: 85,
    outroStartOffset: 120,
    outroSkipToEndOffset: 5,
    brightness: 100,
    contrast: 100,
    saturation: 100,
    audioBoost: 100,
    aspectRatio: 'contain'
};

// Global DOM elements holder
const DOM = {};

// Web Audio API State
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
let analyser = null;
let canvas = null;
let ctx = null;
let animationFrameId = null; // Used to cleanly stop the visualizer loop
let isAudioPipelineInitialized = false;

/* ======================================================== */
/*              DEFENSIVE PROGRAMMING HELPERS               */
/* ======================================================== */

// Safely bind event listener
function bindEvent(el, eventType, callback, useCapture = false) {
    if (el) {
        el.addEventListener(eventType, callback, useCapture);
    }
}

// Safely retrieve DOM Elements when the page loads
function initDOMElements() {
    // Media Player & HUD
    DOM.player = document.getElementById('media-player');
    DOM.playBtn = document.getElementById('play-btn');
    DOM.playIcon = document.getElementById('play-icon');
    DOM.pauseIcon = document.getElementById('pause-icon');
    DOM.prevBtn = document.getElementById('prev-btn');
    DOM.nextBtn = document.getElementById('next-btn');
    DOM.seekbar = document.getElementById('seekbar');
    DOM.currentTimeLabel = document.getElementById('current-time');
    DOM.totalDurationLabel = document.getElementById('total-duration');
    DOM.volumeBtn = document.getElementById('volume-btn');
    DOM.volumeHighIcon = document.getElementById('volume-high');
    DOM.volumeMutedIcon = document.getElementById('volume-muted');
    DOM.volumeSlider = document.getElementById('volume-slider');
    DOM.speedBtn = document.getElementById('speed-btn');
    DOM.speedMenu = document.getElementById('speed-menu');
    DOM.playlistSidebar = document.getElementById('playlist-sidebar');
    DOM.togglePlaylistBtn = document.getElementById('toggle-playlist-btn');
    DOM.playlistItemsContainer = document.getElementById('playlist-items');
    DOM.playlistCountLabel = document.getElementById('playlist-count');
    DOM.addBtn = document.getElementById('add-btn');
    DOM.addFirstBtn = document.getElementById('add-first-btn');
    DOM.openFileBtn = document.getElementById('open-file-btn');
    DOM.audioUI = document.getElementById('audio-ui');
    DOM.vinylDisc = document.getElementById('vinyl-disc');
    DOM.trackTitle = document.getElementById('track-title');
    DOM.trackArtist = document.getElementById('track-artist');
    DOM.viewport = document.getElementById('player-viewport');
    DOM.fullscreenBtn = document.getElementById('fullscreen-btn');
    DOM.dropOverlay = document.getElementById('drop-overlay');
    DOM.toastElement = document.getElementById('toast');
    DOM.hudOverlay = document.getElementById('hud-overlay');
    DOM.hudContent = document.getElementById('hud-content');
    DOM.skipIntroBtn = document.getElementById('skip-container');
    DOM.skipIntroKeyLabel = document.getElementById('skip-intro-key-label');
    DOM.controlsCard = document.getElementById('controls-card');
}

/* ======================================================== */
/*                     2. MOVIE PLAYER                      */
/* ======================================================== */

/* Helper: Check file extension and if it's TS */
function getFileTypeInfo(filename) {
    const nameLower = filename.toLowerCase();
    const isTS = nameLower.endsWith('.ts');
    const videoExts = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.ogg', '.ts'];
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const isVideo = videoExts.includes(ext);
    return { isVideo, isTS };
}

/* Helper: Format Time */
function formatTime(seconds) {
    if (isNaN(seconds) || seconds === Infinity) return "00:00";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hrs > 0) {
        return `${hrs}:${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }
    return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

/* Show Small Toast */
function showToast(message) {
    if (DOM.toastElement) {
        DOM.toastElement.textContent = message;
        DOM.toastElement.classList.add('show');
        setTimeout(() => {
            DOM.toastElement.classList.remove('show');
        }, 2000);
    }
}

let watchTogetherRoom = null;
let watchTogetherTimer = null;
let watchTogetherLastClientCount = 0;
let watchTogetherLastPush = 0;
let watchTogetherUpdating = false;
let watchTogetherLink = '';
let watchTogetherStateLink = '';
let watchTogetherCloud = false;
let tvRoomPin = null;
let tvRoomTimer = null;
let liveStreamCode = null;
let liveStreamTimer = null;
let joinedWatchRoom = null;
let joinedWatchTimer = null;
let joinedWatchHostBase = '';
let joinedWatchCloud = false;
let joinedWatchDownloadAsked = false;
let joinedWatchDownloading = false;
let watchTogetherUiMode = localStorage.getItem('watch_together_mode') || 'app';
function showWatchTogetherPanel() {
    let overlay = document.getElementById('watch-together-host-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'watch-together-host-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
            <div class="watch-room-card">
                <div class="watch-room-head">
                    <div>
                        <div class="watch-room-kicker">WATCH TOGETHER</div>
                        <div class="watch-room-title" id="watch-room-title">Room</div>
                    </div>
                    <button class="watch-room-close" id="watch-room-close">×</button>
                </div>
                <div class="watch-room-status" id="watch-room-status">Waiting for friend…</div>
                <div class="watch-room-link" id="watch-room-link"></div>
                <div class="watch-room-actions">
                    <button id="watch-copy-link" class="watch-room-btn primary">Copy link</button>
                    <button id="watch-go-player" class="watch-room-btn">Go to player</button>
                    <button id="watch-stop-room" class="watch-room-btn danger">Stop</button>
                </div>
                <div class="watch-room-note">You can create the room first, then open a movie. Friend waits on the link and selects the same local file when ready.</div>
            </div>`;
        document.body.appendChild(overlay);
        document.getElementById('watch-room-close').onclick = () => overlay.classList.add('hidden');
        document.getElementById('watch-copy-link').onclick = async () => {
            try { await navigator.clipboard.writeText(watchTogetherLink); showToast('Room link copied'); } catch(e) { alert(watchTogetherLink); }
        };
        document.getElementById('watch-go-player').onclick = () => {
            overlay.classList.add('hidden');
            closeNavigationBlockers();
            document.getElementById('tab-load-btn')?.click();
            if (currentIndex >= 0 && playlist[currentIndex] && DOM.player) {
                const track = playlist[currentIndex];
                const hasRealSrc = DOM.player.src && DOM.player.src !== window.location.href && DOM.player.src !== '';
                // If boot restored playlist labels but did not load media source yet, load the selected track now.
                if (!hasRealSrc) {
                    playTrack(currentIndex).then(() => {
                        setTimeout(() => { if (DOM.player && DOM.player.paused) DOM.player.play().catch(()=>{}); }, 250);
                    }).catch(e => console.warn('[Watch Together] Go to player playTrack failed:', e));
                } else if (DOM.player.paused) {
                    DOM.player.play().catch(()=>{});
                }
                pushWatchTogetherNow('go-player', 0);
            } else {
                showToast('Room is ready. Open a video now.');
            }
        };
        document.getElementById('watch-stop-room').onclick = () => { overlay.classList.add('hidden'); stopWatchTogetherRoom(); };
    }
    overlay.classList.remove('hidden');
    updateWatchTogetherPanel();
}

function updateWatchTogetherPanel() {
    const title = document.getElementById('watch-room-title');
    const status = document.getElementById('watch-room-status');
    const linkBox = document.getElementById('watch-room-link');
    if (title) title.textContent = watchTogetherRoom ? `Room ${watchTogetherRoom}` : 'No active room';
    if (status) {
        const mediaReady = currentIndex >= 0 && playlist[currentIndex];
        status.textContent = watchTogetherRoom ? `${watchTogetherLastClientCount} friend(s) connected • ${mediaReady ? 'media ready' : 'waiting for host video'}` : 'Room stopped';
    }
    if (linkBox) linkBox.textContent = watchTogetherLink || '';
}

async function ensureHostMediaForWatchTogether() {
    if (currentIndex >= 0 && playlist[currentIndex] && DOM.player) return true;
    // If user is on cinematic/details page, use the first linked episode/movie and open player automatically.
    try {
        if (activeLibraryItem && Array.isArray(activeLibraryItem.episodes)) {
            const firstLinked = activeLibraryItem.episodes.find(e => e && e.path);
            if (firstLinked) {
                playLibraryEpisode(activeLibraryItem, firstLinked.num || 1, 0, 'watch-together-host');
                await sleep(900);
                return currentIndex >= 0 && playlist[currentIndex];
            }
        }
    } catch(e) {}
    return false;
}

function cloudAuthHeaders(extra = {}) {
    const token = localStorage.getItem('modernplayer_api_token') || '';
    const headers = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const serverToken = localStorage.getItem('modernplayer_server_token') || '';
    if (serverToken) headers['X-ModernPlayer-Token'] = serverToken;
    return headers;
}
function cloudApiBase() {
    return (localStorage.getItem('modernplayer_api_url') || '').trim().replace(/\/$/, '');
}

async function createWatchTogetherRoom() {
    try {
        const hasMedia = !!(DOM.player && currentIndex >= 0 && playlist[currentIndex]);
        const track = hasMedia ? playlist[currentIndex] : { name: 'Waiting for host media' };
        const payload = {
            title: hasMedia ? (track.name || 'Watch Together') : 'Waiting for host media',
            path: hasMedia ? (track.path || '') : '',
            duration: hasMedia ? (getActiveDuration() || DOM.player.duration || 0) : 0,
            time: hasMedia ? (DOM.player.currentTime || 0) : 0,
            paused: hasMedia ? DOM.player.paused : true,
            rate: hasMedia ? (DOM.player.playbackRate || 1) : 1
        };
        let data;
        if (watchTogetherUiMode === 'app' && cloudApiBase()) {
            const res = await fetch(cloudApiBase() + '/api/cloud-watch/create', { method:'POST', headers: cloudAuthHeaders(), body: JSON.stringify(payload) });
            data = await res.json();
            if (!res.ok || data.status !== 'success') throw new Error(data.detail || data.message || 'cloud room create failed');
            watchTogetherCloud = true;
            watchTogetherRoom = data.room || data.pin;
            watchTogetherLastClientCount = 0;
            watchTogetherLink = `PIN: ${watchTogetherRoom}`;
            watchTogetherStateLink = cloudApiBase() + '/api/cloud-watch/state/' + encodeURIComponent(watchTogetherRoom);
            try { await navigator.clipboard.writeText(String(watchTogetherRoom)); } catch(e) {}
            showToast('Cloud room PIN copied');
        } else {
            const res = await fetch('/api/watch/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
            data = await res.json();
            if (data.status !== 'success') throw new Error(data.message || 'room create failed');
            watchTogetherCloud = false;
            watchTogetherRoom = data.room;
            watchTogetherLastClientCount = 0;
            const urls = data.urls || [];
            const radmin = urls.find(u => String(u.ip || '').startsWith('26.'));
            const tailscale = urls.find(u => String(u.ip || '').startsWith('100.'));
            const preferred = radmin || tailscale || urls.find(u => u.label === 'LAN') || { url: data.lan_url || data.local_url, label: 'LAN', ip: data.host_ip };
            const link = preferred.url;
            watchTogetherLink = link;
            watchTogetherStateLink = link.replace('/watch/', '/api/watch/state/');
            try { await navigator.clipboard.writeText(link); } catch(e) {}
            showToast(`Watch room copied: ${preferred.label || 'link'}`);
        }
        showWatchTogetherPanel();
        if (watchTogetherTimer) clearInterval(watchTogetherTimer);
        watchTogetherTimer = setInterval(() => { updateWatchTogetherRoom('interval'); pollWatchTogetherClients(); }, 700);
        updateWatchTogetherRoom('created');
        pollWatchTogetherClients();
        setTimeout(() => updateWatchTogetherRoom('created-retry'), 700);
    } catch(e) {
        console.error('[Watch Together] create failed:', e);
        showToast('Watch Together failed: ' + e.message);
    }
}
async function updateWatchTogetherRoom(reason = 'tick') {
    if (!watchTogetherRoom || watchTogetherUpdating) return;
    watchTogetherUpdating = true;
    try {
        const hasMedia = !!(DOM.player && currentIndex >= 0 && playlist[currentIndex]);
        const track = hasMedia ? (playlist[currentIndex] || {}) : {};
        const payload = {
            title: hasMedia ? (track.name || 'Watch Together') : 'Waiting for host to open media',
            path: hasMedia ? (track.path || '') : '',
            duration: hasMedia ? (getActiveDuration() || DOM.player.duration || 0) : 0,
            time: hasMedia ? (DOM.player.currentTime || 0) : 0,
            paused: hasMedia ? DOM.player.paused : true,
            rate: hasMedia ? (DOM.player.playbackRate || 1) : 1,
            reason
        };
        const endpoint = watchTogetherCloud
            ? cloudApiBase() + '/api/cloud-watch/update/' + encodeURIComponent(watchTogetherRoom)
            : ((window.location && window.location.origin && window.location.origin.startsWith('http')) ? window.location.origin : 'http://127.0.0.1:8765') + '/api/watch/update/' + encodeURIComponent(watchTogetherRoom);
        const r = await fetch(endpoint, {
            method:'POST', headers: watchTogetherCloud ? cloudAuthHeaders() : {'Content-Type':'application/json'}, body: JSON.stringify(payload), cache: 'no-store'
        });
        if (!r.ok) throw new Error('update HTTP ' + r.status);
        const btn = document.getElementById('watch-together-btn');
        if (btn) btn.textContent = watchTogetherLastClientCount ? `Room ${watchTogetherRoom} • ${watchTogetherLastClientCount}` : `Room ${watchTogetherRoom}`;
    } catch(e) {
        console.warn('[Watch Together] host update failed:', e);
        const btn = document.getElementById('watch-together-btn');
        if (btn) btn.textContent = `Room ${watchTogetherRoom} !`;
        const st = document.getElementById('watch-room-status');
        if (st) st.textContent = `Sync update failed: ${e.message}`;
    } finally {
        watchTogetherUpdating = false;
    }
}

async function pollWatchTogetherClients() {
    if (!watchTogetherRoom) return;
    try {
        const endpoint = watchTogetherCloud
            ? cloudApiBase() + '/api/cloud-watch/state/' + encodeURIComponent(watchTogetherRoom)
            : ((window.location && window.location.origin && window.location.origin.startsWith('http')) ? window.location.origin : 'http://127.0.0.1:8765') + '/api/watch/state/' + encodeURIComponent(watchTogetherRoom);
        const stateRes = await fetch(endpoint, { cache: 'no-store', headers: watchTogetherCloud ? cloudAuthHeaders({}) : {} });
        if (!stateRes.ok) return;
        const state = await stateRes.json();
        const count = state && state.room && state.room.clients ? Object.keys(state.room.clients).length : 0;
        if (count !== watchTogetherLastClientCount) {
            watchTogetherLastClientCount = count;
            showToast(`Watch Together: ${count} friend(s) connected`);
        }
        updateWatchTogetherPanel();
        const btn = document.getElementById('watch-together-btn');
        if (btn) btn.textContent = count ? `Room ${watchTogetherRoom} • ${count}` : `Room ${watchTogetherRoom}`;
    } catch(e) {}
}


function pushWatchTogetherNow(reason = 'event', minInterval = 120) {
    if (!watchTogetherRoom) return;
    const now = Date.now();
    if (now - watchTogetherLastPush < minInterval) return;
    watchTogetherLastPush = now;
    updateWatchTogetherRoom(reason);
}

function stopWatchTogetherRoom() {
    watchTogetherRoom = null;
    watchTogetherLastClientCount = 0;
    watchTogetherLastPush = 0;
    watchTogetherLink = '';
    watchTogetherStateLink = '';
    watchTogetherCloud = false;
    updateWatchTogetherPanel();
    if (watchTogetherTimer) clearInterval(watchTogetherTimer);
    watchTogetherTimer = null;
    const btn = document.getElementById('watch-together-btn');
    if (btn) btn.textContent = 'Watch Together';
    showToast('Watch Together stopped');
}
async function createLiveStreamDataOnly() {
    const res = await fetch('/api/live_stream/create', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title: 'ModernPlayer Live Stream' })
    });
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'live stream create failed');
    return data;
}

function bestCastUrlFromLiveData(data, device = null) {
    const links = data.urls || [];
    const host = String(device?.host || '');
    // Prefer same subnet as Chromecast if possible.
    if (host) {
        const prefix = host.split('.').slice(0,3).join('.') + '.';
        const same = links.find(u => String(u.ip || '').startsWith(prefix));
        if (same) return same.url;
    }
    const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
    return (wifiLan && wifiLan.url) || data.lan_url || data.local_url || (links[0] && links[0].url) || '';
}

async function openChromecastCastPanel() {
    let overlay = document.getElementById('chromecast-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'chromecast-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
          <div class="watch-room-card tv-host-card">
            <div class="watch-room-head">
              <div><div class="watch-room-kicker">CAST</div><div class="watch-room-title">Cast to TV</div></div>
              <button class="watch-room-close" id="cast-close">×</button>
            </div>
            <div class="watch-room-status" id="cast-status">Searching Chromecast devices...</div>
            <div id="cast-devices" class="tv-source-list"></div>
            <div class="watch-room-note">This uses Chromecast / Google Cast. It starts a live PC screen stream and sends it to the selected TV. If audio is missing, set LIVE_STREAM_AUDIO_DEVICE in keys.json.</div>
          </div>`;
        document.body.appendChild(overlay);
        document.getElementById('cast-close').onclick = () => overlay.classList.add('hidden');
    }
    overlay.classList.remove('hidden');
    const status = document.getElementById('cast-status');
    const list = document.getElementById('cast-devices');
    status.textContent = 'Searching Chromecast devices...';
    list.innerHTML = '';
    try {
        if (!(window.pywebview && window.pywebview.api && window.pywebview.api.chromecast_list_devices)) {
            status.textContent = 'Chromecast API missing in this build.';
            return;
        }
        const raw = await window.pywebview.api.chromecast_list_devices(8);
        const res = JSON.parse(raw || '{}');
        if (res.status === 'missing_dependency') {
            status.textContent = res.message || 'pychromecast is not installed.';
            return;
        }
        if (res.status !== 'success') throw new Error(res.message || res.status);
        const devices = res.devices || [];
        if (!devices.length) {
            status.textContent = 'No Chromecast devices found. Make sure TV and PC are on the same LAN and Chromecast is enabled.';
            return;
        }
        status.textContent = `${devices.length} device(s) found. Choose TV to start Live Stream.`;
        list.innerHTML = devices.map((d, i) => `
          <button class="tv-source-choice" data-i="${i}">
            <span class="tv-source-label">${d.model || 'CAST'}</span>
            <span class="tv-source-name">${d.name || 'Chromecast'} ${d.host ? '· ' + d.host : ''}</span>
          </button>`).join('');
        list.querySelectorAll('.tv-source-choice').forEach(btn => {
            btn.onclick = async () => {
                const d = devices[Number(btn.dataset.i)];
                try {
                    status.textContent = `Starting live stream for ${d.name || 'TV'}...`;
                    const data = await createLiveStreamDataOnly();
                    liveStreamCode = data.code;
                    const url = bestCastUrlFromLiveData(data, d);
                    status.textContent = `Casting to ${d.name || 'TV'}...`;
                    const castRaw = await window.pywebview.api.chromecast_play_url(d.uuid || d.name, url, 'ModernPlayer Live Stream', 'application/vnd.apple.mpegurl');
                    const cast = JSON.parse(castRaw || '{}');
                    if (cast.status !== 'success') throw new Error(cast.message || cast.status);
                    showLiveStreamPanel(data);
                    status.textContent = `Casting to ${d.name || 'TV'}.`;
                    showToast('Casting Live Stream to TV');
                } catch(e) {
                    status.textContent = 'Cast failed: ' + e.message;
                }
            };
        });
    } catch(e) {
        status.textContent = 'Chromecast search failed: ' + e.message;
    }
}

function showLiveStreamPanel(data = null) {
    let overlay = document.getElementById('live-stream-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'live-stream-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
          <div class="watch-room-card tv-host-card">
            <div class="watch-room-head">
              <div><div class="watch-room-kicker">LIVE STREAM</div><div class="watch-room-title" id="live-stream-title">PC screen stream</div></div>
              <button class="watch-room-close" id="live-stream-close">×</button>
            </div>
            <div class="watch-room-status" id="live-stream-status">Preparing screen stream…</div>
            <div class="watch-room-link" id="live-stream-link"></div>
            <div class="watch-room-actions">
              <button id="live-copy" class="watch-room-btn primary">Copy link</button>
              <button id="live-open" class="watch-room-btn">Open here</button>
              <button id="live-stop" class="watch-room-btn danger">Stop stream</button>
            </div>
            <div class="watch-room-note">This streams your PC screen, not a file. Keep the player visible. If audio is missing, configure LIVE_STREAM_AUDIO_DEVICE in keys.json to Stereo Mix or VB-CABLE.</div>
          </div>`;
        document.body.appendChild(overlay);
        document.getElementById('live-stream-close').onclick = () => overlay.classList.add('hidden');
        document.getElementById('live-copy').onclick = async () => {
            const link = document.getElementById('live-stream-link')?.dataset.direct || '';
            try { await navigator.clipboard.writeText(link); showToast('Live stream link copied'); } catch(e) { alert(link); }
        };
        document.getElementById('live-open').onclick = () => {
            const link = document.getElementById('live-stream-link')?.dataset.direct || '';
            if (link) window.open(link, '_blank');
        };
        document.getElementById('live-stop').onclick = stopLiveStream;
    }
    if (data) {
        const links = data.urls || [];
        const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
        const preferred = wifiLan || links[0] || { url: data.lan_url || data.local_url || '' };
        const link = preferred.url || data.lan_url || data.local_url || '';
        const linkEl = document.getElementById('live-stream-link');
        if (linkEl) {
            linkEl.dataset.direct = link;
            const extra = links.length ? '\n\nDetected links:\n' + links.map(u => `${u.label || 'IP'}: ${u.url}`).join('\n') : '';
            linkEl.textContent = `Live: ${link}${extra}`;
        }
        const status = document.getElementById('live-stream-status');
        if (status) status.textContent = data.has_audio ? 'Live stream starting with audio device.' : 'Live stream starting without audio device.';
        pollLiveStreamStatus(data.code);
    }
    overlay.classList.remove('hidden');
}

async function createLiveStream() {
    try {
        showTaskOverlay('Starting live stream...', 'Capturing PC screen for TV/browser.');
        clearTimeout(taskOverlaySafetyTimer);
        const res = await fetch('/api/live_stream/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: 'ModernPlayer Live Stream' }) });
        const data = await res.json();
        hideTaskOverlay(200);
        if (data.status !== 'success') throw new Error(data.message || 'live stream create failed');
        liveStreamCode = data.code;
        const links = data.urls || [];
        const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
        const link = (wifiLan && wifiLan.url) || data.lan_url || data.local_url;
        try { await navigator.clipboard.writeText(link); } catch(e) {}
        showToast('Live stream link copied');
        showLiveStreamPanel(data);
        if (liveStreamTimer) clearInterval(liveStreamTimer);
        liveStreamTimer = setInterval(() => pollLiveStreamStatus(liveStreamCode), 1500);
    } catch(e) {
        hideTaskOverlay(200);
        console.error('[Live Stream] failed:', e);
        showToast('Live Stream failed: ' + e.message);
    }
}

async function pollLiveStreamStatus(code) {
    if (!code) return;
    try {
        const r = await fetch('/api/live_stream/status/' + encodeURIComponent(code), { cache:'no-store' });
        const data = await r.json();
        const status = document.getElementById('live-stream-status');
        if (status && data.status === 'success') {
            const st = data.stream || {};
            status.textContent = `${st.message || st.status || 'Streaming'}${st.has_audio ? ' • audio' : ' • no audio device'}`;
        }
    } catch(e) {}
}

async function stopLiveStream() {
    if (!liveStreamCode) return;
    try { await fetch('/api/live_stream/stop/' + encodeURIComponent(liveStreamCode), { method:'POST' }); } catch(e) {}
    if (liveStreamTimer) clearInterval(liveStreamTimer);
    liveStreamTimer = null;
    liveStreamCode = null;
    const overlay = document.getElementById('live-stream-panel');
    if (overlay) overlay.classList.add('hidden');
    showToast('Live Stream stopped');
}

function collectTvSources() {
    const sources = [];
    const add = (label, name, path) => {
        if (!path) return;
        if (sources.some(x => x.path === path)) return;
        sources.push({ label, name: name || path.split(/[\\/]/).pop(), path });
    };
    if (currentIndex >= 0 && playlist[currentIndex] && playlist[currentIndex].path) {
        add('Current player', playlist[currentIndex].name, playlist[currentIndex].path);
    }
    if (activeLibraryItem && Array.isArray(activeLibraryItem.episodes)) {
        activeLibraryItem.episodes.filter(e => e && e.path).forEach(e => {
            const isMovie = activeLibraryItem.category === 'movie' || activeLibraryItem.episodes.length === 1;
            add(isMovie ? 'Library movie' : `Episode ${e.num}`, e.name || `${activeLibraryItem.title} E${e.num}`, e.path);
        });
    }
    return sources;
}

function showTvSourcePicker() {
    const sources = collectTvSources();
    if (!sources.length) {
        showToast('Open or link a local video first');
        return;
    }
    if (sources.length === 1) {
        createTvRoom(sources[0]);
        return;
    }
    let overlay = document.getElementById('tv-source-picker');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'tv-source-picker';
    overlay.className = 'watch-together-host-panel';
    overlay.innerHTML = `
      <div class="watch-room-card tv-host-card">
        <div class="watch-room-head">
          <div><div class="watch-room-kicker">TV MODE</div><div class="watch-room-title">Choose what to cast</div></div>
          <button class="watch-room-close" id="tv-source-close">×</button>
        </div>
        <div class="watch-room-note">Pick the exact file to serve to your TV. This prevents TV Mode from using an old restored playlist item.</div>
        <div id="tv-source-list" class="tv-source-list"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('tv-source-close').onclick = () => overlay.remove();
    const list = document.getElementById('tv-source-list');
    list.innerHTML = sources.map((src, i) => `
      <button class="tv-source-choice" data-i="${i}">
        <span class="tv-source-label">${src.label}</span>
        <span class="tv-source-name" title="${src.name}">${src.name}</span>
      </button>`).join('');
    list.querySelectorAll('.tv-source-choice').forEach(btn => {
        btn.onclick = () => {
            const src = sources[Number(btn.dataset.i)];
            overlay.remove();
            createTvRoom(src);
        };
    });
}

function showTvModePanel(data = null) {
    let overlay = document.getElementById('tv-mode-host-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'tv-mode-host-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
            <div class="watch-room-card tv-host-card">
                <div class="watch-room-head">
                    <div>
                        <div class="watch-room-kicker">TV MODE</div>
                        <div class="watch-room-title" id="tv-room-title">TV Room</div>
                    </div>
                    <button class="watch-room-close" id="tv-room-close">×</button>
                </div>
                <div class="tv-pin-box">
                    <div class="tv-pin-label">PIN CODE</div>
                    <div class="tv-pin-value" id="tv-pin-value">------</div>
                </div>
                <div class="watch-room-status" id="tv-room-status">Open the link on your TV and press Start once.</div>
                <div class="watch-room-link" id="tv-room-link"></div>
                <div class="watch-room-actions">
                    <button id="tv-copy-direct" class="watch-room-btn primary">Copy TV link</button>
                    <button id="tv-copy-join" class="watch-room-btn">Copy join page</button>
                    <button id="tv-open-local" class="watch-room-btn">Open here</button>
                    <button id="tv-stop-room" class="watch-room-btn danger">Stop</button>
                </div>
                <div class="watch-room-note">TV must be on the same Wi‑Fi LAN or VPN. Best compatibility is MP4 H264 AAC. MKV HEVC may not play in TV browser until TV compatible stream mode is added.</div>
            </div>`;
        document.body.appendChild(overlay);
        document.getElementById('tv-room-close').onclick = () => overlay.classList.add('hidden');
        document.getElementById('tv-copy-direct').onclick = async () => {
            const link = document.getElementById('tv-room-link')?.dataset.direct || '';
            try { await navigator.clipboard.writeText(link); showToast('TV direct link copied'); } catch(e) { alert(link); }
        };
        document.getElementById('tv-copy-join').onclick = async () => {
            const link = document.getElementById('tv-room-link')?.dataset.join || '';
            try { await navigator.clipboard.writeText(link); showToast('TV join page copied'); } catch(e) { alert(link); }
        };
        document.getElementById('tv-open-local').onclick = () => {
            const link = document.getElementById('tv-room-link')?.dataset.direct || '';
            if (link) window.open(link, '_blank');
        };
        document.getElementById('tv-stop-room').onclick = () => { overlay.classList.add('hidden'); stopTvRoom(); };
    }
    if (data) {
        const pin = data.pin || tvRoomPin || '------';
        const direct = data.lan_url || data.local_url || '';
        const join = data.join_url || '';
        const links = data.urls || [];
        const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
        const radmin = links.find(u => String(u.ip || '').startsWith('26.'));
        const preferredDirect = (wifiLan && wifiLan.url) || direct || (radmin && radmin.url);
        const preferredJoin = (wifiLan && wifiLan.join_url) || join || (radmin && radmin.join_url);
        const title = document.getElementById('tv-room-title');
        const pinEl = document.getElementById('tv-pin-value');
        const linkEl = document.getElementById('tv-room-link');
        const status = document.getElementById('tv-room-status');
        if (title) title.textContent = `TV Room ${pin}`;
        if (pinEl) pinEl.textContent = pin;
        if (linkEl) {
            linkEl.dataset.direct = preferredDirect;
            linkEl.dataset.join = preferredJoin;
            const extra = links.length ? '\n\nDetected links:\n' + links.map(u => `${u.label || 'IP'}: ${u.url}`).join('\n') : '';
            linkEl.textContent = `Direct: ${preferredDirect}\nJoin: ${preferredJoin}${extra}`;
        }
        if (status) status.textContent = 'TV room is active. Open direct link or join page on TV.';
    }
    overlay.classList.remove('hidden');
}

async function createTvRoom(source = null) {
    source = source || (currentIndex >= 0 && playlist[currentIndex] ? { name: playlist[currentIndex].name, path: playlist[currentIndex].path } : null);
    if (!source || !source.path) {
        showToast('Open or link a local video first');
        return;
    }
    try {
        const isCurrent = currentIndex >= 0 && playlist[currentIndex] && playlist[currentIndex].path === source.path;
        const payload = {
            title: source.name || 'ModernPlayer TV',
            path: source.path,
            duration: isCurrent ? (getActiveDuration() || DOM.player.duration || 0) : 0,
            time: isCurrent ? (DOM.player.currentTime || 0) : 0,
            paused: isCurrent ? DOM.player.paused : true,
            rate: isCurrent ? (DOM.player.playbackRate || 1) : 1
        };
        const res = await fetch('/api/tv/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        if (data.status !== 'success') throw new Error(data.message || 'TV room create failed');
        tvRoomPin = data.pin;
        const tvBtn = document.getElementById('tv-mode-btn');
        if (tvBtn) tvBtn.textContent = `TV ${tvRoomPin}`;
        const links = data.urls || [];
        const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
        const radmin = links.find(u => String(u.ip || '').startsWith('26.'));
        // TV on same Wi-Fi needs LAN IP, not Radmin. Radmin is for remote friend/app mode.
        const link = (wifiLan && wifiLan.url) || data.lan_url || (radmin && radmin.url) || data.local_url;
        try { await navigator.clipboard.writeText(link); } catch(e) {}
        showToast('TV link copied');
        showTvModePanel(data);
        if (tvRoomTimer) clearInterval(tvRoomTimer);
        tvRoomTimer = setInterval(updateTvRoom, 500);
        updateTvRoom();
    } catch(e) {
        console.error('[TV Mode] create failed:', e);
        showToast('TV Mode failed: ' + e.message);
    }
}
async function updateTvRoom() {
    if (!tvRoomPin || !DOM.player || currentIndex < 0 || !playlist[currentIndex]) return;
    try {
        const track = playlist[currentIndex];
        await fetch('/api/tv/update/' + encodeURIComponent(tvRoomPin), {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
                title: track.name || 'ModernPlayer TV',
                path: track.path,
                duration: getActiveDuration() || DOM.player.duration || 0,
                time: DOM.player.currentTime || 0,
                paused: DOM.player.paused,
                rate: DOM.player.playbackRate || 1
            })
        });
    } catch(e) {}
}
function stopTvRoom() {
    tvRoomPin = null;
    const btn = document.getElementById('tv-mode-btn');
    if (btn) btn.textContent = 'TV Mode';
    if (tvRoomTimer) clearInterval(tvRoomTimer);
    tvRoomTimer = null;
    showToast('TV Mode stopped');
}

function showWatchTogetherStart() {
    if (watchTogetherRoom) return showWatchTogetherPanel();
    let overlay = document.getElementById('watch-start-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'watch-start-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
          <div class="watch-room-card watch-start-card">
            <div class="watch-room-head">
              <div><div class="watch-room-kicker">WATCH TOGETHER</div><div class="watch-room-title">Room setup</div></div>
              <button class="watch-room-close" id="watch-start-close">×</button>
            </div>
            <button class="watch-mode-pill" id="watch-mode-toggle"></button>
            <div class="watch-room-note" id="watch-mode-note"></div>
            <div class="watch-room-actions" style="margin-top:14px;">
              <button id="watch-start-create" class="watch-room-btn primary">Create Room</button>
              <button id="watch-start-join" class="watch-room-btn">Join Room</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        document.getElementById('watch-start-close').onclick = () => overlay.classList.add('hidden');
        document.getElementById('watch-mode-toggle').onclick = () => {
            watchTogetherUiMode = watchTogetherUiMode === 'app' ? 'browser' : 'app';
            localStorage.setItem('watch_together_mode', watchTogetherUiMode);
            updateWatchStartPanel();
        };
        document.getElementById('watch-start-create').onclick = () => { overlay.classList.add('hidden'); createWatchTogetherRoom(); };
        document.getElementById('watch-start-join').onclick = () => { overlay.classList.add('hidden'); joinWatchTogetherRoom(); };
    }
    overlay.classList.remove('hidden');
    updateWatchStartPanel();
}

function updateWatchStartPanel() {
    const mode = document.getElementById('watch-mode-toggle');
    const note = document.getElementById('watch-mode-note');
    const join = document.getElementById('watch-start-join');
    if (mode) mode.textContent = `Mode: ${watchTogetherUiMode === 'app' ? 'APP-MODE' : 'BROWSER MODE'}`;
    if (note) note.textContent = watchTogetherUiMode === 'app'
        ? 'App-mode: cloud PIN if Profile server is configured. Friend opens app, Join Room, enters only PIN. Best for MKV/HEVC because the app decodes it.'
        : 'Browser mode: host creates a link. Friend opens browser and selects the same browser-compatible file.';
    if (join) join.style.display = watchTogetherUiMode === 'app' ? '' : 'none';
}

async function joinWatchTogetherRoom() {
    const base = cloudApiBase() || prompt('Server URL is not set in Profile. Enter API URL:', '')?.trim().replace(/\/$/, '');
    if (!base) return;
    localStorage.setItem('modernplayer_api_url', base);
    const pin = prompt('Enter room PIN:', localStorage.getItem('watch_join_pin') || '');
    if (!pin) return;
    joinedWatchCloud = true;
    joinedWatchHostBase = base;
    joinedWatchRoom = String(pin).trim();
    localStorage.setItem('watch_join_pin', joinedWatchRoom);
    showToast('Joined cloud room. Open the same local file, then wait for host.');
    alert(`Joined room ${joinedWatchRoom}.\n\nOpen the same movie/episode in your app.\nStatus will follow host play pause seek.`);
    if (joinedWatchTimer) clearInterval(joinedWatchTimer);
    joinedWatchTimer = setInterval(pollJoinedWatchRoom, 500);
    pollJoinedWatchRoom();
}


async function maybeAskDownloadSharedFile(room) {
    if (!room || !room.share || !room.share.available || joinedWatchDownloadAsked || joinedWatchDownloading) return;
    if (currentIndex >= 0 && playlist[currentIndex]) return;
    joinedWatchDownloadAsked = true;
    const name = room.share.name || 'shared media';
    const size = room.share.size_mb ? `${room.share.size_mb} MB` : 'unknown size';
    const ok = confirm(`Host wants to watch:\n\n${name}\n${size}\n\nYou do not have a file open in the app. Download it from host now?`);
    if (!ok) {
        showToast('You declined host file download');
        return;
    }
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.watch_share_download_start)) {
        showToast('Download API missing in this build');
        return;
    }
    joinedWatchDownloading = true;
    try {
        const url = joinedWatchHostBase + room.share.download_url;
        const raw = await window.pywebview.api.watch_share_download_start(url, name);
        const res = JSON.parse(raw || '{}');
        if (res.status !== 'processing') throw new Error(res.message || 'download did not start');
        showTaskOverlay('Downloading from host...', name);
        clearTimeout(taskOverlaySafetyTimer);
        for (let i = 0; i < 43200; i++) { // long files: up to 12h at 1s
            await sleep(1000);
            const stRaw = await window.pywebview.api.media_task_status(res.task_id);
            const st = JSON.parse(stRaw || '{}');
            updateTaskOverlay('Downloading from host...', st.message || `${st.progress || 0}%`);
            if (st.status === 'ready' && st.path) {
                hideTaskOverlay(200);
                showToast('Shared file downloaded');
                addFilesToPlaylist([{ name: st.name || name, path: st.path, size: 0 }]);
                setTimeout(() => pollJoinedWatchRoom(), 1200);
                break;
            }
            if (st.status === 'error') {
                hideTaskOverlay(200);
                showToast('Host download failed');
                console.error('[Watch Together] host download failed:', st.message);
                break;
            }
        }
    } catch(e) {
        hideTaskOverlay(200);
        showToast('Host download error: ' + e.message);
    } finally {
        joinedWatchDownloading = false;
    }
}

async function pollJoinedWatchRoom() {
    if (!joinedWatchRoom || !joinedWatchHostBase) return;
    try {
        if (joinedWatchCloud) {
            await fetch(`${joinedWatchHostBase}/api/cloud-watch/join/${encodeURIComponent(joinedWatchRoom)}`, { method:'POST', headers: cloudAuthHeaders(), body: JSON.stringify({ has_file: currentIndex >= 0 && !!playlist[currentIndex] }) }).catch(()=>{});
        }
        const url = joinedWatchCloud
            ? `${joinedWatchHostBase}/api/cloud-watch/state/${encodeURIComponent(joinedWatchRoom)}`
            : `${joinedWatchHostBase}/api/watch/state/${encodeURIComponent(joinedWatchRoom)}`;
        const r = await fetch(url, { cache:'no-store', headers: joinedWatchCloud ? cloudAuthHeaders({}) : {} });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (data.status !== 'success') throw new Error(data.message || data.status);
        await maybeAskDownloadSharedFile(data.room);
        const st = data.room.state || {};
        const target = Number(st.time || 0) + (!st.paused ? Math.max(0, Number(data.serverTime) - Number(st.updatedAt || data.serverTime)) * Number(st.rate || 1) : 0);
        const btn = document.getElementById('watch-together-btn');
        if (btn) btn.textContent = `Joined ${joinedWatchRoom}`;
        if (!DOM.player || currentIndex < 0 || !playlist[currentIndex]) return;
        const drift = Math.abs((DOM.player.currentTime || 0) - target);
        DOM.player.playbackRate = Number(st.rate || 1);
        if (drift > 0.8) seekVideoSafely(target, 'watch-join-sync');
        if (st.paused && !DOM.player.paused) DOM.player.pause();
        if (!st.paused && DOM.player.paused) DOM.player.play().catch(()=>{});
        if (!st.paused && drift > 0.15 && drift <= 0.8) DOM.player.playbackRate = (DOM.player.currentTime < target ? 1.03 : 0.97) * Number(st.rate || 1);
    } catch(e) {
        const btn = document.getElementById('watch-together-btn');
        if (btn) btn.textContent = `Joined ${joinedWatchRoom} !`;
    }
}

function initCloudProfileButton() {
    if (document.getElementById('cloud-profile-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'cloud-profile-btn';
    btn.className = 'cloud-profile-btn';
    btn.textContent = localStorage.getItem('modernplayer_cloud_user') || 'Profile';
    btn.onclick = openCloudProfilePanel;
    document.body.appendChild(btn);
}

function openCloudProfilePanel() {
    let overlay = document.getElementById('cloud-profile-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'cloud-profile-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
          <div class="watch-room-card cloud-profile-card">
            <div class="watch-room-head">
              <div><div class="watch-room-kicker">MODERNPLAYER CLOUD</div><div class="watch-room-title">Profile</div></div>
              <button class="watch-room-close" id="cloud-profile-close">×</button>
            </div>
            <label class="cloud-label">Server URL</label>
            <input id="cloud-url" class="cloud-input" placeholder="http://54.235.4.93">
            <label class="cloud-label">Username or email</label>
            <input id="cloud-login" class="cloud-input" placeholder="marsel">
            <label class="cloud-label">Email for registration</label>
            <input id="cloud-email" class="cloud-input" placeholder="email@example.com">
            <label class="cloud-label">Password</label>
            <input id="cloud-pass" class="cloud-input" type="password" placeholder="password">
            <div class="watch-room-actions" style="margin-top:14px;">
              <button id="cloud-login-btn" class="watch-room-btn primary">Login</button>
              <button id="cloud-register-btn" class="watch-room-btn">Register</button>
              <button id="cloud-logout-btn" class="watch-room-btn danger">Logout</button>
            </div>
            <div class="watch-room-status" id="cloud-status" style="margin-top:12px;">Not connected</div>
            <div class="watch-room-note">Cloud account will later enable server Assistant memory, user limits, cloud RAW search and profile sync.</div>
          </div>`;
        document.body.appendChild(overlay);
        document.getElementById('cloud-profile-close').onclick = () => overlay.classList.add('hidden');
        document.getElementById('cloud-login-btn').onclick = cloudLogin;
        document.getElementById('cloud-register-btn').onclick = cloudRegister;
        document.getElementById('cloud-logout-btn').onclick = cloudLogout;
    }
    document.getElementById('cloud-url').value = localStorage.getItem('modernplayer_api_url') || DEFAULT_MODERNPLAYER_API_URL || '';
    document.getElementById('cloud-login').value = localStorage.getItem('modernplayer_cloud_user') || '';
    document.getElementById('cloud-email').value = localStorage.getItem('modernplayer_cloud_email') || '';
    updateCloudStatus();
    overlay.classList.remove('hidden');
}

function cloudBaseUrl() {
    return (document.getElementById('cloud-url')?.value || localStorage.getItem('modernplayer_api_url') || DEFAULT_MODERNPLAYER_API_URL || '').trim().replace(/\/$/, '');
}
function updateCloudStatus(text = '') {
    const st = document.getElementById('cloud-status');
    const user = localStorage.getItem('modernplayer_cloud_user') || '';
    const token = localStorage.getItem('modernplayer_api_token') || '';
    if (st) st.textContent = text || (token ? `Logged in as ${user || 'user'}` : 'Not connected');
    const btn = document.getElementById('cloud-profile-btn');
    if (btn) btn.textContent = token ? (user || 'Profile') : 'Profile';
}
async function cloudLogin() {
    try {
        const base = cloudBaseUrl();
        if (!base) throw new Error('Server URL required');
        const username = document.getElementById('cloud-login').value.trim();
        const password = document.getElementById('cloud-pass').value;
        const r = await fetch(base + '/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, password }) });
        const data = await r.json();
        if (!r.ok || data.status !== 'success') throw new Error(data.detail || data.message || 'login failed');
        localStorage.setItem('modernplayer_api_url', base);
        localStorage.setItem('modernplayer_api_token', data.token);
        localStorage.setItem('modernplayer_cloud_user', data.user?.username || username);
        localStorage.setItem('modernplayer_cloud_email', data.user?.email || '');
        updateCloudStatus('Login successful');
        showToast('Cloud login successful');
    } catch(e) { updateCloudStatus('Login error: ' + e.message); }
}
async function cloudRegister() {
    try {
        const base = cloudBaseUrl();
        if (!base) throw new Error('Server URL required');
        const username = document.getElementById('cloud-login').value.trim();
        const email = document.getElementById('cloud-email').value.trim();
        const password = document.getElementById('cloud-pass').value;
        const r = await fetch(base + '/api/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username, email, password }) });
        const data = await r.json();
        if (!r.ok || data.status !== 'success') throw new Error(data.detail || data.message || 'register failed');
        localStorage.setItem('modernplayer_api_url', base);
        localStorage.setItem('modernplayer_cloud_user', username);
        localStorage.setItem('modernplayer_cloud_email', email);
        let msg = data.email_verification_required ? 'Registered. Check email verification.' : 'Registered. You can login now.';
        if (data.verification_url) msg += ' Verification URL: ' + data.verification_url;
        updateCloudStatus(msg);
        if (data.verification_url) alert(msg);
    } catch(e) { updateCloudStatus('Register error: ' + e.message); }
}
function cloudLogout() {
    localStorage.removeItem('modernplayer_api_token');
    updateCloudStatus('Logged out');
    showToast('Cloud logged out');
}

function initWatchTogetherButton() {
    if (!document.getElementById('watch-together-btn')) {
        const btn = document.createElement('button');
        btn.id = 'watch-together-btn';
        btn.className = 'watch-together-btn';
        btn.textContent = 'Watch Together';
        btn.title = 'Create sync room for a friend with the same file';
        btn.onclick = () => showWatchTogetherStart();
        document.body.appendChild(btn);
    }
    if (!document.getElementById('live-stream-btn')) {
        const live = document.createElement('button');
        live.id = 'live-stream-btn';
        live.className = 'watch-together-btn live-stream-btn';
        live.textContent = 'Cast TV';
        live.title = 'Find Chromecast TV and cast live PC stream';
        live.onclick = () => openChromecastCastPanel();
        document.body.appendChild(live);
    }
}

let taskOverlaySafetyTimer = null;
function showTaskOverlay(title, subtitle = '') {
    clearTimeout(taskOverlaySafetyTimer);
    let overlay = document.getElementById('task-progress-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'task-progress-overlay';
        overlay.className = 'task-progress-overlay hidden';
        overlay.innerHTML = `
            <div class="task-progress-card">
                <div class="task-progress-title" id="task-progress-title">Working...</div>
                <div class="task-progress-subtitle" id="task-progress-subtitle"></div>
                <div class="task-progress-bar"><span></span></div>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    const t = document.getElementById('task-progress-title');
    const st = document.getElementById('task-progress-subtitle');
    if (t) t.textContent = title;
    if (st) st.textContent = subtitle;
    overlay.classList.remove('hidden');
    taskOverlaySafetyTimer = setTimeout(() => {
        const current = document.getElementById('task-progress-overlay');
        if (current && !current.classList.contains('hidden')) {
            current.classList.add('hidden');
            showToast('Linking dialog closed or timed out');
        }
    }, 15000);
}


function updateTaskOverlay(title, subtitle = '') {
    const t = document.getElementById('task-progress-title');
    const st = document.getElementById('task-progress-subtitle');
    if (t) t.textContent = title;
    if (st) st.textContent = subtitle;
}

function hideTaskOverlay(delay = 350) {
    clearTimeout(taskOverlaySafetyTimer);
    const overlay = document.getElementById('task-progress-overlay');
    if (!overlay) return;
    setTimeout(() => overlay.classList.add('hidden'), delay);
}

function setSidecarBadge(visible, text = 'AAC audio') {
    clearTimeout(sidecarBadgeTimer);
    let badge = document.getElementById('sidecar-audio-badge');
    if (!visible) {
        if (badge) badge.remove();
        return;
    }
    // Keep it almost invisible for immersion: show only a short confirmation, then remove.
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'sidecar-audio-badge';
        badge.className = 'sidecar-audio-badge';
        document.body.appendChild(badge);
    }
    badge.textContent = text;
    badge.classList.remove('sidecar-badge-hide');
    sidecarBadgeTimer = setTimeout(() => {
        const current = document.getElementById('sidecar-audio-badge');
        if (current) {
            current.classList.add('sidecar-badge-hide');
            setTimeout(() => { try { current.remove(); } catch(e) {} }, 300);
        }
    }, 2200);
}


function isVideoReadyForSidecar() {
    if (!DOM.player) return false;
    // For sidecar audio we only need the video session to be alive. Huge MKV can sit at readyState=1/2 often.
    return !DOM.player.paused && DOM.player.readyState >= 1;
}

function syncSidecarVolumeAndRate(rateNudge = 0) {
    if (!sidecarAudio || !DOM.player) return;
    try { sidecarAudio.volume = Math.max(0, Math.min(1, DOM.player.volume ?? 1)); } catch(e) {}
    try {
        const baseRate = DOM.player.playbackRate || 1;
        sidecarAudio.playbackRate = Math.max(0.90, Math.min(1.10, baseRate + rateNudge));
    } catch(e) {}
    // Never leave recovery-muted state stuck.
    try { sidecarAudio.muted = false; } catch(e) {}
}

function syncSidecarToVideo(force = false) {
    if (!sidecarAudio || !DOM.player || sidecarSyncBusy) return;
    sidecarSyncBusy = true;
    try {
        syncSidecarVolumeAndRate(0);
        const vt = DOM.player.currentTime || 0;
        const at = sidecarAudio.currentTime || 0;
        const driftRaw = vt - at;
        const drift = Math.abs(driftRaw);
        const now = Date.now();
        // Hard sync only on startup/real seek/large drift. This avoids chopped audio.
        if ((force && drift > 0.05) || (drift > 1.25 && now - sidecarLastHardSync > 1800)) {
            sidecarAudio.currentTime = vt;
            sidecarLastHardSync = now;
            syncSidecarVolumeAndRate(0);
        } else if (drift > 0.18) {
            syncSidecarVolumeAndRate((driftRaw > 0 ? 1 : -1) * (drift > 0.7 ? 0.045 : 0.018));
        }
    } catch(e) {
        console.warn('[Audio Sidecar] sync failed:', e);
    } finally {
        sidecarSyncBusy = false;
    }
}

function scheduleSidecarResume(reason = 'resume', delay = 120) {
    clearTimeout(sidecarResumeTimer);
    sidecarResumeTimer = setTimeout(() => {
        if (!sidecarAudio || !DOM.player || DOM.player.paused) return;
        syncSidecarToVideo(true);
        startSidecarAudio(false, reason);
    }, delay);
}

function holdSidecarAudio(reason = 'seek', ms = 650) {
    sidecarHoldUntil = Math.max(sidecarHoldUntil, Date.now() + ms);
    if (sidecarAudio) {
        try { sidecarAudio.pause(); } catch(e) {}
        scheduleSidecarResume(reason + '-release', ms + 80);
    }
}

function markExplicitVideoSeek(reason = 'seek', holdMs = 750) {
    holdSidecarAudio(reason, holdMs);
}

function seekVideoSafely(time, reason = 'seek') {
    if (!DOM.player) return;
    const duration = getActiveDuration();
    let target = Number(time) || 0;
    if (duration > 0) {
        const maxSafeTime = Math.max(0, Math.min(duration - 5, duration * 0.985));
        target = Math.max(0, Math.min(maxSafeTime, target));
    }
    const holdMs = String(reason).startsWith('keyboard') ? 1150 : 850;
    markExplicitVideoSeek(reason, holdMs);
    nextSeekTime = null;
    isSeekingJS = false;
    try { DOM.player.currentTime = target; } catch(e) { console.warn('[Seek] failed:', e); }
    if (!DOM.player.paused) {
        setTimeout(() => {
            try { if (DOM.player && !DOM.player.paused) DOM.player.play().catch(()=>{}); } catch(e) {}
            scheduleSidecarResume(reason + '-after-seek', 220);
        }, 120);
    }
    setTimeout(() => {
        isPlayerSeeking = false;
        isSeekingJS = false;
        isSeeking = false;
        scheduleSidecarResume(reason + '-seek-safety', 120);
    }, 1300);
}

async function recoverSidecarAudio(reason = 'watchdog') {
    if (!sidecarAudio || !DOM.player || sidecarRecovering || DOM.player.paused) return false;
    sidecarRecovering = true;
    try {
        console.warn('[Audio Sidecar] recovering:', reason);
        syncSidecarToVideo(true);
        syncSidecarVolumeAndRate(0);
        sidecarAudio.muted = false;
        await sidecarAudio.play();
        sidecarLastObservedTime = sidecarAudio.currentTime || 0;
        sidecarLastAdvancedAt = Date.now();
        return true;
    } catch(e1) {
        try {
            // Fallback for WebView policy weirdness: muted start then immediate unmute.
            sidecarAudio.muted = true;
            await sidecarAudio.play();
            setTimeout(() => { try { if (sidecarAudio) sidecarAudio.muted = false; } catch(e) {} }, 80);
            sidecarLastObservedTime = sidecarAudio.currentTime || 0;
            sidecarLastAdvancedAt = Date.now();
            return true;
        } catch(e2) {
            console.warn('[Audio Sidecar] recovery failed:', e1, e2);
            return false;
        }
    } finally {
        setTimeout(() => { sidecarRecovering = false; }, 350);
    }
}

function watchdogSidecarAudio() {
    if (!sidecarAudio || !DOM.player || DOM.player.paused) return;
    const now = Date.now();
    const at = sidecarAudio.currentTime || 0;
    try { sidecarAudio.muted = false; } catch(e) {}

    if (Date.now() < sidecarHoldUntil) return;

    if (Math.abs(at - sidecarLastObservedTime) > 0.035) {
        sidecarLastObservedTime = at;
        sidecarLastAdvancedAt = now;
    }
    if (!sidecarLastAdvancedAt) sidecarLastAdvancedAt = now;

    if ((sidecarAudio.paused || now - sidecarLastAdvancedAt > 1800) && !sidecarRecovering) {
        recoverSidecarAudio(sidecarAudio.paused ? 'paused-while-video-playing' : 'time-not-advancing');
    }
}

function startSidecarAudio(forceSync = false, reason = 'start') {
    if (!sidecarAudio || !DOM.player || DOM.player.paused) return;
    try {
        if (Date.now() < sidecarHoldUntil) {
            scheduleSidecarResume(reason + '-hold', Math.min(500, sidecarHoldUntil - Date.now() + 80));
            return;
        }
        if (forceSync) syncSidecarToVideo(true);
        syncSidecarVolumeAndRate(0);
        sidecarAudio.muted = false;
        sidecarAudio.play()
            .then(() => {
                try { if (sidecarAudio) sidecarAudio.muted = false; } catch(e) {}
                sidecarLastObservedTime = sidecarAudio ? (sidecarAudio.currentTime || 0) : 0;
                sidecarLastAdvancedAt = Date.now();
            })
            .catch(e => {
                console.warn('[Audio Sidecar] play blocked, recovery path:', e);
                recoverSidecarAudio('play-blocked-' + reason);
            });
    } catch(e) {
        console.warn('[Audio Sidecar] start failed:', e);
    }
}

function pauseSidecarAudio() {
    if (!sidecarAudio) return;
    try { sidecarAudio.pause(); } catch(e) {}
}

function stopExternalAudioSidecar() {
    if (sidecarSyncTimer) {
        clearInterval(sidecarSyncTimer);
        sidecarSyncTimer = null;
    }
    clearTimeout(sidecarResumeTimer);
    sidecarResumeTimer = null;
    if (sidecarAudio) {
        try { sidecarAudio.pause(); } catch(e) {}
        try { sidecarAudio.removeAttribute('src'); sidecarAudio.load(); } catch(e) {}
    }
    sidecarAudio = null;
    sidecarLastHardSync = 0;
    sidecarLastObservedTime = 0;
    sidecarLastAdvancedAt = 0;
    sidecarRecovering = false;
    sidecarHoldUntil = 0;
    activeSidecarUrl = '';
    if (DOM.player) {
        try { DOM.player.muted = false; } catch(e) {}
    }
    setSidecarBadge(false);
}

function configureExternalAudioSidecar(sidecarUrl, label = 'AAC audio') {
    if (!sidecarUrl || !DOM.player) return false;
    if (sidecarAudio && activeSidecarUrl === sidecarUrl) {
        scheduleSidecarResume('same-sidecar-config', 80);
        return true;
    }
    stopExternalAudioSidecar();
    try {
        sidecarAudio = new Audio();
        activeSidecarUrl = sidecarUrl;
        sidecarAudio.preload = 'auto';
        sidecarAudio.autoplay = false;
        sidecarAudio.crossOrigin = 'anonymous';
        sidecarAudio.src = sidecarUrl;
        sidecarAudio.load();
        DOM.player.muted = true; // Embedded DTS/TrueHD remains silent; external AAC carries user volume.
        DOM.player.autoplay = true;
        DOM.player.playsInline = true;
        syncSidecarVolumeAndRate(0);
        sidecarAudio.addEventListener('error', (e) => {
            console.error('[Audio Sidecar] element error:', e);
            showToast('AAC sidecar audio failed to load');
        });
        sidecarAudio.addEventListener('loadedmetadata', () => scheduleSidecarResume('sidecar-loadedmetadata', 80));
        sidecarAudio.addEventListener('canplay', () => scheduleSidecarResume('sidecar-canplay', 80));
        sidecarAudio.addEventListener('playing', () => {
            try { sidecarAudio.muted = false; } catch(e) {}
            sidecarLastObservedTime = sidecarAudio.currentTime || 0;
            sidecarLastAdvancedAt = Date.now();
        });
        sidecarAudio.addEventListener('pause', () => {
            if (DOM.player && !DOM.player.paused && Date.now() >= sidecarHoldUntil) {
                scheduleSidecarResume('sidecar-paused-event', 180);
            }
        });
        sidecarAudio.addEventListener('stalled', () => setTimeout(() => watchdogSidecarAudio(), 250));
        sidecarAudio.addEventListener('waiting', () => setTimeout(() => watchdogSidecarAudio(), 250));
        sidecarSyncTimer = setInterval(() => {
            if (sidecarAudio && DOM.player && !DOM.player.paused) {
                syncSidecarToVideo(false);
                watchdogSidecarAudio();
            }
        }, 500);
        setSidecarBadge(true, label);
        scheduleSidecarResume('configured', 120);
        setTimeout(() => scheduleSidecarResume('configured-retry-1', 700), 700);
        setTimeout(() => scheduleSidecarResume('configured-retry-2', 1600), 1600);
        return true;
    } catch(e) {
        console.error('[Audio Sidecar] configure failed:', e);
        stopExternalAudioSidecar();
        return false;
    }
}

function relinkActiveEpisodeToCompatibleCopy(path, name) {
    try {
        if (!activeLibraryItem || !activeEpisodeNum || !path) return;
        const ep = ensureEpisodeSlot(activeLibraryItem, Number(activeEpisodeNum) || 1);
        const oldPath = ep.path || '';
        ep.path = path;
        ep.name = name || path.split(/[\\/]/).pop() || ep.name || 'Compatible copy';
        ep.audioCompatMode = 'full_proxy';
        ep.compatible_copy = true;
        saveLibrary();
        renderLibraryGrid();
        try { renderHDRezkaEpisodes(); } catch(e) {}
        try { renderDetailsContent(activeLibraryItem, true); } catch(e) {}
        showToast('Library link updated to compatible copy');
        if (oldPath && oldPath !== path && window.pywebview && window.pywebview.api && window.pywebview.api.safe_delete_replaced_media) {
            window.pywebview.api.safe_delete_replaced_media(oldPath, path).then(raw => {
                try {
                    const res = JSON.parse(raw || '{}');
                    if (res.status === 'success') showToast('Old app-managed media deleted');
                    else console.log('[Storage Cleaner] old media not deleted:', res.reason || res.message || res.status);
                } catch(e) {}
            }).catch(() => {});
        }
    } catch(e) {
        console.warn('[Audio Fix] failed to relink active episode:', e);
    }
}

function showAudioFixDialog(info) {
    return new Promise(resolve => {
        const existing = document.getElementById('audio-fix-dialog');
        if (existing) existing.remove();
        const sizeGb = Number(info?.size_gb || 0);
        const primary = info?.analysis?.playback_audio || {};
        const codec = (primary.codec || 'unknown').toUpperCase();
        const vcodec = ((info?.analysis?.video_codecs || [])[0] || 'unknown').toUpperCase();
        const lang = primary.language || 'und';
        const needsVideo = !!info?.analysis?.needs_video_transcode;
        const recommended = needsVideo ? 'video' : (sizeGb > 0 && sizeGb <= 8 ? 'full' : 'sidecar');
        const overlay = document.createElement('div');
        overlay.id = 'audio-fix-dialog';
        overlay.className = 'audio-fix-dialog';
        overlay.innerHTML = `
            <div class="audio-fix-card">
                <div class="audio-fix-head">
                    <div>
                        <div class="audio-fix-kicker">PLAYBACK FIX</div>
                        <div class="audio-fix-title">Media is not WebView-compatible</div>
                    </div>
                    <button class="audio-fix-close" id="audio-fix-close">×</button>
                </div>
                <div class="audio-fix-meta">
                    <span>Video: <b>${vcodec}</b></span>
                    <span>Primary audio: <b>${codec}</b></span>
                    <span>Language: <b>${lang}</b></span>
                    ${sizeGb ? `<span>File: <b>${sizeGb.toFixed(2)} GB</b></span>` : ''}
                </div>
                <div class="audio-fix-note">
                    ${needsVideo ? 'Video codec/container may not start in WebView. Browser MP4 converts video to H.264 and audio to AAC.' : 'Audio codec may not play in WebView. Sidecar is small; Full audio copy is simpler for small files.'}
                </div>
                <div class="audio-fix-actions">
                    <button class="audio-fix-btn ${recommended === 'video' ? 'recommended' : ''}" id="audio-fix-video">
                        <b>Browser MP4</b><small>H.264 + AAC. Fixes spinning HEVC/AV1 video.</small>
                    </button>
                    <button class="audio-fix-btn ${recommended === 'sidecar' ? 'recommended' : ''}" id="audio-fix-sidecar">
                        <b>AAC Sidecar</b><small>Small cache. Fixes audio only.</small>
                    </button>
                    <button class="audio-fix-btn ${recommended === 'full' ? 'recommended' : ''}" id="audio-fix-full">
                        <b>Full audio copy</b><small>Video copy + AAC. Needs ~${sizeGb ? sizeGb.toFixed(2) : '?'} GB.</small>
                    </button>
                    <button class="audio-fix-btn ghost" id="audio-fix-original">
                        <b>No fix</b><small>Try original file as-is</small>
                    </button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const done = (v) => { overlay.remove(); resolve(v); };
        document.getElementById('audio-fix-video').onclick = () => done('video');
        document.getElementById('audio-fix-sidecar').onclick = () => done('sidecar');
        document.getElementById('audio-fix-full').onclick = () => done('full');
        document.getElementById('audio-fix-original').onclick = () => done('original');
        document.getElementById('audio-fix-close').onclick = () => done('cancel');
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } });
        overlay.tabIndex = -1;
        overlay.focus();
    });
}

async function applyCachedPlaybackFixIfAny(track) {
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.check_playback_fixes)) return { handled: false, info: null };
    try {
        const raw = await window.pywebview.api.check_playback_fixes(track.path);
        const info = JSON.parse(raw || '{}');
        if (info.status !== 'success') return { handled: false, info };
        if (!info.needs_fix) {
            track.audioCompatMode = 'direct';
            return { handled: true, info };
        }
        if (info.video_proxy && info.video_proxy.ready && info.video_proxy.path) {
            track.path = info.video_proxy.path;
            track.url = `${window.location.origin}/media?path=${encodeURIComponent(track.path)}`;
            track.audioCompatMode = 'video_proxy';
            relinkActiveEpisodeToCompatibleCopy(track.path, track.path.split(/[\\/]/).pop());
            savePlaylistPermanently();
            return { handled: true, info };
        }
        if (info.full_proxy && info.full_proxy.ready && info.full_proxy.path) {
            track.path = info.full_proxy.path;
            track.url = `${window.location.origin}/media?path=${encodeURIComponent(track.path)}`;
            track.audioCompatMode = 'full_proxy';
            relinkActiveEpisodeToCompatibleCopy(track.path, track.path.split(/[\\/]/).pop());
            savePlaylistPermanently();
            return { handled: true, info };
        }
        if (info.sidecar && info.sidecar.ready && info.sidecar.path) {
            track.audioSidecarPath = info.sidecar.path;
            track.audioSidecarUrl = `${window.location.origin}/media?path=${encodeURIComponent(info.sidecar.path)}`;
            track.audioCompatMode = 'audio_sidecar';
            configureExternalAudioSidecar(track.audioSidecarUrl, 'AAC audio');
            savePlaylistPermanently();
            return { handled: true, info };
        }
        return { handled: false, info };
    } catch(e) {
        console.warn('[Audio Fix] cached check failed:', e);
        return { handled: false, info: null };
    }
}


/* Flash Minimal Central HUD Overlay */
let hudTimeout;
function flashHUD(htmlContent) {
    if (DOM.hudContent && DOM.hudOverlay) {
        clearTimeout(hudTimeout);
        DOM.hudContent.innerHTML = htmlContent;
        DOM.hudOverlay.classList.add('active');
        
        hudTimeout = setTimeout(() => {
            DOM.hudOverlay.classList.remove('active');
        }, 600);
    }
}

/* 
   Update Slider Progress background dynamically!
   This uses a pure, native CSS linear-gradient background on the range input track.
   Completely eliminates layered offset progress DIVs, fixing the vertical drift bug permanently!
*/
function updateSliderProgress(slider, val) {
    if (!slider) return;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const percentage = ((val - min) / (max - min)) * 100;
    slider.style.background = `linear-gradient(to right, #ffffff 0%, #ffffff ${percentage}%, rgba(255, 255, 255, 0.08) ${percentage}%, rgba(255, 255, 255, 0.08) 100%)`;
}

/* 
   ★ BULLETPROOF DURATION RESOLVER:
   Returns either our Python PTS-calculated duration (if available) or falls back
   natively to the browser video element's reported duration.
   Guarantees seeking and timers work 100% of the time, on all files!
*/
function getActiveDuration() {
    if (activeDuration && activeDuration > 0) {
        return activeDuration;
    }
    if (DOM.player && DOM.player.duration && isFinite(DOM.player.duration) && DOM.player.duration > 0) {
        return DOM.player.duration;
    }
    return 0;
}

/* Initialize Custom Sliders */
function initSliders() {
    if (DOM.volumeSlider) {
        DOM.volumeSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (DOM.player) DOM.player.volume = val / 100;
            updateSliderProgress(DOM.volumeSlider, val);
            updateVolumeUI(DOM.player ? DOM.player.volume : 0);
        });
        updateSliderProgress(DOM.volumeSlider, parseFloat(DOM.volumeSlider.value));
    }

    // ★ ZERO-LAG TIMELINE CONTROL WITH DEFERRED SEEKING & REAL-TIME ESTIMATIONS!
    if (DOM.seekbar) {
        // 1. Lock timeupdate updates when slider is dragged/clicked
        bindEvent(DOM.seekbar, 'mousedown', () => { isSeeking = true; });
        bindEvent(DOM.seekbar, 'touchstart', () => { isSeeking = true; });

        let lastSeekTime = 0;
        let seekTimeout = null;

        // Safe serialized seek dispatcher
        function safeSeekTo(time) {
            if (!DOM.player) return;
            seekVideoSafely(time, 'timeline-seek');
        }

        // 2. Continuous real-time seeking as the user drags (completely lag-free!)
        bindEvent(DOM.seekbar, 'input', (e) => {
            const duration = getActiveDuration();
            if (!duration) return;
            const val = parseFloat(e.target.value);
            
            // ★ BULLETPROOF EOF PROTECTION:
            // Clamp targetTime to max 98.5% of estimated duration or duration - 5 seconds.
            // This prevents requesting bytes beyond the file length, solving 100% of player freezes at the end!
            const maxSafeTime = Math.max(0, Math.min(duration - 5, duration * 0.985));
            const rawTargetTime = (val / 100) * duration;
            const targetTime = Math.min(maxSafeTime, rawTargetTime);
            
            // Instantly update timer and slider progress in UI (60 FPS)
            if (DOM.currentTimeLabel) DOM.currentTimeLabel.textContent = formatTime(targetTime);
            updateSliderProgress(DOM.seekbar, val);
            
            // Throttle actual video element seeks to at most once every 120ms to prevent connection exhaustion!
            const now = Date.now();
            if (now - lastSeekTime >= 120) {
                safeSeekTo(targetTime);
                lastSeekTime = now;
            } else {
                // Set a timeout to capture the last frame when they stop dragging or drag slowly
                clearTimeout(seekTimeout);
                seekTimeout = setTimeout(() => {
                    safeSeekTo(targetTime);
                    lastSeekTime = Date.now();
                }, 120);
            }
        });

        // 3. Ensure the final exact frame is loaded when dragging stops
        bindEvent(DOM.seekbar, 'change', (e) => {
            const duration = getActiveDuration();
            if (!duration) return;
            const val = parseFloat(e.target.value);
            
            const maxSafeTime = Math.max(0, Math.min(duration - 5, duration * 0.985));
            const rawTargetTime = (val / 100) * duration;
            const targetTime = Math.min(maxSafeTime, rawTargetTime);
            
            clearTimeout(seekTimeout); // Clear any pending seek timeouts
            safeSeekTo(targetTime);
        });

        // 4. Precise pixel-perfect clicking on the seekbar track itself!
        // Overrides default browser padding to click exactly near the edges!
        const handleSeekbarClick = (e) => {
            const rect = DOM.seekbar.getBoundingClientRect();
            let pct = (e.clientX - rect.left) / rect.width;
            pct = Math.max(0, Math.min(1, pct));
            
            const duration = getActiveDuration();
            if (!duration) return;
            
            const maxSafeTime = Math.max(0, Math.min(duration - 5, duration * 0.985));
            const rawTargetTime = pct * duration;
            const targetTime = Math.min(maxSafeTime, rawTargetTime);
            
            DOM.seekbar.value = pct * 100;
            updateSliderProgress(DOM.seekbar, pct * 100);
            
            safeSeekTo(targetTime);
            if (DOM.currentTimeLabel) {
                DOM.currentTimeLabel.textContent = formatTime(targetTime);
            }
        };
        bindEvent(DOM.seekbar, 'click', handleSeekbarClick);

        // 5. Precise seekbar hover tooltip (MPV/IINA style)
        const tooltip = document.getElementById('seekbar-tooltip');
        bindEvent(DOM.seekbar, 'mousemove', (e) => {
            const rect = DOM.seekbar.getBoundingClientRect();
            let pct = (e.clientX - rect.left) / rect.width;
            pct = Math.max(0, Math.min(1, pct));
            
            const duration = getActiveDuration();
            if (duration > 0) {
                const hoverTime = pct * duration;
                if (tooltip) {
                    tooltip.textContent = formatTime(hoverTime);
                    // Defensive clamping between 3% and 97% to prevent tooltip edge clipping!
                    const clampedLeft = Math.max(3, Math.min(97, pct * 100));
                    tooltip.style.left = `${clampedLeft}%`;
                }
            }
        });
    }

    /* 
       🚨 GLOBAL DRAG RELEASE FIX:
       Guarantees isSeeking is ALWAYS set back to false on mouseup anywhere on the screen!
       Adaptive Lock: If the video player is currently seeking, we let the 'seeked' event
       reset isSeeking to guarantee a 100% smooth, snap-back-free transition.
       Otherwise, we reset isSeeking immediately, with a safety fallback timeout.
    */
    window.addEventListener('mouseup', () => {
        if (isSeeking) {
            if (DOM.player && !DOM.player.seeking && !isPlayerSeeking) {
                isSeeking = false;
            } else {
                // Seek in progress, let seeked event handle it. Safety fallback: 1.2 seconds
                setTimeout(() => {
                    isSeeking = false;
                }, 1200);
            }
        }
    });
    window.addEventListener('touchend', () => {
        if (isSeeking) {
            if (DOM.player && !DOM.player.seeking && !isPlayerSeeking) {
                isSeeking = false;
            } else {
                setTimeout(() => {
                    isSeeking = false;
                }, 1200);
            }
        }
    });
}

/* Update Volume UI elements */
function updateVolumeUI(volume) {
    if (DOM.volumeSlider) {
        if (volume === 0) {
            if (DOM.volumeHighIcon) DOM.volumeHighIcon.classList.add('hidden');
            if (DOM.volumeMutedIcon) DOM.volumeMutedIcon.classList.remove('hidden');
        } else {
            if (DOM.volumeHighIcon) DOM.volumeHighIcon.classList.remove('hidden');
            if (DOM.volumeMutedIcon) DOM.volumeMutedIcon.classList.add('hidden');
        }
        const val = volume * 100;
        DOM.volumeSlider.value = val;
        updateSliderProgress(DOM.volumeSlider, val);
    }
}

/* Toggle Playback state */
function togglePlay() {
    if (playlist.length === 0) {
        openFileDialog();
        return;
    }
    
    if (!isVideoMode || settings.audioBoost > 100) {
        initAudioContext();
    }
    
    if (DOM.player) {
        if (DOM.player.paused) {
            DOM.player.play().then(() => scheduleSidecarResume('manual-play', 80)).catch(e => console.log("Playback blocked: ", e));
            flashHUD(`
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            `);
        } else {
            DOM.player.pause();
            flashHUD(`
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
            `);
        }
    }
}

/* Aspect Ratio Toggler (Cycles between contain, cover, fill) */
function toggleAspectRatio() {
    if (!DOM.player) return;
    
    const states = ['contain', 'cover', 'fill'];
    let idx = states.indexOf(settings.aspectRatio);
    idx = (idx + 1) % states.length;
    settings.aspectRatio = states[idx];
    
    DOM.player.style.objectFit = settings.aspectRatio;
    
    flashHUD(`<span>Aspect: ${settings.aspectRatio.toUpperCase()}</span>`);
    showToast(`Aspect ratio set to: ${settings.aspectRatio}`);
}

function getActiveSkipMarkers() {
    const itemMarkers = activeLibraryItem && activeLibraryItem.skipMarkers ? activeLibraryItem.skipMarkers : {};
    const epMarkers = itemMarkers && activeEpisodeNum ? itemMarkers[String(activeEpisodeNum)] : null;
    const introStart = Number(epMarkers?.introStart ?? itemMarkers.introStart ?? settings.introStart ?? 0);
    const introEnd = Number(epMarkers?.introEnd ?? itemMarkers.introEnd ?? settings.introEnd ?? settings.introDuration ?? 85);
    const outroStartOffset = Number(epMarkers?.outroStartOffset ?? itemMarkers.outroStartOffset ?? settings.outroStartOffset ?? 120);
    const outroSkipToEndOffset = Number(epMarkers?.outroSkipToEndOffset ?? itemMarkers.outroSkipToEndOffset ?? settings.outroSkipToEndOffset ?? 5);
    return {
        introStart: Math.max(0, introStart),
        introEnd: Math.max(introStart + 1, introEnd),
        outroStartOffset: Math.max(5, outroStartOffset),
        outroSkipToEndOffset: Math.max(1, outroSkipToEndOffset)
    };
}

/* Premium Dismissable Skip Pill (Intro & Outro) Controller */
function updateSkipIntroVisibility() {
    if (!DOM.player || !DOM.skipIntroBtn) return;
    
    const currentTime = DOM.player.currentTime;
    const duration = getActiveDuration();
    const markers = getActiveSkipMarkers();
    
    // If user dismissed the overlay, keep it completely hidden for the current track
    if (isSkipDismissed || duration <= 0) {
        DOM.skipIntroBtn.classList.add('hidden');
        return;
    }
    
    // Cold-open aware: the intro button appears only inside the actual opening range.
    const isIntroActive = isVideoMode && currentTime >= markers.introStart && currentTime < markers.introEnd;
    
    // Outro range: configurable; starts before the end, vanishes just before the end.
    const outroStartTime = duration - markers.outroStartOffset;
    const isOutroActive = isVideoMode && currentTime >= outroStartTime && currentTime < (duration - markers.outroSkipToEndOffset);
    
    const skipText = document.getElementById('skip-text');
    
    if (isIntroActive) {
        if (skipText) skipText.textContent = "Skip Intro";
        DOM.skipIntroBtn.classList.remove('hidden');
    } else if (isOutroActive) {
        if (skipText) skipText.textContent = "Skip Outro";
        DOM.skipIntroBtn.classList.remove('hidden');
    } else {
        DOM.skipIntroBtn.classList.add('hidden');
    }
}

// Bind native player element events defensively (Executing inside DOMContentLoaded only!)
function bindPlayerEvents() {
    if (!DOM.player) return;

    // Capture F11, KeyF, Space hotkeys even if the video element has direct focus!
    DOM.player.addEventListener('keydown', (e) => {
        if (e.code === 'F11' || e.code === 'KeyF') {
            e.preventDefault();
            e.stopPropagation();
            toggleFullscreen();
        } else if (e.code === 'Space') {
            e.preventDefault();
            e.stopPropagation();
            togglePlay();
        }
    });

    DOM.player.addEventListener('seeking', () => {
        isPlayerSeeking = true;
        if (sidecarAudio) holdSidecarAudio('video-seeking', 900);
    });

    // Symmetrical self-healing player error recovery driver!
    DOM.player.addEventListener('error', (e) => {
        // Only trigger error handling if a track is actively loaded to prevent infinite recursion loop on empty src reset!
        if (playlist.length > 0 && currentIndex !== -1 && DOM.player && DOM.player.src && DOM.player.src !== "" && DOM.player.src !== window.location.href) {
            console.error("[Player Engine] Video element threw a playback error:", e);
            const activeTrack = playlist[currentIndex] || {};
            const activePath = String(activeTrack.path || '');
            if (activePath.includes('audio_proxy_')) {
                showToast('Old broken AAC proxy detected. Remove this playlist item and open the original MKV again.');
            } else if (activeTrack.audioSidecarPath || activeTrack.audioCompatMode === 'audio_sidecar') {
                showToast('Video failed, but AAC sidecar exists. Reopen the original MKV, not an old proxy file.');
            } else {
                showToast("Error: Media file is corrupted, blocked, or unsupported.");
            }
            resetPlayerToEmpty();
        }
    });

    DOM.player.addEventListener('seeked', () => {
        isPlayerSeeking = false;
        pushWatchTogetherNow('seeked', 0);
        scheduleSidecarResume('video-seeked', 180);
        setTimeout(() => scheduleSidecarResume('video-seeked-retry', 900), 900);
        
        nextSeekTime = null;
        isSeekingJS = false;
        isSeeking = false;
    });

    DOM.player.addEventListener('play', () => {
        pushWatchTogetherNow('play', 0);
        startSidecarAudio();
        if (DOM.playIcon) DOM.playIcon.classList.add('hidden');
        if (DOM.pauseIcon) DOM.pauseIcon.classList.remove('hidden');
        document.body.classList.add('playing');
        updatePlaylistActiveItemState();
        
        // Synchronously check and show skip button on playback start
        updateSkipIntroVisibility();
        
        // Show controls card only when play starts
        if (DOM.controlsCard) DOM.controlsCard.classList.add('active');
        
        // Resume visualizer draw loop if in audio mode
        if (!isVideoMode && isAudioPipelineInitialized) {
            startVisualizerLoop();
        }
    });

    DOM.player.addEventListener('pause', () => {
        pushWatchTogetherNow('pause', 0);
        pauseSidecarAudio();
        if (DOM.playIcon) DOM.playIcon.classList.remove('hidden');
        if (DOM.pauseIcon) DOM.pauseIcon.classList.add('hidden');
        document.body.classList.remove('playing');
        updatePlaylistActiveItemState();
        
        // Stop visualizer animation frame draw loop when paused to save 100% CPU!
        stopVisualizerLoop();
    });

    DOM.player.addEventListener('ended', () => {
        pauseSidecarAudio();
        // ★ NEXT EPISODE COUNTDOWN INTEGRATION:
        if (activeLibraryItem && activeEpisodeNum) {
            const nextEpNum = activeEpisodeNum + 1;
            const nextEp = activeLibraryItem.episodes.find(e => e.num === nextEpNum && e.path);
            if (nextEp) {
                triggerNextEpisodeCountdown(nextEp);
                return;
            }
        }
        playNext();
    });

    DOM.player.addEventListener('waiting', () => {
        // Do not pause sidecar on every tiny WebView buffering event; it caused permanent silence.
        if (sidecarAudio) setTimeout(() => watchdogSidecarAudio(), 250);
    });

    DOM.player.addEventListener('stalled', () => {
        if (sidecarAudio) setTimeout(() => watchdogSidecarAudio(), 250);
    });

    DOM.player.addEventListener('playing', () => {
        scheduleSidecarResume('video-playing', 80);
    });

    DOM.player.addEventListener('canplay', () => {
        scheduleSidecarResume('video-canplay', 120);
    });

    DOM.player.addEventListener('volumechange', () => {
        syncSidecarVolumeAndRate();
    });

    DOM.player.addEventListener('ratechange', () => {
        syncSidecarVolumeAndRate();
        syncSidecarToVideo(false);
    });

    DOM.player.addEventListener('timeupdate', () => {
        if (!DOM.player) return;
        pushWatchTogetherNow('timeupdate', 900);
        
        // Smart Watching Guard telemetry runs on every tick, not only on save intervals.
        if (activeLibraryItem && activeEpisodeNum) {
            updateWatchSessionTelemetry(DOM.player.currentTime);
        }

        // Sidecar self-heal on normal video ticks. If video is moving but audio was held/paused, restart it.
        if (sidecarAudio && !DOM.player.paused && Date.now() >= sidecarHoldUntil && sidecarAudio.paused) {
            scheduleSidecarResume('timeupdate-audio-paused', 80);
        }

        // Fallback duration polling for .TS files natively from mpegtsPlayer
        if (playlist[currentIndex] && playlist[currentIndex].isTS && mpegtsPlayer && activeDuration <= 0) {
            const mpegtsDur = mpegtsPlayer.duration;
            if (mpegtsDur && isFinite(mpegtsDur) && mpegtsDur > 0) {
                activeDuration = mpegtsDur;
                console.log(`[mpegts.js] Polled duration natively: ${activeDuration}s`);
            }
        }

        // Dynamic duration growth: if current playback goes beyond our estimated duration,
        // dynamically grow the duration state so that the timeline never clips or locks up!
        if (DOM.player.currentTime > activeDuration) {
            activeDuration = DOM.player.currentTime + 30; // Grow by 30 seconds
        }

        // Update Subtitles Display in sync!
        updateSubtitlesDisplay();

        // Save playback position every 5 seconds if playing a library episode!
        if (activeLibraryItem && activeEpisodeNum) {
            const now = Date.now();
            if (now - lastSaveTime >= 5000) {
                const duration = getActiveDuration();
                const resumeInfo = {
                    epNum: activeEpisodeNum,
                    time: DOM.player.currentTime
                };
                localStorage.setItem('resume_info_' + activeLibraryItem.id, JSON.stringify(resumeInfo));
                
                        // Automatically save watching progress and history entries!
                saveWatchingProgress(activeLibraryItem, activeEpisodeNum, DOM.player.currentTime, duration);
                saveViewingHistory(activeLibraryItem, activeEpisodeNum, DOM.player.currentTime);
                
                lastSaveTime = now;
            }
        }

        const duration = getActiveDuration();
        const hasDuration = duration > 0;
        
        // ★ REAL-TIME TIMELINE UPDATE:
        // Only update seekbar value and progress background if the user is NOT currently dragging it,
        // AND the player is NOT actively seeking! This completely prevents any snap-backs!
        if (!isSeeking && !isPlayerSeeking && !DOM.player.seeking && DOM.seekbar) {
            if (hasDuration) {
                const progressPercent = (DOM.player.currentTime / duration) * 100;
                DOM.seekbar.value = progressPercent;
                updateSliderProgress(DOM.seekbar, progressPercent);
            } else {
                DOM.seekbar.value = 0;
                updateSliderProgress(DOM.seekbar, 0);
            }
        }

        // 2. GUARANTEED WORKING TIMERS (Never freezes at 00:00)
        if (!isSeeking) {
            if (DOM.currentTimeLabel) {
                DOM.currentTimeLabel.textContent = formatTime(DOM.player.currentTime);
            }
            
            if (hasDuration) {
                if (DOM.totalDurationLabel) {
                    DOM.totalDurationLabel.textContent = formatTime(duration);
                }
            } else {
                if (DOM.totalDurationLabel) {
                    DOM.totalDurationLabel.textContent = "--:--"; 
                }
            }
        }

        // 3. Smart Skip Intro Button visibility (appears synchronously and vanishes instantly!)
        updateSkipIntroVisibility();
    });

    DOM.player.addEventListener('loadedmetadata', () => {
        if (!DOM.player) return;
        
        // Symmetrically render bookmarks on timeline on load!
        renderBookmarksOnTimeline();
        
        // Reset skip dismissed state for the newly loaded track
        isSkipDismissed = false;
        
        // Clear any active next episode countdown overlays on track change
        const overlay = document.getElementById('next-episode-overlay');
        if (overlay) overlay.classList.add('hidden');
        clearInterval(countdownInterval);
        
        // Sync activeDuration from browser native source ONLY if it is not a TS file
        const isTS = playlist[currentIndex] && playlist[currentIndex].isTS;
        if (!isTS) {
            const duration = DOM.player.duration;
            if (duration && isFinite(duration) && duration > 0) {
                activeDuration = duration;
            }
        }

        const duration = getActiveDuration();
        const hasDuration = duration > 0;
        if (DOM.totalDurationLabel) {
            DOM.totalDurationLabel.textContent = hasDuration ? formatTime(duration) : "--:--";
        }

        // Synchronously check and show skip button on metadata load
        updateSkipIntroVisibility();

        if (!isSeeking && DOM.seekbar) {
            DOM.seekbar.value = 0;
            updateSliderProgress(DOM.seekbar, 0);
        }
    });
}



/* Destroy current mpegts.js instance safely */
function destroyMpegts() {
    if (mpegtsPlayer) {
        try {
            mpegtsPlayer.unload();
            mpegtsPlayer.detachMediaElement();
            mpegtsPlayer.destroy();
        } catch (e) {
            console.error("Error destroying mpegts.js:", e);
        }
        mpegtsPlayer = null;
    }
}

/* Playlist operations */
async function addFilesToPlaylist(files) {
    const origin = window.location.origin;
    const initialCount = playlist.length;
    
    // We use a for-of loop so we can await each file processing synchronously
    for (const file of files) {
        let path = file.path || '';
        let name = file.name;
        
        // ★ AUTOMATIC ON-THE-FLY REMUXING INTEGRATION:
        // If it's a TS file and we have PyWebView API, remux it to MP4 in 0.5s with zero quality loss!
        if (window.pywebview && window.pywebview.api && path && path.toLowerCase().endsWith('.ts')) {
            showToast("Remuxing TS to MP4 for flawless seeking...");
            try {
                const res = await window.pywebview.api.process_file(path, name);
                if (res && res.path) {
                    path = res.path;
                    name = res.name;
                    if (res.is_remuxed) {
                        showToast("TS successfully remuxed to MP4!");
                    }
                }
            } catch (err) {
                console.error("Error during remuxing:", err);
            }
        }
        
        let url;
        if (path) {
            url = `${origin}/media?path=${encodeURIComponent(path)}`;
        } else if (file.blobUrl) {
            url = file.blobUrl;
        } else {
            continue;
        }
        
        const fileInfo = getFileTypeInfo(name);
        
        if (!playlist.some(item => item.path === path && item.url === url)) {
            playlist.push({
                name: name,
                path: path,
                url: url,
                isVideo: fileInfo.isVideo,
                isTS: fileInfo.isTS,
                size: file.size || 0
            });
            
            // ★ SMART FILE MATCHING:
            // Automatically try to match and link this loaded file to an added library episode in the background!
            tryAutoLinkLoadedFile(name, path);
        }
    }

    renderPlaylist();
    savePlaylistPermanently();
    if (playlist.length > 0) {
        showToast(`Added ${playlist.length - initialCount} files to playlist`);
        
        // Symmetrical: Automatically switch to player view on load!
        const loadBtn = document.getElementById('tab-load-btn');
        if (loadBtn) loadBtn.click();
        
        if (currentIndex === -1 || currentIndex >= playlist.length - files.length) {
            playTrack(playlist.length - files.length);
        }
    }
}

function renderPlaylist() {
    if (!DOM.playlistCountLabel || !DOM.playlistItemsContainer) return;
    
    DOM.playlistCountLabel.textContent = playlist.length;
    
    if (playlist.length === 0) {
        DOM.playlistItemsContainer.innerHTML = `
            <div class="empty-playlist">
                <p>Playlist is empty</p>
                <button id="add-first-btn" class="action-btn">Add Files</button>
            </div>
        `;
        const addFirstBtn = document.getElementById('add-first-btn');
        if (addFirstBtn) addFirstBtn.addEventListener('click', openFileDialog);
        currentIndex = -1;
        resetPlayerToEmpty();
        return;
    }
    
    DOM.playlistItemsContainer.innerHTML = '';
    playlist.forEach((track, idx) => {
        const item = document.createElement('div');
        item.className = `playlist-item ${idx === currentIndex ? 'active' : ''} ${idx === currentIndex && DOM.player && !DOM.player.paused ? 'playing-state' : ''}`;
        item.setAttribute('data-index', idx);
        
        item.innerHTML = `
            <div class="item-index-indicator">
                <span class="item-index">${idx + 1}</span>
                <div class="playing-bars">
                    <div class="bar"></div>
                    <div class="bar"></div>
                    <div class="bar"></div>
                </div>
            </div>
            <div class="item-details">
                <div class="item-title" title="${track.name}">${track.name}</div>
            </div>
            <button class="item-remove" title="Remove">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>
        `;
        
        item.addEventListener('click', (e) => {
            if (e.target.closest('.item-remove')) {
                e.stopPropagation();
                removeTrack(idx);
            } else {
                playTrack(idx);
            }
        });
        
        DOM.playlistItemsContainer.appendChild(item);
    });
}

function updatePlaylistActiveItemState() {
    if (!DOM.playlistItemsContainer) return;
    const items = DOM.playlistItemsContainer.querySelectorAll('.playlist-item');
    items.forEach((item, idx) => {
        if (idx === currentIndex) {
            item.classList.add('active');
            if (DOM.player && !DOM.player.paused) {
                item.classList.add('playing-state');
            } else {
                item.classList.remove('playing-state');
            }
        } else {
            item.classList.remove('active', 'playing-state');
        }
    });
}

function removeTrack(index) {
    playlist.splice(index, 1);
    
    if (playlist.length === 0) {
        currentIndex = -1;
        renderPlaylist();
    } else if (index === currentIndex) {
        currentIndex = Math.min(index, playlist.length - 1);
        playTrack(currentIndex);
        savePlaylistPermanently();
    } else {
        if (index < currentIndex) {
            currentIndex--;
        }
        renderPlaylist();
    }
}

function resetPlayerToEmpty() {
    // Full teardown: prevents external AAC sidecar from continuing after Back/Library/navigation.
    stopExternalAudioSidecar();
    destroyMpegts();
    if (DOM.player) {
        try { DOM.player.pause(); } catch(e) {}
        try {
            DOM.player.src = "";
            DOM.player.removeAttribute('src');
            DOM.player.load();
        } catch(e) {}
    }
    if (DOM.trackTitle) DOM.trackTitle.textContent = "Minimalist Player Pro";
    if (DOM.trackArtist) DOM.trackArtist.textContent = "Open a media file or drag & drop it here to begin";
    document.body.classList.remove('playing');
    document.body.classList.remove('player-has-video'); // Clear video state!
    if (DOM.playIcon) DOM.playIcon.classList.remove('hidden');
    if (DOM.pauseIcon) DOM.pauseIcon.classList.add('hidden');
    if (DOM.seekbar) {
        DOM.seekbar.value = 0;
        updateSliderProgress(DOM.seekbar, 0);
    }
    if (DOM.currentTimeLabel) DOM.currentTimeLabel.textContent = "00:00";
    if (DOM.totalDurationLabel) DOM.totalDurationLabel.textContent = "00:00";
    
    activeDuration = 0; // Reset state
    
    // Show splash screen home container again!
    if (DOM.audioUI) DOM.audioUI.classList.remove('hidden');
    
    // Hide controls panel on reset / empty
    if (DOM.controlsCard) DOM.controlsCard.classList.remove('active');
    stopVisualizerLoop();
}

function primeNativeVideoForImmediateStart(track) {
    if (!DOM.player || !track || track.isTS || !track.isVideo || !track.url) return false;
    try {
        DOM.player.muted = true; // temporary: if audio is direct-compatible, playNativeVideoWithRetry will unmute later.
        DOM.player.autoplay = true;
        DOM.player.playsInline = true;
        if (!DOM.player.src || DOM.player.src !== track.url) {
            DOM.player.src = track.url;
            DOM.player.load();
        }
        DOM.player.play()
            .then(() => {
                if (DOM.controlsCard) DOM.controlsCard.classList.add('active');
                document.body.classList.add('playing');
            })
            .catch(e => console.warn('[Playback] immediate muted prime failed:', e));
        return true;
    } catch(e) {
        console.warn('[Playback] prime failed:', e);
        return false;
    }
}

async function playNativeVideoWithRetry(track) {
    if (!DOM.player || !track) return;
    const usesSidecar = !!(track.audioSidecarUrl || track.audioSidecarPath || track.audioCompatMode === 'audio_sidecar');
    if (usesSidecar) {
        // Must be muted before src/play. This keeps WebView autoplay policy from blocking first launch after async sidecar check.
        try { DOM.player.muted = true; DOM.player.autoplay = true; DOM.player.playsInline = true; } catch(e) {}
    }
    const alreadyLoaded = DOM.player.src === track.url;
    if (!alreadyLoaded) {
        DOM.player.src = track.url;
        try { DOM.player.load(); } catch(e) {}
    }
    if (!usesSidecar) {
        try { DOM.player.muted = false; } catch(e) {}
    }

    let playStarted = false;
    let attempts = 0;
    const tryPlay = async (tag) => {
        if (playStarted || attempts >= 4) return playStarted;
        attempts++;
        try {
            if (usesSidecar) {
                try { DOM.player.muted = true; } catch(e) {}
            }
            await DOM.player.play();
            playStarted = true;
            showToast(`Playing: ${track.name}`);
            if (DOM.controlsCard) DOM.controlsCard.classList.add('active');
            if (usesSidecar) {
                startSidecarAudio(true, 'video-play-success');
                setTimeout(() => startSidecarAudio(true, 'video-play-retry-1'), 600);
                setTimeout(() => startSidecarAudio(true, 'video-play-retry-2'), 1800);
            }
            return true;
        } catch (err) {
            console.warn(`[Playback] play() failed at ${tag}:`, err);
            return false;
        }
    };

    if (await tryPlay('immediate')) return;

    // Heavy MKV/WebView sometimes refuses the first play while metadata is still settling.
    // Retry on actual readiness events and timers; user should not need to enter Library twice.
    const onReady = () => tryPlay('media-ready').then(ok => {
        if (!ok && attempts >= 4) showToast('Playback needs one click; press Play');
    });
    DOM.player.addEventListener('canplay', onReady, { once: true });
    DOM.player.addEventListener('loadeddata', onReady, { once: true });
    setTimeout(() => tryPlay('delayed-900'), 900);
    setTimeout(() => tryPlay('delayed-2200').then(ok => {
        if (!ok && !playStarted) showToast('Playback needs one click; press Play');
    }), 2200);
}


/* Play specific track index */
async function playTrack(index) {
    if (index < 0 || index >= playlist.length || !DOM.player) return;
    
    currentIndex = index;
    savePlaylistPermanently();
    const track = playlist[currentIndex];
    
    // Explicit hardware decoder and buffer cleaning to prevent GPU lockups on rapid clicks!
    stopExternalAudioSidecar();
    if (DOM.player) {
        try {
            DOM.player.pause();
            DOM.player.src = "";
            DOM.player.removeAttribute('src');
            DOM.player.load();
        } catch(e) {}
    }
    
    destroyMpegts();
    stopVisualizerLoop(); // Stop any active visualizer frames
    
    isVideoMode = track.isVideo;
    activeDuration = 0; // Reset duration state
    isSkipDismissed = false; // Reset skip dismissed state!
    
    document.body.classList.add('player-has-video'); // Set video state!
    if (isVideoMode) {
        if (DOM.audioUI) DOM.audioUI.classList.add('hidden');
    } else {
        if (DOM.audioUI) DOM.audioUI.classList.remove('hidden');
        const cleanName = track.name.substring(0, track.name.lastIndexOf('.')) || track.name;
        if (DOM.trackTitle) DOM.trackTitle.textContent = cleanName;
        if (DOM.trackArtist) DOM.trackArtist.textContent = "Audio File";
        setTimeout(resizeCanvas, 50);
    }
    
    if (!isVideoMode || settings.audioBoost > 100) {
        initAudioContext();
    }

    // Start heavy local MKV immediately while the async codec/cache check runs.
    // Otherwise WebView can lose the original click activation and require a second Library entry.
    let nativePlaybackPrimed = false;
    if (!track.isTS && track.isVideo && track.path) {
        nativePlaybackPrimed = primeNativeVideoForImmediateStart(track);
    }
    
    // ═══════════════════════════════════════════════════════
    //  ⚡ REAL-TIME DURATION INJECTION SCANNER
    //  Queries Python's custom PTS binary scanner to fetch the real duration of .ts files on-the-fly!
    // ═══════════════════════════════════════════════════════
    let fileDuration = 0;
    if (window.pywebview && window.pywebview.api && track.path) {
        try {
            fileDuration = await window.pywebview.api.get_file_duration(track.path);
            console.log(`[PTS Parser] Retrieved physical duration: ${fileDuration} seconds`);
        } catch(e) {
            console.warn("Could not retrieve TS duration from Python API", e);
        }
    }
    
    // JS Size estimation fallback if Python is unavailable or fails (important for sandboxed Drag & Drop files!)
    if (fileDuration <= 0 && track.size && track.size > 0) {
        fileDuration = track.size / 200000.0; // ~1.6 Mbps average (matches HDRezka standard HLS streams perfectly!)
        console.log(`[JS Estimator] Estimated duration from file size (${track.size} bytes): ${fileDuration}s`);
    }
    
    if (fileDuration > 0) {
        activeDuration = fileDuration; // Set our custom activeDuration state directly!
    }

    // Browser audio compatibility: DTS-HD/TrueHD/FLAC/etc. can show picture but no sound in WebView/Windows.
    // Fix without duplicating huge movies: backend creates ONLY a small AAC/M4A audio sidecar.
    // Frontend plays original video muted + synced external AAC audio.
    if (!track.isTS && track.path) {
        if (track.audioSidecarPath && !track.audioSidecarUrl) {
            track.audioSidecarUrl = `${window.location.origin}/media?path=${encodeURIComponent(track.audioSidecarPath)}`;
        }
        if (track.audioSidecarUrl) {
            configureExternalAudioSidecar(track.audioSidecarUrl, 'AAC audio');
        } else if (window.pywebview && window.pywebview.api && window.pywebview.api.prepare_media_for_playback) {
            track.audioCompatChecked = true;
            track.audioProxyChecked = true; // legacy flag kept so old playlists do not break
            try {
                // 1) First check existing cached fixes. If a full compatible copy/sidecar exists, use it silently.
                const cached = await applyCachedPlaybackFixIfAny(track);
                let prep = null;
                if (cached.handled) {
                    prep = { status: 'ready', mode: track.audioCompatMode || 'direct', path: track.path };
                } else {
                    const info = cached.info;
                    if (!info || info.status !== 'success') {
                        // Fallback to backend prepare if cache check failed.
                        const prepRaw = await window.pywebview.api.prepare_media_for_playback(track.path, 'sidecar');
                        prep = JSON.parse(prepRaw || '{}');
                    } else if (!info.needs_fix) {
                        track.audioCompatMode = 'direct';
                        prep = { status: 'ready', mode: 'direct', path: track.path, analysis: info.analysis };
                    } else {
                        // Pause any primed video. User must explicitly choose; Escape/close does not auto-pick a mode.
                        try { if (DOM.player) DOM.player.pause(); } catch(e) {}
                        const audioFixMode = await showAudioFixDialog(info);
                        if (audioFixMode === 'cancel') {
                            showToast('Audio fix cancelled');
                            resetPlayerToEmpty();
                            return;
                        }
                        const prepRaw = await window.pywebview.api.prepare_media_for_playback(track.path, audioFixMode);
                        prep = JSON.parse(prepRaw || '{}');
                    }
                }
                if (prep.status === 'ready' && prep.mode === 'video_proxy' && prep.path) {
                    showToast(prep.cached ? 'Using cached browser MP4' : 'Using browser-compatible MP4');
                    track.path = prep.path;
                    track.url = `${window.location.origin}/media?path=${encodeURIComponent(prep.path)}`;
                    track.audioCompatMode = 'video_proxy';
                    relinkActiveEpisodeToCompatibleCopy(track.path, track.name || track.path.split(/[\/]/).pop());
                    savePlaylistPermanently();
                } else if (prep.status === 'ready' && prep.mode === 'full_proxy' && prep.path) {
                    showToast(prep.cached ? 'Using cached compatible copy' : 'Using compatible full copy');
                    track.path = prep.path;
                    track.url = `${window.location.origin}/media?path=${encodeURIComponent(prep.path)}`;
                    track.audioCompatMode = 'full_proxy';
                    relinkActiveEpisodeToCompatibleCopy(track.path, track.name || track.path.split(/[\/]/).pop());
                    savePlaylistPermanently();
                } else if (prep.status === 'ready' && prep.mode === 'audio_sidecar' && prep.sidecar_path) {
                    track.audioSidecarPath = prep.sidecar_path;
                    track.audioSidecarUrl = `${window.location.origin}/media?path=${encodeURIComponent(prep.sidecar_path)}`;
                    track.audioCompatMode = 'audio_sidecar';
                    configureExternalAudioSidecar(track.audioSidecarUrl, 'AAC audio');
                    if (!prep.cached) showToast('Using AAC sidecar audio');
                    savePlaylistPermanently();
                } else if (prep.status === 'ready' && prep.mode === 'direct') {
                    track.audioCompatMode = 'direct';
                } else if (prep.status === 'processing' && prep.task_id) {
                    showTaskOverlay('Creating compatible media...', prep.mode === 'video_proxy' ? 'Creating H.264/AAC MP4. This fixes HEVC/AV1 video playback but takes longer.' : (prep.mode === 'full_proxy' ? 'Creating a full compatible MKV copy. This uses extra disk space but playback is simpler.' : 'Creating a small AAC sidecar. Video is not copied.'));
                    clearTimeout(taskOverlaySafetyTimer); // long FFmpeg task: keep overlay until task finishes
                    const taskId = prep.task_id;
                    for (let i = 0; i < 1440; i++) { // up to ~48 minutes for huge lossless audio tracks
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        const statusRaw = await window.pywebview.api.media_task_status(taskId);
                        const status = JSON.parse(statusRaw || '{}');
                        updateTaskOverlay('Creating compatible audio...', status.message || `${status.progress || 0}%`);
                        if (status.status === 'ready' && status.path && (prep.mode === 'full_proxy' || prep.mode === 'video_proxy')) {
                            hideTaskOverlay(200);
                            track.path = status.path;
                            track.url = `${window.location.origin}/media?path=${encodeURIComponent(status.path)}`;
                            track.audioCompatMode = prep.mode;
                            relinkActiveEpisodeToCompatibleCopy(track.path, track.name || track.path.split(/[\/]/).pop());
                            showToast(prep.mode === 'video_proxy' ? 'Browser-compatible MP4 ready' : 'Compatible full copy ready');
                            savePlaylistPermanently();
                            break;
                        }
                        if (status.status === 'ready' && status.sidecar_path) {
                            hideTaskOverlay(200);
                            track.audioSidecarPath = status.sidecar_path;
                            track.audioSidecarUrl = `${window.location.origin}/media?path=${encodeURIComponent(status.sidecar_path)}`;
                            track.audioCompatMode = 'audio_sidecar';
                            configureExternalAudioSidecar(track.audioSidecarUrl, 'AAC audio');
                            showToast('AAC sidecar ready — playing with sound');
                            savePlaylistPermanently();
                            break;
                        }
                        if (status.status === 'error') {
                            hideTaskOverlay(200);
                            showToast('Audio sidecar failed; original file may have no sound');
                            console.error('[Audio Sidecar] failed:', status.message);
                            break;
                        }
                    }
                } else if (prep.status === 'error') {
                    console.warn('[Audio Sidecar] prepare error:', prep.message);
                }
            } catch (e) {
                console.warn('[Audio Sidecar] prepare failed:', e);
            }
        }
    }

    if (track.isTS) {
        if (window.mpegts && mpegts.getFeatureList().mseLivePlayback) {
            const mediaDataSource = {
                type: 'mpegts',
                url: track.url,
                isLive: false
            };
            
            // Inject duration to mpegts.js if successfully resolved
            if (activeDuration > 0) {
                mediaDataSource.duration = activeDuration * 1000;
            }
            
            mpegtsPlayer = mpegts.createPlayer(mediaDataSource, {
                enableWorker: true,
                enableWorkerForMSE: true,
                lazyLoad: false, // Disabled to prevent decoder freezes or lockups during rapid seeking!
                autoCleanupSourceBuffer: true, // ★ ULTRA RAM OPTIMIZATION: Automatically clean played cache from memory!
                autoCleanupMaxBackwardBufferDelay: 120, // Increase slightly for smoother backward seeking without freezing
                autoCleanupMinBackwardBufferDelay: 40
            });
            
            // ★ BULLETPROOF SELF-HEALING RECOVERY DRIVER:
            // Automatically recovers the media pipeline on-the-fly if decoding fails during extreme seeking!
            mpegtsPlayer.on(mpegts.Events.ERROR, (type, detail, info) => {
                console.error(`[mpegts.js Error] Type: ${type}, Detail: ${detail}`);
                if (type === mpegts.ErrorTypes.MEDIA_ERROR) {
                    try {
                        mpegtsPlayer.recoverMediaError();
                        console.log("[mpegts.js] Recovered successfully from media error!");
                    } catch (e) {
                        console.error("[mpegts.js] Recovery failed, reloading stream...", e);
                        const currentPos = DOM.player ? DOM.player.currentTime : 0;
                        playTrack(currentIndex).then(() => {
                            if (DOM.player) DOM.player.currentTime = currentPos;
                        });
                    }
                }
            });

            mpegtsPlayer.attachMediaElement(DOM.player);
            mpegtsPlayer.load();
            DOM.player.play()
                .then(() => {
                    showToast(`Playing: ${track.name}`);
                    if (DOM.controlsCard) DOM.controlsCard.classList.add('active');
                })
                .catch(e => console.log("Play error for TS:", e));
        } else {
            showToast("Error: mpegts.js not supported in this engine");
        }
    } else {
        await playNativeVideoWithRetry(track);
    }
    
    renderPlaylist();
}

function playNext() {
    // Symmetrical: Check if we are playing a library episode!
    if (activeLibraryItem && activeEpisodeNum) {
        const nextEpNum = activeEpisodeNum + 1;
        const nextEp = activeLibraryItem.episodes.find(e => e.num === nextEpNum && e.path);
        if (nextEp) {
            playLibraryEpisode(activeLibraryItem, nextEpNum, 0, 'next-auto');
            return;
        }
    }

    if (playlist.length === 0) return;
    const nextIndex = (currentIndex + 1) % playlist.length;
    playTrack(nextIndex);
}

function playPrev() {
    // Symmetrical: Check if we are playing a library episode!
    if (activeLibraryItem && activeEpisodeNum) {
        const prevEpNum = activeEpisodeNum - 1;
        const prevEp = activeLibraryItem.episodes.find(e => e.num === prevEpNum && e.path);
        if (prevEp) {
            playLibraryEpisode(activeLibraryItem, prevEpNum);
            return;
        }
    }

    if (playlist.length === 0) return;
    const prevIndex = (currentIndex - 1 + playlist.length) % playlist.length;
    playTrack(prevIndex);
}

/* Native dialog file open */
function openFileDialog() {
    // We only use the native dialog if PyWebView is fully loaded and initialized!
    // This permanently prevents any startup deadlocks or freezes if clicked immediately upon launch!
    if (window.pywebview && window.pywebview.api && isAPIReady) {
        window.pywebview.api.select_files();
    } else {
        // Safe, responsive HTML5 file picker fallback
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = "audio/*,video/*,.ts";
        fileInput.onchange = (e) => {
            const files = Array.from(e.target.files).map(f => ({
                name: f.name,
                blobUrl: URL.createObjectURL(f),
                path: '',
                size: f.size || 0
            }));
            addFilesToPlaylist(files);
        };
        fileInput.click();
    }
}

function resizeCanvas() {
    if (canvas) {
        canvas.width = viewport.clientWidth;
        canvas.height = viewport.clientHeight;
    }
}
window.addEventListener('resize', resizeCanvas);

/* Fullscreen Logic - EXPLICIT NATIVE CALL TO PYWEBVIEW */
function toggleFullscreen() {
    document.body.classList.add('fullscreen-transition');
    setTimeout(() => document.body.classList.remove('fullscreen-transition'), 420);
    if (window.pywebview && window.pywebview.api) {
        console.log("[Fullscreen Engine] Triggering PyWebView native toggle_native_fullscreen");
        window.pywebview.api.toggle_native_fullscreen();
    } else {
        const vp = document.getElementById('player-viewport');
        if (!document.fullscreenElement) {
            if (vp.requestFullscreen) {
                vp.requestFullscreen();
            } else if (vp.webkitRequestFullscreen) {
                vp.webkitRequestFullscreen();
            }
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            }
        }
    }
}

/* 
   Smart Visualizer Animation loop management!
   When video mode is active, the loop is completely stopped to save 100% CPU/GPU cycles.
   Only runs when actively playing audio tracks!
*/
function startVisualizerLoop() {
    if (isAudioPipelineInitialized && !animationFrameId) {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        function draw() {
            animationFrameId = requestAnimationFrame(draw);
            analyser.getByteFrequencyData(dataArray);
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            const barWidth = (canvas.width / bufferLength) * 1.5;
            let barHeight;
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
                barHeight = dataArray[i];
                ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + (barHeight / 255) * 0.18})`;
                
                const ratio = canvas.height / 280;
                const h = barHeight * ratio;
                const y = canvas.height - h;
                
                ctx.beginPath();
                if (ctx.roundRect) {
                    ctx.roundRect(x, y, barWidth - 4, h, [2, 2, 0, 0]);
                } else {
                    ctx.fillRect(x, y, barWidth - 4, h);
                }
                ctx.fill();
                
                x += barWidth;
            }
        }
        draw();
        console.log("Visualizer loop active.");
    }
}

function stopVisualizerLoop() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
        console.log("Visualizer loop suspended to save 100% CPU.");
    }
}

/* Event Binding for core elements */
function initEvents() {
    // Media Player binds
    bindEvent(DOM.playBtn, 'click', togglePlay);
    bindEvent(DOM.nextBtn, 'click', playNext);
    bindEvent(DOM.prevBtn, 'click', playPrev);
    bindEvent(DOM.openFileBtn, 'click', openFileDialog);

    // Bind action and close buttons on our new Premium Skip Pill
    const skipActionBtn = document.getElementById('skip-action-btn');
    bindEvent(skipActionBtn, 'click', (e) => {
        e.stopPropagation();
        if (!DOM.player) return;
        const currentTime = DOM.player.currentTime;
        const duration = getActiveDuration();
        const markers = getActiveSkipMarkers();
        const outroStartTime = duration - markers.outroStartOffset;
        
        if (currentTime >= markers.introStart && currentTime < markers.introEnd) {
            seekVideoSafely(markers.introEnd, 'skip-intro');
            if (DOM.skipIntroBtn) DOM.skipIntroBtn.classList.add('hidden');
            flashHUD(`<span style="font-size: 11px;">Intro Skipped</span>`);
            showToast("Intro skipped successfully");
        } else if (duration > 0 && currentTime >= outroStartTime) {
            // Symmetrical: mark current episode as watched and remove from progress
            if (activeLibraryItem && activeEpisodeNum) {
                const watchedKey = `watched_${activeLibraryItem.id}_${activeEpisodeNum}`;
                saveViewingHistory(activeLibraryItem, activeEpisodeNum, duration || DOM.player.currentTime || 0);
                localStorage.setItem(watchedKey, 'true');
                removeEpisodeFromWatchingProgress(activeLibraryItem.id);
            }
            playNext();
            flashHUD(`<span style="font-size: 11px;">Outro Skipped</span>`);
            showToast("Outro skipped, playing next");
        }
    });

    const skipCloseBtn = document.getElementById('skip-close-btn');
    bindEvent(skipCloseBtn, 'click', (e) => {
        e.stopPropagation();
        isSkipDismissed = true;
        if (DOM.skipIntroBtn) DOM.skipIntroBtn.classList.add('hidden');
        showToast("Overlay dismissed");
    });

    // Central splash screen click bindings
    const centralBtn = document.getElementById('central-open-btn');
    bindEvent(centralBtn, 'click', (e) => {
        e.stopPropagation();
        openFileDialog();
    });

    const audioUI = document.getElementById('audio-ui');
    bindEvent(audioUI, 'click', (e) => {
        if (playlist.length === 0) {
            openFileDialog();
        }
    });

    // Mouse Wheel volume control directly over the video viewport!
    bindEvent(DOM.viewport, 'wheel', (e) => {
        e.preventDefault();
        if (playlist.length === 0 || !DOM.player) return; // Guard against scrolling on splash screen
        const change = e.deltaY < 0 ? 0.05 : -0.05;
        const nv = Math.max(0, Math.min(1, DOM.player.volume + change));
        DOM.player.volume = nv;
        updateVolumeUI(nv);
        flashHUD(`<span>Vol: ${Math.round(nv * 100)}%</span>`);
    }, { passive: false });

    // Double-click left/right half of the video viewport to rewind/forward 10 seconds!
    bindEvent(DOM.viewport, 'dblclick', (e) => {
        e.preventDefault();
        if (playlist.length === 0 || !isVideoMode || !DOM.player) return; // Guard against clicking on splash screen
        const rect = DOM.viewport.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const mid = rect.width / 2;
        if (clickX < mid) {
            seekVideoSafely((DOM.player.currentTime || 0) - 10, 'dblclick-rewind');
            flashHUD(`<span>-10s</span>`);
        } else {
            seekVideoSafely((DOM.player.currentTime || 0) + 10, 'dblclick-forward');
            flashHUD(`<span>+10s</span>`);
        }
    });

    bindEvent(DOM.speedBtn, 'click', (e) => {
        e.stopPropagation();
        if (DOM.speedMenu) DOM.speedMenu.classList.toggle('show');
    });
    
    document.addEventListener('click', () => {
        if (DOM.speedMenu) DOM.speedMenu.classList.remove('show');
    });
    
    document.querySelectorAll('.speed-option').forEach(option => {
        option.addEventListener('click', (e) => {
            const speed = parseFloat(e.target.dataset.speed);
            if (DOM.player) DOM.player.playbackRate = speed;
            if (DOM.speedBtn) DOM.speedBtn.textContent = speed === 1.0 ? '1.0x' : `${speed}x`;
            document.querySelectorAll('.speed-option').forEach(opt => opt.classList.remove('active'));
            e.target.classList.add('active');
            showToast(`Speed: ${speed}x`);
        });
    });

    bindEvent(DOM.volumeBtn, 'click', () => {
        if (DOM.player) {
            if (DOM.player.volume > 0) {
                previousVolume = DOM.player.volume;
                DOM.player.volume = 0;
                updateVolumeUI(0);
            } else {
                DOM.player.volume = previousVolume;
                updateVolumeUI(previousVolume);
            }
        }
    });

    bindEvent(DOM.togglePlaylistBtn, 'click', () => {
        if (DOM.playlistSidebar) {
            DOM.playlistSidebar.classList.toggle('hidden');
            DOM.togglePlaylistBtn.classList.toggle('active', !DOM.playlistSidebar.classList.contains('hidden'));
        }
        setTimeout(resizeCanvas, 350);
    });

    bindEvent(DOM.addBtn, 'click', openFileDialog);
    bindEvent(DOM.fullscreenBtn, 'click', toggleFullscreen);

    // Keyboard Shortcuts setup defensively
    document.addEventListener('keydown', (e) => {
        // Strict typing guard: if the user is typing in any input field, let them type normally!
        if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            return;
        }

        if (e.code === 'F11' || e.code === 'KeyF') {
            e.preventDefault();
            toggleFullscreen();
        }
        else if (e.code === 'Space') {
            e.preventDefault();
            togglePlay();
        }
        else if (e.code === 'ArrowRight' && e.shiftKey) {
            e.preventDefault();
            playNext();
        }
        else if (e.code === 'ArrowLeft' && e.shiftKey) {
            e.preventDefault();
            playPrev();
        }
        else if (e.code === settings.forwardKey) {
            e.preventDefault();
            if (DOM.player) {
                seekVideoSafely((DOM.player.currentTime || 0) + 5, 'keyboard-forward');
                flashHUD(`<span>+5s</span>`);
            }
        }
        else if (e.code === settings.rewindKey) {
            e.preventDefault();
            if (DOM.player) {
                seekVideoSafely((DOM.player.currentTime || 0) - 5, 'keyboard-rewind');
                flashHUD(`<span>-5s</span>`);
            }
        }
        else if (e.code === settings.skipIntroKey) {
            e.preventDefault();
            const actionBtn = document.getElementById('skip-action-btn');
            if (actionBtn) actionBtn.click();
        }
        else if (e.code === 'KeyA') {
            e.preventDefault();
            toggleAspectRatio();
        }
        else if (e.code === 'KeyZ') {
            e.preventDefault();
            if (DOM.player) {
                DOM.player.classList.toggle('zero-sharpness-active');
                const active = DOM.player.classList.contains('zero-sharpness-active');
                flashHUD(`<span>Enhancer: ${active ? "ВКЛ" : "ВЫКЛ"}</span>`);
                showToast(`Сглаживание Zero Sharpness: ${active ? "Включено" : "Выключено"}`);
            }
        }
        else if (e.code === 'KeyC') {
            e.preventDefault();
            openSubtitleFileDialog();
        }
        else if (e.code === 'KeyB') {
            e.preventDefault();
            addVideoBookmark();
        }
        else if (e.code === 'Slash' || e.code === 'Slash' && e.shiftKey) {
            e.preventDefault();
            toggleHotkeysHelp();
        }
        else if (e.code === 'Escape') {
            e.preventDefault();
            const hotkeysOverlay = document.getElementById('hotkeys-overlay');
            if (hotkeysOverlay && !hotkeysOverlay.classList.contains('hidden')) {
                hotkeysOverlay.classList.add('hidden');
            } else if (document.fullscreenElement) {
                document.exitFullscreen();
            } else if (isVideoMode && DOM.player && !DOM.player.paused) {
                // Pause video on Escape first
                DOM.player.pause();
            } else if (playlist.length > 0) {
                // Exit player to home screen if loaded/paused
                exitPlayerToHome();
            } else if (!document.getElementById('hdrezka-page').classList.contains('hidden')) {
                // Close HDRezka page back to Catalog/Library results
                document.getElementById('hdrezka-page').classList.add('hidden');
                document.getElementById('search-view').classList.remove('hidden');
            } else {
                exitPlayerToHome();
            }
        }
        else if (e.code === 'ArrowUp') {
            e.preventDefault();
            if (DOM.player) {
                const nv = Math.min(1, DOM.player.volume + 0.05);
                DOM.player.volume = nv;
                updateVolumeUI(nv);
                flashHUD(`<span>Vol: ${Math.round(nv * 100)}%</span>`);
            }
        }
        else if (e.code === 'ArrowDown') {
            e.preventDefault();
            if (DOM.player) {
                const nv = Math.max(0, DOM.player.volume - 0.05);
                DOM.player.volume = nv;
                updateVolumeUI(nv);
                flashHUD(`<span>Vol: ${Math.round(nv * 100)}%</span>`);
            }
        }
    });

    setupDragAndDrop();
    setupAutoHideControls();

    // ★ CHROME-STYLE TOP TABS & MULTIPORT LIBRARY HANDLERS (Step 1)
    const loadBtn = document.getElementById('tab-load-btn');
    const searchBtn = document.getElementById('tab-search-btn');
    const downloaderBtn = document.getElementById('tab-downloader-btn');
    const mergerBtn = document.getElementById('tab-merger-btn');
    const searchView = document.getElementById('search-view');
    const playerViewport = document.getElementById('player-viewport');
    const downloaderView = document.getElementById('downloader-view');
    const mergerView = document.getElementById('merger-view');
    const searchSubBar = document.getElementById('search-sub-bar');

    bindEvent(loadBtn, 'click', () => {
        loadBtn.classList.add('active');
        searchBtn.classList.remove('active');
        if (downloaderBtn) downloaderBtn.classList.remove('active');
        if (mergerBtn) mergerBtn.classList.remove('active');
        searchView.classList.add('hidden');
        if (downloaderView) downloaderView.classList.add('hidden');
        if (mergerView) mergerView.classList.add('hidden');
        playerViewport.classList.remove('hidden');
        if (searchSubBar) searchSubBar.classList.add('hidden');
        
        // Symmetrical: close the details slide-out panel when switching to Load tab!
        const detailsPanel = document.getElementById('details-panel');
        if (detailsPanel) {
            detailsPanel.classList.remove('show');
        }
    });

    bindEvent(searchBtn, 'click', () => {
        if (isVideoMode && DOM.player && !DOM.player.paused) resetPlayerToEmpty();
        searchBtn.classList.add('active');
        loadBtn.classList.remove('active');
        if (downloaderBtn) downloaderBtn.classList.remove('active');
        if (mergerBtn) mergerBtn.classList.remove('active');
        searchView.classList.remove('hidden');
        playerViewport.classList.add('hidden');
        if (downloaderView) downloaderView.classList.add('hidden');
        if (mergerView) mergerView.classList.add('hidden');
        if (searchSubBar) searchSubBar.classList.remove('hidden');
        
        // Symmetrical: Auto-load trending on first tab click
        const resultsGrid = document.getElementById('catalog-results');
        if (resultsGrid && resultsGrid.children.length === 0) {
            loadTrendingAnime();
        }
        renderLibraryGrid(); // Automatically update library on tab switch
    });

    bindEvent(downloaderBtn, 'click', () => {
        if (isVideoMode && DOM.player && !DOM.player.paused) resetPlayerToEmpty();
        downloaderBtn.classList.add('active');
        if (mergerBtn) mergerBtn.classList.remove('active');
        loadBtn.classList.remove('active');
        searchBtn.classList.remove('active');
        if (downloaderView) downloaderView.classList.remove('hidden');
        if (mergerView) mergerView.classList.add('hidden');
        searchView.classList.add('hidden');
        playerViewport.classList.add('hidden');
        if (searchSubBar) searchSubBar.classList.add('hidden');
        
        // Close the details panel on switch
        const detailsPanel = document.getElementById('details-panel');
        if (detailsPanel) {
            detailsPanel.classList.remove('show');
        }
    });

    bindEvent(mergerBtn, 'click', () => {
        if (!mergerBtn) return;
        if (isVideoMode && DOM.player && !DOM.player.paused) resetPlayerToEmpty();
        mergerBtn.classList.add('active');
        if (downloaderBtn) downloaderBtn.classList.remove('active');
        loadBtn.classList.remove('active');
        searchBtn.classList.remove('active');
        if (mergerView) mergerView.classList.remove('hidden');
        if (downloaderView) downloaderView.classList.add('hidden');
        searchView.classList.add('hidden');
        playerViewport.classList.add('hidden');
        if (searchSubBar) searchSubBar.classList.add('hidden');
        const detailsPanel = document.getElementById('details-panel');
        if (detailsPanel) detailsPanel.classList.remove('show');
        if (!mergerWatcherTimer) toggleMergerWatcher();
        mergerScan();
    });

    initMergerPanelEvents();

    // Subtabs: Catalog / Library / Watching
    const subtabCatalog = document.getElementById('subtab-catalog-btn');
    const subtabLibrary = document.getElementById('subtab-library-btn');
    const subtabWatching = document.getElementById('subtab-watching-btn');
    const catalogContainer = document.getElementById('catalog-container');
    const libraryContainer = document.getElementById('library-container');
    const watchingContainer = document.getElementById('watching-container');

    bindEvent(subtabCatalog, 'click', () => {
        subtabCatalog.classList.add('active');
        subtabLibrary.classList.remove('active');
        if (subtabWatching) subtabWatching.classList.remove('active');
        catalogContainer.classList.remove('hidden');
        libraryContainer.classList.add('hidden');
        if (watchingContainer) watchingContainer.classList.add('hidden');
    });

    bindEvent(subtabLibrary, 'click', () => {
        subtabLibrary.classList.add('active');
        subtabCatalog.classList.remove('active');
        if (subtabWatching) subtabWatching.classList.remove('active');
        libraryContainer.classList.remove('hidden');
        catalogContainer.classList.add('hidden');
        if (watchingContainer) watchingContainer.classList.add('hidden');
        renderLibraryGrid();
    });

    bindEvent(subtabWatching, 'click', () => {
        if (subtabWatching) subtabWatching.classList.add('active');
        subtabCatalog.classList.remove('active');
        subtabLibrary.classList.remove('active');
        if (watchingContainer) watchingContainer.classList.remove('hidden');
        catalogContainer.classList.add('hidden');
        libraryContainer.classList.add('hidden');
        renderWatchingDashboard();
    });

    // Library category selection: Movie / Show / Anime
    document.querySelectorAll('.category-btn').forEach(btn => {
        bindEvent(btn, 'click', (e) => {
            document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            currentCategory = e.target.dataset.category;
            renderLibraryGrid();
        });
    });

    // ★ STABLE EVENT BINDINGS FOR SEARCH & DETAILS PANEL (Move inside initEvents)
    const catalogSearchInput = document.getElementById('catalog-search-input');
    const catalogSearchSubmit = document.getElementById('catalog-search-submit');

    bindEvent(catalogSearchSubmit, 'click', () => {
        const query = catalogSearchInput.value.trim();
        if (query.length > 0) {
            searchCatalog(query);
        }
    });

    bindEvent(catalogSearchInput, 'keydown', (e) => {
        if (e.code === 'Enter') {
            const query = catalogSearchInput.value.trim();
            if (query.length > 0) {
                searchCatalog(query);
            }
        }
    });

    // Bind details close button
    bindEvent(document.getElementById('details-close-btn'), 'click', () => {
        document.getElementById('details-panel').classList.remove('show');
    });

    // Bind Downloader Search triggers
    const dlSearchInput = document.getElementById('downloader-search-input');
    const dlSearchSubmit = document.getElementById('downloader-search-submit');
    
    bindEvent(dlSearchSubmit, 'click', () => {
        const query = dlSearchInput ? dlSearchInput.value.trim() : '';
        if (query.length > 0) {
            triggerNyaaSearch(query);
        }
    });
    
    bindEvent(dlSearchInput, 'keydown', (e) => {
        if (e.code === 'Enter') {
            const query = dlSearchInput ? dlSearchInput.value.trim() : '';
            if (query.length > 0) {
                triggerNyaaSearch(query);
            }
        }
    });

    // Bind Catalog Search Category Buttons
    const catAnimeBtn = document.getElementById('catalog-cat-anime-btn');
    const catMovieBtn = document.getElementById('catalog-cat-movie-btn');
    const catShowBtn = document.getElementById('catalog-cat-show-btn');
    const searchInput = document.getElementById('catalog-search-input');
    
    const handleSearchCategoryClick = (btn, cat, placeholder) => {
        if (!btn) return;
        bindEvent(btn, 'click', (e) => {
            [catAnimeBtn, catMovieBtn, catShowBtn].forEach(b => { if (b) b.classList.remove('active'); });
            e.target.classList.add('active');
            activeSearchCategory = cat;
            if (searchInput) searchInput.setAttribute('placeholder', placeholder);
            
            // Auto trigger search if input has value
            const query = searchInput ? searchInput.value.trim() : '';
            if (query.length > 0) {
                searchCatalog(query);
            }
        });
    };
    
    handleSearchCategoryClick(catAnimeBtn, 'anime', 'Search anime, movies, series...');
    handleSearchCategoryClick(catMovieBtn, 'movie', 'Search Hollywood movies, cinema...');
    handleSearchCategoryClick(catShowBtn, 'show', 'Search TV series, Netflix shows...');

    // Bind Hotkeys Help Overlay Close button
    const hotkeysCloseBtn = document.getElementById('hotkeys-close-btn');
    bindEvent(hotkeysCloseBtn, 'click', () => {
        document.getElementById('hotkeys-overlay').classList.add('hidden');
    });

    const hotkeysOverlay = document.getElementById('hotkeys-overlay');
    bindEvent(hotkeysOverlay, 'click', (e) => {
        if (e.target === hotkeysOverlay) {
            hotkeysOverlay.classList.add('hidden');
        }
    });

    // Bind HDRezka Folder button
    const folderBtn = document.getElementById('hdrezka-folder-btn');
    bindEvent(folderBtn, 'click', openFolderLinkDialog);

    // Bind Subtitle CC toggler
    const subBtn = document.getElementById('subtitle-btn');
    bindEvent(subBtn, 'click', openSubtitleFileDialog);

    // Bind Stream URL Input & Play Button
    const streamPlayBtn = document.getElementById('stream-url-play-btn');
    const streamInput = document.getElementById('stream-url-input');
    
    const handleStreamPlayback = () => {
        const url = streamInput.value.trim();
        if (!url) return;
        playlist = [{
            name: "Stream video",
            path: url,
            url: url,
            isVideo: true,
            isTS: url.toLowerCase().endsWith('.ts'),
            size: 0
        }];
        currentIndex = 0;
        playTrack(0);
    };
    
    bindEvent(streamPlayBtn, 'click', handleStreamPlayback);
    bindEvent(streamInput, 'keydown', (e) => {
        if (e.code === 'Enter') {
            handleStreamPlayback();
        }
    });

    // Bind HDRezka back button
    bindEvent(document.getElementById('hdrezka-back-btn'), 'click', () => {
        document.getElementById('hdrezka-page').classList.add('hidden');
        document.getElementById('search-view').classList.remove('hidden');
    });

    // Bind Player viewport back-to-home button
    const playerBackBtn = document.getElementById('player-back-to-home-btn');
    bindEvent(playerBackBtn, 'click', (e) => {
        e.stopPropagation();
        exitPlayerToHome();
    });

    // Bind HDRezka library action button
    const rezkaLibBtn = document.getElementById('hdrezka-lib-btn');
    bindEvent(rezkaLibBtn, 'click', () => {
        if (!activeLibraryItem) return;
        const { item, inLibrary } = normalizeMediaItem(activeLibraryItem);
        
        if (inLibrary) {
            library[item.category] = (library[item.category] || []).filter(i => i.id !== item.id);
            saveLibrary();
            showToast("Удалено из библиотеки");
            updateHDRezkaLibButton(false);
            renderLibraryGrid();
            renderHDRezkaEpisodes();
        } else {
            if (!library[item.category]) library[item.category] = [];
            library[item.category].push(item);
            saveLibrary();
            showToast("Добавлено в библиотеку");
            updateHDRezkaLibButton(true);
            renderLibraryGrid();
            renderHDRezkaEpisodes();
        }
    });
}

/* Unifed global window drag-and-drop listener that intercepts drop correctly */
function setupDragAndDrop() {
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (DOM.dropOverlay) {
            DOM.dropOverlay.classList.add('active');
        }
    }, true); 

    if (DOM.dropOverlay) {
        DOM.dropOverlay.addEventListener('dragleave', (e) => {
            e.preventDefault();
            DOM.dropOverlay.classList.remove('active');
        });
    }

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        if (DOM.dropOverlay) DOM.dropOverlay.classList.remove('active');
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            const mappedFiles = files.map(file => {
                // ★ EXTREME CRITICAL FIX:
                // PyWebView automatically injects 'pywebviewFullPath' on the file object
                // during browser drag-and-drop on Windows! This bypasses Chrome's local folder path sandbox block!
                const path = file.pywebviewFullPath || file.path || '';
                return {
                    name: file.name,
                    path: path,
                    blobUrl: URL.createObjectURL(file),
                    size: file.size || 0
                };
            });
            addFilesToPlaylist(mappedFiles);
        }
    }, true); 
}

/* Controls Auto-hide */
let hoverTimeout;
let isControlsHovered = false;
function setupAutoHideControls() {
    const controlsCard = document.getElementById('controls-card');
    if (!controlsCard) return;
    
    controlsCard.addEventListener('mouseenter', () => { isControlsHovered = true; });
    controlsCard.addEventListener('mouseleave', () => { isControlsHovered = false; });
    
    document.addEventListener('mousemove', () => {
        document.body.classList.remove('hide-controls');
        clearTimeout(hoverTimeout);
        
        if (isVideoMode && DOM.player && !DOM.player.paused && !isControlsHovered) {
            hoverTimeout = setTimeout(() => {
                document.body.classList.add('hide-controls');
            }, 3000);
        }
    });
}

// Dom Ready Initializer
window.addEventListener('pagehide', () => {
    try { persistCurrentWatchOnExit('pagehide'); } catch(e) {}
    try { stopExternalAudioSidecar(); } catch(e) {}
    try { if (DOM.player) DOM.player.pause(); } catch(e) {}
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) persistCurrentWatchOnExit('visibility-hidden');
    if (document.hidden && sidecarAudio && DOM.player && DOM.player.paused) {
        stopExternalAudioSidecar();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // Symmetrically defend against any accidental classes on launch!
    document.body.classList.remove('player-has-video');
    document.body.classList.remove('playing');
    initDOMElements();
    initSliders();
    bindPlayerEvents();
    initEvents();
    initWatchTogetherButton();
    initCloudProfileButton();
    // Sync default Library category with the UI default (Movie). Prevents empty Anime tab showing until user toggles categories.
    try {
        document.querySelectorAll('.library-categories-bar .category-btn').forEach(b => b.classList.remove('active'));
        const movieBtn = document.getElementById('category-movie-btn');
        if (movieBtn) movieBtn.classList.add('active');
        currentCategory = 'movie';
    } catch(e) {}
    resizeCanvas();
    window.__uiBindingsReady = true;
    bootStatus('Interface controls ready. Waiting for backend...');
    if (!window.__bootDbStarted && window.pywebview && window.pywebview.api) {
        setTimeout(bootLoadDatabasesThenUnlock, 50);
    }
    // FAST BOOT RULE:
    // Do not render heavy Library/Watching/Playlist dashboards on startup.
    // They render lazily when the user opens Search/Library/Watching, keeping the first window fully responsive.
    const addFirstBtn = document.getElementById('add-first-btn');
    if (addFirstBtn) addFirstBtn.addEventListener('click', openFileDialog);
    
    // Loading overlay is hidden after the startup gate confirms UI + backend readiness.
    setTimeout(() => { if (!window.__bootDbStarted) bootLoadDatabasesThenUnlock(); }, 500);
    setTimeout(() => {
        if (window.pywebview) {
            showToast("Minimal Media Player Pro is active.");
        } else {
            showToast("Demo environment active");
        }
    }, 800);
});

// ★ CHROME-STYLE TOP TABS & MULTIPORT LIBRARY LOGIC (Step 1)
let currentCategory = 'movie';
let library = { movie: [], show: [], anime: [] };
try {
    const saved = localStorage.getItem('player_library');
    if (saved) {
        library = JSON.parse(saved);
    }
} catch (e) {
    console.error("Failed to parse library from localStorage:", e);
}
library = dedupeLibraryInPlace(library);

// Guarantee properties exist to prevent any undefined crashes!
if (!library || typeof library !== 'object') {
    library = { movie: [], show: [], anime: [] };
}
if (!library.movie) library.movie = [];
if (!library.show) library.show = [];
if (!library.anime) library.anime = [];


function libraryTitleKey(item) {
    return String(item?.title || item?.name || '')
        .toLowerCase()
        .replace(/\(\d{4}\)/g, '')
        .replace(/[^a-z0-9а-яё一-龯ぁ-んァ-ン]+/gi, '')
        .trim();
}

function dedupeLibraryInPlace(lib) {
    if (!lib || typeof lib !== 'object') return { movie: [], show: [], anime: [] };
    for (const cat of ['movie', 'show', 'anime']) {
        const src = Array.isArray(lib[cat]) ? lib[cat] : [];
        const byId = new Map();
        const byTitle = new Map();
        const out = [];
        const mergeItems = (a, b) => {
            const merged = Object.assign({}, a || {}, b || {});
            const epsA = Array.isArray(a?.episodes) ? a.episodes : [];
            const epsB = Array.isArray(b?.episodes) ? b.episodes : [];
            const epMap = new Map();
            epsA.forEach(e => epMap.set(e.num, Object.assign({}, e)));
            epsB.forEach(e => {
                const prev = epMap.get(e.num) || {};
                epMap.set(e.num, Object.assign({}, prev, e, {
                    path: e.path || prev.path || '',
                    name: e.name || prev.name || ''
                }));
            });
            if (epMap.size) merged.episodes = Array.from(epMap.values()).sort((x, y) => x.num - y.num);
            return merged;
        };
        for (const item of src) {
            if (!item) continue;
            const idKey = item.id !== undefined && item.id !== null ? String(item.id) : '';
            const titleKey = libraryTitleKey(item);
            let existingIndex = -1;
            if (idKey && byId.has(idKey)) existingIndex = byId.get(idKey);
            else if (titleKey && byTitle.has(titleKey)) existingIndex = byTitle.get(titleKey);
            if (existingIndex >= 0) {
                out[existingIndex] = mergeItems(out[existingIndex], item);
            } else {
                const idx = out.length;
                out.push(item);
                if (idKey) byId.set(idKey, idx);
                if (titleKey) byTitle.set(titleKey, idx);
            }
        }
        lib[cat] = out;
    }
    return lib;
}

function mergeLibraryObjects(localLib, pythonLib) {
    const result = { movie: [], show: [], anime: [] };
    const cats = ['movie', 'show', 'anime'];

    const mergeItems = (existing, item) => {
        const merged = Object.assign({}, existing || {}, item || {});
        // Preserve important non-empty fields from either side. Object.assign can overwrite with empty strings.
        for (const key of ['path', 'name', 'poster', 'image', 'synopsis', 'category', 'type']) {
            if ((merged[key] === '' || merged[key] === undefined || merged[key] === null) && existing && existing[key]) merged[key] = existing[key];
            if ((merged[key] === '' || merged[key] === undefined || merged[key] === null) && item && item[key]) merged[key] = item[key];
        }
        const oldEpisodes = Array.isArray(existing?.episodes) ? existing.episodes : [];
        const newEpisodes = Array.isArray(item?.episodes) ? item.episodes : [];
        const epMap = new Map();
        oldEpisodes.forEach(e => {
            const key = e?.num !== undefined ? String(e.num) : String(epMap.size + 1);
            epMap.set(key, Object.assign({}, e));
        });
        newEpisodes.forEach(e => {
            const key = e?.num !== undefined ? String(e.num) : String(epMap.size + 1);
            const prev = epMap.get(key) || {};
            epMap.set(key, Object.assign({}, prev, e, {
                // Preserve linked files from either store; never let an older empty DB erase links.
                path: e.path || prev.path || '',
                name: e.name || prev.name || ''
            }));
        });
        if (epMap.size > 0) merged.episodes = Array.from(epMap.values()).sort((a, b) => (a.num || 0) - (b.num || 0));
        return merged;
    };

    for (const cat of cats) {
        const map = new Map();
        const aliases = new Map();
        const add = (item) => {
            if (!item) return;
            const idKey = item.id !== undefined && item.id !== null && item.id !== '' ? `id:${String(item.id)}` : '';
            const titleKey = libraryTitleKey(item) ? `title:${libraryTitleKey(item)}` : '';
            const key = idKey || titleKey;
            if (!key) return;
            const existingKey = aliases.get(idKey) || aliases.get(titleKey) || key;
            if (!map.has(existingKey)) {
                map.set(existingKey, item);
            } else {
                map.set(existingKey, mergeItems(map.get(existingKey), item));
            }
            if (idKey) aliases.set(idKey, existingKey);
            if (titleKey) aliases.set(titleKey, existingKey);
        };
        (Array.isArray(localLib?.[cat]) ? localLib[cat] : []).forEach(add);
        (Array.isArray(pythonLib?.[cat]) ? pythonLib[cat] : []).forEach(add);
        result[cat] = Array.from(map.values());
    }
    return dedupeLibraryInPlace(result);
}



async function saveDbDataFallback(key, data) {
    try {
        if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.save_db_data === 'function') {
            return await window.pywebview.api.save_db_data(key, data);
        }
        await fetch('/api/save_db_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, data })
        });
        return true;
    } catch(e) {
        console.warn('[Storage Engine] saveDbData fallback failed:', e);
        return false;
    }
}

function saveLibrary() {
    // Always save to localStorage immediately so startup/API delays never wipe user changes.
    library = dedupeLibraryInPlace(library);
    const payload = JSON.stringify(library);
    localStorage.setItem('player_library', payload);
    // Always attempt backend persistence. saveDbDataFallback uses PyWebView when available,
    // otherwise HTTP fallback; this fixes the "saved locally but disappeared after restart" class of bugs.
    saveDbDataFallback("library", payload).then(ok => {
        if (!ok) console.warn("[Storage Engine] Library backend sync failed; localStorage copy is still safe.");
    });
}

function renderLibraryGrid() {
    const grid = document.getElementById('library-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    // Defensive fallback to prevent any undefined 'toUpperCase' crashes
    if (typeof currentCategory === 'undefined' || !currentCategory) {
        currentCategory = 'anime';
    }
    
    const items = library[currentCategory] || [];
    if (items.length === 0) {
        grid.innerHTML = `
            <div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;">
                <p>Your ${currentCategory.toUpperCase()} library is empty.</p>
                <p style="font-size: 0.65rem; color: var(--text-muted); margin-top: 4px;">Search and add some titles first!</p>
            </div>
        `;
        return;
    }
    
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'media-card';
        card.innerHTML = `
            <div class="media-poster-wrapper">
                <img class="media-poster" src="${item.poster || DEFAULT_POSTER_DATA}" alt="${item.title}">
            </div>
            <div class="media-card-info">
                <div class="media-card-title" title="${item.title}">${item.title}</div>
                <div class="media-card-meta">${item.episodes ? item.episodes.length + ' Episodes' : 'Movie'}</div>
            </div>
        `;
        bindMediaCardEvents(card, item, false);
        grid.appendChild(card);
    });
}

function showLibraryItemDetails(item) {
    const detailsPanel = document.getElementById('details-panel');
    if (!detailsPanel) return;
    
    activeLibraryItem = item;
    renderDetailsContent(item, true);
    detailsPanel.classList.add('show');
}

function looksLikeLiveActionQuery(query) {
    const q = (query || '').toLowerCase().trim();
    return [
        'во все тяжкие', 'breaking bad', 'better call saul', 'лучше звоните солу',
        'game of thrones', 'игра престолов', 'the boys', 'пацаны', 'sopranos', 'клан сопрано'
    ].some(x => q.includes(x));
}

function containsCyrillic(text) {
    return /[а-яё]/i.test(text || '');
}

function normalizeSearchKey(text) {
    return (text || '').toLowerCase().replace(/[^a-z0-9а-яё一-龯ぁ-んァ-ン]/gi, '');
}

function getKnownFranchiseKey(query, items = []) {
    const q = normalizeSearchKey(query);
    const aliases = {
        bleach: ['bleach', 'блич', 'буричи'],
        spider: ['spiderman', 'spiderverse', 'spider man', 'человекпаук', 'паук'],
        fate: ['fate', 'фейт'],
        jojo: ['jojo', 'джоджо'],
        monogatari: ['monogatari', 'моногатари'],
        gintama: ['gintama', 'гинтама']
    };
    for (const [key, vals] of Object.entries(aliases)) {
        if (vals.some(v => q.includes(normalizeSearchKey(v)))) return key;
    }
    for (const item of items) {
        const t = normalizeSearchKey(item.title || item.name || '');
        for (const [key, vals] of Object.entries(aliases)) {
            if (vals.some(v => t.includes(normalizeSearchKey(v)))) return key;
        }
    }
    return null;
}

function applyKnownMetadataFallback(item) {
    if (!item) return item;
    const key = getKnownFranchiseKey(item.title || item.name || '', [{ title: item.title || item.name }]);
    if (key === 'bleach') {
        item.studios_str = item.studios_str && item.studios_str !== '-' ? item.studios_str : 'Studio Pierrot';
        item.genres_str = item.genres_str && item.genres_str !== '-' ? item.genres_str : 'Action, Adventure, Supernatural';
        item.source = item.source && item.source !== '-' ? item.source : 'Manga';
        item.score = item.score || 7.96;
    } else if (key === 'spider') {
        item.studios_str = item.studios_str && item.studios_str !== '-' ? item.studios_str : 'Sony Pictures / Marvel';
        item.genres_str = item.genres_str && item.genres_str !== '-' ? item.genres_str : 'Superhero, Action, Adventure';
        item.source = item.source && item.source !== '-' ? item.source : 'Marvel Comics';
    }
    return item;
}

function collapseAnimeSearchResultsToFranchise(query, items) {
    if (!Array.isArray(items) || items.length === 0) return items || [];
    const key = getKnownFranchiseKey(query, items);
    if (!key || !FAMOUS_FRANCHISES[key]) return items;

    const root = FAMOUS_FRANCHISES[key].slice().sort((a, b) => (a.order || 999) - (b.order || 999))[0];
    let main = items.find(i => i.mal_id === root.id)
        || items.find(i => normalizeSearchKey(i.title || '').includes(normalizeSearchKey(root.name || '')) && (i.type || '').toLowerCase() === 'tv')
        || items.find(i => (i.type || '').toLowerCase() === 'tv')
        || items[0];

    main = Object.assign({}, main, {
        mal_id: root.id || main.mal_id,
        title: root.name || main.title,
        type: root.type || main.type || 'TV',
        episodes: root.episodes || main.episodes || 12,
        category: 'anime',
        franchiseHub: true,
        franchiseKey: key,
        franchisePartsCount: FAMOUS_FRANCHISES[key].length
    });
    return [main];
}

function collapseMovieSearchResultsToFranchise(query, items) {
    if (!Array.isArray(items) || items.length === 0) return items || [];
    const q = normalizeSearchKey(query);
    const spiderAliases = ['spiderman', 'spiderverse', 'человекпаук', 'паук'];
    if (!spiderAliases.some(a => q.includes(a))) return items;
    const main = Object.assign({}, items[0], {
        id: items[0].id,
        title: 'Spider-Man Franchise',
        name: 'Spider-Man Franchise',
        category: 'movie',
        type: 'Movie',
        episodes: 1,
        franchiseHub: true,
        franchisePartsCount: items.length
    });
    return [main];
}

function pickRootCandidateFromAIPlan(items, plan) {
    if (!Array.isArray(items) || items.length === 0) return null;
    const root = normalizeSearchKey(plan.root_title || plan.canonical_title || plan.hub_title || '');
    if (root) {
        const exact = items.find(i => normalizeSearchKey(i.title || i.name || '') === root);
        if (exact) return exact;
        const fuzzy = items.find(i => {
            const t = normalizeSearchKey(i.title || i.name || '');
            return t && (t.includes(root) || root.includes(t));
        });
        if (fuzzy) return fuzzy;
    }
    return items.find(i => (i.type || '').toLowerCase() === 'tv') || items[0];
}

function filterPrecisionResults(query, items, category) {
    if (!Array.isArray(items) || items.length === 0) return items || [];
    const q = normalizeSearchKey(query);
    if (!q) return items;
    const exact = items.filter(i => {
        const title = normalizeSearchKey(i.title || i.name || '');
        const original = normalizeSearchKey(i.original_name || i.original_title || '');
        return title === q || original === q;
    });
    if (exact.length > 0) return exact;

    // Strong containment filter for precision search: hides weak unrelated TMDB/Jikan noise.
    const strong = items.filter(i => {
        const title = normalizeSearchKey(i.title || i.name || '');
        if (!title) return false;
        if (title.includes(q) || q.includes(title)) return true;
        const words = q.match(/[a-z0-9а-яё]+/gi) || [];
        if (words.length >= 2) return words.every(w => title.includes(w));
        return false;
    });
    return strong.length > 0 ? strong : items.slice(0, Math.min(items.length, 8));
}

async function applyAIFranchiseCollapse(query, items, category) {
    if (!Array.isArray(items) || items.length === 0) return items || [];
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.get_ai_franchise_search_plan)) {
        return items;
    }
    try {
        const shortCandidates = items.slice(0, 20).map(i => ({
            id: i.mal_id || i.id,
            mal_id: i.mal_id,
            title: i.title || i.name,
            name: i.name,
            type: i.type,
            episodes: i.episodes,
            year: i.year || (i.aired && i.aired.from ? new Date(i.aired.from).getFullYear() : null)
        }));
        const raw = await window.pywebview.api.get_ai_franchise_search_plan(query, category, JSON.stringify(shortCandidates));
        const plan = JSON.parse(raw || '{}');
        if (!plan || plan.status !== 'success' || !plan.should_collapse || (plan.confidence || 0) < 0.55) {
            return items;
        }
        const root = pickRootCandidateFromAIPlan(items, plan) || items[0];
        const hubTitle = plan.hub_title || plan.canonical_title || root.title || root.name;
        const hub = Object.assign({}, root, {
            title: hubTitle,
            name: hubTitle,
            category: category,
            type: root.type || (category === 'movie' ? 'Movie' : 'TV'),
            episodes: root.episodes || 12,
            franchiseHub: true,
            aiFranchisePlan: plan,
            franchisePartsCount: items.length
        });
        showToast(`Franchise detected: ${hubTitle}`);
        return [hub];
    } catch (e) {
        console.warn('[Franchise Collapse] AI detection failed:', e);
        return items;
    }
}

async function searchCatalog(query) {
    const resultsGrid = document.getElementById('catalog-results');
    if (!resultsGrid) return;
    
    resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Поиск, пожалуйста подождите...</p></div>';
    
    const TMDB_API_KEY = "3d1cb94d909aab088231f5af899dffdc"; // Premium built-in TMDB key
    const catalogLang = containsCyrillic(query) ? 'ru-RU' : 'en-US';
    const effectiveCategory = (activeSearchCategory === 'anime' && looksLikeLiveActionQuery(query)) ? 'show' : activeSearchCategory;
    if (effectiveCategory !== activeSearchCategory) {
        showToast('Detected live-action title — searching TV catalog instead of anime.');
    }

    if (effectiveCategory === 'anime') {
        try {
            const response = await safeFetchJikan(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=24`);
            const json = await response.json();
            
            resultsGrid.innerHTML = '';
            const rawItems = filterPrecisionResults(query, json.data || [], 'anime');
            const aiCollapsed = await applyAIFranchiseCollapse(query, rawItems, 'anime');
            const items = (aiCollapsed === rawItems) ? collapseAnimeSearchResultsToFranchise(query, rawItems) : aiCollapsed;
            
            if (items.length === 0) {
                resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Nothing found.</p></div>';
                return;
            }
            
            items.forEach(item => {
                const card = document.createElement('div');
                card.className = 'media-card';
                
                const shortSynopsis = item.synopsis || "No description available.";
                
                card.innerHTML = `
                    <div class="media-poster-wrapper">
                        <img class="media-poster" src="${item.images.jpg.image_url}" alt="${item.title}">
                        <div class="media-hover-overlay">
                            <p class="media-hover-desc">${shortSynopsis}</p>
                            <p style="font-size: 0.68rem; color: #7c5cfc; font-weight: 600; margin-top: 4px;">Click for details</p>
                        </div>
                    </div>
                    <div class="media-card-info">
                        <div class="media-card-title" title="${item.title}">${item.title}</div>
                        <div class="media-card-meta">${item.franchiseHub ? 'FRANCHISE HUB • ' + item.franchisePartsCount + ' parts' : (item.type || 'TV') + ' • ' + (item.episodes || '?') + ' eps.'}</div>
                    </div>
                `;
                
                bindMediaCardEvents(card, item, true);
                resultsGrid.appendChild(card);
            });
        } catch (err) {
            console.error("Anime search failed:", err);
            resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Search error. Check your internet connection.</p></div>';
        }
    } else if (effectiveCategory === 'movie') {
        // Query TMDB API for ALL global and popular movies (e.g. Bruno, Borat, Inception, etc.) in Russian!
        try {
            const response = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${catalogLang}`);
            const json = await response.json();
            
            resultsGrid.innerHTML = '';
            const rawItems = filterPrecisionResults(query, json.results || [], 'movie');
            const aiCollapsed = await applyAIFranchiseCollapse(query, rawItems, 'movie');
            const items = (aiCollapsed === rawItems) ? collapseMovieSearchResultsToFranchise(query, rawItems) : aiCollapsed;
            
            if (items.length === 0) {
                resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>No movies found.</p></div>';
                return;
            }
            
            items.forEach(show => {
                const card = document.createElement('div');
                card.className = 'media-card';
                
                const posterUrl = show.poster_path ? `https://image.tmdb.org/t/p/w300${show.poster_path}` : DEFAULT_POSTER_DATA;
                const summaryText = show.overview || "Описание временно отсутствует.";
                const premieredYear = show.release_date ? new Date(show.release_date).getFullYear() : '?';
                const scoreVal = show.vote_average ? show.vote_average.toFixed(1) : null;
                
                card.innerHTML = `
                    <div class="media-poster-wrapper">
                        <img class="media-poster" src="${posterUrl}" alt="${show.title}">
                        <div class="media-hover-overlay">
                            <p class="media-hover-desc">${summaryText}</p>
                            <p style="font-size: 0.68rem; color: #7c5cfc; font-weight: 600; margin-top: 4px;">Click for details</p>
                        </div>
                    </div>
                    <div class="media-card-info">
                        <div class="media-card-title" title="${show.title}">${show.title}</div>
                        <div class="media-card-meta">${show.franchiseHub ? 'FRANCHISE HUB • Watch order' : premieredYear + ' • Movie ' + (scoreVal ? '• ★ ' + scoreVal : '')}</div>
                    </div>
                `;
                
                const mappedItem = {
                    mal_id: show.id, // Use TMDB ID
                    title: show.title,
                    category: 'movie',
                    type: 'Movie',
                    images: { jpg: { image_url: posterUrl } },
                    synopsis: summaryText,
                    status: 'Released',
                    episodes: 1, // Movie has 1 episode/part
                    score: scoreVal,
                    studios_str: '-',
                    genres_str: 'Movie',
                    source: 'Theatrical',
                    aired: { from: show.release_date || null }
                };
                
                bindMediaCardEvents(card, mappedItem, true);
                resultsGrid.appendChild(card);
            });
        } catch (err) {
            console.error("TMDB Movie search failed:", err);
            resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Search error. Check your internet connection.</p></div>';
        }
    } else {
        // Query TMDB API for ALL global TV series (Netflix, HBO, Amazon, etc.) in Russian!
        try {
            const response = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&language=${catalogLang}`);
            const json = await response.json();
            
            resultsGrid.innerHTML = '';
            const rawItems = filterPrecisionResults(query, json.results || [], 'show');
            const items = await applyAIFranchiseCollapse(query, rawItems, 'show');
            
            if (items.length === 0) {
                resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>No shows found.</p></div>';
                return;
            }
            
            for (const show of items) {
                const card = document.createElement('div');
                card.className = 'media-card';

                let showDetails = null;
                try {
                    const detailRes = await fetch(`https://api.themoviedb.org/3/tv/${show.id}?api_key=${TMDB_API_KEY}&language=${catalogLang}`);
                    showDetails = await detailRes.json();
                } catch(e) {}
                
                const posterUrl = show.poster_path ? `https://image.tmdb.org/t/p/w300${show.poster_path}` : DEFAULT_POSTER_DATA;
                const summaryText = show.overview || (showDetails && showDetails.overview) || "Описание временно отсутствует.";
                const premieredYear = show.first_air_date ? new Date(show.first_air_date).getFullYear() : '?';
                const scoreVal = show.vote_average ? show.vote_average.toFixed(1) : null;
                const tvStatus = showDetails && showDetails.status ? showDetails.status : 'Unknown';
                const tvEpisodes = showDetails && showDetails.number_of_episodes ? showDetails.number_of_episodes : 12;
                const tvGenres = showDetails && Array.isArray(showDetails.genres) ? showDetails.genres.map(g => g.name).join(', ') : 'Show';
                const tvNetworks = showDetails && Array.isArray(showDetails.networks) ? showDetails.networks.map(n => n.name).join(', ') : '-';
                
                card.innerHTML = `
                    <div class="media-poster-wrapper">
                        <img class="media-poster" src="${posterUrl}" alt="${show.name}">
                        <div class="media-hover-overlay">
                            <p class="media-hover-desc">${summaryText}</p>
                            <p style="font-size: 0.68rem; color: #7c5cfc; font-weight: 600; margin-top: 4px;">Click for details</p>
                        </div>
                    </div>
                    <div class="media-card-info">
                        <div class="media-card-title" title="${show.name}">${show.name}</div>
                        <div class="media-card-meta">${premieredYear} • Show ${scoreVal ? '• ★ ' + scoreVal : ''}</div>
                    </div>
                `;
                
                const mappedItem = {
                    mal_id: show.id, // Use TMDB TV ID
                    title: show.name,
                    category: 'show',
                    type: 'TV',
                    images: { jpg: { image_url: posterUrl } },
                    synopsis: summaryText,
                    status: tvStatus === 'Ended' ? 'Completed' : tvStatus,
                    episodes: tvEpisodes,
                    score: scoreVal,
                    studios_str: tvNetworks,
                    genres_str: tvGenres,
                    source: 'TV Broadcast',
                    aired: { from: show.first_air_date || null }
                };
                
                bindMediaCardEvents(card, mappedItem, true);
                resultsGrid.appendChild(card);
            }
        } catch (err) {
            console.error("TMDB TV search failed:", err);
            resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Search error. Check your internet connection.</p></div>';
        }
    }
}

async function fetchFranchiseRelations(animeId) {
    try {
        if (activeLibraryItem && activeLibraryItem.category === 'movie' && !activeLibraryItem.franchiseHub) {
            return `<div class="details-empty-note">Standalone movie · no required franchise watch order</div>`;
        }
        if (activeLibraryItem && activeLibraryItem.category === 'show' && !activeLibraryItem.franchiseHub) {
            return `<div class="details-empty-note">Standalone show · no required franchise watch order</div>`;
        }
        const fullChrono = await getRecursiveFranchiseChronology(animeId);
        if (!fullChrono || fullChrono.length === 0) {
            const kind = activeLibraryItem && activeLibraryItem.category === 'show' ? 'Standalone show' : (activeLibraryItem && activeLibraryItem.category === 'movie' ? 'Standalone movie' : 'Standalone title');
            return `<div class="details-empty-note">${kind} · no required franchise watch order</div>`;
        }

        const ordered = [...fullChrono].sort((a, b) => {
            const orderA = a.order || 999;
            const orderB = b.order || 999;
            if (orderA !== orderB) return orderA - orderB;
            return (a.year || 9999) - (b.year || 9999);
        });

        let chronologyHTML = `<div class="details-chrono-list">`;
        ordered.forEach((entry, idx) => {
            const relation = entry.relation ? translateRelationLabel(entry.relation) : 'Watch order';
            const epInfo = entry.episodes ? `${entry.episodes} ep.` : '';
            chronologyHTML += `
                <div class="details-chrono-item ${activeLibraryItem && String(activeLibraryItem.title || '').toLowerCase() === String(entry.name || '').toLowerCase() ? 'is-current' : ''}">
                    <div class="details-chrono-index">${String(idx + 1).padStart(2, '0')}</div>
                    <div class="details-chrono-main">
                        <div class="details-chrono-name" title="${entry.name || ''}">${entry.name || 'Untitled'}</div>
                        <div class="details-chrono-meta">
                            <span>${relation}</span>
                            ${entry.year ? `<span>${entry.year}</span>` : ''}
                            ${epInfo ? `<span>${epInfo}</span>` : ''}
                        </div>
                    </div>
                </div>
            `;
        });
        chronologyHTML += `</div>`;
        return chronologyHTML;
    } catch (e) {
        console.error("Failed to fetch recursive relations:", e);
        return `<div class="details-empty-note error">Failed to load chronology</div>`;
    }
}

function openCatalogItemDetails(item) {
    const detailsPanel = document.getElementById('details-panel');
    const detailsContent = document.getElementById('details-content');
    if (!detailsPanel || !detailsContent) return;
    
    // Map catalog item to our library schema. Respect explicit TMDB category to prevent live-action TV becoming ANIME.
    const typeLower = (item.type || 'TV').toLowerCase();
    let category = item.category || 'anime';
    if (!item.category && typeLower.includes('movie')) {
        category = 'movie';
    }
    
    // Extract all possible English, Japanese, and synonyms titles for 100% accurate fuzzy auto-linking!
    const allTitles = [item.title];
    if (item.title_english) allTitles.push(item.title_english);
    if (item.title_japanese) allTitles.push(item.title_japanese);
    if (item.titles) {
        item.titles.forEach(t => {
            if (t.title) allTitles.push(t.title);
        });
    }
    
    // Check if already in library
    const existing = (library[category] || []).find(i => i.id === item.mal_id);
    const inLibrary = !!existing;
    
    const episodesCount = item.episodes || 12;
    const episodesList = existing ? existing.episodes : Array.from({length: episodesCount}, (_, i) => ({
        num: i + 1,
        path: '',
        name: ''
    }));
    
    activeLibraryItem = {
        id: item.mal_id,
        title: item.title,
        poster: item.images.jpg.image_url,
        category: category,
        synopsis: item.synopsis || "No description available.",
        status: item.status || "Unknown",
        episodes: episodesList,
        all_titles: allTitles, // Save all title variants!
        franchiseHub: !!item.franchiseHub,
        aiFranchisePlan: item.aiFranchisePlan || null
    };
    
    renderDetailsContent(activeLibraryItem, inLibrary);
    detailsPanel.classList.add('show');
    
    // Fetch and dynamically inject relations!
    fetchFranchiseRelations(item.mal_id).then(chronoHTML => {
        activeLibraryItem.chronology = chronoHTML;
        const chronoContainer = document.getElementById('details-chronology-container');
        if (chronoContainer) {
            chronoContainer.innerHTML = chronoHTML;
        }
    });
}

function renderDetailsContent(item, inLibrary) {
    const detailsContent = document.getElementById('details-content');
    if (!detailsContent) return;
    
    const newsText = item.status === "Currently Airing" ? "New episode releases this week" : "Finished airing · all episodes available";
    const chronoContent = item.chronology || `<div class="details-empty-note loading">Loading franchise chronology…</div>`;
    const isMovieLike = item.category === 'movie' || (item.type || '').toLowerCase().includes('movie') || (item.episodes && item.episodes.length === 1);
    const mediaSectionTitle = isMovieLike ? 'Movie file' : 'Episodes';
    const linkedCount = (item.episodes || []).filter(e => e.path).length;
    const totalCount = (item.episodes || []).length || 1;
    const mediaLinkedText = isMovieLike
        ? (linkedCount ? 'File linked' : 'No file linked')
        : `${linkedCount} / ${totalCount} linked`;
    const poster = item.poster || DEFAULT_POSTER_DATA;
    const category = String(item.category || 'title').toUpperCase();
    
    let html = `
        <section class="details-hero-card">
            <div class="details-hero-bg" style="background-image:url('${poster}')"></div>
            <div class="details-hero-content">
                <img class="details-poster" src="${poster}" alt="${item.title || 'Poster'}">
                <div class="details-hero-info">
                    <div class="details-kicker-row">
                        <span class="details-type-pill">${category}</span>
                        <span class="details-status-dot"></span>
                        <span class="details-muted-mini">${item.status || 'Library title'}</span>
                    </div>
                    <h3 class="details-title" title="${item.title || ''}">${item.title || 'Untitled'}</h3>
                    <button class="details-library-btn ${inLibrary ? 'danger' : 'primary'}" id="lib-action-btn">
                        <span>${inLibrary ? 'Remove from Library' : 'Add to Library'}</span>
                    </button>
                </div>
            </div>
        </section>
        
        <section class="details-card details-description-card">
            <div class="details-section-head">
                <h4>Description</h4>
            </div>
            <p class="details-description">${item.synopsis || 'No description available.'}</p>
        </section>
        
        <section class="details-news-card">
            <div class="details-news-icon">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
                </svg>
            </div>
            <div>
                <div class="details-news-label">Status</div>
                <div class="details-news-text">${newsText}</div>
            </div>
        </section>

        <section class="details-card details-chrono-card">
            <div class="details-section-head">
                <div>
                    <h4>Watch order</h4>
                    <p>Franchise chronology and related entries</p>
                </div>
            </div>
            <div id="details-chronology-container" class="details-chronology-container">
                ${chronoContent}
            </div>
        </section>
        
        <section class="details-media-section">
            <div class="details-section-head compact">
                <h4>${mediaSectionTitle}</h4>
                <span>${mediaLinkedText}</span>
            </div>
            <div class="details-episodes-list" id="details-episodes-list">
                <!-- Episodes lists injected here -->
            </div>
        </section>
    `;
    
    detailsContent.innerHTML = html;
    
    const libActionBtn = document.getElementById('lib-action-btn');
    bindEvent(libActionBtn, 'click', () => {
        if (inLibrary) {
            library[item.category] = (library[item.category] || []).filter(i => i.id !== item.id);
            saveLibrary();
            showToast("Removed from Library");
            renderDetailsContent(item, false);
            renderLibraryGrid();
        } else {
            if (!library[item.category]) library[item.category] = [];
            library[item.category].push(item);
            saveLibrary();
            showToast("Added to Library");
            renderDetailsContent(item, true);
            renderLibraryGrid();
        }
    });
    
    renderEpisodesList(item, inLibrary);
}

function showTvStreamPanel(data = null) {
    let overlay = document.getElementById('tv-stream-host-panel');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'tv-stream-host-panel';
        overlay.className = 'watch-together-host-panel';
        overlay.innerHTML = `
            <div class="watch-room-card tv-host-card">
                <div class="watch-room-head">
                    <div>
                        <div class="watch-room-kicker">TV STREAM</div>
                        <div class="watch-room-title" id="tv-stream-title">Browser compatible stream</div>
                    </div>
                    <button class="watch-room-close" id="tv-stream-close">×</button>
                </div>
                <div class="tv-pin-box">
                    <div class="tv-pin-label">STREAM CODE</div>
                    <div class="tv-pin-value" id="tv-stream-pin">------</div>
                </div>
                <div class="watch-room-status" id="tv-stream-status">Starting FFmpeg H264 AAC stream…</div>
                <div class="watch-room-link" id="tv-stream-link"></div>
                <div class="watch-room-actions">
                    <button id="tv-stream-copy" class="watch-room-btn primary">Copy stream link</button>
                    <button id="tv-stream-open" class="watch-room-btn">Open here</button>
                    <button id="tv-stream-stop" class="watch-room-btn danger">Close panel</button>
                </div>
                <div class="watch-room-note">Use this when TV cannot play MKV HEVC audio/video. It transcodes to H264 AAC HLS. It still requires the TV to reach this PC over LAN/VPN.</div>
            </div>`;
        document.body.appendChild(overlay);
        document.getElementById('tv-stream-close').onclick = () => overlay.classList.add('hidden');
        document.getElementById('tv-stream-stop').onclick = () => overlay.classList.add('hidden');
        document.getElementById('tv-stream-copy').onclick = async () => {
            const link = document.getElementById('tv-stream-link')?.dataset.direct || '';
            try { await navigator.clipboard.writeText(link); showToast('TV stream link copied'); } catch(e) { alert(link); }
        };
        document.getElementById('tv-stream-open').onclick = () => {
            const link = document.getElementById('tv-stream-link')?.dataset.direct || '';
            if (link) window.open(link, '_blank');
        };
    }
    if (data) {
        const code = data.code || data.pin || '------';
        const links = data.urls || [];
        const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
        const preferred = wifiLan || links[0] || { url: data.lan_url || data.local_url || '' };
        const direct = preferred.url || data.lan_url || data.local_url || '';
        const pinEl = document.getElementById('tv-stream-pin');
        const linkEl = document.getElementById('tv-stream-link');
        if (pinEl) pinEl.textContent = code;
        if (linkEl) {
            linkEl.dataset.direct = direct;
            const extra = links.length ? '\n\nDetected links:\n' + links.map(u => `${u.label || 'IP'}: ${u.url}`).join('\n') : '';
            linkEl.textContent = `Stream: ${direct}${extra}`;
        }
        pollTvStreamStatus(code);
    }
    overlay.classList.remove('hidden');
}

async function pollTvStreamStatus(code) {
    const status = document.getElementById('tv-stream-status');
    if (!code || !status) return;
    for (let i = 0; i < 720; i++) {
        try {
            const r = await fetch('/api/tv_stream/status/' + encodeURIComponent(code), { cache: 'no-store' });
            const data = await r.json();
            if (data.status === 'success') {
                const st = data.stream || {};
                status.textContent = `${st.message || st.status || 'Streaming'} • ${st.progress || 0}%`;
                if (st.status === 'ready') return;
                if (st.status === 'error') return;
            }
        } catch(e) {
            status.textContent = 'Stream status error: ' + e.message;
            return;
        }
        await sleep(1500);
    }
}

async function createTvStreamRoom(source = null) {
    source = source || (currentIndex >= 0 && playlist[currentIndex] ? { name: playlist[currentIndex].name, path: playlist[currentIndex].path } : null);
    if (!source || !source.path) {
        showToast('TV Stream: choose/open a local video first');
        return;
    }
    try {
        showTaskOverlay('Starting TV stream...', 'Preparing H264/AAC stream for TV browser.');
        clearTimeout(taskOverlaySafetyTimer);
        const res = await fetch('/api/tv_stream/create', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ title: source.name || 'TV Stream', path: source.path })
        });
        const data = await res.json();
        hideTaskOverlay(200);
        if (data.status !== 'success') throw new Error(data.message || 'TV stream create failed');
        const links = data.urls || [];
        const wifiLan = links.find(u => /^192\.168\./.test(String(u.ip || ''))) || links.find(u => /^10\./.test(String(u.ip || ''))) || links.find(u => /^172\./.test(String(u.ip || '')));
        const link = (wifiLan && wifiLan.url) || data.lan_url || data.local_url;
        try { await navigator.clipboard.writeText(link); } catch(e) {}
        showToast('TV stream link copied');
        showTvStreamPanel(data);
    } catch(e) {
        hideTaskOverlay(200);
        console.error('[TV Stream] failed:', e);
        showToast('TV Stream failed: ' + e.message);
    }
}

function castLibraryEpisodeToTvStream(item, epNum) {
    try {
        const ep = (item?.episodes || []).find(e => Number(e.num) === Number(epNum));
        if (!ep || !ep.path) { showToast('TV Stream: no linked file'); return; }
        const isMovie = item.category === 'movie' || (item.episodes || []).length === 1;
        createTvStreamRoom({ name: ep.name || (isMovie ? item.title : `${item.title} E${ep.num}`), path: ep.path });
    } catch(e) {
        showToast('TV Stream failed: ' + e.message);
    }
}

function getSeasonEpisodeDisplay(item, absoluteEp) {
    const title = String(item?.title || '').toLowerCase();
    const n = Number(absoluteEp) || 1;
    let counts = null;
    if (title.includes('mentalist')) counts = [23, 23, 24, 24, 22, 22, 13];
    // Generic fallback for huge flat TV lists: split into 24-episode seasons so UI is not a 160-row wall.
    if (!counts && (item?.category === 'show') && (item.episodes || []).length > 60) {
        counts = [];
        let left = (item.episodes || []).length;
        while (left > 0) { counts.push(Math.min(24, left)); left -= 24; }
    }
    if (!counts) return { season: item?.season || 1, episode: n, label: (item?.category === 'movie' || (item?.episodes || []).length === 1) ? 'Movie' : `Episode ${n}`, seasonStart: n === 1 };
    let acc = 0;
    for (let i = 0; i < counts.length; i++) {
        if (n <= acc + counts[i]) {
            const ep = n - acc;
            return { season: i + 1, episode: ep, label: `S${String(i + 1).padStart(2,'0')}E${String(ep).padStart(2,'0')}`, seasonStart: ep === 1 };
        }
        acc += counts[i];
    }
    return { season: counts.length, episode: n - acc, label: `Episode ${n}`, seasonStart: false };
}

function castLibraryEpisodeToTv(item, epNum) {
    try {
        if (!item) { showToast('TV Mode: no title selected'); return; }
        const ep = (item.episodes || []).find(e => Number(e.num) === Number(epNum));
        if (!ep || !ep.path) { showToast('TV Mode: no linked file for this episode/movie'); return; }
        activeLibraryItem = item;
        activeEpisodeNum = Number(epNum) || 1;
        const isMovie = item.category === 'movie' || (item.episodes || []).length === 1;
        createTvRoom({
            name: ep.name || (isMovie ? item.title : `${item.title} E${ep.num}`),
            path: ep.path,
            label: isMovie ? 'Movie' : `Episode ${ep.num}`
        });
    } catch(e) {
        console.error('[TV Mode] castLibraryEpisodeToTv failed:', e);
        showToast('TV Mode failed: ' + e.message);
    }
}

function castActiveItemToTv() {
    if (!activeLibraryItem || !Array.isArray(activeLibraryItem.episodes)) {
        showToast('TV Mode: open a Library title first');
        return;
    }
    const resumeRaw = localStorage.getItem('resume_info_' + activeLibraryItem.id);
    let resumeEp = null;
    try { if (resumeRaw) resumeEp = JSON.parse(resumeRaw).epNum; } catch(e) {}
    const ep = (resumeEp && activeLibraryItem.episodes.find(e => Number(e.num) === Number(resumeEp) && e.path))
        || activeLibraryItem.episodes.find(e => e && e.path);
    if (!ep) { showToast('TV Mode: no linked files in this title'); return; }
    castLibraryEpisodeToTv(activeLibraryItem, ep.num);
}

function renderEpisodesList(item, inLibrary) {
    const epListContainer = document.getElementById('details-episodes-list');
    if (!epListContainer) return;
    
    epListContainer.innerHTML = '';
    const episodes = item.episodes || [];
    const isMovieLike = item.category === 'movie' || (item.type || '').toLowerCase().includes('movie') || episodes.length === 1;
    
    episodes.forEach(ep => {
        const meta = getSeasonEpisodeDisplay(item, ep.num);
        if (!isMovieLike && meta.seasonStart) {
            const header = document.createElement('div');
            header.className = 'details-season-divider';
            header.textContent = `Season ${meta.season}`;
            epListContainer.appendChild(header);
        }
        const row = document.createElement('div');
        const aired = isEpisodeAired(item, ep.num);
        row.className = `details-episode-row ${!aired ? 'unreleased' : ''} ${ep.path ? 'linked' : ''}`;
        
        const label = isMovieLike ? 'Movie' : meta.label;
        const fileName = ep.name ? ep.name : 'No file linked';
        row.innerHTML = `
            <div class="details-episode-info">
                <div class="details-episode-title-row">
                    <span class="details-episode-title">${label}</span>
                    ${!aired ? '<span class="details-episode-badge unreleased">Unreleased</span>' : ''}
                    ${ep.path ? '<span class="details-episode-badge linked">Linked</span>' : ''}
                </div>
                <div class="details-episode-file" id="ep-name-${ep.num}" title="${fileName}">${fileName}</div>
            </div>
            <div class="details-episode-actions">
                ${ep.path ? 
                    `<button class="details-mini-btn play" id="ep-play-${ep.num}" title="Play ${label}">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                        <span>Play</span>
                    </button>
                    <button class="details-mini-btn tv" id="ep-tv-${ep.num}" title="Open ${label} on TV">
                        <span>TV</span>
                    </button>
                    <button class="details-mini-btn tvstream" id="ep-tvstream-${ep.num}" title="Live stream PC screen to TV">
                        <span>Live</span>
                    </button>
                    <button class="details-mini-btn unlink" id="ep-unlink-btn-${ep.num}" title="Unlink file">
                        <span>Unlink</span>
                    </button>` :
                    `<button class="details-mini-btn link" id="ep-link-${ep.num}" title="Link media file">
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.1-1.1"/></svg>
                        <span>Link File</span>
                    </button>`
                }
            </div>
        `;
        
        epListContainer.appendChild(row);
        
        if (ep.path) {
            const playBtn = document.getElementById(`ep-play-${ep.num}`);
            bindEvent(playBtn, 'click', () => {
                document.getElementById('details-panel').classList.remove('show');
                document.getElementById('tab-load-btn').click();
                playLibraryEpisode(item, ep.num);
            });
            const tvBtn = document.getElementById(`ep-tv-${ep.num}`);
            bindEvent(tvBtn, 'click', () => {
                castLibraryEpisodeToTv(item, ep.num);
            });
            const tvStreamBtn = document.getElementById(`ep-tvstream-${ep.num}`);
            bindEvent(tvStreamBtn, 'click', () => {
                openChromecastCastPanel();
            });

            const unlinkBtn = document.getElementById(`ep-unlink-btn-${ep.num}`);
            bindEvent(unlinkBtn, 'click', () => {
                ep.path = '';
                ep.name = '';
                saveLibrary();
                showToast(`Episode file ${ep.num} unlinked successfully!`);
                renderDetailsContent(item, inLibrary);
                renderLibraryGrid();
            });
        } else {
            const linkBtn = document.getElementById(`ep-link-${ep.num}`);
            bindEvent(linkBtn, 'click', () => {
                if (!inLibrary) {
                    if (!library[item.category]) library[item.category] = [];
                    library[item.category].push(item);
                    saveLibrary();
                    showToast("Title added to Library!");
                    renderDetailsContent(item, true);
                    renderLibraryGrid();
                }
                
                if (window.pywebview && window.pywebview.api) {
                    window.pywebview.api.select_link_file(item.id || item.mal_id, ep.num, item.title);
                } else {
                    showToast("Native file dialog is not available in browser preview");
                }
            });
        }
    });
}

function tryAutoLinkLoadedFile(name, path) {
    // Extract episode number using regex (handles E01, Ep 1, 01, Series 1, etc.)
    const epMatch = name.match(/(?:ep|episode|s\d+e|series|серия|серии)?\s*(\d+)/i);
    if (!epMatch) return;
    const epNum = parseInt(epMatch[1]);
    
    // Clean filename for fuzzy title matching
    const cleanFileName = name.toLowerCase().replace(/[\d_.-]/g, ' ').trim();
    
    let matchedItem = null;
    
    for (const category of ['anime', 'show', 'movie']) {
        const items = library[category] || [];
        for (const item of items) {
            // Check if any stored title variations match!
            const titles = item.all_titles || [item.title];
            const matchesTitle = titles.some(title => {
                const cleanTitle = title.toLowerCase();
                return cleanFileName.includes(cleanTitle) || cleanTitle.includes(cleanFileName);
            });
            
            if (matchesTitle) {
                matchedItem = item;
                break;
            }
        }
        if (matchedItem) break;
    }
    
    if (matchedItem) {
        const ep = matchedItem.episodes.find(e => e.num === epNum);
        if (ep && !ep.path) {
            ep.path = path;
            ep.name = name;
            saveLibrary();
            showToast(`Auto-linked file to "${matchedItem.title}" - Episode ${epNum}!`);
            
            // Refresh details panel if it is currently open for this item!
            if (activeLibraryItem && activeLibraryItem.id === matchedItem.id) {
                renderDetailsContent(matchedItem, true);
            }
            renderLibraryGrid();
        }
    }
}

function triggerNextEpisodeCountdown(nextEp) {
    const overlay = document.getElementById('next-episode-overlay');
    const timerEl = document.getElementById('next-ep-timer');
    const titleEl = document.getElementById('next-ep-title');
    if (!overlay || !timerEl || !titleEl) return;
    
    titleEl.textContent = `Episode ${nextEp.num}: ${nextEp.name}`;
    timerEl.textContent = "5";
    overlay.classList.remove('hidden');
    
    countdownTime = 5;
    clearInterval(countdownInterval);
    
    countdownInterval = setInterval(() => {
        countdownTime--;
        timerEl.textContent = countdownTime;
        if (countdownTime <= 0) {
            clearInterval(countdownInterval);
            overlay.classList.add('hidden');
            playLibraryEpisode(activeLibraryItem, nextEp.num, 0, 'next-auto');
        }
    }, 1000);
    
    // Bind skip/play now button
    const skipBtn = document.getElementById('next-ep-skip-btn');
    bindEvent(skipBtn, 'click', () => {
        clearInterval(countdownInterval);
        overlay.classList.add('hidden');
        playLibraryEpisode(activeLibraryItem, nextEp.num, 0, 'next-auto');
    });
    
    // Bind cancel button
    const cancelBtn = document.getElementById('next-ep-cancel-btn');
    bindEvent(cancelBtn, 'click', () => {
        clearInterval(countdownInterval);
        overlay.classList.add('hidden');
    });
}

async function loadTrendingAnime() {
    const resultsGrid = document.getElementById('catalog-results');
    if (!resultsGrid) return;
    
    // Check if we have a cached version inside localStorage
    const cached = localStorage.getItem('cached_trending_anime');
    if (cached) {
        console.log("[Storage Engine] Loaded trending list instantly from cache!");
        renderTrendingItems(JSON.parse(cached));
        
        // Symmetrically fetch a fresh version silently in the background
        fetchFreshTrendingAnimeSilent();
        return;
    }
    
    resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Loading popular titles, please wait...</p></div>';
    
    try {
        const response = await safeFetchJikan('https://api.jikan.moe/v4/top/anime?limit=24');
        const json = await response.json();
        const items = json.data || [];
        
        if (items.length > 0) {
            localStorage.setItem('cached_trending_anime', JSON.stringify(items));
            renderTrendingItems(items);
        } else {
            resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>List is empty.</p></div>';
        }
    } catch (err) {
        console.warn("Silent Jikan trending load timed out or failed:", err);
        resultsGrid.innerHTML = '<div class="empty-playlist" style="grid-column: 1 / -1; padding: 40px 0;"><p>Server is temporarily unavailable. You can type a title in the search above.</p></div>';
    }
}

function renderTrendingItems(items) {
    const resultsGrid = document.getElementById('catalog-results');
    if (!resultsGrid) return;
    resultsGrid.innerHTML = '';
    
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'media-card';
        
        const shortSynopsis = item.synopsis || "No description available.";
        
        card.innerHTML = `
            <div class="media-poster-wrapper">
                <img class="media-poster" src="${item.images.jpg.image_url}" alt="${item.title}">
                <div class="media-hover-overlay">
                    <p class="media-hover-desc">${shortSynopsis}</p>
                    <p style="font-size: 0.68rem; color: #7c5cfc; font-weight: 600; margin-top: 4px;">Click for details</p>
                </div>
            </div>
            <div class="media-card-info">
                <div class="media-card-title" title="${item.title}">${item.title}</div>
                <div class="media-card-meta">${item.type || 'TV'} • ${item.episodes || '?'} eps.</div>
            </div>
        `;
        
        bindMediaCardEvents(card, item, true);
        resultsGrid.appendChild(card);
    });
}

async function fetchFreshTrendingAnimeSilent() {
    try {
        const response = await safeFetchJikan('https://api.jikan.moe/v4/top/anime?limit=24');
        const json = await response.json();
        const items = json.data || [];
        if (items.length > 0) {
            localStorage.setItem('cached_trending_anime', JSON.stringify(items));
            console.log("[Storage Engine] Silent background trending list refreshed successfully!");
        }
    } catch(e) {
        console.warn("Silent background trending load timed out or failed (expected Jikan limit):", e);
    }
}

/* ======================================================== */
/*              PREMIUM MEDIA CARD INTERACTIVITY            */
/* ======================================================== */

function bindMediaCardEvents(card, item, isCatalog) {
    // Left Click: Open details slide-out
    card.addEventListener('click', (e) => {
        if (e.detail > 1) return; // Ignore on double click
        if (isCatalog) {
            openCatalogItemDetails(item);
        } else {
            showLibraryItemDetails(item);
        }
    });

    // Double Click: Open HDRezka cinematic Series Page
    card.addEventListener('dblclick', (e) => {
        e.preventDefault();
        openHDRezkaPage(item);
    });

    // Right Click: Show custom context menu
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCustomContextMenu(e.clientX, e.clientY, item, isCatalog);
    });
}

function normalizeMediaItem(item) {
    // Safe normalization
    if (item.id && !item.mal_id) {
        if (!item.category) {
            item.category = 'anime';
        }
        const existing = (library[item.category] || []).find(i => i.id === item.id);
        return {
            item: existing || item,
            inLibrary: !!existing
        };
    }
    
    const malId = item.mal_id;
    const typeLower = (item.type || 'TV').toLowerCase();
    let category = item.category || 'anime';
    if (!item.category && typeLower.includes('movie')) {
        category = 'movie';
    }
    
    const existing = (library[category] || []).find(i => i.id === malId);
    
    const allTitles = [item.title];
    if (item.title_english) allTitles.push(item.title_english);
    if (item.title_japanese) allTitles.push(item.title_japanese);
    if (item.titles) {
        item.titles.forEach(t => {
            if (t.title) allTitles.push(t.title);
        });
    }
    
    const episodesCount = item.episodes || 12;
    const episodesList = existing ? existing.episodes : Array.from({length: episodesCount}, (_, i) => ({
        num: i + 1,
        path: '',
        name: ''
    }));
    
    const studiosList = item.studios ? item.studios.map(s => s.name).join(', ') : (item.studios_str || '-');
    const genresList = item.genres ? item.genres.map(g => g.name).join(', ') : (item.genres_str || '-');

    const normalized = {
        id: malId,
        title: item.title,
        poster: item.images ? item.images.jpg.image_url : (item.poster || ''),
        category: category,
        synopsis: item.synopsis || "No description available.",
        status: item.status || "Unknown",
        episodes: episodesList,
        all_titles: allTitles,
        aired_from: item.aired ? item.aired.from : (item.aired_from || null),
        score: item.score || item.score_val || null,
        studios_str: studiosList,
        genres_str: genresList,
        source: item.source || '-',
        rank: item.rank || null,
        rating: item.rating || '-',
        franchiseHub: !!item.franchiseHub,
        aiFranchisePlan: item.aiFranchisePlan || null
    };
    
    return {
        item: existing || normalized,
        inLibrary: !!existing
    };
}

function updateHDRezkaMetadataUI(item) {
    if (!item) return;
    const studioEl = document.getElementById('hdrezka-studio');
    if (studioEl) studioEl.textContent = item.studios_str || '-';

    const genresEl = document.getElementById('hdrezka-genres');
    if (genresEl) genresEl.textContent = item.genres_str || '-';

    const sourceEl = document.getElementById('hdrezka-source');
    if (sourceEl) sourceEl.textContent = item.source || '-';

    // Synopsis can arrive later with the chronology metadata.
    const synopsisEl = document.getElementById('hdrezka-synopsis');
    if (synopsisEl && item.synopsis) synopsisEl.textContent = item.synopsis;

    const scoreEl = document.getElementById('hdrezka-score');
    if (scoreEl) {
        scoreEl.innerHTML = item.score ? `<span style="color: #ffb800; font-weight: 700;">★ ${item.score}</span>` : '-';
    }

    const statusPill = document.getElementById('hdrezka-status');
    if (statusPill) statusPill.textContent = item.status || "Unknown";
}

async function openHDRezkaPage(rawItem) {
    const { item, inLibrary } = normalizeMediaItem(rawItem);
    applyKnownMetadataFallback(item);
    activeLibraryItem = item;
    
    // Explicitly close details slide-out panel to prevent overlap!
    const detailsPanel = document.getElementById('details-panel');
    if (detailsPanel) {
        detailsPanel.classList.remove('show');
    }
    
    const page = document.getElementById('hdrezka-page');
    if (!page) return;
    
    // Background poster blur
    const bg = document.getElementById('hdrezka-bg');
    if (bg) bg.style.backgroundImage = `url(${item.poster})`;
    
    // Main poster image
    const poster = document.getElementById('hdrezka-poster');
    if (poster) poster.src = item.poster;
    
    // Title, alt titles, synopsis
    const title = document.getElementById('hdrezka-title');
    if (title) title.textContent = item.title;
    
    const altTitles = document.getElementById('hdrezka-alt-titles');
    if (altTitles) {
        const uniqueAlts = [...new Set(item.all_titles || [])].filter(t => t !== item.title);
        altTitles.textContent = uniqueAlts.length > 0 ? uniqueAlts.slice(0, 3).join(' • ') : '';
    }
    
    const synopsis = document.getElementById('hdrezka-synopsis');
    if (synopsis) synopsis.textContent = item.synopsis || "No description available.";

    // Populate premium specifications grid!
    updateHDRezkaMetadataUI(item);
    
    // Metadata pills
    const typePill = document.getElementById('hdrezka-type');
    if (typePill) typePill.textContent = item.category.toUpperCase();
    
    const statusPill = document.getElementById('hdrezka-status');
    if (statusPill) statusPill.textContent = item.status || "Unknown";
    
    const epCountPill = document.getElementById('hdrezka-ep-count');
    if (epCountPill) epCountPill.textContent = `${item.episodes.length} Episodes`;
    
    updateHDRezkaLibButton(inLibrary);
    renderHDRezkaSeasons();
    
    // Hide panel until loaded
    const epDescPanel = document.getElementById('hdrezka-episode-desc-panel');
    if (epDescPanel) epDescPanel.classList.add('hidden');
    
    // Fetch episode descriptions in background and show the first episode by default!
    fetchEpisodeDetailsForActiveItem(item.id).then(eps => {
        if (eps && eps.length > 0) {
            showHDRezkaEpisodeDescription(eps, 1);
            // Re-render after episode metadata arrives so unreleased future episodes become visibly marked.
            renderHDRezkaEpisodes();
        } else {
            if (epDescPanel) epDescPanel.classList.add('hidden');
        }
    });

    // Show overlay
    page.classList.remove('hidden');
    
    // Hide default viewports to prevent layout collisions
    document.getElementById('player-viewport').classList.add('hidden');
    document.getElementById('search-view').classList.add('hidden');
    
    // Chronology is now shown once, inside the premium watch-order strip above tabs.
    // The old bottom duplicate chronology block was removed from the UI.
}

function updateHDRezkaLibButton(inLibrary) {
    const btn = document.getElementById('hdrezka-lib-btn');
    if (!btn) return;
    
    if (inLibrary) {
        btn.textContent = "Remove from Library";
        btn.style.background = "rgba(239, 68, 68, 0.15)";
        btn.style.borderColor = "rgba(239, 68, 68, 0.3)";
        btn.style.color = "#ef4444";
    } else {
        btn.textContent = "Add to Library";
        btn.style.background = "#7c5cfc";
        btn.style.borderColor = "#7c5cfc";
        btn.style.color = "#fff";
    }
}

async function renderHDRezkaSeasons() {
    const bar = document.getElementById('hdrezka-seasons-bar');
    if (!bar) return;
    
    bar.innerHTML = '';
    
    const fullChrono = await getRecursiveFranchiseChronology(activeLibraryItem.id);
    
    const activeTitleKey = (activeLibraryItem.title || '').toLowerCase().replace(/[^a-z0-9а-яё一-龯ぁ-んァ-ン]/gi, '');
    const activeChronoMeta = fullChrono.find(p => {
        const pKey = (p.name || '').toLowerCase().replace(/[^a-z0-9а-яё一-龯ぁ-んァ-ン]/gi, '');
        return p.id === activeLibraryItem.id || (pKey && activeTitleKey && pKey === activeTitleKey);
    });

    const seasonsList = [
        {
            id: activeLibraryItem.id,
            order: activeChronoMeta ? activeChronoMeta.order : 1,
            relation: activeChronoMeta ? activeChronoMeta.relation : 'Main story',
            name: activeLibraryItem.title,
            category: activeLibraryItem.category,
            episodes: activeLibraryItem.episodes,
            synopsis: activeLibraryItem.synopsis,
            status: activeLibraryItem.status,
            poster: activeLibraryItem.poster,
            all_titles: activeLibraryItem.all_titles,
            studios_str: activeLibraryItem.studios_str,
            genres_str: activeLibraryItem.genres_str,
            source: activeLibraryItem.source,
            score: activeLibraryItem.score
        }
    ];
    
    fullChrono.forEach((part) => {
        const pKey = (part.name || '').toLowerCase().replace(/[^a-z0-9а-яё一-龯ぁ-んァ-ン]/gi, '');
        if (part.id === activeLibraryItem.id || (pKey && activeTitleKey && pKey === activeTitleKey)) {
            return;
        }
        let libPart = null;
        for (const cat of ['anime', 'show', 'movie']) {
            libPart = (library[cat] || []).find(i => i.id === part.id);
            if (libPart) break;
        }
        
        const episodesCount = part.episodes || 12;
        const epList = libPart ? libPart.episodes : Array.from({length: episodesCount}, (_, i) => ({
            num: i + 1,
            path: '',
            name: ''
        }));
        
        seasonsList.push({
            id: part.id,
            order: part.order || 999,
            relation: part.relation || '',
            name: part.name,
            category: activeLibraryItem.category || 'anime',
            episodes: epList,
            synopsis: libPart ? libPart.synopsis : "Description loads when selected...",
            status: libPart ? libPart.status : "Completed",
            poster: libPart ? libPart.poster : activeLibraryItem.poster,
            all_titles: [part.name],
            studios_str: libPart ? libPart.studios_str : '-',
            genres_str: libPart ? libPart.genres_str : '-',
            source: part.source || '-',
            score: part.score || null,
            year: part.year || 0
        });
    });
    
    // Sort by AI-defined watch order first, then year. This prevents complex franchises from becoming database soup.
    seasonsList.sort((a, b) => {
        const orderA = a.order || 999;
        const orderB = b.order || 999;
        if (orderA !== orderB) return orderA - orderB;
        const yearA = a.year || (a.aired_from ? new Date(a.aired_from).getFullYear() : 0) || 2026;
        const yearB = b.year || (b.aired_from ? new Date(b.aired_from).getFullYear() : 0) || 2026;
        return yearA - yearB;
    });

    seasonsList.forEach((season, idx) => {
        const tab = document.createElement('button');
        const isCurrent = season.id === activeLibraryItem.id;
        tab.className = `hdrezka-season-tab ${isCurrent ? 'active' : ''}`;
        
        const cleanName = String(season.name || 'Untitled').trim();
        const relationLabel = translateRelationLabel(season.relation || season.type || 'Main story');
        const epCount = Array.isArray(season.episodes) ? season.episodes.length : (season.episodes || 0);
        const yearLabel = season.year ? `${season.year}` : '';
        tab.innerHTML = `
            <span class="part-num">${String(idx + 1).padStart(2, '0')}</span>
            <span class="part-copy">
                <span class="part-title" title="${cleanName}">${cleanName}</span>
                <span class="part-meta">
                    <span>${relationLabel}</span>
                    ${yearLabel ? `<span>${yearLabel}</span>` : ''}
                    ${epCount ? `<span>${epCount} ep.</span>` : ''}
                </span>
            </span>`;
        
        tab.addEventListener('click', () => {
            activeLibraryItem = season;
            
            document.querySelectorAll('.hdrezka-season-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            renderHDRezkaEpisodes();
            
            const poster = document.getElementById('hdrezka-poster');
            if (poster && season.poster) poster.src = season.poster;
            
            const title = document.getElementById('hdrezka-title');
            if (title) title.textContent = season.name;
            
            const synopsis = document.getElementById('hdrezka-synopsis');
            if (synopsis) synopsis.textContent = season.synopsis || "No description available.";
            
            const studioEl = document.getElementById('hdrezka-studio');
            if (studioEl) studioEl.textContent = season.studios_str || '-';
            
            const genresEl = document.getElementById('hdrezka-genres');
            if (genresEl) genresEl.textContent = season.genres_str || '-';
            
            const scoreEl = document.getElementById('hdrezka-score');
            if (scoreEl) {
                scoreEl.innerHTML = season.score ? `<span style="color: #ffb800; font-weight: 700;">★ ${season.score}</span>` : '-';
            }
            
            fetchEpisodeDetailsForActiveItem(season.id).then(eps => {
                if (eps && eps.length > 0) {
                    showHDRezkaEpisodeDescription(eps, 1);
                    renderHDRezkaEpisodes();
                } else {
                    document.getElementById('hdrezka-episode-desc-panel').classList.add('hidden');
                }
            });
        });
        
        bar.appendChild(tab);
    });
    
    setupFranchiseResumeBanner(seasonsList);
    renderHDRezkaEpisodes();
}

function renderHDRezkaEpisodes() {
    const grid = document.getElementById('hdrezka-episodes-grid');
    const counter = document.getElementById('hdrezka-linked-counter');
    if (!grid || !activeLibraryItem) return;
    
    grid.innerHTML = '';
    const episodes = activeLibraryItem.episodes || [];
    const linkedCount = episodes.filter(e => e.path).length;
    const isMovieLike = (activeLibraryItem.type || '').toLowerCase().includes('movie') || activeLibraryItem.category === 'movie' || episodes.length === 1;
    const titleEl = document.getElementById('hdrezka-episodes-title');
    if (titleEl) titleEl.textContent = isMovieLike ? 'Movie / Special' : 'Episodes';
    
    if (counter) {
        counter.textContent = isMovieLike ? (linkedCount ? 'File linked' : 'No file linked') : `${linkedCount} / ${episodes.length} linked`;
        let tvCastBtn = document.getElementById('hdrezka-tv-cast-btn');
        if (linkedCount && !tvCastBtn) {
            tvCastBtn = document.createElement('button');
            tvCastBtn.id = 'hdrezka-tv-cast-btn';
            tvCastBtn.className = 'hdrezka-tv-cast-btn';
            tvCastBtn.textContent = 'TV Mode';
            tvCastBtn.title = 'Cast selected/first linked file to TV';
            counter.parentElement.appendChild(tvCastBtn);
            const tvStreamBtn = document.createElement('button');
            tvStreamBtn.id = 'hdrezka-tv-stream-btn';
            tvStreamBtn.className = 'hdrezka-tv-cast-btn';
            tvStreamBtn.textContent = 'Live Stream';
            tvStreamBtn.title = 'Live stream PC screen to TV/browser';
            counter.parentElement.appendChild(tvStreamBtn);
        }
        if (tvCastBtn) {
            tvCastBtn.style.display = linkedCount ? '' : 'none';
            tvCastBtn.onclick = () => castActiveItemToTv();
        }
        const tvStreamBtn = document.getElementById('hdrezka-tv-stream-btn');
        if (tvStreamBtn) {
            tvStreamBtn.style.display = linkedCount ? '' : 'none';
            tvStreamBtn.onclick = () => openChromecastCastPanel();
        }
    }
    grid.classList.toggle('movie-mode', isMovieLike);
    
    let resumeEp = null;
    let resumeTime = 0;
    try {
        const savedResume = localStorage.getItem('resume_info_' + activeLibraryItem.id);
        if (savedResume) {
            const parsed = JSON.parse(savedResume);
            resumeEp = parsed.epNum;
            resumeTime = parsed.time;
        }
    } catch(e) {}

    episodes.forEach(ep => {
        const btn = document.createElement('button');
        btn.className = `hdrezka-ep-btn ${isMovieLike ? 'movie-card' : ''}`;
        const aired = isEpisodeAired(activeLibraryItem, ep.num);
        const watchedKey = `watched_${activeLibraryItem.id}_${ep.num}`;
        const isResume = resumeEp === ep.num;
        const meta = getSeasonEpisodeDisplay(activeLibraryItem, ep.num);
        const fileTitle = ep.name || (isMovieLike ? 'Movie file is not linked' : 'No file linked');
        
        if (!aired) btn.classList.add('unreleased');
        if (ep.path) btn.classList.add('linked');
        if (activeEpisodeNum === ep.num) btn.classList.add('playing');
        if (localStorage.getItem(watchedKey) === 'true') btn.classList.add('watched');
        if (isResume) btn.classList.add('resume');

        if (isMovieLike) {
            btn.innerHTML = `
                <span class="hdrezka-ep-number">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                </span>
                ${ep.path ? `<span class="ep-unlink-badge" title="Unlink file">×</span>` : ''}
            `;
        } else {
            btn.innerHTML = `
                <span class="hdrezka-ep-number">${meta.episode}</span>
                ${ep.path ? `<span class="ep-unlink-badge" title="Unlink file">×</span>` : ''}
            `;
        }

        if (!aired) {
            btn.setAttribute('title', `${isMovieLike ? 'movie/special' : 'Episode ' + ep.num} is not released yet`);
        } else if (isResume) {
            btn.setAttribute('title', `Resume watching (${formatTime(resumeTime)})`);
        } else if (ep.path) {
            btn.setAttribute('title', ep.name || 'Linked file');
        } else {
            btn.setAttribute('title', isMovieLike ? 'Movie file is not linked. Click to link.' : 'No file linked. Click to link.');
        }
        
        btn.addEventListener('mouseenter', () => {
            if (activeLibraryItem) {
                const eps = episodesDetailsCache.get(activeLibraryItem.id);
                if (eps) showHDRezkaEpisodeDescription(eps, ep.num);
            }
        });

        btn.addEventListener('click', () => {
            if (ep.path) {
                document.getElementById('hdrezka-page').classList.add('hidden');
                document.getElementById('player-viewport').classList.remove('hidden');
                document.getElementById('tab-load-btn').click();
                const startTime = (resumeEp === ep.num) ? resumeTime : 0;
                playLibraryEpisode(activeLibraryItem, ep.num, startTime);
                localStorage.setItem(watchedKey, 'true');
                btn.classList.add('watched');
            } else {
                if (!aired) {
                    showToast(`Warning: ${isMovieLike ? 'movie/special' : 'episode ' + ep.num} is not released yet, but you can still link a local file!`);
                }
                linkFileForEpisodeInRezka(ep.num);
            }
        });

        const unlinkBadge = btn.querySelector('.ep-unlink-badge');
        if (unlinkBadge) {
            unlinkBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                ep.path = '';
                ep.name = '';
                saveLibrary();
                showToast(`Episode file ${ep.num} unlinked successfully!`);
                renderHDRezkaEpisodes();
                renderLibraryGrid();
            });
        }
        
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showEpisodeContextMenu(e.clientX, e.clientY, ep.num);
        });
        
        grid.appendChild(btn);
    });
}

function playLibraryEpisode(item, epNum, startTime = 0, source = 'episode-grid') {
    try {
        if (!item) {
            showToast('Nothing to play: Library item missing');
            return;
        }
        const ep = (item.episodes || []).find(e => Number(e.num) === Number(epNum));
        if (!ep || !ep.path) {
            showToast('No linked file for this episode/movie');
            console.warn('[Play Library] missing episode/path:', item, epNum);
            return;
        }
        const fileInfo = getFileTypeInfo(ep.name || ep.path || 'media.mkv');
        activeLibraryItem = item;
        activeEpisodeNum = Number(epNum) || 1;
        beginWatchSession(item, activeEpisodeNum, startTime || 0, source);
        playlist = [{
            name: ep.name || (ep.path ? ep.path.split(/[\\/]/).pop() : 'Linked media'),
            path: ep.path,
            url: `${window.location.origin}/media?path=${encodeURIComponent(ep.path)}`,
            isVideo: true,
            isTS: fileInfo.isTS,
            size: 0,
            audioSidecarPath: ep.audioSidecarPath || '',
            audioCompatMode: ep.audioCompatMode || ''
        }];
        currentIndex = 0;
        savePlaylistPermanently();
        document.getElementById('hdrezka-page')?.classList.add('hidden');
        document.getElementById('details-panel')?.classList.remove('show');
        document.getElementById('player-viewport')?.classList.remove('hidden');
        document.getElementById('tab-load-btn')?.click();
        playTrack(0).then(() => {
            if (startTime > 0 && DOM.player) {
                setTimeout(() => seekVideoSafely(startTime, 'resume-start'), 350);
            }
        }).catch(err => {
            console.error('[Play Library] playTrack failed:', err);
            showToast('Playback start failed');
        });
    } catch (e) {
        console.error('[Play Library] failed:', e);
        showToast('Play failed: ' + e.message);
    }
}
window.playLibraryEpisode = playLibraryEpisode;

function findLibraryItemByIdDeep(id) {
    const sid = String(id);
    for (const cat of ['anime', 'show', 'movie']) {
        const item = (library[cat] || []).find(i => String(i.id) === sid || String(i.mal_id) === sid);
        if (item) return { item, category: cat };
    }
    return { item: null, category: '' };
}

function ensureEpisodeSlot(item, epNum) {
    if (!item.episodes || !Array.isArray(item.episodes)) item.episodes = [];
    let ep = item.episodes.find(e => Number(e.num) === Number(epNum));
    if (!ep) {
        ep = { num: Number(epNum) || 1, path: '', name: '' };
        item.episodes.push(ep);
        item.episodes.sort((a, b) => (a.num || 0) - (b.num || 0));
    }
    return ep;
}

function completeEpisodeLinking(malId, epNum, file) {
    try {
        hideTaskOverlay(0);
        if (!file || !(file.path || file.blobUrl)) {
            showToast('Link failed: no file path returned');
            return false;
        }
        const sid = String(malId);
        let found = findLibraryItemByIdDeep(sid);
        let item = found.item;
        let category = found.category;

        // If this page was opened from catalog but title was not yet in Library, add the active item first.
        if (!item && activeLibraryItem) {
            const norm = normalizeMediaItem(activeLibraryItem);
            item = norm.item;
            category = item.category || activeLibraryItem.category || 'anime';
            if (!library[category]) library[category] = [];
            if (!library[category].some(i => String(i.id) === String(item.id))) {
                library[category].push(item);
            }
        }
        if (!item) {
            showToast('Link failed: Library title not found');
            console.warn('[Link File] Library title not found for id:', malId, file);
            return false;
        }

        const ep = ensureEpisodeSlot(item, Number(epNum) || 1);
        ep.path = file.path || file.blobUrl || '';
        ep.name = file.name || (file.path ? file.path.split(/[\\/]/).pop() : 'Linked media');
        ep.is_remuxed = !!file.is_remuxed;
        ep.linked_directly = !!file.linked_directly;

        // Keep active item in sync with stored library item.
        if (activeLibraryItem && String(activeLibraryItem.id) === String(item.id)) {
            activeLibraryItem = item;
        }
        saveLibrary();
        renderLibraryGrid();
        try { renderDetailsContent(item, true); } catch(e) {}
        try { renderHDRezkaEpisodes(); } catch(e) {}
        try { updateHDRezkaLibButton(true); } catch(e) {}
        showToast(`${ep.name} linked`);
        return true;
    } catch (e) {
        hideTaskOverlay(0);
        console.error('[Link File] completeEpisodeLinking failed:', e);
        showToast('Link failed: ' + e.message);
        return false;
    }
}
window.completeEpisodeLinking = completeEpisodeLinking;

function cancelEpisodeLinking() {
    hideTaskOverlay(0);
    showToast('File linking cancelled');
}
window.cancelEpisodeLinking = cancelEpisodeLinking;

function linkFileForEpisodeInRezka(epNum) {
    if (!activeLibraryItem) return;
    const { item, inLibrary } = normalizeMediaItem(activeLibraryItem);
    
    if (!inLibrary) {
        if (!library[item.category]) library[item.category] = [];
        library[item.category].push(item);
        saveLibrary();
        showToast(`Added to Library for episode linking!`);
        updateHDRezkaLibButton(true);
        renderLibraryGrid();
    }
    
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.select_link_file(item.id, epNum, item.title);
    } else {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = "audio/*,video/*,.ts";
        fileInput.onchange = (e) => {
            const files = Array.from(e.target.files).map(f => ({
                name: f.name,
                blobUrl: URL.createObjectURL(f),
                path: '',
                size: f.size || 0
            }));
            if (files.length > 0) {
                completeEpisodeLinking(item.id, epNum, files[0]);
            }
        };
        fileInput.click();
    }
}

/* ======================================================== */
/*          RECURSIVE FRANCHISE CHRONOLOGY SCANNER          */
/* ======================================================== */

const chronologyCache = new Map();

async function getRecursiveFranchiseChronology(startId) {
    if (chronologyCache.has(startId)) {
        return chronologyCache.get(startId);
    }
    if (activeLibraryItem && activeLibraryItem.id === startId && activeLibraryItem.category !== 'anime' && !activeLibraryItem.franchiseHub) {
        chronologyCache.set(startId, []);
        return [];
    }
    
    showToast("Loading franchise chronology...");
    
    let startTitle = "";
    if (activeLibraryItem && activeLibraryItem.id === startId) {
        startTitle = activeLibraryItem.title;
    }
    
    // AI must be tried before local famous fallback so metadata (studio/source/genres) is filled.
    if (activeLibraryItem && activeLibraryItem.id === startId) {
        startTitle = activeLibraryItem.title;
    }
    
    // Symmetrical AI integration: try OpenAI & Tavily first!
    if (window.pywebview && window.pywebview.api && startTitle) {
        try {
            console.log(`[AI Engine] Attempting AI franchise compiler for: "${startTitle}"`);
            const aiResRaw = await window.pywebview.api.get_ai_franchise_info(startTitle, (activeLibraryItem && activeLibraryItem.category) || '', startId);
            const aiRes = JSON.parse(aiResRaw);
            
            if (aiRes && aiRes.status === "success" && Array.isArray(aiRes.franchise)) {
                console.log("[AI Engine] Successfully compiled franchise via GPT-4o-mini & Tavily!");
                
                // Load the rich metadata into activeLibraryItem!
                if (activeLibraryItem) {
                    if (aiRes.synopsis) activeLibraryItem.synopsis = aiRes.synopsis;
                    if (aiRes.studios_str) activeLibraryItem.studios_str = aiRes.studios_str;
                    if (aiRes.genres_str) activeLibraryItem.genres_str = aiRes.genres_str;
                    if (aiRes.source) activeLibraryItem.source = aiRes.source;
                    if (aiRes.score) activeLibraryItem.score = aiRes.score;
                    if (aiRes.airing_status) activeLibraryItem.status = aiRes.airing_status;
                    updateHDRezkaMetadataUI(activeLibraryItem);
                }
                
                let compiled = aiRes.franchise.map((item, idx) => ({ 
                    id: item.id,
                    order: item.order || (idx + 1),
                    name: item.name,
                    relation: item.relation,
                    type: item.type || 'TV',
                    year: item.year || 0,
                    episodes: item.episodes || 12,
                    confidence: item.confidence || aiRes.confidence || 0.6
                }));

                // If the AI returned a too-short chronology for a known large franchise, keep AI metadata
                // but use our curated local watch-order fallback for the parts list.
                const knownKey = getKnownFranchiseKey(startTitle, compiled.map(x => ({ title: x.name, type: x.type, episodes: x.episodes })));
                if (knownKey && FAMOUS_FRANCHISES[knownKey] && compiled.length < Math.max(3, FAMOUS_FRANCHISES[knownKey].length * 0.6)) {
                    console.log(`[Franchise Engine] AI chronology too sparse for ${knownKey}; using curated parts fallback while keeping AI metadata.`);
                    compiled = FAMOUS_FRANCHISES[knownKey];
                }
                
                chronologyCache.set(startId, compiled);
                return compiled;
            } else if (aiRes && aiRes.status === "no_keys") {
                console.log("[AI Engine] Missing API keys in keys.json or env.");
            }
        } catch (err) {
            console.error("[AI Engine] AI compiler failed:", err);
        }
    }

    // Famous database fallback only after AI/no-keys/failure.
    if (startTitle) {
        const titleLower = startTitle.toLowerCase();
        for (const [key, list] of Object.entries(FAMOUS_FRANCHISES)) {
            if (titleLower.includes(key) || (key === 'jojo' && titleLower.includes('kimyou na bouken'))) {
                console.log(`[Famous Database] Fallback matched franchise: "${key}"`);
                if (activeLibraryItem && key === 'bleach') {
                    activeLibraryItem.studios_str = activeLibraryItem.studios_str && activeLibraryItem.studios_str !== '-' ? activeLibraryItem.studios_str : 'Studio Pierrot';
                    activeLibraryItem.genres_str = activeLibraryItem.genres_str && activeLibraryItem.genres_str !== '-' ? activeLibraryItem.genres_str : 'Action, Adventure, Supernatural';
                    activeLibraryItem.source = activeLibraryItem.source && activeLibraryItem.source !== '-' ? activeLibraryItem.source : 'Manga';
                    activeLibraryItem.score = activeLibraryItem.score || 7.96;
                    updateHDRezkaMetadataUI(activeLibraryItem);
                }
                chronologyCache.set(startId, list);
                return list;
            }
        }
    }

    // Never use Jikan anime fallback for live-action TV/movies. It causes nonsense like Breaking Bad -> anime.
    if (activeLibraryItem && activeLibraryItem.id === startId && activeLibraryItem.category && activeLibraryItem.category !== 'anime') {
        console.log("[Franchise Engine] Non-anime title without validated AI chronology. Skipping Jikan fallback.");
        chronologyCache.set(startId, []);
        return [];
    }
    
    const compiled = [];
    const visitedIds = new Set();
    visitedIds.add(startId);
    
    try {
        if (!startTitle) {
            await new Promise(resolve => setTimeout(resolve, 330));
            const detailRes = await safeFetchJikan(`https://api.jikan.moe/v4/anime/${startId}`);
            const detailJson = await detailRes.json();
            if (detailJson.data) {
                startTitle = detailJson.data.title;
            }
        }
    } catch (e) {
        console.error("Error fetching starter item title:", e);
    }
    
    if (startTitle) {
        // Extract Core Franchise Name
        let coreName = startTitle.split(/[:\-\(]|Part|Season|сезон|3rd|2nd|1st/i)[0].trim();
        if (coreName.length < 4) {
            coreName = startTitle;
        }
        
        console.log(`[Franchise Engine] Core franchise name: "${coreName}"`);
        
        try {
            await new Promise(resolve => setTimeout(resolve, 330));
            const searchRes = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(coreName)}&limit=25`);
            const searchJson = await searchRes.json();
            const searchItems = searchJson.data || [];
            
            searchItems.forEach(item => {
                const itemTitleLower = item.title.toLowerCase();
                const coreNameLower = coreName.toLowerCase();
                
                // Premium validation: Only include if the search result contains the core name,
                // OR if the core name contains the search result name! Prevent unrelated "Kill la Kill" results!
                const isRelated = itemTitleLower.includes(coreNameLower) || coreNameLower.includes(itemTitleLower);
                
                if (isRelated && item.mal_id !== startId && !visitedIds.has(item.mal_id)) {
                    visitedIds.add(item.mal_id);
                    compiled.push({
                        id: item.mal_id,
                        name: item.title,
                        relation: determineRelationFromTitles(startTitle, item.title, item.type),
                        type: item.type || 'anime',
                        year: item.year || (item.aired ? new Date(item.aired.from).getFullYear() : 0)
                    });
                }
            });
            console.log(`[Franchise Engine] Search returned ${compiled.length} related entries.`);
        } catch (err) {
            console.error("[Franchise Engine] Search failed:", err);
        }
    }
    
    // Direct relations reinforcement
    try {
        await new Promise(resolve => setTimeout(resolve, 330));
        const relRes = await safeFetchJikan(`https://api.jikan.moe/v4/anime/${startId}/relations`);
        const relJson = await relRes.json();
        const relations = relJson.data || [];
        
        relations.forEach(r => {
            const label = r.relation;
            r.entry.forEach(entry => {
                if (entry.type === 'anime') {
                    if (entry.mal_id !== startId && !visitedIds.has(entry.mal_id)) {
                        visitedIds.add(entry.mal_id);
                        compiled.push({
                            id: entry.mal_id,
                            name: entry.name,
                            relation: label,
                            type: entry.type,
                            year: 0
                        });
                    } else if (entry.mal_id !== startId) {
                        const existing = compiled.find(x => x.id === entry.mal_id);
                        if (existing) {
                            existing.relation = label;
                        }
                    }
                }
            });
        });
    } catch (e) {
        console.error("[Franchise Engine] Direct relations fetch failed:", e);
    }
    
    compiled.sort((a, b) => {
        if (a.year && b.year && a.year !== b.year) {
            return a.year - b.year;
        }
        const order = { "Prequel": 1, "Parent story": 2, "Alternative version": 3, "Sequel": 4 };
        const valA = order[a.relation] || 5;
        const valB = order[b.relation] || 5;
        return valA - valB;
    });
    
    chronologyCache.set(startId, compiled);
    return compiled;
}

function determineRelationFromTitles(mainTitle, relTitle, relType) {
    const mainLower = mainTitle.toLowerCase();
    const relLower = relTitle.toLowerCase();
    
    if (relType && relType.toLowerCase().includes('movie')) {
        return "Movie";
    }
    
    if (relLower.includes('part 1') || relLower.includes('phantom blood')) return "Prequel";
    if (relLower.includes('part 2') || relLower.includes('battle tendency')) return "Prequel";
    if (relLower.includes('part 3') || relLower.includes('stardust')) return "Prequel";
    if (relLower.includes('part 4') || relLower.includes('diamond is')) return "Prequel";
    if (relLower.includes('part 5') || relLower.includes('ougon') || relLower.includes('golden wind')) return "Prequel";
    
    if (mainLower.includes('part 7') && relLower.includes('part 6')) return "Prequel";
    if (mainLower.includes('part 6') && relLower.includes('part 7')) return "Sequel";
    if (mainLower.includes('part 6') && relLower.includes('part 5')) return "Prequel";
    if (mainLower.includes('part 5') && relLower.includes('part 6')) return "Sequel";
    
    return "Часть франшизы";
}

function exitPlayerToHome() {
    resetPlayerToEmpty();
    const searchBtn = document.getElementById('tab-search-btn');
    if (searchBtn) searchBtn.click();
    
    document.body.classList.remove('playing');
    document.body.classList.remove('player-has-video');
    
    const hdrezkaPage = document.getElementById('hdrezka-page');
    if (hdrezkaPage) hdrezkaPage.classList.add('hidden');
    
    const searchView = document.getElementById('search-view');
    if (searchView) searchView.classList.remove('hidden');
    
    showToast("Back to browse");
}

async function renderHDRezkaChronology(animeId) {
    const container = document.getElementById('hdrezka-chronology-container');
    if (!container) return;
    
    container.innerHTML = '<p style="font-size: 0.72rem; color: var(--text-muted);">Loading franchise...</p>';
    
    try {
        const fullChrono = await getRecursiveFranchiseChronology(animeId);
        container.innerHTML = '';
        
        if (fullChrono.length === 0) {
            container.innerHTML = '<p style="font-size: 0.72rem; color: var(--text-muted);">Chronology not found.</p>';
            return;
        }
        
        const orderedChrono = fullChrono.slice().sort((a, b) => {
            const orderA = a.order || 999;
            const orderB = b.order || 999;
            if (orderA !== orderB) return orderA - orderB;
            return (a.year || 9999) - (b.year || 9999);
        });

        orderedChrono.forEach((rel, idx) => {
            const card = document.createElement('div');
            card.className = 'hdrezka-chrono-card';
            card.innerHTML = `
                <div class="hdrezka-chrono-name" title="${rel.name}">
                    <span class="chrono-step-badge">#${idx + 1}</span>
                    <span>${rel.name}</span>
                </div>
                <div class="hdrezka-chrono-rel">${translateRelationLabel(rel.relation)}</div>
            `;
            
            bindEvent(card, 'click', async () => {
                showToast(`Переход к: ${rel.name}`);
                await loadAndOpenChronologyItem(rel.id);
            });
            
            container.appendChild(card);
        });
    } catch (e) {
        console.error("Chronology render error:", e);
        container.innerHTML = '<p style="font-size: 0.72rem; color: var(--text-muted);">Failed to load franchise.</p>';
    }
}

function translateRelationLabel(label) {
    const dict = {
        "Prequel": "Предыстория",
        "Sequel": "Продолжение",
        "Parent story": "Основная история",
        "Alternative version": "Альт. версия",
        "Side story": "Спин-офф",
        "Summary": "Спешл",
        "Adaptation": "Адаптация"
    };
    return dict[label] || label;
}

async function loadAndOpenChronologyItem(malId) {
    try {
        const response = await safeFetchJikan(`https://api.jikan.moe/v4/anime/${malId}`);
        const json = await response.json();
        const item = json.data;
        if (item) {
            openHDRezkaPage(item);
        }
    } catch(err) {
        console.error("Failed to load chronology item details:", err);
        showToast("Ошибка загрузки деталей серии");
    }
}

/* ======================================================== */
/*                SLEEK CUSTOM CONTEXT MENUS                */
/* ======================================================== */

function showCustomContextMenu(x, y, item, isCatalog) {
    const menu = document.getElementById('custom-context-menu');
    if (!menu) return;
    
    const normalized = normalizeMediaItem(item);
    const mediaItem = normalized.item;
    const inLibrary = normalized.inLibrary;
    
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('show');
    
    const btnWatchedToggle = document.getElementById('context-toggle-watched');
    if (btnWatchedToggle) btnWatchedToggle.style.display = 'none';

    const btnDetails = document.getElementById('context-open-details');
    btnDetails.textContent = "Показать инфо";
    btnDetails.onclick = () => {
        menu.classList.remove('show');
        if (isCatalog) {
            openCatalogItemDetails(item);
        } else {
            showLibraryItemDetails(item);
        }
    };
    
    const btnRezka = document.getElementById('context-open-hdrezka');
    btnRezka.textContent = "Открыть в стиле HDRezka";
    btnRezka.onclick = () => {
        menu.classList.remove('show');
        openHDRezkaPage(item);
    };
    
    const btnPlay = document.getElementById('context-play-first');
    const firstLinked = mediaItem.episodes.find(e => e.path);
    if (firstLinked) {
        btnPlay.style.display = 'block';
        btnPlay.textContent = `Воспроизвести серию ${firstLinked.num}`;
        btnPlay.onclick = () => {
            menu.classList.remove('show');
            document.getElementById('tab-load-btn').click();
            playLibraryEpisode(mediaItem, firstLinked.num);
        };
    } else {
        btnPlay.style.display = 'none';
    }
    
    const btnRemove = document.getElementById('context-remove-lib');
    if (inLibrary) {
        btnRemove.style.display = 'block';
        btnRemove.onclick = () => {
            menu.classList.remove('show');
            library[mediaItem.category] = (library[mediaItem.category] || []).filter(i => i.id !== mediaItem.id);
            saveLibrary();
            showToast("Удалено из библиотеки");
            renderLibraryGrid();
        };
    } else {
        btnRemove.style.display = 'none';
    }
    
    const closeMenu = () => {
        menu.classList.remove('show');
        document.removeEventListener('click', closeMenu);
    };
    
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 10);
}

function showEpisodeContextMenu(x, y, epNum) {
    if (!activeLibraryItem) return;
    const { item, inLibrary } = normalizeMediaItem(activeLibraryItem);
    const ep = item.episodes.find(e => e.num === epNum);
    if (!ep) return;
    
    const menu = document.getElementById('custom-context-menu');
    if (!menu) return;
    
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('show');
    
    const btnDetails = document.getElementById('context-open-details');
    btnDetails.textContent = `Информация о серии ${epNum}`;

    const btnWatchedToggle = document.getElementById('context-toggle-watched');
    if (btnWatchedToggle) {
        btnWatchedToggle.style.display = 'block';
        const watchedKey = `watched_${activeLibraryItem.id}_${epNum}`;
        const isCurrentlyWatched = localStorage.getItem(watchedKey) === 'true';
        
        btnWatchedToggle.textContent = isCurrentlyWatched ? "Пометить как непросмотренную" : "Пометить как просмотренную";
        
        btnWatchedToggle.onclick = () => {
            menu.classList.remove('show');
            if (isCurrentlyWatched) {
                localStorage.removeItem(watchedKey);
                showToast(`Episode ${epNum} помечена как непросмотренная.`);
            } else {
                localStorage.setItem(watchedKey, 'true');
                showToast(`Episode ${epNum} помечена как просмотренная.`);
            }
            renderHDRezkaEpisodes(); // Refresh grid!
        };
    }
    btnDetails.onclick = () => {
        menu.classList.remove('show');
        if (ep.path) {
            showToast(`Файл: ${ep.name}`);
        } else {
            showToast(`Episode ${epNum} не привязана.`);
        }
    };
    
    const btnRezka = document.getElementById('context-open-hdrezka');
    btnRezka.textContent = ep.path ? "Перепривязать файл" : "Привязать файл серии";
    btnRezka.onclick = () => {
        menu.classList.remove('show');
        linkFileForEpisodeInRezka(epNum);
    };
    
    const btnPlay = document.getElementById('context-play-first');
    if (ep.path) {
        btnPlay.style.display = 'block';
        btnPlay.textContent = `Воспроизвести серию ${epNum}`;
        btnPlay.onclick = () => {
            menu.classList.remove('show');
            document.getElementById('hdrezka-page').classList.add('hidden');
            document.getElementById('player-viewport').classList.remove('hidden');
            document.getElementById('tab-load-btn').click();
            playLibraryEpisode(item, epNum);
        };
    } else {
        btnPlay.style.display = 'none';
    }
    
    const btnRemove = document.getElementById('context-remove-lib');
    if (ep.path) {
        btnRemove.style.display = 'block';
        btnRemove.textContent = "Unlink file";
        btnRemove.onclick = () => {
            menu.classList.remove('show');
            ep.path = '';
            ep.name = '';
            saveLibrary();
            showToast(`Episode file ${epNum} отвязан.`);
            renderHDRezkaEpisodes();
            renderLibraryGrid();
        };
    } else {
        btnRemove.style.display = 'none';
    }
    
    const closeMenu = () => {
        menu.classList.remove('show');
        document.removeEventListener('click', closeMenu);
        btnDetails.textContent = "Показать инфо";
        btnRezka.textContent = "Открыть в стиле HDRezka";
        btnPlay.textContent = "Воспроизвести серию 1";
        btnRemove.textContent = "Remove from Library";
        const btnWatchedToggle = document.getElementById('context-toggle-watched');
        if (btnWatchedToggle) btnWatchedToggle.textContent = "Пометить как просмотренную";
    };
    
    setTimeout(() => {
        document.addEventListener('click', closeMenu);
    }, 10);
}

/* ======================================================== */
/*              WATCHING PROGRESS & HISTORY STORAGE         */
/* ======================================================== */

function isEpisodeAired(item, epNum) {
    if (!item) return true;
    if (item.status === "Finished Airing" || item.status === "Completed") {
        return true;
    }
    if (item.status === "Not yet aired") {
        return false;
    }
    
    // Premium Jikan / MyAnimeList episode list validation!
    const eps = episodesDetailsCache.get(item.id);
    if (eps && eps.length > 0) {
        const epDetails = eps.find(e => e.mal_id === epNum);
        if (!epDetails) {
            return false; // Not released yet!
        }
        return true;
    }
    
    if (item.aired_from) {
        const startDate = new Date(item.aired_from);
        const epReleaseTime = startDate.getTime() + (epNum - 1) * 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        return now >= epReleaseTime;
    }
    
    if (item.episodes && Array.isArray(item.episodes)) {
        const ep = item.episodes.find(e => e.num === epNum);
        if (ep && ep.path) return true;
    }
    return true;
}

function getStoredWatchingProgressEntry(itemId) {
    try {
        const saved = localStorage.getItem('watching_progress');
        const progress = saved ? JSON.parse(saved) : [];
        return Array.isArray(progress) ? progress.find(p => p.id === itemId) : null;
    } catch(e) {
        return null;
    }
}

function beginWatchSession(item, epNum, startTime = 0, source = 'episode-grid') {
    const previous = getStoredWatchingProgressEntry(item.id);
    watchSession = {
        itemId: item.id,
        epNum: epNum,
        source: source,
        startedAt: Date.now(),
        startedMediaTime: Number(startTime) || 0,
        lastMediaTime: Number(startTime) || 0,
        lastWallTime: Date.now(),
        continuousSeconds: 0,
        maxTime: Number(startTime) || 0,
        suspiciousSeek: false,
        previousEpNum: previous ? previous.epNum : null,
        previousTime: previous ? previous.time : 0,
        trustedImmediately: source === 'watching' || source === 'next-auto' || source === 'resume-banner'
    };
    lastPlaybackTick = null;
}

function updateWatchSessionTelemetry(currentTime) {
    if (!watchSession || !DOM.player || DOM.player.paused) return;
    const now = Date.now();
    const t = Number(currentTime) || 0;
    if (lastPlaybackTick) {
        const wallDelta = Math.max(0, (now - lastPlaybackTick.wall) / 1000);
        const mediaDelta = t - lastPlaybackTick.media;
        // Large forward jumps are user seeking, not honest continuous watching.
        if (mediaDelta > Math.max(25, wallDelta * 4 + 8)) {
            watchSession.suspiciousSeek = true;
        }
        // Count only normal playback movement.
        if (mediaDelta > 0 && mediaDelta < Math.max(8, wallDelta * 2.5 + 3)) {
            watchSession.continuousSeconds += Math.min(mediaDelta, wallDelta + 1.5);
        }
    }
    watchSession.lastMediaTime = t;
    watchSession.lastWallTime = now;
    watchSession.maxTime = Math.max(watchSession.maxTime || 0, t);
    lastPlaybackTick = { wall: now, media: t };
}

function isHonestWatchingProgress(item, epNum, time, duration) {
    if (!watchSession || watchSession.itemId !== item.id || watchSession.epNum !== epNum) {
        return false;
    }
    if (watchSession.trustedImmediately) return true;

    const previousEp = watchSession.previousEpNum;
    const continuous = watchSession.continuousSeconds || 0;
    const pct = duration ? (time / duration) : 0;
    const isSameEpisode = previousEp === epNum;
    const isNextEpisode = previousEp == null || epNum <= previousEp + 1;

    // Normal path: same / next episode with at least 45s of real playback.
    if (!watchSession.suspiciousSeek && isNextEpisode && continuous >= 45 && time >= 45) {
        return true;
    }
    // Same episode can update sooner after a short resume.
    if (!watchSession.suspiciousSeek && isSameEpisode && continuous >= 20) {
        return true;
    }
    // If user really watches a far episode for a long time, accept it; accidental seek-to-end will not pass.
    if (!watchSession.suspiciousSeek && continuous >= 600) {
        return true;
    }
    // Near-complete without honest playback is suspicious and must not replace the Watching card.
    if (watchSession.suspiciousSeek && pct > 0.70 && continuous < 300) {
        return false;
    }
    return false;
}

function saveWatchingProgress(item, epNum, time, duration) {
    // Robust Watching v2: save normal playback progress aggressively.
    // The old "honest watching" guard was too strict and caused real watched episodes to disappear.
    // We still avoid saving intro/near-end junk and avoid large regressions, but normal watching is persisted every tick.
    if (!item || !epNum) return;
    time = Number(time) || 0;
    duration = Number(duration || getActiveDuration() || 0) || 0;
    if (time < 10) return;
    if (duration > 0 && time / duration >= 0.92) {
        // Near the end: mark watched and remove from continue-watching instead of saving a useless end resume.
        try { localStorage.setItem(`watched_${item.id}_${epNum}`, 'true'); } catch(e) {}
        removeEpisodeFromWatchingProgress(item.id);
        return;
    }

    let progress = [];
    try {
        const saved = localStorage.getItem('watching_progress');
        if (saved) progress = JSON.parse(saved);
    } catch(e) {}
    if (!Array.isArray(progress)) progress = [];

    const existing = progress.find(p => p.id === item.id);
    // Do not regress the same episode by a lot due to accidental early seek/reopen.
    if (existing && Number(existing.epNum) === Number(epNum) && Number(existing.time || 0) - time > 90) {
        console.log('[Watching] Ignored large backwards progress regression', { title: item.title, epNum, old: existing.time, next: time });
        return;
    }

    progress = progress.filter(p => p.id !== item.id);
    progress.unshift({
        id: item.id,
        title: item.title,
        poster: item.poster,
        category: item.category,
        epNum: Number(epNum),
        episodesCount: (item.episodes || []).length || 1,
        time,
        duration: duration || 1400,
        timestamp: Date.now(),
        robust: true
    });
    progress = progress.slice(0, 20);
    localStorage.setItem('watching_progress', JSON.stringify(progress));
    localStorage.setItem('resume_info_' + item.id, JSON.stringify({ epNum: Number(epNum), time }));
    saveDbDataFallback('watching_progress', JSON.stringify(progress));
}

function saveWatchingProgressTrusted(item, epNum, time, duration, reason = 'trusted') {
    try {
        if (!item || !epNum) return;
        if (!duration || duration <= 0) duration = getActiveDuration() || 1400;
        let progress = [];
        try { const saved = localStorage.getItem('watching_progress'); if (saved) progress = JSON.parse(saved); } catch(e) {}
        if (!Array.isArray(progress)) progress = [];
        progress = progress.filter(p => p.id !== item.id);
        const pct = duration ? time / duration : 0;
        if (pct >= 0.92) {
            removeEpisodeFromWatchingProgress(item.id);
            localStorage.setItem(`watched_${item.id}_${epNum}`, 'true');
            return;
        }
        progress.unshift({
            id: item.id, title: item.title, poster: item.poster, category: item.category,
            epNum, episodesCount: (item.episodes || []).length || 1,
            time: Math.max(0, time || 0), duration, timestamp: Date.now(), trusted_reason: reason
        });
        progress = progress.slice(0, 15);
        localStorage.setItem('watching_progress', JSON.stringify(progress));
        if (isDatabaseLoaded && window.pywebview && window.pywebview.api) saveDbDataFallback('watching_progress', JSON.stringify(progress));
    } catch(e) { console.warn('[Watching] trusted save failed:', e); }
}

function persistCurrentWatchOnExit(reason = 'exit') {
    try {
        if (!activeLibraryItem || !activeEpisodeNum || !DOM.player) return;
        const t = DOM.player.currentTime || 0;
        const d = getActiveDuration() || DOM.player.duration || 0;
        if (t >= 20 && d > 0) saveWatchingProgressTrusted(activeLibraryItem, activeEpisodeNum, t, d, reason);
    } catch(e) {}
}

function saveViewingHistory(item, epNum, time) {
    if (!isDatabaseLoaded) {
        console.warn("[Storage Engine] History will be saved locally first; Python DB sync is not ready yet.");
    }
    let history = [];
    try {
        const saved = localStorage.getItem('viewing_history');
        if (saved) history = JSON.parse(saved);
    } catch(e) {}
    
    if (!Array.isArray(history)) history = [];
    history = history.filter(h => !(h.id === item.id && h.epNum === epNum));
    
    history.unshift({
        id: item.id,
        title: item.title,
        epNum: epNum,
        time: time,
        timestamp: Date.now()
    });
    
    history = history.slice(0, 50);
    localStorage.setItem('viewing_history', JSON.stringify(history));
    if (isDatabaseLoaded && window.pywebview && window.pywebview.api) {
        saveDbDataFallback("viewing_history", JSON.stringify(history));
    }
}

function renderWatchingDashboard() {
    const progressList = document.getElementById('watching-progress-list');
    const historyList = document.getElementById('watching-history-list');
    if (!progressList || !historyList) return;
    
    let progress = [];
    try {
        const saved = localStorage.getItem('watching_progress');
        if (saved) progress = JSON.parse(saved);
    } catch(e) {}
    
    progressList.innerHTML = '';
    if (!progress || progress.length === 0) {
        progressList.innerHTML = `
            <div class="empty-playlist" style="grid-column: 1 / -1; padding: 32px 0;">
                <p>Нет сериалов в процессе просмотра.</p>
            </div>
        `;
    } else {
        progress.forEach(p => {
            const pct = Math.min(100, Math.max(0, (p.time / p.duration) * 100));
            const card = document.createElement('div');
            card.className = 'watching-card';
            card.innerHTML = `
                <div class="media-poster-wrapper" style="cursor: pointer;">
                    <img class="media-poster" src="${p.poster || DEFAULT_POSTER_DATA}" alt="${p.title}">
                </div>
                <div class="watching-card-info">
                    <div class="watching-card-title" title="${p.title}">${p.title}</div>
                    <div class="watching-card-meta">Episode ${p.epNum} из ${p.episodesCount}</div>
                    <div class="watching-progress-bar-wrapper">
                        <div class="watching-progress-bar" style="width: ${pct}%"></div>
                    </div>
                    <div style="font-size: 0.6rem; color: var(--text-muted); margin-top: 4px;">
                        Остановились на ${formatTime(p.time)}
                    </div>
                    <button class="watching-resume-btn">Продолжить</button>
                </div>
            `;
            
            card.querySelector('.media-poster-wrapper').addEventListener('click', () => {
                showLibraryItemDetails(p);
            });
            
            card.addEventListener('dblclick', () => {
                openHDRezkaPage(p);
            });
            
            card.querySelector('.watching-resume-btn').addEventListener('click', () => {
                let item = null;
                for (const cat of ['anime', 'show', 'movie']) {
                    item = (library[cat] || []).find(i => i.id === p.id);
                    if (item) break;
                }
                if (item) {
                    document.getElementById('tab-load-btn').click();
                    playLibraryEpisode(item, p.epNum, p.time, 'watching');
                } else {
                    showToast("Тайтл не найден в библиотеке.");
                }
            });
            
            progressList.appendChild(card);
        });
    }
    
    let history = [];
    try {
        const saved = localStorage.getItem('viewing_history');
        if (saved) history = JSON.parse(saved);
    } catch(e) {}
    
    historyList.innerHTML = '';
    if (!history || history.length === 0) {
        historyList.innerHTML = `
            <div class="empty-playlist" style="padding: 32px 0;">
                <p>История просмотров пуста.</p>
            </div>
        `;
    } else {
        history.forEach((h, idx) => {
            const dateStr = new Date(h.timestamp).toLocaleDateString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit'
            });
            
            const item = document.createElement('div');
            item.className = 'history-item';
            item.innerHTML = `
                <div class="history-item-details">
                    <div class="history-item-title" title="${h.title}">${h.title}</div>
                    <div class="history-item-subtitle">Episode ${h.epNum} • Просмотрено до ${formatTime(h.time)}</div>
                    <div style="font-size: 0.58rem; color: var(--text-muted); margin-top: 2px;">${dateStr}</div>
                </div>
                <button class="history-remove-btn" title="Удалить из истории">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
            `;
            
            item.querySelector('.history-item-details').addEventListener('click', () => {
                let catItem = null;
                for (const cat of ['anime', 'show', 'movie']) {
                    catItem = (library[cat] || []).find(i => i.id === h.id);
                    if (catItem) break;
                }
                if (catItem) {
                    document.getElementById('tab-load-btn').click();
                    playLibraryEpisode(catItem, h.epNum, h.time);
                } else {
                    showToast("Тайтл не найден в библиотеке.");
                }
            });
            
            item.querySelector('.history-remove-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                removeEntryFromHistory(idx);
            });
            
            historyList.appendChild(item);
        });
    }
    
    // Symmetrically render release schedule on dashboard load!
    renderReleaseSchedule();
}

function removeEntryFromHistory(index) {
    let history = [];
    try {
        const saved = localStorage.getItem('viewing_history');
        if (saved) history = JSON.parse(saved);
    } catch(e) {}
    
    if (Array.isArray(history)) {
        history.splice(index, 1);
        localStorage.setItem('viewing_history', JSON.stringify(history));
        if (window.pywebview && window.pywebview.api) {
            saveDbDataFallback("viewing_history", JSON.stringify(history));
        }
        renderWatchingDashboard();
        showToast("Удалено из истории");
    }
}

/* ======================================================== */
/*          HDREZKA-STYLE EPISODE DETAILS ENGINE            */
/* ======================================================== */

const episodesDetailsCache = new Map();

async function fetchEpisodeDetailsForActiveItem(animeId) {
    if (episodesDetailsCache.has(animeId)) {
        return episodesDetailsCache.get(animeId);
    }
    
    try {
        await new Promise(resolve => setTimeout(resolve, 330));
        const res = await safeFetchJikan(`https://api.jikan.moe/v4/anime/${animeId}/episodes`);
        const json = await res.json();
        const eps = json.data || [];
        episodesDetailsCache.set(animeId, eps);
        return eps;
    } catch(e) {
        console.error("Failed to fetch episodes details:", e);
        return [];
    }
}

function showHDRezkaEpisodeDescription(eps, epNum) {
    const panel = document.getElementById('hdrezka-episode-desc-panel');
    const titleEl = document.getElementById('hdrezka-ep-desc-title');
    const dateEl = document.getElementById('hdrezka-ep-desc-date');
    const textEl = document.getElementById('hdrezka-ep-desc-text');
    
    if (!panel || !titleEl || !dateEl || !textEl) return;
    
    const epDetails = eps.find(e => e.mal_id === epNum);
    
    if (epDetails) {
        titleEl.textContent = `Episode ${epNum}: ${epDetails.title || 'Untitled'} ${epDetails.title_japanese ? ' (' + epDetails.title_japanese + ')' : ''}`;
        const dateStr = epDetails.aired ? new Date(epDetails.aired).toLocaleDateString('en-US') : 'Unknown';
        dateEl.textContent = `Air date: ${dateStr}`;
        textEl.textContent = epDetails.synopsis || "Episode description is temporarily unavailable.";
        panel.classList.remove('hidden');
    } else {
        titleEl.textContent = `Episode ${epNum}`;
        dateEl.textContent = 'Air date: Unknown';
        textEl.textContent = "Episode description is temporarily unavailable.";
        panel.classList.remove('hidden');
    }
}

/* ======================================================== */
/*          PRE-DEFINED FRANCHISES DATABASE (FAMOUS)        */
/* ======================================================== */

const FAMOUS_FRANCHISES = {
    spider: [
        { id: 557, order: 1, name: "Spider-Man", relation: "Raimi Trilogy Part 1", type: "Movie", year: 2002, episodes: 1 },
        { id: 558, order: 2, name: "Spider-Man 2", relation: "Raimi Trilogy Part 2", type: "Movie", year: 2004, episodes: 1 },
        { id: 559, order: 3, name: "Spider-Man 3", relation: "Raimi Trilogy Part 3", type: "Movie", year: 2007, episodes: 1 },
        { id: 1930, order: 4, name: "The Amazing Spider-Man", relation: "Amazing Duology Part 1", type: "Movie", year: 2012, episodes: 1 },
        { id: 102382, order: 5, name: "The Amazing Spider-Man 2", relation: "Amazing Duology Part 2", type: "Movie", year: 2014, episodes: 1 },
        { id: 315635, order: 6, name: "Spider-Man: Homecoming", relation: "MCU Part 1", type: "Movie", year: 2017, episodes: 1 },
        { id: 429617, order: 7, name: "Spider-Man: Far From Home", relation: "MCU Part 2", type: "Movie", year: 2019, episodes: 1 },
        { id: 634649, order: 8, name: "Spider-Man: No Way Home", relation: "MCU Part 3", type: "Movie", year: 2021, episodes: 1 },
        { id: 324857, order: 20, name: "Spider-Man: Into the Spider-Verse", relation: "Spider-Verse Part 1", type: "Movie", year: 2018, episodes: 1 },
        { id: 569094, order: 21, name: "Spider-Man: Across the Spider-Verse", relation: "Spider-Verse Part 2", type: "Movie", year: 2023, episodes: 1 }
    ],
    bleach: [
        { id: 269, order: 1, name: "Bleach", relation: "Main Story / Original TV Series", type: "TV", year: 2004, episodes: 366 },
        { id: 834, order: 2, name: "Bleach: Memories in the Rain", relation: "Optional Special / Early Side Story", type: "Special", year: 2004, episodes: 1 },
        { id: 835, order: 3, name: "Bleach: The Sealed Sword Frenzy", relation: "Optional Special / After Soul Society", type: "Special", year: 2005, episodes: 1 },
        { id: 1686, order: 4, name: "Bleach Movie 1: Memories of Nobody", relation: "Optional Movie / After Episode ~117", type: "Movie", year: 2006, episodes: 1 },
        { id: 2889, order: 5, name: "Bleach Movie 2: The DiamondDust Rebellion", relation: "Optional Movie / After Episode ~125", type: "Movie", year: 2007, episodes: 1 },
        { id: 4835, order: 6, name: "Bleach Movie 3: Fade to Black", relation: "Optional Movie / After Episode ~125", type: "Movie", year: 2008, episodes: 1 },
        { id: 8247, order: 7, name: "Bleach Movie 4: Hell Verse", relation: "Optional Movie / After Episode ~299", type: "Movie", year: 2010, episodes: 1 },
        { id: 41467, order: 8, name: "Bleach: Thousand-Year Blood War", relation: "Sequel / Final Arc Part 1", type: "TV", year: 2022, episodes: 13 },
        { id: 53998, order: 9, name: "Bleach: Thousand-Year Blood War - The Separation", relation: "Sequel / Final Arc Part 2", type: "TV", year: 2023, episodes: 13 },
        { id: 56784, order: 10, name: "Bleach: Thousand-Year Blood War - The Conflict", relation: "Sequel / Final Arc Part 3", type: "TV", year: 2024, episodes: 14 },
        { id: 60215, order: 11, name: "Bleach: Thousand-Year Blood War - The Calamity", relation: "Sequel / Final Arc Part 4 (Unreleased)", type: "TV", year: 2026, episodes: 12 },
        { id: 41468, order: 99, name: "Burn the Witch", relation: "Alternative Setting / Same Universe", type: "Movie", year: 2020, episodes: 3 }
    ],
    jojo: [
        { id: 14719, name: "JoJo's Bizarre Adventure (Part 1 & 2)", relation: "Phantom Blood & Battle Tendency", type: "TV", year: 2012, episodes: 26 },
        { id: 20899, name: "JoJo's Bizarre Adventure: Stardust Crusaders (Part 3)", relation: "Stardust Crusaders", type: "TV", year: 2014, episodes: 24 },
        { id: 26055, name: "JoJo's Bizarre Adventure: Stardust Crusaders - Egypt Arc", relation: "Egypt Battle", type: "TV", year: 2015, episodes: 24 },
        { id: 31592, name: "JoJo's Bizarre Adventure: Diamond is Unbreakable (Part 4)", relation: "Diamond is Unbreakable", type: "TV", year: 2016, episodes: 39 },
        { id: 37991, name: "JoJo's Bizarre Adventure: Golden Wind (Part 5)", relation: "Golden Wind", type: "TV", year: 2018, episodes: 39 },
        { id: 49220, name: "JoJo's Bizarre Adventure: Stone Ocean (Part 6)", relation: "Stone Ocean", type: "TV", year: 2021, episodes: 38 },
        { id: 52991, name: "JoJo's Bizarre Adventure: Steel Ball Run (Part 7)", relation: "Steel Ball Run", type: "TV", year: 2026, episodes: 12 }
    ],
    fate: [
        { id: 356, name: "Fate/stay night (2006)", relation: "Saber Route", type: "TV", year: 2006, episodes: 24 },
        { id: 10087, name: "Fate/Zero", relation: "Prequel Season 1", type: "TV", year: 2011, episodes: 13 },
        { id: 11741, name: "Fate/Zero Season 2", relation: "Prequel Season 2", type: "TV", year: 2012, episodes: 12 },
        { id: 22297, name: "Fate/stay night: Unlimited Blade Works", relation: "Rin Route S1", type: "TV", year: 2014, episodes: 13 },
        { id: 28701, name: "Fate/stay night: Unlimited Blade Works Season 2", relation: "Rin Route S2", type: "TV", year: 2015, episodes: 13 },
        { id: 25537, name: "Fate/stay night Movie: Heaven's Feel - I", relation: "Sakura Route Part 1", type: "Movie", year: 2017, episodes: 1 },
        { id: 33049, name: "Fate/stay night Movie: Heaven's Feel - II", relation: "Sakura Route Part 2", type: "Movie", year: 2019, episodes: 1 },
        { id: 33050, name: "Fate/stay night Movie: Heaven's Feel - III", relation: "Sakura Route Part 3", type: "Movie", year: 2020, episodes: 1 }
    ],
    monogatari: [
        { id: 5081, name: "Bakemonogatari", relation: "Season 1 Part 1", type: "TV", year: 2009, episodes: 15 },
        { id: 11597, name: "Nisemonogatari", relation: "Season 1 Part 2", type: "TV", year: 2012, episodes: 11 },
        { id: 15689, name: "Nekomonogatari: Kuro", relation: "Season 1 Part 3", type: "TV", year: 2012, episodes: 4 },
        { id: 17074, name: "Monogatari Series: Second Season", relation: "Season 2", type: "TV", year: 2013, episodes: 26 },
        { id: 21855, name: "Hanamonogatari", relation: "Season 2 Part 2", type: "TV", year: 2014, episodes: 5 },
        { id: 28025, name: "Tsukimonogatari", relation: "Final Season Part 1", type: "TV", year: 2014, episodes: 4 },
        { id: 9260, name: "Kizumonogatari I: Tekketsu-hen", relation: "Prequel Trilogy Part 1", type: "Movie", year: 2016, episodes: 1 },
        { id: 31715, name: "Kizumonogatari II: Nekketsu-hen", relation: "Prequel Trilogy Part 2", type: "Movie", year: 2016, episodes: 1 },
        { id: 31716, name: "Kizumonogatari III: Reiketsu-hen", relation: "Prequel Trilogy Part 3", type: "Movie", year: 2017, episodes: 1 },
        { id: 31181, name: "Owarimonogatari Season 2", relation: "Final Season Part 2", type: "TV", year: 2017, episodes: 7 },
        { id: 36999, name: "Zoku Owarimonogatari", relation: "Epilogue", type: "TV", year: 2018, episodes: 6 }
    ],
    gintama: [
        { id: 918, name: "Gintama (2006)", relation: "Season 1", type: "TV", year: 2006, episodes: 201 },
        { id: 9969, name: "Gintama'", relation: "Season 2", type: "TV", year: 2011, episodes: 51 },
        { id: 15417, name: "Gintama' Enchousen", relation: "Season 2 Sequel", type: "TV", year: 2012, episodes: 13 },
        { id: 28977, name: "Gintama°", relation: "Season 3", type: "TV", year: 2015, episodes: 51 },
        { id: 34096, name: "Gintama.", relation: "Season 4", type: "TV", year: 2017, episodes: 12 }
    ]
};

function setupFranchiseResumeBanner(seasonsList) {
    const banner = document.getElementById('hdrezka-franchise-resume-banner');
    const titleEl = document.getElementById('hdrezka-resume-title');
    const btn = document.getElementById('hdrezka-resume-banner-btn');
    
    if (!banner || !titleEl || !btn) return;
    
    let foundProgress = null;
    let newestTimestamp = 0;
    
    seasonsList.forEach((season, idx) => {
        try {
            const savedResume = localStorage.getItem('resume_info_' + season.id);
            if (savedResume) {
                const parsed = JSON.parse(savedResume);
                let progressEntry = null;
                try {
                    const savedProg = localStorage.getItem('watching_progress');
                    if (savedProg) {
                        const parsedProg = JSON.parse(savedProg);
                        progressEntry = parsedProg.find(p => p.id === season.id);
                    }
                } catch(e) {}
                
                const timestamp = progressEntry ? progressEntry.timestamp : 1;
                
                if (timestamp > newestTimestamp) {
                    newestTimestamp = timestamp;
                    foundProgress = {
                        season: season,
                        seasonIndex: idx + 1,
                        epNum: parsed.epNum,
                        time: parsed.time
                    };
                }
            }
        } catch(e) {}
    });
    
    if (foundProgress) {
        titleEl.textContent = `Сезон ${foundProgress.seasonIndex}: ${foundProgress.season.name.split(/[:\-\(]/)[0].trim()} • Episode ${foundProgress.epNum} • Остановились на ${formatTime(foundProgress.time)}`;
        banner.classList.remove('hidden');
        
        btn.onclick = () => {
            document.getElementById('hdrezka-page').classList.add('hidden');
            document.getElementById('player-viewport').classList.remove('hidden');
            document.getElementById('tab-load-btn').click();
            playLibraryEpisode(foundProgress.season, foundProgress.epNum, foundProgress.time);
        };
    } else {
        banner.classList.add('hidden');
    }
}

/* ======================================================== */
/*          MULTIPLE FILES MATCHING & REMUXING              */
/* ======================================================== */

function openFolderLinkDialog() {
    if (!activeLibraryItem) return;
    
    const { item, inLibrary } = normalizeMediaItem(activeLibraryItem);
    if (!inLibrary) {
        if (!library[item.category]) library[item.category] = [];
        library[item.category].push(item);
        saveLibrary();
        showToast("Добавлено в библиотеку для привязки серий!");
        updateHDRezkaLibButton(true);
        renderLibraryGrid();
    }
    
    if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.select_link_folder(item.id, item.title);
    } else {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.multiple = true;
        fileInput.accept = "audio/*,video/*,.ts";
        fileInput.onchange = (e) => {
            const files = Array.from(e.target.files).map(f => ({
                name: f.name,
                blobUrl: URL.createObjectURL(f),
                path: '',
                size: f.size || 0
            }));
            completeMultipleEpisodesLinking(item.id, files);
        };
        fileInput.click();
    }
}

async function completeMultipleEpisodesLinking(malId, files) {
    let matchedItem = null;
    for (const cat of ['anime', 'show', 'movie']) {
        matchedItem = (library[cat] || []).find(i => i.id === malId);
        if (matchedItem) break;
    }
    
    if (!matchedItem) return;
    
    showToast("Анализ и авто-сопоставление файлов...");
    
    let linkedCount = 0;
    
    for (const file of files) {
        let path = file.path || '';
        let originalName = file.name;
        
        // Extract episode number from original filename as requested by user!
        const epMatch = originalName.match(/(?:ep|episode|s\d+e|series|серия|серии)?\s*(\d+)/i);
        // Backend parses the episode from the release name (skips 1080p, years, CRCs); regex is the fallback.
        const epNum = Number(file.episode) || (epMatch ? parseInt(epMatch[1]) : 0);
        if (!epNum) continue;
        
        const ep = matchedItem.episodes.find(e => e.num === epNum);
        if (ep) {
            let finalPath = path;
            let finalName = originalName;
            
            // Remux TS files on-the-fly securely
            if (window.pywebview && window.pywebview.api && path && path.toLowerCase().endsWith('.ts')) {
                showToast(`Ремуксинг Episodes ${epNum}...`);
                try {
                    const res = await window.pywebview.api.process_file(path, originalName);
                    if (res && res.path) {
                        finalPath = res.path;
                        finalName = res.name;
                    }
                } catch(e) {
                    console.error("Multi-remux failed for file:", originalName, e);
                }
            }
            
            ep.path = finalPath;
            ep.name = finalName;
            linkedCount++;
        }
    }
    
    if (linkedCount > 0) {
        saveLibrary();
        showToast(`Успешно linked ${linkedCount} серий!`);
        
        if (activeLibraryItem && activeLibraryItem.id === malId) {
            activeLibraryItem.episodes = matchedItem.episodes;
            renderHDRezkaEpisodes();
        }
        renderLibraryGrid();
    } else {
        showToast("Не удалось сопоставить файлы с сериями.");
    }
}

/* ======================================================== */
/*          SRT SUBTITLES ENGINE WITH MANUALLY TOGGLE       */
/* ======================================================== */

let loadedSubtitles = [];
let isSubtitlesEnabled = false;

function parseSRTSubtitles(text) {
    const lines = text.split(/\r?\n/);
    const subs = [];
    let currentSub = null;
    
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        
        if (/^\d+$/.test(line)) {
            if (currentSub) subs.push(currentSub);
            currentSub = { id: line, start: 0, end: 0, text: [] };
        } else if (line.includes('-->')) {
            const parts = line.split('-->');
            if (parts.length === 2 && currentSub) {
                currentSub.start = parseTimecode(parts[0].trim());
                currentSub.end = parseTimecode(parts[1].trim());
            }
        } else if (currentSub) {
            currentSub.text.push(line);
        }
    });
    if (currentSub) subs.push(currentSub);
    return subs;
}

function parseTimecode(tc) {
    const match = tc.match(/(\d+):(\d+):(\d+)[,\.](\d+)/);
    if (match) {
        const h = parseInt(match[1]);
        const m = parseInt(match[2]);
        const s = parseInt(match[3]);
        const ms = parseInt(match[4]);
        return h * 3600 + m * 60 + s + ms / 1000;
    }
    return 0;
}

function updateSubtitlesDisplay() {
    const overlay = document.getElementById('subtitles-overlay');
    if (!overlay || !isSubtitlesEnabled || loadedSubtitles.length === 0 || !DOM.player) {
        if (overlay) overlay.classList.add('hidden');
        return;
    }
    
    const ct = DOM.player.currentTime;
    const current = loadedSubtitles.find(s => ct >= s.start && ct <= s.end);
    
    if (current) {
        overlay.innerHTML = current.text.join('<br>');
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

function openSubtitleFileDialog() {
    if (isSubtitlesEnabled) {
        isSubtitlesEnabled = false;
        const overlay = document.getElementById('subtitles-overlay');
        if (overlay) overlay.classList.add('hidden');
        document.getElementById('subtitle-btn').classList.remove('active');
        showToast("Субтитры выключены");
        return;
    }
    
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ".srt";
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
                loadedSubtitles = parseSRTSubtitles(event.target.result);
                isSubtitlesEnabled = true;
                document.getElementById('subtitle-btn').classList.add('active');
                showToast(`Субтитры загружены: ${file.name}`);
            };
            reader.readAsText(file);
        }
    };
    input.click();
}

/* ======================================================== */
/*          ONGOING RELEASES WEEKLY COUNTDOWN SCHEDULER     */
/* ======================================================== */

function renderReleaseSchedule() {
    const list = document.getElementById('watching-schedule-list');
    if (!list) return;
    
    list.innerHTML = '';
    
    const airingItems = [];
    ['anime', 'show', 'movie'].forEach(cat => {
        (library[cat] || []).forEach(item => {
            if (item.status === 'Currently Airing' || item.status === 'Ongoing' || item.status === 'Транслируется') {
                airingItems.push(item);
            }
        });
    });
    
    if (airingItems.length === 0) {
        list.innerHTML = `
            <div class="empty-playlist" style="padding: 24px 0;">
                <p>Нет онгоингов в вашей Библиотеке.</p>
                <p style="font-size: 0.6rem; color: var(--text-muted); margin-top: 4px;">Добавьте транслирующиеся тайтлы!</p>
            </div>
        `;
        return;
    }
    
    airingItems.forEach(item => {
        const card = document.createElement('div');
        card.className = 'schedule-item';
        
        let countdownText = 'Завершен';
        if (item.aired_from) {
            const startDate = new Date(item.aired_from);
            const now = Date.now();
            const elapsed = now - startDate.getTime();
            
            if (elapsed < 0) {
                // Not yet premiered
                const diffMs = startDate.getTime() - now;
                countdownText = "Анонс: " + formatDiffTime(diffMs);
            } else {
                const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
                const weeksElapsed = Math.floor(elapsed / oneWeekMs);
                const totalEps = item.episodes ? item.episodes.length : 12;
                
                if (weeksElapsed < totalEps) {
                    const nextEpNum = weeksElapsed + 1;
                    const nextEpReleaseTime = startDate.getTime() + weeksElapsed * oneWeekMs + oneWeekMs;
                    const diffMs = nextEpReleaseTime - now;
                    countdownText = `Эп ${nextEpNum}: ${formatDiffTime(diffMs)}`;
                } else {
                    countdownText = 'Вышел полностью';
                }
            }
        }
        
        card.innerHTML = `
            <div class="schedule-item-details" style="cursor: pointer;">
                <div class="schedule-item-title" title="${item.title}">${item.title}</div>
                <div class="schedule-item-subtitle">Онгоинг • Всего: ${item.episodes ? item.episodes.length : '?'} eps.</div>
            </div>
            <div class="schedule-timer-badge">${countdownText}</div>
        `;
        
        card.addEventListener('dblclick', () => {
            openHDRezkaPage(item);
        });
        
        list.appendChild(card);
    });
}

function formatDiffTime(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const days = Math.floor(totalSecs / 86400);
    const hours = Math.floor((totalSecs % 86400) / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    
    if (days > 0) {
        return `${days}д ${hours}ч`;
    }
    if (hours > 0) {
        return `${hours}ч ${mins}м`;
    }
    return `${mins}м`;
}

/* ======================================================== */
/*          INTERACTIVE HOTKEYS HELP OVERLAY TOOL           */
/* ======================================================== */

function toggleHotkeysHelp() {
    const overlay = document.getElementById('hotkeys-overlay');
    if (!overlay) return;
    
    overlay.classList.toggle('hidden');
    if (!overlay.classList.contains('hidden')) {
        showToast("Справка по горячим клавишам");
    }
}

/* ======================================================== */
/*          SMART TIMELINE VIDEO BOOKMARKS SYSTEM           */
/* ======================================================== */

function addVideoBookmark() {
    if (!DOM.player || !activeLibraryItem || !activeEpisodeNum) {
        showToast("Закладки доступны только при просмотре серий библиотеки.");
        return;
    }
    
    const duration = getActiveDuration();
    if (duration <= 0) return;
    
    const ct = DOM.player.currentTime;
    const label = prompt("Введите описание закладки (опенинг, эпичный бой...):", `Метка ${formatTime(ct)}`);
    if (label === null) return; // Canceled
    
    const key = `bookmarks_${activeLibraryItem.id}_${activeEpisodeNum}`;
    let bookmarks = [];
    try {
        const saved = localStorage.getItem(key);
        if (saved) bookmarks = JSON.parse(saved);
    } catch(e) {}
    
    if (!Array.isArray(bookmarks)) bookmarks = [];
    
    bookmarks.push({
        time: ct,
        label: label.trim() || `Метка ${formatTime(ct)}`,
        timestamp: Date.now()
    });
    
    // Sort bookmarks by time
    bookmarks.sort((a, b) => a.time - b.time);
    
    localStorage.setItem(key, JSON.stringify(bookmarks));
    showToast(`Добавлена закладка: "${label}"`);
    
    renderBookmarksOnTimeline();
}

function renderBookmarksOnTimeline() {
    const container = document.getElementById('bookmarks-markers-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!activeLibraryItem || !activeEpisodeNum) return;
    
    const duration = getActiveDuration();
    if (duration <= 0) return;
    
    const key = `bookmarks_${activeLibraryItem.id}_${activeEpisodeNum}`;
    let bookmarks = [];
    try {
        const saved = localStorage.getItem(key);
        if (saved) bookmarks = JSON.parse(saved);
    } catch(e) {}
    
    if (!Array.isArray(bookmarks) || bookmarks.length === 0) return;
    
    bookmarks.forEach(b => {
        const pct = (b.time / duration) * 100;
        const marker = document.createElement('div');
        marker.className = 'bookmark-marker';
        marker.style.left = `${pct}%`;
        marker.setAttribute('title', `${b.label} (${formatTime(b.time)})`);
        
        // Single click jumps to that moment!
        marker.addEventListener('click', (e) => {
            e.stopPropagation();
            if (DOM.player) {
                DOM.player.currentTime = b.time;
                showToast(`Переход к: ${b.label}`);
            }
        });
        
        container.appendChild(marker);
    });
}

/* ======================================================== */
/*          PERMANENT DATABASES LOAD DRIVER (PYTHON)        */
/* ======================================================== */

async function loadAllDataFromPython(options = {}) {
    const background = !!options.background;
    if (isDatabaseLoaded || window.__dbLoadInProgress) return; // Prevent double load!
    window.__dbLoadInProgress = true;

    // Symmetrical 15-level self-healing retry loop!
    let retries = 0;
    while ((!window.pywebview || !window.pywebview.api) && retries < 15) {
        await new Promise(resolve => setTimeout(resolve, 100));
        retries++;
    }

    if ((window.pywebview && window.pywebview.api) || true) {
        console.log("[Storage Engine] Performing unified database load after " + (retries * 100) + "ms...");
        try {
            let rawDB;
            if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.load_all_databases === 'function') {
                rawDB = await withTimeout(window.pywebview.api.load_all_databases(), options.boot ? 3200 : 8000, 'load_all_databases');
            } else {
                const controller = new AbortController();
                const abortTimer = setTimeout(() => controller.abort(), options.boot ? 3200 : 8000);
                const response = await fetch('/api/load_all_databases', { cache: 'no-store', signal: controller.signal });
                clearTimeout(abortTimer);
                rawDB = await response.text();
            }
            const db = JSON.parse(rawDB);
            
            // 1. Restore Library using a merge strategy.
            // Never blindly overwrite localStorage with Python DB: if startup sync is late or DB is older,
            // this can make saved titles appear "lost". We union both stores and preserve linked episodes.
            let localLibrary = { movie: [], show: [], anime: [] };
            try {
                const localSaved = localStorage.getItem('player_library');
                if (localSaved) localLibrary = JSON.parse(localSaved);
            } catch(e) {}
            let pythonLibrary = { movie: [], show: [], anime: [] };
            if (db.library && db.library !== "{}" && db.library !== "[]") {
                try { pythonLibrary = JSON.parse(db.library); } catch(e) {}
            }
            library = mergeLibraryObjects(localLibrary, pythonLibrary);
            if (!library.movie) library.movie = [];
            if (!library.show) library.show = [];
            if (!library.anime) library.anime = [];
            localStorage.setItem('player_library', JSON.stringify(library));
            if (window.pywebview && window.pywebview.api) {
                saveDbDataFallback("library", JSON.stringify(library));
            }
            
            // 2. Restore Watching Progress
            if (db.watching_progress && db.watching_progress !== "{}") {
                localStorage.setItem('watching_progress', db.watching_progress);
            }
            
            // 3. Restore Viewing History
            if (db.viewing_history && db.viewing_history !== "{}") {
                localStorage.setItem('viewing_history', db.viewing_history);
            }
            
            // 4. Restore Playlist & Index
            if (db.playlist && db.playlist !== "{}") {
                playlist = JSON.parse(db.playlist);
            }
            if (db.playlist_index && db.playlist_index !== "{}") {
                currentIndex = parseInt(db.playlist_index);
            }
            
            // Mark database as successfully loaded!
            isDatabaseLoaded = true;
            console.log("[Storage Engine] All databases successfully loaded; lock released!");
            
            // Refresh UI only if the user is already on a data-heavy screen.
            // Never force dashboard rendering or media src assignment during background startup sync.
            if (!background) {
                renderLibraryGrid();
                renderWatchingDashboard();
                renderPlaylist();
            } else {
                const searchView = document.getElementById('search-view');
                const downloaderView = document.getElementById('downloader-view');
                const mergerView = document.getElementById('merger-view');
                const isDataScreenOpen = (searchView && !searchView.classList.contains('hidden'))
                    || (downloaderView && !downloaderView.classList.contains('hidden'))
                    || (mergerView && !mergerView.classList.contains('hidden'));
                if (isDataScreenOpen) {
                    setTimeout(() => {
                        try {
                            renderLibraryGrid();
                            renderWatchingDashboard();
                            renderPlaylist();
                        } catch(e) { console.warn('[Storage Engine] Deferred background render failed:', e); }
                    }, 50);
                }
            }
            
            // Restore last track labels only. Do NOT assign player.src on boot; that can freeze WebView on large files.
            if (playlist.length > 0 && currentIndex !== -1) {
                const track = playlist[currentIndex];
                if (track) {
                    const cleanName = track.name.substring(0, track.name.lastIndexOf('.') || track.name);
                    if (DOM.trackTitle) DOM.trackTitle.textContent = cleanName;
                    if (DOM.trackArtist) DOM.trackArtist.textContent = "Restored playlist item";
                }
            }
        } catch(e) {
            console.error("[Storage Engine] Unified transaction load failed:", e);
        } finally {
            window.__dbLoadInProgress = false;
        }
    } else {
        // Fallback for browser-only testing
        isDatabaseLoaded = true;
        window.__dbLoadInProgress = false;
        console.log("[Storage Engine] PyWebView API unavailable, fallback lock released!");
    }
}

function savePlaylistPermanently() {
    localStorage.setItem('playlist', JSON.stringify(playlist));
    localStorage.setItem('playlist_index', currentIndex.toString());
    if (isDatabaseLoaded && window.pywebview && window.pywebview.api) {
        saveDbDataFallback("playlist", JSON.stringify(playlist));
        saveDbDataFallback("playlist_index", currentIndex.toString());
    }
}

function removeEpisodeFromWatchingProgress(animeId) {
    localStorage.removeItem('resume_info_' + animeId);
    
    let progress = [];
    try {
        const saved = localStorage.getItem('watching_progress');
        if (saved) progress = JSON.parse(saved);
    } catch(e) {}
    
    if (Array.isArray(progress)) {
        progress = progress.filter(p => p.id !== animeId);
        localStorage.setItem('watching_progress', JSON.stringify(progress));
        if (window.pywebview && window.pywebview.api) {
            saveDbDataFallback("watching_progress", JSON.stringify(progress));
        }
    }
}

/* ======================================================== */
/*          SELF-HEALING RATE-LIMIT AWARE JIKAN FETCH       */
/* ======================================================== */

async function safeFetchJikan(url, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000); // Strict 4s timeout!
            
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (res.status === 429) {
                console.warn(`[Jikan API] Rate limited (429). Retrying in 1.2s...`);
                await new Promise(resolve => setTimeout(resolve, 1200));
                continue;
            }
            return res;
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(resolve => setTimeout(resolve, 800));
        }
    }
    throw new Error("Timeout or network error");
}

/* ======================================================== */
/*          NOHOMO NYAA.SI DOWNLOADER FRONTEND CONTROLLER   */
/* ======================================================== */

async function triggerNyaaSearch(query) {
    const list = document.getElementById('downloader-results-list');
    const aiVerdict = document.getElementById('downloader-ai-verdict');
    
    if (!list || !aiVerdict) return;
    
    list.innerHTML = '<div class="empty-playlist" style="padding: 40px 0;"><p>Поиск раздач на Nyaa.si и перевод запроса через ИИ...</p></div>';
    aiVerdict.innerHTML = '<p style="color: var(--text-muted); text-align: center; margin-top: 40px;">Ждем ответа от аналитика OpenAI GPT-4o-mini...</p>';
    
    if (window.pywebview && window.pywebview.api) {
        try {
            const rawRes = await window.pywebview.api.search_nyaa_torrents(query);
            const res = JSON.parse(rawRes);
            
            if (res.status === "error") {
                list.innerHTML = `<div class="empty-playlist" style="padding: 40px 0;"><p>${res.message}</p></div>`;
                aiVerdict.innerHTML = '<p style="color: #ef4444; text-align: center; margin-top: 40px;">Сбой ИИ-анализа.</p>';
                return;
            }
            
            if (res.status === "empty") {
                list.innerHTML = `<div class="empty-playlist" style="padding: 40px 0;"><p>Раздачи не найдены по запросу: "${res.query}"</p></div>`;
                aiVerdict.innerHTML = '<p style="color: var(--text-muted); text-align: center; margin-top: 40px;">Нет данных для анализа.</p>';
                return;
            }
            
            // 1. Render Torrents List Symmetrically
            renderNyaaResultsList(res.results);
            
            // 2. Render AI Verdict defensively replacing any escaped newlines and setting innerHTML for HTML-buttons!
            const rawVerdict = (res.ai_verdict || "").replace(/\\n/g, '\n');
            const formattedVerdict = rawVerdict.replace(/\n/g, '<br>');
            aiVerdict.innerHTML = formattedVerdict;
        } catch(e) {
            console.error("Downloader search transaction failed:", e);
            list.innerHTML = `<div class="empty-playlist" style="padding: 40px 0;"><p>Произошла непредвиденная ошибка на стороне бэкенда: ${e.toString()}</p><pre style="font-size: 0.55rem; color: rgba(255,255,255,0.4); text-align: left; margin-top: 10px; max-height: 100px; overflow-y: auto;">${e.stack || ""}</pre></div>`;
        }
    } else {
        list.innerHTML = '<div class="empty-playlist" style="padding: 40px 0;"><p>Оффлайн-поиск Nyaa недоступен в демо-окружении браузера.</p></div>';
    }
}

function renderNyaaResultsList(results) {
    const list = document.getElementById('downloader-results-list');
    if (!list) return;
    
    list.innerHTML = '';
    if (!results || !Array.isArray(results)) return;
    
    results.forEach(item => {
        const row = document.createElement('div');
        row.className = 'history-item';
        row.style.cssText = "display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; margin-bottom: 8px;";
        
        const seedColor = item.seeders > 15 ? "#10b981" : (item.seeders > 5 ? "#f59e0b" : "#ef4444");
        
        // Construct visual tags
        let tags = "";
        if (item.type === "BATCH") tags += `<span style="background: rgba(16, 185, 129, 0.12); color: #10b981; font-size: 0.58rem; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-right: 6px;">BATCH</span>`;
        if (item.censorship === "UNCENSORED") tags += `<span style="background: rgba(239, 68, 68, 0.12); color: #ef4444; font-size: 0.58rem; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-right: 6px;">БЕЗ ЦЕНЗУРЫ 🔞</span>`;
        if (item.source === "BDRip" || item.source === "BDRemux") tags += `<span style="background: rgba(124, 92, 252, 0.12); color: #7c5cfc; font-size: 0.58rem; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-right: 6px;">Blu-ray</span>`;
        if (item.group !== "UNKNOWN") tags += `<span style="background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.8); font-size: 0.58rem; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-right: 6px;">${item.group}</span>`;
        
        row.innerHTML = `
            <div class="history-item-details" style="cursor: default; flex: 1;">
                <div class="history-item-title" title="${item.title}" style="font-size: 0.75rem; font-weight: 600; line-height: 1.35; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 4px;">${item.title}</div>
                <div style="display: flex; gap: 12px; align-items: center; margin-top: 4px;">
                    <span style="font-size: 0.65rem; color: #7c5cfc; font-weight: 700;">Score: ${item.score}</span>
                    <span style="font-size: 0.62rem; color: var(--text-muted);">Размер: ${item.size}</span>
                    <span style="font-size: 0.62rem; color: ${seedColor}; font-weight: 600;">Сиды: ${item.seeders}</span>
                </div>
                <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">
                    ${tags}
                </div>
            </div>
            <div style="display: flex; gap: 6px; align-items: center;">
                <button class="action-btn" style="background: #7c5cfc; border-color: #7c5cfc; color: #fff; padding: 6px 12px; font-size: 0.65rem; cursor: pointer; border-radius: 6px; font-weight: 700;" id="dl-magnet-btn-${item.idx}">Magnet</button>
                <button class="action-btn" style="background: rgba(255,255,255,0.02); border-color: rgba(255,255,255,0.05); color: #fff; padding: 6px 10px; font-size: 0.65rem; cursor: pointer; border-radius: 6px;" id="dl-torrent-btn-${item.idx}">Torrent</button>
            </div>
        `;
        
        list.appendChild(row);
        
        // Bind Actions
        const magnetBtn = document.getElementById(`dl-magnet-btn-${item.idx}`);
        bindEvent(magnetBtn, 'click', () => {
            if (window.pywebview && window.pywebview.api) {
                window.pywebview.api.start_magnet_link(item.magnet_link);
                showToast("Magnet-ссылка передана торрент-клиенту!");
            }
        });
        
        const torrentBtn = document.getElementById(`dl-torrent-btn-${item.idx}`);
        bindEvent(torrentBtn, 'click', async () => {
            if (window.pywebview && window.pywebview.api) {
                showToast("Скачивание торрент-файла...");
                const path = await window.pywebview.api.download_torrent_to_watch(item.torrent_link, item.title);
                if (path) {
                    showToast(`Скачано в: ${path}`);
                } else {
                    showToast("Сбой скачивания торрента.");
                }
            }
        });
    });
}

/* ======================================================== */
/*              ONE-CLICK RAW/DUB MERGER WORKFLOW           */
/* ======================================================== */
let mergerPairsCache = [];
let mergerWatcherTimer = null;
let mergerBusy = false;
let mergerAutoMergeOnNextDub = false;
let aiPendingActions = [];
let aiPendingChoices = [];

function mergerLog(message) {
    const log = document.getElementById('merger-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = 'merger-log-line';
    const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `${time}  ${message}`;
    if (log.children.length === 1 && log.textContent.trim() === 'Ready.') log.innerHTML = '';
    log.prepend(line);
    while (log.children.length > 80) log.removeChild(log.lastChild);
}

function setMergerStatus(text) {
    const el = document.getElementById('merger-watch-status');
    if (el) el.textContent = text;
}

function renderMergerPairs(pairs) {
    const list = document.getElementById('merger-pairs-list');
    if (!list) return;
    if (!pairs || pairs.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); font-size: 0.72rem;">No matched RAW/DUB pairs yet. Put RAW into raw/ and DUB into dub/.</p>';
        return;
    }
    list.innerHTML = pairs.map(pair => {
        const raw = pair.raw || {};
        const dub = pair.dub || {};
        const ep = raw.episode ? `S${String(raw.season || 1).padStart(2, '0')}E${String(raw.episode).padStart(2, '0')}` : '???';
        return `
            <div class="merger-pair-card" data-ep="${raw.episode || ''}">
                <div class="merger-pair-ep">${ep}</div>
                <div style="min-width:0;">
                    <div class="merger-pair-name" title="${raw.name || ''}">RAW: ${raw.name || '-'}</div>
                    <div class="merger-pair-name" title="${dub.name || ''}">DUB: ${dub.name || '-'}</div>
                    <div style="font-size:0.6rem;color:var(--text-muted);">${raw.size_mb || 0} MB + ${dub.size_mb || 0} MB</div>
                </div>
            </div>`;
    }).join('');
}

async function waitForMergerApi(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.merger_scan === 'function') {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 120));
    }
    return false;
}

async function logMergerApiDiagnostics() {
    try {
        const api = window.pywebview && window.pywebview.api;
        const keys = api ? Object.keys(api).filter(k => !k.startsWith('_')).sort() : [];
        mergerLog('Merger API missing. Available API methods: ' + (keys.length ? keys.join(', ') : 'none'));
        if (api && typeof api.get_app_version === 'function') {
            const version = await api.get_app_version();
            mergerLog('Backend version: ' + version);
        } else {
            mergerLog('Backend version method missing: app.py is old or EXE was not rebuilt with new app.py.');
        }
    } catch(e) {
        mergerLog('API diagnostics failed: ' + e.message);
    }
}

async function mergerScan(silent = false) {
    const apiReady = await waitForMergerApi();
    if (!apiReady) {
        if (!silent) await logMergerApiDiagnostics();
        return null;
    }
    try {
        const raw = await window.pywebview.api.merger_scan();
        const res = JSON.parse(raw || '{}');
        if (res.status === 'success') {
            mergerPairsCache = res.matched || [];
            renderMergerPairs(mergerPairsCache);
            setMergerStatus(mergerWatcherTimer ? `Watching dub/ • ${mergerPairsCache.length} matched` : `${mergerPairsCache.length} matched`);
            if (!silent) {
                if (res.folders) mergerLog(`Folders: raw=${res.folders.raw} | dub=${res.folders.dub}`);
                mergerLog(`Scan complete: ${mergerPairsCache.length} matched episode pair(s). RAW files: ${(res.raw || []).length}, DUB files: ${(res.dub || []).length}.`);
                if (res.invalid && res.invalid.length) {
                    res.invalid.slice(0, 5).forEach(f => mergerLog(`Invalid ${String(f.folder || '').toUpperCase()}: ${f.name} — ${f.reason}`));
                    if (res.invalid.length > 5) mergerLog(`Invalid files hidden: ${res.invalid.length - 5} more.`);
                }
            }
            return res;
        }
        if (!silent) mergerLog(`Scan failed: ${res.message || res.status}`);
        return res;
    } catch (e) {
        if (!silent) mergerLog('Scan error: ' + e.message);
        return null;
    }
}

async function mergerOneClickNext() {
    if (mergerBusy) return;
    mergerBusy = true;
    try {
        await mergerScan(true);
        if (!mergerPairsCache.length) {
            mergerLog('No matched pair. Download DUB into dub/ and RAW into raw/ first.');
            return;
        }
        const pair = mergerPairsCache[0];
        const ep = pair.raw.episode || 0;
        const voiceMode = document.getElementById('merger-voice-mode')?.checked;
        const syncMode = document.getElementById('merger-sync-mode')?.value || 'auto';
        mergerLog(`Autosync started for S${String(pair.raw.season || 1).padStart(2, '0')}E${String(ep).padStart(2, '0')}...`);
        const syncRaw = await window.pywebview.api.merger_autosync(ep, null);
        const sync = JSON.parse(syncRaw || '{}');
        if (sync.status !== 'success' || !sync.autosync || sync.autosync.ok === false) {
            mergerLog('Autosync failed. You can still merge manually later. ' + (sync.autosync?.error || sync.message || ''));
            return;
        }
        const offset = Number(sync.autosync.offset || 0);
        mergerLog(`Autosync OK: offset ${offset >= 0 ? '+' : ''}${offset}s, confidence ${Math.round((sync.autosync.confidence || 0) * 100)}%.`);
        if (voiceMode) {
            mergerLog('Voice-only overlay requested. Demucs can take 5-15 minutes on first run/model download. Do not close the app.');
        } else {
            mergerLog('Fast merge started. Video will be copied without re-encode.');
        }
        const title = (typeof activeLibraryItem !== 'undefined' && activeLibraryItem && activeLibraryItem.title)
            ? activeLibraryItem.title
            : ((pair.raw.name || 'Merged Episode').replace(/S\d{1,2}E\d{1,3}.*/i, '').replace(/[._-]+/g, ' ').trim() || 'Merged Episode');
        setMergerStatus(voiceMode ? 'Demucs / merge running...' : 'Merge running...');
        const mergeRaw = await window.pywebview.api.merger_run(ep, offset, null, title, voiceMode ? 'demucs' : 'off', syncMode);
        const merge = JSON.parse(mergeRaw || '{}');
        if (merge.status === 'success') {
            const ok = (merge.results || []).filter(x => x.result && x.result.ok).length;
            mergerLog(`Merge complete: ${ok}/${(merge.results || []).length} file(s) built.`);
            const first = merge.results && merge.results[0] && merge.results[0].result;
            if (first && first.sync_note) mergerLog(`Sync mode: ${first.sync_note}`);
            if (first && first.voice_note) mergerLog(`Voice mode: ${first.voice_note}`);
            if (first && first.organized && first.organized.ok) {
                mergerLog(`Organized: ${first.organized.path}`);
            }
            showToast('One-click merge complete');
            setMergerStatus('Merge complete');
            await mergerScan(true);
        } else {
            setMergerStatus('Merge failed');
            mergerLog('Merge failed: ' + (merge.message || 'unknown error'));
        }
    } catch (e) {
        mergerLog('One-click error: ' + e.message);
    } finally {
        mergerBusy = false;
    }
}


async function openDubSource(auto = false, context = {}) {
    const url = context.url || 'https://rezka.fi/';
    try {
        if (!(window.pywebview && window.pywebview.api && typeof window.pywebview.api.open_internal_url === 'function')) {
            mergerLog('Internal DUB Browser API is not available. I will NOT open an external browser. Rebuild/restart the app if this persists.');
            showToast('Internal DUB Browser API unavailable');
            return;
        }
        const ok = await window.pywebview.api.open_internal_url(url, context.title || '', context.season || 1, context.episode || 0);
        mergerLog((auto ? 'Auto-opened' : 'Opened') + ` internal DUB browser: ${url}` + (ok ? '' : ' (internal returned false)'));
    } catch (e) {
        mergerLog('Open internal DUB browser failed: ' + e.message);
    }
}

function toggleMergerWatcher(options = {}) {
    const btn = document.getElementById('merger-toggle-watch-btn');
    if (mergerWatcherTimer) {
        clearInterval(mergerWatcherTimer);
        mergerWatcherTimer = null;
        if (btn) btn.textContent = 'Start DUB Watcher';
        setMergerStatus(`${mergerPairsCache.length} matched`);
        mergerLog('DUB watcher stopped.');
        return;
    }
    mergerWatcherTimer = setInterval(async () => {
        if (window.pywebview && window.pywebview.api && window.pywebview.api.merger_import_downloads) {
            try { await window.pywebview.api.merger_import_downloads('dub_folder', true); } catch(e) {}
        }
        const before = mergerPairsCache.length;
        await mergerScan(true);
        if (mergerPairsCache.length > before) {
            mergerLog(`New matched DUB detected (${mergerPairsCache.length}). Ready for one-click merge.`);
            if (mergerAutoMergeOnNextDub && !mergerBusy) {
                mergerAutoMergeOnNextDub = false;
                mergerLog('Auto-merge trigger: expected DUB arrived, starting Auto Sync + Merge All.');
                mergerAutoSyncMergeAll();
            }
        }
    }, 5000);
    if (btn) btn.textContent = 'Stop DUB Watcher';
    setMergerStatus('Watching dub/');
    mergerLog('DUB watcher started. Downloads will be auto-imported to dub/ when episode numbers are detected.');
    if (options && options.openSource === true) {
        openDubSource(true);
    }
    mergerImportDownloads('dub_folder', true).then(() => mergerScan(true));
}


async function mergerInjectDubHelper() {
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.dub_browser_inject_helper)) {
        mergerLog('DUB Helper injection API is not available.');
        return;
    }
    try {
        const raw = await window.pywebview.api.dub_browser_inject_helper();
        const res = JSON.parse(raw || '{}');
        mergerLog(res.status === 'success' ? 'DUB Helper injected. Use its buttons inside the DUB Browser.' : 'DUB Helper injection failed: ' + (res.message || res.status));
    } catch(e) {
        mergerLog('DUB Helper injection error: ' + e.message);
    }
}

async function mergerCleanDubAds() {
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.dub_browser_clean_ads)) {
        mergerLog('Ad clean API is not available. Inject helper first or rebuild app.');
        return;
    }
    try {
        const raw = await window.pywebview.api.dub_browser_clean_ads();
        mergerLog('Ad clean result: ' + raw.slice(0, 220));
    } catch(e) {
        mergerLog('Ad clean error: ' + e.message);
    }
}


async function mergerSmartAuto() {
    if (mergerBusy) return;
    mergerBusy = true;
    try {
        mergerLog('Smart Auto started. Importing Downloads, scanning, then choosing the next safe step...');
        setMergerStatus('Smart Auto running...');
        if (window.pywebview && window.pywebview.api && window.pywebview.api.merger_import_downloads) {
            try { await window.pywebview.api.merger_import_downloads('raw_folder', true); } catch(e) {}
            try { await window.pywebview.api.merger_import_downloads('dub_folder', true); } catch(e) {}
        }
        const scan = await mergerScan(true);
        const pairs = mergerPairsCache || [];
        if (pairs.length > 0) {
            mergerLog(`Smart Auto found ${pairs.length} matched pair(s). Starting batch merge.`);
            mergerBusy = false;
            await mergerAutoSyncMergeAll();
            return;
        }
        const rawCount = scan && scan.raw ? scan.raw.length : 0;
        const dubCount = scan && scan.dub ? scan.dub.length : 0;
        if (rawCount === 0 && dubCount === 0) {
            mergerLog('Smart Auto: no RAW or DUB files found. Ask :3 Assistant for best RAW, then use DUB Browser/source for voice.');
            setMergerStatus('Need RAW and DUB');
        } else if (rawCount === 0) {
            mergerLog('Smart Auto: DUB exists, but RAW is missing. Ask :3 Assistant to download the best RAW.');
            setMergerStatus('Need RAW');
        } else if (dubCount === 0) {
            mergerLog('Smart Auto: RAW exists, but DUB is missing. Opening DUB workflow/watcher.');
            setMergerStatus('Need DUB');
            if (!mergerWatcherTimer) toggleMergerWatcher();
        } else {
            mergerLog('Smart Auto: files exist but no episode match. Check filenames include S01E07 / Episode 7.');
            setMergerStatus('No match');
        }
    } catch(e) {
        mergerLog('Smart Auto error: ' + e.message);
        setMergerStatus('Smart Auto error');
    } finally {
        mergerBusy = false;
    }
}

async function mergerOpenFolder(folderKey) {
    const apiReady = await waitForMergerApi();
    if (!apiReady || !(window.pywebview && window.pywebview.api && window.pywebview.api.merger_open_folder)) {
        await logMergerApiDiagnostics();
        return;
    }
    try {
        const raw = await window.pywebview.api.merger_open_folder(folderKey);
        const res = JSON.parse(raw || '{}');
        if (res.status === 'success') mergerLog(`Opened folder: ${res.path}`);
        else mergerLog(`Open folder failed: ${res.message || res.status}`);
    } catch(e) {
        mergerLog('Open folder error: ' + e.message);
    }
}


async function mergerAutoSyncMergeAll() {
    if (mergerBusy) return;
    mergerBusy = true;
    try {
        await mergerScan(true);
        if (!mergerPairsCache.length) {
            mergerLog('No matched pairs. Put RAW files into raw/ and DUB files into dub/ first.');
            return;
        }
        const voiceMode = document.getElementById('merger-voice-mode')?.checked;
        const syncMode = document.getElementById('merger-sync-mode')?.value || 'auto';
        const title = (typeof activeLibraryItem !== 'undefined' && activeLibraryItem && activeLibraryItem.title)
            ? activeLibraryItem.title
            : 'Merged Series';
        mergerLog(`Batch started: ${mergerPairsCache.length} episode(s). Mode: ${voiceMode ? 'Demucs voice overlay' : 'fast full DUB'}.`);
        mergerLog('Episodes are processed sequentially to avoid FFmpeg/Demucs RAM/GPU collisions.');
        setMergerStatus(voiceMode ? 'Demucs batch running...' : 'Batch merge running...');
        const raw = await window.pywebview.api.merger_autosync_merge_all(title, voiceMode ? 'demucs' : 'off', syncMode);
        const res = JSON.parse(raw || '{}');
        if (res.status === 'success') {
            const results = res.results || [];
            const ok = results.filter(x => x.result && x.result.ok).length;
            results.forEach(x => {
                const ep = x.pair && x.pair.raw ? x.pair.raw.episode : '?';
                const off = x.autosync && x.autosync.offset !== undefined ? x.autosync.offset : 0;
                const note = x.result && x.result.voice_note ? ` (${x.result.voice_note})` : '';
                const syncNote = x.result && x.result.sync_note ? ` | Sync mode: ${x.result.sync_note}` : '';
                const okResult = x.result && x.result.ok;
                mergerLog(`Episode ${ep}: offset ${off >= 0 ? '+' : ''}${off}s → ${okResult ? 'OK' : 'FAILED'}${note}${syncNote}`);
                if (!okResult && x.result && x.result.error) {
                    const compact = String(x.result.error).replace(/\s+/g, ' ');
                    const err = compact.length > 1200 ? compact.slice(-1200) : compact;
                    mergerLog(`Episode ${ep} error: ${err}`);
                }
            });
            mergerLog(`Batch complete: ${ok}/${results.length} output file(s).`);
            setMergerStatus('Batch complete');
            showToast('Batch merge complete');
            await mergerScan(true);
            if (ok > 0) {
                mergerLog('Opening Library linker for merged outputs...');
                setTimeout(() => mergerAddOutputsToLibrary(), 450);
            }
        } else {
            setMergerStatus('Batch failed');
            mergerLog('Batch failed: ' + (res.message || res.status || 'unknown error'));
        }
    } catch (e) {
        setMergerStatus('Batch error');
        mergerLog('Batch error: ' + e.message);
    } finally {
        mergerBusy = false;
    }
}


async function mergerImportDownloads(targetKey, auto = false) {
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.merger_import_downloads)) {
        await logMergerApiDiagnostics();
        return;
    }
    try {
        if (!auto) {
            const label = targetKey === 'raw_folder' ? 'RAW' : 'DUB';
            const ok = confirm(`Import episode-like files from Downloads to ${label} folder?\n\nOnly files with detectable episode numbers will be moved.`);
            if (!ok) {
                mergerLog(`${label} import cancelled by user.`);
                return;
            }
        }
        const raw = await window.pywebview.api.merger_import_downloads(targetKey, true);
        const res = JSON.parse(raw || '{}');
        if (res.status === 'success') {
            mergerLog(`Imported ${res.imported.length} file(s) to ${targetKey === 'raw_folder' ? 'raw/' : 'dub/'}.`);
            res.imported.slice(0, 8).forEach(f => mergerLog(`→ ${f.name}`));
            if (res.skipped && res.skipped.length) mergerLog(`Skipped ${res.skipped.length} media file(s) without episode number.`);
            await mergerScan(true);
        } else {
            mergerLog('Import failed: ' + (res.message || res.status));
        }
    } catch(e) {
        mergerLog('Import error: ' + e.message);
    }
}

function getAllLibraryItemsForMerger() {
    const out = [];
    for (const cat of ['anime', 'show', 'movie']) {
        (library[cat] || []).forEach(item => out.push(Object.assign({ category: cat }, item)));
    }
    return out;
}

function openOutputLibraryDialog(files) {
    const existing = document.getElementById('merger-library-dialog');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'merger-library-dialog';
    overlay.className = 'hotkeys-overlay';
    overlay.innerHTML = `
        <div class="hotkeys-content" style="max-width: 620px; align-items: stretch; text-align: left;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <h2 class="hotkeys-title" style="margin:0;text-align:left;">Add merged outputs to Library</h2>
                <button id="merger-lib-close" class="details-close-btn" style="position:static;">&times;</button>
            </div>
            <p style="font-size:0.72rem;color:var(--text-muted);line-height:1.5;margin-bottom:12px;">Merge is done. Choose the Library title to link these output file(s). Episode numbers are detected from filenames and linked automatically.</p>
            <input id="merger-lib-search" type="text" placeholder="Search anime / show / movie in Library..." style="height:36px;border-radius:18px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.07);color:#fff;padding:0 14px;outline:none;margin-bottom:12px;">
            <div id="merger-lib-results" style="display:flex;flex-direction:column;gap:8px;max-height:360px;overflow-y:auto;"></div>
        </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    document.getElementById('merger-lib-close').onclick = close;
    const input = document.getElementById('merger-lib-search');
    const results = document.getElementById('merger-lib-results');
    const render = () => {
        const q = (input.value || '').toLowerCase().trim();
        const items = getAllLibraryItemsForMerger().filter(i => !q || (i.title || '').toLowerCase().includes(q));
        results.innerHTML = items.length ? items.map((item, idx) => `
            <button class="action-btn merger-lib-choice" data-idx="${idx}" style="justify-content:flex-start;height:auto;padding:10px 12px;text-align:left;">
                <span style="font-weight:800;color:#fff;">${item.title}</span>
                <span style="margin-left:auto;color:var(--text-muted);font-size:0.62rem;text-transform:uppercase;">${item.category}</span>
            </button>`).join('') : '<p style="color:var(--text-muted);font-size:0.72rem;">No Library titles found. Add the title to Library first.</p>';
        results.querySelectorAll('.merger-lib-choice').forEach((btn, n) => {
            btn.onclick = () => {
                const selected = items[n];
                if (!selected) return;
                const ok = confirm(`Are you sure you want to add ${files.length} file(s) to "${selected.title}"?`);
                if (!ok) return;
                let linked = 0;
                files.forEach(file => {
                    const epNum = file.episode;
                    const ep = selected.episodes && selected.episodes.find(e => e.num === epNum);
                    if (ep) {
                        ep.path = file.path;
                        ep.name = file.name;
                        linked++;
                    }
                });
                saveLibrary();
                renderLibraryGrid();
                if (activeLibraryItem && activeLibraryItem.id === selected.id) renderHDRezkaEpisodes();
                mergerLog(`Linked ${linked}/${files.length} output file(s) to ${selected.title}. You can watch it from Library now.`);
                showToast(`Linked ${linked} output file(s) to ${selected.title}`);
                close();
                document.getElementById('tab-search-btn')?.click();
                currentCategory = selected.category || currentCategory;
                renderLibraryGrid();
            };
        });
    };
    input.oninput = render;
    render();
}

async function mergerAddOutputsToLibrary() {
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.merger_list_outputs)) {
        await logMergerApiDiagnostics();
        return;
    }
    try {
        const raw = await window.pywebview.api.merger_list_outputs();
        const res = JSON.parse(raw || '{}');
        if (res.status !== 'success') {
            mergerLog('Output listing failed: ' + (res.message || res.status));
            return;
        }
        const files = (res.files || []).map(f => Object.assign({}, f, { episode: f.episode || 1, season: f.season || 1 }));
        if (!files.length) {
            mergerLog('No output files found.');
            return;
        }
        openOutputLibraryDialog(files);
    } catch(e) {
        mergerLog('Add outputs error: ' + e.message);
    }
}

function initMergerPanelEvents() {
    bindEvent(document.getElementById('merger-smart-auto-btn'), 'click', mergerSmartAuto);
    bindEvent(document.getElementById('merger-advanced-toggle-btn'), 'click', () => { const box = document.getElementById('merger-advanced-actions'); if (box) box.classList.toggle('hidden'); });
    bindEvent(document.getElementById('merger-open-raw-btn'), 'click', () => mergerOpenFolder('raw_folder'));
    bindEvent(document.getElementById('merger-open-dub-btn'), 'click', () => mergerOpenFolder('dub_folder'));
    bindEvent(document.getElementById('merger-open-output-btn'), 'click', () => mergerOpenFolder('output_folder'));
    bindEvent(document.getElementById('merger-open-dub-source-btn'), 'click', () => openDubSource(false));
    bindEvent(document.getElementById('merger-inject-helper-btn'), 'click', mergerInjectDubHelper);
    bindEvent(document.getElementById('merger-clean-ads-btn'), 'click', mergerCleanDubAds);
    bindEvent(document.getElementById('merger-import-raw-btn'), 'click', () => mergerImportDownloads('raw_folder'));
    bindEvent(document.getElementById('merger-import-dub-btn'), 'click', () => mergerImportDownloads('dub_folder'));
    bindEvent(document.getElementById('merger-scan-btn'), 'click', () => mergerScan(false));
    bindEvent(document.getElementById('merger-oneclick-btn'), 'click', mergerOneClickNext);
    bindEvent(document.getElementById('merger-merge-all-btn'), 'click', mergerAutoSyncMergeAll);
    bindEvent(document.getElementById('merger-add-outputs-btn'), 'click', mergerAddOutputsToLibrary);
    bindEvent(document.getElementById('merger-toggle-watch-btn'), 'click', toggleMergerWatcher);
}

/* ======================================================== */
/*                       :3 AI ASSISTANT                    */
/* ======================================================== */
function initAIAssistant() {
    const fab = document.getElementById('ai-assistant-fab');
    const panel = document.getElementById('ai-assistant-panel');
    const close = document.getElementById('ai-assistant-close');
    const input = document.getElementById('ai-assistant-input');
    const send = document.getElementById('ai-assistant-send');
    const messages = document.getElementById('ai-assistant-messages');
    if (!fab || !panel || !input || !send || !messages) return;

    const addMsg = (text, who = 'bot', actions = []) => {
        const wrap = document.createElement('div');
        wrap.className = `ai-msg ai-msg-${who}`;
        wrap.textContent = text;
        if (actions && actions.length && who === 'bot') {
            const row = document.createElement('div');
            row.className = 'ai-actions';
            actions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = 'ai-action-btn';
                btn.textContent = action.label || action.type;
                btn.onclick = () => executeAIAssistantAction(action);
                row.appendChild(btn);
            });
            wrap.appendChild(row);
        }
        messages.appendChild(wrap);
        messages.scrollTop = messages.scrollHeight;
    };
    window.aiAssistantAddMessage = addMsg;

    const waitForAssistantApi = async (timeoutMs = 60000, statusNode = null) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (window.pywebview && window.pywebview.api && typeof window.pywebview.api.ai_assistant_chat === 'function') {
                return true;
            }
            if (statusNode) {
                const sec = Math.ceil((Date.now() - start) / 1000);
                statusNode.textContent = `Waiting for backend API... ${sec}s`;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return false;
    };

    const ask = async (prompt) => {
        let text = (prompt || input.value || '').trim();
        if (!text) return;
        input.value = '';
        addMsg(text, 'user');
        const numericChoice = text.match(/^\s*(\d{1,2})\s*$/);
        if (numericChoice && aiPendingChoices.length) {
            const idx = parseInt(numericChoice[1], 10) - 1;
            const choice = aiPendingChoices[idx];
            if (choice && choice.action) {
                addMsg(`Okay, downloading option ${idx + 1}: ${choice.title || choice.action.title || 'selected RAW'}`, 'bot');
                await executeAIAssistantAction(choice.action);
                return;
            }
            addMsg(`Option ${idx + 1} is not available. Choose 1-${aiPendingChoices.length}.`, 'bot');
            return;
        }
        if (isLocalDubAssistantRequest(text)) {
            const req = parseAssistantEpisodeRequest(text);
            const action = {
                type: 'open_dub_source',
                label: 'Open built-in DUB Browser',
                title: req.title,
                season: req.season,
                episode: req.episode
            };
            aiPendingActions = [action, { type: 'open_merger', label: 'Open Merger' }];
            addMsg(`Opening the built-in DUB Browser for ${req.title} S${String(req.season).padStart(2, '0')}E${String(req.episode).padStart(2, '0')}.\n\nSign in once if needed, start the DUB download on the page, and I will catch the finished file from Downloads/dub/.`, 'bot', aiPendingActions);
            await executeAIAssistantAction(action);
            return;
        }

        if (/^(yes|yep|yeah|download|качай|скачай|да|ага|go)$/i.test(text) && aiPendingActions.length) {
            const torrentAction = aiPendingActions.find(a => a.type === 'torrent_add_raw');
            if (torrentAction) {
                addMsg(`Okay, executing: ${torrentAction.label || torrentAction.type}`, 'bot');
                await executeAIAssistantAction(torrentAction);
                return;
            }
            const searchAction = aiPendingActions.find(a => a.type === 'search_downloader' && a.query);
            if (searchAction) {
                // User wants download, not just UI search: ask backend to resolve a concrete candidate.
                text = `prepare ${searchAction.query} download`;
                addMsg(`Resolving concrete RAW candidate for ${searchAction.query}...`, 'bot');
            } else {
                const action = aiPendingActions[0];
                addMsg(`Okay, executing: ${action.label || action.type}`, 'bot');
                await executeAIAssistantAction(action);
                return;
            }
        }
        addMsg('Waiting for backend / assistant...', 'bot');
        const thinking = messages.lastChild;
        const waitStarted = Date.now();
        const thinkingTimer = setInterval(() => {
            if (thinking && thinking.parentNode) {
                const sec = Math.floor((Date.now() - waitStarted) / 1000);
                thinking.textContent = `Working... ${sec}s\nWaiting for the assistant backend. RAW search may use Nyaa; recommendations may use GPT/Tavily.`;
            }
        }, 1000);
        const context = {
            active_tab: document.querySelector('.tab-btn.active span')?.textContent || '',
            active_title: (typeof activeLibraryItem !== 'undefined' && activeLibraryItem && activeLibraryItem.title) ? activeLibraryItem.title : '',
            merger_pairs: mergerPairsCache ? mergerPairsCache.length : 0,
            library_counts: {
                anime: (library.anime || []).length,
                show: (library.show || []).length,
                movie: (library.movie || []).length
            }
        };
        try {
            let res;
            const cloudUrl = (localStorage.getItem('modernplayer_api_url') || DEFAULT_MODERNPLAYER_API_URL || '').trim().replace(/\/$/, '');
            const cloudToken = localStorage.getItem('modernplayer_api_token') || '';
            const serverToken = localStorage.getItem('modernplayer_server_token') || '';
            if (cloudUrl && !(cloudToken || serverToken)) {
                clearInterval(thinkingTimer);
                thinking.remove();
                addMsg('Cloud Assistant is server-first now. Please login in Profile first, then ask again. Server: ' + cloudUrl, 'bot', []);
                openCloudProfilePanel();
                return;
            }
            if (cloudUrl && (cloudToken || serverToken)) {
                thinking.textContent = 'Working... cloud assistant with internet search...';
                const headers = { 'Content-Type': 'application/json' };
                if (cloudToken) headers['Authorization'] = 'Bearer ' + cloudToken;
                if (serverToken) headers['X-ModernPlayer-Token'] = serverToken;
                const response = await fetch(cloudUrl + '/api/assistant/chat', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ message: text, context })
                });
                res = JSON.parse(await response.text() || '{}');
                if (!response.ok) throw new Error(res.detail || res.message || 'Cloud assistant failed');
            } else {
                const assistantReady = await waitForAssistantApi(60000, thinking);
                if (assistantReady) {
                    const raw = await window.pywebview.api.ai_assistant_chat(text, JSON.stringify(context));
                    res = JSON.parse(raw || '{}');
                } else {
                    const response = await fetch('/api/assistant_chat', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ message: text, context: JSON.stringify(context) })
                    });
                    res = JSON.parse(await response.text() || '{}');
                }
            }
            clearInterval(thinkingTimer);
            thinking.remove();
            aiPendingActions = res.actions || [];
            aiPendingChoices = res.choices || [];
            addMsg(res.answer || 'Done.', 'bot', aiPendingActions);
        } catch(e) {
            clearInterval(thinkingTimer);
            thinking.remove();
            addMsg('Assistant error: ' + e.message, 'bot', [ {type:'open_merger', label:'Open Merger'} ]);
        }
    };

    fab.onclick = () => panel.classList.toggle('hidden');
    close.onclick = () => panel.classList.add('hidden');
    send.onclick = () => ask();
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') ask();
    });
    document.querySelectorAll('.ai-assistant-chips button').forEach(btn => {
        btn.onclick = () => ask(btn.getAttribute('data-prompt'));
    });
}

function closeNavigationBlockers() {
    const hd = document.getElementById('hdrezka-page');
    if (hd) hd.classList.add('hidden');
    const details = document.getElementById('details-panel');
    if (details) details.classList.remove('show');
    const player = document.getElementById('player-viewport');
    if (player) player.classList.remove('hidden');
}

async function pollRawTorrentProgress(label = 'RAW download') {
    const say = (msg) => {
        mergerLog(msg);
        if (window.aiAssistantAddMessage) window.aiAssistantAddMessage(msg, 'bot');
    };
    if (!(window.pywebview && window.pywebview.api && window.pywebview.api.torrent_status)) {
        say('RAW progress is unavailable: backend torrent_status API is missing.');
        return;
    }
    let lastBucket = -1;
    let noDownloadTicks = 0;
    let stalledTicks = 0;
    let lastPct = 0;
    say(`${label}: progress watcher started. The file may appear in raw/ before it is complete; Merger will ignore it until 100%.`);
    for (let i = 0; i < 720; i++) { // up to ~2 hours at 10s interval
        await new Promise(resolve => setTimeout(resolve, 10000));
        try {
            const raw = await window.pywebview.api.torrent_status();
            const res = JSON.parse(raw || '{}');
            const downloads = res.downloads || [];
            const d = downloads[downloads.length - 1];
            if (!d) {
                noDownloadTicks++;
                if (noDownloadTicks === 2) say(`${label}: waiting for torrent metadata...`);
                continue;
            }
            const pct = Number(d.progress || 0);
            const bucket = Math.floor(pct / 5);
            const rate = Number(d.download_rate_kb || 0);
            const peers = Number(d.num_peers || 0);
            const seeds = Number(d.num_seeds || 0);
            if (bucket !== lastBucket) {
                lastBucket = bucket;
                const size = d.total_mb ? ` ${d.downloaded_mb || 0}/${d.total_mb} MB` : '';
                say(`${label}: ${pct.toFixed(1)}%${size} • ${rate} KB/s • peers ${peers} • seeds ${seeds}`);
            }
            if (pct <= lastPct + 0.01 && rate <= 0.1) stalledTicks++; else stalledTicks = 0;
            lastPct = pct;
            if (stalledTicks === 6) {
                say(`${label}: still 0 speed after ~1 minute. This usually means no peers/trackers yet, dead torrent, blocked tracker, or internal libtorrent cannot reach this swarm. Try another RAW option with more seeds or configure qBittorrent WebUI for more reliable downloads.`);
            } else if (stalledTicks > 0 && stalledTicks % 18 === 0) {
                say(`${label}: still stalled (${pct.toFixed(1)}%, peers ${peers}, seeds ${seeds}). If this does not move soon, choose another release.`);
            }
            if (d.finished) {
                say(`${label}: download complete. Scanning raw/dub folders now.`);
                showToast('RAW download complete');
                await mergerScan(true);
                return;
            }
        } catch(e) {
            say('Torrent progress check failed: ' + e.message);
            return;
        }
    }
    say(`${label}: progress watcher timed out. Check your torrent client/download folder.`);
}


async function executeAIAssistantAction(action) {
    const type = action && action.type;
    if (!type) return;
    closeNavigationBlockers();
    if (type === 'open_downloader') {
        document.getElementById('tab-downloader-btn')?.click();
    } else if (type === 'search_downloader') {
        document.getElementById('tab-downloader-btn')?.click();
        const q = action.query || action.title || '';
        const input = document.getElementById('downloader-search-input');
        if (input && q) input.value = q;
        if (q) {
            showToast(`Searching RAW: ${q}`);
            await triggerNyaaSearch(q);
        }
    } else if (type === 'torrent_add_raw') {
        document.getElementById('tab-merger-btn')?.click();
        if (!(window.pywebview && window.pywebview.api && window.pywebview.api.torrent_add_raw)) {
            mergerLog('Internal torrent API is not available. Rebuild the app or install backend update.');
            return;
        }
        try {
            mergerLog(`Adding RAW torrent: ${action.title || action.torrent_link || action.magnet_link}`);
            const raw = await window.pywebview.api.torrent_add_raw(action.torrent_link || '', action.magnet_link || '', action.title || 'RAW Download');
            const res = JSON.parse(raw || '{}');
            if (res.status === 'started') {
                const msg = `RAW torrent started: ${res.name} → ${res.save_path}`;
                mergerLog(msg);
                if (window.aiAssistantAddMessage) window.aiAssistantAddMessage(msg, 'bot');
                if (res.engine === 'libtorrent') {
                    pollRawTorrentProgress(res.name || 'RAW download');
                } else {
                    const m = 'Download was handed to external engine; progress is tracked there. I will scan when you run Smart Auto/Scan.';
                    mergerLog(m);
                    if (window.aiAssistantAddMessage) window.aiAssistantAddMessage(m, 'bot');
                }
            } else if (res.status === 'saved_torrent') {
                const m = `Torrent file saved, but not downloading internally: ${res.path}. Open it in a torrent client or configure qBittorrent/libtorrent for automatic progress.`;
                mergerLog(m);
                if (window.aiAssistantAddMessage) window.aiAssistantAddMessage(m, 'bot');
            } else {
                const m = `Torrent add failed: ${res.message || res.status}`;
                mergerLog(m);
                if (window.aiAssistantAddMessage) window.aiAssistantAddMessage(m, 'bot');
            }
        } catch(e) {
            mergerLog('Torrent action error: ' + e.message);
        }
    } else if (type === 'open_merger') {
        document.getElementById('tab-merger-btn')?.click();
    } else if (type === 'open_dub_source') {
        document.getElementById('tab-merger-btn')?.click();
        await openDubSource(false, {
            title: action.title || '',
            season: action.season || 1,
            episode: action.episode || 0,
            url: action.url || ''
        });
        if (!mergerWatcherTimer) toggleMergerWatcher();
    } else if (type === 'import_raw_downloads') {
        document.getElementById('tab-merger-btn')?.click();
        await mergerImportDownloads('raw_folder', true);
    } else if (type === 'import_dub_downloads') {
        document.getElementById('tab-merger-btn')?.click();
        await mergerImportDownloads('dub_folder', true);
    } else if (type === 'download_dub_external') {
        document.getElementById('tab-merger-btn')?.click();
        if (!(window.pywebview && window.pywebview.api && window.pywebview.api.dub_provider_download_episode)) {
            mergerLog('External DUB provider API is not available.');
            return;
        }
        try {
            mergerLog(`Starting external DUB provider: ${action.title} S${String(action.season || 1).padStart(2, '0')}E${String(action.episode || 1).padStart(2, '0')} voice=${action.voice || 'auto'}`);
            const raw = await window.pywebview.api.dub_provider_download_episode(action.title || '', action.season || 1, action.episode || 1, action.voice || '');
            const res = JSON.parse(raw || '{}');
            if (res.status === 'started') {
                mergerLog(`External DUB download started. Voice: ${res.voice || 'auto/default'}. Watcher will import it when ready.`);
                mergerAutoMergeOnNextDub = true;
                if (!mergerWatcherTimer) toggleMergerWatcher();
            } else {
                mergerLog(`External DUB provider failed: ${res.message || res.status}`);
            }
        } catch(e) {
            mergerLog('External DUB action error: ' + e.message);
        }
    } else if (type === 'merger_scan') {
        document.getElementById('tab-merger-btn')?.click();
        await mergerScan(false);
    } else if (type === 'merger_merge_all') {
        document.getElementById('tab-merger-btn')?.click();
        await mergerAutoSyncMergeAll();
    } else if (type === 'add_outputs_to_library') {
        document.getElementById('tab-merger-btn')?.click();
        await mergerAddOutputsToLibrary();
    }
}

// Attach assistant after DOM init without blocking startup.
setTimeout(initAIAssistant, 800);
