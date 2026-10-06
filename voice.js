/* ============================================================================
   ГОЛОСОВЫЕ КОМНАТЫ (по принципу Discord)
   ----------------------------------------------------------------------------
   Идея. В группе есть постоянные голосовые комнаты: в любую можно зайти и выйти
   в любой момент, без «звонка» и «ответа», видно, кто внутри (даже когда вы
   не в комнате), у каждого — кольцо «говорит», значки mute/deafen. Вы остаётесь
   в комнате, пока переходите между чатами: внизу слева «голосовая панель» с
   названием комнаты, качеством связи, кнопками микрофона, наушников и выхода.

   Устройство.
   • Список комнат — таблица voice_rooms (schema.sql, «ГОЛОСОВЫЕ КОМНАТЫ»); пока
     её нет, у каждой группы одна виртуальная «Общая комната».
   • Состав комнаты — realtime-presence канала vroom:<chat>:<room> (мета: имя,
     аватар, mute/deafen, момент входа). Тот же канал несёт адресные сигналы
     WebRTC (offer/answer/ice).
   • Звук — «сетка» (mesh) прямых соединений WebRTC между всеми в комнате (до 8
     человек, только голос). Инициатор пары — тот, кто вошёл позже. TURN из
     настроек подхватывается автоматически (RTC_CONFIG).
   • Микрофон идёт через WebAudio: усиление → шумовой порог → выключатель →
     исходящий трек. Поэтому mute, «рация» (push-to-talk), порог чувствительности
     и смена устройства работают без пересоздания соединений.
   • «Говорит» считается у каждого локально по анализатору звука — без лишних
     сообщений по сети.
   ========================================================================= */

const VOICE_MAX_PARTICIPANTS = 8;
const VOICE_SETTINGS_KEY = "kaban-voice-settings";
const VOICE_USER_PREFS_KEY = "kaban-voice-user-prefs";
const VOICE_SPEAK_THRESHOLD_DB = -52;

const voiceSettings = Object.assign({
    inputId: "", outputId: "",
    inputVolume: 100, outputVolume: 100,
    mode: "vad",                 // vad — по голосу, ptt — рация
    pttKey: "KeyV", pttLabel: "V",
    autoSensitivity: true, thresholdDb: -45,
    echo: true, noise: true, agc: true,
    sounds: true, sfx: true, musicDuck: true
},(() => { try { return JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) || "{}"); } catch { return {}; } })());

function saveVoiceSettings() {
    try { localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(voiceSettings)); } catch { /* не критично */ }
}

function voiceUserPrefs() {
    try { return JSON.parse(localStorage.getItem(VOICE_USER_PREFS_KEY) || "{}"); } catch { return {}; }
}

function voiceUserPref(userId) {
    return Object.assign({ vol: 100, muted: false }, voiceUserPrefs()[userId] || {});
}

function setVoiceUserPref(userId, patch) {
    const all = voiceUserPrefs();
    all[userId] = Object.assign(voiceUserPref(userId), patch);
    try { localStorage.setItem(VOICE_USER_PREFS_KEY, JSON.stringify(all)); } catch { /* не критично */ }
}

/* ---- аудиоконтекст и звуки ------------------------------------------------------------------ */

let voiceCtx = null;

function voiceEnsureCtx() {
    if (!voiceCtx) {
        voiceCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
        if (voiceCtx.setSinkId && voiceSettings.outputId) voiceCtx.setSinkId(voiceSettings.outputId).catch(() => {});
    }
    if (voiceCtx.state === "suspended") voiceCtx.resume().catch(() => {});
    return voiceCtx;
}

// Короткие «сигналы» как в Discord: вход, выход, mute, unmute — синтезируются, файлов нет.
function voiceSound(kind) {

    if (!voiceSettings.sounds) return;
    try {
        const ctx = voiceEnsureCtx();
        const notes = {
            join: [[523, 0], [784, 0.09]],
            leave: [[659, 0], [392, 0.09]],
            mute: [[330, 0]],
            unmute: [[494, 0]],
            deafen: [[294, 0], [220, 0.07]],
            undeafen: [[392, 0], [523, 0.07]]
        }[kind] || [];
        notes.forEach(([frequency, delay]) => {
            const t0 = ctx.currentTime + delay;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = frequency;
            gain.gain.setValueAtTime(0.0001, t0);
            gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t0);
            osc.stop(t0 + 0.18);
        });
    } catch { /* звук необязателен */ }

}

/* ---- общие каналы комнат (один на комнату для всех подписчиков) ------------------------------- */

const voiceHubs = new Map(); // "chat:room" → { api, members, sigListeners, presenceListeners, refs, pending }

function voiceHubAcquire(chatId, roomId, { onSig, onPresence } = {}) {

    const key = `${chatId}:${roomId}`;
    let hub = voiceHubs.get(key);

    if (!hub) {
        hub = { api: null, members: {}, sigListeners: new Set(), presenceListeners: new Set(), refs: 0, pending: [] };
        voiceHubs.set(key, hub);
        KabanAPI.openVoiceChannel(chatId, roomId, {
            onSig: (payload) => hub.sigListeners.forEach((fn) => fn(payload)),
            onPresence: (members) => { hub.members = members; hub.presenceListeners.forEach((fn) => fn(members)); }
        }).then((api) => {
            if (voiceHubs.get(key) !== hub) { api.close(); return; }
            hub.api = api;
            hub.pending.splice(0).forEach((fn) => fn(api));
        }).catch((error) => { console.warn("Не удалось открыть голосовую комнату", error); hub.failed = true; });
    }

    hub.refs++;
    if (onSig) hub.sigListeners.add(onSig);
    if (onPresence) { hub.presenceListeners.add(onPresence); if (Object.keys(hub.members).length) onPresence(hub.members); }

    return {
        hub,
        run: (fn) => (hub.api ? fn(hub.api) : hub.pending.push(fn)),
        release() {
            if (onSig) hub.sigListeners.delete(onSig);
            if (onPresence) hub.presenceListeners.delete(onPresence);
            hub.refs--;
            if (hub.refs <= 0) { hub.api?.close(); voiceHubs.delete(key); }
        }
    };

}

/* ---- наблюдение за комнатами открытой группы ------------------------------------------------------ */

let voiceWatch = null; // { chatId, rooms[], handles:Map(roomId→handle), presence:Map(roomId→members), unsubRooms, virtual }

function voiceDefaultRooms() { return [{ id: "main", name: "Общая комната", virtual: true }]; }

async function voiceLoadRooms(chatId) {
    try {
        const rows = await KabanAPI.getVoiceRooms(chatId);
        if (rows === null) return { rooms: voiceDefaultRooms(), tableMissing: true };
        return { rooms: rows.length ? rows : voiceDefaultRooms(), tableMissing: false, empty: !rows.length };
    } catch (error) {
        console.warn("Не удалось загрузить голосовые комнаты", error);
        return { rooms: voiceDefaultRooms(), tableMissing: true };
    }
}

function voiceSyncHubs(watch) {

    const wanted = new Set(watch.rooms.map((r) => r.id));

    watch.handles.forEach((handle, roomId) => {
        if (!wanted.has(roomId)) { handle.release(); watch.handles.delete(roomId); watch.presence.delete(roomId); }
    });

    watch.rooms.slice(0, VOICE_MAX_PARTICIPANTS).forEach((room) => {
        if (watch.handles.has(room.id)) return;
        watch.handles.set(room.id, voiceHubAcquire(watch.chatId, room.id, {
            onPresence: (members) => { watch.presence.set(room.id, voiceOnlyMembers(watch.chatId, members)); voiceRefreshUi(); }
        }));
    });

}

async function voiceWatchGroup(chatId) {

    voiceUnwatch();
    if (!chatId || currentChatType !== "group") { voiceRefreshUi(); return; }

    const watch = { chatId, rooms: voiceDefaultRooms(), handles: new Map(), presence: new Map(), unsubRooms: null, tableMissing: true, empty: true };
    voiceWatch = watch;

    const loaded = await voiceLoadRooms(chatId);
    if (voiceWatch !== watch) return;
    watch.rooms = loaded.rooms;
    watch.tableMissing = loaded.tableMissing;
    watch.empty = !!loaded.empty;
    voiceSyncHubs(watch);
    voiceRefreshUi();

    if (!watch.tableMissing) {
        watch.unsubRooms = KabanAPI.subscribeToVoiceRooms(chatId, async () => {
            const fresh = await voiceLoadRooms(chatId);
            if (voiceWatch !== watch) return;
            watch.rooms = fresh.rooms;
            watch.tableMissing = fresh.tableMissing;
            watch.empty = !!fresh.empty;
            voiceSyncHubs(watch);
            voiceRefreshUi();
        });
    }

}

function voiceUnwatch() {
    if (!voiceWatch) return;
    voiceWatch.unsubRooms?.();
    voiceWatch.handles.forEach((handle) => handle.release());
    voiceWatch = null;
    voiceRefreshUi();
}

/* ---- мета участника ---------------------------------------------------------------------------------- */

function voiceMeta() {
    const call = voiceCall;
    return {
        name: cachedMyProfile?.display_name || "Участник",
        avatar: cachedMyProfile?.avatar_url || null,
        muted: !!call?.muted,
        deafened: !!call?.deafened,
        joinedAt: call?.joinedAt || Date.now(),
        // Что играет в музыке комнаты — видно всем в списке комнат («🎵 …»).
        music: call && typeof listenRoomMusicTitle === "function" ? listenRoomMusicTitle(call.chatId, call.roomId) : null
    };
}

function voicePushMeta() {
    voiceCall?.handle?.run((api) => api.track(voiceMeta()));
}

function voiceMemberName(userId, meta) {
    if (userId === myRealUserId) return "Вы";
    return meta?.name || groupMembersCacheName(userId) || "Участник";
}

function groupMembersCacheName(userId) {
    const chatId = voiceCall?.chatId || voiceWatch?.chatId;
    const member = (groupMembersCache.get(chatId) || []).find((m) => m.user_id === userId);
    return member?.users?.display_name || null;
}

// Каналы Realtime открыты для любого залогиненного, кто знает id комнаты, — поэтому
// «присутствующих» не из состава группы отбрасываем (когда состав уже загружен).
function voiceOnlyMembers(chatId, members) {
    const cache = groupMembersCache.get(chatId);
    if (!cache || !cache.length) return members;
    const allowed = new Set(cache.map((m) => m.user_id));
    return Object.fromEntries(Object.entries(members || {}).filter(([id]) => id === myRealUserId || allowed.has(id)));
}

function voiceIsGroupAdmin(chatId, userId) {
    const member = (groupMembersCache.get(chatId) || []).find((m) => m.user_id === userId);
    return member?.role === "admin";
}

/* ============================================================================
   ПОДКЛЮЧЕНИЕ К КОМНАТЕ
   ========================================================================= */

let voiceCall = null;       // активное подключение
let voiceTickTimer = null;
let voicePingTimer = null;
let voicePttDown = false;

async function voiceStartLocalAudio(call) {

    const ctx = voiceEnsureCtx();
    const local = { ctx, micStream: null, src: null, buffer: new Float32Array(1024), gateOpenUntil: 0 };

    local.inputGain = ctx.createGain();
    local.inputGain.gain.value = voiceSettings.inputVolume / 100;
    local.analyser = ctx.createAnalyser();
    local.analyser.fftSize = 1024;
    local.gate = ctx.createGain();
    local.muteGain = ctx.createGain();
    local.dest = ctx.createMediaStreamDestination();
    local.inputGain.connect(local.analyser);
    local.inputGain.connect(local.gate).connect(local.muteGain).connect(local.dest);
    local.sendStream = local.dest.stream;
    local.sendTrack = local.dest.stream.getAudioTracks()[0];

    call.local = local;

    try {
        await voiceAttachMic(local);
    } catch (error) {
        call.noMic = true;
        throw error;
    }

}

async function voiceAttachMic(local) {

    const constraints = {
        audio: {
            deviceId: voiceSettings.inputId ? { exact: voiceSettings.inputId } : undefined,
            echoCancellation: voiceSettings.echo,
            noiseSuppression: voiceSettings.noise,
            autoGainControl: voiceSettings.agc,
            channelCount: 1
        }
    };

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
        // Сохранённое устройство пропало — пробуем устройство по умолчанию.
        if (voiceSettings.inputId && (error.name === "OverconstrainedError" || error.name === "NotFoundError")) {
            voiceSettings.inputId = "";
            saveVoiceSettings();
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: voiceSettings.echo, noiseSuppression: voiceSettings.noise, autoGainControl: voiceSettings.agc, channelCount: 1 } });
        } else {
            throw error;
        }
    }

    local.src?.disconnect();
    local.micStream?.getTracks().forEach((track) => track.stop());
    local.micStream = stream;
    local.src = local.ctx.createMediaStreamSource(stream);
    local.src.connect(local.inputGain);

}

function voiceApplyMicState() {

    const call = voiceCall;
    if (!call?.local) return;

    const transmitting = !call.muted && !call.deafened && (voiceSettings.mode === "vad" || voicePttDown);
    call.transmitting = transmitting;
    call.local.muteGain.gain.setTargetAtTime(transmitting ? 1 : 0, call.local.ctx.currentTime, 0.012);

}

async function voiceJoin(chatId, roomId, roomName, groupName) {

    if (voiceCall) {
        if (voiceCall.chatId === chatId && voiceCall.roomId === roomId) { openVoiceRooms(); return; }
        await voiceLeave(true);
    }

    const present = voiceWatch && voiceWatch.chatId === chatId ? Object.keys(voiceWatch.presence.get(roomId) || {}).filter((id) => id !== myRealUserId).length : 0;
    if (present >= VOICE_MAX_PARTICIPANTS) { toast(`В комнате уже ${VOICE_MAX_PARTICIPANTS} человек — это максимум`); return; }

    const call = {
        chatId, roomId, roomName, groupName,
        peers: new Map(), members: {}, speaking: new Set(),
        joinedAt: Date.now(), muted: false, deafened: false, noMic: false,
        local: null, handle: null, pingMs: null, master: null, transmitting: false
    };
    voiceCall = call;
    voiceRefreshUi();

    if (typeof ensureTurnServers === "function") await ensureTurnServers(); // ретранслятор для мобильных сетей

    try {
        await voiceStartLocalAudio(call);
    } catch (error) {
        const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
        toast(denied ? "Нет доступа к микрофону — вы подключены как слушатель" : "Микрофон не найден — вы подключены как слушатель");
        call.muted = true;
    }

    if (voiceCall !== call) return; // успели выйти, пока ждали разрешение

    call.master = call.local.ctx.createGain();
    call.master.gain.value = voiceSettings.outputVolume / 100;
    call.master.connect(call.local.ctx.destination);

    voiceApplyMicState();

    call.handle = voiceHubAcquire(chatId, roomId, { onSig: voiceHandleSig, onPresence: voiceOnRoomPresence });
    call.handle.run((api) => api.track(voiceMeta()));

    clearInterval(voiceTickTimer);
    clearInterval(voicePingTimer);
    voiceTickTimer = setInterval(voiceTick, 60);
    voicePingTimer = setInterval(voicePingTick, 3500);

    voiceSound("join");
    voiceRefreshUi();

    // Музыка комнаты: подключаемся сразу — если в комнате уже что-то играет, оно
    // зазвучит и у вошедшего (панель не всплывает, её открывает кнопка 🎵).
    if (typeof listenJoin === "function") listenJoin(chatId, false, { voiceRoomId: roomId, quiet: true });

}

async function voiceLeave(silent) {

    const call = voiceCall;
    if (!call) return;

    voiceToggleSfxPanel(false);
    clearInterval(voiceTickTimer);
    clearInterval(voicePingTimer);
    voiceTickTimer = voicePingTimer = null;

    call.peers.forEach((peer, userId) => voiceClosePeer(call, userId));
    call.local?.micStream?.getTracks().forEach((track) => track.stop());
    try { call.local?.src?.disconnect(); } catch { /* уже отключён */ }
    try { call.master?.disconnect(); } catch { /* уже отключён */ }

    call.handle?.run((api) => api.untrack());
    call.handle?.release();
    voiceCall = null;

    // Вышли из комнаты — выходим и из её музыки.
    if (typeof listenRoom !== "undefined" && listenRoom?.voiceRoomId === call.roomId && listenRoom?.chatId === call.chatId) listenLeave();

    if (!silent) voiceSound("leave");
    voiceRefreshUi();

}

/* ---- сигнализация и соединения ------------------------------------------------------------------------- */

function voiceOnRoomPresence(members) {

    const call = voiceCall;
    if (!call) return;
    members = voiceOnlyMembers(call.chatId, members);
    call.members = members;

    // Те, кто пропал, — закрываем соединение.
    call.peers.forEach((peer, userId) => { if (!members[userId]) voiceClosePeer(call, userId); });

    // Для вошедших раньше нас инициатор — мы (кто позже, тот и звонит).
    Object.entries(members).forEach(([userId, meta]) => {
        if (userId === myRealUserId || call.peers.has(userId)) return;
        if (Object.keys(members).length > VOICE_MAX_PARTICIPANTS) return;
        const mine = call.joinedAt, theirs = meta.joinedAt || 0;
        const initiator = mine > theirs || (mine === theirs && myRealUserId > userId);
        if (initiator) voiceConnectTo(call, userId, meta);
    });

    // Звук входа/выхода других участников.
    const count = Object.keys(members).length;
    if (call.lastCount != null && count > call.lastCount) voiceSound("join");
    else if (call.lastCount != null && count < call.lastCount) voiceSound("leave");
    call.lastCount = count;

    voiceRefreshUi();

}

function voiceCreatePeer(call, userId, epoch) {

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const peer = { pc, userId, epoch, pendingIce: [], remoteSet: false, state: "connecting", nodes: null, restarting: false, initiator: false };
    call.peers.set(userId, peer);

    pc.onicecandidate = (event) => {
        if (event.candidate) voiceSend(call, { type: "ice", to: userId, data: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate });
    };

    pc.ontrack = (event) => voiceAttachRemote(call, peer, event.streams[0] || new MediaStream([event.track]));

    pc.onconnectionstatechange = () => {
        peer.state = pc.connectionState;
        if (pc.connectionState === "failed") voiceRestartPeer(call, peer);
        if (pc.connectionState === "disconnected") {
            clearTimeout(peer.disconnectTimer);
            peer.disconnectTimer = setTimeout(() => { if (pc.connectionState === "disconnected") voiceRestartPeer(call, peer); }, 5000);
        }
        voiceRefreshUi();
    };

    return peer;

}

function voiceSend(call, payload) {
    call.handle?.run((api) => api.send({ ...payload, from: myRealUserId, epoch: call.joinedAt }));
}

/* ---- саундборд: короткие звуки, которые слышит вся комната (синтез, без файлов) -------------------- */

// t — старт (с), d — длительность, f0→f1 — тон, n — шум вместо тона, v — громкость
const VOICE_SFX = [
    { id: "gg",    icon: "🏆", label: "GG",      steps: [{ t: 0, d: .16, f0: 523, ty: "triangle" }, { t: .14, d: .16, f0: 659, ty: "triangle" }, { t: .28, d: .38, f0: 784, ty: "triangle" }] },
    { id: "ura",   icon: "🎉", label: "Ура",     steps: [392, 523, 659, 784, 1047].map((f, i) => ({ t: i * .075, d: i === 4 ? .45 : .12, f0: f, ty: "sawtooth", v: .09 })) },
    { id: "fail",  icon: "😢", label: "Провал",  steps: [{ t: 0, d: .3, f0: 330, f1: 311, ty: "sawtooth", v: .1 }, { t: .3, d: .3, f0: 311, f1: 294, ty: "sawtooth", v: .1 }, { t: .6, d: .3, f0: 294, f1: 277, ty: "sawtooth", v: .1 }, { t: .9, d: .7, f0: 262, f1: 196, ty: "sawtooth", v: .1 }] },
    { id: "horn",  icon: "📣", label: "Сирена",  steps: [0, .32, .64].flatMap((t) => [{ t, d: .24, f0: 466, ty: "sawtooth", v: .08 }, { t, d: .24, f0: 587, ty: "sawtooth", v: .08 }, { t, d: .24, f0: 698, ty: "sawtooth", v: .06 }]) },
    { id: "drum",  icon: "🥁", label: "Бадум-тс", steps: [{ t: 0, d: .16, f0: 150, f1: 60, ty: "sine", v: .35 }, { t: .16, d: .16, f0: 150, f1: 60, ty: "sine", v: .35 }, { t: .42, d: .25, n: 1, v: .2 }] },
    { id: "clap",  icon: "👏", label: "Хлопки", steps: Array.from({ length: 9 }, (_, i) => ({ t: i * .07 + (i % 2) * .02, d: .05, n: 1, v: .16 })) },
    { id: "laser", icon: "🔫", label: "Лазер",   steps: [{ t: 0, d: .28, f0: 1900, f1: 160, ty: "square", v: .07 }, { t: .3, d: .28, f0: 1900, f1: 160, ty: "square", v: .07 }] },
    { id: "bruh",  icon: "💀", label: "Бру…",    steps: [{ t: 0, d: .5, f0: 190, f1: 90, ty: "square", v: .09 }, { t: 0, d: .5, f0: 193, f1: 87, ty: "sawtooth", v: .06 }] },
    // мемные мелодии: «Коробейники» (народная), заставка Nokia (Gran Vals, Таррега), «ой-ой» как в аське
    { id: "tetris", icon: "🧱", label: "Тетрис",  steps: voiceSfxMelody([[659, .4], [494, .2], [523, .2], [587, .4], [523, .2], [494, .2], [440, .4], [440, .2], [523, .2], [659, .4], [587, .2], [523, .2], [494, .5], [523, .2], [587, .4], [659, .4], [523, .4], [440, .4], [440, .5]], "square", .05) },
    { id: "nokia",  icon: "📱", label: "Nokia",   steps: voiceSfxMelody([[1319, .11], [1175, .11], [740, .22], [831, .22], [1109, .11], [988, .11], [587, .22], [659, .22], [988, .11], [880, .11], [554, .22], [659, .22], [880, .6]], "square", .05) },
    { id: "error",  icon: "❌", label: "Ошибка",  steps: [{ t: 0, d: .14, f0: 880, ty: "square", v: .06 }, { t: .17, d: .14, f0: 660, ty: "square", v: .06 }, { t: .34, d: .45, f0: 440, ty: "square", v: .06 }] },
    { id: "uhoh",   icon: "😬", label: "Ой-ой",   steps: [{ t: 0, d: .2, f0: 800, f1: 700, ty: "triangle", v: .18 }, { t: .24, d: .38, f0: 540, f1: 430, ty: "triangle", v: .18 }] }
];

function voiceSfxMelody(notes, type, vol) {
    let t = 0;
    return notes.map(([f0, d]) => { const step = { t, d: d * 0.95, f0, ty: type, v: vol }; t += d; return step; });
}

const VOICE_SFX_COOLDOWN_MS = 1400;
let voiceSfxLastSent = 0;
let voiceSfxLastHeard = new Map(); // userId → время последнего звука (защита от спама)

function voiceSfxPlay(call, id) {

    const def = VOICE_SFX.find((s) => s.id === id);
    const ctx = call?.local?.ctx;
    if (!def || !ctx || !call.master) return;

    try {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const bus = ctx.createGain();
        bus.gain.value = 0.9;
        bus.connect(call.master);
        const t0 = ctx.currentTime + 0.01;
        let noiseBuf = null;

        def.steps.forEach((s) => {
            const gain = ctx.createGain();
            const vol = s.v || 0.16;
            gain.gain.setValueAtTime(0.0001, t0 + s.t);
            gain.gain.exponentialRampToValueAtTime(vol, t0 + s.t + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + s.t + s.d);
            if (s.n) {
                if (!noiseBuf) {
                    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
                    const data = noiseBuf.getChannelData(0);
                    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
                }
                const src = ctx.createBufferSource();
                src.buffer = noiseBuf;
                const filter = ctx.createBiquadFilter();
                filter.type = "bandpass";
                filter.frequency.value = 2200;
                src.connect(filter).connect(gain).connect(bus);
                src.start(t0 + s.t);
                src.stop(t0 + s.t + s.d + 0.02);
            } else {
                const osc = ctx.createOscillator();
                osc.type = s.ty || "sine";
                osc.frequency.setValueAtTime(s.f0, t0 + s.t);
                if (s.f1) osc.frequency.exponentialRampToValueAtTime(s.f1, t0 + s.t + s.d);
                osc.connect(gain).connect(bus);
                osc.start(t0 + s.t);
                osc.stop(t0 + s.t + s.d + 0.02);
            }
        });
    } catch { /* звук необязателен */ }

}

function voiceSfxIncoming(call, payload) {

    if (call.deafened || !voiceSettings.sfx) return;
    const now = Date.now();
    if (now - (voiceSfxLastHeard.get(payload.from) || 0) < VOICE_SFX_COOLDOWN_MS * 0.7) return;
    if (!call.members[payload.from]) return;   // только участники этой комнаты
    voiceSfxLastHeard.set(payload.from, now);

    const who = call.members[payload.from].name || "Участник";
    const builtin = VOICE_SFX.find((s) => s.id === payload.id);
    if (builtin) {
        voiceSfxPlay(call, payload.id);
        voiceSfxFlash(`${who}: ${builtin.label}`);
        return;
    }

    // Свой звук другого участника: данные приходят вместе с первым запуском, дальше — из кэша.
    const key = `${payload.from}:${payload.id}`;
    if (typeof payload.data === "string" && payload.data.length < 200000) {
        try { voiceSfxRemote.set(key, voiceSfxFromBase64(payload.data)); } catch { return; }
    }
    const buffer = voiceSfxRemote.get(key);
    if (!buffer) return;
    voiceSfxPlayBuffer(call, buffer);
    voiceSfxFlash(`${who}: ${String(payload.name || "звук").slice(0, 24)}`);

}

/* ---- свои звуки (мемы): хранятся локально, при запуске уходят остальным в комнате ---------------- */

const VOICE_SFX_MAX_BYTES = 120 * 1024;
const VOICE_SFX_MAX_SECONDS = 8;
const VOICE_SFX_MAX_CUSTOM = 8;
const voiceSfxRemote = new Map();    // "userId:soundId" → ArrayBuffer
let voiceCustomSfx = [];             // { id, name, data: ArrayBuffer }
let voiceCustomSfxLoaded = false;

function voiceSfxDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open("kaban-voice-sfx", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("s", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function voiceSfxLoadCustom() {
    if (voiceCustomSfxLoaded) return;
    voiceCustomSfxLoaded = true;
    try {
        const db = await voiceSfxDb();
        voiceCustomSfx = await new Promise((resolve) => {
            const req = db.transaction("s").objectStore("s").getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
        voiceCustomSfx.sort((a, b) => a.id.localeCompare(b.id));
        voiceSfxRenderPanel();
    } catch { /* без IndexedDB свои звуки недоступны */ }
}

async function voiceSfxSaveCustom(item) {
    const db = await voiceSfxDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction("s", "readwrite");
        tx.objectStore("s").put(item);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

function voiceSfxToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function voiceSfxFromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

async function voiceSfxPlayBuffer(call, buffer) {
    const ctx = call?.local?.ctx;
    if (!ctx || !call.master) return;
    try {
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const decoded = await ctx.decodeAudioData(buffer.slice(0));
        if (decoded.duration > VOICE_SFX_MAX_SECONDS + 0.5) return;
        const src = ctx.createBufferSource();
        src.buffer = decoded;
        const bus = ctx.createGain();
        bus.gain.value = 0.9;
        src.connect(bus).connect(call.master);
        src.start();
    } catch { /* повреждённый файл — пропускаем */ }
}

function voiceSfxPickFile() {
    if (voiceCustomSfx.length >= VOICE_SFX_MAX_CUSTOM) { toast(`Можно добавить до ${VOICE_SFX_MAX_CUSTOM} своих звуков`); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/*";
    input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        if (file.size > VOICE_SFX_MAX_BYTES) { toast("Файл слишком большой: до 120 КБ (≈ 8 секунд mp3)"); return; }
        try {
            const data = await file.arrayBuffer();
            const decoded = await voiceEnsureCtx().decodeAudioData(data.slice(0));
            if (decoded.duration > VOICE_SFX_MAX_SECONDS) { toast(`Звук длиннее ${VOICE_SFX_MAX_SECONDS} секунд`); return; }
            const name = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 14) || "Звук";
            const item = { id: "c" + Date.now().toString(36), name, data };
            await voiceSfxSaveCustom(item);
            voiceCustomSfx.push(item);
            voiceSfxRenderPanel();
            toast(`Звук «${name}» добавлен`);
        } catch {
            toast("Не удалось прочитать аудиофайл");
        }
    };
    input.click();
}

async function voiceSfxRemoveCustom(id) {
    voiceCustomSfx = voiceCustomSfx.filter((s) => s.id !== id);
    try {
        const db = await voiceSfxDb();
        db.transaction("s", "readwrite").objectStore("s").delete(id);
    } catch { /* не критично */ }
    voiceSfxRenderPanel();
}

let voiceSfxFlashTimer = null;
function voiceSfxFlash(text) {
    const sub = document.getElementById("voice-dock-sub");
    if (!sub) return;
    sub.textContent = text;
    sub.classList.add("sfx");
    clearTimeout(voiceSfxFlashTimer);
    voiceSfxFlashTimer = setTimeout(() => { sub.classList.remove("sfx"); voiceRenderDock(); }, 1800);
}

function voiceSfxSend(id) {

    const call = voiceCall;
    if (!call) return;
    const now = Date.now();
    if (now - voiceSfxLastSent < VOICE_SFX_COOLDOWN_MS) return;
    const custom = voiceCustomSfx.find((s) => s.id === id);
    if (custom) {
        voiceSfxLastSent = now;
        voiceSfxPlayBuffer(call, custom.data);
        // Данные отправляем, когда состав комнаты изменился с прошлой отправки этого звука.
        const roster = Object.keys(call.members).sort().join(",");
        call.sfxShared = call.sfxShared || {};
        const payload = { type: "sfx", to: "*", id, name: custom.name };
        if (call.sfxShared[id] !== roster) { payload.data = voiceSfxToBase64(custom.data); call.sfxShared[id] = roster; }
        voiceSend(call, payload);
    } else {
        voiceSfxLastSent = now;
        voiceSfxPlay(call, id);
        voiceSend(call, { type: "sfx", to: "*", id });
    }
    document.getElementById("voice-sfx-pop")?.classList.add("cooling");
    setTimeout(() => document.getElementById("voice-sfx-pop")?.classList.remove("cooling"), VOICE_SFX_COOLDOWN_MS);

}

// Кнопка 🎵: открыть плеер музыки комнаты (подключение к сессии уже есть с момента входа).
function voiceOpenMusic() {
    const call = voiceCall;
    if (!call || typeof listenJoin !== "function") return;
    voiceToggleSfxPanel(false);
    if (!listenRoom || listenRoom.voiceRoomId !== call.roomId) listenJoin(call.chatId, false, { voiceRoomId: call.roomId, quiet: true });
    listenOpenRoomPanel();
}

function voiceToggleSfxPanel(force) {

    const pop = document.getElementById("voice-sfx-pop");
    if (!pop) return;
    const open = typeof force === "boolean" ? force : pop.hidden;
    pop.hidden = !open;
    if (open) { voiceSfxRenderPanel(); voiceSfxLoadCustom(); }
    document.getElementById("voice-sfx-btn")?.classList.toggle("active", open);

}

function voiceSfxRenderPanel() {

    const pop = document.getElementById("voice-sfx-pop");
    if (!pop || pop.hidden) return;
    const cooling = pop.classList.contains("cooling");
    const item = (s) => `<button type="button" class="voice-sfx-item" onclick="voiceSfxSend('${s.id}')"><span>${s.icon}</span><em>${escapeHTML(s.label)}</em></button>`;
    pop.innerHTML =
        VOICE_SFX.map(item).join("") +
        `<div class="voice-sfx-sep">Свои</div>` +
        voiceCustomSfx.map((s) => `<div class="voice-sfx-item custom" role="button" tabindex="0" onclick="voiceSfxSend('${s.id}')"><span>🔊</span><em>${escapeHTML(s.name)}</em><button type="button" class="voice-sfx-del" title="Удалить звук" onclick="event.stopPropagation();voiceSfxRemoveCustom('${s.id}')">×</button></div>`).join("") +
        `<button type="button" class="voice-sfx-item add" onclick="voiceSfxPickFile()" title="Добавить свой звук (mp3/ogg до 120 КБ, до 8 с)"><span>＋</span><em>Свой звук</em></button>` +
        `<label class="voice-sfx-mute"><input type="checkbox" ${voiceSettings.sfx ? "checked" : ""} onchange="voiceSetSetting('sfx', this.checked)"> Слышать звуки других</label>`;
    pop.classList.toggle("cooling", cooling);

}

document.addEventListener("pointerdown", (event) => {
    const pop = document.getElementById("voice-sfx-pop");
    if (pop && !pop.hidden && !event.target.closest("#voice-sfx-pop, #voice-sfx-btn")) voiceToggleSfxPanel(false);
});

function voiceTuneSdp(sdp) {
    // Моно-голос, умеренный битрейт, FEC — разборчиво и экономно для сетки.
    return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*useinbandfec=1[^\r\n]*)/g, (line, pt, params) =>
        /maxaveragebitrate/.test(params) ? line : `a=fmtp:${pt} ${params};stereo=0;maxaveragebitrate=48000`);
}

async function voiceConnectTo(call, userId, meta) {

    const peer = voiceCreatePeer(call, userId, meta.joinedAt || 0);
    peer.initiator = true;

    try {
        peer.pc.addTrack(call.local.sendTrack, call.local.sendStream);
        const offer = await peer.pc.createOffer();
        offer.sdp = voiceTuneSdp(offer.sdp);
        await peer.pc.setLocalDescription(offer);
        voiceSend(call, { type: "offer", to: userId, sdp: offer.sdp });
    } catch (error) {
        console.warn("Не удалось начать соединение", error);
        voiceClosePeer(call, userId);
    }

}

async function voiceRestartPeer(call, peer) {

    if (!peer.initiator || peer.restarting || voiceCall !== call) return;
    peer.restarting = true;
    try {
        const offer = await peer.pc.createOffer({ iceRestart: true });
        offer.sdp = voiceTuneSdp(offer.sdp);
        await peer.pc.setLocalDescription(offer);
        voiceSend(call, { type: "offer", to: peer.userId, sdp: offer.sdp });
    } catch (error) {
        console.warn("Не удалось восстановить соединение", error);
    } finally {
        setTimeout(() => { peer.restarting = false; }, 4000);
    }

}

async function voiceFlushIce(peer) {
    peer.remoteSet = true;
    for (const candidate of peer.pendingIce.splice(0)) {
        try { await peer.pc.addIceCandidate(candidate); } catch { /* устаревший кандидат */ }
    }
}

async function voiceHandleSig(payload) {

    const call = voiceCall;
    if (call && payload?.type === "sfx" && payload.from !== myRealUserId) { voiceSfxIncoming(call, payload); return; }
    if (!call || !payload || payload.to !== myRealUserId) return;

    const from = payload.from;

    if (payload.type === "kick") {
        if (!voiceIsGroupAdmin(call.chatId, from)) return;
        await voiceLeave(true);
        toast("Администратор отключил вас от голосовой комнаты");
        return;
    }

    let peer = call.peers.get(from);

    if (payload.type === "offer") {
        if (!voiceOnlyMembers(call.chatId, { [from]: 1 })[from]) return;   // не участник группы
        // Новый вход того же человека (другая эпоха) — старое соединение заменяем.
        if (peer && payload.epoch !== peer.epoch && !peer.initiator) { voiceClosePeer(call, from); peer = null; }
        if (!peer) peer = voiceCreatePeer(call, from, payload.epoch);
        try {
            await peer.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
            // Отвечающий отдаёт свой голос по уже созданному приёмнику (иначе слышно только в одну сторону).
            const transceiver = peer.pc.getTransceivers().find((t) => t.receiver?.track?.kind === "audio");
            if (transceiver) {
                transceiver.direction = "sendrecv";
                await transceiver.sender.replaceTrack(call.local.sendTrack);
            }
            const answer = await peer.pc.createAnswer();
            answer.sdp = voiceTuneSdp(answer.sdp);
            await peer.pc.setLocalDescription(answer);
            voiceSend(call, { type: "answer", to: from, sdp: answer.sdp });
            await voiceFlushIce(peer);
        } catch (error) {
            console.warn("Не удалось ответить на предложение", error);
            voiceClosePeer(call, from);
        }
        return;
    }

    if (!peer) return;

    if (payload.type === "answer") {
        try {
            await peer.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
            await voiceFlushIce(peer);
        } catch (error) { console.warn("Не удалось применить ответ", error); }
        return;
    }

    if (payload.type === "ice") {
        if (peer.remoteSet) { try { await peer.pc.addIceCandidate(payload.data); } catch { /* ок */ } }
        else peer.pendingIce.push(payload.data);
    }

}

function voiceClosePeer(call, userId) {

    const peer = call.peers.get(userId);
    if (!peer) return;
    call.peers.delete(userId);
    clearTimeout(peer.disconnectTimer);
    peer.pc.onconnectionstatechange = null;
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    try { peer.pc.close(); } catch { /* уже закрыт */ }

    if (peer.nodes) {
        try { peer.nodes.src.disconnect(); peer.nodes.gain.disconnect(); } catch { /* ок */ }
        peer.nodes.audio.srcObject = null;
        peer.nodes.audio.remove();
    }
    call.speaking.delete(userId);

}

/* ---- входящий звук ------------------------------------------------------------------------------------------ */

function voiceAttachRemote(call, peer, stream) {

    if (peer.nodes) return;
    const ctx = call.local.ctx;

    // Chrome не «прокачивает» удалённый поток, пока он не подключён к медиа-элементу —
    // подключаем к скрытому заглушённому, а звучит поток через WebAudio (там громкость до 200%).
    const audio = document.createElement("audio");
    audio.muted = true;
    audio.autoplay = true;
    audio.srcObject = stream;
    document.getElementById("voice-audio-sink")?.appendChild(audio);
    audio.play?.().catch(() => {});

    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    src.connect(analyser);
    src.connect(gain).connect(call.master);

    peer.nodes = { audio, src, analyser, gain, buffer: new Float32Array(512), speakingUntil: 0 };
    voiceApplyPeerVolume(peer);

}

function voiceApplyPeerVolume(peer) {
    if (!peer.nodes) return;
    const pref = voiceUserPref(peer.userId);
    peer.nodes.gain.gain.value = pref.muted ? 0 : Math.max(0, pref.vol) / 100;
}

/* ---- «говорит», шумовой порог, качество связи --------------------------------------------------------------- */

function voiceLevelDb(analyser, buffer) {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function voiceTick() {

    const call = voiceCall;
    if (!call?.local) return;

    const now = performance.now();
    const speaking = new Set();

    // Свой микрофон: шумовой порог (если включён ручной) и признак «говорю».
    const level = voiceLevelDb(call.local.analyser, call.local.buffer);
    call.localLevel = level;
    const threshold = voiceSettings.autoSensitivity ? VOICE_SPEAK_THRESHOLD_DB : voiceSettings.thresholdDb;
    if (!voiceSettings.autoSensitivity) {
        if (level > threshold) call.local.gateOpenUntil = now + 280;
        call.local.gate.gain.setTargetAtTime(now < call.local.gateOpenUntil ? 1 : 0, call.local.ctx.currentTime, now < call.local.gateOpenUntil ? 0.008 : 0.06);
    } else {
        call.local.gate.gain.setTargetAtTime(1, call.local.ctx.currentTime, 0.02);
    }
    if (call.transmitting && level > threshold) call.local.speakingUntil = now + 320;
    if (call.transmitting && now < (call.local.speakingUntil || 0)) speaking.add(myRealUserId);

    // Остальные — по анализатору входящего потока.
    call.peers.forEach((peer, userId) => {
        if (!peer.nodes) return;
        const peerLevel = voiceLevelDb(peer.nodes.analyser, peer.nodes.buffer);
        if (peerLevel > VOICE_SPEAK_THRESHOLD_DB && peer.nodes.gain.gain.value > 0 && !call.deafened) peer.nodes.speakingUntil = now + 300;
        if (now < peer.nodes.speakingUntil) speaking.add(userId);
    });

    // Перерисовывать только если набор изменился.
    const changed = speaking.size !== call.speaking.size || [...speaking].some((id) => !call.speaking.has(id));
    call.speaking = speaking;
    if (changed) {
        voiceApplySpeakingClasses();
        // Кто-то (кроме меня) говорит — музыка комнаты плавно тише, замолчали — громче.
        if (typeof listenDuck === "function" && voiceSettings.musicDuck !== false && listenRoom?.voiceRoomId === call.roomId) {
            listenDuck([...speaking].some((id) => id !== myRealUserId));
        }
    }

    voiceUpdateMeters(level);

}

async function voicePingTick() {

    const call = voiceCall;
    if (!call) return;

    const samples = [];
    for (const peer of call.peers.values()) {
        if (peer.pc.connectionState !== "connected") continue;
        try {
            const stats = await peer.pc.getStats();
            stats.forEach((report) => {
                if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated && typeof report.currentRoundTripTime === "number") {
                    samples.push(report.currentRoundTripTime * 1000);
                }
            });
        } catch { /* соединение закрывается */ }
    }

    call.pingMs = samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null;
    voiceRenderDock();

}

/* ---- управление: микрофон, наушники, устройства, рация -------------------------------------------------------- */

function voiceToggleMute() {

    const call = voiceCall;
    if (!call || call.noMic && call.muted) { if (call?.noMic) toast("Микрофон недоступен — разрешите доступ в браузере и зайдите снова"); return; }

    // Включить микрофон при выключенных наушниках — значит включить и их (как в Discord).
    if (call.deafened) { call.deafened = false; voiceApplyDeafen(); }
    call.muted = !call.muted;
    voiceApplyMicState();
    voicePushMeta();
    voiceSound(call.muted ? "mute" : "unmute");
    voiceRefreshUi();

}

function voiceApplyDeafen() {
    const call = voiceCall;
    if (!call?.master) return;
    call.master.gain.setTargetAtTime(call.deafened ? 0 : voiceSettings.outputVolume / 100, call.local.ctx.currentTime, 0.02);
}

function voiceToggleDeafen() {

    const call = voiceCall;
    if (!call) return;

    call.deafened = !call.deafened;
    if (call.deafened) { call.wasMutedBeforeDeafen = call.muted; call.muted = true; }
    else call.muted = !!call.wasMutedBeforeDeafen || !!call.noMic;

    voiceApplyDeafen();
    voiceApplyMicState();
    voicePushMeta();
    voiceSound(call.deafened ? "deafen" : "undeafen");
    voiceRefreshUi();

}

async function voiceChangeInputDevice(deviceId) {
    voiceSettings.inputId = deviceId;
    saveVoiceSettings();
    if (voiceCall?.local) {
        try { await voiceAttachMic(voiceCall.local); voiceCall.noMic = false; } catch { toast("Не удалось переключить микрофон"); }
    }
}

function voiceChangeOutputDevice(deviceId) {
    voiceSettings.outputId = deviceId;
    saveVoiceSettings();
    if (voiceCtx?.setSinkId) voiceCtx.setSinkId(deviceId || "").catch(() => toast("Не удалось переключить устройство вывода"));
    else toast("Этот браузер не умеет выбирать устройство вывода — звук идёт на устройство по умолчанию");
}

function voiceSetInputVolume(value) {
    voiceSettings.inputVolume = Number(value);
    saveVoiceSettings();
    if (voiceCall?.local) voiceCall.local.inputGain.gain.value = voiceSettings.inputVolume / 100;
}

function voiceSetOutputVolume(value) {
    voiceSettings.outputVolume = Number(value);
    saveVoiceSettings();
    if (voiceCall && !voiceCall.deafened) voiceApplyDeafen();
}

function voiceSetMode(mode) {
    voiceSettings.mode = mode;
    saveVoiceSettings();
    voiceApplyMicState();
    voiceRenderSettings();
}

// Рация: клавиша работает, пока фокус не в поле ввода.
document.addEventListener("keydown", (event) => {
    if (voiceCapturingPtt) {
        event.preventDefault();
        voiceSettings.pttKey = event.code;
        voiceSettings.pttLabel = event.key.length === 1 ? event.key.toUpperCase() : event.code.replace(/^Key/, "").replace(/^Digit/, "");
        voiceCapturingPtt = false;
        saveVoiceSettings();
        voiceRenderSettings();
        return;
    }
    if (voiceSettings.mode !== "ptt" || !voiceCall || event.code !== voiceSettings.pttKey || event.repeat) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    voicePttDown = true;
    voiceApplyMicState();
});

document.addEventListener("keyup", (event) => {
    if (event.code !== voiceSettings.pttKey || !voicePttDown) return;
    voicePttDown = false;
    voiceApplyMicState();
});

window.addEventListener("blur", () => { if (voicePttDown) { voicePttDown = false; voiceApplyMicState(); } });
window.addEventListener("pagehide", () => { if (voiceCall) voiceLeave(true); });

let voiceCapturingPtt = false;

function voiceCapturePttKey() {
    voiceCapturingPtt = true;
    voiceRenderSettings();
}

function voiceKickUser(userId) {
    const call = voiceCall;
    if (!call || !voiceIsGroupAdmin(call.chatId, myRealUserId)) return;
    voiceSend(call, { type: "kick", to: userId });
    toast("Участник отключён от комнаты");
}

/* ============================================================================
   ИНТЕРФЕЙС
   ========================================================================= */

function voiceSvg(name) {
    const icons = {
        speaker: '<path d="M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
        mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/>',
        micOff: '<path d="M4 4l16 16M9 9v2a3 3 0 0 0 5 2.2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.2 5.6M19 11a7 7 0 0 1-.6 2.8M12 18v3m-4 0h8"/>',
        headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
        headphonesOff: '<path d="M4 4l16 16M4 15v-3a8 8 0 0 1 12.5-6.6M20 15v-3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
        gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
        phoneDown: '<path d="M3 14.5c5-4.5 13-4.5 18 0l-2 2.5-3.5-1.5v-2.5a9 9 0 0 0-7 0V15.5L5 17z"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
        user: '<circle cx="12" cy="8.5" r="3.4"/><path d="M5 19.5c0-3.4 3.1-5.8 7-5.8s7 2.4 7 5.8"/>'
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ""}</svg>`;
}

function voiceAvatarHTML(userId, meta, small) {
    const name = voiceMemberName(userId, meta);
    const url = meta?.avatar;
    const style = url ? ` style="background-image:${escapeHTML(cssUrlValue(url))}"` : "";
    return `<span class="voice-avatar${small ? " small" : ""}" data-voice-user="${escapeHTML(userId)}"${style}>${url ? "" : escapeHTML((name === "Вы" ? (cachedMyProfile?.display_name || "Я") : name).trim().charAt(0).toUpperCase())}</span>`;
}

function voiceRefreshUi() {
    voiceRenderDock();
    voiceRenderRooms();
    voiceRenderBanner();
    voiceRenderHeaderButton();
}

function voiceApplySpeakingClasses() {
    const speaking = voiceCall?.speaking || new Set();
    document.querySelectorAll("[data-voice-user]").forEach((el) => {
        el.classList.toggle("speaking", speaking.has(el.dataset.voiceUser));
    });
}

/* ---- голосовая панель (внизу слева) ----------------------------------------------------------------------------- */

function voiceQualityLevel(call) {
    if (call.pingMs == null) return 0;
    if (call.pingMs < 90) return 4;
    if (call.pingMs < 170) return 3;
    if (call.pingMs < 300) return 2;
    return 1;
}

function voiceRenderDock() {

    const dock = document.getElementById("voice-dock");
    if (!dock) return;
    const call = voiceCall;
    dock.hidden = !call;
    if (!call) return;

    const connected = [...call.peers.values()].filter((p) => p.state === "connected").length;
    const others = Object.keys(call.members).filter((id) => id !== myRealUserId).length;
    const status = others === 0 ? "Вы одни в комнате" : (connected < others ? "Соединяемся…" : "Голосовая связь");

    document.getElementById("voice-dock-title").textContent = status;
    document.getElementById("voice-dock-sub").textContent = `${call.roomName} · ${call.groupName}`;

    const quality = voiceQualityLevel(call);
    const q = document.getElementById("voice-quality");
    q.dataset.level = String(quality);
    q.title = call.pingMs != null ? `Задержка ${call.pingMs} мс` : "Связь устанавливается";

    document.getElementById("voice-dock-avatar").innerHTML = voiceAvatarHTML(myRealUserId, voiceMeta(), true);

    const mic = document.getElementById("voice-mic-btn");
    mic.classList.toggle("off", call.muted);
    mic.innerHTML = voiceSvg(call.muted ? "micOff" : "mic");
    mic.title = call.muted ? "Включить микрофон" : "Выключить микрофон";
    mic.setAttribute("aria-pressed", String(call.muted));

    const ear = document.getElementById("voice-deafen-btn");
    ear.classList.toggle("off", call.deafened);
    ear.innerHTML = voiceSvg(call.deafened ? "headphonesOff" : "headphones");
    ear.title = call.deafened ? "Включить звук" : "Выключить звук (и микрофон)";
    ear.setAttribute("aria-pressed", String(call.deafened));

    // 🎵 подсвечена, пока в комнате играет музыка.
    const musicBtn = document.getElementById("voice-music-btn");
    if (musicBtn) musicBtn.classList.toggle("active", !!(typeof listenRoomMusicTitle === "function" && listenRoomMusicTitle(call.chatId, call.roomId)));

    document.getElementById("voice-ptt-hint").hidden = voiceSettings.mode !== "ptt";
    document.getElementById("voice-ptt-hint").textContent = `Рация: удерживайте ${voiceSettings.pttLabel}`;

    voiceApplySpeakingClasses();

}

/* ---- окно «Голосовые комнаты» ---------------------------------------------------------------------------------------- */

let voiceOpenStrip = null;   // userId, у кого раскрыта полоска громкости

function openVoiceRooms() {
    if (currentChatType !== "group" && !voiceCall) { toast("Голосовые комнаты есть в группах"); return; }
    if (currentChatType === "group" && (!voiceWatch || voiceWatch.chatId !== currentChatId)) voiceWatchGroup(currentChatId);
    const backdrop = document.getElementById("voice-rooms-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    voiceRenderRooms();
}

function closeVoiceRooms() {
    const backdrop = document.getElementById("voice-rooms-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function voiceCanManageRooms() {
    return typeof groupHasRight === "function" && groupHasRight("change_info");
}

function voicePersonRow(userId, meta, roomId) {

    const mine = userId === myRealUserId;
    const call = voiceCall;
    const inThisCall = call && call.roomId === roomId && call.chatId === voiceWatch?.chatId;
    const peer = inThisCall ? call.peers.get(userId) : null;
    const connecting = inThisCall && !mine && (!peer || peer.state !== "connected");
    const pref = voiceUserPref(userId);
    const status = [
        meta.deafened ? `<span class="vp-flag" title="Звук выключен">${voiceSvg("headphonesOff")}</span>` : (meta.muted ? `<span class="vp-flag" title="Микрофон выключен">${voiceSvg("micOff")}</span>` : ""),
        pref.muted && !mine ? `<span class="vp-flag muted-by-me" title="Вы его не слышите">${voiceSvg("speaker")}</span>` : ""
    ].join("");

    const strip = voiceOpenStrip === userId && !mine && inThisCall ? `
        <div class="vp-strip" onclick="event.stopPropagation()">
            <label class="vp-vol"><span>Громкость</span><input type="range" min="0" max="200" value="${pref.vol}" oninput="voiceSetUserVolume('${escapeHTML(userId)}', this.value)"><b>${pref.vol}%</b></label>
            <button type="button" class="vp-btn" onclick="voiceToggleUserMute('${escapeHTML(userId)}')">${pref.muted ? "Включить для меня" : "Заглушить для меня"}</button>
            ${voiceIsGroupAdmin(call.chatId, myRealUserId) ? `<button type="button" class="vp-btn danger" onclick="voiceKickUser('${escapeHTML(userId)}')">Отключить от комнаты</button>` : ""}
        </div>` : "";

    return `
        <div class="vroom-person${inThisCall && !mine ? " clickable" : ""}${connecting ? " connecting" : ""}" ${inThisCall && !mine ? `onclick="voiceToggleStrip('${escapeHTML(userId)}')"` : ""}>
            ${voiceAvatarHTML(userId, meta, true)}
            <span class="vp-name">${escapeHTML(voiceMemberName(userId, meta))}</span>
            ${connecting ? '<span class="vp-connecting">соединение…</span>' : ""}
            <span class="vp-flags">${status}</span>
        </div>${strip}`;

}

function voiceRenderRooms() {

    const backdrop = document.getElementById("voice-rooms-backdrop");
    if (!backdrop || !backdrop.classList.contains("open")) return;

    const list = document.getElementById("voice-rooms-list");
    const watch = voiceWatch;

    if (!watch) { list.innerHTML = '<div class="group-perms-hint">Откройте группу, чтобы увидеть её голосовые комнаты.</div>'; return; }

    document.getElementById("voice-rooms-title").textContent = `Голосовые комнаты · ${currentChatTitle || ""}`;

    const manage = voiceCanManageRooms();

    list.innerHTML = watch.rooms.map((room) => {
        const members = watch.presence.get(room.id) || {};
        const ids = Object.keys(members);
        const joinedHere = voiceCall && voiceCall.chatId === watch.chatId && voiceCall.roomId === room.id;
        const people = ids
            .sort((a, b) => (members[a].joinedAt || 0) - (members[b].joinedAt || 0))
            .map((id) => voicePersonRow(id, members[id], room.id)).join("");
        const full = ids.length >= VOICE_MAX_PARTICIPANTS && !joinedHere;
        const musicTitle = ids.map((id) => members[id]?.music).find(Boolean) || null;

        return `
        <div class="vroom-card${joinedHere ? " active" : ""}${ids.length ? " has-people" : ""}" data-room-id="${escapeHTML(room.id)}">
            <div class="vroom-head">
                <span class="vroom-icon">${voiceSvg("speaker")}</span>
                <div class="vroom-title">${escapeHTML(room.name)}<small>${ids.length}/${VOICE_MAX_PARTICIPANTS}${musicTitle ? ` · <span class="vroom-music">🎵 ${escapeHTML(musicTitle)}</span>` : ""}</small></div>
                ${joinedHere
                    ? `<button type="button" class="vroom-join leave" onclick="voiceLeave()">Выйти</button>`
                    : `<button type="button" class="vroom-join" ${full ? "disabled" : ""} onclick="voiceJoinRoom('${escapeHTML(room.id)}')">${full ? "Заполнена" : "Войти"}</button>`}
                ${manage && !room.virtual ? `<button type="button" class="vroom-more" onclick="voiceRoomMenu('${escapeHTML(room.id)}')" aria-label="Управление комнатой">${voiceSvg("more")}</button>` : ""}
            </div>
            ${ids.length ? `<div class="vroom-people">${people}</div>` : '<div class="vroom-empty">Пока никого — зайдите первым</div>'}
        </div>`;
    }).join("");

    document.getElementById("voice-rooms-manage").hidden = !manage;
    voiceApplySpeakingClasses();

}

function voiceJoinRoom(roomId) {
    const watch = voiceWatch;
    const room = watch?.rooms.find((r) => r.id === roomId);
    if (!watch || !room) return;
    voiceJoin(watch.chatId, room.id, room.name, currentChatTitle || "Группа");
}

function voiceToggleStrip(userId) {
    voiceOpenStrip = voiceOpenStrip === userId ? null : userId;
    voiceRenderRooms();
}

function voiceSetUserVolume(userId, value) {
    setVoiceUserPref(userId, { vol: Number(value) });
    const peer = voiceCall?.peers.get(userId);
    if (peer) voiceApplyPeerVolume(peer);
    const label = document.querySelector(".vp-vol b");
    if (label) label.textContent = value + "%";
}

function voiceToggleUserMute(userId) {
    setVoiceUserPref(userId, { muted: !voiceUserPref(userId).muted });
    const peer = voiceCall?.peers.get(userId);
    if (peer) voiceApplyPeerVolume(peer);
    voiceRenderRooms();
}

async function voiceCreateRoomFromInput() {

    const input = document.getElementById("voice-new-room-input");
    const name = input.value.trim();
    if (!name) { toast("Назовите комнату"); return; }
    const watch = voiceWatch;
    if (!watch) return;
    if (watch.tableMissing) { toast("Чтобы создавать комнаты, нужно выполнить SQL-блок «ГОЛОСОВЫЕ КОМНАТЫ» из schema.sql"); return; }

    try {
        // Первая настоящая комната заменяет виртуальную — создаём и «Общую», чтобы привычное не исчезло.
        const names = watch.empty ? ["Общая комната", name] : [name];
        await KabanAPI.createVoiceRooms(watch.chatId, names);
        input.value = "";
        const fresh = await voiceLoadRooms(watch.chatId);
        if (voiceWatch === watch) { watch.rooms = fresh.rooms; watch.empty = !!fresh.empty; voiceSyncHubs(watch); voiceRefreshUi(); }
    } catch (error) {
        toast("Не удалось создать комнату: " + (error?.message || error));
    }

}

async function voiceRoomMenu(roomId) {

    const watch = voiceWatch;
    const room = watch?.rooms.find((r) => r.id === roomId);
    if (!room) return;

    const action = prompt(`Комната «${room.name}»\n\nВведите новое название, чтобы переименовать, или напишите «удалить», чтобы удалить комнату:`, room.name);
    if (action === null) return;
    const value = action.trim();
    if (!value || value === room.name) return;

    try {
        if (value.toLowerCase() === "удалить") {
            if (voiceCall && voiceCall.roomId === roomId) await voiceLeave(true);
            await KabanAPI.deleteVoiceRoom(roomId);
        } else {
            await KabanAPI.renameVoiceRoom(roomId, value.slice(0, 32));
        }
        const fresh = await voiceLoadRooms(watch.chatId);
        if (voiceWatch === watch) { watch.rooms = fresh.rooms; watch.empty = !!fresh.empty; voiceSyncHubs(watch); voiceRefreshUi(); }
    } catch (error) {
        toast("Не удалось изменить комнату: " + (error?.message || error));
    }

}

/* ---- баннер в чате и кнопка в шапке ---------------------------------------------------------------------------------- */

function voiceRenderBanner() {

    const banner = document.getElementById("voice-banner");
    if (!banner) return;

    const watch = voiceWatch;
    const inThisGroup = voiceCall && watch && voiceCall.chatId === watch.chatId;
    if (!watch || inThisGroup || currentChatId !== watch.chatId) { banner.hidden = true; return; }

    // Самая людная комната с кем-то внутри.
    let best = null;
    watch.rooms.forEach((room) => {
        const ids = Object.keys(watch.presence.get(room.id) || {});
        if (ids.length && (!best || ids.length > best.ids.length)) best = { room, ids };
    });
    if (!best) { banner.hidden = true; return; }

    const members = watch.presence.get(best.room.id);
    const names = best.ids.slice(0, 3).map((id) => voiceMemberName(id, members[id])).join(", ");
    document.getElementById("voice-banner-text").textContent = `В комнате «${best.room.name}»: ${names}${best.ids.length > 3 ? ` и ещё ${best.ids.length - 3}` : ""}`;
    banner.dataset.roomId = best.room.id;
    banner.hidden = false;

}

function voiceJoinFromBanner() {
    const roomId = document.getElementById("voice-banner").dataset.roomId;
    if (roomId) voiceJoinRoom(roomId);
}

function voiceRenderHeaderButton() {

    const button = document.getElementById("header-voice-button");
    if (!button) return;

    const isGroup = currentChatType === "group" && !!currentChatId && !currentChatIsSecret;
    button.hidden = !isGroup && !voiceCall;

    let total = 0;
    voiceWatch?.presence.forEach((members) => { total += Object.keys(members).length; });
    const badge = button.querySelector(".voice-badge");
    if (badge) { badge.hidden = !total; badge.textContent = String(total); }
    button.classList.toggle("in-call", !!voiceCall);

}

/* ---- настройки голоса ---------------------------------------------------------------------------------------------------- */

let voiceMicTest = null;

async function openVoiceSettings() {

    const backdrop = document.getElementById("voice-settings-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    await voiceFillDevices();
    voiceRenderSettings();

    // Индикатор уровня: в комнате — тот же микрофон, иначе временный тест.
    if (!voiceCall) {
        try {
            const ctx = voiceEnsureCtx();
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: voiceSettings.inputId ? { exact: voiceSettings.inputId } : undefined, echoCancellation: voiceSettings.echo, noiseSuppression: voiceSettings.noise, autoGainControl: voiceSettings.agc } });
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            const src = ctx.createMediaStreamSource(stream);
            src.connect(analyser);
            voiceMicTest = { stream, src, analyser, buffer: new Float32Array(1024), timer: setInterval(() => voiceUpdateMeters(voiceLevelDb(analyser, voiceMicTest.buffer)), 80) };
        } catch { /* без микрофона индикатор просто пустой */ }
    }

}

function closeVoiceSettings() {
    const backdrop = document.getElementById("voice-settings-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    if (voiceMicTest) {
        clearInterval(voiceMicTest.timer);
        voiceMicTest.stream.getTracks().forEach((t) => t.stop());
        try { voiceMicTest.src.disconnect(); } catch { /* ок */ }
        voiceMicTest = null;
    }
    voiceCapturingPtt = false;
}

async function voiceFillDevices() {

    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* нет доступа */ }

    const options = (kind, selected) => {
        const list = devices.filter((d) => d.kind === kind);
        return `<option value="">По умолчанию</option>` + list.map((d, i) =>
            `<option value="${escapeHTML(d.deviceId)}"${d.deviceId === selected ? " selected" : ""}>${escapeHTML(d.label || (kind === "audioinput" ? `Микрофон ${i + 1}` : `Динамики ${i + 1}`))}</option>`).join("");
    };

    document.getElementById("voice-input-select").innerHTML = options("audioinput", voiceSettings.inputId);
    document.getElementById("voice-output-select").innerHTML = options("audiooutput", voiceSettings.outputId);

}

function voiceRenderSettings() {

    document.querySelectorAll("[data-voice-mode]").forEach((btn) => btn.classList.toggle("active", btn.dataset.voiceMode === voiceSettings.mode));
    document.getElementById("voice-ptt-row").hidden = voiceSettings.mode !== "ptt";
    document.getElementById("voice-ptt-key").textContent = voiceCapturingPtt ? "Нажмите клавишу…" : voiceSettings.pttLabel;
    document.getElementById("voice-sens-row").hidden = voiceSettings.mode === "ptt";
    document.getElementById("voice-auto-input").checked = voiceSettings.autoSensitivity;
    document.getElementById("voice-threshold-wrap").hidden = voiceSettings.autoSensitivity;
    document.getElementById("voice-threshold-input").value = String(voiceSettings.thresholdDb);
    document.getElementById("voice-in-vol").value = String(voiceSettings.inputVolume);
    document.getElementById("voice-out-vol").value = String(voiceSettings.outputVolume);
    document.getElementById("voice-echo-input").checked = voiceSettings.echo;
    document.getElementById("voice-noise-input").checked = voiceSettings.noise;
    document.getElementById("voice-agc-input").checked = voiceSettings.agc;
    document.getElementById("voice-sounds-input").checked = voiceSettings.sounds;
    const duckInput = document.getElementById("voice-duck-input");
    if (duckInput) duckInput.checked = voiceSettings.musicDuck !== false;
    document.getElementById("voice-threshold-marker").style.left = Math.max(0, Math.min(100, ((voiceSettings.thresholdDb + 100) / 80) * 100)) + "%";

}

function voiceSetSetting(key, value) {
    voiceSettings[key] = value;
    saveVoiceSettings();
    if (key === "echo" || key === "noise" || key === "agc") {
        // Эти параметры применяются при открытии микрофона — переоткрываем в комнате.
        if (voiceCall?.local) voiceAttachMic(voiceCall.local).catch(() => toast("Не удалось применить настройку микрофона"));
    }
    voiceRenderSettings();
}

function voiceUpdateMeters(levelDb) {
    const fill = document.getElementById("voice-meter-fill");
    if (!fill || !document.getElementById("voice-settings-backdrop").classList.contains("open")) return;
    fill.style.width = Math.max(0, Math.min(100, ((levelDb + 100) / 80) * 100)) + "%";
}

/* ---- жизненный цикл --------------------------------------------------------------------------------------------------------- */

function voiceShutdown() {
    voiceUnwatch();
    if (voiceCall) voiceLeave(true);
    closeVoiceRooms();
}
