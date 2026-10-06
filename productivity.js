/* ============================================================================
   ПРОДУКТИВНОСТЬ: напоминания по сообщению, предпросмотр ссылок, поиск по всем
   чатам, командная палитра (Ctrl/Cmd+K) с командами и сообщениями.
   Загружается после остальных скриптов; функции палитры переопределяют
   одноимённые из script-messages.js (последнее объявление выигрывает).
   ========================================================================= */

/* ---- маленькие SVG-иконки для палитры ------------------------------------------ */
const PALETTE_ICONS = {
    chat: '<path d="M4 11.5c0-4.14 3.58-7.5 8-7.5s8 3.36 8 7.5-3.58 7.5-8 7.5c-1.04 0-2.03-.18-2.94-.52L5 20l1.1-3.3A7.35 7.35 0 0 1 4 11.5Z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>',
    user: '<circle cx="12" cy="8.5" r="3.4"/><path d="M5 19.5c0-3.4 3.1-5.8 7-5.8s7 2.4 7 5.8"/>',
    users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3 19c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2"/><circle cx="17" cy="9.5" r="2.5"/><path d="M17 14c2.6 0 4.5 1.6 4.5 4.2"/>',
    palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.9-.8 1.9-1.7 0-.5-.2-.8-.4-1.2-.3-.4-.4-.8-.4-1.2 0-.9.7-1.6 1.7-1.6H17a3.5 3.5 0 0 0 3.5-3.5C20.5 6.9 16.7 3.5 12 3.5Z"/><circle cx="8" cy="11" r="1"/><circle cx="12" cy="7.8" r="1"/><circle cx="16" cy="11" r="1"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
    bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20a2 2 0 0 0 4 0"/>',
    speaker: '<path d="M4 10v4h3.5L12 18V6L7.5 10zM15.5 9a4 4 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11"/>',
    pin: '<path d="m9 4 6 6-2.5 2.5V16l-1.5 1.5L6.5 13l1.5-1.5H11.5L14 9"/><path d="M5 19l3.5-3.5"/>',
    poll: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    game: '<rect x="3" y="7" width="18" height="11" rx="5"/><path d="M8 10.5v4M6 12.5h4M15.5 11.5h.01M17.5 13.5h.01"/>',
    phone: '<path d="M5 4.5h3.5l1.7 4.2-2.1 1.4a11 11 0 0 0 5.8 5.8l1.4-2.1 4.2 1.7V19a1.5 1.5 0 0 1-1.6 1.5A14.5 14.5 0 0 1 3.5 6.1 1.5 1.5 0 0 1 5 4.5Z"/>',
    video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="m15.5 10.5 5-3v9l-5-3z"/>',
    story: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>',
    signal: '<path d="M4 18v-1M9 18v-4M14 18V9M19 18V5"/>',
    exit: '<path d="M10 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H10M15 8l4 4-4 4M19 12H9"/>',
    msg: '<path d="M4.5 6.5h15v9h-7l-4 3.5v-3.5h-4z"/>'
};

function paletteIcon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${PALETTE_ICONS[name] || PALETTE_ICONS.chat}</svg>`;
}

/* ============================================================================
   1. НАПОМИНАНИЯ. Хранятся на этом устройстве (localStorage), проверяются раз в
   15 секунд, пока приложение открыто (вкладка может быть в фоне). Срабатывание:
   системное уведомление (если разрешено) + карточка в углу с «Открыть» и
   «Отложить».
   ========================================================================= */

let reminderTimer = null;
let reminderTargetMessageId = null;

function remindersKey() { return "kaban-reminders:" + (myRealUserId || "guest"); }

function loadReminders() {
    try {
        const list = JSON.parse(localStorage.getItem(remindersKey()) || "[]");
        return Array.isArray(list) ? list : [];
    } catch { return []; }
}

function saveReminders(list) {
    try { localStorage.setItem(remindersKey(), JSON.stringify(list)); } catch { toast("Не удалось сохранить напоминание: нет места в браузере"); }
}

function startReminders() {
    clearInterval(reminderTimer);
    reminderTimer = setInterval(checkDueReminders, 15000);
    setTimeout(checkDueReminders, 2500);
    syncRemindersHint();
}

function stopReminders() { clearInterval(reminderTimer); reminderTimer = null; }

function syncRemindersHint() {
    const hint = document.getElementById("reminders-row-hint");
    if (!hint) return;
    const count = loadReminders().filter((r) => !r.fired).length;
    hint.textContent = count ? String(count) : "Нет";
}

function contextMenuRemind() {
    const messageId = contextMenuTargetRow?.dataset.messageId;
    document.getElementById("message-context-menu").hidden = true;
    if (messageId) openReminderPicker(messageId);
}

function formatReminderTime(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diffDays = Math.round((day - today) / 86400000);
    const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    if (diffDays === 0) return "сегодня в " + time;
    if (diffDays === 1) return "завтра в " + time;
    return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + " в " + time;
}

function openReminderPicker(messageId) {

    const message = realMessagesById.get(messageId);
    if (!message) return;
    reminderTargetMessageId = messageId;

    document.getElementById("reminder-preview").textContent = messagePreviewText(message);

    const now = new Date();
    const evening = new Date(now); evening.setHours(19, 0, 0, 0);
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
    const monday = new Date(now); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(9, 0, 0, 0);

    const options = [
        { label: "Через 15 минут", ts: now.getTime() + 15 * 60000 },
        { label: "Через час", ts: now.getTime() + 60 * 60000 },
        { label: "Через 3 часа", ts: now.getTime() + 3 * 3600000 },
        ...(evening > now ? [{ label: "Сегодня вечером · 19:00", ts: evening.getTime() }] : []),
        { label: "Завтра утром · 9:00", ts: tomorrow.getTime() },
        { label: "В понедельник · 9:00", ts: monday.getTime() }
    ];

    document.getElementById("reminder-options").innerHTML = options.map((o) =>
        `<button type="button" class="reminder-option" data-ts="${o.ts}" onclick="createReminder(Number(this.dataset.ts))">${o.label}</button>`).join("");

    const custom = document.getElementById("reminder-custom-input");
    const pad = (n) => String(n).padStart(2, "0");
    const base = new Date(now.getTime() + 3600000);
    custom.value = `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
    custom.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

    const backdrop = document.getElementById("reminder-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeReminderPicker() {
    const backdrop = document.getElementById("reminder-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function createReminderFromCustom() {
    const value = document.getElementById("reminder-custom-input").value;
    const ts = value ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(ts) || ts <= Date.now()) { toast("Выберите время в будущем"); return; }
    createReminder(ts);
}

async function createReminder(dueTs) {

    const message = realMessagesById.get(reminderTargetMessageId);
    if (!message) return;

    const list = loadReminders();
    list.push({
        id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        chatId: message.chat_id || currentChatId,
        messageId: message.id,
        preview: messagePreviewText(message).slice(0, 140),
        chatTitle: currentChatTitle || "Чат",
        due: dueTs,
        fired: false
    });
    saveReminders(list);
    closeReminderPicker();
    syncRemindersHint();
    toast("Напомню " + formatReminderTime(dueTs));

    // Разрешение на уведомления просим в момент, когда оно реально нужно.
    if ("Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch { /* пользователь закрыл запрос */ }
    }

}

function checkDueReminders() {

    const list = loadReminders();
    const now = Date.now();
    let changed = false;

    list.forEach((reminder) => {
        if (reminder.fired || reminder.due > now) return;
        reminder.fired = true;
        changed = true;
        // Давно просроченное (приложение было закрыто больше суток) — молча.
        if (now - reminder.due < 24 * 3600000) fireReminder(reminder);
    });

    if (changed) {
        // Отработавшие храним недолго — для истории в списке.
        saveReminders(list.filter((r) => !r.fired || now - r.due < 48 * 3600000));
        syncRemindersHint();
        if (document.getElementById("reminders-backdrop")?.classList.contains("open")) renderRemindersList();
    }

}

function fireReminder(reminder) {

    if ("Notification" in window && Notification.permission === "granted") {
        try {
            const notification = new Notification("Напоминание · " + reminder.chatTitle, { body: reminder.preview, tag: reminder.id });
            notification.onclick = () => { window.focus(); openReminderTarget(reminder.chatId, reminder.messageId); notification.close(); };
        } catch { /* на части мобильных браузеров конструктор недоступен — есть карточка в приложении */ }
    }

    const card = document.createElement("div");
    card.className = "reminder-card";
    card.innerHTML = `
        <div class="reminder-card-head"><span class="reminder-card-icon">${paletteIcon("bell")}</span><span>Напоминание · ${escapeHTML(reminder.chatTitle)}</span></div>
        <div class="reminder-card-text">${escapeHTML(reminder.preview)}</div>
        <div class="reminder-card-actions">
            <button type="button" data-act="open">Открыть</button>
            <button type="button" data-act="snooze">Через 10 мин</button>
            <button type="button" data-act="close" aria-label="Закрыть">✕</button>
        </div>`;
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add("show"));

    const remove = () => { card.classList.remove("show"); setTimeout(() => card.remove(), 250); };
    card.addEventListener("click", (event) => {
        const act = event.target.closest("button")?.dataset.act;
        if (!act) return;
        if (act === "open") openReminderTarget(reminder.chatId, reminder.messageId);
        if (act === "snooze") {
            const list = loadReminders();
            list.push({ ...reminder, id: reminder.id + "s", due: Date.now() + 10 * 60000, fired: false });
            saveReminders(list);
            syncRemindersHint();
            toast("Напомню через 10 минут");
        }
        remove();
    });
    setTimeout(remove, 45000);

    if (appSettings.receiveSound) { try { playReceiveSound(); } catch { /* звук не критичен */ } }

}

async function openReminderTarget(chatId, messageId) {
    closeRemindersList();
    await jumpToMessage(chatId, messageId);
}

function openRemindersList() {
    renderRemindersList();
    const backdrop = document.getElementById("reminders-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeRemindersList() {
    const backdrop = document.getElementById("reminders-backdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function renderRemindersList() {

    const list = loadReminders().sort((a, b) => a.due - b.due);
    const upcoming = list.filter((r) => !r.fired);
    const past = list.filter((r) => r.fired);

    const row = (r) => `
        <div class="reminder-row${r.fired ? " past" : ""}">
            <button type="button" class="reminder-row-main" data-chat="${escapeHTML(r.chatId)}" data-message="${escapeHTML(r.messageId)}" onclick="openReminderTarget(this.dataset.chat, this.dataset.message)">
                <span class="reminder-row-time">${escapeHTML(formatReminderTime(r.due))} · ${escapeHTML(r.chatTitle)}</span>
                <span class="reminder-row-text">${escapeHTML(r.preview)}</span>
            </button>
            <button type="button" class="reminder-row-delete" data-id="${escapeHTML(r.id)}" onclick="deleteReminder(this.dataset.id)" aria-label="Удалить">✕</button>
        </div>`;

    document.getElementById("reminders-list").innerHTML =
        (upcoming.length ? upcoming.map(row).join("") : '<div class="group-perms-hint">Предстоящих напоминаний нет. Откройте меню сообщения (правый клик) → «Напомнить».</div>')
        + (past.length ? `<div class="group-members-head poll-head"><span>Сработавшие</span></div>${past.map(row).join("")}` : "");

}

function deleteReminder(id) {
    saveReminders(loadReminders().filter((r) => r.id !== id));
    renderRemindersList();
    syncRemindersHint();
}

/* ============================================================================
   2. ПРЕДПРОСМОТР ССЫЛОК. Карточка под текстом: картинка, сайт, заголовок,
   описание. Данные берём у noembed.com (YouTube, Vimeo и т.п.), для остальных —
   у microlink.io; результаты кэшируются на устройстве. Адрес ссылки уходит этим
   сервисам — поэтому есть переключатель в настройках, а в секретных чатах
   предпросмотр никогда не запрашивается.
   ========================================================================= */

const LINK_PREVIEW_CACHE_KEY = "kaban-link-previews";
const LINK_PREVIEW_TTL = 7 * 24 * 3600000;
const linkPreviewInflight = new Map();

function linkPreviewsEnabled() { return appSettings.linkPreviews !== false && !currentChatIsSecret; }

// Кэш разбирается из localStorage ОДИН раз и дальше живёт в памяти: раньше при
// открытии чата JSON-кэш (до 160 карточек) заново парсился для каждой ссылки.
let linkPreviewMemoryCache = null;
let linkPreviewSaveTimer = null;

function loadLinkPreviewCache() {
    if (!linkPreviewMemoryCache) {
        try { linkPreviewMemoryCache = JSON.parse(localStorage.getItem(LINK_PREVIEW_CACHE_KEY) || "{}") || {}; } catch { linkPreviewMemoryCache = {}; }
    }
    return linkPreviewMemoryCache;
}

function saveLinkPreview(url, data) {
    const cache = loadLinkPreviewCache();
    cache[url] = { at: Date.now(), data };
    const keys = Object.keys(cache);
    if (keys.length > 160) keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 160).forEach((k) => delete cache[k]);
    // Запись на диск — не чаще раза в секунду (и не посреди открытия чата).
    clearTimeout(linkPreviewSaveTimer);
    linkPreviewSaveTimer = setTimeout(() => {
        try { localStorage.setItem(LINK_PREVIEW_CACHE_KEY, JSON.stringify(cache)); } catch { /* кэш необязателен */ }
    }, 1000);
}

async function fetchLinkPreview(url) {

    const cached = loadLinkPreviewCache()[url];
    if (cached && Date.now() - cached.at < (cached.data ? LINK_PREVIEW_TTL : 3600000)) return cached.data;
    if (linkPreviewInflight.has(url)) return linkPreviewInflight.get(url);

    const job = (async () => {

        let data = null;

        try {
            const response = await fetch("https://noembed.com/embed?url=" + encodeURIComponent(url));
            const json = await response.json();
            if (json && !json.error && json.title) {
                data = { title: json.title, description: json.author_name ? json.author_name : "", image: json.thumbnail_url || "", site: json.provider_name || "" };
            }
        } catch { /* пробуем следующий источник */ }

        if (!data) {
            try {
                const response = await fetch("https://api.microlink.io/?url=" + encodeURIComponent(url));
                const json = await response.json();
                const d = json?.data;
                if (json?.status === "success" && d && (d.title || d.description)) {
                    data = { title: d.title || "", description: d.description || "", image: d.image?.url || "", site: d.publisher || "" };
                }
            } catch { /* сервис недоступен или лимит — просто без карточки */ }
        }

        saveLinkPreview(url, data);
        return data;

    })();

    linkPreviewInflight.set(url, job);
    try { return await job; } finally { linkPreviewInflight.delete(url); }

}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

async function attachLinkPreview(row) {

    if (!linkPreviewsEnabled() || row.classList.contains("system-message")) return;
    const bubble = row.querySelector(".message");
    if (!bubble || bubble.querySelector(".link-preview") || bubble.classList.contains("sticker")) return;

    const link = bubble.querySelector(".message-text a.msg-link");
    if (!link) return;

    const url = link.href;
    if (!/^https?:/i.test(url)) return;

    const data = await fetchLinkPreview(url);
    if (!data || !row.isConnected || bubble.querySelector(".link-preview")) return;

    const card = document.createElement("a");
    card.className = "link-preview";
    card.href = url;
    card.target = "_blank";
    card.rel = "noopener noreferrer";
    card.innerHTML = `
        ${data.image ? `<span class="link-preview-image" style="background-image:${escapeHTML(cssUrlValue(data.image))}"></span>` : ""}
        <span class="link-preview-site">${escapeHTML(data.site || hostOf(url))}</span>
        ${data.title ? `<span class="link-preview-title">${escapeHTML(data.title)}</span>` : ""}
        ${data.description ? `<span class="link-preview-desc">${escapeHTML(data.description)}</span>` : ""}`;

    const text = bubble.querySelector(".message-text");
    // Карточка добавляет высоту: если человек был внизу ленты, он там и остаётся
    // (раньше последнее сообщение «уезжало» под поле ввода).
    const list = document.getElementById("messages");
    const stick = list && list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    text.insertAdjacentElement("afterend", card);
    if (stick) list.scrollTop = list.scrollHeight;

}

(function watchMessagesForLinks() {

    const container = document.getElementById("messages");
    if (!container) return;

    const scan = (node) => {
        if (node.nodeType !== 1) return;
        const row = node.classList?.contains("message-row") ? node : node.closest?.(".message-row");
        if (row) attachLinkPreview(row);
        node.querySelectorAll?.(".message-row").forEach(attachLinkPreview);
    };

    new MutationObserver((mutations) => mutations.forEach((m) => m.addedNodes.forEach(scan))).observe(container, { childList: true, subtree: true });

})();

/* ============================================================================
   3. ПОИСК ПО ВСЕМ ЧАТАМ. Сообщения ищутся на сервере (RLS отдаёт только мои
   чаты); секретные чаты пропускаем — там в базе шифротекст.
   ========================================================================= */

function highlightSnippet(text, query) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    const index = clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    const start = Math.max(0, index - 28);
    const slice = clean.slice(start, start + 110);
    const prefix = start > 0 ? "…" : "";
    const rel = index - start;
    if (index < 0) return escapeHTML(prefix + slice);
    return escapeHTML(prefix + slice.slice(0, rel)) + "<mark>" + escapeHTML(slice.slice(rel, rel + query.length)) + "</mark>" + escapeHTML(slice.slice(rel + query.length));
}

function chatDisplayName(chatId) {
    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return "Чат";
    if (row.chats?.type === "group") return row.chats.title || "Группа";
    return row.otherUser?.display_name || "Чат";
}

async function searchAllMessages(query) {
    const results = await KabanAPI.searchMessages(query, 25);
    const secretIds = new Set(cachedChatRows.filter((r) => r.chats?.is_secret).map((r) => r.chat_id));
    return results.filter((m) => !secretIds.has(m.chat_id));
}

// Найти сообщение в любом чате: открыть чат, при необходимости догрузить историю.
async function jumpToMessage(chatId, messageId) {

    try {
        if (currentChatId !== chatId) await openRealChat(chatId);
    } catch (error) {
        toast("Не удалось открыть чат");
        return;
    }

    const findRow = () => document.querySelector(`.message-row[data-message-id="${messageId}"]`);

    let pages = 0;
    while (!findRow() && hasMoreMessages && currentChatId === chatId && pages < 40) {
        const before = oldestLoadedMessageCreatedAt;
        await loadOlderMessages();
        pages++;
        if (oldestLoadedMessageCreatedAt === before) break;
    }

    if (findRow()) flashMessage(messageId);
    else toast("Сообщение уже недоступно в истории");

}

// Блок «Сообщения» под результатами поиска в сайдбаре.
async function appendMessageSearchResults(query, token) {

    if (query.length < 2) return;

    let messages;
    try { messages = await searchAllMessages(query); } catch { return; }
    if (token !== unifiedSearchToken) return;

    const resultsEl = document.getElementById("unified-search-results");
    if (!resultsEl || resultsEl.hidden || !messages.length) return;

    document.getElementById("unified-search-empty")?.remove();

    const html = messages.map((m) => `
        <button type="button" class="msg-hit" data-chat="${escapeHTML(m.chat_id)}" data-message="${escapeHTML(m.id)}" onclick="jumpToMessage(this.dataset.chat, this.dataset.message)">
            <span class="msg-hit-head"><span class="msg-hit-chat">${escapeHTML(chatDisplayName(m.chat_id))}</span><span class="msg-hit-date">${escapeHTML(new Date(m.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }))}</span></span>
            <span class="msg-hit-text">${highlightSnippet(m.text, query)}</span>
        </button>`).join("");

    resultsEl.insertAdjacentHTML("beforeend", `<div class="section-label">Сообщения</div>${html}`);

}

/* ============================================================================
   4. КОМАНДНАЯ ПАЛИТРА (Ctrl/Cmd+K). Чаты по имени и @логину, команды (с
   синонимами), сообщения со всех чатов. Порядок: точное начало слова выше
   «содержит»; без запроса — недавние чаты и основные команды.
   ========================================================================= */

let paletteSearchToken = 0;
let paletteSearchTimer = null;

function getCommandPaletteItems() {

    const items = [];
    const configured = typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED;
    const inChat = !!currentChatId;
    const close = () => closeCommandPalette();

    if (configured) {
        cachedChatRows.forEach((row) => {
            const isGroup = row.chats?.type === "group";
            const name = isGroup ? (row.chats.title || "Группа") : (row.otherUser?.display_name || "Чат");
            const username = isGroup ? "" : (row.otherUser?.username || "");
            items.push({
                kind: "chat", icon: isGroup ? "users" : "chat", label: name, keywords: username,
                hint: isGroup ? "Группа" : (username ? "@" + username : "Чат"),
                run: () => { close(); openRealChat(row.chat_id); }
            });
        });
    }

    const commands = [
        { icon: "search", label: "Найти собеседника", keywords: "новый чат написать", hint: "Чат", run: () => { close(); toggleNewChatPopover(); } },
        { icon: "users", label: "Создать группу", keywords: "новая группа", hint: "Группа", run: () => { close(); openNewGroupModal(); } },
        { icon: "user", label: "Мой профиль", keywords: "имя фото статус аватар", run: () => { close(); openProfileScreen(); } },
        { icon: "palette", label: "Оформление и цвета", keywords: "тема акцент пузыри обои цвет", run: () => { close(); openThemeColorPicker(); } },
        { icon: "moon", label: "Переключить светлую/тёмную тему", keywords: "тема ночь день тёмная светлая", run: () => { close(); toggleDark(); } },
        { icon: "gear", label: "Настройки", keywords: "параметры уведомления звук", run: () => { close(); openSettings(); } },
        { icon: "speaker", label: "Голосовые комнаты", keywords: "голос войти общаться дискорд канал", hint: "Группа", run: () => { close(); openVoiceRooms(); } },
        { icon: "gear", label: "Настройки голоса", keywords: "микрофон рация динамики наушники громкость", run: () => { close(); openVoiceSettings(); } },
        { icon: "bell", label: "Напоминания", keywords: "напомнить список", hint: "Список", run: () => { close(); openRemindersList(); } },
        { icon: "signal", label: "Сервер для звонков (TURN)", keywords: "звонки соединение relay", run: () => { close(); openTurnModal(); } },
        { icon: "users", label: "Создать папку чатов", keywords: "папка группировка фильтр", run: () => { close(); openFolderEditor(); } },
        { icon: "story", label: "Добавить историю", keywords: "сторис статус фото", run: () => { close(); if (typeof openStoryCreate === "function") openStoryCreate(); } }
    ];

    if (inChat) {
        commands.unshift(
            { icon: "pin", label: "Закреплённые сообщения чата", keywords: "закрепы pin", hint: "В этом чате", run: () => { close(); openPinnedList(); } },
            { icon: "poll", label: "Создать опрос", keywords: "голосование", hint: "В этом чате", run: () => { close(); openPollModal(); } },
            { icon: "game", label: "Сыграть в игру", keywords: "крестики нолики камень ножницы кубик", hint: "В этом чате", run: () => { close(); openGamesModal(); } },
            { icon: "phone", label: "Позвонить", keywords: "звонок аудио", hint: "В этом чате", run: () => { close(); startCall("audio"); } },
            { icon: "video", label: "Видеозвонок", keywords: "видео камера", hint: "В этом чате", run: () => { close(); startCall("video"); } },
            { icon: "search", label: "Поиск по этому чату", keywords: "найти в чате", hint: "В этом чате", run: () => { close(); if (typeof toggleChatSearch === "function") toggleChatSearch(); } }
        );
    }

    if (configured) commands.push({ icon: "exit", label: "Выйти из аккаунта", keywords: "выход", run: () => { close(); handleSignOut(); } });

    commands.forEach((c) => items.push({ kind: "command", ...c }));
    return items;

}

function paletteScore(item, q) {
    const label = item.label.toLocaleLowerCase();
    const keywords = (item.keywords || "").toLocaleLowerCase();
    if (label === q) return 100;
    if (label.startsWith(q)) return 80;
    if (label.split(/[\s\-—·]+/).some((w) => w.startsWith(q))) return 60;
    if (keywords.split(/\s+/).some((w) => w.startsWith(q))) return 45;
    if (label.includes(q)) return 30;
    if (keywords.includes(q)) return 20;
    return 0;
}

function renderCommandPaletteResults(query) {

    const q = query.trim().toLocaleLowerCase();
    const all = getCommandPaletteItems();

    if (!q) {
        // Недавние чаты (первые 6) и команды — в порядке объявления.
        const chats = all.filter((i) => i.kind === "chat").slice(0, 6);
        commandPaletteItems = [...chats, ...all.filter((i) => i.kind === "command")];
    } else {
        commandPaletteItems = all
            .map((item) => ({ item, score: paletteScore(item, q) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.item);
    }

    commandPaletteSelectedIndex = 0;
    drawPaletteItems();

    clearTimeout(paletteSearchTimer);
    const token = ++paletteSearchToken;
    if (q.length >= 2 && typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED) {
        paletteSearchTimer = setTimeout(async () => {
            let messages;
            try { messages = await searchAllMessages(query.trim()); } catch { return; }
            if (token !== paletteSearchToken || !messages.length) return;
            const extra = messages.slice(0, 8).map((m) => ({
                kind: "message", icon: "msg", label: String(m.text || "").replace(/\s+/g, " ").slice(0, 80),
                hint: chatDisplayName(m.chat_id),
                run: () => { closeCommandPalette(); jumpToMessage(m.chat_id, m.id); }
            }));
            commandPaletteItems = [...commandPaletteItems, ...extra];
            drawPaletteItems();
        }, 260);
    }

}

function drawPaletteItems() {

    const resultsContainer = document.getElementById("command-palette-results");
    if (!commandPaletteItems.length) {
        resultsContainer.innerHTML = `<div class="command-palette-empty">Ничего не найдено</div>`;
        return;
    }

    const titles = { chat: "Чаты", command: "Команды", message: "Сообщения" };
    let lastKind = null;
    resultsContainer.innerHTML = commandPaletteItems.map((item, index) => {
        const heading = item.kind !== lastKind ? `<div class="command-palette-group">${titles[item.kind] || ""}</div>` : "";
        lastKind = item.kind;
        return `${heading}
        <button class="command-palette-item${index === commandPaletteSelectedIndex ? " selected" : ""}" type="button" onclick="runCommandPaletteItem(${index})">
            <span class="command-palette-item-icon pal-icon">${paletteIcon(item.icon)}</span>
            <span class="command-palette-item-label">${escapeHTML(item.label)}</span>
            ${item.hint ? `<span class="command-palette-item-hint">${escapeHTML(item.hint)}</span>` : ""}
        </button>`;
    }).join("");

}


/* ============================================================================
   5. СВОИ ПАПКИ ЧАТОВ. Создаются и наполняются на этом устройстве (localStorage):
   название + выбранные чаты. Вкладки идут после стандартных («Все», «Личные»…),
   у каждой — счётчик непрочитанных чатов; у активной своей папки — карандаш
   для правки. Ничего не меняет на сервере.
   ========================================================================= */

let folderEditorId = null;

function foldersKey() { return "kaban-folders:" + (myRealUserId || "guest"); }

function loadFolders() {
    try {
        const list = JSON.parse(localStorage.getItem(foldersKey()) || "[]");
        return Array.isArray(list) ? list.filter((f) => f && typeof f.id === "string") : [];
    } catch { return []; }
}

function saveFolders(list) {
    try { localStorage.setItem(foldersKey(), JSON.stringify(list)); return true; }
    catch { toast("Не удалось сохранить папку: нет места в браузере"); return false; }
}

function folderChatRows(folderId) {
    const folder = loadFolders().find((f) => f.id === folderId);
    if (!folder) return [];
    const ids = new Set(folder.chatIds || []);
    return cachedChatRows.filter((row) => ids.has(row.chat_id));
}

function renderCustomFolderTabs() {

    const holder = document.getElementById("custom-folder-tabs");
    if (!holder) return;

    const folders = loadFolders();
    if (activeChatFolder.startsWith("f:") && !folders.some((f) => "f:" + f.id === activeChatFolder)) activeChatFolder = "all";

    holder.innerHTML = folders.map((folder) => {
        const key = "f:" + folder.id;
        const active = activeChatFolder === key;
        const unread = folderChatRows(folder.id).filter((row) => (row.unreadCount || 0) > 0 || row.manuallyUnread).length;
        return `<button type="button" class="chat-folder-tab custom${active ? " active" : ""}" data-folder="${escapeHTML(key)}" onclick="switchChatFolder(this.dataset.folder)" oncontextmenu="event.preventDefault(); openFolderEditor('${escapeHTML(folder.id)}')">
            ${escapeHTML(folder.name)}${unread ? `<span class="folder-badge">${unread}</span>` : ""}${active ? `<span class="folder-edit" role="button" aria-label="Изменить папку" onclick="event.stopPropagation(); openFolderEditor('${escapeHTML(folder.id)}')">✎</span>` : ""}
        </button>`;
    }).join("");

    // Стандартные вкладки: активность могла смениться вместе с папкой.
    document.querySelectorAll("#chat-folders > .chat-folder-tab[data-folder]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.folder === activeChatFolder);
    });

}

function openFolderEditor(folderId) {

    folderEditorId = folderId || null;
    const folder = folderId ? loadFolders().find((f) => f.id === folderId) : null;
    const selected = new Set(folder?.chatIds || []);

    document.getElementById("folder-editor-title").textContent = folder ? "Изменить папку" : "Новая папка";
    document.getElementById("folder-name-input").value = folder?.name || "";
    document.getElementById("folder-delete-btn").hidden = !folder;

    document.getElementById("folder-chats-list").innerHTML = cachedChatRows.map((row) => {
        const isGroup = row.chats?.type === "group";
        const name = isGroup ? (row.chats.title || "Группа") : (row.otherUser?.display_name || "Чат");
        return `
        <label class="folder-chat-row">
            <input type="checkbox" class="folder-chat-check" value="${escapeHTML(row.chat_id)}"${selected.has(row.chat_id) ? " checked" : ""}>
            <span class="folder-chat-box" aria-hidden="true"></span>
            <span class="folder-chat-name">${escapeHTML(name)}</span>
            <span class="folder-chat-kind">${isGroup ? "Группа" : "Личный"}</span>
        </label>`;
    }).join("") || '<div class="group-perms-hint">Чатов пока нет.</div>';

    const backdrop = document.getElementById("folder-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("folder-name-input").focus();

}

function closeFolderEditor() {
    const backdrop = document.getElementById("folder-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function saveFolderFromEditor() {

    const name = document.getElementById("folder-name-input").value.trim();
    if (!name) { toast("Назовите папку"); return; }

    const chatIds = [...document.querySelectorAll(".folder-chat-check:checked")].map((input) => input.value);
    const folders = loadFolders();

    if (folderEditorId) {
        const folder = folders.find((f) => f.id === folderEditorId);
        if (folder) { folder.name = name; folder.chatIds = chatIds; }
    } else {
        if (folders.length >= 12) { toast("Можно создать не больше 12 папок"); return; }
        const id = "f" + Date.now().toString(36);
        folders.push({ id, name, chatIds });
        activeChatFolder = "f:" + id;
    }

    if (!saveFolders(folders)) return;
    isShowingArchivedChats = false;
    closeFolderEditor();
    renderChatListFromCache();

}

function deleteFolderFromEditor() {
    if (!folderEditorId) return;
    if (!confirm("Удалить папку? Сами чаты останутся на месте.")) return;
    saveFolders(loadFolders().filter((f) => f.id !== folderEditorId));
    if (activeChatFolder === "f:" + folderEditorId) activeChatFolder = "all";
    closeFolderEditor();
    renderChatListFromCache();
}