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
    let nextTryAt = 0;
    let failures = 0;

    function storageKey() { return KEY_PREFIX + (typeof myRealUserId !== "undefined" ? myRealUserId : ""); }

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

        try {
            for (const item of [...items]) {
                if (item.state === "failed") continue;
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
                        item.error = text.slice(0, 80);
                        save();
                        renderRow(item);
                    }
                }
            }
        } finally {
            running = false;
            if (typeof KabanConn !== "undefined") KabanConn.update();
        }

    }

    async function deliverExisting(item) {
        try {
            const recent = await KabanAPI.getMessages(item.chatId, { limit: 20 });
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

    // Догоняем всё, что случилось, пока нас не было.
    async function resync() {

        const now = Date.now();
        if (now - lastSyncAt < 4000) return;
        lastSyncAt = now;

        KabanOutbox.resetAttempts();
        try { await KabanOutbox.flush(); } catch { /* повторим по расписанию */ }

        reviveChannels();
        await fillGap();

        try { if (typeof loadChatList === "function") await loadChatList(); } catch { /* не критично */ }

    }

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

        let fetched;
        try { fetched = await KabanAPI.getMessages(chatId, { limit: 50 }); } catch { return; }
        if (currentChatId !== chatId || !fetched.length) return;

        const me = myRealUserId;
        const fetchedIds = new Set(fetched.map((m) => m.id));
        const oldest = fetched[0].created_at;
        const container = document.getElementById("messages");
        const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 120;
        const unread = [];
        let appended = false;

        for (const message of fetched) {

            const known = realMessagesById.get(message.id);

            if (!known) {
                if (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret && message.encryption_iv && typeof KabanCrypto !== "undefined") {
                    try { message.text = await KabanCrypto.decryptMessage(chatId, message); } catch { message.text = "🔒 Не удалось расшифровать"; }
                }
                if (currentChatId !== chatId) return;
                realMessagesById.set(message.id, message);
                appendRealMessageRow(message, message.sender_id === me);
                appended = true;
                if (message.sender_id !== me) unread.push(message.id);
            } else if (known.edited_at !== message.edited_at || known.deleted_at !== message.deleted_at || known.text !== message.text) {
                realMessagesById.set(message.id, { ...known, ...message, text: known.encryption_iv ? known.text : message.text });
                updateRealMessageRow(message.id);
            }

        }

        // Удалённые «у всех» за время обрыва — убираем из ленты.
        for (const [id, message] of [...realMessagesById]) {
            if (message.chat_id === chatId && message.created_at >= oldest && !fetchedIds.has(id)) removeMessageRowCompletely(id);
        }

        if (appended) {
            updateMessageGrouping();
            if (wasAtBottom && appSettings.autoScroll) scrollMessagesToBottom();
        }
        if (unread.length) KabanAPI.markMessagesAsRead(unread).catch(() => {});

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
