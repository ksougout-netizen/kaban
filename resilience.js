/* =========================================================================
   resilience.js — устойчивость к плохой сети и сбоям
   -------------------------------------------------------------------------
   • KabanConn   — баннер состояния сети, проверка доступности сервера,
                   «догоняющая» синхронизация после возврата связи
                   (пропущенные сообщения, список чатов, мёртвые realtime-каналы).
   • KabanOutbox — очередь неотправленных текстовых сообщений: без сети
                   сообщение остаётся в чате («ожидает сети») и уходит само.
                   Повторная отправка идемпотентна: id создаёт клиент, дубль
                   на сервере даёт 23505 — значит, сообщение уже доставлено.
   • KabanDiag   — единый перехват непредвиденных ошибок: понятное сообщение
                   пользователю и журнал последних ошибок для диагностики.
   Грузится последним — переопределяет/оборачивает функции прежних скриптов.
   ========================================================================= */

const KabanDiag = (() => {

    const LOG_KEY = "kaban-error-log";
    const MAX_ENTRIES = 40;
    let lastToastAt = 0;

    function readLog() {
        try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { return []; }
    }

    function record(kind, message, extra) {
        try {
            const log = readLog();
            log.push({ t: new Date().toISOString(), kind, message: String(message).slice(0, 400), ...(extra || {}) });
            localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)));
        } catch { /* журнал необязателен */ }
    }

    // Ошибки, о которых человеку знать не нужно: шум браузера, расширений, CDN.
    function isNoise(message, source) {
        const text = String(message || "");
        if (/ResizeObserver loop/i.test(text)) return true;
        if (/^Script error\.?$/i.test(text)) return true;
        if (/AbortError|The user aborted|NotAllowedError|play\(\) request was interrupted|The operation was aborted/i.test(text)) return true;
        if (/chrome-extension:|moz-extension:|safari-extension:/i.test(String(source || ""))) return true;
        if (/Non-Error promise rejection/i.test(text)) return true;
        return false;
    }

    function isOurs(source) {
        if (!source) return true;
        try { return new URL(source, location.href).origin === location.origin || location.protocol === "file:"; } catch { return true; }
    }

    function notify() {
        const now = Date.now();
        if (now - lastToastAt < 12000) return;   // не засыпаем человека одинаковыми окнами
        lastToastAt = now;
        if (typeof toast === "function") toast("Что-то пошло не так. Попробуйте ещё раз, а если повторится — обновите страницу (Ctrl+F5)");
    }

    function handle(kind, message, source, stack) {
        if (isNoise(message, source)) return;
        record(kind, message, { source: source ? String(source).slice(-80) : undefined, stack: stack ? String(stack).slice(0, 600) : undefined });
        if (typeof KabanOutbox !== "undefined" && KabanOutbox.isNetworkError({ message })) {
            if (typeof KabanConn !== "undefined") KabanConn.suspect();
            return;                                 // сеть — это баннер, а не «ошибка»
        }
        if (isOurs(source)) notify();
    }

    window.addEventListener("error", (event) => {
        if (event.target && event.target !== window && event.target.tagName) return;   // ресурс не загрузился — не JS-ошибка
        handle("error", event.message, event.filename, event.error?.stack);
    });

    window.addEventListener("unhandledrejection", (event) => {
        const reason = event.reason;
        handle("promise", reason?.message || reason, reason?.fileName, reason?.stack);
    });

    return {
        log: readLog,
        record,
        clear() { try { localStorage.removeItem(LOG_KEY); } catch { /* не критично */ } },
        async copy() {
            const text = JSON.stringify(readLog(), null, 2);
            try { await navigator.clipboard.writeText(text); if (typeof toast === "function") toast("Журнал ошибок скопирован"); } catch { console.log(text); }
        }
    };

})();

// Удобный вызов из консоли: copyErrorLog()
function copyErrorLog() { return KabanDiag.copy(); }

/* ---- очередь неотправленных сообщений --------------------------------------------------------------------- */

const KabanOutbox = (() => {

    const KEY_PREFIX = "kaban-outbox:";
    let items = [];
    let loadedFor = null;
    let running = false;
    let sendingNow = null;     // clientId сообщения, запрос которого сейчас идёт на сервер
    let nextTryAt = 0;
    let failures = 0;

    // Ключ — по аккаунту, для которого очередь загружена, а не по текущему: отправка,
    // закончившаяся уже после выхода (или входа другого человека), иначе записывала
    // остаток чужой очереди под ключ нового аккаунта.
    function storageKey() { return KEY_PREFIX + (loadedFor || ""); }

    function load() {
        const uid = typeof myRealUserId !== "undefined" ? myRealUserId : null;
        if (!uid || loadedFor === uid) return;
        loadedFor = uid;
        try { items = JSON.parse(localStorage.getItem(storageKey()) || "[]"); } catch { items = []; }
    }

    function save() {
        try { localStorage.setItem(storageKey(), JSON.stringify(items)); } catch { /* не критично */ }
    }

    function newId() {
        if (crypto.randomUUID) return crypto.randomUUID();
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function isNetworkError(error) {
        if (!navigator.onLine) return true;
        const text = String(error?.message || error || "");
        if (error?.status === 0 || error?.code === "ETIMEDOUT") return true;
        if (error?.status >= 502 && error?.status <= 504) return true;
        // Протухший токен после офлайна: пока сети не было, библиотека не смогла его
        // обновить, и первая отправка после возвращения связи получает «JWT expired».
        // Это не «не отправилось навсегда» (раньше сообщение помечалось ⚠ и ждало
        // ручного «Повторить») — токен обновится, и следующая попытка пройдёт.
        if (error?.code === "PGRST301" || error?.status === 401 || /jwt expired|invalid jwt|jwt.*expired|token.*expired/i.test(text)) return true;
        return /failed to fetch|networkerror|network request failed|load failed|network error|fetch failed|timed? ?out|timeout|ERR_INTERNET|ERR_NETWORK|ERR_CONNECTION|AuthRetryableFetchError/i.test(text);
    }

    function rowFor(clientId) {
        return document.querySelector(`#messages .message-row[data-message-id="pending-${clientId}"]`);
    }

    function renderRow(item) {

        if (typeof currentChatId === "undefined" || currentChatId !== item.chatId) return;
        const container = document.getElementById("messages");
        if (!container) return;

        let row = rowFor(item.clientId);
        if (!row) {
            appendRealMessageRow({
                id: "pending-" + item.clientId,
                chat_id: item.chatId,
                sender_id: myRealUserId,
                type: "text",
                text: item.text,
                created_at: new Date(item.created).toISOString(),
                reply_to_id: item.replyToId || null,
                attachment_meta: item.attachmentMeta || null,
                message_status: []
            }, true);
            row = rowFor(item.clientId);
            if (!row) return;
            row.classList.add("pending");
            row.dataset.clientId = item.clientId;
            if (typeof updateMessageGrouping === "function") updateMessageGrouping();
        }

        const tick = row.querySelector(".message-status");
        if (tick) { tick.dataset.status = item.state; tick.textContent = item.state === "failed" ? "⚠" : "🕓"; }

        row.classList.toggle("failed", item.state === "failed");
        row.classList.toggle("sending", item.state === "sending");

        // «Отправляется» — обычная отправка в процессе: без плашки, только часики.
        if (item.state === "sending") {
            row.querySelector(".outbox-bar")?.remove();
            return;
        }

        let bar = row.querySelector(".outbox-bar");
        if (!bar) {
            bar = document.createElement("div");
            bar.className = "outbox-bar";
            row.querySelector(".message")?.insertAdjacentElement("afterend", bar);
        }
        bar.innerHTML = item.state === "failed"
            ? `<span>Не отправлено${item.error ? ": " + escapeHTML(item.error) : ""}</span><button type="button" data-act="retry">Повторить</button><button type="button" data-act="cancel">Отмена</button>`
            : `<span>Ожидает сети — отправится само</span><button type="button" data-act="cancel">Отмена</button>`;

        if (appSettings?.autoScroll) scrollMessagesToBottom();

    }

    function removeRow(clientId) { rowFor(clientId)?.remove(); }

    function drop(item) {
        items = items.filter((x) => x.clientId !== item.clientId);
        save();
        removeRow(item.clientId);
    }

    function deliver(item, message) {

        drop(item);
        if (!message) return;

        realMessagesById.set(message.id, message);
        if (currentChatId === item.chatId) {
            appendRealMessageRow(message, true);
            updateMessageGrouping();
            if (appSettings.autoScroll) scrollMessagesToBottom();
        }
        if (typeof patchCachedChatLastMessage === "function") patchCachedChatLastMessage(item.chatId, message);

    }

    async function flush() {

        load();
        if (running || !items.length || !navigator.onLine) return;
        running = true;
        const owner = loadedFor;

        try {
            for (const item of [...items]) {
                // Вышли из аккаунта посреди отправки — остаток очереди не должен уйти
                // с сессией следующего человека.
                if (loadedFor !== owner || myRealUserId !== owner) break;
                if (item.state === "failed") continue;
                // Отменили, пока отправлялось предыдущее, — пропускаем.
                if (!items.some((x) => x.clientId === item.clientId)) continue;
                sendingNow = item.clientId;
                try {
                    const message = await KabanAPI.sendMessage(item.chatId, {
                        type: "text",
                        text: item.text,
                        replyToId: item.replyToId || null,
                        attachmentMeta: item.attachmentMeta || null,
                        id: item.clientId
                    });
                    failures = 0;
                    deliver(item, message);
                } catch (error) {
                    const text = String(error?.message || error || "");
                    if (error?.code === "23505" || /duplicate key/i.test(text)) {
                        // Прошлая попытка дошла до сервера, оборвался только ответ — сообщение уже есть.
                        failures = 0;
                        await deliverExisting(item);
                    } else if (isNetworkError(error)) {
                        failures += 1;
                        nextTryAt = Date.now() + Math.min(30000, 3000 * 2 ** Math.min(failures, 4));
                        if (typeof KabanConn !== "undefined") KabanConn.suspect();
                        break;                      // порядок важен — дальше не идём
                    } else {
                        item.state = "failed";
                        item.error = (typeof sendErrorText === "function" ? sendErrorText(error) : text).slice(0, 80);
                        save();
                        renderRow(item);
                    }
                }
            }
        } finally {
            running = false;
            sendingNow = null;
            if (typeof KabanConn !== "undefined") KabanConn.update();
        }

    }

    // Сообщение уже на сервере (прошлая попытка дошла, оборвался только ответ) —
    // берём его по id. Раньше искали среди последних 20 сообщений чата: в активной
    // группе за время обрыва их набиралось больше, своё не находилось, и строка
    // просто исчезала из ленты до перезахода в чат.
    async function deliverExisting(item) {
        try {
            const message = await KabanAPI.getMessageById?.(item.clientId);
            if (message) { deliver(item, message); return; }
            const recent = await KabanAPI.getMessages(item.chatId, { limit: 50 });
            deliver(item, recent.find((m) => m.id === item.clientId) || null);
        } catch {
            deliver(item, null);
        }
    }

    // Мгновенный показ своего сообщения ДО ответа сервера (как в Telegram): строка
    // с часиками; по ответу её заменяет настоящая (finishSending), при обрыве —
    // она же становится «ожидает сети» (enqueue).
    function showSending(item) {
        renderRow({ ...item, created: Date.now(), state: "sending" });
    }

    function finishSending(clientId) {
        removeRow(clientId);
    }

    function enqueue(item) {
        load();
        items = items.filter((x) => x.clientId !== item.clientId);
        items.push({ ...item, created: Date.now(), state: "waiting" });
        save();
        renderRow(items[items.length - 1]);
        nextTryAt = Date.now() + 3000;
        if (typeof KabanConn !== "undefined") { KabanConn.suspect(); KabanConn.update(); }
    }

    function cancel(clientId) {
        const item = items.find((x) => x.clientId === clientId);
        if (!item) return;
        // Запрос этого сообщения уже ушёл на сервер: раньше «Отмена» убирала его из очереди
        // и возвращала текст в поле ввода, а оно всё равно приходило в чат — и текст легко
        // было отправить второй раз.
        if (sendingNow === clientId) { toast("Сообщение уже отправляется"); return; }
        drop(item);
        const input = document.getElementById("input");
        if (input && currentChatId === item.chatId && !input.value) {
            input.value = item.text;
            if (typeof resizeComposer === "function") resizeComposer();
            if (typeof updateComposerAction === "function") updateComposerAction();
        }
        if (typeof KabanConn !== "undefined") KabanConn.update();
    }

    function retry(clientId) {
        const item = items.find((x) => x.clientId === clientId);
        if (!item) return;
        item.state = "waiting";
        item.error = "";
        save();
        renderRow(item);
        failures = 0;
        flush();
    }

    function renderFor(chatId) {
        load();
        items.filter((x) => x.chatId === chatId).forEach(renderRow);
    }

    document.getElementById("messages")?.addEventListener("click", (event) => {
        const button = event.target.closest(".outbox-bar button");
        if (!button) return;
        const clientId = button.closest(".message-row")?.dataset.clientId;
        if (!clientId) return;
        event.stopPropagation();
        if (button.dataset.act === "retry") retry(clientId); else cancel(clientId);
    }, true);

    // У ожидающего сообщения нет серверной записи — контекстное меню, реакции и т.п. не применимы.
    document.getElementById("messages")?.addEventListener("contextmenu", (event) => {
        if (event.target.closest(".message-row.pending")) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);

    // Тихий «насос»: пока в очереди что-то есть и сеть жива — пробуем по расписанию.
    setInterval(() => {
        load();
        if (items.some((x) => x.state !== "failed") && Date.now() >= nextTryAt) flush();
    }, 2500);

    return {
        newId, isNetworkError, enqueue, flush, cancel, retry, renderFor, showSending, finishSending,
        get pendingCount() { load(); return items.filter((x) => x.state !== "failed").length; },
        get failedCount() { load(); return items.filter((x) => x.state === "failed").length; },
        resetAttempts() { failures = 0; nextTryAt = 0; }
    };

})();

// Окна-«страницы» (профиль, настройки, сохранённое, карточки, медиа…) открываются
// по одному: открыли новое — прежнее само закрывается. Раньше они накладывались друг
// на друга, и чтобы попасть в «Настройки» из «Моего профиля», профиль сначала нужно
// было закрыть вручную. Следим за классом open у всех окон сразу, а не правим каждую
// кнопку, — так правило действует и для окон, которые появятся позже.
// Вложенные окна (участник группы поверх группы, подтверждения) в список не входят —
// им как раз нужно лежать поверх родителя.
const KabanExclusiveWindows = (() => {
    const IDS = [
        "profile-screen-backdrop", "settings-backdrop", "saved-messages-backdrop", "info-modal-backdrop",
        "contact-modal-backdrop", "group-info-backdrop", "new-group-backdrop", "shared-media-backdrop",
        "command-palette-backdrop"
    ];
    const isOpen = (el) => el.classList.contains("open");
    const wasOpen = new Set();

    function check(changedId) {
        const el = document.getElementById(changedId);
        if (!el) return;
        const open = isOpen(el);
        if (!open) { wasOpen.delete(changedId); return; }
        if (wasOpen.has(changedId)) return;
        wasOpen.add(changedId);
        // Телефон: страницы складываются стопкой, как в Telegram (phone-pages.js) — профиль поверх
        // «Настроек», медиа поверх карточки; «назад» возвращает на предыдущую, а не к списку чатов.
        if (typeof isPhoneWidth !== "undefined" && isPhoneWidth) return;
        const closers = (typeof SHEET_CLOSE_BY_BACKDROP_ID !== "undefined" && SHEET_CLOSE_BY_BACKDROP_ID) || {};
        for (const id of IDS) {
            if (id === changedId) continue;
            const other = document.getElementById(id);
            if (!other || !isOpen(other)) continue;
            try { closers[id]?.(); } catch { /* закрыть не вышло */ }
            // Не закрылось (например, в профиле несохранённые правки и человек нажал
            // «Отмена») — не оставляем два окна сразу, убираем только что открытое.
            if (isOpen(other)) {
                try { closers[changedId]?.(); } catch { /* ок */ }
                return;
            }
            wasOpen.delete(id);
        }
    }

    const observer = new MutationObserver((records) => {
        const ids = new Set(records.map((r) => r.target.id).filter(Boolean));
        ids.forEach(check);
    });
    IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (isOpen(el)) wasOpen.add(id);
        observer.observe(el, { attributes: true, attributeFilter: ["class"] });
    });
    return { check };
})();

// «Медиа» (фото, файлы, голосовые, ссылки) строится по сообщениям чата, но
// перерисовывалось только при открытии чата и подгрузке истории: новое голосовое
// появлялось в «Медиа» лишь после повторного входа в чат. Теперь любое появление,
// изменение или удаление сообщения обновляет список (склеиваем всплески в одно
// обновление), а открытое окно «Медиа» перерисовывается тут же.
const KabanSharedMedia = (() => {
    let timer = 0;
    function refresh() {
        clearTimeout(timer);
        timer = setTimeout(() => {
            try {
                if (typeof renderSharedMediaDataForCurrentChat === "function") renderSharedMediaDataForCurrentChat();
                if (document.getElementById("shared-media-backdrop")?.classList.contains("open") && typeof filterSharedMediaModal === "function") filterSharedMediaModal();
            } catch { /* не критично */ }
        }, 120);
    }
    ["appendRealMessageRow", "updateRealMessageRow", "removeMessageRowCompletely"].forEach((name) => {
        const original = globalThis[name];
        if (typeof original !== "function") return;
        // function-объявления верхнего уровня — свойства window; переприсваиваем так же, как openRealChat ниже.
        globalThis[name] = function (...args) {
            const result = original.apply(this, args);
            // Строки истории (quiet: открытие чата, подгрузка старых) — «Медиа» обновит сам
            // показ истории одним разом; иначе при дорисовке кусками оно перестраивалось
            // после каждого куска.
            if (!(name === "appendRealMessageRow" && args[2]?.quiet)) refresh();
            return result;
        };
    });
    return { refresh };
})();

// После открытия чата — показать его неотправленные сообщения.
if (typeof openRealChat === "function") {
    const originalOpenRealChat = openRealChat;
    openRealChat = async function (...args) {
        const result = await originalOpenRealChat.apply(this, args);
        try { KabanOutbox.renderFor(args[0]); } catch { /* не критично */ }
        return result;
    };
}

/* ---- состояние сети и «догоняющая» синхронизация ------------------------------------------------------------------ */

const KabanConn = (() => {

    let reachable = true;        // сервер отвечает
    let probing = false;
    let probeTimer = null;
    let okFlashTimer = null;
    let lastSyncAt = 0;
    let hiddenAt = 0;

    function banner() { return document.getElementById("connection-banner"); }

    function update() {

        const el = banner();
        if (!el) return;

        const offline = !navigator.onLine;
        const down = offline || !reachable;
        const queued = KabanOutbox.pendingCount;
        const failed = KabanOutbox.failedCount;

        if (down) {
            clearTimeout(okFlashTimer);
            el.classList.remove("ok");
            el.textContent = (offline ? "Нет сети" : "Нет связи с сервером") +
                (queued ? ` — ${queued} ${queued === 1 ? "сообщение ждёт" : "сообщ. ждут"} отправки` : " — переподключаемся…");
            el.hidden = false;
        } else if (!el.classList.contains("ok")) {
            el.hidden = !failed;
            if (failed) el.textContent = `Не отправлено сообщений: ${failed} — нажмите «Повторить» под ними`;
        }

    }

    function flashRestored() {
        const el = banner();
        if (!el) return;
        el.classList.add("ok");
        el.textContent = "Соединение восстановлено";
        el.hidden = false;
        clearTimeout(okFlashTimer);
        okFlashTimer = setTimeout(() => { el.classList.remove("ok"); update(); }, 2500);
    }

    async function ping() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            const response = await fetch(`${SUPABASE_URL}/auth/v1/health`, {
                headers: { apikey: SUPABASE_ANON_KEY },
                cache: "no-store",
                signal: controller.signal
            });
            clearTimeout(timer);
            return response.status < 500;
        } catch {
            return false;
        }
    }

    // Что-то не дошло до сервера — проверяем доступность, пока не станет понятно.
    function suspect() {
        if (probing) return;
        probing = true;
        const step = async () => {
            if (!navigator.onLine) { reachable = false; update(); probeTimer = setTimeout(step, 3000); return; }
            const ok = await ping();
            if (ok) {
                const wasDown = !reachable || !navigator.onLine;
                reachable = true;
                probing = false;
                update();
                if (wasDown || KabanOutbox.pendingCount) { if (wasDown) flashRestored(); resync(); }
                return;
            }
            reachable = false;
            update();
            probeTimer = setTimeout(step, 4000);
        };
        clearTimeout(probeTimer);
        step();
    }

    // Догоняем всё, что случилось, пока нас не было. Просьба, пришедшая в первые 4 с
    // после прошлой синхронизации, раньше просто терялась (а это мог быть как раз
    // повторный обрыв) — теперь она переносится на конец этого окна.
    let resyncLater = null;
    async function resync() {

        const now = Date.now();
        if (now - lastSyncAt < 4000) {
            if (!resyncLater) resyncLater = setTimeout(() => { resyncLater = null; resync(); }, 4000 - (now - lastSyncAt) + 50);
            return;
        }
        lastSyncAt = now;

        KabanOutbox.resetAttempts();
        try { await KabanOutbox.flush(); } catch { /* повторим по расписанию */ }

        reviveChannels();
        await fillGap();

        try { if (typeof loadChatList === "function") await loadChatList(); } catch { /* не критично */ }
        try { if (typeof refreshStories === "function") refreshStories(); } catch { /* не критично */ }
        try { if (typeof flushPendingReads === "function") flushPendingReads(); } catch { /* не критично */ }

    }

    // Realtime-сокет переподключился сам (после «тихого» обрыва библиотека
    // переоткрывает его без нашего участия): всё, что пришло, пока он был мёртв,
    // через него уже не придёт — догружаем. Раньше догрузка запускалась только по
    // возврату на вкладку или событию online, и сообщения за время обрыва в
    // открытом чате просто не появлялись.
    function watchRealtimeSocket() {
        let client;
        try { client = getSupabaseClient(); } catch { return; }
        const rt = client?.realtime;
        if (typeof rt?.onOpen !== "function" || typeof rt?.onClose !== "function") return;
        let wasClosed = false;
        rt.onClose(() => { wasClosed = true; });
        rt.onError?.(() => { wasClosed = true; });
        rt.onOpen(() => {
            if (!wasClosed) return;           // самое первое подключение — не «восстановление»
            wasClosed = false;
            if (typeof myRealUserId === "undefined" || !myRealUserId) return;
            reachable = true;
            update();
            resync();
        });
    }
    watchRealtimeSocket();

    // Сторож каналов: раньше упавший канал (входящие звонки, файлы, истории…) оживал
    // только после сна/смены сети — до тех пор события по нему просто не приходили.
    // Теперь раз в 8 секунд проверяем и поднимаем упавшие; ничего не стоит, если всё в порядке.
    setInterval(() => {
        if (!navigator.onLine || typeof myRealUserId === "undefined" || !myRealUserId) return;
        reviveChannels();
    }, 8000);

    // Каналы Realtime, которые сервер закрыл или которые оборвались, — подписываем заново.
    function reviveChannels() {
        try {
            const db = getSupabaseClient();
            if (db.realtime && !db.realtime.isConnected?.()) db.realtime.connect();
            (db.getChannels?.() || []).forEach((channel) => {
                if (channel.state === "errored" || channel.state === "closed") {
                    try { channel.subscribe(); } catch { /* уже подписывается */ }
                }
            });
        } catch { /* не критично */ }
    }

    // Сообщения, пришедшие в открытый чат за время обрыва, не доставляются задним числом — берём их сами.
    async function fillGap() {

        const chatId = typeof currentChatId !== "undefined" ? currentChatId : null;
        if (!chatId || typeof realMessagesById === "undefined" || !document.getElementById("messages")) return;

        // Дельта, а не «последние 50»: раньше, если за время обрыва в чате набралось
        // больше 50 сообщений (активная группа, 10 минут в метро), всё, что старше
        // последних 50, просто пропадало из ленты — дыра посередине переписки.
        // Листаем назад страницами, пока не встретим уже известное сообщение
        // (не больше 10 страниц — дальше разумнее переоткрыть чат).
        let fetched = [];
        try {
            let before = null;
            for (let page = 0; page < 10; page++) {
                const batch = await KabanAPI.getMessages(chatId, before ? { limit: 50, before } : { limit: 50 });
                if (currentChatId !== chatId) return;
                fetched = batch.concat(fetched);
                // Размер и курсор — по ответу сервера, а не по списку без просроченных
                // исчезающих (см. serverPageLength в script-chats.js).
                if (serverPageLength(batch) < 50 || batch.some((m) => realMessagesById.has(m.id))) break;
                before = serverPageOldest(batch);
            }
        } catch { return; }
        if (currentChatId !== chatId || !fetched.length) return;

        const me = myRealUserId;
        const fetchedIds = new Set(fetched.map((m) => m.id));
        const oldest = fetched[0].created_at;
        const newest = fetched[fetched.length - 1].created_at;
        const container = document.getElementById("messages");
        const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
        const unread = [];
        let appended = false;

        // Самое новое из уже показанного: realtime после переподключения мог успеть принести
        // свежее сообщение раньше, чем мы догрузили «дыру». Раньше сообщения из дыры просто
        // дописывались в конец — и вставали ПОСЛЕ более нового. Теперь — на своё место.
        let latestShown = "";
        realMessagesById.forEach((m) => { if (m.chat_id === chatId && m.created_at > latestShown) latestShown = m.created_at; });
        const placeChronologically = (id, createdAt) => {
            const row = container.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"]`);
            if (!row) return;
            for (const other of container.querySelectorAll(".message-row[data-message-id]")) {
                if (other === row) return;
                if ((realMessagesById.get(other.dataset.messageId)?.created_at || "") > createdAt) { other.before(row); return; }
            }
        };

        for (const message of fetched) {

            const known = realMessagesById.get(message.id);

            if (!known) {
                if (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret && message.encryption_iv && typeof KabanCrypto !== "undefined") {
                    try { message.text = await KabanCrypto.decryptMessage(chatId, message); } catch { message.text = "🔒 Не удалось расшифровать"; }
                }
                if (currentChatId !== chatId) return;
                realMessagesById.set(message.id, message);
                appendRealMessageRow(message, message.sender_id === me);
                if (message.created_at < latestShown) placeChronologically(message.id, message.created_at);
                appended = true;
                if (message.sender_id !== me) unread.push(message.id);
            } else if (known.edited_at !== message.edited_at || known.deleted_at !== message.deleted_at || known.text !== message.text) {
                realMessagesById.set(message.id, { ...known, ...message, text: known.encryption_iv ? known.text : message.text });
                updateRealMessageRow(message.id);
            }

        }

        // Удалённые «у всех» за время обрыва — убираем из ленты. Только в пределах
        // загруженного окна [oldest, newest]: раньше верхней границы не было, и сообщение,
        // пришедшее (или отправленное мной) уже ПОСЛЕ запроса — пока догружались следующие
        // страницы или расшифровывалось, — считалось удалённым и пропадало из ленты.
        for (const [id, message] of [...realMessagesById]) {
            if (message.chat_id === chatId && message.created_at >= oldest && message.created_at <= newest && !fetchedIds.has(id)) removeMessageRowCompletely(id);
        }

        if (appended) {
            updateMessageGrouping();
            if (wasAtBottom && appSettings.autoScroll) scrollMessagesToBottom();
        }
        if (unread.length) {
            if (typeof sendReadMarks === "function" && !document.hidden) sendReadMarks(unread);
            else unread.forEach((id) => typeof pendingReadIds !== "undefined" && pendingReadIds.add(id));
        }

    }

    window.addEventListener("offline", () => { reachable = false; update(); });
    window.addEventListener("online", () => { suspect(); });

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) { hiddenAt = Date.now(); return; }
        // Вкладка была скрыта (или компьютер спал) — каналы могли тихо умереть.
        if (hiddenAt && Date.now() - hiddenAt > 20000) resync();
        hiddenAt = 0;
    });

    update();

    return { update, suspect, resync };

})();
