/* ============================================================================
   КАМЕРА И ТРАНСЛЯЦИЯ ЭКРАНА В ГОЛОСОВЫХ КОМНАТАХ (как в Discord)
   ----------------------------------------------------------------------------
   • Кнопки «Камера» и «Экран» — вторая строка голосовой панели.
   • Видео участников — в плавающем окне «сцены»: сетка плиток, клик по плитке —
     крупно, двойной клик — во весь экран. Окно можно перетаскивать за шапку,
     менять размер за угол и свернуть в маленькую плашку.
   • Передача — через заранее созданные каналы соединений (voice.js,
     voiceAddMediaTransceivers): включение не переподключает голос.
   ========================================================================= */

const VOICE_STAGE_POS_KEY = "kaban-voice-stage-pos";
const VOICE_SCREEN_PRESETS = [
    { id: "720", label: "720p · 30 кадров", hint: "Экономно, для любого интернета", width: 1280, height: 720, fps: 30, bitrate: 1500000 },
    { id: "1080", label: "1080p · 30 кадров", hint: "Чёткий текст и интерфейс", width: 1920, height: 1080, fps: 30, bitrate: 2800000 },
    { id: "1080-60", label: "1080p · 60 кадров", hint: "Плавно для игр, нужен быстрый интернет", width: 1920, height: 1080, fps: 60, bitrate: 4500000 }
];
const VOICE_MAX_UPLOAD = 9000000;    // общий исходящий поток на всех зрителей (сетка)

let voiceStageFocus = null;          // id плитки, показанной крупно
let voiceStageMinimized = false;
const voiceStageVideos = new Map();  // id плитки → { el, track }

/* ---- включение/выключение ---- */

async function voiceToggleCamera() {
    const call = voiceCall;
    if (!call) return;
    call.media = call.media || {};
    if (call.media.camTrack) { voiceStopCamera(call); return; }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: "user" }
        });
        if (voiceCall !== call) { stream.getTracks().forEach((t) => t.stop()); return; }
        const track = stream.getVideoTracks()[0];
        try { track.contentHint = "motion"; } catch { /* ок */ }
        track.addEventListener("ended", () => { if (call.media?.camTrack === track) voiceStopCamera(call); });
        call.media.camTrack = track;
        voiceMediaChanged(call);
    } catch (error) {
        toast(error?.name === "NotAllowedError" ? "Нет доступа к камере — разрешите его в настройках" : "Камера не найдена");
    }
}

function voiceStopCamera(call) {
    call.media?.camTrack?.stop();
    if (call.media) call.media.camTrack = null;
    voiceMediaChanged(call);
}

function voiceToggleScreenMenu(force) {
    const call = voiceCall;
    const pop = document.getElementById("voice-golive-pop");
    if (!call || !pop) return;
    if (call.media?.screenTrack) { voiceStopScreen(call); pop.hidden = true; return; }
    const open = typeof force === "boolean" ? force : pop.hidden;
    pop.hidden = !open;
    if (!open) return;
    voiceToggleSfxPanel(false);
    const saved = localStorage.getItem("kaban-golive-preset") || "720";
    pop.innerHTML = `<div class="golive-head">Показать экран</div>` + VOICE_SCREEN_PRESETS.map((p) => `
        <button type="button" class="golive-item${p.id === saved ? " selected" : ""}" onclick="voiceStartScreen('${p.id}')">
            <span class="golive-title">${escapeHTML(p.label)}</span><span class="golive-hint">${escapeHTML(p.hint)}</span>
        </button>`).join("");
}

async function voiceStartScreen(presetId) {
    const call = voiceCall;
    document.getElementById("voice-golive-pop").hidden = true;
    if (!call) return;
    const preset = VOICE_SCREEN_PRESETS.find((p) => p.id === presetId) || VOICE_SCREEN_PRESETS[0];
    try { localStorage.setItem("kaban-golive-preset", preset.id); } catch { /* ок */ }
    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: preset.fps, max: preset.fps } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            systemAudio: "include",
            selfBrowserSurface: "exclude",
            surfaceSwitching: "include"
        });
    } catch (error) {
        if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") toast("Не удалось начать трансляцию");
        return;
    }
    if (voiceCall !== call) { stream.getTracks().forEach((t) => t.stop()); return; }
    call.media = call.media || {};
    const video = stream.getVideoTracks()[0];
    try { video.contentHint = preset.fps >= 60 ? "motion" : "detail"; } catch { /* ок */ }
    video.addEventListener("ended", () => { if (call.media?.screenTrack === video) voiceStopScreen(call); });
    call.media.screenTrack = video;
    call.media.screenAudioTrack = stream.getAudioTracks()[0] || null;
    call.media.screenPreset = preset;
    voiceStageFocus = "me:screen";
    voiceStageMinimized = false;
    voiceMediaChanged(call);
    voiceSound("unmute");
}

function voiceStopScreen(call) {
    call.media?.screenTrack?.stop();
    call.media?.screenAudioTrack?.stop();
    if (call.media) { call.media.screenTrack = null; call.media.screenAudioTrack = null; }
    voiceMediaChanged(call);
}

function voiceStopAllMedia(call) {
    call.media?.camTrack?.stop();
    call.media?.screenTrack?.stop();
    call.media?.screenAudioTrack?.stop();
    call.media = {};
    voiceStageFocus = null;
    voiceStageVideos.forEach(({ el }) => { el.srcObject = null; });
    voiceStageVideos.clear();
    const stage = document.getElementById("voice-stage");
    if (stage) { stage.hidden = true; document.getElementById("voice-stage-grid").textContent = ""; }
}

function voiceMediaChanged(call) {
    call.peers.forEach((peer) => voiceApplyMediaToPeer(call, peer));
    voicePushMeta();
    voiceRefreshUi();
}

// Битрейт: экран — по выбранному качеству, но суммарно на всех зрителей не больше VOICE_MAX_UPLOAD.
// Раньше ограничение почти никогда не применялось: вызывалось сразу после
// replaceTrack, а трек у отправителя появляется позже (replaceTrack асинхронный), —
// и молча пропускалось. Экран уходил каждому
// зрителю без ограничения, забивал исходящий канал, и в комнате заикался голос.
// Теперь вызывается и после replaceTrack, и раз в 3,5 с (voicePingTick); setParameters —
// только когда значение реально изменилось (например, в комнату зашёл новый зритель).
function voiceTuneVideoSenders(call, peer) {
    if (peer.pc.connectionState === "closed") return;
    const viewers = Math.max(1, call.peers.size);
    const t = peer.pc.getTransceivers();
    const tune = (slot, maxBitrate, degradation) => {
        const sender = t[slot]?.sender;
        if (!sender?.track) return;
        maxBitrate = Math.round(maxBitrate);
        const key = maxBitrate + "|" + (degradation || "");
        if (sender._kabanTune === key) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) return;   // ещё не согласовано — повторим позже
            params.encodings[0].maxBitrate = maxBitrate;
            if (degradation) params.degradationPreference = degradation;
            sender._kabanTune = key;
            sender.setParameters(params).catch(() => { sender._kabanTune = null; });
        } catch { /* повторим на следующей проверке */ }
    };
    tune(VOICE_SLOT_CAM, Math.min(450000, VOICE_MAX_UPLOAD / viewers / 3));
    const preset = call.media?.screenPreset || VOICE_SCREEN_PRESETS[0];
    tune(VOICE_SLOT_SCREEN, Math.max(600000, Math.min(preset.bitrate, VOICE_MAX_UPLOAD / viewers)), preset.fps >= 60 ? "maintain-framerate" : "maintain-resolution");
    if (typeof prioritizeAudioSenders === "function") prioritizeAudioSenders(peer.pc);
}

/* ---- сцена с видео ---- */

function voiceStageTiles() {
    const call = voiceCall;
    if (!call) return [];
    const tiles = [];
    const media = call.media || {};
    const myMeta = voiceMeta();
    if (media.screenTrack) tiles.push({ id: "me:screen", userId: myRealUserId, track: media.screenTrack, name: "Ваш экран", live: true, meta: myMeta });
    if (media.camTrack) tiles.push({ id: "me:cam", userId: myRealUserId, track: media.camTrack, name: "Вы", mirror: true, meta: myMeta });
    Object.entries(call.members || {}).forEach(([userId, meta]) => {
        if (userId === myRealUserId) return;
        const peer = call.peers.get(userId);
        if (!peer) return;
        const name = voiceMemberName(userId, meta);
        if (meta.screen && peer.screenTrack) tiles.push({ id: userId + ":screen", userId, track: peer.screenTrack, name, live: true, meta });
        if (meta.cam && peer.camTrack) tiles.push({ id: userId + ":cam", userId, track: peer.camTrack, name, meta });
    });
    return tiles;
}

function voiceVideoRefresh() {
    voiceRenderMediaButtons();
    const stage = document.getElementById("voice-stage");
    const grid = document.getElementById("voice-stage-grid");
    if (!stage || !grid) return;

    const tiles = voiceStageTiles();
    if (!tiles.length) {
        stage.hidden = true;
        voiceStageVideos.forEach(({ el }) => { el.srcObject = null; });
        voiceStageVideos.clear();
        grid.textContent = "";
        voiceStageFocus = null;
        return;
    }
    if (voiceStageFocus && !tiles.some((t) => t.id === voiceStageFocus)) voiceStageFocus = null;
    const wasHidden = stage.hidden;
    stage.hidden = false;
    if (wasHidden) voiceStageRestorePosition(stage);
    stage.classList.toggle("minimized", voiceStageMinimized);
    stage.classList.toggle("has-focus", !!voiceStageFocus && tiles.length > 1);
    stage.dataset.count = String(Math.min(tiles.length, 9));
    document.getElementById("voice-stage-title").textContent = `${voiceCall.roomName} · ${tiles.length === 1 ? "1 видео" : tiles.length + " видео"}`;

    // Плитки не пересоздаём — иначе видео моргает. Только добавляем/убираем/переставляем.
    const keep = new Set(tiles.map((t) => t.id));
    [...grid.children].forEach((el) => { if (!keep.has(el.dataset.tile)) { voiceStageVideos.get(el.dataset.tile)?.el && (voiceStageVideos.get(el.dataset.tile).el.srcObject = null); voiceStageVideos.delete(el.dataset.tile); el.remove(); } });

    tiles.forEach((tile, index) => {
        let el = grid.querySelector(`[data-tile="${CSS.escape(tile.id)}"]`);
        if (!el) {
            el = document.createElement("div");
            el.className = "vstage-tile";
            el.dataset.tile = tile.id;
            el.innerHTML = `<video autoplay playsinline muted></video><span class="vstage-name"></span><span class="vstage-live">В ЭФИРЕ</span><button type="button" class="vstage-full" title="Во весь экран" aria-label="Во весь экран"><svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg></button>`;
            el.onclick = (e) => {
                if (e.target.closest(".vstage-full")) { voiceStageFullscreen(el); return; }
                voiceStageFocus = voiceStageFocus === tile.id ? null : tile.id;
                voiceVideoRefresh();
            };
            el.ondblclick = () => voiceStageFullscreen(el);
            grid.appendChild(el);
        }
        if (grid.children[index] !== el) grid.insertBefore(el, grid.children[index] || null);
        const video = el.querySelector("video");
        const known = voiceStageVideos.get(tile.id);
        if (!known || known.track !== tile.track) {
            video.srcObject = new MediaStream([tile.track]);
            playOrUnlock(video);
            voiceStageVideos.set(tile.id, { el: video, track: tile.track });
        }
        el.classList.toggle("mirror", !!tile.mirror);
        el.classList.toggle("live", !!tile.live);
        el.classList.toggle("focused", voiceStageFocus === tile.id);
        el.dataset.voiceUser = tile.userId;
        el.querySelector(".vstage-name").textContent = tile.name;
    });

    voiceApplySpeakingClasses();
}

function voiceRenderMediaButtons() {
    const call = voiceCall;
    const cam = document.getElementById("voice-cam-btn");
    const screen = document.getElementById("voice-screen-btn");
    if (!cam || !screen) return;
    const camOn = !!call?.media?.camTrack;
    const screenOn = !!call?.media?.screenTrack;
    cam.classList.toggle("on", camOn);
    cam.querySelector("em").textContent = "Камера";
    cam.title = camOn ? "Выключить камеру" : "Включить камеру";
    screen.classList.toggle("on", screenOn);
    screen.querySelector("em").textContent = screenOn ? "Стоп" : "Экран";
    screen.title = screenOn ? "Остановить показ экрана" : "Показать экран всей комнате";
    screen.hidden = !(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function");
}

function voiceStageToggleMinimize() {
    voiceStageMinimized = !voiceStageMinimized;
    voiceVideoRefresh();
}

function voiceStageFullscreen(target) {
    const el = target || document.getElementById("voice-stage");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
}

/* ---- перетаскивание окна сцены ---- */

function voiceStageRestorePosition(stage) {
    let pos = null;
    try { pos = JSON.parse(localStorage.getItem(VOICE_STAGE_POS_KEY)); } catch { /* по умолчанию */ }
    if (!pos || window.innerWidth <= 650) { stage.style.left = stage.style.top = stage.style.width = stage.style.height = ""; return; }
    const w = Math.min(pos.w || 520, window.innerWidth - 16);
    const h = Math.min(pos.h || 340, window.innerHeight - 16);
    stage.style.width = w + "px";
    stage.style.height = h + "px";
    stage.style.left = Math.max(8, Math.min(pos.x, window.innerWidth - w - 8)) + "px";
    stage.style.top = Math.max(8, Math.min(pos.y, window.innerHeight - 60)) + "px";
    stage.style.right = "auto";
}

function voiceStageSavePosition(stage) {
    const r = stage.getBoundingClientRect();
    try { localStorage.setItem(VOICE_STAGE_POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })); } catch { /* ок */ }
}

(function initVoiceStage() {
    const stage = document.getElementById("voice-stage");
    const head = document.getElementById("voice-stage-head");
    if (!stage || !head) return;
    let drag = null;
    head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button") || window.innerWidth <= 650) return;
        const r = stage.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
        head.setPointerCapture(e.pointerId);
        stage.classList.add("dragging");
    });
    head.addEventListener("pointermove", (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const w = stage.offsetWidth;
        stage.style.left = Math.max(8, Math.min(e.clientX - drag.dx, window.innerWidth - w - 8)) + "px";
        stage.style.top = Math.max(8, Math.min(e.clientY - drag.dy, window.innerHeight - 48)) + "px";
        stage.style.right = "auto";
    });
    const end = () => { if (!drag) return; drag = null; stage.classList.remove("dragging"); voiceStageSavePosition(stage); };
    head.addEventListener("pointerup", end);
    head.addEventListener("pointercancel", end);
    // Размер меняется за уголок (CSS resize) — запоминаем.
    if (typeof ResizeObserver === "function") {
        let t = 0;
        new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => { if (!stage.hidden && !stage.classList.contains("minimized")) voiceStageSavePosition(stage); }, 400); }).observe(stage);
    }
})();

document.addEventListener("pointerdown", (event) => {
    const pop = document.getElementById("voice-golive-pop");
    if (pop && !pop.hidden && !event.target.closest("#voice-golive-pop, #voice-screen-btn")) pop.hidden = true;
});
