/* ============================================================================
   ИСЧЕЗАЮЩИЕ СООБЩЕНИЯ (автоудаление). Нужен disappearing.sql: пока он не выполнен,
   приложение это молча пропускает (никаких кнопок, никаких запросов в чатах).

   Как работает:
     • в чате можно включить таймер (1 час / 1 день / 1 неделя): новые сообщения
       удаляются через это время после отправки — у всех участников. Срок
       проставляет сервер (колонка messages.expires_at), клиент его не выбирает;
     • у исчезающего сообщения рядом со временем значок таймера;
     • как только срок вышел, сообщение само уходит из ленты (проверка раз в 2 с),
       а физически удаляется функцией purge_expired_messages() — её зовём раз в
       минуту и при открытии чата; файлы из хранилища стираем сами;
     • просроченные сообщения не показываются и при загрузке истории;
     • включают таймер: в личном чате любой из двоих, в группе — владелец/админ.
   Подключается после resilience.js / photo-editor.js.
   ========================================================================= */

(function () {

    "use strict";

    const OPTIONS = [
        { seconds: null, label: "Выключено", hint: "Сообщения остаются" },
        { seconds: 3600, label: "1 час", hint: "Новые сообщения исчезнут через час" },
        { seconds: 86400, label: "1 день", hint: "Новые сообщения исчезнут через сутки" },
        { seconds: 604800, label: "1 неделя", hint: "Новые сообщения исчезнут через 7 дней" }
    ];

    const TIMER_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5M9.5 3.5h5"/></svg>';

    let available = null;                 // null — ещё не знаем, false — SQL не выполнен
    const ttlByChat = new Map();          // chatId → секунды или null
    let purging = false;
    let purgeTimer = null;

    /* ---- запросы ------------------------------------------------------------- */

    function missingSchema(error) {
        const text = String(error?.message || error || "");
        return error?.code === "42703" || error?.code === "42883" || error?.code === "PGRST202" || error?.code === "PGRST204"
            || /ttl_seconds|expires_at|set_chat_ttl|purge_expired_messages|schema cache/i.test(text);
    }

    async function fetchChatTtl(chatId) {
        const db = getSupabaseClient();
        const { data, error } = await db.from("chats").select("ttl_seconds").eq("id", chatId).maybeSingle();
        if (error) {
            if (missingSchema(error)) { available = false; return undefined; }
            throw error;
        }
        available = true;
        return data ? (data.ttl_seconds ?? null) : null;
    }

    async function refreshChatTtl(chatId) {
        if (!chatId || available === false) return;
        try {
            const ttl = await fetchChatTtl(chatId);
            if (ttl === undefined) { syncUI(); return; }
            ttlByChat.set(chatId, ttl);
            if (chatId === currentChatId) syncUI();
        } catch (error) {
            console.warn("Не удалось узнать таймер чата", error);
        }
    }

    function labelFor(seconds) {
        const option = OPTIONS.find((o) => o.seconds === seconds);
        if (option) return option.label;
        return seconds ? `${seconds} сек.` : "Выключено";
    }

    /* ---- интерфейс ---------------------------------------------------------------- */

    function ensureHeaderButton() {

        let button = document.getElementById("ttl-header-btn");
        if (button) return button;
        const tools = document.querySelector(".header-tools");
        if (!tools) return null;

        button = document.createElement("button");
        button.type = "button";
        button.id = "ttl-header-btn";
        button.className = "icon-btn header-tool ttl-header-btn";
        button.hidden = true;
        button.setAttribute("aria-label", "Автоудаление сообщений");
        button.innerHTML = TIMER_ICON;
        button.addEventListener("click", () => openTtlPicker());
        tools.insertBefore(button, tools.firstChild);
        return button;

    }

    function syncUI() {

        const chatId = typeof currentChatId !== "undefined" ? currentChatId : null;
        const ttl = chatId ? (ttlByChat.get(chatId) ?? null) : null;
        const usable = available === true && !!chatId;

        const header = ensureHeaderButton();
        if (header) {
            header.hidden = !(usable && ttl);
            header.title = ttl ? `Автоудаление: ${labelFor(ttl)}` : "Автоудаление";
            header.setAttribute("aria-label", header.title);
        }

        const isGroup = typeof currentChatType !== "undefined" && currentChatType === "group";
        const infoBtn = document.getElementById("info-ttl-btn");
        if (infoBtn) {
            infoBtn.hidden = !usable || isGroup;
            const hint = document.getElementById("info-ttl-hint");
            if (hint) hint.textContent = ttl ? `Через ${labelFor(ttl)}` : "Выключено";
        }

        const groupBtn = document.getElementById("group-info-ttl-btn");
        if (groupBtn) {
            groupBtn.hidden = !usable || !isGroup;
            const meta = document.getElementById("group-info-ttl-meta");
            if (meta) meta.textContent = ttl ? labelFor(ttl) : "Выкл.";
        }

    }

    function buildPicker() {

        if (document.getElementById("ttl-backdrop")) return;
        const backdrop = document.createElement("div");
        backdrop.className = "forward-backdrop";
        backdrop.id = "ttl-backdrop";
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `
            <section class="forward-modal group-info-modal" role="dialog" aria-modal="true" aria-label="Автоудаление сообщений">
                <div class="forward-modal-header">
                    <span>Автоудаление сообщений</span>
                    <button type="button" class="settings-close" data-ttl-act="close" aria-label="Закрыть">×</button>
                </div>
                <div class="ttl-options" id="ttl-options"></div>
                <p class="group-perms-hint">Новые сообщения в этом чате будут удаляться у всех участников через выбранное время после отправки. Уже отправленные остаются. Записать или переслать исчезающее сообщение всё равно можно — хранить его нужно самим.</p>
            </section>`;
        document.body.appendChild(backdrop);

        backdrop.addEventListener("click", (event) => {
            if (event.target === backdrop || event.target.closest("[data-ttl-act='close']")) { closeTtlPicker(); return; }
            const option = event.target.closest("[data-ttl]");
            if (option) chooseTtl(option.dataset.ttl === "" ? null : Number(option.dataset.ttl));
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && backdrop.classList.contains("open")) { event.stopImmediatePropagation(); closeTtlPicker(); }
        }, true);

    }

    function renderPicker() {
        const current = ttlByChat.get(currentChatId) ?? null;
        document.getElementById("ttl-options").innerHTML = OPTIONS.map((o) => `
            <button type="button" class="ttl-option${o.seconds === current ? " active" : ""}" data-ttl="${o.seconds ?? ""}">
                <span class="ttl-option-icon">${TIMER_ICON}</span>
                <span class="ttl-option-copy"><span class="ttl-option-title">${o.label}</span><span class="ttl-option-hint">${o.hint}</span></span>
                <span class="ttl-option-check" aria-hidden="true">${o.seconds === current ? "✓" : ""}</span>
            </button>`).join("");
    }

    window.openTtlPicker = async function () {

        if (!currentChatId) { toast("Откройте чат"); return; }
        if (available === false) { toast("Автоудаление ещё не включено на сервере (нужно выполнить disappearing.sql)"); return; }
        if (available === null) await refreshChatTtl(currentChatId);
        if (available !== true) { toast("Автоудаление ещё не включено на сервере (нужно выполнить disappearing.sql)"); return; }

        buildPicker();
        renderPicker();
        const backdrop = document.getElementById("ttl-backdrop");
        backdrop.classList.add("open");
        backdrop.setAttribute("aria-hidden", "false");

    };

    function closeTtlPicker() {
        const backdrop = document.getElementById("ttl-backdrop");
        if (!backdrop) return;
        backdrop.classList.remove("open");
        backdrop.setAttribute("aria-hidden", "true");
    }

    async function chooseTtl(seconds) {

        const chatId = currentChatId;
        if (!chatId) return;
        if ((ttlByChat.get(chatId) ?? null) === seconds) { closeTtlPicker(); return; }

        try {
            const { error } = await getSupabaseClient().rpc("set_chat_ttl", { p_chat: chatId, p_ttl: seconds });
            if (error) throw error;
        } catch (error) {
            const text = String(error?.message || error);
            toast(/only the owner or an admin/i.test(text)
                ? "Автоудаление в группе включают владелец и администраторы"
                : "Не удалось изменить автоудаление: " + text);
            return;
        }

        ttlByChat.set(chatId, seconds);
        closeTtlPicker();
        syncUI();
        toast(seconds ? `Автоудаление: через ${labelFor(seconds)}` : "Автоудаление выключено");

    }

    /* ---- значок таймера и исчезновение в ленте -------------------------------- */

    function decorateExpiring(message) {

        const row = document.querySelector(`#messages .message-row[data-message-id="${message.id}"]`);
        if (!row) return;
        row.dataset.expiresAt = message.expires_at;
        const time = row.querySelector(".message-time");
        if (time && !time.querySelector(".message-timer")) {
            const icon = document.createElement("span");
            icon.className = "message-timer";
            icon.title = "Исчезающее сообщение";
            icon.innerHTML = TIMER_ICON;
            time.insertBefore(icon, time.firstChild);
        }

    }

    function expireDueRows() {

        const now = Date.now();
        let removed = 0;
        document.querySelectorAll("#messages .message-row[data-expires-at]").forEach((row) => {
            if (Date.parse(row.dataset.expiresAt) <= now) {
                removeMessageRowCompletely(row.dataset.messageId, { deferRefresh: true });
                removed++;
            }
        });
        // Ещё не показанные (не в ленте), но уже просроченные — просто забываем.
        realMessagesById.forEach((message, id) => {
            if (message.expires_at && Date.parse(message.expires_at) <= now) realMessagesById.delete(id);
        });
        if (removed) {
            if (typeof refreshAfterMessageRemoval === "function") refreshAfterMessageRemoval();
            purgeSoon();
        }

    }

    /* ---- физическое удаление ------------------------------------------------------ */

    async function purgeExpiredNow() {

        if (available === false || purging || !myRealUserId || !navigator.onLine) return;
        purging = true;
        try {
            const { data, error } = await getSupabaseClient().rpc("purge_expired_messages");
            if (error) {
                if (missingSchema(error)) available = false;
                return;
            }
            available = true;
            const urls = (data || []).map((row) => row.attachment_url).filter(Boolean);
            // Файл стираем из хранилища: свои — получится, чужие по правилам доступа нет (их стирает отправитель).
            urls.forEach((url) => KabanAPI.deleteStorageFile?.("attachments", url)?.catch?.(() => {}));
            if (urls.length || (data || []).length) {
                if (typeof loadChatList === "function") loadChatList();
            }
        } catch (error) {
            console.warn("Не удалось удалить просроченные сообщения", error);
        } finally {
            purging = false;
        }

    }

    let purgeSoonTimer = null;
    function purgeSoon() {
        clearTimeout(purgeSoonTimer);
        purgeSoonTimer = setTimeout(purgeExpiredNow, 1500);
    }

    /* ---- подключение к остальному приложению ------------------------------------ */

    // История: просроченные сообщения не показываем (даже если ещё не удалены с сервера).
    if (typeof KabanAPI !== "undefined" && KabanAPI.getMessages) {
        const originalGetMessages = KabanAPI.getMessages.bind(KabanAPI);
        KabanAPI.getMessages = async function (...args) {
            const rows = await originalGetMessages(...args);
            const now = Date.now();
            return rows.filter((m) => !m.expires_at || Date.parse(m.expires_at) > now);
        };
    }

    if (typeof appendRealMessageRow === "function") {
        const originalAppend = appendRealMessageRow;
        appendRealMessageRow = function (message) {
            const result = originalAppend.apply(this, arguments);
            if (message?.expires_at) decorateExpiring(message);
            // Служебная запись «включил(а) автоудаление» — узнаём новый таймер.
            if (message?.type === "system" && /автоудаление/i.test(message.text || "")) refreshChatTtl(message.chat_id);
            return result;
        };
    }

    if (typeof openRealChat === "function") {
        const originalOpen = openRealChat;
        openRealChat = async function (chatId) {
            const result = await originalOpen.apply(this, arguments);
            refreshChatTtl(chatId);
            purgeSoon();
            return result;
        };
    }

    if (typeof openInfoModal === "function") {
        const originalOpenInfo = openInfoModal;
        openInfoModal = function () { const result = originalOpenInfo.apply(this, arguments); syncUI(); return result; };
    }
    if (typeof openGroupInfoModal === "function") {
        const originalOpenGroup = openGroupInfoModal;
        openGroupInfoModal = function () { const result = originalOpenGroup.apply(this, arguments); syncUI(); return result; };
    }

    setInterval(expireDueRows, 2000);
    purgeTimer = setInterval(purgeExpiredNow, 60000);
    setTimeout(purgeExpiredNow, 9000);

    window.KabanDisappearing = {
        _state: { ttlByChat, get available() { return available; }, set available(v) { available = v; } },
        _expireDueRows: expireDueRows, _decorate: decorateExpiring, _sync: syncUI, _purge: purgeExpiredNow, _choose: chooseTtl
    };

})();
