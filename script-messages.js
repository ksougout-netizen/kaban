/* ============================================================================
   Этот файл — одна из частей script.js, разбитого на несколько файлов для
   удобства навигации (раньше был единый файл ~350КБ/8300+ строк). Порядок
   подключения в index.html ВАЖЕН и должен точно совпадать с исходным
   порядком кода — файлы выполняются последовательно, как один конкатенированный
   скрипт, функции между ними не изолированы (нет import/export, всё в общей
   глобальной области видимости, как и раньше).
   ============================================================================ */
/* ============================================================================
   КОМАНДНАЯ ПАЛИТРА (Ctrl/Cmd+K): быстрый переход к чату и командам
   приложения одной строкой — не меняет визуальный стиль, только сокращает
   путь к тем же самым действиям, что уже есть в интерфейсе.
   ========================================================================= */

let commandPaletteItems = [];
let commandPaletteSelectedIndex = 0;

function openCommandPalette() {

    const backdrop = document.getElementById("command-palette-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    const input = document.getElementById("command-palette-input");
    input.value = "";
    renderCommandPaletteResults("");
    input.focus();

}

function closeCommandPalette() {
    const backdrop = document.getElementById("command-palette-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function toggleCommandPalette() {
    const backdrop = document.getElementById("command-palette-backdrop");
    if (backdrop.classList.contains("open")) {
        closeCommandPalette();
    } else {
        openCommandPalette();
    }
}

// Команды палитры собираются заново при каждом открытии — список чатов
// и статус входа могли поменяться с прошлого раза.
function getCommandPaletteItems() {

    const items = [];
    const configured = typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED;

    if (configured && typeof cachedChatRows !== "undefined") {
        cachedChatRows.forEach((row) => {
            items.push({
                icon: "💬",
                label: row.otherUser?.display_name || row.chats.title || "Чат",
                hint: "Чат",
                run: () => { closeCommandPalette(); openRealChat(row.chat_id); }
            });
        });
    }

    const demoSection = document.getElementById("demo-chat-section");
    if (demoSection && !demoSection.hidden) {
        items.push({
            icon: "💬",
            label: document.querySelector('.chat[onclick="openChat()"] .chat-name')?.textContent.trim() || "Чат",
            hint: "Демо-чат",
            run: () => { closeCommandPalette(); openChat(); }
        });
    }

    items.push(
        { icon: "🔎", label: "Найти собеседника", hint: "Новый чат", run: () => { closeCommandPalette(); toggleNewChatPopover(); } },
        { icon: "🌗", label: "Переключить тему", hint: "Оформление", run: () => { closeCommandPalette(); toggleDark(); } },
        { icon: "⚙️", label: "Настройки", run: () => { closeCommandPalette(); openSettings(); } }
    );

    if (configured) {
        items.push({ icon: "🚪", label: "Выйти из аккаунта", run: () => { closeCommandPalette(); handleSignOut(); } });
    }

    return items;

}

function renderCommandPaletteResults(query) {

    const resultsContainer = document.getElementById("command-palette-results");
    const q = query.trim().toLocaleLowerCase();
    const allItems = getCommandPaletteItems();

    commandPaletteItems = q ? allItems.filter((item) => item.label.toLocaleLowerCase().includes(q)) : allItems;
    commandPaletteSelectedIndex = 0;

    resultsContainer.innerHTML = commandPaletteItems.length ? commandPaletteItems.map((item, index) => `
        <button class="command-palette-item${index === 0 ? " selected" : ""}" type="button" onclick="runCommandPaletteItem(${index})">
            <span class="command-palette-item-icon">${item.icon}</span>
            <span class="command-palette-item-label">${escapeHTML(item.label)}</span>
            ${item.hint ? `<span class="command-palette-item-hint">${escapeHTML(item.hint)}</span>` : ""}
        </button>
    `).join("") : `<div class="command-palette-empty">Ничего не найдено</div>`;

}

function runCommandPaletteItem(index) {
    const item = commandPaletteItems[index];
    if (item) item.run();
}

function moveCommandPaletteSelection(delta) {

    if (!commandPaletteItems.length) return;

    commandPaletteSelectedIndex = (commandPaletteSelectedIndex + delta + commandPaletteItems.length) % commandPaletteItems.length;

    document.querySelectorAll(".command-palette-item").forEach((el, index) => {
        el.classList.toggle("selected", index === commandPaletteSelectedIndex);
    });

    document.querySelector(".command-palette-item.selected")?.scrollIntoView({ block: "nearest" });

}

document.addEventListener("keydown", (event) => {

    // event.code, а не event.key: на русской раскладке Ctrl+K приходит как «л»,
    // и палитра у русскоязычных пользователей не открывалась вовсе.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.code === "KeyK" || event.key.toLocaleLowerCase() === "k")) {
        event.preventDefault();
        toggleCommandPalette();
        return;
    }

    if (!document.getElementById("command-palette-backdrop").classList.contains("open")) return;

    if (event.key === "ArrowDown") {
        event.preventDefault();
        moveCommandPaletteSelection(1);
    } else if (event.key === "ArrowUp") {
        event.preventDefault();
        moveCommandPaletteSelection(-1);
    } else if (event.key === "Enter") {
        event.preventDefault();
        runCommandPaletteItem(commandPaletteSelectedIndex);
    }

});


/* ============================================================================
   КОНТЕКСТНОЕ МЕНЮ СООБЩЕНИЯ (правый клик) и ДВОЙНОЙ КЛИК — БЫСТРАЯ РЕАКЦИЯ:
   те же действия, что уже доступны через hover-панель, вторым, более
   привычным для десктопа/мыши путём. Ничего нового не хранится — вызывают
   те же react()/reply(), что и обычная панель инструментов сообщения.
   ========================================================================= */

let contextMenuTargetRow = null;
let lastContextMenuX = 0;
let lastContextMenuY = 0;

document.getElementById("messages").addEventListener("contextmenu", (event) => {

    const row = event.target.closest(".message-row");
    if (!row) return;

    // Служебная плашка группы («… добавил(а) …») — не сообщение: реагировать,
    // пересылать, закреплять её нечего (раньше меню открывалось и реакция ломала строку).
    if (row.classList.contains("system-message")) { event.preventDefault(); return; }

    event.preventDefault();
    contextMenuTargetRow = row;
    lastContextMenuX = event.clientX;
    lastContextMenuY = event.clientY;

    renderContextReactRow();

    const menu = document.getElementById("message-context-menu");
    menu.hidden = false;

    // Изменить можно только своё настоящее (не демо) сообщение, ещё не
    // удалённое; удалить, закрепить, переслать, выбрать — любое настоящее
    // сообщение ("удалить у меня" работает и с чужими, см. delete_message_for_me).
    const isReal = !!currentChatId && !!row.dataset.messageId;
    const isMine = row.classList.contains("sent");
    const isDeleted = row.classList.contains("deleted");

    // В секретных чатах не даём редактировать (правка потребовала бы
    // заново шифровать новым звеном цепочки задним числом — не укладывается
    // в forward-secrecy модель) и не даём пересылать (иначе расшифрованный
    // на этом устройстве текст утёк бы в обычный, несекретный чат — ровно
    // так же это запрещено и в настоящем Telegram).
    const isPoll = !!(realMessagesById.get(row.dataset.messageId)?.attachment_meta?.poll || realMessagesById.get(row.dataset.messageId)?.attachment_meta?.game);
    document.getElementById("ctx-edit").hidden = !(isReal && isMine && !isDeleted) || currentChatIsSecret || isPoll;
    document.getElementById("ctx-delete").hidden = !(isReal && !isDeleted);
    document.getElementById("ctx-forward").hidden = !(isReal && !isDeleted) || currentChatIsSecret;
    document.getElementById("ctx-select").hidden = !(isReal && !isDeleted);
    document.getElementById("ctx-save").hidden = isDeleted || currentChatIsSecret;
    const savedMessage = isReal && !currentChatIsSecret
        ? getSavedMessages().some((item) => item.chatId === currentChatId && item.messageId === row.dataset.messageId)
        : false;
    document.getElementById("ctx-save-label").textContent = savedMessage ? "Убрать из закладок" : "В закладки";

    const remindBtn = document.getElementById("ctx-remind");
    if (remindBtn) remindBtn.hidden = !(isReal && !isDeleted);

    const pinBtn = document.getElementById("ctx-pin");
    pinBtn.hidden = !(isReal && !isDeleted);
    if (isReal && !isDeleted) {
        const pinned = !!realMessagesById.get(row.dataset.messageId)?.pinned_for?.includes(myRealUserId);
        document.getElementById("ctx-pin-label").textContent = pinned ? "Открепить" : "Закрепить";
    }

    // Реальные размеры меню (набор пунктов зависит от сообщения — высота
    // не постоянна), а не угаданные: иначе у нижнего края окна меню
    // вылезало за экран и до "Удалить" нельзя было добраться.
    const menuWidth = menu.offsetWidth || 200;
    const menuHeight = menu.offsetHeight || 340;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

});

document.addEventListener("click", (event) => {
    if (!event.target.closest("#message-context-menu")) {
        document.getElementById("message-context-menu").hidden = true;
    }
    if (!event.target.closest("#reaction-picker-popover")) {
        closeReactionPickerPopover();
    }
});

function contextMenuReply() {
    if (contextMenuTargetRow) reply(contextMenuTargetRow);
    document.getElementById("message-context-menu").hidden = true;
}

function contextMenuCopy() {

    if (contextMenuTargetRow) {
        // Для настоящего текстового сообщения копируем исходный текст (с переносами
        // строк и разметкой), а не то, что видно в пузыре: раньше в буфер попадали
        // имя автора в группе, текст карточки ссылки и подписи «изменено».
        const original = realMessagesById.get(contextMenuTargetRow.dataset.messageId);
        let text;
        if (original?.type === "text" && typeof original.text === "string" && !original.attachment_meta?.poll && !original.attachment_meta?.game) {
            text = original.text;
        } else {
            const clone = contextMenuTargetRow.querySelector(".message").cloneNode(true);
            clone.querySelectorAll(".message-time, .message-reply-quote, .message-sender-name, .link-preview, .effect-replay, .message-edited-tag").forEach((el) => el.remove());
            text = clone.textContent.trim();
        }

        navigator.clipboard?.writeText(text)
            .then(() => toast("Текст скопирован"))
            .catch(() => toast("Не удалось скопировать"));
    }

    document.getElementById("message-context-menu").hidden = true;

}

const SAVED_MESSAGES_STORAGE_PREFIX = "kaban-saved-messages:";

function savedMessagesStorageKey() {
    return SAVED_MESSAGES_STORAGE_PREFIX + (myRealUserId || "guest");
}

function getSavedMessages() {
    try {
        const saved = JSON.parse(localStorage.getItem(savedMessagesStorageKey()) || "[]");
        return Array.isArray(saved) ? saved : [];
    } catch {
        return [];
    }
}

function persistSavedMessages(saved) {
    try {
        localStorage.setItem(savedMessagesStorageKey(), JSON.stringify(saved));
        return true;
    } catch {
        toast("Не удалось сохранить: недостаточно места в браузере");
        return false;
    }
}

function contextMenuToggleSaved() {

    const row = contextMenuTargetRow;
    if (!row || currentChatIsSecret || row.classList.contains("deleted")) return;

    const messageId = row.dataset.messageId || "";
    const chatId = currentChatId || "";
    const sourceKey = messageId || (row.dataset.savedKey ||= `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const saved = getSavedMessages();
    const existingIndex = saved.findIndex((item) => item.chatId === chatId && item.sourceKey === sourceKey);

    if (existingIndex >= 0) {
        saved.splice(existingIndex, 1);
        if (persistSavedMessages(saved)) toast("Удалено из закладок");
    } else {
        const message = messageId ? realMessagesById.get(messageId) : null;
        const content = row.querySelector(".message")?.cloneNode(true);
        content?.querySelectorAll(".message-time, .message-reply-quote, .message-sender-name").forEach((el) => el.remove());
        const chatName = currentChatTitle || document.querySelector(".person-name")?.textContent.trim() || "Чат";
        const text = (content?.textContent || "").replace(/\s+/g, " ").trim();
        saved.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            sourceKey,
            chatId,
            messageId,
            chatName,
            sender: row.classList.contains("sent")
                ? "Вы"
                : currentChatType === "group"
                    ? currentChatMembersById.get(message?.sender_id)?.display_name || "Участник"
                    : "",
            text: text || (message?.type === "voice" ? "Голосовое сообщение" : "Вложение"),
            savedAt: new Date().toISOString()
        });
        if (persistSavedMessages(saved)) toast("Добавлено в закладки");
    }

    document.getElementById("message-context-menu").hidden = true;
}

function openSavedMessages() {
    document.getElementById("saved-messages-search").value = "";
    renderSavedMessages();
    const backdrop = document.getElementById("saved-messages-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeSavedMessages() {
    const backdrop = document.getElementById("saved-messages-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeSavedMessagesFromBackdrop(event) {
    if (event.target === event.currentTarget) closeSavedMessages();
}

function renderSavedMessages() {

    const list = document.getElementById("saved-messages-list");
    const query = document.getElementById("saved-messages-search").value.trim().toLocaleLowerCase();
    const saved = getSavedMessages()
        .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""))
        .filter((item) => !query || `${item.chatName} ${item.sender} ${item.text}`.toLocaleLowerCase().includes(query));

    if (!saved.length) {
        list.innerHTML = `<div class="shared-empty visible">${query ? "Ничего не найдено" : "Здесь будут сообщения, которые вы добавите в закладки"}</div>`;
        return;
    }

    list.innerHTML = saved.map((item) => {
        const savedAt = item.savedAt
            ? new Date(item.savedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
            : "";
        const metadata = [item.sender, savedAt].filter(Boolean).join(" · ");
        return `
            <div class="saved-message-entry" role="listitem">
                <button class="shared-row saved-message-open" type="button" onclick="openSavedMessage('${escapeHTML(item.id)}')">
                    <span class="shared-row-icon">☆</span>
                    <span class="shared-row-copy">
                        <span class="shared-row-name">${escapeHTML(item.chatName || "Чат")}</span>
                        <span class="shared-row-meta">${escapeHTML(metadata)}</span>
                        <span class="saved-message-preview">${escapeHTML(item.text || "Сообщение")}</span>
                    </span>
                </button>
                <button class="saved-message-remove" type="button" onclick="removeSavedMessage('${escapeHTML(item.id)}')" aria-label="Удалить из закладок">×</button>
            </div>
        `;
    }).join("");

}

function removeSavedMessage(id) {
    const saved = getSavedMessages().filter((item) => item.id !== id);
    if (persistSavedMessages(saved)) {
        renderSavedMessages();
        toast("Удалено из закладок");
    }
}

async function openSavedMessage(id) {

    const item = getSavedMessages().find((saved) => saved.id === id);
    if (!item) return;

    closeSavedMessages();
    if (!item.chatId) {
        openChat();
        return;
    }

    try {
        await openRealChat(item.chatId);
    } catch (error) {
        // Панель закладок уже закрыта выше — без этого при сбое открытия чата
        // человек оставался бы на экране под ней без единого сообщения о том,
        // что что-то пошло не так (необработанный rejection).
        console.warn("Не удалось открыть чат из закладки", error);
        toast("Не удалось открыть чат");
        return;
    }
    if (item.messageId) flashMessage(item.messageId);

}

function contextMenuReact(emoji) {
    if (contextMenuTargetRow) react(contextMenuTargetRow, emoji);
    pushRecentReaction(emoji);
    document.getElementById("message-context-menu").hidden = true;
}

/* ============================================================================
   ЛЕНТА РЕАКЦИЙ В КОНТЕКСТНОМ МЕНЮ + ПОЛНЫЙ ПИКЕР ("+"): прокручиваемый
   ряд часто используемых эмодзи, последним — кнопка "+", открывающая
   окошко с поиском и всеми категориями (тот же набор, что и в панели
   эмодзи композера, см. EMOJI_CATEGORIES выше).
   ========================================================================= */

const CONTEXT_REACT_EMOJIS = [
    "👍","🔥","❤️","😂","🤣","😮","😢","🎉","👏","🙏",
    "💯","😎","🤔","🤩","😍","🥳","🤝","💪","👀","💔"
];

const RECENT_REACTIONS_KEY = "kaban-recent-reactions";

// «Недавние» чистим от мусора: пустые записи (например, невидимый соединитель,
// попавший туда, когда в панели была пустая клетка) рисовались бы пустым местом.
function getRecentReactions() {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_REACTIONS_KEY) || "[]");
        const clean = (Array.isArray(raw) ? raw : []).filter((e, i, list) =>
            typeof e === "string" && /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[0-9#*]\uFE0F?\u20E3/u.test(e) && list.indexOf(e) === i);
        if (clean.length !== (Array.isArray(raw) ? raw.length : 0)) localStorage.setItem(RECENT_REACTIONS_KEY, JSON.stringify(clean));
        return clean;
    } catch (error) {
        return [];
    }
}

function pushRecentReaction(emoji) {
    try {
        const recent = [emoji, ...getRecentReactions().filter((e) => e !== emoji)].slice(0, 16);
        localStorage.setItem(RECENT_REACTIONS_KEY, JSON.stringify(recent));
    } catch (error) {
        console.warn("Не удалось сохранить недавние реакции", error);
    }
}

let contextReactRowRendered = false;

function renderContextReactRow() {
    contextReactRowRendered = true;
    const row = document.getElementById("context-menu-react-row");
    row.innerHTML = CONTEXT_REACT_EMOJIS.map((e) => `
        <button type="button" onclick="contextMenuReact('${e}')" aria-label="Реакция ${e}">${e}</button>
    `).join("");
}

// Обычное колесо мыши по умолчанию крутит только вертикально — этот
// список horizontal-only, поэтому переводим вертикальный delta в
// горизонтальный скролл, чтобы крутить можно было не только
// шифт+колесо/жестом трекпада.
document.getElementById("context-menu-react-row").addEventListener("wheel", (event) => {
    if (event.deltaY === 0) return;
    event.currentTarget.scrollLeft += event.deltaY;
    event.preventDefault();
}, { passive: false });

let reactionPickerRendered = false;

function openReactionPickerPopover(event) {

    event.stopPropagation();
    document.getElementById("message-context-menu").hidden = true;

    if (!reactionPickerRendered) renderReactionPicker();
    document.getElementById("reaction-picker-search").value = "";
    filterReactionPicker();

    const popover = document.getElementById("reaction-picker-popover");
    const width = 300, height = 340;
    const x = Math.min(lastContextMenuX, window.innerWidth - width - 8);
    const y = Math.min(lastContextMenuY, window.innerHeight - height - 8);
    popover.style.left = `${Math.max(8, x)}px`;
    popover.style.top = `${Math.max(8, y)}px`;

    popover.classList.add("open");
    popover.setAttribute("aria-hidden", "false");

}

function closeReactionPickerPopover() {
    const popover = document.getElementById("reaction-picker-popover");
    popover.classList.remove("open");
    popover.setAttribute("aria-hidden", "true");
}

function renderReactionPicker() {

    reactionPickerRendered = true;

    const cats = document.getElementById("reaction-picker-cats");
    cats.innerHTML = EMOJI_CATEGORIES.map((cat, index) => `
        <button type="button" class="emoji-popover-cat-btn${index === 0 ? " active" : ""}" data-cat="${cat.id}" title="${cat.label}" onclick="jumpToReactionCategory('${cat.id}')">${cat.icon}</button>
    `).join("");

    const recent = getRecentReactions();
    const recentHTML = recent.length ? `
        <div class="emoji-section" id="reaction-section-recent">
            <div class="emoji-section-label">Часто используемые</div>
            <div class="emoji-grid">
                ${recent.map((e) => `<button type="button" onclick="pickReactionFromPicker('${e}')">${e}</button>`).join("")}
            </div>
        </div>
    ` : "";

    const body = document.getElementById("reaction-picker-body");
    body.innerHTML = recentHTML + EMOJI_CATEGORIES.map((cat) => `
        <div class="emoji-section" id="reaction-section-${cat.id}">
            <div class="emoji-section-label">${cat.label}</div>
            <div class="emoji-grid">
                ${cat.emojis.map((e) => `<button type="button" onclick="pickReactionFromPicker('${e}')">${e}</button>`).join("")}
            </div>
        </div>
    `).join("");

}

function jumpToReactionCategory(catId) {
    document.getElementById(`reaction-section-${catId}`)?.scrollIntoView({ block: "start" });
}

function pickReactionFromPicker(emoji) {
    if (contextMenuTargetRow) react(contextMenuTargetRow, emoji);
    pushRecentReaction(emoji);
    reactionPickerRendered = false; // пересоберётся при следующем открытии — обновится "часто используемые"
    closeReactionPickerPopover();
}

function filterReactionPicker() {
    const query = document.getElementById("reaction-picker-search").value.trim().toLowerCase();
    document.querySelectorAll("#reaction-picker-body .emoji-section").forEach((section) => {
        const label = section.querySelector(".emoji-section-label")?.textContent.toLowerCase() || "";
        section.hidden = query.length > 0 && !label.includes(query);
    });
}

function contextMenuEdit() {
    if (contextMenuTargetRow) startEditMessage(contextMenuTargetRow);
    document.getElementById("message-context-menu").hidden = true;
}

function contextMenuDelete() {
    const messageId = contextMenuTargetRow?.dataset.messageId;
    if (messageId) openDeleteChoiceModal(messageId);
    document.getElementById("message-context-menu").hidden = true;
}

function contextMenuForward() {
    const messageId = contextMenuTargetRow?.dataset.messageId;
    if (messageId) openForwardPopover(messageId);
    document.getElementById("message-context-menu").hidden = true;
}

/* ============================================================================
   РЕДАКТИРОВАНИЕ / УДАЛЕНИЕ / ПЕРЕСЫЛКА настоящих сообщений — те же
   действия, что в Telegram, поверх обычной панели инструментов сообщения.
   ========================================================================= */

// Фото/видео/аудио/файл — те же CSS-классы, что и у демо-вложений
// (.message-image/.message-audio/.message-file*), просто с настоящим
// attachment_url вместо blob: URL выбранного файла.
function buildAttachmentHTML(message) {

    const url = message.attachment_url;
    const meta = message.attachment_meta || {};

    // P2P-передача большого файла — у нас НИКОГДА нет attachment_url (байты
    // идут напрямую между браузерами, Storage не участвует), поэтому этот
    // случай должен сработать раньше общего "if (!url) return" ниже.
    if (meta.p2p) return buildP2PFileHTML(message);

    // location/contact хранят данные только в attachment_meta, без файла в
    // Storage — те же CSS-классы (.message-location*/.message-contact*),
    // что и у демо-версии этих карточек.
    if (message.type === "location") {
        const lat = Number(meta.lat);
        const lon = Number(meta.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "📍 Геопозиция";
        return `
            <button type="button" class="message-location" onclick="window.open('https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}', '_blank', 'noopener')">
                <span class="message-location-icon">📍</span>
                <div class="message-location-copy">
                    <div class="message-location-title">Геопозиция</div>
                    <div class="message-location-hint">${lat.toFixed(5)}, ${lon.toFixed(5)}</div>
                </div>
            </button>
        `;
    }

    if (message.type === "contact") {
        const name = escapeHTML(meta.display_name || "Контакт");
        const userId = escapeHTML(meta.user_id || "");
        return `
            <button type="button" class="message-contact" onclick="openContactFromMessage('${userId}')">
                <span class="message-contact-icon">👤</span>
                <div class="message-contact-copy">
                    <div class="message-contact-title">${name}</div>
                    <div class="message-contact-hint">Контакт</div>
                </div>
            </button>
        `;
    }

    if (!url) return "📎 Вложение";

    if (message.type === "image") {
        return `<img class="message-image" src="${escapeHTML(url)}" alt="${escapeHTML(meta.name || "Фото")}" loading="lazy" onclick="openImageGallery(this)">`;
    }

    if (message.type === "video") {
        return `<video class="message-image" src="${escapeHTML(url)}" controls playsinline preload="metadata"></video>`;
    }

    // Видео-кружок — свой плеер 1:1 по принципу настоящего Telegram: тап по
    // кругу вместо нативных browser-controls, тонкое кольцо прогресса по
    // краю, бейдж скорости. meta.duration — миллисекунды (см. sendRealRecording
    // в script-chats.js), используется как текст ДО того, как <video> сам
    // вычислит duration.
    if (message.type === "video_note") {
        return `
            <div class="video-circle" onclick="toggleVideoCircle(this)">
                <video
                    class="video-circle-video"
                    src="${escapeHTML(url)}"
                    playsinline
                    preload="metadata"
                    data-duration-ms="${Number(meta.duration) || 0}"
                    onplay="onVideoCirclePlayStateChange(this)"
                    onpause="onVideoCirclePlayStateChange(this)"
                    onended="onVideoCircleEnded(this)"
                    ontimeupdate="onVideoCircleTimeUpdate(this)"
                    onloadedmetadata="onVideoCircleTimeUpdate(this)"
                ></video>
                <svg class="video-circle-ring" viewBox="0 0 100 100" aria-hidden="true">
                    <circle class="video-circle-ring-track" cx="50" cy="50" r="47"></circle>
                    <circle class="video-circle-ring-progress" cx="50" cy="50" r="47"></circle>
                </svg>
                <span class="video-circle-play-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M8 5.14v13.72c0 .9.98 1.45 1.76.99l10.85-6.86a1.15 1.15 0 0 0 0-1.98L9.76 4.15C8.98 3.69 8 4.24 8 5.14Z"/></svg>
                </span>
                <button type="button" class="video-circle-speed" onclick="event.stopPropagation(); cycleVideoCircleSpeed(this)">1x</button>
            </div>
        `;
    }

    // Голосовое — свой проигрыватель (плей/пауза, перемотка по полоске,
    // переключатель скорости 1x/1.5x/2x/0.75x), а не голый нативный <audio
    // controls>: тот не умеет менять скорость из видимого UI и визуально не
    // похож на остальной интерфейс. meta.duration — миллисекунды (см.
    // sendRealRecording/recorder "stop" в script-core.js), используется как
    // текст ДО того, как <audio> успеет сам вычислить duration.
    if (message.type === "voice") {

        const initialTime = formatRecordingTime(Number(meta.duration) || 0);

        // Звуковая волна — считается один раз при записи (см. computeWaveformPeaks
        // в script-chats.js) и приходит готовым массивом в meta.waveform. Старые
        // голосовые (отправленные до этой фичи) или те, где decodeAudioData не
        // осилил формат — без него, тогда рисуется обычная плоская полоска.
        const waveform = Array.isArray(meta.waveform) && meta.waveform.length ? meta.waveform : null;
        const progressHTML = waveform
            ? `
                <div class="voice-waveform" onpointerdown="startVoiceMessageSeek(event, this)">
                    <div class="voice-waveform-bars voice-waveform-bars-base">${waveform.map((p) => `<span style="height:${Math.round(p * 100)}%"></span>`).join("")}</div>
                    <div class="voice-waveform-bars voice-waveform-bars-progress" style="clip-path:inset(0 100% 0 0)">${waveform.map((p) => `<span style="height:${Math.round(p * 100)}%"></span>`).join("")}</div>
                </div>
            `
            : `
                <div class="voice-message-progress" onpointerdown="startVoiceMessageSeek(event, this)">
                    <div class="voice-message-progress-fill"></div>
                </div>
            `;

        return `
            <div class="voice-message">
                <audio
                    class="voice-message-audio"
                    src="${escapeHTML(url)}"
                    preload="metadata"
                    data-duration-ms="${Number(meta.duration) || 0}"
                    onplay="onVoiceMessagePlayStateChange(this)"
                    onpause="onVoiceMessagePlayStateChange(this)"
                    onended="onVoiceMessageEnded(this)"
                    ontimeupdate="onVoiceMessageTimeUpdate(this)"
                    onloadedmetadata="onVoiceMessageTimeUpdate(this)"
                ></audio>
                <button type="button" class="voice-message-play" onclick="toggleVoiceMessage(this)" aria-label="Воспроизвести голосовое сообщение">
                    <svg class="vm-icon-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72c0 .9.98 1.45 1.76.99l10.85-6.86a1.15 1.15 0 0 0 0-1.98L9.76 4.15C8.98 3.69 8 4.24 8 5.14Z"/></svg>
                    <svg class="vm-icon-pause" viewBox="0 0 24 24" aria-hidden="true" hidden><path d="M7.5 5A1.5 1.5 0 0 0 6 6.5v11a1.5 1.5 0 0 0 3 0v-11A1.5 1.5 0 0 0 7.5 5Zm9 0A1.5 1.5 0 0 0 15 6.5v11a1.5 1.5 0 0 0 3 0v-11A1.5 1.5 0 0 0 16.5 5Z"/></svg>
                </button>
                <div class="voice-message-body">
                    ${progressHTML}
                    <div class="voice-message-time">${initialTime}</div>
                </div>
                <button type="button" class="voice-message-speed" onclick="cycleVoiceMessageSpeed(this)" aria-label="Скорость воспроизведения">1x</button>
                <button type="button" class="voice-message-transcribe" onclick="transcribeVoiceMessage(this)" aria-label="Расшифровать в текст" title="Расшифровать в текст">Aa</button>
            </div>
        `;
    }

    if (message.type === "audio") {
        return `
            <audio class="message-audio" src="${escapeHTML(url)}" controls preload="metadata"></audio>
            <div class="message-file-name">${escapeHTML(meta.name || "Аудио")}</div>
        `;
    }

    return `
        <a class="message-file" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">
            <span class="message-file-icon">${fileKindIcon(meta.name || "")}</span>
            <div class="message-file-copy">
                <div class="message-file-name">${escapeHTML(meta.name || "Файл")}</div>
                <div class="message-file-size">${meta.size ? formatFileSize(meta.size) : ""}</div>
            </div>
        </a>
    `;

}

// P2P-передача (см. script-core.js → sendP2PFile/acceptFileTransfer) — своя
// карточка вместо обычной ссылки на файл: кнопки "Принять/Отклонить" (у
// получателя, пока pending), живой прогресс (bytesDone/bytesTotal), текстовый
// статус. Прогресс и статус дальше обновляются НАПРЯМУЮ через DOM по id
// (p2p-status-/p2p-progress-${transferId}) из обработчиков дата-канала —
// без перерисовки всего сообщения на каждый чанк.
function buildP2PFileHTML(message) {

    const meta = message.attachment_meta || {};
    // transferId приходит из attachment_meta, который пишет ДРУГАЯ сторона
    // (собеседник), и дальше подставляется в id="…" и inline onclick="…('…')"
    // без экранирования — строка вида  x');alert(1);//  выполнила бы чужой
    // код в браузере получателя. Допускаем только безопасный набор символов
    // (настоящий transferId — crypto.randomUUID(), он ему полностью
    // удовлетворяет); всё остальное считаем отсутствующим id.
    const rawTransferId = String(meta.transferId || "");
    const transferId = /^[A-Za-z0-9_-]{1,64}$/.test(rawTransferId) ? rawTransferId : "";
    const isMine = message.sender_id === myRealUserId;
    const status = meta.status || "pending";

    const statusLabels = {
        queued: "В очереди…",
        pending: isMine ? "Ожидает подтверждения…" : "Предлагает файл",
        accepted: "Подключение…",
        transferring: "Передаётся…",
        paused: "На паузе",
        reconnecting: "Переподключение…",
        verifying: "Проверка целостности…",
        completed: isMine ? "Файл отправлен, хеш совпадает" : "Файл сохранён, хеш совпадает",
        "hash-mismatch": "⚠️ Файл передан, но хеш не совпал",
        declined: isMine ? "Собеседник отклонил" : "Вы отклонили",
        failed: "Передача не удалась",
        cancelled: "Передача отменена",
        unsupported: "У собеседника нет поддержки (нужен Chrome/Edge на компьютере)"
    };

    // Блок кнопок рендерим ВСЕГДА (даже пустым) — так setP2PStatus (см.
    // script-core.js) может дальше дописывать в него кнопку паузы по ходу
    // передачи через querySelector, не дожидаясь полной перерисовки
    // сообщения. Без этого у отправителя (isMine — для него тут изначально
    // ничего не рендерилось, только у получателя на шаге accept/decline)
    // просто не было бы DOM-узла, куда вставить кнопку "Пауза".
    const actionsInner = !transferId
        ? ""
        : (status === "pending" && !isMine)
        ? `<button type="button" class="p2p-file-accept" onclick="acceptFileTransfer('${transferId}')">Принять</button>
           <button type="button" class="p2p-file-decline" onclick="declineFileTransfer('${transferId}')">Отклонить</button>`
        : (status === "transferring" || status === "paused")
            ? (status === "paused"
                ? `<button type="button" class="p2p-file-pause" onclick="resumeFileTransferManual('${transferId}')">Продолжить</button>`
                : `<button type="button" class="p2p-file-pause" onclick="pauseFileTransfer('${transferId}')">Пауза</button>`)
            : "";
    const actionsHTML = `<div class="p2p-file-actions">${actionsInner}</div>`;

    return `
        <div class="p2p-file" data-transfer-id="${escapeHTML(transferId)}">
            <span class="p2p-file-icon">${fileKindIcon(meta.fileName || "")}</span>
            <div class="p2p-file-copy">
                <div class="p2p-file-name">${escapeHTML(meta.fileName || "Файл")}<span class="p2p-file-lan-badge" title="Прямое соединение в локальной сети — максимальная скорость" hidden>⚡ LAN</span></div>
                <div class="p2p-file-size">${meta.fileSize ? formatFileSize(meta.fileSize) : ""}</div>
                <div class="p2p-file-status" id="p2p-status-${transferId}">${escapeHTML(statusLabels[status] || "")}</div>
                <div class="p2p-file-progress" id="p2p-progress-wrap-${transferId}" hidden>
                    <div class="p2p-file-progress-fill" id="p2p-progress-${transferId}"></div>
                </div>
            </div>
            ${actionsHTML}
        </div>
    `;

}


/* ГОЛОСОВОЙ ПРОИГРЫВАТЕЛЬ (.voice-message) — свой плей/пауза, перемотка по
   полоске тапом и скорость 1x/1.5x/2x/0.75x по кругу. Один <audio> на
   сообщение, элементы находятся через closest/querySelector от того, что
   реально кликнули — отдельных id на каждое голосовое заводить не нужно. */

const VOICE_SPEED_STEPS = [1, 1.5, 2, 0.75];

// Свежезаписанные (MediaRecorder) webm-блобы почти всегда отдают
// audio.duration === Infinity, пока браузер не домотает до конца хотя бы
// один раз (контейнер пишется "на лету", без таблицы длительности в
// заголовке — известная особенность Chrome, не баг конкретно этого кода).
// Infinity — ИСТИННОЕ значение в JS, поэтому простое "audio.duration || x"
// его не отфильтрует и пропускает дальше, а currentTime = fraction*Infinity
// кидает "non-finite" и ломает перемотку. Everywhere, где нужна
// длительность, нужно брать именно отсюда, а не читать .duration напрямую.
function getMediaDurationSeconds(mediaEl) {
    if (Number.isFinite(mediaEl.duration) && mediaEl.duration > 0) return mediaEl.duration;
    return (Number(mediaEl.dataset.durationMs) || 0) / 1000;
}

function toggleVoiceMessage(button) {

    const audio = button.closest(".voice-message")?.querySelector(".voice-message-audio");
    if (!audio) return;

    if (!audio.paused) {
        audio.pause();
        return;
    }

    // Как в Telegram — играет только одно голосовое/видео-кружок сразу
    // (см. pauseAllOtherMedia ниже, общая для обоих типов).
    pauseAllOtherMedia(audio);

    audio.play().catch(() => {});

}

function onVoiceMessagePlayStateChange(audio) {

    const container = audio.closest(".voice-message");
    if (!container) return;

    const playing = !audio.paused && !audio.ended;
    container.classList.toggle("playing", playing);
    container.querySelector(".vm-icon-play").hidden = playing;
    container.querySelector(".vm-icon-pause").hidden = !playing;

}

function onVoiceMessageTimeUpdate(audio) {

    const container = audio.closest(".voice-message");
    if (!container) return;

    const durationMs = getMediaDurationSeconds(audio) * 1000;

    const fraction = durationMs ? Math.min(1, (audio.currentTime * 1000) / durationMs) : 0;

    const fill = container.querySelector(".voice-message-progress-fill");
    if (fill) fill.style.width = `${fraction * 100}%`;

    // Звуковая волна красится "проигранной" поверх "общей" через clip-path —
    // проще и дешевле по перерисовке, чем менять высоту/цвет каждого
    // столбика по отдельности на каждый кадр timeupdate.
    const waveformProgress = container.querySelector(".voice-waveform-bars-progress");
    if (waveformProgress) waveformProgress.style.clipPath = `inset(0 ${(1 - fraction) * 100}% 0 0)`;

    const timeEl = container.querySelector(".voice-message-time");
    if (timeEl) {
        const remainingMs = audio.currentTime > 0 ? Math.max(0, durationMs - audio.currentTime * 1000) : durationMs;
        timeEl.textContent = formatRecordingTime(remainingMs);
    }

}

function onVoiceMessageEnded(audio) {

    audio.currentTime = 0;
    onVoiceMessagePlayStateChange(audio);
    onVoiceMessageTimeUpdate(audio);

}

// Перетаскивание по полоске (не только тап): на время протяжки ставим на
// паузу, как в большинстве плееров — иначе currentTime, который сам ползёт
// от воспроизведения, спорит с тем, что тащит палец/курсор.
function startVoiceMessageSeek(event, progressEl) {

    event.preventDefault();
    event.stopPropagation();

    const audio = progressEl.closest(".voice-message")?.querySelector(".voice-message-audio");
    if (!audio) return;

    const duration = getMediaDurationSeconds(audio);
    if (!duration) return;

    const wasPlaying = !audio.paused;
    audio.pause();

    // Полоска во время протяжки не двигается — размеры читаем ОДИН раз, а не
    // getBoundingClientRect() на каждый pointermove сразу после того, как
    // предыдущий onVoiceMessageTimeUpdate уже записал width/clip-path (чтение
    // layout после записи стилей — принудительный синхронный reflow на
    // каждое микродвижение пальца).
    const rect = progressEl.getBoundingClientRect();

    const applySeek = (clientX) => {
        const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        audio.currentTime = fraction * duration;
        onVoiceMessageTimeUpdate(audio);
    };

    applySeek(event.clientX);

    const onMove = (moveEvent) => applySeek(moveEvent.clientX);
    // finish вешается и на pointerup, и на pointercancel (на touch браузер
    // шлёт cancel, когда жест превращается в прокрутку страницы) — без
    // pointercancel слушатели на document оставались навсегда и продолжали
    // "перематывать" это голосовое от любого последующего движения курсора,
    // а прерванное воспроизведение никогда не возобновлялось.
    const finish = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        // Если строку успели перерисовать посреди протяжки (<audio> уже
        // оторван от DOM), запускать воспроизведение на осиротевшем узле
        // нельзя — оно играло бы без UI и без возможности остановить.
        if (wasPlaying && audio.isConnected) audio.play().catch(() => {});
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);

}

function cycleVoiceMessageSpeed(button) {

    const audio = button.closest(".voice-message")?.querySelector(".voice-message-audio");
    if (!audio) return;

    const current = audio.playbackRate || 1;
    const currentIndex = VOICE_SPEED_STEPS.findIndex((step) => Math.abs(step - current) < 0.01);
    const next = VOICE_SPEED_STEPS[(currentIndex + 1) % VOICE_SPEED_STEPS.length];

    audio.playbackRate = next;
    button.textContent = `${next}x`;

}


/* ВИДЕО-КРУЖОК (.video-circle) — свой плеер 1:1 по принципу настоящего
   Telegram: тап по кругу — пуск/пауза, тонкое кольцо прогресса по краю,
   бейдж скорости по кругу (как у голосовых). Играет только ОДНО аудио/видео
   сразу во всём приложении — pauseAllOtherMedia останавливает все остальные
   голосовые и видео-кружки, когда запускается новый. */

const VIDEO_CIRCLE_RING_CIRCUMFERENCE = 295; // 2*PI*47 — должно совпадать со stroke-dasharray в style.css
const VIDEO_CIRCLE_SPEED_STEPS = [1, 1.5, 2, 0.75];

function pauseAllOtherMedia(exceptEl) {
    document.querySelectorAll("#messages audio, #messages video").forEach((el) => {
        if (el !== exceptEl && !el.paused) el.pause();
    });
}

function toggleVideoCircle(container) {

    const video = container.querySelector(".video-circle-video");
    if (!video) return;

    if (!video.paused) {
        video.pause();
        return;
    }

    pauseAllOtherMedia(video);
    video.play().catch(() => {});

}

function onVideoCirclePlayStateChange(video) {
    const container = video.closest(".video-circle");
    if (!container) return;
    container.classList.toggle("playing", !video.paused && !video.ended);
}

function onVideoCircleTimeUpdate(video) {

    const container = video.closest(".video-circle");
    if (!container) return;

    const durationMs = getMediaDurationSeconds(video) * 1000;

    const fraction = durationMs ? Math.min(1, (video.currentTime * 1000) / durationMs) : 0;
    const ring = container.querySelector(".video-circle-ring-progress");
    if (ring) ring.style.strokeDashoffset = String(VIDEO_CIRCLE_RING_CIRCUMFERENCE * (1 - fraction));

    // Плашка снизу-справа (.message-time) у видео-кружка показывает
    // оставшееся/общее время ролика, а не время отправки сообщения — тоже
    // ровно как в настоящем Telegram (у обычных сообщений там время отправки).
    const timeTextEl = container.closest(".message")?.querySelector(".message-time-text");
    if (timeTextEl) {
        const remainingMs = video.currentTime > 0 ? Math.max(0, durationMs - video.currentTime * 1000) : durationMs;
        timeTextEl.textContent = formatRecordingTime(remainingMs);
    }

}

function onVideoCircleEnded(video) {
    video.currentTime = 0;
    onVideoCirclePlayStateChange(video);
    onVideoCircleTimeUpdate(video);
}

function cycleVideoCircleSpeed(button) {

    const video = button.closest(".video-circle")?.querySelector(".video-circle-video");
    if (!video) return;

    const current = video.playbackRate || 1;
    const currentIndex = VIDEO_CIRCLE_SPEED_STEPS.findIndex((step) => Math.abs(step - current) < 0.01);
    const next = VIDEO_CIRCLE_SPEED_STEPS[(currentIndex + 1) % VIDEO_CIRCLE_SPEED_STEPS.length];

    video.playbackRate = next;
    button.textContent = `${next}x`;

}


function openContactFromMessage(userId) {
    if (!userId) { toast("Профиль недоступен"); return; }
    startRealChatWith(userId);
}


/* ГАЛЕРЕЯ ФОТО ЧАТА: тап по фото собирает ВСЕ фото из уже отрисованных
   сообщений текущего чата (а не только то, по которому тапнули) — листать
   можно сразу всю переписку, как в настоящем мессенджере. Список строится
   заново при каждом открытии, а не хранится — подгруженные при скролле
   вверх старые сообщения тоже должны туда попадать. */

let imageGalleryUrls = [];
let imageGalleryIndex = 0;

function openImageGallery(imgEl) {

    imageGalleryUrls = Array.from(document.querySelectorAll("#messages img.message-image")).map((el) => el.src);
    imageGalleryIndex = Math.max(0, imageGalleryUrls.indexOf(imgEl.src));

    renderImageGallery();

    const backdrop = document.getElementById("image-gallery-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function renderImageGallery() {

    const total = imageGalleryUrls.length;
    document.getElementById("image-gallery-image").src = imageGalleryUrls[imageGalleryIndex] || "";
    document.getElementById("image-gallery-counter").textContent = total > 1 ? `${imageGalleryIndex + 1} / ${total}` : "";
    document.getElementById("image-gallery-prev").hidden = total < 2;
    document.getElementById("image-gallery-next").hidden = total < 2;

}

function navigateImageGallery(delta) {
    if (imageGalleryUrls.length < 2) return;
    imageGalleryIndex = (imageGalleryIndex + delta + imageGalleryUrls.length) % imageGalleryUrls.length;
    renderImageGallery();
}

function closeImageGallery() {
    const backdrop = document.getElementById("image-gallery-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.getElementById("image-gallery-image").src = "";
}

function closeImageGalleryFromBackdrop(event) {
    if (event.target === event.currentTarget) closeImageGallery();
}

document.addEventListener("keydown", (event) => {
    if (!document.getElementById("image-gallery-backdrop")?.classList.contains("open")) return;
    if (event.key === "Escape") closeImageGallery();
    else if (event.key === "ArrowLeft") navigateImageGallery(-1);
    else if (event.key === "ArrowRight") navigateImageGallery(1);
});

// Свайп влево/вправо по самому фото — пальцем, как в любой нормальной
// галерее (стрелки — для мыши/десктопа, их на телефоне и не видно будет
// при обычной ширине экрана).
(function attachImageGallerySwipe() {
    let startX = null;
    const image = document.getElementById("image-gallery-image");
    if (!image) return;

    image.addEventListener("pointerdown", (event) => { startX = event.clientX; });
    image.addEventListener("pointerup", (event) => {
        if (startX === null) return;
        const deltaX = event.clientX - startX;
        startX = null;
        if (Math.abs(deltaX) < 40) return;
        navigateImageGallery(deltaX < 0 ? 1 : -1);
    });
})();

function buildMessageRowInnerHTML(message, isMine) {

    const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // Настоящая галочка прочтения: ✓ пока ни один ДРУГОЙ участник чата не
    // отметил сообщение прочитанным (см. message.message_status — join из
    // getMessages), ✓✓ как только хотя бы один отметил (см. markMessagesAsRead
    // в openRealChat/onMessage — вызывается, пока чат открыт у собеседника).
    const isRead = (message.message_status || []).some((s) => s.user_id !== myRealUserId && s.status === "read");
    const statusTick = isMine
        ? `<span class="message-status" data-status="${isRead ? "read" : "sent"}">${isRead ? "✓✓" : "✓"}</span>`
        : "";
    const editedTag = message.edited_at && !message.deleted_at ? `<span class="message-edited-tag">изменено</span>` : "";
    const effectKind = message.attachment_meta?.effect;
    const effectTag = effectKind && !message.deleted_at && typeof EFFECT_ICONS !== "undefined" && EFFECT_ICONS[effectKind]
        ? `<button type="button" class="effect-replay" data-effect="${effectKind}" onclick="event.stopPropagation(); replayEffectFrom(this)" title="Повторить эффект" aria-label="Повторить эффект">${EFFECT_ICONS[effectKind]}</button>`
        : "";
    const replyMarkup = buildReplyQuoteHTML(message.reply_to_id, message.attachment_meta?.reply_excerpt);
    const forwardedFrom = message.attachment_meta?.forwarded_from;
    const forwardedMarkup = forwardedFrom && !message.deleted_at
        ? `<span class="message-forwarded">Переслано от ${escapeHTML(String(forwardedFrom).slice(0, 64))}</span>`
        : "";

    // message-text — ОТДЕЛЬНЫЙ инлайн-контейнер именно под текст, не весь
    // .message целиком: white-space:pre-wrap (нужен, чтобы переносы строк
    // ВНУТРИ набранного текста не схлопывались) должен относиться только
    // к этому тексту. Раньше pre-wrap стоял на .message — и заодно начинал
    // буквально печатать переводы строк и отступы ИЗ ШАБЛОНА этой функции
    // (между `${senderLabel}`, `${replyMarkup}` и т.д.), раздувая КАЖДЫЙ
    // пузырь пустыми строками — то самое "здоровенные пузыри" с текстом
    // где-то посередине.
    const bodyText = message.deleted_at
        ? `<span class="message-deleted-tag">Сообщение удалено</span>`
        : (message.attachment_meta?.poll
            ? buildPollHTML(message)
            : message.attachment_meta?.game
            ? buildGameHTML(message)
            : message.type === "text"
            ? `<span class="message-text">${renderFormattedText(message.text || "")}</span>`
            : buildAttachmentHTML(message));

    // В группах над чужим сообщением подписываем автора (как в Telegram) —
    // в личных чатах и так ясно, кто писал, поэтому только для group.
    const senderLabel = !isMine && currentChatType === "group"
        ? `<span class="message-sender-name">${escapeHTML(currentChatMembersById.get(message.sender_id)?.display_name || "Участник")}</span>`
        : "";

    // has-video-circle вместо CSS-селектора .message:has(.video-circle): :has()
    // заставляет браузер следить за мутациями потомков КАЖДОГО пузыря в ленте
    // (любая реакция/правка/статус пересчитывает его для всех видимых
    // сообщений) — обычный класс решает ту же задачу без этой цены.
    const bubbleClass = bodyText.includes('class="video-circle"') ? "message has-video-circle" : "message";

    return `
        <div class="${bubbleClass}">
            ${senderLabel}
            ${forwardedMarkup}
            ${replyMarkup}
            ${bodyText}
            <span class="message-time">
                ${effectTag}
                ${editedTag}
                <span class="message-time-text">${time}</span>
                ${statusTick}
            </span>
        </div>
        <div class="message-reactions"></div>
    `;

}

// Только галочка прочтения (✓ → ✓✓) — без пересборки всего пузыря.
function updateMessageStatusTick(messageId) {
    const message = realMessagesById.get(messageId);
    const tick = document.querySelector(`#messages .message-row[data-message-id="${messageId}"] .message-status`);
    if (!message || !tick) return;
    const isRead = (message.message_status || []).some((s) => s.user_id !== myRealUserId && s.status === "read");
    const status = isRead ? "read" : "sent";
    if (tick.dataset.status === status) return;
    tick.dataset.status = status;
    tick.textContent = isRead ? "✓✓" : "✓";
}

function updateRealMessageRow(messageId, { force = false } = {}) {
    const message = realMessagesById.get(messageId);
    const row = document.querySelector(`#messages .message-row[data-message-id="${messageId}"]`);
    if (!message || !row) return;

    // Сообщение сейчас редактируется — чужая реакция/закреп не должны молча
    // уничтожить форму правки вместе с набранным текстом. Перерисуем после.
    if (!force && row.querySelector(".message-edit-form")) {
        if (message.reactions) renderReactionsInto(row.querySelector(".message-reactions"), message.reactions, myRealUserId);
        return;
    }

    const isMine = row.classList.contains("sent");

    // Строка перерисовывается ЦЕЛИКОМ при любом изменении (реакция, закреп,
    // правка, смена статуса) — это уничтожает и пересоздаёт <audio>/<video>
    // (играющее голосовое молча обрывалось бы и прыгало на 0:00 от чужой
    // реакции) и сбрасывает "живой" прогресс активной P2P-передачи, который
    // обновляется напрямую через DOM, а в attachment_meta не пишется. Снимаем
    // состояние до перерисовки и возвращаем его после.
    const mediaSnapshot = [...row.querySelectorAll("audio, video")].map((el) => ({
        currentTime: el.currentTime,
        playbackRate: el.playbackRate,
        paused: el.paused
    }));

    let p2pSnapshot = null;
    const oldP2PCard = row.querySelector(".p2p-file");
    const oldTransferId = oldP2PCard?.dataset.transferId;
    if (oldTransferId && typeof activeFileTransfers !== "undefined" && activeFileTransfers.has(oldTransferId)) {
        p2pSnapshot = {
            status: oldP2PCard.querySelector(".p2p-file-status")?.textContent,
            progressHidden: oldP2PCard.querySelector(".p2p-file-progress")?.hidden,
            progressWidth: oldP2PCard.querySelector(".p2p-file-progress-fill")?.style.width,
            actions: oldP2PCard.querySelector(".p2p-file-actions")?.innerHTML,
            lanHidden: oldP2PCard.querySelector(".p2p-file-lan-badge")?.hidden
        };
    }

    try {
        row.innerHTML = buildMessageRowInnerHTML(message, isMine);
    } catch (error) {
        console.warn("Не удалось перерисовать сообщение", messageId, error);
        return;
    }
    row.classList.toggle("deleted", !!message.deleted_at);
    // Чипы реакций пересоздаются ниже — класс отступа под них снимаем, иначе после
    // снятия последней реакции под пузырём оставалась пустая дыра.
    row.classList.remove("has-reactions");

    row.querySelectorAll("audio, video").forEach((el, index) => {
        const snap = mediaSnapshot[index];
        if (!snap) return;
        try {
            if (snap.currentTime > 0) el.currentTime = snap.currentTime;
            el.playbackRate = snap.playbackRate;
            if (!snap.paused) el.play().catch(() => {});
        } catch {}
    });

    if (p2pSnapshot) {
        const newP2PCard = row.querySelector(".p2p-file");
        if (newP2PCard) {
            const statusEl = newP2PCard.querySelector(".p2p-file-status");
            if (statusEl && p2pSnapshot.status) statusEl.textContent = p2pSnapshot.status;
            const progressEl = newP2PCard.querySelector(".p2p-file-progress");
            if (progressEl && p2pSnapshot.progressHidden === false) progressEl.hidden = false;
            const fillEl = newP2PCard.querySelector(".p2p-file-progress-fill");
            if (fillEl && p2pSnapshot.progressWidth) fillEl.style.width = p2pSnapshot.progressWidth;
            const actionsEl = newP2PCard.querySelector(".p2p-file-actions");
            if (actionsEl && p2pSnapshot.actions != null) actionsEl.innerHTML = p2pSnapshot.actions;
            const lanEl = newP2PCard.querySelector(".p2p-file-lan-badge");
            if (lanEl && p2pSnapshot.lanHidden === false) lanEl.hidden = false;
        }
    }

    if (!message.deleted_at && message.type === "text") {
        if (message.attachment_meta?.game?.kind === "dice") {
            // Кубик — как стикер: без пузыря, просто грань на фоне чата.
            row.querySelector(".message").classList.add("sticker", "dice-message");
        } else if (message.attachment_meta?.sticker) {
            row.querySelector(".message").classList.add("sticker");
        } else if (appSettings.largeEmoji && isEmojiOnly(message.text || "")) {
            row.querySelector(".message").classList.add("emoji-only");
        }
    }
    if (message.reactions?.length) {
        renderReactionsInto(row.querySelector(".message-reactions"), message.reactions, myRealUserId);
    }
}

function startEditMessage(row) {

    const messageId = row.dataset.messageId;
    const message = realMessagesById.get(messageId);
    if (!message || message.deleted_at || message.type !== "text") return;

    const bubble = row.querySelector(".message");
    bubble.innerHTML = `
        <div class="message-edit-form">
            <textarea class="message-edit-input">${escapeHTML(message.text || "")}</textarea>
            <div class="message-edit-actions">
                <button type="button" onclick="cancelEditMessage('${messageId}')">Отмена</button>
                <button type="button" onclick="confirmEditMessage('${messageId}')">Сохранить</button>
            </div>
        </div>
    `;

    const textarea = bubble.querySelector(".message-edit-input");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.addEventListener("keydown", (event) => {
        if (event.key === "Escape") cancelEditMessage(messageId);
        if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); confirmEditMessage(messageId); }
    });

}

function cancelEditMessage(messageId) {
    updateRealMessageRow(messageId, { force: true });
}

async function confirmEditMessage(messageId) {

    // Защита на случай прямого вызова в обход скрытой кнопки "Изменить" в
    // контекстном меню (см. currentChatIsSecret там же) — editMessage() пишет
    // текст как есть, а в секретном чате это должен быть шифротекст.
    if (currentChatIsSecret) { toast("Редактирование в секретных чатах недоступно"); return; }

    const row = document.querySelector(`.message-row[data-message-id="${messageId}"]`);
    const newText = row?.querySelector(".message-edit-input")?.value.trim();
    if (!newText) { toast("Текст не может быть пустым"); return; }
    if (newText.length > MAX_MESSAGE_LENGTH) { toast(`Слишком длинно: максимум ${MAX_MESSAGE_LENGTH} символов`); return; }
    // Ничего не поменяли — не отправляем запрос и не ставим метку «изменено».
    if (newText === (realMessagesById.get(messageId)?.text || "").trim()) { cancelEditMessage(messageId); return; }

    // Быстрый двойной Enter (автоповтор клавиши) или Enter + клик по кнопке
    // раньше запускали два параллельных запроса правки одного сообщения,
    // которые потом гонялись друг с другом за обновление строки и кеша.
    if (editsInFlight.has(messageId)) return;
    editsInFlight.add(messageId);

    try {
        const updated = await KabanAPI.editMessage(messageId, newText);
        const merged = { ...realMessagesById.get(messageId), ...updated };
        realMessagesById.set(messageId, merged);
        updateRealMessageRow(messageId, { force: true });
        // Превью в сайдбаре трогаем, только если отредактированное сообщение —
        // и есть то самое последнее (иначе там нечего обновлять, а полный
        // loadChatList() ради этого — лишний поход на сервер).
        const row = cachedChatRows.find((r) => r.chat_id === currentChatId);
        if (row?.chats?.messages?.[0]?.id === messageId) {
            patchCachedChatLastMessage(currentChatId, merged);
        }
    } catch (error) {
        toast("Не удалось изменить: " + (error?.message || error));
    } finally {
        editsInFlight.delete(messageId);
    }

}

const editsInFlight = new Set();

// "Удалить у меня" / "Удалить у нас обоих" — выбор в маленьком окошке
// (по образцу .forward-modal), а не сразу необратимое действие по клику.
// В обоих случаях строка теперь пропадает ПОЛНОСТЬЮ (а не остаётся
// плейсхолдером "сообщение удалено", как раньше) — отличаются только тем,
// видно ли сообщение собеседнику после удаления.
let deleteChoiceMessageIds = [];

// messageId — одно сообщение (контекстное меню) или массив (массовое
// удаление выбранных, см. deleteSelectedMessages).
function openDeleteChoiceModal(messageId) {

    deleteChoiceMessageIds = Array.isArray(messageId) ? messageId : [messageId];

    // "Удалить у нас обоих" массово предлагаем, только если ВСЕ выбранные
    // сообщения — мои (иначе полезли бы в чужие через один клик).
    // Админ группы с правом delete_messages может удалять и чужие.
    const mayDeleteOthers = currentChatType === "group" && groupMayDeleteOthers();
    const allMine = mayDeleteOthers || deleteChoiceMessageIds.every((id) => {
        const row = document.querySelector(`.message-row[data-message-id="${id}"]`);
        return row?.classList.contains("sent");
    });
    document.getElementById("delete-choice-everyone").hidden = !allMine;

    const backdrop = document.getElementById("delete-choice-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeDeleteChoiceModal() {
    const backdrop = document.getElementById("delete-choice-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    deleteChoiceMessageIds = [];
}

// Удаляет сообщения по одному и отражает в интерфейсе ровно те, что
// реально удалились на сервере. Раньше строки убирались из UI только ПОСЛЕ
// успешного завершения всего цикла: если, например, третье из пяти падало
// с ошибкой, первые два уже были стёрты на сервере, а на экране оставались
// все пять — повторная попытка упиралась в уже удалённые, а человек не мог
// понять, в каком состоянии чат.
async function deleteMessagesBatch(ids, deleteOne) {

    const succeeded = [];
    let firstError = null;

    // Параллельно (раньше строго по одному — 20 выбранных сообщений = 20 сетевых кругов подряд).
    const results = await Promise.allSettled(ids.map((id) => deleteOne(id)));
    results.forEach((result, index) => {
        if (result.status === "fulfilled") succeeded.push(ids[index]);
        else if (!firstError) firstError = result.reason;
    });

    if (succeeded.length) {
        succeeded.forEach((id) => removeMessageRowCompletely(id, { deferRefresh: true }));
        refreshAfterMessageRemoval();
        refreshChatListPreviewFromMessages(currentChatId);
    }

    if (firstError) {
        const reason = firstError?.message || firstError;
        toast(succeeded.length
            ? `Удалено ${succeeded.length} из ${ids.length}: ${reason}`
            : "Не удалось удалить: " + reason);
    }

}

async function confirmDeleteForMe() {

    const ids = deleteChoiceMessageIds;
    closeDeleteChoiceModal();
    exitSelectionMode();
    if (!ids.length) return;

    await deleteMessagesBatch(ids, (id) => KabanAPI.deleteMessageForMe(id));

}

async function confirmDeleteForEveryone() {

    const ids = deleteChoiceMessageIds;
    closeDeleteChoiceModal();
    exitSelectionMode();
    if (!ids.length) return;

    if (ids.length === 1) {
        await deleteMessagesBatch(ids, (id) => KabanAPI.deleteMessageForEveryone(id));
        return;
    }

    // Несколько сообщений — одним запросом, а не N последовательных.
    try {
        const removed = await KabanAPI.deleteMessagesForEveryone(ids);
        removed.forEach((id) => removeMessageRowCompletely(id, { deferRefresh: true }));
        if (removed.length) {
            refreshAfterMessageRemoval();
            refreshChatListPreviewFromMessages(currentChatId);
        }
        if (removed.length < ids.length) toast(`Удалено ${removed.length} из ${ids.length}: на остальные нет прав`);
    } catch (error) {
        toast("Не удалось удалить: " + (error?.message || error));
    }

}

// Пересчитывает "последнее сообщение" чата для превью в сайдбаре прямо из
// уже загруженной истории (realMessagesById) — один раз на весь пакет
// удаления (выше могли удалить сразу несколько сообщений выделением), а
// не полный поход на сервер на КАЖДОЕ из них, как было раньше.
function refreshChatListPreviewFromMessages(chatId) {

    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row?.chats) return;

    let latest = null;
    realMessagesById.forEach((message) => {
        if (message.chat_id !== chatId) return;
        if (!latest || new Date(message.created_at) > new Date(latest.created_at)) latest = message;
    });

    row.chats.messages = latest ? [latest] : [];
    refreshChatListLocally();

}

// deferRefresh — для массового удаления: пересчёт группировки и полоски
// закрепа (оба проходят по ВСЕМУ списку сообщений) делаем один раз после
// всей пачки, а не по разу на каждое удалённое сообщение (K сообщений в
// длинной истории = K полных проходов с сортировкой подряд).
function removeMessageRowCompletely(messageId, { deferRefresh = false } = {}) {

    const row = document.querySelector(`.message-row[data-message-id="${messageId}"]`);
    if (row) {
        row.style.transition = "opacity .18s ease, transform .18s ease";
        row.style.opacity = "0";
        row.style.transform = "scale(.94)";
        setTimeout(() => row.remove(), 180);
    }

    realMessagesById.delete(messageId);
    selectedMessageIds.delete(messageId);
    if (!deferRefresh) refreshAfterMessageRemoval();

}

let removalGroupingTimer = null;

function refreshAfterMessageRemoval() {
    renderPinnedBar();
    // Группировку пересчитываем уже ПОСЛЕ того, как строки с анимацией
    // исчезновения (180мс) реально убраны из DOM — раньше она считалась пока
    // удаляемая строка ещё была на месте, и скруглённые углы/подписи соседних
    // сообщений оставались как будто удалённое всё ещё рядом.
    clearTimeout(removalGroupingTimer);
    removalGroupingTimer = setTimeout(updateMessageGrouping, 220);
}

/* ============================================================================
   ЗАКРЕПЛЁННОЕ СООБЩЕНИЕ — полоска под шапкой (см. #pinned-bar в index.html).
   Закрепить/открепить может любой участник чата, не только автор (см.
   toggle_message_pin в schema.sql). Несколько закреплений — бар листает их
   по кругу кликом, как в Telegram.
   ========================================================================= */

let pinnedBarIndex = 0;

// Открепление — всегда простое одиночное действие (снимает только свой id,
// см. schema.sql → toggle_message_pin). Закрепление — как и удаление,
// предлагает выбор: у меня / у нас обоих (см. openPinChoiceModal ниже).
function contextMenuTogglePin() {

    const messageId = contextMenuTargetRow?.dataset.messageId;
    document.getElementById("message-context-menu").hidden = true;
    if (!messageId) return;

    const message = realMessagesById.get(messageId);
    if (!message) return;

    const isPinnedForMe = message.pinned_for?.includes(myRealUserId);
    if (isPinnedForMe) {
        togglePinMessage(messageId, false, false);
    } else {
        openPinChoiceModal(messageId);
    }

}

let pinChoiceMessageId = null;

function openPinChoiceModal(messageId) {
    pinChoiceMessageId = messageId;
    // В группе закрепить для всех может только тот, у кого есть такое право.
    const everyoneButton = document.getElementById("pin-choice-everyone");
    if (everyoneButton) everyoneButton.hidden = currentChatType === "group" && !groupMayPin();
    const backdrop = document.getElementById("pin-choice-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closePinChoiceModal() {
    const backdrop = document.getElementById("pin-choice-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    pinChoiceMessageId = null;
}

function confirmPinForMe() {
    const messageId = pinChoiceMessageId;
    closePinChoiceModal();
    if (messageId) togglePinMessage(messageId, true, false);
}

function confirmPinForEveryone() {
    const messageId = pinChoiceMessageId;
    closePinChoiceModal();
    if (messageId) togglePinMessage(messageId, true, true);
}

async function togglePinMessage(messageId, pin, forEveryone) {

    try {
        await KabanAPI.togglePin(messageId, pin, forEveryone);

        const message = realMessagesById.get(messageId);
        if (message) {
            if (!pin) {
                message.pinned_for = (message.pinned_for || []).filter((id) => id !== myRealUserId);
            } else if (forEveryone) {
                message.pinned_for = [...new Set([...(message.pinned_for || []), myRealUserId, ...otherChatMemberIds()])];
            } else {
                message.pinned_for = [...new Set([...(message.pinned_for || []), myRealUserId])];
            }
        }

        renderPinnedBar();
        toast(pin ? "Сообщение закреплено" : "Сообщение откреплено");
    } catch (error) {
        toast("Не удалось закрепить: " + (error?.message || error));
    }

}

// Локально достраиваем pinned_for для "у нас обоих" сразу после ответа
// сервера (не дожидаясь отдельного запроса) — id участников уже есть
// в cachedChatRows/otherUser текущего чата.
function otherChatMemberIds() {
    if (currentChatType === "group") return [...currentChatMembersById.keys()];
    const meta = cachedChatRows.find((row) => row.chat_id === currentChatId);
    return meta?.otherUser?.id ? [meta.otherUser.id] : [];
}

function getPinnedMessages() {
    return [...realMessagesById.values()]
        .filter((m) => m.pinned_for?.includes(myRealUserId) && !m.deleted_at)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function renderPinnedBar() {

    const bar = document.getElementById("pinned-bar");
    if (!currentChatId || selectionMode) { bar.hidden = true; return; }

    const pinned = getPinnedMessages();
    if (!pinned.length) { bar.hidden = true; return; }

    if (pinnedBarIndex >= pinned.length) pinnedBarIndex = 0;
    const current = pinned[pinnedBarIndex];

    document.getElementById("pinned-bar-label").textContent = pinned.length > 1
        ? `Закреплено (${pinnedBarIndex + 1}/${pinned.length})`
        : "Закреплённое сообщение";
    document.getElementById("pinned-bar-text").textContent = messagePreviewText(current);
    bar.dataset.messageId = current.id;
    bar.hidden = false;

    // Слева — столбик из сегментов (по числу закрепов), активный подсвечен; кнопка списка — если закрепов больше одного.
    document.getElementById("pinned-bar-list").hidden = pinned.length < 2;
    const segs = document.getElementById("pinned-bar-segs");
    const shown = Math.min(pinned.length, 4);
    if (segs.children.length !== shown) segs.innerHTML = "<i></i>".repeat(shown);
    const activeSeg = pinnedBarIndex % shown;
    [...segs.children].forEach((seg, i) => seg.classList.toggle("active", i === activeSeg));

}

function handlePinnedBarClick() {

    const pinned = getPinnedMessages();
    if (!pinned.length) return;

    flashMessage(pinned[pinnedBarIndex].id);
    pinnedBarIndex = (pinnedBarIndex + 1) % pinned.length;
    renderPinnedBar();

}

function unpinFromBar() {
    const messageId = document.getElementById("pinned-bar").dataset.messageId;
    if (messageId) togglePinMessage(messageId, false);
}

async function flashMessage(messageId) {

    let row = document.querySelector(`#messages .message-row[data-message-id="${messageId}"]`);

    // Сообщение старше загруженной части истории (ответ на старое, закреп, результат
    // поиска) — раньше клик молча ничего не делал. Догружаем историю постранично.
    if (!row && currentChatId && typeof loadOlderMessages === "function") {
        const chatAtStart = currentChatId;
        for (let page = 0; page < 20 && !row && hasMoreMessages && currentChatId === chatAtStart; page++) {
            const before = oldestLoadedMessageCreatedAt;
            await loadOlderMessages();
            if (oldestLoadedMessageCreatedAt === before) break; // сеть/конец истории
            row = document.querySelector(`#messages .message-row[data-message-id="${messageId}"]`);
        }
        if (!row) {
            if (currentChatId === chatAtStart) toast("Сообщение не найдено — возможно, оно удалено");
            return;
        }
    }
    if (!row) return;

    scrollElementIntoViewSafely(row, "center");
    const bubble = row.querySelector(".message");
    bubble.classList.add("flash-highlight");
    setTimeout(() => bubble.classList.remove("flash-highlight"), 900);

}

/* ============================================================================
   РЕЖИМ ВЫДЕЛЕНИЯ СООБЩЕНИЙ — checkbox поверх каждого сообщения (рисуется
   CSS-псевдоэлементом, см. #messages.selection-mode в style.css), панель
   действий сверху вместо закреплённого сообщения (см. #selection-bar).
   ========================================================================= */

let selectionMode = false;
let selectedMessageIds = new Set();

function contextMenuSelect() {

    const messageId = contextMenuTargetRow?.dataset.messageId;
    document.getElementById("message-context-menu").hidden = true;

    enterSelectionMode();
    if (messageId) toggleMessageSelection(messageId);

}

function enterSelectionMode() {

    if (selectionMode) return;
    selectionMode = true;
    selectedMessageIds.clear();

    document.getElementById("messages").classList.add("selection-mode");
    document.getElementById("selection-bar").hidden = false;
    document.getElementById("pinned-bar").hidden = true;

    updateSelectionBar();

}

function exitSelectionMode() {

    if (!selectionMode) return;
    selectionMode = false;
    selectedMessageIds.clear();

    document.getElementById("messages").classList.remove("selection-mode");
    document.querySelectorAll(".message-row.selected").forEach((row) => row.classList.remove("selected"));
    document.getElementById("selection-bar").hidden = true;

    renderPinnedBar();

}

function toggleMessageSelection(messageId) {

    const row = document.querySelector(`.message-row[data-message-id="${messageId}"]`);
    if (!row) return;

    if (selectedMessageIds.has(messageId)) {
        selectedMessageIds.delete(messageId);
        row.classList.remove("selected");
    } else {
        selectedMessageIds.add(messageId);
        row.classList.add("selected");
    }

    updateSelectionBar();

}

function updateSelectionBar() {
    const count = selectedMessageIds.size;
    document.getElementById("selection-bar-count").textContent = count === 0 ? "Выберите сообщения" : `${count} выбрано`;
}

function forwardSelectedMessages() {
    if (!selectedMessageIds.size) { toast("Выберите хотя бы одно сообщение"); return; }
    openForwardPopover([...selectedMessageIds]);
}

function deleteSelectedMessages() {
    if (!selectedMessageIds.size) { toast("Выберите хотя бы одно сообщение"); return; }
    openDeleteChoiceModal([...selectedMessageIds]);
}

document.getElementById("messages").addEventListener("click", (event) => {

    if (!selectionMode) return;

    const row = event.target.closest(".message-row");
    if (!row?.dataset.messageId) return;

    event.preventDefault();
    event.stopPropagation();
    toggleMessageSelection(row.dataset.messageId);

});

let forwardMessageIds = [];

// messageId — одно сообщение (из контекстного меню) или массив (из режима
// выделения, см. forwardSelectedMessages).
function openForwardPopover(messageId) {

    if (currentChatIsSecret) {
        toast("Пересылка из секретных чатов недоступна");
        return;
    }

    forwardMessageIds = Array.isArray(messageId) ? messageId : [messageId];
    const popover = document.getElementById("forward-popover");
    const list = document.getElementById("forward-popover-list");

    // Секретные чаты нельзя предложить как ЦЕЛЬ пересылки: forwardRealMessage
    // ниже отправляет через обычный sendMessage (открытым текстом), а
    // секретный чат ожидает шифротекст — без этого фильтра пересылка ТУДА
    // молча записала бы читаемый текст в чат, который выглядит защищённым.
    const targets = cachedChatRows.filter((row) => !row.chats.is_secret);

    list.innerHTML = targets.map((row) => {
        const chat = row.chats;
        const other = row.otherUser;
        const isSavedMessages = chat.type !== "group" && !other;
        const name = chat.type === "group"
            ? (chat.title || "Группа")
            : isSavedMessages ? "Избранное" : (loadContactAlias(other?.id) || other?.display_name || "Пользователь");
        return `
            <button class="new-chat-result-row" type="button" onclick="forwardRealMessage('${chat.id}')">
                <span class="new-chat-result-avatar${isSavedMessages ? " chat-avatar-saved" : ""}">${isSavedMessages ? "🔖" : "👤"}</span>
                <span>${escapeHTML(name)}</span>
            </button>
        `;
    }).join("") || `<div class="new-chat-result-empty">Нет других чатов, чтобы переслать</div>`;

    popover.classList.add("open");
    popover.setAttribute("aria-hidden", "false");

}

function closeForwardPopover() {
    const popover = document.getElementById("forward-popover");
    popover.classList.remove("open");
    popover.setAttribute("aria-hidden", "true");
    forwardMessageIds = [];
}

async function forwardRealMessage(targetChatId) {

    const ids = forwardMessageIds;
    closeForwardPopover();
    exitSelectionMode();

    const messages = ids.map((id) => realMessagesById.get(id)).filter((m) => m && !m.deleted_at);
    if (!messages.length) return;

    // Защита на случай прямого вызова в обход openForwardPopover (там
    // секретные чаты уже отфильтрованы из списка целей) — см. комментарий
    // там же про то, почему пересылка ТУДА обычным sendMessage опасна.
    const targetChat = cachedChatRows.find((row) => row.chat_id === targetChatId)?.chats;
    if (targetChat?.is_secret) {
        toast("Пересылка в секретные чаты недоступна");
        return;
    }

    // Реальная отправка откладывается на 3 секунды — окно для "Отмена"
    // на случай ошибочной пересылки (адресату ничего не долетает, пока
    // не истекло время или пока явно не подтвердили продолжением работы
    // в чате — см. ниже про settled).
    toastWithUndo(
        messages.length > 1 ? `Переслано сообщений: ${messages.length}` : "Сообщение переслано",
        async (undone) => {
            if (undone) return;
            try {
                let lastSent;
                for (const message of messages) {
                    // Раньше пересылался только type + text: фото, голосовые, файлы и
                    // опросы приходили адресату пустыми «битыми» сообщениями.
                    const meta = { ...(message.attachment_meta || {}) };
                    delete meta.reply_excerpt;
                    delete meta.effect;
                    if (!meta.forwarded_from) {
                        const author = message.sender_id === myRealUserId
                            ? (cachedMyProfile?.display_name || "Вы")
                            : (currentChatMembersById.get(message.sender_id)?.display_name || (currentChatType !== "group" ? currentChatTitle : "") || "Участник");
                        meta.forwarded_from = author;
                    }
                    lastSent = await KabanAPI.sendMessage(targetChatId, {
                        type: message.type,
                        text: message.text,
                        attachmentUrl: message.attachment_url || null,
                        attachmentMeta: meta
                    });
                }
                // targetChatId всегда уже есть в cachedChatRows (это цели из уже
                // загруженного списка чатов, см. targetChat выше) — полный
                // loadChatList() тут был чистым лишним походом на сервер.
                if (lastSent) patchCachedChatLastMessage(targetChatId, lastSent);
            } catch (error) {
                toast("Не удалось переслать: " + (error?.message || error));
            }
        }
    );

}

// Двойной клик по сообщению — мгновенная реакция ❤️, десктопный аналог
// свайпа/долгого тапа на телефоне.
document.getElementById("messages").addEventListener("dblclick", (event) => {

    if (event.target.closest("button")) return; // не мешаем двойному клику по кнопкам внутри

    const row = event.target.closest(".message-row");
    if (!row || selectionMode) return;
    // Служебные плашки, ещё не отправленные и удалённые — реакцию ставить не на что.
    if (row.classList.contains("system-message") || row.classList.contains("pending") || row.classList.contains("deleted")) return;

    react(row, "❤️");

});


/* ============================================================================
   DRAG-AND-DROP ФАЙЛОВ: перетаскивание файла из системы прямо в окно чата —
   вместо обязательного похода через меню "+". Сама отправка идёт через уже
   существующий обработчик выбора файла, просто без диалога открытия файла.
   ========================================================================= */

let dragCounter = 0;

window.addEventListener("dragenter", (event) => {

    if (!event.dataTransfer?.types?.includes("Files")) return;
    if (!document.body.classList.contains("chat-selected")) return;

    dragCounter += 1;
    document.getElementById("drop-overlay").classList.add("active");

});

window.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
});

window.addEventListener("dragleave", () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
        document.getElementById("drop-overlay").classList.remove("active");
    }
});

window.addEventListener("drop", (event) => {

    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();

    dragCounter = 0;
    document.getElementById("drop-overlay").classList.remove("active");

    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    const kind = file.type.startsWith("image/") || file.type.startsWith("video/") ? "media" : "document";
    handleAttachFile({ files: [file] }, kind);

});



/* ============================================================================
   ОПРОСЫ. Сообщение: type "text", text = "📊 вопрос" (старые клиенты увидят
   это), attachment_meta.poll = { question, options[], multiple }. Голос — строка
   в reactions с emoji "poll:0,2" (см. KabanAPI.setPollVote): отдельной схемы не
   нужно, обновления приходят тем же realtime, что и реакции.
   ========================================================================= */

const POLL_MAX_OPTIONS = 10;

// attachment_meta задаёт отправитель — приводим опрос к безопасному виду (массив строк,
// не больше POLL_MAX_OPTIONS), иначе «кривой» опрос ломал бы отрисовку всего чата.
function normalizedPoll(message) {
    const raw = message.attachment_meta?.poll || {};
    const options = (Array.isArray(raw.options) ? raw.options : []).slice(0, POLL_MAX_OPTIONS).map((o) => String(o ?? ""));
    return { question: String(raw.question ?? ""), options, multiple: !!raw.multiple };
}

function pollStats(message) {

    const poll = normalizedPoll(message);
    const counts = new Array(poll.options.length).fill(0);
    let voters = 0;
    const mine = new Set();

    (message.reactions || []).forEach((r) => {
        const emoji = String(r.emoji);
        if (!emoji.startsWith("poll:")) return;
        // Голос пишется напрямую в базу: повторы («0,0,0») и несколько вариантов в опросе
        // с одним ответом не должны накручивать счётчики.
        let indices = [...new Set(emoji.slice(5).split(",").map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < counts.length))];
        if (!poll.multiple) indices = indices.slice(0, 1);
        if (!indices.length) return;
        voters++;
        indices.forEach((i) => { counts[i]++; if (r.user_id === myRealUserId) mine.add(i); });
    });

    return { counts, voters, mine };

}

function buildPollInnerHTML(message) {

    const poll = normalizedPoll(message);
    const { counts, voters, mine } = pollStats(message);
    const maxCount = Math.max(1, ...counts);

    const options = poll.options.map((option, index) => {
        const percent = voters ? Math.round((counts[index] / voters) * 100) : 0;
        const voted = mine.has(index);
        return `
        <button type="button" class="poll-option${voted ? " voted" : ""}${counts[index] === maxCount && voters ? " leading" : ""}" data-index="${index}" onclick="votePoll(this.closest('.message-row').dataset.messageId, ${index})">
            <span class="poll-bar" style="width:${percent}%"></span>
            <span class="poll-check${poll.multiple ? " square" : ""}" aria-hidden="true">${voted ? "✓" : ""}</span>
            <span class="poll-text">${escapeHTML(option)}</span>
            <span class="poll-pct">${voters ? percent + "%" : ""}</span>
        </button>`;
    }).join("");

    return `
        <div class="poll-question">${escapeHTML(poll.question)}</div>
        <div class="poll-sub">${poll.multiple ? "Можно выбрать несколько ответов" : "Один ответ"}</div>
        <div class="poll-options">${options}</div>
        <div class="poll-total">${voters ? `${voters} ${pluralRu(voters, "голос", "голоса", "голосов")}` : "Пока никто не проголосовал"}</div>`;

}

function buildPollHTML(message) {
    return `<div class="poll-card">${buildPollInnerHTML(message)}</div>`;
}

function updatePollRow(messageId) {
    const message = realMessagesById.get(messageId);
    const card = document.querySelector(`.message-row[data-message-id="${messageId}"] .poll-card`);
    if (!message?.attachment_meta?.poll || !card) return;
    card.innerHTML = buildPollInnerHTML(message);
}

async function votePoll(messageId, index) {

    const message = realMessagesById.get(messageId);
    if (!message?.attachment_meta?.poll) return;

    const poll = message.attachment_meta.poll;
    const { mine } = pollStats(message);
    const next = new Set(mine);

    if (poll.multiple) {
        if (next.has(index)) next.delete(index); else next.add(index);
    } else if (next.has(index)) {
        next.clear(); // повторное нажатие снимает голос
    } else {
        next.clear();
        next.add(index);
    }

    const before = message.reactions || [];
    message.reactions = before.filter((r) => r.user_id !== myRealUserId);
    if (next.size) message.reactions.push({ user_id: myRealUserId, emoji: "poll:" + [...next].sort((a, b) => a - b).join(",") });
    updatePollRow(messageId);

    try {
        await KabanAPI.setPollVote(messageId, [...next]);
    } catch (error) {
        message.reactions = before;
        updatePollRow(messageId);
        toast("Не удалось проголосовать: " + (error?.message || error));
    }

}

/* ---- создание опроса ---------------------------------------------------- */

function openPollModal() {

    closeAttachMenu();

    if (!currentChatId) { toast("Откройте чат, чтобы создать опрос"); return; }
    if (currentChatIsSecret) { toast("В секретных чатах опросы не поддерживаются"); return; }
    if (currentChatType === "group" && !groupMayAttach()) { toast("В этой группе вам нельзя отправлять такие сообщения"); return; }

    document.getElementById("poll-question-input").value = "";
    document.getElementById("poll-multiple-input").checked = false;
    const list = document.getElementById("poll-options-list");
    list.innerHTML = "";
    addPollOption();
    addPollOption();

    const backdrop = document.getElementById("poll-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("poll-question-input").focus();

}

function closePollModal() {
    const backdrop = document.getElementById("poll-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function addPollOption() {

    const list = document.getElementById("poll-options-list");
    if (list.children.length >= POLL_MAX_OPTIONS) return;

    const row = document.createElement("div");
    row.className = "poll-option-row";
    row.innerHTML = `
        <input type="text" class="poll-option-input" maxlength="100" placeholder="Вариант ${list.children.length + 1}">
        <button type="button" class="poll-option-remove" aria-label="Убрать вариант" onclick="removePollOption(this)">×</button>`;
    list.appendChild(row);
    syncPollModalState();

}

function removePollOption(button) {
    const list = document.getElementById("poll-options-list");
    if (list.children.length <= 2) return;
    button.closest(".poll-option-row").remove();
    list.querySelectorAll(".poll-option-input").forEach((input, i) => { input.placeholder = `Вариант ${i + 1}`; });
    syncPollModalState();
}

function syncPollModalState() {
    const count = document.getElementById("poll-options-list").children.length;
    document.getElementById("poll-add-option").hidden = count >= POLL_MAX_OPTIONS;
    document.querySelectorAll(".poll-option-remove").forEach((button) => { button.hidden = count <= 2; });
}

async function createPoll() {

    const question = document.getElementById("poll-question-input").value.trim();
    const options = [...document.querySelectorAll(".poll-option-input")].map((input) => input.value.trim()).filter(Boolean);
    const multiple = document.getElementById("poll-multiple-input").checked;

    if (!question) { toast("Введите вопрос"); return; }
    if (options.length < 2) { toast("Нужно хотя бы два варианта ответа"); return; }
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) { toast("Варианты не должны повторяться"); return; }

    const targetChatId = currentChatId;
    closePollModal();

    let message;
    try {
        message = await KabanAPI.sendMessage(targetChatId, {
            type: "text",
            text: "📊 " + question,
            attachmentMeta: { poll: { question, options, multiple } }
        });
    } catch (error) {
        toast("Не удалось создать опрос: " + (error?.message || error));
        return;
    }

    realMessagesById.set(message.id, message);
    if (currentChatId === targetChatId) {
        appendRealMessageRow(message, true);
        updateMessageGrouping();
        if (appSettings.sendSound) playSendSound();
        if (appSettings.autoScroll) scrollMessagesToBottom();
    }
    patchCachedChatLastMessage(targetChatId, message);

}

/* ---- список всех закреплённых ------------------------------------------- */

const MESSAGE_TYPE_LABELS = {
    image: "🖼 Фото", video: "🎞 Видео", voice: "🎙 Голосовое сообщение", video_note: "⏺ Видеокружок",
    audio: "🎵 Музыка", document: "📄 Документ", location: "📍 Геопозиция", contact: "👤 Контакт"
};

function messagePreviewText(message) {
    if (message.attachment_meta?.poll) return "📊 " + message.attachment_meta.poll.question;
    if (message.type === "text") return message.text || "Сообщение";
    const label = MESSAGE_TYPE_LABELS[message.type] || "Вложение";
    const name = message.attachment_meta?.name;
    return name ? `${label}: ${name}` : label;
}

function openPinnedList() {

    const pinned = getPinnedMessages();
    if (!pinned.length) return;

    document.getElementById("pinned-list-title").textContent = `Закреплённые сообщения · ${pinned.length}`;

    document.getElementById("pinned-list").innerHTML = pinned.map((message) => {
        const mine = message.sender_id === myRealUserId;
        const author = mine ? "Вы" : (currentChatMembersById.get(message.sender_id)?.display_name || currentChatTitle || "Собеседник");
        const when = new Date(message.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        return `
        <div class="pinned-list-row" role="button" tabindex="0" data-message-id="${message.id}" onclick="jumpToPinned(this.dataset.messageId)" onkeydown="if (event.key === 'Enter') jumpToPinned(this.dataset.messageId)">
            <span class="pinned-list-copy">
                <span class="pinned-list-meta">${escapeHTML(author)} · ${escapeHTML(when)}</span>
                <span class="pinned-list-text">${escapeHTML(messagePreviewText(message))}</span>
            </span>
            <button type="button" class="pinned-list-unpin" data-message-id="${message.id}" onclick="event.stopPropagation(); unpinFromList(this.dataset.messageId)" aria-label="Открепить" title="Открепить">✕</button>
        </div>`;
    }).join("");

    const backdrop = document.getElementById("pinned-list-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closePinnedList() {
    const backdrop = document.getElementById("pinned-list-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function jumpToPinned(messageId) {
    closePinnedList();
    const index = getPinnedMessages().findIndex((m) => m.id === messageId);
    if (index >= 0) pinnedBarIndex = index;
    renderPinnedBar();
    flashMessage(messageId);
}

async function unpinFromList(messageId) {
    await togglePinMessage(messageId, false);
    if (getPinnedMessages().length) openPinnedList(); else closePinnedList();
}