/* ============================================================================
   РЕАКЦИИ НА СООБЩЕНИЯ — дизайн и анимации. Загружается после остальных
   скриптов и переопределяет renderReactionsInto / reactReal /
   renderContextReactRow (последнее объявление выигрывает).
   • Чипы под сообщением: пилюля с эмодзи и счётчиком; чипы не пересоздаются,
     а сверяются с данными (появление — «пружина», счётчик «подпрыгивает», уход —
     сжатие). Наведение оживляет эмодзи; долгое нажатие / правый клик — кто
     поставил.
   • Кнопка «+ реакция» у пузыря при наведении (десктоп) и плавающая панель с
     анимированными эмодзи; панель в контекстном меню.
   • «Взрыв» реакции: крупное анимированное эмодзи с искрами над сообщением —
     при своей реакции, при чужой (мягче) и при двойном клике (на месте клика).
   Хранение прежнее: одна реакция на пользователя и сообщение (reactions).
   ========================================================================= */

const REACTION_BAR_DEFAULTS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "🎉"];

// Строка реакции пользователя хранит набор через "|" — см. KabanAPI.setMyReactions.
const MAX_REACTIONS_PER_USER = 6;

function splitReactionEmojis(raw) {
    const value = String(raw || "");
    if (/^(poll|game):/.test(value)) return [];
    // Строку пишет любой участник напрямую в базу — пропускаем только короткие «эмодзи» без HTML.
    return value.split("|").map((e) => e.trim()).filter((e) => e && e.length <= 16 && !/[<>"'&]/.test(e)).slice(0, MAX_REACTIONS_PER_USER);
}

function myReactionEmojis(message) {
    const mine = (message?.reactions || []).find((r) => r.user_id === myRealUserId);
    return splitReactionEmojis(mine?.emoji);
}

function reactionBarEmojis() {
    const out = [];
    [...getRecentReactions().slice(0, 4), ...REACTION_BAR_DEFAULTS].forEach((emoji) => {
        if (!out.includes(emoji) && out.length < 7) out.push(emoji);
    });
    return out;
}

function reactionUserName(userId) {
    if (userId === myRealUserId) return "Вы";
    return currentChatMembersById.get(userId)?.display_name
        || cachedChatRows.find((r) => r.chat_id === currentChatId)?.otherUser?.display_name
        || "Участник";
}

function vibrateTap() {
    try { if (navigator.vibrate) navigator.vibrate(8); } catch { /* не поддерживается */ }
}

/* ---- чипы ------------------------------------------------------------------- */

function createReactionChip(emoji) {

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reaction-chip entering";
    chip.dataset.emoji = emoji;
    // Эмодзи в чипе сразу анимированное (если анимация есть): два прогона и пауза в конечной позе;
    // повторно проигрывается при наведении и нажатии.
    chip.innerHTML = `<span class="rc-emoji">${animEmojiHTML(emoji, "", 2)}</span>`;
    chip.addEventListener("animationend", (event) => { if (event.target === chip) chip.classList.remove("entering"); });

    chip.addEventListener("click", () => {
        if (chip._longPressed) { chip._longPressed = false; return; }
        vibrateTap();
        react(chip, emoji);
    });

    // Кто поставил: правый клик или долгое нажатие.
    chip.addEventListener("contextmenu", (event) => { event.preventDefault(); event.stopPropagation(); showReactionWho(chip); });

    let pressTimer = null;
    chip.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse") return;
        chip._longPressed = false;
        pressTimer = setTimeout(() => { chip._longPressed = true; showReactionWho(chip); }, 450);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((type) => chip.addEventListener(type, () => clearTimeout(pressTimer)));

    // Повтор анимации: при наведении (десктоп) и при нажатии.
    const replay = () => {
        const inner = chip.querySelector(".anim-emoji");
        if (!inner || !inner.dataset.anim) return;
        inner._animPlayed = 0;
        inner._animDone = false;
        if (inner._anim) inner._anim.goToAndPlay(0, true);
        else startAnimEmoji(inner);   // после двух прогонов экземпляр освобождён — создаём заново
    };
    chip.addEventListener("pointerenter", (event) => { if (event.pointerType !== "touch") replay(); });
    chip.addEventListener("click", replay);

    return chip;

}

function renderReactionsInto(container, reactions, myId) {

    const groups = new Map();
    // Голоса опросов и ходы игр лежат в той же таблице, но реакциями не показываются.
    (reactions || []).forEach((r) => {
        splitReactionEmojis(r.emoji).forEach((emoji) => {
            if (!groups.has(emoji)) groups.set(emoji, { count: 0, mine: false, users: [] });
            const g = groups.get(emoji);
            g.count += 1;
            g.users.push(r.user_id);
            if (r.user_id === myId) g.mine = true;
        });
    });

    const row = container.closest(".message-row");
    const existing = new Map();
    [...container.children].forEach((child) => {
        if (child.classList.contains("reaction-chip") && !child.classList.contains("leaving")) existing.set(child.dataset.emoji, child);
    });

    // Ушедшие реакции — сжимаются и убираются.
    existing.forEach((chip, emoji) => {
        if (groups.has(emoji)) return;
        chip.classList.add("leaving");
        const remove = () => { chip.remove(); if (row && !container.querySelector(".reaction-chip")) row.classList.remove("has-reactions"); };
        chip.addEventListener("animationend", (event) => { if (event.target === chip) remove(); });
        setTimeout(remove, 320);
    });

    if (!groups.size) return;
    row?.classList.add("has-reactions");

    groups.forEach((group, emoji) => {

        let chip = existing.get(emoji);
        if (!chip) { chip = createReactionChip(emoji); container.appendChild(chip); }

        chip.classList.toggle("active", group.mine);
        chip._users = group.users;
        chip.setAttribute("aria-label", `${emoji} ${group.count}${group.mine ? ", ваша реакция — нажмите, чтобы убрать" : ""}`);
        chip.title = group.users.map(reactionUserName).join(", ");

        let countEl = chip.querySelector(".reaction-count");
        if (group.count > 1) {
            if (!countEl) {
                countEl = document.createElement("span");
                countEl.className = "reaction-count";
                chip.appendChild(countEl);
            }
            if (countEl.textContent !== String(group.count)) {
                countEl.textContent = String(group.count);
                countEl.classList.remove("bump");
                void countEl.offsetWidth;
                countEl.classList.add("bump");
            }
        } else if (countEl) {
            countEl.remove();
        }

    });

}

/* ---- «кто поставил» -------------------------------------------------------- */

function closeReactionWho() { document.getElementById("reaction-who")?.remove(); }

function showReactionWho(chip) {

    closeReactionWho();
    const users = chip._users || [];
    if (!users.length) return;

    const card = document.createElement("div");
    card.id = "reaction-who";
    card.className = "reaction-who";
    card.innerHTML = `
        <div class="reaction-who-head"><span class="reaction-who-emoji">${escapeHTML(chip.dataset.emoji)}</span><span>${users.length} ${pluralRu(users.length, "реакция", "реакции", "реакций")}</span></div>
        ${users.slice(0, 12).map((id) => {
            const name = reactionUserName(id);
            return `<div class="reaction-who-row"><span class="reaction-who-avatar">${escapeHTML(name.trim().charAt(0).toUpperCase())}</span><span>${escapeHTML(name)}</span></div>`;
        }).join("")}
        ${users.length > 12 ? `<div class="reaction-who-more">и ещё ${users.length - 12}</div>` : ""}`;
    document.body.appendChild(card);

    const rect = chip.getBoundingClientRect();
    const width = card.offsetWidth, height = card.offsetHeight;
    card.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)) + "px";
    card.style.top = (rect.top - height - 8 > 8 ? rect.top - height - 8 : rect.bottom + 8) + "px";
    requestAnimationFrame(() => card.classList.add("open"));

}

document.addEventListener("pointerdown", (event) => { if (!event.target.closest("#reaction-who")) closeReactionWho(); }, true);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeReactionWho(); closeReactionBar(); } });
document.getElementById("messages")?.addEventListener("scroll", () => { closeReactionWho(); closeReactionBar(); }, { passive: true });

/* ---- «взрыв» реакции ------------------------------------------------------------ */

// Крупное анимированное эмодзи над сообщением (или в точке клика) + искры.
function playReactionBurst(row, emoji, options = {}) {

    if (appSettings.reduceMotion || document.hidden) return;

    let x = options.x, y = options.y;
    if (x == null) {
        const bubble = row?.querySelector(".message");
        if (!bubble) return;
        const rect = bubble.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > window.innerHeight) return;
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
    }

    const light = !!options.light;
    const burst = document.createElement("div");
    burst.className = "reaction-burst" + (light ? " light" : "");
    burst.style.left = x + "px";
    burst.style.top = y + "px";
    burst.style.fontSize = (light ? 54 : 96) + "px";

    const sparks = Array.from({ length: light ? 5 : 9 }, (_, i) => {
        const angle = (i / (light ? 5 : 9)) * Math.PI * 2 + Math.random() * 0.5;
        const distance = (light ? 46 : 84) + Math.random() * 34;
        return `<span class="reaction-spark" style="--dx:${Math.round(Math.cos(angle) * distance)}px;--dy:${Math.round(Math.sin(angle) * distance)}px;animation-delay:${Math.round(Math.random() * 90)}ms">${escapeHTML(emoji)}</span>`;
    }).join("");

    burst.innerHTML = `<span class="reaction-burst-main">${animEmojiHTML(emoji)}</span>${sparks}`;
    document.body.appendChild(burst);
    const anim = burst.querySelector(".anim-emoji");
    if (anim) registerAnimEmoji(anim);

    setTimeout(() => { if (anim) releaseAnimEmoji(anim); burst.remove(); }, light ? 1250 : 1600);

}

/* ---- реакция: логика отправки (как раньше + взрыв) -------------------------------- */

async function reactReal(row, messageId, emoji) {

    const message = realMessagesById.get(messageId);
    if (!message) return;

    if (message.attachment_meta?.poll) { toast("К опросу нельзя добавить реакцию — проголосуйте за вариант"); return; }
    if (message.attachment_meta?.game) { toast("К игре нельзя добавить реакцию"); return; }

    const current = myReactionEmojis(message);
    const removing = current.includes(emoji);
    if (!removing && current.length >= MAX_REACTIONS_PER_USER) {
        toast(`Можно поставить не больше ${MAX_REACTIONS_PER_USER} реакций на одно сообщение`);
        return;
    }
    const next = removing ? current.filter((e) => e !== emoji) : [...current, emoji];
    const reactionsBefore = message.reactions || [];

    message.reactions = reactionsBefore.filter((r) => r.user_id !== myRealUserId);
    if (next.length) message.reactions.push({ user_id: myRealUserId, emoji: next.join("|") });

    renderReactionsInto(row.querySelector(".message-reactions"), message.reactions, myRealUserId);
    if (!removing) {
        const point = dblClickPoint && Date.now() - dblClickPoint.at < 600 ? dblClickPoint : null;
        dblClickPoint = null;
        playReactionBurst(row, emoji, point ? { x: point.x, y: point.y } : {});
        vibrateTap();
    }

    // Быстрые клики по нескольким эмодзи подряд раньше уходили параллельными
    // запросами, и более старый мог прийти на сервер последним — итоговый набор
    // реакций откатывался. Теперь запросы по сообщению идут строго по очереди, а
    // промежуточные состояния схлопываются в последнее.
    queueReactionWrite(messageId, next, emoji);

}

const reactionWriteQueue = new Map(); // messageId → { running, next, lastEmoji }

function queueReactionWrite(messageId, emojis, emoji) {
    const entry = reactionWriteQueue.get(messageId) || { running: false, next: null };
    entry.next = emojis;
    entry.lastEmoji = emoji;
    reactionWriteQueue.set(messageId, entry);
    if (entry.running) return;
    entry.running = true;
    (async () => {
        while (entry.next) {
            const target = entry.next;
            entry.next = null;
            try {
                await KabanAPI.setMyReactions(messageId, target);
            } catch (error) {
                toast("Не удалось поставить реакцию: " + (error?.message || error));
                // Откатываем только СВОЮ строку — чужие реакции, пришедшие тем временем, не трогаем.
                const message = realMessagesById.get(messageId);
                if (message) {
                    message.reactions = (message.reactions || []).filter((r) => r.user_id !== myRealUserId);
                    const row = document.querySelector(`#messages .message-row[data-message-id="${messageId}"] .message-reactions`);
                    if (row) renderReactionsInto(row, message.reactions, myRealUserId);
                }
                entry.next = null;
            }
        }
        entry.running = false;
        reactionWriteQueue.delete(messageId);
    })();
}

// Двойной клик по сообщению (быстрое ❤️): запоминаем точку клика в фазе
// перехвата (она срабатывает раньше обычного слушателя, который ставит
// реакцию) — тогда reactReal вылетит сердцем именно оттуда.
let dblClickPoint = null;
document.getElementById("messages")?.addEventListener("dblclick", (event) => {
    dblClickPoint = { x: event.clientX, y: event.clientY, at: Date.now() };
}, true);
/* ---- панель реакций (hover-кнопка и плавающая панель) ------------------------------ */

let reactionBarRow = null;

function closeReactionBar() {
    const bar = document.getElementById("reaction-bar");
    if (!bar) return;
    bar.querySelectorAll(".anim-emoji").forEach(releaseAnimEmoji);
    bar.remove();
    reactionBarRow = null;
}

function openReactionBar(row) {

    closeReactionBar();
    closeReactionWho();

    const bubble = row.querySelector(".message");
    if (!bubble) return;

    reactionBarRow = row;
    contextMenuTargetRow = row; // полный пикер «+» опирается на эту строку
    const rect = bubble.getBoundingClientRect();
    reactionPickerAnchor = { rect, isSent: row.classList.contains("sent") };
    lastContextMenuX = rect.left;
    lastContextMenuY = rect.bottom;

    const message = realMessagesById.get(row.dataset.messageId);
    const mine = new Set(myReactionEmojis(message));

    const bar = document.createElement("div");
    bar.id = "reaction-bar";
    bar.className = "reaction-bar";
    bar.innerHTML = reactionBarEmojis().map((emoji, i) => `
        <button type="button" class="rb-btn${mine.has(emoji) ? " active" : ""}" data-e="${emoji}" style="--i:${i}" aria-label="Реакция ${emoji}">${animEmojiHTML(emoji)}</button>`).join("")
        + `<button type="button" class="rb-more" style="--i:7" aria-label="Все реакции"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
    document.body.appendChild(bar);

    const width = bar.offsetWidth, height = bar.offsetHeight;
    const isSent = row.classList.contains("sent");
    let left = isSent ? rect.right - width : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = rect.top - height - 8;
    if (top < 8) top = rect.bottom + 8;
    bar.style.left = left + "px";
    bar.style.top = top + "px";
    requestAnimationFrame(() => bar.classList.add("open"));
    bar.querySelectorAll(".anim-emoji").forEach(registerAnimEmoji);

    bar.addEventListener("click", (event) => {
        const pick = event.target.closest(".rb-btn");
        if (pick) {
            const emoji = pick.dataset.e;
            pushRecentReaction(emoji);
            const targetRow = reactionBarRow;
            closeReactionBar();
            if (targetRow) react(targetRow, emoji);
            return;
        }
        if (event.target.closest(".rb-more")) {
            closeReactionBar();
            // Настоящее событие: openReactionPickerPopover гасит всплытие, иначе
            // глобальный обработчик клика сразу закрыл бы только что открытый пикер.
            openReactionPickerPopover(event);
        }
    });

}

document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#reaction-bar, #react-hover-btn")) closeReactionBar();
}, true);

(function initReactionHoverButton() {

    const messages = document.getElementById("messages");
    if (!messages) return;

    const button = document.createElement("button");
    button.type = "button";
    button.id = "react-hover-btn";
    button.className = "react-hover-btn";
    button.hidden = true;
    button.setAttribute("aria-label", "Добавить реакцию");
    button.title = "Добавить реакцию";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="12" r="7.5"/><path d="M8.5 14c.7 1 1.6 1.5 2.5 1.5s1.8-.5 2.5-1.5M9 10.2h.01M13 10.2h.01M19 4v4M17 6h4"/></svg>';
    document.body.appendChild(button);

    let currentRow = null;
    let hideTimer = null;

    const eligible = (row) => {
        if (!row || !row.dataset.messageId || row.classList.contains("deleted") || row.classList.contains("system-message")) return false;
        const message = realMessagesById.get(row.dataset.messageId);
        return !!message && !message.deleted_at && !message.attachment_meta?.poll && !message.attachment_meta?.game && !selectionMode;
    };

    const hide = () => { button.hidden = true; currentRow = null; };
    const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, 220); };

    function place(row) {
        const bubble = row.querySelector(".message");
        if (!bubble) { hide(); return; }
        const rect = bubble.getBoundingClientRect();
        const listRect = messages.getBoundingClientRect();
        const size = 30;
        const isSent = row.classList.contains("sent");
        let left = isSent ? rect.left - size - 6 : rect.right + 6;
        left = Math.max(listRect.left + 4, Math.min(left, listRect.right - size - 4));
        const top = Math.max(listRect.top + 4, Math.min(rect.top + rect.height / 2 - size / 2, listRect.bottom - size - 4));
        button.style.left = left + "px";
        button.style.top = top + "px";
        button.hidden = false;
    }

    messages.addEventListener("pointerover", (event) => {
        if (event.pointerType === "touch") return;
        const row = event.target.closest(".message-row");
        if (!eligible(row)) { scheduleHide(); return; }
        clearTimeout(hideTimer);
        if (row !== currentRow) { currentRow = row; place(row); }
    });

    messages.addEventListener("pointerleave", scheduleHide);
    messages.addEventListener("scroll", hide, { passive: true });
    button.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    button.addEventListener("pointerleave", scheduleHide);

    button.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!currentRow) return;
        const row = currentRow;
        hide();
        openReactionBar(row);
    });

})();

/* ---- ряд реакций в контекстном меню ------------------------------------------------ */

function renderContextReactRow() {

    contextReactRowRendered = true;
    const row = document.getElementById("context-menu-react-row");
    const emojis = [...new Set([...getRecentReactions().slice(0, 6), ...CONTEXT_REACT_EMOJIS])].slice(0, 20);

    // Прежние живые экземпляры освобождаем, потом рисуем заново. Эмодзи сразу
    // анимированные (как в плавающей панели), без подмены при наведении —
    // подмена содержимого под курсором заставляла кнопки дёргаться.
    row.querySelectorAll(".anim-emoji").forEach(releaseAnimEmoji);
    row.innerHTML = emojis.map((e) => `
        <button type="button" data-e="${e}" onclick="contextMenuReact(this.dataset.e)" aria-label="Реакция ${e}">${animEmojiHTML(e)}</button>
    `).join("");
    row.querySelectorAll(".anim-emoji").forEach(registerAnimEmoji);

}
// Меню собирается заново с учётом «недавних» при каждом открытии.


/* ---- полный выбор эмодзи: открывается у сообщения, а не «где получится» ---------------- */

let reactionPickerAnchor = null;

// Рядом с пузырём: под ним, если там хватает места, иначе над ним; по горизонтали
// выровнен по стороне пузыря (свои — по правому краю, чужие — по левому). Если
// открыт из контекстного меню (нет пузыря-якоря) — от точки клика с отражением
// к тем сторонам, где есть место. Размеры берутся из реального окна, а не угаданные.
function openReactionPickerPopover(event) {

    event?.stopPropagation?.();
    document.getElementById("message-context-menu").hidden = true;

    if (!reactionPickerRendered) renderReactionPicker();
    document.getElementById("reaction-picker-search").value = "";
    filterReactionPicker();

    const popover = document.getElementById("reaction-picker-popover");
    const anchor = reactionPickerAnchor;
    reactionPickerAnchor = null;

    const vw = window.innerWidth, vh = window.innerHeight, margin = 10, gap = 10;
    popover.style.maxHeight = Math.max(220, vh - margin * 2) + "px";

    // Сначала «открываем» вне экрана, чтобы измерить настоящие размеры.
    popover.style.left = "-9999px";
    popover.style.top = "0px";
    popover.classList.add("open");
    popover.setAttribute("aria-hidden", "false");
    const width = popover.offsetWidth || 300;
    const height = popover.offsetHeight || 340;

    let left, top, originY = "top";

    if (anchor) {
        const rect = anchor.rect;
        left = anchor.isSent ? rect.right - width : rect.left;
        const below = vh - rect.bottom - gap - margin;
        const above = rect.top - gap - margin;
        if (below >= height) { top = rect.bottom + gap; originY = "top"; }
        else if (above >= height) { top = rect.top - height - gap; originY = "bottom"; }
        else if (below >= above) { top = vh - height - margin; originY = "top"; }
        else { top = margin; originY = "bottom"; }
    } else {
        left = lastContextMenuX;
        top = lastContextMenuY;
        if (left + width > vw - margin) left = lastContextMenuX - width;
        if (top + height > vh - margin) { top = lastContextMenuY - height; originY = "bottom"; }
    }

    left = Math.max(margin, Math.min(left, vw - width - margin));
    top = Math.max(margin, Math.min(top, vh - height - margin));

    popover.style.left = left + "px";
    popover.style.top = top + "px";
    popover.style.transformOrigin = (anchor?.isSent ? "right " : "left ") + originY;

}