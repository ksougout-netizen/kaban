/* ============================================================================
   «СЛУШАТЬ ВМЕСТЕ»: общий плеер в чате, который играет синхронно у всех, кто
   присоединился. Управлять может любой участник сессии (пауза, перемотка,
   следующий трек, очередь).
   • Источники: аудио из этого чата (музыка, присланная файлом), прямая ссылка
     на аудиофайл, ссылка на YouTube.
   • Синхронизация: realtime-канал чата "listen:<chat_id>" — события состояния
     (очередь, трек, играет/пауза, позиция + метка времени). Каждый клиент
     вычисляет «где мы сейчас» = позиция + прошедшее время и подгоняет плеер,
     расхождение больше ~1.8 с выравнивается перемоткой. Часы устройств должны
     быть правильными (обычная автосинхронизация системы).
   • Присутствие: в сессии те, кто в presence-канале; в чате с активной
     сессией у остальных — полоса «Слушают вместе — присоединиться».
   YouTube на странице, открытой как file:// (не по https), может отказать
   во встраивании — аудиофайлы работают везде.
   ========================================================================= */

const LISTEN_YT_API = "https://www.youtube.com/iframe_api";
const LISTEN_DRIFT_LIMIT = 1.8;

// ---- общий канал на чат (один на всех подписчиков: баннер и сама сессия) ----------------
const listenHubs = new Map(); // chatId → { api, eventListeners:Set, presenceListeners:Set, refs, participants:[] }

function listenHubAcquire(chatId, { onEvent, onPresence } = {}) {

    let hub = listenHubs.get(chatId);

    if (!hub) {
        hub = { api: null, eventListeners: new Set(), presenceListeners: new Set(), refs: 0, participants: [], pending: [] };
        listenHubs.set(chatId, hub);
        KabanAPI.openListenChannel(chatId, {
            onEvent: (payload) => hub.eventListeners.forEach((fn) => fn(payload)),
            onPresence: (ids) => { hub.participants = ids; hub.presenceListeners.forEach((fn) => fn(ids)); }
        }).then((api) => {
            if (!listenHubs.has(chatId) || listenHubs.get(chatId) !== hub) { api?.close(); return; }
            hub.api = api;
            hub.pending.splice(0).forEach((fn) => fn(api));
        }).catch((error) => console.warn("Не удалось открыть канал «слушать вместе»", error));
    }

    hub.refs++;
    if (onEvent) hub.eventListeners.add(onEvent);
    if (onPresence) { hub.presenceListeners.add(onPresence); if (hub.participants.length) onPresence(hub.participants); }

    return {
        hub,
        run: (fn) => (hub.api ? fn(hub.api) : hub.pending.push(fn)),
        release() {
            if (onEvent) hub.eventListeners.delete(onEvent);
            if (onPresence) hub.presenceListeners.delete(onPresence);
            hub.refs--;
            if (hub.refs <= 0) { hub.api?.close(); listenHubs.delete(chatId); }
        }
    };

}

// ---- состояние сессии ------------------------------------------------------------------------

let listenRoom = null;     // { chatId, handle, state, loadedTrackId, participants[] }
let listenWatcher = null;  // пассивный наблюдатель для баннера { chatId, handle }
let listenTimer = null;
let listenSeeking = false;

const listenAudio = new Audio();
listenAudio.preload = "auto";
let listenYt = null;
let listenYtReady = null;

function emptyListenState() { return { queue: [], index: -1, playing: false, position: 0, at: 0, rev: 0 }; }

function listenCurrentTrack() {
    return listenRoom ? (listenRoom.state.queue[listenRoom.state.index] || null) : null;
}

function listenTargetTime() {
    const s = listenRoom.state;
    return s.playing ? s.position + (Date.now() - s.at) / 1000 : s.position;
}

/* ---- движки воспроизведения ------------------------------------------------------------------ */

function listenLoadYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (!listenYtReady) {
        listenYtReady = new Promise((resolve, reject) => {
            const previous = window.onYouTubeIframeAPIReady;
            window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(); };
            const script = document.createElement("script");
            script.src = LISTEN_YT_API;
            script.onerror = () => { listenYtReady = null; reject(new Error("YouTube недоступен")); };
            document.head.appendChild(script);
        });
    }
    return listenYtReady;
}

async function listenEnsureYt(videoId, startSeconds, autoplay) {

    await listenLoadYtApi();
    const wrap = document.getElementById("listen-yt-wrap");
    wrap.hidden = false;

    if (listenYt) {
        if (autoplay) listenYt.loadVideoById({ videoId, startSeconds });
        else listenYt.cueVideoById({ videoId, startSeconds });
        return;
    }

    await new Promise((resolve) => {
        listenYt = new YT.Player("listen-yt", {
            videoId,
            width: "100%",
            height: "100%",
            playerVars: { controls: 0, rel: 0, playsinline: 1, modestbranding: 1, disablekb: 1, start: Math.floor(startSeconds || 0), autoplay: autoplay ? 1 : 0 },
            events: {
                onReady: () => resolve(),
                onStateChange: (event) => { if (event.data === 0) listenOnTrackEnded(); },
                onError: () => toast("Это видео нельзя воспроизвести во встроенном плеере")
            }
        });
    });

}

// YouTube-плеер после переключения трека ещё какое-то время отдаёт время и
// ДЛИТЕЛЬНОСТЬ ПРОШЛОГО видео — ползунок и перемотка в начале нового трека
// работали по чужой длительности. Верим ему, только когда загружено именно наше видео.
function listenYtMatches(track) {
    try { return !!listenYt && listenYt.getVideoData?.()?.video_id === track.src; } catch { return false; }
}

function listenAudioMatches(track) {
    return !!track && listenRoom?.loadedTrackId === track.id && listenAudio.readyState >= 1;
}

function listenEngineTime() {
    const track = listenCurrentTrack();
    if (track?.kind === "youtube") return listenYtMatches(track) ? (listenYt.getCurrentTime?.() || 0) : 0;
    return listenAudioMatches(track) ? (listenAudio.currentTime || 0) : 0;
}

function listenEngineDuration() {
    const track = listenCurrentTrack();
    if (track?.kind === "youtube") return listenYtMatches(track) ? (listenYt.getDuration?.() || 0) : 0;
    return listenAudioMatches(track) && Number.isFinite(listenAudio.duration) ? listenAudio.duration : 0;
}

// Плеер действительно играет нужный трек (а не грузится) — только тогда имеет смысл подгонять время.
function listenEngineReady(track) {
    if (!track) return false;
    if (track.kind === "youtube") return listenYtMatches(track) && listenYt.getPlayerState?.() === 1;
    return listenAudioMatches(track) && !listenAudio.paused && listenAudio.readyState >= 3;
}

function listenEngineSeek(seconds) {
    const track = listenCurrentTrack();
    if (track?.kind === "youtube") listenYt?.seekTo?.(Math.max(0, seconds), true);
    else { try { listenAudio.currentTime = Math.max(0, seconds); } catch { /* метаданные ещё не загружены */ } }
}

async function listenEnginePlayState(playing) {
    const track = listenCurrentTrack();
    if (!track) return;
    if (track.kind === "youtube") {
        if (playing) listenYt?.playVideo?.(); else listenYt?.pauseVideo?.();
    } else if (playing) {
        try { await listenAudio.play(); } catch { toast("Нажмите ▶, чтобы разрешить воспроизведение в браузере"); }
    } else {
        listenAudio.pause();
    }
}

// Привести реальный плеер к общему состоянию.
async function listenReconcile(force) {

    const room = listenRoom;
    if (!room) return;

    const track = listenCurrentTrack();
    if (!track) {
        listenAudio.pause();
        listenYt?.pauseVideo?.();
        document.getElementById("listen-yt-wrap").hidden = true;
        listenRenderUi();
        return;
    }

    const target = Math.max(0, listenTargetTime());

    if (room.loadedTrackId !== track.id) {
        room.loadedTrackId = track.id;
        // Новый трек — сразу сбрасываем время и ползунок, а не показываем прошлые до загрузки.
        document.getElementById("listen-cur").textContent = formatListenTime(target);
        document.getElementById("listen-dur").textContent = "–:––";
        document.getElementById("listen-seek").value = "0";
        if (track.kind === "youtube") {
            listenAudio.pause();
            await listenEnsureYt(track.src, target, room.state.playing);
        } else {
            listenYt?.pauseVideo?.();
            document.getElementById("listen-yt-wrap").hidden = true;
            listenAudio.src = track.src;
            listenAudio.currentTime = target;
        }
    } else if (force || Math.abs(listenEngineTime() - target) > LISTEN_DRIFT_LIMIT) {
        listenEngineSeek(target);
    }

    await listenEnginePlayState(room.state.playing);
    listenRenderUi();

}

function listenOnTrackEnded() {
    const room = listenRoom;
    if (!room) return;
    room.handle.run((api) => api.send({ type: "ended", index: room.state.index, at: Date.now(), sentAt: Date.now() }));
}

listenAudio.addEventListener("ended", () => listenOnTrackEnded());
listenAudio.addEventListener("error", () => { if (listenRoom && listenCurrentTrack()?.kind === "audio") toast("Не удалось воспроизвести этот трек"); });

/* ---- события канала ------------------------------------------------------------------------------ */

// Часы на разных компьютерах расходятся на секунды (Windows подводит время редко),
// а «момент старта» трека (state.at) записан по часам того, кто нажал ▶. Раньше
// его брали как есть — и участники слышали разные места трека ровно на величину
// расхождения часов, подгонка этого не исправляла. Теперь каждое сообщение несёт
// sentAt — время отправки по часам отправителя, и все отметки переводятся в свои
// часы: остаётся только задержка сети (~0,1 с). У старых версий sentAt нет — как раньше.
function listenLocalTime(remoteTime, sentAt) {
    if (typeof remoteTime !== "number" || typeof sentAt !== "number") return remoteTime;
    return remoteTime + (Date.now() - sentAt);
}

function listenLocalizeState(state, sentAt) {
    if (typeof sentAt !== "number" || typeof state.at !== "number") return state;
    return { ...state, at: listenLocalTime(state.at, sentAt) };
}

function listenHandleEvent(payload) {

    const room = listenRoom;
    if (!room || !payload) return;

    if (payload.type === "state" && payload.state) {
        const next = listenLocalizeState(payload.state, payload.sentAt);
        if (next.rev <= room.state.rev) return;
        const previousTrack = listenCurrentTrack();
        room.state = next;
        const track = listenCurrentTrack();
        if (!previousTrack || !track || previousTrack.id !== track.id) room.loadedTrackId = null;
        listenReconcile(true);
        return;
    }

    if (payload.type === "hello") {
        if (payload.from === myRealUserId || !room.state.queue.length) return;
        // Отвечают все, у кого есть состояние; у кого оно свежее, тот и «выигрывает» по rev.
        setTimeout(() => room.handle.run((api) => api.send({ type: "state", state: room.state, sentAt: Date.now() })), Math.random() * 250);
        return;
    }

    if (payload.type === "ended") {
        // Детерминированный переход: все получают одно и то же событие и считают одно и то же.
        if (payload.index !== room.state.index) return;
        const nextIndex = payload.index + 1;
        const hasNext = nextIndex < room.state.queue.length;
        room.state = {
            ...room.state,
            index: hasNext ? nextIndex : payload.index,
            playing: hasNext,
            position: 0,
            at: listenLocalTime(payload.at, payload.sentAt),
            rev: room.state.rev + 1
        };
        room.loadedTrackId = null;
        listenReconcile(true);
    }

}

// Любое действие пользователя: меняем состояние, рассылаем и применяем у себя.
function listenCommit(mutator) {

    const room = listenRoom;
    if (!room) return;

    const previousTrack = listenCurrentTrack();
    const draft = { ...room.state, queue: [...room.state.queue] };
    mutator(draft);
    draft.rev = Math.max(Date.now(), room.state.rev + 1);

    room.state = draft;
    const track = listenCurrentTrack();
    if (!previousTrack || !track || previousTrack.id !== track.id) room.loadedTrackId = null;

    room.handle.run((api) => api.send({ type: "state", state: draft, sentAt: Date.now() }));
    listenReconcile(true);

}

/* ---- управление ------------------------------------------------------------------------------------- */

function listenTogglePlay() {
    if (!listenRoom || !listenCurrentTrack()) { openListenAddModal(); return; }
    listenCommit((s) => {
        const position = Math.max(0, listenTargetTime());
        s.position = position;
        s.at = Date.now();
        s.playing = !s.playing;
    });
}

function listenNext() {
    if (!listenRoom) return;
    const s = listenRoom.state;
    if (s.index + 1 >= s.queue.length) return;
    listenCommit((d) => { d.index = s.index + 1; d.position = 0; d.at = Date.now(); d.playing = true; });
}

function listenPrev() {
    if (!listenRoom) return;
    const s = listenRoom.state;
    // Больше 3 секунд — «в начало трека», иначе — предыдущий.
    if (listenTargetTime() > 3 || s.index <= 0) {
        listenCommit((d) => { d.position = 0; d.at = Date.now(); });
    } else {
        listenCommit((d) => { d.index = s.index - 1; d.position = 0; d.at = Date.now(); d.playing = true; });
    }
}

function listenSeekInput(value) {
    listenSeeking = true;
    const duration = listenEngineDuration();
    if (duration) document.getElementById("listen-cur").textContent = formatListenTime((Number(value) / 1000) * duration);
}

function listenSeekCommit(value) {
    listenSeeking = false;
    const duration = listenEngineDuration();
    if (!listenRoom || !duration) return;
    const position = (Number(value) / 1000) * duration;
    listenCommit((d) => { d.position = position; d.at = Date.now(); });
}

// Громкость = выбранная человеком × приглушение (когда в голосовой комнате кто-то говорит).
let listenBaseVolume = 0.8;
let listenDuckCurrent = 1;
let listenDuckTarget = 1;
let listenDuckTimer = null;

function listenApplyVolume() {
    // «Выключить звук» в голосовой комнате глушит и музыку комнаты (как в Discord).
    const deafened = !!listenRoom?.voiceRoomId && typeof voiceCall !== "undefined" && !!voiceCall?.deafened;
    const volume = deafened ? 0 : Math.max(0, Math.min(1, listenBaseVolume * listenDuckCurrent));
    listenAudio.volume = volume;
    listenYt?.setVolume?.(Math.round(volume * 100));
}

function listenSetVolume(value) {
    listenBaseVolume = Number(value) / 100;
    listenApplyVolume();
    try { localStorage.setItem("kaban-listen-volume", String(value)); } catch { /* не критично */ }
}

// Плавное приглушение музыки: on — кто-то говорит (до 30%), off — возврат к 100%.
function listenDuck(on) {
    listenDuckTarget = on ? 0.3 : 1;
    if (listenDuckTimer) return;
    listenDuckTimer = setInterval(() => {
        const step = listenDuckTarget < listenDuckCurrent ? 0.14 : 0.05; // вниз быстро, вверх мягко
        if (Math.abs(listenDuckTarget - listenDuckCurrent) <= step) {
            listenDuckCurrent = listenDuckTarget;
            clearInterval(listenDuckTimer);
            listenDuckTimer = null;
        } else {
            listenDuckCurrent += listenDuckTarget > listenDuckCurrent ? step : -step;
        }
        listenApplyVolume();
    }, 50);
}

// Что сейчас играет в музыке голосовой комнаты (для подписи в списке комнат).
function listenRoomMusicTitle(chatId, voiceRoomId) {
    const room = listenRoom;
    if (!room || room.chatId !== chatId || room.voiceRoomId !== voiceRoomId || !room.state.playing) return null;
    const track = listenCurrentTrack();
    return track ? String(track.title || "Музыка").slice(0, 80) : null;
}

function listenRemoveTrack(index) {
    if (!listenRoom) return;
    listenCommit((d) => {
        d.queue.splice(index, 1);
        if (!d.queue.length) { d.index = -1; d.playing = false; d.position = 0; }
        else if (index < d.index) d.index -= 1;
        else if (index === d.index) { d.index = Math.min(d.index, d.queue.length - 1); d.position = 0; d.at = Date.now(); }
    });
}

function listenPlayIndex(index) {
    if (!listenRoom || index === listenRoom.state.index) return;
    listenCommit((d) => { d.index = index; d.position = 0; d.at = Date.now(); d.playing = true; });
}

/* ---- треки -------------------------------------------------------------------------------------------- */

function parseYoutubeId(url) {
    const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/))([\w-]{11})/i);
    return match ? match[1] : null;
}

function trackTitleFromUrl(url) {
    try {
        const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
        return name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").trim() || "Аудио";
    } catch { return "Аудио"; }
}

async function listenAddTrack(track) {

    if (!listenRoom) return;
    const enriched = { id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), by: myRealUserId, ...track };

    listenCommit((d) => {
        d.queue.push(enriched);
        if (d.index < 0) { d.index = d.queue.length - 1; d.position = 0; d.at = Date.now(); d.playing = true; }
    });

    toast(`Добавлено в очередь: ${enriched.title}`);

}

async function addListenTrackFromInput() {

    const input = document.getElementById("listen-url-input");
    const url = input.value.trim();
    if (!url) { toast("Вставьте ссылку на YouTube или аудиофайл"); return; }
    if (!/^https?:\/\//i.test(url)) { toast("Ссылка должна начинаться с http:// или https://"); return; }

    const videoId = parseYoutubeId(url);
    let title;
    if (videoId) {
        title = "YouTube";
        try {
            const response = await fetch("https://noembed.com/embed?url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + videoId));
            const json = await response.json();
            if (json?.title) title = json.title;
        } catch { /* название необязательно */ }
        await listenAddTrack({ kind: "youtube", src: videoId, title });
    } else {
        await listenAddTrack({ kind: "audio", src: url, title: trackTitleFromUrl(url) });
    }

    input.value = "";
    closeListenAddModal();

}

function openListenAddModal() {

    if (!listenRoom) return;

    const audios = [...realMessagesById.values()]
        .filter((m) => m.type === "audio" && m.attachment_url && !m.deleted_at && m.chat_id === listenRoom.chatId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    document.getElementById("listen-chat-audio").innerHTML = audios.length
        ? audios.map((m) => `
            <button type="button" class="listen-audio-row" data-url="${escapeHTML(m.attachment_url)}" data-title="${escapeHTML(m.attachment_meta?.name || trackTitleFromUrl(m.attachment_url))}" onclick="addListenChatAudio(this)">
                <span class="listen-audio-icon">♪</span>
                <span class="listen-audio-name">${escapeHTML(m.attachment_meta?.name || trackTitleFromUrl(m.attachment_url))}</span>
                <span class="listen-audio-add">＋</span>
            </button>`).join("")
        : '<div class="group-perms-hint">В этом чате пока нет присланной музыки. Отправьте аудиофайл через меню вложений («Музыка») или вставьте ссылку выше.</div>';

    const backdrop = document.getElementById("listen-add-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("listen-url-input").focus();

}

function closeListenAddModal() {
    const backdrop = document.getElementById("listen-add-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function addListenChatAudio(button) {
    listenAddTrack({ kind: "audio", src: button.dataset.url, title: button.dataset.title });
    closeListenAddModal();
}

/* ---- вход / выход ------------------------------------------------------------------------------------- */

function startListenTogether() {

    closeAttachMenu();
    if (!currentChatId) { toast("Откройте чат, чтобы слушать вместе"); return; }
    if (currentChatIsSecret) { toast("В секретных чатах общий плеер недоступен"); return; }
    if (currentChatType === "group" && !groupMayAttach()) { toast("В этой группе вам нельзя отправлять такие сообщения"); return; }

    listenJoin(currentChatId, true);

}

// voiceRoomId — музыка голосовой комнаты: своя сессия на комнату (ключ канала
// «vr-<чат>-<комната>»), подключаются к ней все, кто в комнате; панель при этом
// не всплывает сама (quiet) — её открывает кнопка 🎵 в панели комнаты.
function listenJoin(chatId, openAdd, { voiceRoomId = null, quiet = false } = {}) {

    const key = voiceRoomId ? `vr-${chatId}-${voiceRoomId}` : chatId;

    if (listenRoom && listenRoom.key === key) {
        if (!quiet) { listenRoom.panelOpen = true; listenRenderUi(); }
        if (openAdd && !listenCurrentTrack()) openListenAddModal();
        return;
    }
    if (listenRoom) listenLeave();

    const room = { key, chatId, voiceRoomId, panelOpen: !quiet, state: emptyListenState(), loadedTrackId: null, participants: [], handle: null };
    listenRoom = room;

    room.handle = listenHubAcquire(key, {
        onEvent: listenHandleEvent,
        onPresence: (ids) => { room.participants = ids; listenRenderUi(); }
    });

    // Войти в presence и спросить у уже слушающих текущее состояние.
    room.handle.run((api) => { api.join(); api.send({ type: "hello", from: myRealUserId }); });

    try { document.getElementById("listen-volume").value = localStorage.getItem("kaban-listen-volume") || "80"; } catch { /* по умолчанию */ }
    listenDuckTarget = listenDuckCurrent = 1;
    listenSetVolume(document.getElementById("listen-volume").value);

    document.getElementById("listen-panel").classList.remove("mini");
    updateListenBanner();
    listenRenderUi();

    clearInterval(listenTimer);
    listenTimer = setInterval(listenTick, 500);

    if (openAdd) setTimeout(() => { if (listenRoom === room && !room.state.queue.length) openListenAddModal(); }, 700);

}

function listenLeave() {

    const room = listenRoom;
    if (!room) return;

    clearInterval(listenTimer);
    listenTimer = null;
    listenAudio.pause();
    listenAudio.removeAttribute("src");
    listenYt?.stopVideo?.();
    document.getElementById("listen-yt-wrap").hidden = true;

    room.handle.run((api) => api.leave());
    room.handle.release();
    listenRoom = null;
    listenDuckTarget = listenDuckCurrent = 1;
    if (room.voiceRoomId && typeof voicePushMeta === "function") voicePushMeta();

    const panelEl = document.getElementById("listen-panel");
    panelEl.hidden = true;
    panelEl.classList.remove("room-mode", "offscreen");
    closeListenAddModal();
    // Если мы смотрим этот же чат — снова появится баннер для возвращения.
    if (currentChatId === room.chatId) listenWatchChat(room.chatId);

}

function listenToggleMini() {
    document.getElementById("listen-panel").classList.toggle("mini");
}

// Крестик в панели: в обычной сессии — выйти, в музыке комнаты — просто скрыть
// панель (музыка для комнаты продолжается; выключить её у себя — громкостью или выходом из комнаты).
function listenClosePanel() {
    if (listenRoom?.voiceRoomId) { listenRoom.panelOpen = false; listenRenderUi(); return; }
    listenLeave();
}

function listenOpenRoomPanel() {
    if (!listenRoom) return;
    listenRoom.panelOpen = true;
    document.getElementById("listen-panel").classList.remove("mini");
    listenRenderUi();
    if (!listenCurrentTrack()) openListenAddModal();
}

// Каждые полсекунды: ползунок, время и подгонка при дрейфе.
function listenTick() {

    if (!listenRoom) return;
    const track = listenCurrentTrack();
    if (!track) return;

    if (listenRoom.state.playing) {
        const target = listenTargetTime();
        // Подгоняем только когда трек реально играет: пока он грузится, «время плеера» —
        // ноль или чужое, и раньше это вызывало перемотку каждые полсекунды (трек заикался).
        if (listenRoom.loadedTrackId === track.id && listenEngineReady(track) && Math.abs(listenEngineTime() - target) > LISTEN_DRIFT_LIMIT) listenEngineSeek(target);
    }

    if (!listenSeeking) {
        const duration = listenEngineDuration();
        const time = duration ? listenEngineTime() : Math.max(0, listenTargetTime());
        // Только изменившееся (дважды в секунду, всё время, пока идёт музыка).
        const set = (id, prop, value) => { const el = document.getElementById(id); if (el && el[prop] !== value) el[prop] = value; };
        set("listen-cur", "textContent", formatListenTime(time));
        set("listen-dur", "textContent", duration ? formatListenTime(duration) : "–:––");
        set("listen-seek", "value", duration ? String(Math.round(Math.min(1, time / duration) * 1000)) : "0");
    }

}

function formatListenTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function listenRenderUi() {

    const room = listenRoom;
    const panel = document.getElementById("listen-panel");
    if (!panel) return;
    if (!room) { panel.hidden = true; return; }

    const track = listenCurrentTrack();
    const s = room.state;

    // Музыка голосовой комнаты: панель видна, только когда её открыли кнопкой 🎵.
    // Скрытая — уводится за экран, а не display:none: иначе встроенный YouTube
    // может перестать играть.
    panel.classList.toggle("room-mode", !!room.voiceRoomId);
    panel.hidden = false;
    panel.classList.toggle("offscreen", !!room.voiceRoomId && !room.panelOpen);
    document.querySelector(".listen-head-title").firstChild.textContent = room.voiceRoomId
        ? `Музыка в комнате${typeof voiceCall !== "undefined" && voiceCall?.roomName ? " «" + voiceCall.roomName + "»" : ""} `
        : "Слушаем вместе ";

    // Название трека — в мету участника голосовой комнаты (видно в списке комнат).
    if (room.voiceRoomId) {
        const musicTitle = s.playing && track ? track.title : null;
        if (room.pushedTitle !== musicTitle) { room.pushedTitle = musicTitle; if (typeof voicePushMeta === "function") voicePushMeta(); }
        if (typeof voiceRenderDock === "function") voiceRenderDock();
    }

    document.getElementById("listen-count").textContent = room.participants.length ? `· ${room.participants.length}` : "";
    document.getElementById("listen-track-title").textContent = track ? track.title : "Пока ничего не играет";
    const adder = track && track.by ? (track.by === myRealUserId ? "Добавили вы" : `Добавил(а) ${reactionUserName(track.by)}`) : "Добавьте трек — YouTube, файл или ссылка";
    document.getElementById("listen-track-sub").textContent = adder;
    panel.classList.toggle("playing", !!(track && s.playing));
    panel.classList.toggle("has-track", !!track);

    document.getElementById("listen-queue").innerHTML = s.queue.map((t, i) => `
        <div class="listen-queue-row${i === s.index ? " current" : ""}">
            <button type="button" class="listen-queue-main" onclick="listenPlayIndex(${i})"><span class="listen-queue-no">${i === s.index && s.playing ? "▶" : i + 1}</span><span class="listen-queue-title">${escapeHTML(t.title)}</span></button>
            <button type="button" class="listen-queue-remove" onclick="listenRemoveTrack(${i})" aria-label="Убрать из очереди">✕</button>
        </div>`).join("");

    document.getElementById("listen-prev").disabled = !track;
    document.getElementById("listen-next").disabled = !track || s.index + 1 >= s.queue.length;

}

/* ---- баннер «слушают вместе» ------------------------------------------------------------------------- */

function listenWatchChat(chatId) {

    listenUnwatch();
    if (!chatId || (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret)) { updateListenBanner(); return; }
    if (listenRoom && listenRoom.key === chatId) { updateListenBanner(); return; }

    const watcher = { chatId, ids: [] };
    watcher.handle = listenHubAcquire(chatId, { onPresence: (ids) => { watcher.ids = ids; updateListenBanner(); } });
    listenWatcher = watcher;

}

function listenUnwatch() {
    if (listenWatcher) { listenWatcher.handle.release(); listenWatcher = null; }
    updateListenBanner();
}

function updateListenBanner() {

    const banner = document.getElementById("listen-banner");
    if (!banner) return;

    const others = listenWatcher ? listenWatcher.ids.filter((id) => id !== myRealUserId) : [];
    const joinedHere = listenRoom && listenWatcher && listenRoom.key === listenWatcher.chatId;

    if (!listenWatcher || joinedHere || !others.length || currentChatId !== listenWatcher.chatId) { banner.hidden = true; return; }

    const names = others.slice(0, 3).map((id) => reactionUserName(id)).join(", ");
    document.getElementById("listen-banner-text").textContent = `Слушают вместе: ${names}${others.length > 3 ? ` и ещё ${others.length - 3}` : ""}`;
    banner.hidden = false;

}

function joinOngoingListen() {
    if (listenWatcher) listenJoin(listenWatcher.chatId, false);
}

// Полное завершение (выход из аккаунта).
function listenShutdown() {
    listenUnwatch();
    if (listenRoom) listenLeave();
}
