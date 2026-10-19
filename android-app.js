/* ============================================================================
   KABAN ДЛЯ ANDROID — связь веб-приложения с Android-приложением (Capacitor).
   В приложении есть window.Capacitor (isNativePlatform() === true) и плагин
   KabanNative (android-app/android/.../KabanNativePlugin.java); в браузере и в
   программе для ПК этого файла как будто нет.

   Что делает:
     • «видно / свёрнуто» по настоящему состоянию приложения (WebView этого не знает);
     • уведомления о сообщениях — системные Android (в WebView нет Notification);
     • фоновая служба «KABAN на связи»: звонки и сообщения приходят, когда приложение
       свёрнуто или экран выключен; и пинок соединения раз в 25 с (kabanKeepAlive);
     • входящий звонок — экран поверх блокировки с мелодией; идущий звонок — микрофон
       при выключенном экране, кнопка «Динамик» (трубка / громкая связь);
     • кнопка «Назад» Android: закрыть окно → выйти из чата → свернуть приложение;
     • «скачать» — в папку «Загрузки/KABAN»;
     • цвет системных панелей под тему; подсказки про разрешения;
     • обновление интерфейса без переустановки приложения (по app-manifest.json).
   ========================================================================= */

(function () {
    "use strict";

    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return;
    const P = cap.Plugins || {};
    const Native = P.KabanNative;
    const App = P.App;
    const Notes = P.LocalNotifications;
    const Files = P.Filesystem;
    if (!Native) return;

    window.kabanAndroid = true;
    document.documentElement.classList.add("is-android");
    const log = (...a) => console.log("[android]", ...a);

    /* ---------- видно / свёрнуто ----------
       WebView сам не всегда сообщает, что приложение свёрнуто: без этого новые сообщения
       в открытом чате сразу считались прочитанными, «в сети» не гасло, а уведомления не
       показывались (они только для невидимого окна). */
    let appActive = true;
    try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => !appActive });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (appActive ? "visible" : "hidden") });
        const nativeHasFocus = document.hasFocus.bind(document);
        document.hasFocus = () => appActive && nativeHasFocus();
    } catch { /* старый WebView — как есть */ }

    function setActive(active) {
        if (appActive === active) return;
        appActive = active;
        document.dispatchEvent(new Event("visibilitychange"));
        if (active) onBecameVisible(); else onBecameHidden();
    }
    App?.addListener("appStateChange", ({ isActive }) => setActive(!!isActive));
    App?.addListener("pause", () => setActive(false));
    App?.addListener("resume", () => setActive(true));

    /* ---------- уведомления: Notification → системные уведомления Android ---------- */

    let notePermission = "default";
    const noteHandlers = new Map();   // id → объект уведомления (для onclick)

    function noteId(tag) {
        let h = 0;
        for (const ch of String(tag || Math.random())) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return Math.abs(h) % 2000000000 + 100;
    }

    async function refreshNotePermission() {
        try {
            const { display } = await Notes.checkPermissions();
            notePermission = display === "granted" ? "granted" : display === "denied" ? "denied" : "default";
        } catch { /* плагина нет */ }
        return notePermission;
    }

    if (Notes) {
        refreshNotePermission();
        Notes.createChannel?.({ id: "kaban_messages", name: "Сообщения", description: "Новые сообщения в чатах", importance: 4, visibility: 0, vibration: true, lights: true }).catch(() => {});
        Notes.addListener("localNotificationActionPerformed", ({ notification }) => {
            const n = noteHandlers.get(notification?.id);
            try { n?.onclick?.({ target: n }); } catch { /* ок */ }
        });

        class AndroidNotification {
            constructor(title, options = {}) {
                this.title = title;
                this.body = options.body || "";
                this.tag = options.tag || "";
                this.onclick = null;
                this.id = noteId(this.tag || title + Date.now());
                // О звонке сообщает свой экран входящего звонка (KabanService), второе не нужно.
                if (this.tag === "kaban-call") return;
                noteHandlers.set(this.id, this);
                if (noteHandlers.size > 200) noteHandlers.delete(noteHandlers.keys().next().value);
                Notes.schedule({ notifications: [{
                    id: this.id, title: String(title || "KABAN"), body: String(this.body),
                    channelId: "kaban_messages", smallIcon: "ic_stat_kaban", iconColor: "#2A9EF1",
                    group: "kaban-messages", autoCancel: true
                }] }).catch((e) => log("notify", e));
            }
            close() { Notes.cancel({ notifications: [{ id: this.id }] }).catch(() => {}); noteHandlers.delete(this.id); }
            addEventListener(type, fn) { if (type === "click") this.onclick = fn; }
            static get permission() { return notePermission; }
            static async requestPermission() {
                try { const { display } = await Notes.requestPermissions(); notePermission = display === "granted" ? "granted" : "denied"; }
                catch { notePermission = "denied"; }
                return notePermission;
            }
        }
        window.Notification = AndroidNotification;
    }

    /* ---------- фоновая служба и «пинок» соединения ---------- */

    // Из фоновой службы раз в ~25 с: таймеры свёрнутой страницы WebView притормаживает
    // до раза в минуту, и проверка связи с сервером опаздывала — сервер рвал соединение,
    // а вместе с ним пропадали входящие звонки. Отсюда соединение проверяется вовремя.
    window.kabanKeepAlive = function () {
        try {
            if (typeof myRealUserId === "undefined" || !myRealUserId) return;
            const rt = getSupabaseClient().realtime;
            if (!rt) return;
            if (!rt.isConnected()) { rt.connect(); return; }
            const s = rt.socketAdapter || rt;
            const sentAt = s.heartbeatSentAt || 0;
            // Ответа на heartbeat нет уже 15 с — повторный вызов разорвёт мёртвое соединение
            // и откроет новое; давно не слали (таймер притормозили) — шлём сами.
            if ((s.pendingHeartbeatRef && Date.now() - sentAt > 15000) || (!s.pendingHeartbeatRef && Date.now() - sentAt > 24000)) rt.sendHeartbeat();
        } catch (error) { log("keepalive", error); }
    };

    let keepAliveOn = false;
    function syncKeepAlive() {
        const want = typeof myRealUserId !== "undefined" && !!myRealUserId;
        if (want === keepAliveOn) return;
        keepAliveOn = want;
        (want ? Native.startKeepAlive() : Native.stopKeepAlive()).catch((e) => log("service", e));
        if (want) setTimeout(checkPhoneSettings, 4000);
    }
    const wrap = (name, after, before) => {
        const original = window[name];
        if (typeof original !== "function") return;
        window[name] = function () {
            if (before && before.apply(this, arguments) === false) return;
            const result = original.apply(this, arguments);
            if (after) Promise.resolve(result).then(() => after.apply(this, arguments), () => after.apply(this, arguments));
            return result;
        };
    };
    wrap("applyRealSessionState", syncKeepAlive);
    wrap("handleSignOut", syncKeepAlive);
    setInterval(syncKeepAlive, 5000);

    // Push браузера в приложении не нужен (приложение держит соединение само).
    window.setupPushSubscription = async function () {};

    /* ---------- звонки ---------- */

    let nativeRinging = false;

    function ringNative(offer) {
        nativeRinging = true;
        Native.showIncomingCall({ name: offer?.callerName || "KABAN", video: !!offer?.isVideo }).catch(() => {});
    }
    function stopNativeRing() {
        if (!nativeRinging) return;
        nativeRinging = false;
        Native.hideIncomingCall().catch(() => {});
    }

    // Входящий, пока приложение свёрнуто или экран выключен — системный экран звонка с
    // мелодией (своя мелодия страницы в фоне не играла бы или играла бы вперемешку).
    wrap("showIncomingCallUI", null, function (offer) {
        if (!appActive) { ringNative(offer); }
        return true;
    });
    wrap("startCallTone", null, function (kind) {
        if (kind === "ringtone" && (!appActive || nativeRinging)) return false;
        return true;
    });
    ["hideCallUI", "dismissIncomingCall", "declineIncomingCall", "acceptIncomingCall", "teardownActiveCall"].forEach((name) => wrap(name, syncCallState, () => { stopNativeRing(); return true; }));
    ["startCall", "voiceJoin", "voiceLeave", "joinGroupCall", "leaveGroupCall", "endCall"].forEach((name) => wrap(name, syncCallState));

    async function handleCallAction(action) {
        log("call action", action);
        if (action === "accept") {
            stopNativeRing();
            // Запуск с экрана блокировки — вызов мог ещё восстанавливаться (restoreIncomingCall).
            for (let i = 0; i < 40 && typeof pendingIncomingCall !== "undefined" && !pendingIncomingCall; i++) await new Promise((r) => setTimeout(r, 250));
            if (typeof pendingIncomingCall !== "undefined" && pendingIncomingCall) acceptIncomingCall();
        } else if (action === "decline") {
            stopNativeRing();
            if (typeof pendingIncomingCall !== "undefined" && pendingIncomingCall) declineIncomingCall();
        } else if (action === "hangup") {
            if (typeof activeCall !== "undefined" && (activeCall || acceptingCall)) endCall();
            else if (typeof voiceCall !== "undefined" && voiceCall) voiceLeave();
            else if (typeof activeGroupCall !== "undefined" && activeGroupCall) leaveGroupCall();
        }
    }
    Native.addListener("callAction", ({ action }) => handleCallAction(action));
    Native.takePendingCallAction().then(({ action }) => { if (action) handleCallAction(action); }).catch(() => {});

    // Режим «идёт звонок»: микрофон при выключенном экране, звук в трубку/динамик/гарнитуру.
    let callStateKey = JSON.stringify({ active: false });   // при запуске звонка нет — службу не трогаем
    function syncCallState() {
        const call = typeof activeCall !== "undefined" ? activeCall : null;
        const room = typeof voiceCall !== "undefined" ? voiceCall : null;
        const group = typeof activeGroupCall !== "undefined" ? activeGroupCall : null;
        const accepting = typeof acceptingCall !== "undefined" ? acceptingCall : null;
        const starting = typeof startingCall !== "undefined" && startingCall;
        const active = !!(call || room || group || accepting || starting);
        const state = active ? {
            active: true,
            name: call?.remoteName || accepting?.offer?.callerName || room?.roomName || group?.title || "",
            video: !!(call?.isVideo || call?.local?.video || accepting?.offer?.isVideo || group?.videoTrack),
            room: !!(room || group) && !call
        } : { active: false };
        const key = JSON.stringify(state);
        if (key === callStateKey) return;
        callStateKey = key;
        Native.setCallState(state).catch((e) => log("call state", e));
        if (active) setTimeout(syncSpeakerButton, 400);
    }
    setInterval(syncCallState, 1500);

    // Кнопка «Динамик» в окне звонка (трубка ↔ громкая связь).
    (function addSpeakerButton() {
        const controls = document.getElementById("call-controls-incall");
        if (!controls || controls.querySelector("[data-android-speaker]")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "call-control";
        button.dataset.androidSpeaker = "1";
        button.setAttribute("aria-pressed", "false");
        button.innerHTML = `<span class="call-control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg></span><span class="call-control-label">Динамик</span>`;
        button.addEventListener("click", async () => {
            const on = button.getAttribute("aria-pressed") !== "true";
            try { const { route } = await Native.setSpeaker({ on }); paintSpeaker(route); } catch { /* ок */ }
        });
        const mic = controls.querySelector('[data-call-action="mute"]');
        controls.insertBefore(button, mic || controls.lastElementChild);
    })();
    function paintSpeaker(route) {
        const button = document.querySelector("[data-android-speaker]");
        if (!button) return;
        button.setAttribute("aria-pressed", String(route === "speaker"));
        const label = button.querySelector(".call-control-label");
        if (label) label.textContent = route === "bluetooth" ? "Bluetooth" : route === "headset" ? "Гарнитура" : "Динамик";
    }
    function syncSpeakerButton() { Native.getAudioRoute().then(({ route }) => paintSpeaker(route)).catch(() => {}); }

    /* ---------- видно / свёрнуто: что делать ---------- */

    function onBecameVisible() {
        // Открыли приложение, пока звонит системный экран, — дальше звонит само приложение.
        if (nativeRinging && typeof pendingIncomingCall !== "undefined" && pendingIncomingCall) {
            stopNativeRing();
            try { startCallTone("ringtone"); } catch { /* ок */ }
        }
        try { if (typeof KabanConn !== "undefined") KabanConn.suspect(); } catch { /* ок */ }
        window.kabanKeepAlive();
        maybeShowUpdateBanner();
    }

    function onBecameHidden() {
        // Звонит внутри приложения, а его свернули — переводим звонок на системный экран.
        if (typeof pendingIncomingCall !== "undefined" && pendingIncomingCall && !nativeRinging) {
            try { stopCallTone(); } catch { /* ок */ }
            ringNative(pendingIncomingCall);
        }
        scheduleQuietUpdate();
    }

    /* ---------- кнопка «Назад» ---------- */

    function uiSignature() {
        const call = document.getElementById("call-backdrop");
        return [
            document.querySelectorAll(".open").length,
            document.body.className,
            document.getElementById("message-context-menu")?.hidden,
            call?.classList.contains("open"),
            document.querySelectorAll("[role=dialog]:not([hidden])").length
        ].join("|");
    }

    App?.addListener("backButton", () => {
        // Окно звонка: Escape там означает «завершить», а «Назад» на телефоне — свернуть.
        if (document.getElementById("call-backdrop")?.classList.contains("open")) {
            if (typeof activeCall !== "undefined" && activeCall) minimizeCall();
            else Native.moveToBack().catch(() => {});
            return;
        }
        const before = uiSignature();
        // Escape уже умеет всё: закрыть верхнее окно, свернуть звонок, выйти из чата.
        const esc = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
        document.dispatchEvent(esc);
        setTimeout(() => {
            // Закрыл главный обработчик (script-ui.js) или окно само перехватило Esc — не сворачиваем.
            if (esc.kabanConsumed || esc.defaultPrevented) return;
            if (uiSignature() !== before) return;
            Native.moveToBack().catch(() => App.minimizeApp?.());
        }, 60);
    });

    /* ---------- «скачать» → «Загрузки/KABAN» ---------- */

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    async function saveDownload(href, name) {
        try {
            const blob = await (await fetch(href)).blob();
            const mime = blob.type || "application/octet-stream";
            const { uri } = await Native.saveFile({ name: name || "kaban-file", mime, data: await blobToBase64(blob) });
            if (typeof toast === "function") toast(`Сохранено в «Загрузки/KABAN»: ${name}`);
            return { uri, mime };
        } catch (error) {
            if (typeof toast === "function") toast("Не удалось сохранить файл: " + (error?.message || error));
            return null;
        }
    }

    const nativeAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute("download") && this.href) { saveDownload(this.href, this.getAttribute("download") || this.download); return; }
        return nativeAnchorClick.apply(this, arguments);
    };
    document.addEventListener("click", (event) => {
        const a = event.target.closest?.("a[download]");
        if (!a || !a.href || event.defaultPrevented) return;
        event.preventDefault();
        saveDownload(a.href, a.getAttribute("download") || a.href.split("/").pop().split("?")[0]);
    }, true);

    /* ---------- системные панели под тему ---------- */

    // Цвет фона страницы, под который красятся строка состояния и полоска жестов.
    let barsBase = [16, 16, 16];
    let barsPainted = "";
    function syncSystemBars() {
        const bg = getComputedStyle(document.body).backgroundColor || "rgb(16,16,16)";
        barsBase = (bg.match(/\d+/g) || [16, 16, 16]).slice(0, 3).map(Number);
        barsPainted = "";
        paintSystemBars();
    }
    // Открыто окно с затемнением — системные полосы темнеют вместе с ним (как у диалогов
    // Android); идёт звонок — в цвет экрана звонка. Иначе яркая строка состояния над
    // затемнённым экраном выдавала, что окно «нарисовано» внутри страницы.
    function paintSystemBars() {
        let rgb = barsBase;
        const call = document.getElementById("call-backdrop");
        if (call?.classList.contains("open")) {
            const g = getComputedStyle(call.querySelector(".call-dialog") || call).backgroundImage.match(/rgba?\(([^)]+)\)/);
            rgb = g ? g[1].split(",").slice(0, 3).map((n) => Number(n)) : [24, 24, 40];
        } else if (typeof anyOverlayOpen === "function" && anyOverlayOpen()) {
            rgb = barsBase.map((c) => Math.round(c * 0.6));   // ~ затемнение подложек окон
        }
        const hex = "#" + rgb.map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0")).join("");
        if (hex === barsPainted) return;
        barsPainted = hex;
        const light = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) > 140;
        Native.setSystemBars({ color: hex, darkIcons: light }).catch(() => {});
    }
    let overlayTimer = 0;
    const OVERLAY_SEL = '[id$="-backdrop"], [id$="-popover"], [class*="backdrop"], #message-context-menu';
    new MutationObserver((records) => {
        // Только смены самих слоёв окон: проверка видимости окон заставляет браузер разложить
        // страницу, а классы в ленте/списке меняются постоянно (прокрутка, анимации).
        if (overlayTimer) return;
        const relevant = records.some((r) => (r.type === "attributes" && r.target.matches?.(OVERLAY_SEL))
            || [...r.addedNodes, ...r.removedNodes].some((n) => n.nodeType === 1 && n.matches?.(OVERLAY_SEL)));
        if (!relevant) return;
        overlayTimer = setTimeout(() => { overlayTimer = 0; paintSystemBars(); setTimeout(paintSystemBars, 320); }, 90);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"] });
    // Только при смене темы: getComputedStyle на каждую смену класса body (открыть чат,
    // звонок…) заставлял браузер пересчитывать стили посреди анимации.
    let barsDark = null;
    new MutationObserver(() => {
        const dark = document.body.classList.contains("dark");
        if (dark === barsDark) return;
        barsDark = dark;
        requestAnimationFrame(syncSystemBars);
    }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    setTimeout(syncSystemBars, 300);
    // Поворот экрана / смена темы системы: SystemBars из Capacitor заново ставит подложку
    // из темы приложения (тёмную) — возвращаем цвет под текущую тему KABAN.
    let barsTimer = 0;
    window.addEventListener("resize", () => { clearTimeout(barsTimer); barsTimer = setTimeout(syncSystemBars, 400); });

    /* ---------- разрешения: чтобы звонки правда доходили ---------- */

    const SETTINGS_SEEN_KEY = "kaban-android-setup-v1";
    const SAMSUNG_SLEEP_KEY = "kaban-samsung-sleep-done";

    async function checkPhoneSettings(force) {
        let status;
        try { status = await Native.getStatus(); } catch { return; }
        if (notePermission !== "granted") await window.Notification.requestPermission?.();
        const problems = [];
        if (!status.batteryUnrestricted) problems.push({ id: "battery", title: "Работа в фоне", text: "Разрешите KABAN работать без ограничений батареи — иначе телефон усыпит приложение и звонки перестанут доходить.", action: () => Native.requestBatteryUnrestricted() });
        if (!status.fullScreenCalls) problems.push({ id: "fullscreen", title: "Экран звонка поверх блокировки", text: "Разрешите показывать входящий звонок на весь экран, даже когда телефон заблокирован.", action: () => Native.openFullScreenCallSettings() });
        if (notePermission !== "granted") problems.push({ id: "notes", title: "Уведомления", text: "Без уведомлений вы не узнаете о новых сообщениях и звонках, пока приложение свёрнуто.", action: () => Native.openAppSettings() });
        // Samsung сам усыпляет «редко используемые» приложения, даже без ограничений батареи —
        // KABAN нужно один раз внести в список тех, что никогда не засыпают.
        let samsungDone = false;
        try { samsungDone = localStorage.getItem(SAMSUNG_SLEEP_KEY) === "1"; } catch { /* ок */ }
        if (/samsung/i.test(status.manufacturer || "") && !samsungDone) {
            problems.push({
                id: "samsung", title: "Спящие приложения Samsung",
                text: status.sdk >= 30
                    ? "Батарея → «Ограничения в фоновом режиме» → «Приложения, которые никогда не переходят в спящий режим» → добавьте KABAN."
                    : "Батарея → «Мониторинг энергопотребления» (или «Неиспользуемые приложения в спящий режим») → исключите KABAN.",
                action: () => { try { localStorage.setItem(SAMSUNG_SLEEP_KEY, "1"); } catch { /* ок */ } return Native.openVendorBatterySettings(); }
            });
        }
        if (!problems.length) return;
        let seen = "";
        try { seen = localStorage.getItem(SETTINGS_SEEN_KEY) || ""; } catch { /* ок */ }
        const key = problems.map((p) => p.id).join(",");
        if (!force && seen === key) return;
        showSetupSheet(problems, status, () => { try { localStorage.setItem(SETTINGS_SEEN_KEY, key); } catch { /* ок */ } });
    }
    window.kabanAndroidSetup = () => checkPhoneSettings(true);

    function showSetupSheet(problems, status, onDone) {
        document.getElementById("android-setup")?.remove();
        const sheet = document.createElement("div");
        sheet.id = "android-setup";
        sheet.className = "android-setup-backdrop open";
        const brandHint = /xiaomi|redmi|poco|huawei|honor|oppo|vivo|realme|oneplus|meizu/i.test(status.manufacturer || "")
            ? `<p class="android-setup-note">На телефонах ${status.manufacturer} ещё включите для KABAN «Автозапуск» в настройках приложения — иначе система закрывает его в фоне.</p>` : "";
        sheet.innerHTML = `
            <div class="android-setup-card" role="dialog" aria-modal="true" aria-label="Настройка звонков">
                <h3>Чтобы звонки доходили</h3>
                <p class="android-setup-lead">KABAN работает без сервисов Google, поэтому телефону нужно разрешить держать его на связи.</p>
                ${problems.map((p, i) => `
                    <div class="android-setup-row">
                        <div><b>${p.title}</b><span>${p.text}</span></div>
                        <button type="button" data-i="${i}">${p.id === "samsung" ? "Открыть" : "Разрешить"}</button>
                    </div>`).join("")}
                ${brandHint}
                <button type="button" class="android-setup-close">Готово</button>
            </div>`;
        document.body.appendChild(sheet);
        sheet.addEventListener("click", (event) => {
            const i = event.target.closest("button[data-i]")?.dataset.i;
            if (i !== undefined) { problems[Number(i)].action().catch?.(() => {}); event.target.textContent = "Открыто ✓"; return; }
            if (event.target === sheet || event.target.closest(".android-setup-close")) { sheet.remove(); onDone(); }
        });
    }

    /* ---------- обновление интерфейса без переустановки ----------
       Как в программе для ПК: app-manifest.json с GitHub Pages → новая версия скачивается в
       память приложения, каждый файл сверяется по SHA-256, и интерфейс переключается на
       неё (тихо — когда приложение свёрнуто и нет звонка, или по кнопке «Обновить»).
       Новая версия не подтвердила запуск за 25 с — Android сам вернёт прежнюю. */

    const UPDATE_BASE = "https://ksougout-netizen.github.io/kaban/";
    const currentVersion = (document.querySelector('script[src*="script-core.js"]')?.getAttribute("src") || "").match(/v=([\d-]+)/)?.[1] || "";
    let readyUpdate = null;     // { version, path }
    let downloading = false;

    function versionNewer(a, b) {
        const [da, na] = String(a).split("-"), [db, nb] = String(b).split("-");
        return da !== db ? da > db : Number(na) > Number(nb);
    }
    function semverAtLeast(have, need) {
        const h = String(have || "0").split(".").map(Number), n = String(need || "0").split(".").map(Number);
        for (let i = 0; i < 3; i++) { if ((h[i] || 0) !== (n[i] || 0)) return (h[i] || 0) > (n[i] || 0); }
        return true;
    }
    async function sha256Hex(buffer) {
        const digest = await crypto.subtle.digest("SHA-256", buffer);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function checkForUpdate() {
        if (downloading || readyUpdate || !Files || !currentVersion) return;
        try {
            const res = await fetch(UPDATE_BASE + "app-manifest.json?ts=" + Date.now(), { cache: "no-store" });
            if (!res.ok) return;
            const manifest = await res.json();
            if (!manifest?.version || !versionNewer(manifest.version, currentVersion)) return;
            const status = await Native.getStatus().catch(() => ({}));
            if (manifest.minAndroid && !semverAtLeast(status.shellVersion, manifest.minAndroid)) {
                log("нужна новая версия приложения", manifest.minAndroid);
                return;
            }
            const info = await Native.getWebInfo();
            const dir = `web/${manifest.version}`;
            const path = `${info.dataDir}/${dir}`;
            if (info.brokenPath === path) return;   // эта версия уже не запустилась — ждём следующую
            downloading = true;
            const names = Object.keys(manifest.files);
            for (const name of names) {
                const meta = manifest.files[name];
                // Файл не менялся — берём из открытой сейчас версии, не качаем заново.
                let buffer = null;
                try {
                    const local = await fetch("/" + encodeURI(name), { cache: "no-store" });
                    if (local.ok) { const b = await local.arrayBuffer(); if (meta.sha256 && await sha256Hex(b) === meta.sha256) buffer = b; }
                } catch { /* нет такого файла */ }
                if (!buffer) {
                    const r = await fetch(UPDATE_BASE + encodeURI(name) + "?v=" + manifest.version, { cache: "no-store" });
                    if (!r.ok) throw new Error(`${name}: ${r.status}`);
                    buffer = await r.arrayBuffer();
                }
                if (meta.sha256 && await sha256Hex(buffer) !== meta.sha256) throw new Error(`${name}: файл повреждён`);
                await Files.writeFile({ path: `${dir}/${name}`, directory: "DATA", data: await blobToBase64(new Blob([buffer])), recursive: true });
            }
            readyUpdate = { version: manifest.version, path };
            log("обновление готово", manifest.version);
            if (appActive) maybeShowUpdateBanner(); else scheduleQuietUpdate();
        } catch (error) {
            log("обновление не скачалось", error);
        } finally {
            downloading = false;
        }
    }

    function busyNow() {
        return (typeof activeCall !== "undefined" && activeCall) || (typeof voiceCall !== "undefined" && voiceCall)
            || (typeof activeGroupCall !== "undefined" && activeGroupCall) || (typeof pendingIncomingCall !== "undefined" && pendingIncomingCall);
    }

    function applyUpdate() {
        if (!readyUpdate) return;
        Native.applyWebPath({ path: readyUpdate.path }).catch((e) => log("apply", e));
    }

    let quietTimer = null;
    function scheduleQuietUpdate() {
        clearTimeout(quietTimer);
        if (!readyUpdate) return;
        quietTimer = setTimeout(() => { if (!appActive && !busyNow()) applyUpdate(); }, 60000);
    }

    function maybeShowUpdateBanner() {
        if (!readyUpdate || document.getElementById("android-update-banner")) return;
        const banner = document.createElement("div");
        banner.id = "android-update-banner";
        banner.className = "desktop-update-banner show";
        banner.setAttribute("role", "status");
        banner.innerHTML = `
            <span class="desktop-update-icon" aria-hidden="true">↻</span>
            <span class="desktop-update-copy"><strong>Доступна новая версия KABAN</strong><em>Обновление займёт секунду</em></span>
            <button type="button" class="desktop-update-btn">Обновить</button>
            <button type="button" class="desktop-update-close" aria-label="Позже" title="Позже">×</button>`;
        banner.querySelector(".desktop-update-btn").onclick = async () => {
            if (busyNow() && !(await kabanConfirm("Обновление прервёт текущий разговор. Продолжить?", { ok: "Обновить" }))) return;
            applyUpdate();
        };
        banner.querySelector(".desktop-update-close").onclick = () => banner.remove();
        document.body.appendChild(banner);
    }

    // Удалить скачанные версии, кроме той, что сейчас открыта.
    async function cleanupOldVersions() {
        if (!Files) return;
        try {
            const info = await Native.getWebInfo();
            const { files } = await Files.readdir({ path: "web", directory: "DATA" });
            for (const entry of files || []) {
                const name = typeof entry === "string" ? entry : entry.name;
                if (!info.serverPath || !info.serverPath.endsWith("/web/" + name)) await Files.rmdir({ path: `web/${name}`, directory: "DATA", recursive: true }).catch(() => {});
            }
        } catch { /* папки ещё нет */ }
    }

    // Эта версия интерфейса загрузилась — подтверждаем (иначе Android вернёт прежнюю).
    window.addEventListener("load", () => {
        setTimeout(() => {
            if (typeof KabanAPI === "undefined" || typeof startCall !== "function") return;
            Native.confirmWebVersion().then(cleanupOldVersions).catch(() => {});
        }, 2500);
    });
    setTimeout(checkForUpdate, 15000);
    setInterval(checkForUpdate, 6 * 60 * 60 * 1000);

    log("KABAN для Android, интерфейс", currentVersion);
})();
