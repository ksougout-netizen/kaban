/* ============================================================================
   Этот файл — одна из частей script.js, разбитого на несколько файлов для
   удобства навигации (раньше был единый файл ~350КБ/8300+ строк). Порядок
   подключения в index.html ВАЖЕН и должен точно совпадать с исходным
   порядком кода — файлы выполняются последовательно, как один конкатенированный
   скрипт, функции между ними не изолированы (нет import/export, всё в общей
   глобальной области видимости, как и раньше).
   ============================================================================ */
/* ============================================================================
   ЭМОДЗИ / СТИКЕРЫ: панель над композером (кнопка со смайликом в поле
   ввода) — вкладка "Эмодзи" вставляет символ в текст на месте курсора,
   вкладка "Стикеры" отправляет сообщение сразу (как в норм мессенджерах).
   Стикеры — крупные одиночные эмодзи: переиспользуют уже готовый режим
   "Крупные эмодзи" (isEmojiOnly), отдельная система рисования не нужна.
   ========================================================================= */

/* ---- АНИМИРОВАННЫЕ ЭМОДЗИ И СТИКЕРЫ ----------------------------------------
   Данные (EMOJI_CATEGORIES, ANIM_EMOJI_RAW, STICKER_PACKS) — в emoji-data.js.
   Анимации — Noto Animated Emoji в формате Lottie (≈30 КБ на эмодзи), рисует
   lottie-web (грузится лениво, только когда первый раз понадобилась анимация).
   Эмодзи без анимации в наборе показывают символ с лёгкой CSS-анимацией, так
   что «живыми» бывают все. Анимация идёт, только пока эмодзи на экране, а
   лишние экземпляры вне экрана освобождаются — лента не тормозит. */

const ANIM_EMOJI_BASE = "https://fonts.gstatic.com/s/e/notoemoji/latest/";
const LOTTIE_SRC = "vendor/lottie_light.min.js?v=5.12.2"; // локальная копия — не зависим от CDN
const ANIM_MAX_INSTANCES = 36;

const ANIM_EMOJI = (() => {
    const map = new Map();
    Object.entries(ANIM_EMOJI_RAW).forEach(([emoji, name]) => map.set(emoji.replace(/\uFE0F/g, ""), name));
    return map;
})();

function animNameFor(emoji) {
    return ANIM_EMOJI.get(String(emoji).replace(/\uFE0F/g, "")) || null;
}

// Составные эмодзи (через ZWJ: 🐻‍❄️, ❤️‍🔥…) нужны шрифту системы: если глифа нет,
// они рассыпаются на отдельные картинки или пустой квадрат. Проверяем шириной
// на canvas — склеенный глиф примерно как один эмодзи, рассыпанный вдвое шире —
// и такие из панелей убираем.
const emojiRenderableCtx = (() => {
    try { return document.createElement("canvas").getContext("2d"); } catch { return null; }
})();

function emojiRenderable(emoji) {
    if (!emoji.includes("\u200D") || !emojiRenderableCtx) return true;
    emojiRenderableCtx.font = "32px sans-serif";
    const whole = emojiRenderableCtx.measureText(emoji).width;
    const first = emojiRenderableCtx.measureText(emoji.split("\u200D")[0]).width;
    return !first || whole < first * 1.5;
}

EMOJI_CATEGORIES.forEach((category) => { category.emojis = category.emojis.filter(emojiRenderable); });

function splitGraphemes(text) {
    try {
        return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
    } catch {
        return Array.from(text);
    }
}

function animatedEmojiEnabled() {
    return appSettings.animatedEmoji !== false && !appSettings.reduceMotion;
}

// Разметка одного эмодзи: символ внутри — всегда (его видно, пока грузится
// анимация, и он копируется как текст); поверх подгружается Lottie.
// loops > 0 — проиграть столько раз и замереть в конечной позе (для чипов
// реакций: видно, что эмодзи «живое», но лента не мельтешит бесконечно).
function animEmojiHTML(emoji, extraClass = "", loops = 0) {
    // emoji может прийти из базы (реакции пишет любой участник напрямую через API) —
    // без экранирования строка вида <img onerror=…> исполнялась бы у всех в чате.
    const safe = escapeHTML(String(emoji ?? ""));
    const name = animNameFor(emoji);
    return `<span class="anim-emoji${name ? "" : " no-lottie"}${extraClass ? " " + extraClass : ""}"${name ? ` data-anim="${name}"` : ""}${name && loops ? ` data-loops="${loops}"` : ""} role="img" aria-label="${safe}"><span class="anim-glyph">${safe}</span></span>`;
}

let lottiePromise = null;
function loadLottie() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (!lottiePromise) {
        lottiePromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = LOTTIE_SRC;
            script.onload = () => resolve(window.lottie);
            script.onerror = () => { lottiePromise = null; reject(new Error("lottie-web")); };
            document.head.appendChild(script);
        });
    }
    return lottiePromise;
}

const animJsonCache = new Map();
function fetchAnimJson(name) {
    if (!animJsonCache.has(name)) {
        animJsonCache.set(name, fetch(`${ANIM_EMOJI_BASE}${name}/lottie.json`)
            .then((response) => { if (!response.ok) throw new Error("no animation"); return response.json(); })
            .catch((error) => { animJsonCache.delete(name); throw error; }));
        // Кэш не растёт бесконечно: разобранные JSON-анимации тяжёлые, держим последние 60.
        if (animJsonCache.size > 60) animJsonCache.delete(animJsonCache.keys().next().value);
    }
    return animJsonCache.get(name);
}

let animActiveCount = 0;

const animObserver = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) startAnimEmoji(entry.target);
            else pauseAnimEmoji(entry.target);
        });
    }, { rootMargin: "60px" })
    : null;

function registerAnimEmoji(el) {
    if (el._animRegistered || !el.dataset.anim) return;
    el._animRegistered = true;
    if (animObserver) animObserver.observe(el);
    else startAnimEmoji(el);
}

async function startAnimEmoji(el) {

    if (!animatedEmojiEnabled() || !el.isConnected || el._animDone) return;
    if (el._anim) { el._anim.play(); return; }
    if (el._animLoading) return;
    el._animLoading = true;

    try {
        const [lottie, data] = await Promise.all([loadLottie(), fetchAnimJson(el.dataset.anim)]);
        if (!el.isConnected || el._anim) return;
        const holder = document.createElement("span");
        holder.className = "anim-canvas";
        el.appendChild(holder);
        const loops = Number(el.dataset.loops) || 0;
        el._anim = lottie.loadAnimation({ container: holder, renderer: "svg", loop: !loops, autoplay: true, animationData: data });
        if (loops) {
            el._animPlayed = 0;
            el._animDone = false;
            el._anim.addEventListener("complete", () => {
                el._animPlayed++;
                if (el._animPlayed < loops) { el._anim.goToAndPlay(0, true); return; }
                // Конечный кадр у части анимаций пустой («вспышка» гаснет), поэтому в покое
                // показываем обычный символ — он всегда на месте.
                el._animDone = true;
                destroyAnimEmoji(el);
            });
        }
        animActiveCount++;
        // Первые кадры многих анимаций «вырастают из ничего» — пока там пусто,
        // остаётся обычный символ, и только потом он уступает место анимации.
        const showWhenVisible = (event) => {
            if (!el._anim || (event.currentTime || 0) < 6) return;
            el.classList.add("anim-ready");
            el._anim.removeEventListener("enterFrame", showWhenVisible);
        };
        el._anim.addEventListener("enterFrame", showWhenVisible);
    } catch {
        el.classList.add("anim-failed");
    } finally {
        el._animLoading = false;
    }

}

function destroyAnimEmoji(el) {
    if (el._anim) { el._anim.destroy(); el._anim = null; animActiveCount = Math.max(0, animActiveCount - 1); }
    el.querySelector(":scope > .anim-canvas")?.remove();
    el.classList.remove("anim-ready");
}

function pauseAnimEmoji(el) {
    if (!el._anim) return;
    el._anim.pause();
    // Много экземпляров — освобождаем те, что ушли с экрана (вернётся символ).
    if (animActiveCount > ANIM_MAX_INSTANCES) destroyAnimEmoji(el);
}

function releaseAnimEmoji(el) {
    destroyAnimEmoji(el);
    if (animObserver) animObserver.unobserve(el);
    el._animRegistered = false;
}

// Следим за контейнером: новые .anim-emoji подключаем, удалённые освобождаем.
function observeAnimEmojiIn(container) {
    if (!container || container._animWatched) return;
    container._animWatched = true;
    const scan = (root) => {
        if (root.nodeType !== 1) return;
        if (root.matches?.(".anim-emoji")) registerAnimEmoji(root);
        root.querySelectorAll?.(".anim-emoji").forEach(registerAnimEmoji);
    };
    scan(container);
    new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach(scan);
            mutation.removedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                if (node.matches?.(".anim-emoji")) releaseAnimEmoji(node);
                node.querySelectorAll?.(".anim-emoji").forEach(releaseAnimEmoji);
            });
        });
    }).observe(container, { childList: true, subtree: true });
}

// Тап/клик по анимированному эмодзи в ленте — проиграть сначала.
document.addEventListener("click", (event) => {
    const el = event.target.closest?.("#messages .anim-emoji");
    if (el?._anim) { el._anim.goToAndPlay(0, true); }
    else if (el && el.classList.contains("no-lottie")) {
        el.classList.remove("poke");
        void el.offsetWidth;
        el.classList.add("poke");
    }
});

// Инлайн-эмодзи внутри обычного текста: заменяем только то, что умеет анимироваться,
// и только в «текстовых» кусках HTML (не внутри тегов); не больше 8 на сообщение.
function animateInlineEmojis(html) {
    if (!animatedEmojiEnabled()) return html;
    let budget = 8;
    const re = /\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;
    return html.split(/(<[^>]*>)/).map((chunk, index) => {
        if (index % 2 === 1 || budget <= 0) return chunk;
        return chunk.replace(re, (emoji) => {
            if (budget <= 0 || !animNameFor(emoji)) return emoji;
            budget--;
            return animEmojiHTML(emoji, "inline");
        });
    }).join("");
}
let emojiPopoverRendered = false;
let activeEmojiTab = "emoji";

function toggleEmojiPopover(event) {
    event?.stopPropagation();
    const popover = document.getElementById("emoji-popover");
    if (popover.classList.contains("open")) {
        closeEmojiPopover();
    } else {
        openEmojiPopover();
    }
}

function openEmojiPopover() {

    if (!emojiPopoverRendered) renderEmojiPopover();

    closeAttachMenu();

    const popover = document.getElementById("emoji-popover");
    popover.classList.add("open");
    popover.setAttribute("aria-hidden", "false");
    document.getElementById("emoji-button").classList.add("is-open");
    document.getElementById("emoji-button").setAttribute("aria-expanded", "true");

}

function closeEmojiPopover() {

    const popover = document.getElementById("emoji-popover");
    popover.classList.remove("open");
    popover.setAttribute("aria-hidden", "true");
    document.getElementById("emoji-button")?.classList.remove("is-open");
    document.getElementById("emoji-button")?.setAttribute("aria-expanded", "false");

}

function switchEmojiTab(tab) {

    activeEmojiTab = tab;

    document.getElementById("emoji-tab-emoji").classList.toggle("active", tab === "emoji");
    document.getElementById("emoji-tab-emoji").setAttribute("aria-selected", String(tab === "emoji"));
    document.getElementById("emoji-tab-stickers").classList.toggle("active", tab === "stickers");
    document.getElementById("emoji-tab-stickers").setAttribute("aria-selected", String(tab === "stickers"));

    document.getElementById("emoji-popover-cats").hidden = tab !== "emoji";
    document.getElementById("emoji-popover-body").hidden = tab !== "emoji";
    document.getElementById("emoji-popover-stickers").hidden = tab !== "stickers";

}

function renderEmojiPopover() {

    emojiPopoverRendered = true;

    const cats = document.getElementById("emoji-popover-cats");
    cats.innerHTML = EMOJI_CATEGORIES.map((cat, index) => `
        <button type="button" class="emoji-popover-cat-btn${index === 0 ? " active" : ""}" data-cat="${cat.id}" title="${cat.label}" onclick="jumpToEmojiCategory('${cat.id}')">${cat.icon}</button>
    `).join("");

    const body = document.getElementById("emoji-popover-body");
    body.innerHTML = EMOJI_CATEGORIES.map((cat) => `
        <div class="emoji-section" id="emoji-section-${cat.id}">
            <div class="emoji-section-label">${cat.label}</div>
            <div class="emoji-grid">
                ${cat.emojis.map((e) => `<button type="button" data-e="${e}" onclick="insertEmojiIntoComposer(this.dataset.e)">${e}</button>`).join("")}
            </div>
        </div>
    `).join("");

    // Секции и кнопки категорий находим ОДИН раз (разметка после рендера не
    // меняется), а не querySelectorAll + spread на каждое scroll-событие
    // (при инерционной прокрутке их десятки в секунду); реагируем раз на
    // кадр и трогаем кнопки только когда категория реально сменилась.
    const emojiSections = [...body.querySelectorAll(".emoji-section")];
    const emojiCatButtons = [...cats.querySelectorAll(".emoji-popover-cat-btn")];
    let emojiScrollFrame = 0;
    let lastActiveCategory = null;

    body.addEventListener("scroll", () => {
        if (emojiScrollFrame) return;
        emojiScrollFrame = requestAnimationFrame(() => {
            emojiScrollFrame = 0;
            const current = emojiSections.find((section) => section.offsetTop - body.scrollTop > -10);
            if (!current) return;
            const currentCat = current.id.replace("emoji-section-", "");
            if (currentCat === lastActiveCategory) return;
            lastActiveCategory = currentCat;
            emojiCatButtons.forEach((btn) => {
                btn.classList.toggle("active", btn.dataset.cat === currentCat);
            });
        });
    });

    // Наведение на эмодзи в сетке — оно оживает (как предпросмотр).
    body.addEventListener("mouseover", (event) => {
        const button = event.target.closest(".emoji-grid button");
        if (!button || button._hovered || !animatedEmojiEnabled()) return;
        const emoji = button.dataset.e;
        if (!animNameFor(emoji)) return;
        button._hovered = true;
        button.innerHTML = animEmojiHTML(emoji);
        registerAnimEmoji(button.firstElementChild);
    });
    body.addEventListener("mouseout", (event) => {
        const button = event.target.closest(".emoji-grid button");
        if (!button || !button._hovered || button.contains(event.relatedTarget)) return;
        button._hovered = false;
        const inner = button.firstElementChild;
        if (inner) releaseAnimEmoji(inner);
        button.textContent = button.dataset.e;
    });

    renderStickerPacks();

}

let activeStickerPack = STICKER_PACKS[0]?.id;

function renderStickerPacks() {

    const stickers = document.getElementById("emoji-popover-stickers");
    stickers.innerHTML = `
        <div class="sticker-packs">
            ${STICKER_PACKS.map((pack) => `<button type="button" class="sticker-pack-btn${pack.id === activeStickerPack ? " active" : ""}" data-pack="${pack.id}" title="${pack.label}" onclick="selectStickerPack('${pack.id}')">${pack.icon}</button>`).join("")}
        </div>
        <div class="sticker-pack-title" id="sticker-pack-title"></div>
        <div class="sticker-grid" id="sticker-grid"></div>
    `;
    fillStickerGrid();

}

function fillStickerGrid() {

    const pack = STICKER_PACKS.find((p) => p.id === activeStickerPack) || STICKER_PACKS[0];
    if (!pack) return;
    document.getElementById("sticker-pack-title").textContent = pack.label;
    const grid = document.getElementById("sticker-grid");
    grid.innerHTML = pack.items.map((e) => `<button type="button" class="sticker-btn" data-e="${e}" onclick="sendStickerMessage(this.dataset.e)">${animEmojiHTML(e)}</button>`).join("");
    grid.scrollTop = 0;
    observeAnimEmojiIn(grid);

}

function selectStickerPack(packId) {
    activeStickerPack = packId;
    document.querySelectorAll(".sticker-pack-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.pack === packId));
    // Старая сетка вынимается из DOM — её анимации освобождаются наблюдателем.
    fillStickerGrid();
}

function jumpToEmojiCategory(catId) {
    document.getElementById(`emoji-section-${catId}`)?.scrollIntoView({ block: "start" });
}

function insertEmojiIntoComposer(emoji) {

    const input = document.getElementById("input");
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;

    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    const cursor = start + emoji.length;
    input.setSelectionRange(cursor, cursor);
    input.focus();

    resizeComposer();
    updateComposerAction();

}

// Флаг на один следующий send() — отличает "отправили стикер" от "просто
// написали текст, который случайно состоит только из эмодзи". Стикеры
// рисуются крупно и без пузыря (см. style.css → .message.sticker),
// обычные эмодзи-сообщения — крупнее обычного текста, но в пузыре
// (см. .message.emoji-only, поменяли по просьбе — раньше выглядело как
// повисшее/недошедшее сообщение).
let pendingStickerSend = false;

function sendStickerMessage(emoji) {

    closeEmojiPopover();

    const input = document.getElementById("input");
    input.value = emoji;
    pendingStickerSend = true;
    send();

}


function formatFileSize(bytes) {

    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;

}


function fileKindIcon(fileName) {

    const ext = fileName.split(".").pop()?.toLowerCase() || "";

    if (["pdf"].includes(ext)) return "📕";
    if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
    if (["doc", "docx"].includes(ext)) return "📝";
    if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
    if (["ppt", "pptx"].includes(ext)) return "📽️";
    return "📄";

}


function handleAttachFile(input, kind) {

    const file = input.files?.[0];
    input.value = "";
    if (!file) return;

    const type = kind === "media"
        ? (file.type.startsWith("video/") ? "video" : "image")
        : (kind === "music" ? "audio" : "document");

    if (currentChatIsSecret) {
        toast("Вложения в секретных чатах пока не поддерживаются");
        return;
    }

    if (currentChatId) {
        sendRealAttachment(file, type);
        return;
    }

    appendFileMessage(type, file);

}


function beginComposedMessageRow() {

    const row = document.createElement("div");
    row.className = "message-row sent";

    const bubble = document.createElement("div");
    bubble.className = "message";

    if (pendingReply) {
        const quote = document.createElement("span");
        quote.className = "message-reply-quote";
        quote.textContent = pendingReply.text;
        bubble.appendChild(quote);
        pendingReply = null;
        document.getElementById("reply-preview").classList.remove("visible");
    }

    return { row, bubble };

}


function finishComposedMessageRow(row, bubble, previewText) {

    const timeText = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = timeText;

    const status = document.createElement("span");
    status.className = "message-status";
    status.dataset.status = "sent";
    status.textContent = "✓";
    time.appendChild(status);

    bubble.appendChild(time);

    row.appendChild(bubble);
    const replyIndicator = document.createElement("span");
    replyIndicator.className = "reply-indicator";
    replyIndicator.setAttribute("aria-hidden", "true");
    replyIndicator.textContent = "↩";
    row.appendChild(replyIndicator);
    row.appendChild(Object.assign(document.createElement("div"), {
        className: "message-reactions"
    }));

    const messages = document.getElementById("messages");
    messages.insertBefore(row, document.getElementById("typing"));
    updateMessageGrouping();
    scheduleReadReceipt(row);

    if (previewText) {
        updateChatListPreview(previewText, timeText);
    }

    if (appSettings.autoScroll) {
        messages.scrollTop = messages.scrollHeight;
    }

    if (appSettings.sendSound) {
        playSendSound();
    }

}


function appendFileMessage(type, file) {

    const { row, bubble } = beginComposedMessageRow();
    const url = URL.createObjectURL(file);

    if (type === "image") {

        const img = document.createElement("img");
        img.className = "message-image";
        img.src = url;
        img.alt = file.name;
        bubble.appendChild(img);

    } else if (type === "video") {

        const video = document.createElement("video");
        video.className = "message-image";
        video.src = url;
        video.controls = true;
        video.playsInline = true;
        video.preload = "metadata";
        bubble.appendChild(video);

    } else if (type === "audio") {

        const audio = document.createElement("audio");
        audio.className = "message-audio";
        audio.src = url;
        audio.controls = true;
        audio.preload = "metadata";
        bubble.appendChild(audio);

        const name = document.createElement("div");
        name.className = "message-file-name";
        name.textContent = file.name;
        bubble.appendChild(name);

    } else {

        const card = document.createElement("div");
        card.className = "message-file";

        const icon = document.createElement("span");
        icon.className = "message-file-icon";
        icon.textContent = fileKindIcon(file.name);

        const copy = document.createElement("div");
        copy.className = "message-file-copy";

        const name = document.createElement("div");
        name.className = "message-file-name";
        name.textContent = file.name;

        const size = document.createElement("div");
        size.className = "message-file-size";
        size.textContent = formatFileSize(file.size);

        copy.append(name, size);
        card.append(icon, copy);
        bubble.appendChild(card);

    }

    const previewByType = {
        image: "🖼️ Фото",
        video: "📹 Видео",
        audio: "🎵 " + file.name,
        document: "📎 " + file.name
    };

    finishComposedMessageRow(row, bubble, previewByType[type] || "📎 Файл");

}


function shareLocationMessage() {

    closeAttachMenu();

    if (currentChatIsSecret) {
        toast("Геопозиция в секретных чатах пока не поддерживается");
        return;
    }

    if (!navigator.geolocation) {
        toast("Геолокация недоступна в этом браузере");
        return;
    }

    toast("Определяем местоположение…");

    navigator.geolocation.getCurrentPosition(
        (position) => {
            if (currentChatId) {
                sendRealLocation(position.coords.latitude, position.coords.longitude);
            } else {
                appendLocationMessage(position.coords.latitude, position.coords.longitude);
            }
        },
        () => {
            toast("Не удалось получить геопозицию — проверьте разрешение в браузере");
        },
        { timeout: 8000 }
    );

}

async function sendRealLocation(lat, lon) {

    closeAttachMenu();
    const replyToId = pendingReply?.messageId || null;
    pendingReply = null;
    document.getElementById("reply-preview").classList.remove("visible");

    let message;
    try {
        message = await KabanAPI.sendMessage(currentChatId, {
            type: "location",
            attachmentMeta: { lat, lon },
            replyToId
        });
    } catch (error) {
        toast("Не удалось отправить геопозицию: " + (error?.message || error));
        return;
    }

    realMessagesById.set(message.id, message);
    appendRealMessageRow(message, true);
    updateMessageGrouping();
    if (appSettings.sendSound) playSendSound();
    if (appSettings.autoScroll) scrollMessagesToBottom();
    patchCachedChatLastMessage(currentChatId, message);

}


function appendLocationMessage(lat, lon) {

    const { row, bubble } = beginComposedMessageRow();

    const card = document.createElement("button");
    card.type = "button";
    card.className = "message-location";
    card.onclick = () => window.open(
        `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
        "_blank",
        "noopener"
    );

    const icon = document.createElement("span");
    icon.className = "message-location-icon";
    icon.textContent = "📍";

    const copy = document.createElement("div");
    copy.className = "message-location-copy";

    const title = document.createElement("div");
    title.className = "message-location-title";
    title.textContent = "Геопозиция";

    const hint = document.createElement("div");
    hint.className = "message-location-hint";
    hint.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    copy.append(title, hint);
    card.append(icon, copy);
    bubble.appendChild(card);

    finishComposedMessageRow(row, bubble, "📍 Геопозиция");

}


function shareOwnContactMessage() {

    closeAttachMenu();

    if (currentChatIsSecret) {
        toast("Обмен контактом в секретных чатах пока не поддерживается");
        return;
    }

    if (currentChatId) {
        sendRealContactShare();
        return;
    }

    const { row, bubble } = beginComposedMessageRow();

    const card = document.createElement("button");
    card.type = "button";
    card.className = "message-contact";
    card.onclick = () => toast("Контакт «Мой профиль» сохранён");

    const icon = document.createElement("span");
    icon.className = "message-contact-icon";
    icon.textContent = "👤";

    const copy = document.createElement("div");
    copy.className = "message-contact-copy";

    const title = document.createElement("div");
    title.className = "message-contact-title";
    title.textContent = "Мой профиль";

    const hint = document.createElement("div");
    hint.className = "message-contact-hint";
    hint.textContent = "Контакт";

    copy.append(title, hint);
    card.append(icon, copy);
    bubble.appendChild(card);

    finishComposedMessageRow(row, bubble, "👤 Контакт: Мой профиль");

}

async function sendRealContactShare() {

    const replyToId = pendingReply?.messageId || null;
    pendingReply = null;
    document.getElementById("reply-preview").classList.remove("visible");

    let message;
    try {
        message = await KabanAPI.sendMessage(currentChatId, {
            type: "contact",
            attachmentMeta: {
                user_id: myRealUserId,
                display_name: cachedMyProfile?.display_name || "Пользователь"
            },
            replyToId
        });
    } catch (error) {
        toast("Не удалось отправить контакт: " + (error?.message || error));
        return;
    }

    realMessagesById.set(message.id, message);
    appendRealMessageRow(message, true);
    updateMessageGrouping();
    if (appSettings.sendSound) playSendSound();
    if (appSettings.autoScroll) scrollMessagesToBottom();
    patchCachedChatLastMessage(currentChatId, message);

}


/* ОТПРАВКА И ОТОБРАЖЕНИЕ СООБЩЕНИЙ */

let pendingReply = null;
// Таймер автоснятия заглушения — свой на КАЖДЫЙ чат (chatId → timeoutId).
// Раньше он был один на всё приложение: заглушил чат A на час, переключился
// в чат B и тоже заглушил на время — старый таймер A молча отменялся, и A
// оставался заглушённым навсегда вместо того, чтобы включиться через час.
const contactMuteTimeouts = new Map();


function send() {

    const input =
        document.getElementById("input");

    const text =
        input.value.trim();

    if (!text) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
        toast(`Сообщение длиннее ${MAX_MESSAGE_LENGTH} символов — сократите текст`);
        return;
    }

    // Открыт настоящий чат (после входа в реальный аккаунт) — отправляем
    // в Supabase, а не рисуем сообщение локально поверх демо-данных.
    if (currentChatId) {
        sendRealMessage(text);
        return;
    }

    const messages =
        document.getElementById("messages");

    const typing =
        document.getElementById("typing");

    const row =
        document.createElement("div");

    row.className =
        "message-row sent";

    const replyMarkup = pendingReply
        ? `<span class="message-reply-quote">${escapeHTML(pendingReply.text)}</span>`
        : "";

    row.innerHTML = `
        <div class="message">
            ${replyMarkup}
            ${escapeHTML(text)}
            <span class="message-time">
                ${new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                })}
                <span class="message-status" data-status="sent">✓</span>
            </span>
        </div>
        <span class="reply-indicator" aria-hidden="true">↩</span>
        <div class="message-reactions"></div>
        <div class="message-tools">
            <div class="quick-reactions-track">
                <button onclick="react(this,'👍')" aria-label="Поставить реакцию 👍">👍</button>
                <button onclick="react(this,'🔥')" aria-label="Поставить реакцию 🔥">🔥</button>
                <button onclick="react(this,'❤️')" aria-label="Поставить реакцию ❤️">❤️</button>
                <button onclick="react(this,'😂')" aria-label="Поставить реакцию 😂">😂</button>
                <button onclick="react(this,'🤣')" aria-label="Поставить реакцию 🤣">🤣</button>
                <button onclick="react(this,'😮')" aria-label="Поставить реакцию 😮">😮</button>
                <button onclick="react(this,'😢')" aria-label="Поставить реакцию 😢">😢</button>
                <button onclick="react(this,'🎉')" aria-label="Поставить реакцию 🎉">🎉</button>
                <button onclick="react(this,'👏')" aria-label="Поставить реакцию 👏">👏</button>
                <button onclick="react(this,'🙏')" aria-label="Поставить реакцию 🙏">🙏</button>
                <button onclick="react(this,'💯')" aria-label="Поставить реакцию 💯">💯</button>
                <button onclick="react(this,'😎')" aria-label="Поставить реакцию 😎">😎</button>
                <button onclick="react(this,'🤔')" aria-label="Поставить реакцию 🤔">🤔</button>
                <button onclick="react(this,'🤩')" aria-label="Поставить реакцию 🤩">🤩</button>
                <button onclick="react(this,'😍')" aria-label="Поставить реакцию 😍">😍</button>
                <button onclick="react(this,'🥳')" aria-label="Поставить реакцию 🥳">🥳</button>
                <button onclick="react(this,'🤝')" aria-label="Поставить реакцию 🤝">🤝</button>
                <button onclick="react(this,'💪')" aria-label="Поставить реакцию 💪">💪</button>
                <button onclick="react(this,'👀')" aria-label="Поставить реакцию 👀">👀</button>
                <button onclick="react(this,'🤗')" aria-label="Поставить реакцию 🤗">🤗</button>
                <button onclick="react(this,'🙌')" aria-label="Поставить реакцию 🙌">🙌</button>
                <button onclick="react(this,'😴')" aria-label="Поставить реакцию 😴">😴</button>
                <button onclick="react(this,'🙈')" aria-label="Поставить реакцию 🙈">🙈</button>
                <button onclick="react(this,'💔')" aria-label="Поставить реакцию 💔">💔</button>
            </div>
            <button class="reaction-more" onclick="toggleReactionPicker(this)" aria-label="Открыть все реакции" aria-expanded="false">+</button>
            <div class="reaction-picker" role="group" aria-label="Все реакции">
                <button onclick="react(this,'🤣')" aria-label="Поставить реакцию 🤣">🤣</button>
                <button onclick="react(this,'😮')" aria-label="Поставить реакцию 😮">😮</button>
                <button onclick="react(this,'😢')" aria-label="Поставить реакцию 😢">😢</button>
                <button onclick="react(this,'🎉')" aria-label="Поставить реакцию 🎉">🎉</button>
                <button onclick="react(this,'👏')" aria-label="Поставить реакцию 👏">👏</button>
                <button onclick="react(this,'🙏')" aria-label="Поставить реакцию 🙏">🙏</button>
                <button onclick="react(this,'💯')" aria-label="Поставить реакцию 💯">💯</button>
                <button onclick="react(this,'😎')" aria-label="Поставить реакцию 😎">😎</button>
                <button onclick="react(this,'🤔')" aria-label="Поставить реакцию 🤔">🤔</button>
                <button onclick="react(this,'🤩')" aria-label="Поставить реакцию 🤩">🤩</button>
                <button onclick="react(this,'😍')" aria-label="Поставить реакцию 😍">😍</button>
                <button onclick="react(this,'🥳')" aria-label="Поставить реакцию 🥳">🥳</button>
                <button onclick="react(this,'🤝')" aria-label="Поставить реакцию 🤝">🤝</button>
                <button onclick="react(this,'💪')" aria-label="Поставить реакцию 💪">💪</button>
                <button onclick="react(this,'👀')" aria-label="Поставить реакцию 👀">👀</button>
                <button onclick="react(this,'🤗')" aria-label="Поставить реакцию 🤗">🤗</button>
                <button onclick="react(this,'🙌')" aria-label="Поставить реакцию 🙌">🙌</button>
                <button onclick="react(this,'😴')" aria-label="Поставить реакцию 😴">😴</button>
                <button onclick="react(this,'🙈')" aria-label="Поставить реакцию 🙈">🙈</button>
                <button onclick="react(this,'💔')" aria-label="Поставить реакцию 💔">💔</button>
            </div>
            <button onclick="reply(this.closest('.message-row'))" aria-label="Ответить">↩</button>
        </div>
    `;

    if (pendingStickerSend) {
        row.querySelector(".message").classList.add("sticker");
        pendingStickerSend = false;
    } else if (appSettings.largeEmoji && isEmojiOnly(text)) {
        row.querySelector(".message").classList.add("emoji-only");
    }

    messages.insertBefore(row, typing);
    updateMessageGrouping();
    scheduleReadReceipt(row);
    updateChatListPreview(text, new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));

    if (document.getElementById("chat-search").classList.contains("open")) {
        updateChatSearch();
    }

    pendingReply = null;
    document.getElementById("reply-preview").classList.remove("visible");

    input.value = "";
    resizeComposer();
    updateComposerAction();

    if (appSettings.saveDraft) {
        try {
            localStorage.removeItem(draftStorageKey(currentChatId));
        } catch (error) {
            console.warn("Не удалось очистить черновик", error);
        }
    }

    if (appSettings.sendSound) {
        playSendSound();
    }

    if (appSettings.autoScroll) {
        messages.scrollTop = messages.scrollHeight;
    }


    /* Собеседник начинает печатать, потом отвечает */

    typing.classList.add("show");

    setTimeout(() => {

        typing.classList.remove("show");
        appendReceivedMessage(AUTO_REPLY_POOL[Math.floor(Math.random() * AUTO_REPLY_POOL.length)]);

    }, 1500);

}


const AUTO_REPLY_POOL = [
    "Ага, понял 👍",
    "Хорошо, договорились",
    "Окей, до связи!",
    "Спасибо, что написал",
    "Заеду попозже, ладно?",
    "Принято ✅",
    "Понял, сделаю"
];

// Симулированный ответ собеседника — зеркало отправки сообщения выше, но
// с классом "received" и без своих галочек прочтения (это не наше сообщение).
function appendReceivedMessage(text) {

    const messages = document.getElementById("messages");
    const typing = document.getElementById("typing");

    const row = document.createElement("div");
    row.className = "message-row received";

    row.innerHTML = `
        <div class="message">
            ${escapeHTML(text)}
            <span class="message-time">
                ${new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit"
                })}
            </span>
        </div>
        <div class="message-reactions"></div>
        <span class="reply-indicator" aria-hidden="true">↩</span>
        <div class="message-tools">
            <div class="quick-reactions-track">
                <button onclick="react(this,'👍')" aria-label="Поставить реакцию 👍">👍</button>
                <button onclick="react(this,'🔥')" aria-label="Поставить реакцию 🔥">🔥</button>
                <button onclick="react(this,'❤️')" aria-label="Поставить реакцию ❤️">❤️</button>
                <button onclick="react(this,'😂')" aria-label="Поставить реакцию 😂">😂</button>
                <button onclick="react(this,'🤣')" aria-label="Поставить реакцию 🤣">🤣</button>
                <button onclick="react(this,'😮')" aria-label="Поставить реакцию 😮">😮</button>
                <button onclick="react(this,'😢')" aria-label="Поставить реакцию 😢">😢</button>
                <button onclick="react(this,'🎉')" aria-label="Поставить реакцию 🎉">🎉</button>
                <button onclick="react(this,'👏')" aria-label="Поставить реакцию 👏">👏</button>
                <button onclick="react(this,'🙏')" aria-label="Поставить реакцию 🙏">🙏</button>
                <button onclick="react(this,'💯')" aria-label="Поставить реакцию 💯">💯</button>
                <button onclick="react(this,'😎')" aria-label="Поставить реакцию 😎">😎</button>
                <button onclick="react(this,'🤔')" aria-label="Поставить реакцию 🤔">🤔</button>
                <button onclick="react(this,'🤩')" aria-label="Поставить реакцию 🤩">🤩</button>
                <button onclick="react(this,'😍')" aria-label="Поставить реакцию 😍">😍</button>
                <button onclick="react(this,'🥳')" aria-label="Поставить реакцию 🥳">🥳</button>
                <button onclick="react(this,'🤝')" aria-label="Поставить реакцию 🤝">🤝</button>
                <button onclick="react(this,'💪')" aria-label="Поставить реакцию 💪">💪</button>
                <button onclick="react(this,'👀')" aria-label="Поставить реакцию 👀">👀</button>
                <button onclick="react(this,'🤗')" aria-label="Поставить реакцию 🤗">🤗</button>
                <button onclick="react(this,'🙌')" aria-label="Поставить реакцию 🙌">🙌</button>
                <button onclick="react(this,'😴')" aria-label="Поставить реакцию 😴">😴</button>
                <button onclick="react(this,'🙈')" aria-label="Поставить реакцию 🙈">🙈</button>
                <button onclick="react(this,'💔')" aria-label="Поставить реакцию 💔">💔</button>
            </div>
            <button class="reaction-more" onclick="toggleReactionPicker(this)" aria-label="Открыть все реакции" aria-expanded="false">+</button>
            <div class="reaction-picker" role="group" aria-label="Все реакции">
                <button onclick="react(this,'🤣')" aria-label="Поставить реакцию 🤣">🤣</button>
                <button onclick="react(this,'😮')" aria-label="Поставить реакцию 😮">😮</button>
                <button onclick="react(this,'😢')" aria-label="Поставить реакцию 😢">😢</button>
                <button onclick="react(this,'🎉')" aria-label="Поставить реакцию 🎉">🎉</button>
                <button onclick="react(this,'👏')" aria-label="Поставить реакцию 👏">👏</button>
                <button onclick="react(this,'🙏')" aria-label="Поставить реакцию 🙏">🙏</button>
                <button onclick="react(this,'💯')" aria-label="Поставить реакцию 💯">💯</button>
                <button onclick="react(this,'😎')" aria-label="Поставить реакцию 😎">😎</button>
                <button onclick="react(this,'🤔')" aria-label="Поставить реакцию 🤔">🤔</button>
                <button onclick="react(this,'🤩')" aria-label="Поставить реакцию 🤩">🤩</button>
                <button onclick="react(this,'😍')" aria-label="Поставить реакцию 😍">😍</button>
                <button onclick="react(this,'🥳')" aria-label="Поставить реакцию 🥳">🥳</button>
                <button onclick="react(this,'🤝')" aria-label="Поставить реакцию 🤝">🤝</button>
                <button onclick="react(this,'💪')" aria-label="Поставить реакцию 💪">💪</button>
                <button onclick="react(this,'👀')" aria-label="Поставить реакцию 👀">👀</button>
                <button onclick="react(this,'🤗')" aria-label="Поставить реакцию 🤗">🤗</button>
                <button onclick="react(this,'🙌')" aria-label="Поставить реакцию 🙌">🙌</button>
                <button onclick="react(this,'😴')" aria-label="Поставить реакцию 😴">😴</button>
                <button onclick="react(this,'🙈')" aria-label="Поставить реакцию 🙈">🙈</button>
                <button onclick="react(this,'💔')" aria-label="Поставить реакцию 💔">💔</button>
            </div>
            <button onclick="reply(this.closest('.message-row'))" aria-label="Ответить">↩</button>
        </div>
    `;

    if (appSettings.largeEmoji && isEmojiOnly(text)) {
        row.querySelector(".message").classList.add("emoji-only");
    }

    messages.insertBefore(row, typing);
    updateMessageGrouping();

    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    updateChatListPreview(text, time);

    if (document.getElementById("chat-search").classList.contains("open")) {
        updateChatSearch();
    }

    if (appSettings.receiveSound) {
        playReceiveSound();
    }

    if (appSettings.autoScroll) {
        scrollMessagesToBottom();
    }

}


function reply(messageRow) {

    const input =
        document.getElementById("input");

    if (!messageRow) return;

    const bubbleEl = messageRow.querySelector(".message");
    const quotedMessage = bubbleEl.cloneNode(true);

    quotedMessage.querySelector(".message-time")?.remove();
    quotedMessage.querySelector(".message-reply-quote")?.remove();
    const fullText = quotedMessage.textContent.trim();

    // Если перед нажатием "Ответить" было выделено ровно отрывок внутри
    // ЭТОГО же пузыря — цитируем только его (как частичное цитирование в
    // Telegram), а не всё сообщение целиком.
    const selection = window.getSelection();
    const selectedText = selection && !selection.isCollapsed ? selection.toString().trim() : "";
    const selectionInsideThisBubble = !!(selectedText && bubbleEl && selection.anchorNode && bubbleEl.contains(selection.anchorNode));
    const quotedExcerpt = (selectionInsideThisBubble && selectedText.length < fullText.length) ? selectedText : null;
    const previewText = quotedExcerpt || fullText;

    pendingReply = {
        text: previewText,
        quotedExcerpt,
        row: messageRow,
        messageId: messageRow.dataset.messageId || null
    };

    document.getElementById("reply-preview-text").textContent = previewText;
    document.getElementById("reply-preview").classList.add("visible");

    input.focus();

}


function clearReply() {

    pendingReply = null;
    document.getElementById("reply-preview").classList.remove("visible");
    document.getElementById("input").focus();

}


/* НАВИГАЦИЯ И ОКНА: чат, карточка контакта, информация о собеседнике,
   общие медиа — переключение всех всплывающих окон приложения */

function openChat(target = document.querySelector(".chat")) {

    closeContactPopover();
    closeInfoModal();
    closeSharedMediaModal();
    closeAttachMenu();
    document.body.classList.add("chat-selected");

    const chat = target || document.querySelector(".chat");
    if (!chat) return;

    document.querySelectorAll(".chat").forEach((item) => {
        const isActive = item === chat;
        item.classList.toggle("active", isActive);
        item.setAttribute("aria-pressed", String(isActive));
    });

}


function backToChats() {

    closeContactPopover();
    closeGroupInfoModal();
    closeInfoModal();
    closeSharedMediaModal();
    closeAttachMenu();
    pendingReply = null;
    document.getElementById("reply-preview").classList.remove("visible");
    document.body.classList.remove("chat-selected");
    document.querySelector(".chat.active")?.focus() || document.querySelector(".chat")?.focus();

    // Если openRealChat ещё грузит историю (нажали чат и сразу "назад"), его
    // продолжение иначе дорисовало бы сообщения и подписалось на realtime уже
    // ПОСЛЕ ухода из чата — подписка висела бы, пока не откроют другой чат.
    chatOpenRequestToken++;
    stopGroupCallBanner();
    if (typeof listenUnwatch === "function") listenUnwatch();
    if (typeof voiceUnwatch === "function") voiceUnwatch();

    if (chatRealtimeUnsubscribe) {
        chatRealtimeUnsubscribe();
        chatRealtimeUnsubscribe = null;
    }
    if (chatPresenceHandle) {
        chatPresenceHandle.unsubscribe();
        chatPresenceHandle = null;
    }
    if (typingClearTimer) {
        clearTimeout(typingClearTimer);
        typingClearTimer = null;
    }
    currentChatId = null;
    currentOtherUserId = null;
    currentChatType = "direct";
    currentChatMembersById = new Map();

    // Перерисовать список из уже загруженного кэша (без похода на сервер) —
    // чтобы превью только что оставленного чата сразу показало черновик,
    // если человек успел что-то напечатать и не отправил.
    if (typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED) {
        renderChatListFromCache();
    }
    currentChatIsSecret = false;

}


function toggleInfo() {

    closeContactPopover();

    const backdrop = document.getElementById("info-modal-backdrop");

    if (backdrop.classList.contains("open")) {
        closeInfoModal();
    } else {
        openInfoModal();
    }

}


function openInfoModal() {

    const backdrop = document.getElementById("info-modal-backdrop");

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    positionInfoWindow();
    syncSecretChatActionHint();

}


function closeInfoModal() {

    const backdrop = document.getElementById("info-modal-backdrop");
    if (!backdrop.classList.contains("open")) return;

    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");

}


function closeInfoModalFromBackdrop(event) {

    // Окно перетаскивали, и кнопку отпустили над затемнением — это не клик по фону.
    if (infoWindowJustDragged) {
        infoWindowJustDragged = false;
        return;
    }

    if (event.target === event.currentTarget) {
        closeInfoModal();
    }

}


function toggleContactPopover() {

    const backdrop = document.getElementById("contact-modal-backdrop");
    const personButton = document.querySelector(".person");

    if (backdrop.classList.contains("open")) {
        closeContactPopover();
        return;
    }

    updateContactModalStats();
    syncContactModalBlockButton();

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    personButton?.setAttribute("aria-expanded", "true");

}


function closeContactPopover() {

    const backdrop = document.getElementById("contact-modal-backdrop");
    const personButton = document.querySelector(".person");

    if (!backdrop || !backdrop.classList.contains("open")) return;

    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    personButton?.setAttribute("aria-expanded", "false");

}


function closeContactModalFromBackdrop(event) {

    if (event.target === event.currentTarget) {
        closeContactPopover();
    }

}


function updateContactModalStats() {

    ["media", "files", "links", "voice", "gifs"].forEach((kind) => {

        const count = document.querySelectorAll(`.shared-item[data-kind="${kind}"]`).length;
        const valueEl = document.getElementById(`contact-modal-stat-${kind}`);

        if (valueEl) {
            valueEl.textContent = String(count);
        }

    });

}


function toggleBlockFromModal() {

    const realButton = document.querySelector('[data-profile-toggle="blocked"]');
    if (!realButton) return;

    toggleBlockContact(realButton);
    syncContactModalBlockButton();

}


function syncContactModalBlockButton() {

    const realButton = document.querySelector('[data-profile-toggle="blocked"]');
    const modalButton = document.getElementById("contact-modal-block");
    if (!realButton || !modalButton) return;

    const blocked = realButton.getAttribute("aria-pressed") === "true";

    modalButton.lastChild.textContent = blocked ? "Разблокировать" : "Заблокировать";
    modalButton.classList.toggle("danger", !blocked);

}


/* СЕКРЕТНЫЙ ЧАТ: сверка кода безопасности (safety number) — экран, который
   позволяет вручную убедиться, что общий ключ шифрования секретного чата
   никто не подменил при обмене ключами через сервер (см. crypto.js). Пока
   бэкенд не подключён (Supabase не настроен), кнопка "Секретный чат"
   показывает этот же экран в демо-режиме: считает НАСТОЯЩИЙ ключ этого
   устройства и сравнивает его с фиксированным демо-ключом собеседника —
   вся математика реальная, только собеседник пока не живой. */

const DEMO_SECRET_CHAT_ID = "demo-contact";
const DEMO_PEER_KEY_STORAGE_KEY = "kaban-demo-peer-public-key";
let safetyModalChatId = DEMO_SECRET_CHAT_ID; // на какой чат ссылается сейчас открытый экран сверки — demo или настоящий chatId

// Публичный ключ "собеседника" для демо-режима — генерируется один раз в
// этом браузере и дальше не меняется, иначе код безопасности при каждом
// открытии показывал бы разные эмодзи, что бессмысленно для сверки.
async function getDemoPeerPublicKeyBase64() {

    const cached = localStorage.getItem(DEMO_PEER_KEY_STORAGE_KEY);
    if (cached) return cached;

    const demoKeyPair = await window.crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey"]
    );
    const raw = await window.crypto.subtle.exportKey("raw", demoKeyPair.publicKey);
    const base64 = bufferToBase64(raw);

    localStorage.setItem(DEMO_PEER_KEY_STORAGE_KEY, base64);
    return base64;

}


async function openSafetyNumberDemo() {

    closeContactPopover();
    safetyModalChatId = DEMO_SECRET_CHAT_ID;

    const backdrop = document.getElementById("safety-modal-backdrop");
    const body = document.getElementById("safety-modal-body");

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    body.innerHTML = '<div class="safety-modal-loading">Вычисляем код…</div>';

    try {

        if (typeof KabanCrypto === "undefined") {
            throw new Error("crypto.js не подключён к странице");
        }

        const myPublicKey = await KabanCrypto.getPublicKeyBase64();
        const theirPublicKey = await getDemoPeerPublicKeyBase64();
        const safetyNumber = await KabanCrypto.computeSafetyNumber(myPublicKey, theirPublicKey);

        renderSafetyNumber(safetyNumber);

    } catch (error) {

        body.innerHTML = `<div class="safety-modal-error">Не удалось получить код: ${escapeHTML(error.message)}</div>`;

    }

}

// Тот же экран, но для настоящего секретного чата (chats.is_secret=true) —
// ключи берутся из secret_chat_handshake, а не из демо-заглушки.
async function openSafetyNumberForCurrentChat() {

    closeContactPopover();
    closeInfoModal();
    safetyModalChatId = currentChatId;

    const backdrop = document.getElementById("safety-modal-backdrop");
    const body = document.getElementById("safety-modal-body");

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    body.innerHTML = '<div class="safety-modal-loading">Вычисляем код…</div>';

    try {
        const safetyNumber = await KabanCrypto.getSafetyNumberForChat(currentChatId);
        renderSafetyNumber(safetyNumber);
    } catch (error) {
        body.innerHTML = `<div class="safety-modal-error">Не удалось получить код: ${escapeHTML(error.message)}</div>`;
    }

}

// Клик по "Секретный чат" в карточке собеседника: в демо-режиме или без
// открытого личного чата — старый демо-экран; если чат уже секретный —
// сверка кода; если обычный (не секретный) — начинаем/открываем секретный
// чат с этим же человеком.
async function handleSecretChatAction() {

    const configured = typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED;

    if (!configured || currentChatType === "group" || !currentOtherUserId) {
        openSafetyNumberDemo();
        return;
    }

    if (currentChatIsSecret) {
        openSafetyNumberForCurrentChat();
        return;
    }

    // Двойной клик до ответа сервера запускал две параллельные "найди или
    // создай" проверки — обе не находили секретный чат и создавали по своему
    // (два чата с разными ключами между одной и той же парой людей).
    if (startingSecretChat) return;
    startingSecretChat = true;

    closeContactPopover();
    closeInfoModal();

    try {
        const chatId = await KabanCrypto.getOrStartSecretChat(currentOtherUserId);
        await loadChatList();
        await openRealChat(chatId);
    } catch (error) {
        toast("Не удалось начать секретный чат: " + (error?.message || error));
    } finally {
        startingSecretChat = false;
    }

}

let startingSecretChat = false;


function renderSafetyNumber({ emoji, digits, fingerprint }) {

    const body = document.getElementById("safety-modal-body");
    const verified = KabanCrypto.isSafetyNumberVerified(safetyModalChatId, fingerprint);

    body.dataset.fingerprint = fingerprint;

    body.innerHTML = `
        <div class="safety-emoji-row">
            ${emoji.map((symbol) => `<span class="safety-emoji">${symbol}</span>`).join("")}
        </div>
        <div class="safety-digits">${escapeHTML(digits)}</div>
        <button
            class="safety-confirm-button${verified ? " is-verified" : ""}"
            type="button"
            onclick="confirmSafetyNumberMatch()"
        >
            ${verified ? "✓ Код проверен" : "Коды совпадают — подтвердить"}
        </button>
    `;

}


function confirmSafetyNumberMatch() {

    const body = document.getElementById("safety-modal-body");
    const fingerprint = body.dataset.fingerprint;
    if (!fingerprint) return;

    KabanCrypto.confirmSafetyNumber(safetyModalChatId, fingerprint);
    if (safetyModalChatId === DEMO_SECRET_CHAT_ID) syncSecretChatActionHint();
    toast("Код подтверждён — этот секретный чат защищён от подмены ключа");
    closeSafetyNumberModal();

}


function closeSafetyNumberModal() {

    const backdrop = document.getElementById("safety-modal-backdrop");

    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");

}


function closeSafetyModalFromBackdrop(event) {

    if (event.target === event.currentTarget) {
        closeSafetyNumberModal();
    }

}


// Показывает в списке действий, проверен ли уже код безопасности — либо,
// если открыт настоящий (не секретный) личный чат, что кнопка вообще
// начинает секретный чат, а не сверяет код. Вызывается при загрузке
// страницы, при открытии инфо-панели и сразу после подтверждения кода.
async function syncSecretChatActionHint() {

    const hint = document.getElementById("secret-chat-action-hint");
    const button = hint?.closest(".info-action");
    if (!hint || typeof KabanCrypto === "undefined") return;

    const configured = typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED;
    const inRealChat = configured && !!currentChatId;

    if (inRealChat && currentChatType === "group") {
        // Секретные чаты только 1:1 — в группе действие не имеет смысла.
        if (button) button.hidden = true;
        return;
    }
    if (button) button.hidden = false;

    try {

        if (inRealChat && currentChatIsSecret) {
            const { fingerprint } = await KabanCrypto.getSafetyNumberForChat(currentChatId);
            hint.textContent = KabanCrypto.isSafetyNumberVerified(currentChatId, fingerprint)
                ? "✓ Код проверен"
                : "Проверить код безопасности";
        } else if (inRealChat) {
            hint.textContent = "Начать секретный чат";
        } else {
            const myPublicKey = await KabanCrypto.getPublicKeyBase64();
            const theirPublicKey = await getDemoPeerPublicKeyBase64();
            const { fingerprint } = await KabanCrypto.computeSafetyNumber(myPublicKey, theirPublicKey);

            hint.textContent = KabanCrypto.isSafetyNumberVerified(DEMO_SECRET_CHAT_ID, fingerprint)
                ? "✓ Код проверен"
                : "Проверить код безопасности";
        }

    } catch {
        // crypto.js недоступен, собеседник ещё не принял секретный чат и т.п. —
        // оставляем подпись по умолчанию, это не критичная функция интерфейса.
        if (inRealChat && currentChatIsSecret) hint.textContent = "Собеседник ещё не в сети";
    }

}

document.addEventListener("DOMContentLoaded", syncSecretChatActionHint);


/* ИЗМЕНЕНИЕ КОНТАКТА: локальное имя для КОНКРЕТНОГО собеседника (ключ
   содержит его user id, а не один общий ключ на всё приложение — иначе
   переименование одного контакта задевало бы имя вообще всех остальных).
   Видно только мне, настоящее display_name на сервере не трогается —
   ровно как "изменить контакт" в Telegram. Раньше здесь были ещё локальный
   значок-эмодзи и фото — убрал: они дублировали уже отдельно существующий
   настоящий видео/фото-аватар и были источником убогих смайликов без
   реальной надобности. */

const CONTACT_ALIAS_STORAGE_PREFIX = "kaban-contact-alias:";

function contactAliasStorageKey(userId) {
    return CONTACT_ALIAS_STORAGE_PREFIX + userId;
}

function loadContactAlias(userId) {
    if (!userId) return null;
    try {
        return localStorage.getItem(contactAliasStorageKey(userId)) || null;
    } catch {
        return null;
    }
}

// Накладывает локальный алиас поверх уже отрисованного настоящего имени
// (см. openRealChat → applyContactProfile) — вызывать именно ПОСЛЕ него.
function applyContactAliasIfSet(userId) {
    const alias = loadContactAlias(userId);
    if (!alias) return;
    document.querySelectorAll('[data-contact-field="name"]').forEach((el) => {
        el.textContent = alias;
    });
}

// ВИДЕО-АВАТАР: короткий зацикленный ролик поверх фото/эмодзи-заглушки —
// тот же контейнер, что и для статичного аватара (.person-avatar,
// .contact-modal-avatar, .info-avatar, #profile-screen-avatar и т.п.),
// просто поверх него добавляется/прячется один <video> ребёнок. Контейнер
// должен быть position:relative с overflow:hidden (см. style.css), иначе
// видео вылезет за пределы кружка.
function applyAvatarVideo(container, videoUrl) {

    if (!container) return;

    let video = container.querySelector(":scope > video.avatar-video");

    if (videoUrl) {
        if (!video) {
            video = document.createElement("video");
            video.className = "avatar-video";
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.autoplay = true;
            container.appendChild(video);
        }
        if (video.getAttribute("src") !== videoUrl) video.setAttribute("src", videoUrl);
        video.hidden = false;
        video.play().catch(() => {}); // автоплей без жеста может быть отклонён — не критично, видео всё равно появится по первому кадру
    } else if (video) {
        video.pause();
        video.hidden = true;
    }

}

// profile.photo — data URL (128×128 JPEG) или null. Когда есть фото, оно
// приоритетнее значка — эмодзи остаётся "запасным" вариантом на случай,
// если фото уберут. profile.avatarVideo — поверх фото/эмодзи, если задан
// (см. applyAvatarVideo выше).
function applyContactProfile(profile) {

    document.querySelectorAll('[data-contact-field="name"]').forEach((el) => {
        el.textContent = profile.name;
    });

    const username = profile.username || "";
    document.querySelectorAll('[data-contact-field="username"]').forEach((el) => {
        el.textContent = username ? `@${username.replace(/^@/, "")}` : "";
    });

    // bio приходит из реального поля users.bio (см. KabanAPI.getChats) —
    // раньше в карточке был захардкожен один и тот же демо-текст про
    // Владивосток для вообще всех собеседников.
    document.querySelectorAll('[data-contact-field="bio"]').forEach((el) => {
        el.textContent = profile.bio || "Нет информации";
    });

    document.querySelectorAll('[data-contact-field="avatar"]').forEach((el) => {
        if (profile.photo) {
            el.textContent = "";
            el.style.backgroundImage = `url(${profile.photo})`;
            el.style.backgroundSize = "cover";
            el.style.backgroundPosition = "center";
        } else {
            // Градиент + инициалы вместо эмодзи-заглушки (как в списке чатов).
            const kind = profile.isSaved ? "saved" : profile.isBot ? "bot" : profile.avatar === "👥" ? "group" : "user";
            const av = avatarParts({ name: profile.isSaved ? "Избранное" : profile.name, kind });
            el.innerHTML = av.inner;
            el.style.backgroundImage = "";
            el.style.background = (av.style.match(/background:([^;"]+)/) || [])[1] || "";
            el.style.color = "#fff";
        }
        el.classList.toggle("has-initials", !profile.photo);
        el.classList.toggle("chat-avatar-saved", !!profile.isSaved);
        el.classList.toggle("chat-avatar-bot", !!profile.isBot);
        applyAvatarVideo(el, profile.avatarVideo || null);
    });

    // Шапка карточки собеседника: цвет из имени (у каждого свой) либо размытое фото.
    let contactHue = 0;
    for (const ch of profile.name || "") contactHue = (contactHue * 31 + ch.charCodeAt(0)) % 360;
    document.querySelectorAll(".contact-modal, .info.info-window").forEach((card) => {
        card.style.setProperty("--gh", String(contactHue));
        card.style.setProperty("--gp", profile.photo ? `url(${profile.photo})` : "none");
        card.classList.toggle("has-photo", !!profile.photo);
    });
    const callAvatar = document.getElementById("call-avatar");
    if (callAvatar) callAvatar.textContent = profile.name.trim().charAt(0).toUpperCase() || "Ж";

    // Фото собеседника рядом с его сообщениями (только на ПК — см.
    // style.css @media (min-width: 651px) .message-row.received). Один
    // раз на весь чат, а не на каждое сообщение — рисуется CSS-псевдоэлементом
    // через переменные, поэтому appendRealMessageRow/send() трогать не нужно.
    const messagesEl = document.getElementById("messages");
    if (messagesEl) {
        messagesEl.style.setProperty("--chat-avatar-emoji", profile.photo ? '""' : `"${(profile.avatar || "👤").replace(/"/g, '\\"')}"`);
        messagesEl.style.setProperty("--chat-avatar-img", profile.photo ? `url(${profile.photo})` : "none");
    }

}

function openEditContactModal() {

    closeContactPopover();

    if (!currentOtherUserId) {
        toast("Доступно только для личных чатов");
        return;
    }

    const alias = loadContactAlias(currentOtherUserId);
    document.getElementById("edit-contact-name").value = alias || "";
    document.getElementById("edit-contact-reset-btn").hidden = !alias;

    const backdrop = document.getElementById("edit-contact-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function saveContactProfile() {

    if (!currentOtherUserId) return;

    const name = document.getElementById("edit-contact-name").value.trim();
    if (!name) {
        toast("Имя не может быть пустым");
        return;
    }

    try {
        localStorage.setItem(contactAliasStorageKey(currentOtherUserId), name);
    } catch (error) {
        toast("Не удалось сохранить: недостаточно места в браузере");
        return;
    }

    applyContactAliasIfSet(currentOtherUserId);
    renderChatListFromCache(); // строка в списке чатов тоже должна сразу показать алиас

    toast("Локальное имя сохранено");
    closeEditContactModal();

}

// Полный пересчёт текущего чата — проще и надёжнее, чем вручную
// восстанавливать настоящее имя (с приставками 🔒/эмодзи-статуса) второй
// копией той же логики, что уже есть в openRealChat.
async function resetContactProfile() {

    if (!currentOtherUserId || !currentChatId) return;

    try {
        localStorage.removeItem(contactAliasStorageKey(currentOtherUserId));
    } catch {
        // некритично — хуже не станет, просто не удалилось
    }

    toast("Локальное имя убрано");
    closeEditContactModal();
    await openRealChat(currentChatId);
    renderChatListFromCache();

}

function closeEditContactModal() {
    const backdrop = document.getElementById("edit-contact-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeEditContactFromBackdrop(event) {
    if (event.target === event.currentTarget) closeEditContactModal();
}


/* ОБЩИЕ ГРУППЫ: статичный демо-список — реальная функция вместо toast со
   вшитой цифрой. В демо-версии группового чата нет, поэтому список
   иллюстративный, но окно с ним настоящее, не заглушка. */

// НАСТОЯЩИЕ "Общие группы" — пересечение моих групп и групп otherUserId
// (см. KabanAPI.getSharedGroups), тап по строке реально открывает ту
// группу, а не показывает тост. Только для 1:1/секретных чатов —
// currentOtherUserId пуст в групповом чате, кнопка туда и не выведена.
// Токен запроса: повторное открытие окна (двойной клик по пункту) запускало
// два параллельных запроса, и победитель определялся тем, кто ответит
// ПОСЛЕДНИМ, а не тем, кто запрошен последним — как уже сделано у поиска.
let sharedGroupsModalToken = 0;
let blockedContactsModalToken = 0;

async function openSharedGroupsModal() {

    if (!currentOtherUserId) return;

    const requestToken = ++sharedGroupsModalToken;

    closeContactPopover();
    closeInfoModal();

    const list = document.getElementById("shared-groups-list");
    list.innerHTML = `<div class="contact-group-row" style="cursor:default"><span class="contact-group-copy"><span class="contact-group-name">Загрузка…</span></span></div>`;

    const backdrop = document.getElementById("shared-groups-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    try {
        const groups = await KabanAPI.getSharedGroups(currentOtherUserId);
        if (requestToken !== sharedGroupsModalToken) return;
        if (!groups.length) {
            list.innerHTML = `<div class="contact-group-row" style="cursor:default"><span class="contact-group-copy"><span class="contact-group-name">Общих групп нет</span></span></div>`;
            return;
        }
        list.innerHTML = groups.map((group) => `
            <button class="contact-group-row" type="button" onclick="closeSharedGroupsModal(); openRealChat('${group.chatId}')">
                <span class="contact-group-avatar"${group.avatarUrl ? ` style="background-image:${escapeHTML(cssUrlValue(group.avatarUrl))};background-size:cover;background-position:center"` : ""}>${group.avatarUrl ? "" : "👥"}</span>
                <span class="contact-group-copy">
                    <span class="contact-group-name">${escapeHTML(group.title || "Группа")}</span>
                    <span class="contact-group-meta">${group.memberCount} ${pluralRu(group.memberCount, "участник", "участника", "участников")}</span>
                </span>
            </button>
        `).join("");
    } catch (error) {
        if (requestToken !== sharedGroupsModalToken) return;
        list.innerHTML = `<div class="contact-group-row" style="cursor:default"><span class="contact-group-copy"><span class="contact-group-name">Не удалось загрузить</span></span></div>`;
        console.warn("Не удалось загрузить общие группы", error);
    }

}

function closeSharedGroupsModal() {
    const backdrop = document.getElementById("shared-groups-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeSharedGroupsFromBackdrop(event) {
    if (event.target === event.currentTarget) closeSharedGroupsModal();
}


/* ЗАБЛОКИРОВАННЫЕ: Настройки → Приватность → Заблокированные — список
   собеседников с is_blocked=true (см. KabanAPI.getBlockedContacts), с
   разблокировкой прямо отсюда, а не только по одному через карточку
   каждого конкретного контакта. */

async function openBlockedContactsModal() {

    const requestToken = ++blockedContactsModalToken;

    const backdrop = document.getElementById("blocked-contacts-backdrop");
    const list = document.getElementById("blocked-contacts-list");

    list.innerHTML = `<div class="contact-group-row" style="cursor:default"><span class="contact-group-copy"><span class="contact-group-name">Загрузка…</span></span></div>`;
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    try {
        const blocked = await KabanAPI.getBlockedContacts();
        if (requestToken !== blockedContactsModalToken) return;
        renderBlockedContactsList(blocked);
    } catch (error) {
        if (requestToken !== blockedContactsModalToken) return;
        list.innerHTML = `<div class="contact-group-row" style="cursor:default"><span class="contact-group-copy"><span class="contact-group-name">Не удалось загрузить список</span></span></div>`;
        console.warn("Не удалось загрузить заблокированных", error);
    }

}

function renderBlockedContactsList(blocked) {

    const list = document.getElementById("blocked-contacts-list");

    if (!blocked.length) {
        list.innerHTML = `<div class="contact-group-row" style="cursor:default"><span class="contact-group-copy"><span class="contact-group-name">Никого не заблокировано</span></span></div>`;
        return;
    }

    list.innerHTML = blocked.map(({ chatId, user }) => `
        <div class="contact-group-row" style="cursor:default">
            <span class="contact-group-avatar"${user.avatar_url ? ` style="background-image:${escapeHTML(cssUrlValue(user.avatar_url))};background-size:cover;background-position:center"` : ""}>${user.avatar_url ? "" : "👤"}</span>
            <span class="contact-group-copy">
                <span class="contact-group-name">${escapeHTML(user.display_name || "Пользователь")}</span>
                <span class="contact-group-meta">@${escapeHTML(user.username || "")}</span>
            </span>
            <button type="button" class="contact-modal-list-item danger" style="width:auto;padding:6px 12px;border-radius:8px;background:var(--surface);flex:0 0 auto" onclick="unblockContactFromList('${chatId}', this)">
                Разблокировать
            </button>
        </div>
    `).join("");

}

async function unblockContactFromList(chatId, button) {

    button.disabled = true;
    button.textContent = "…";

    try {
        await KabanAPI.setBlocked(chatId, false);

        // Если это тот же чат, что открыт прямо сейчас — синхронизируем и
        // его собственную кнопку блокировки, и композер (он был выключен).
        if (currentChatId === chatId) {
            const liveButton = document.querySelector('[data-profile-toggle="blocked"]');
            if (liveButton) applyBlockUIState(liveButton, false);
        }

        button.closest(".contact-group-row").remove();
        if (!document.querySelector("#blocked-contacts-list .contact-group-row")) {
            renderBlockedContactsList([]);
        }
        toast("Пользователь разблокирован");
    } catch (error) {
        button.disabled = false;
        button.textContent = "Разблокировать";
        toast("Не удалось разблокировать: " + (error?.message || error));
    }

}

function closeBlockedContactsModal() {
    const backdrop = document.getElementById("blocked-contacts-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeBlockedContactsFromBackdrop(event) {
    if (event.target === event.currentTarget) closeBlockedContactsModal();
}


/* QR-КОД ПРОФИЛЯ: всегда СВОЙ (не собеседника) — чтобы его можно было
   показать и отсканировать, как настоящую визитку. Кодируем простой текст
   "KABAN: @username", а не выдуманную ссылку — у KABAN нет публичных
   веб-страниц профиля, которые такая ссылка могла бы реально открыть, и
   врать про это в QR-коде не стоит. Библиотека — qrcodejs (давид Шим),
   подключена в index.html с cdnjs. */

// Библиотека QR (~20 КБ) грузится только при первом открытии QR, а не при каждом
// старте приложения, где она блокировала разбор страницы.
let qrLibraryPromise = null;
function loadQrLibrary() {
    if (typeof QRCode !== "undefined") return Promise.resolve();
    if (!qrLibraryPromise) {
        qrLibraryPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = "vendor/qrcode.min.js?v=1.0.0";
            script.onload = resolve;
            script.onerror = () => { qrLibraryPromise = null; reject(new Error("qrcode")); };
            document.head.appendChild(script);
        });
    }
    return qrLibraryPromise;
}

async function openProfileQRCode() {

    if (!cachedMyProfile) {
        toast("Профиль ещё не загружен");
        return;
    }
    try { await loadQrLibrary(); } catch { /* ниже покажем «не удалось построить» */ }

    const container = document.getElementById("profile-qr-canvas");
    container.innerHTML = "";

    try {
        // eslint-disable-next-line no-undef
        new QRCode(container, {
            text: `KABAN: @${cachedMyProfile.username}`,
            width: 196,
            height: 196,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });
    } catch (error) {
        container.textContent = "Не удалось построить QR-код";
        console.warn("QR-код: библиотека недоступна", error);
    }

    document.getElementById("profile-qr-name").textContent = cachedMyProfile.display_name || "";
    document.getElementById("profile-qr-username").textContent = cachedMyProfile.username ? `@${cachedMyProfile.username}` : "";

    const backdrop = document.getElementById("profile-qr-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeProfileQRCode() {
    const backdrop = document.getElementById("profile-qr-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeProfileQRFromBackdrop(event) {
    if (event.target === event.currentTarget) closeProfileQRCode();
}


/* НОВЫЙ ЧАТ: поповер поиска по кнопке "+" — реальный поиск среди контактов
   (в демо-версии контакт один, но поповер и фильтрация настоящие, а не
   toast-заглушка; когда появится бэкенд, здесь достаточно будет заменить
   источник результатов на KabanAPI.searchUsersByUsername). */

function toggleNewChatPopover() {

    const popover = document.getElementById("new-chat-popover");
    if (popover.classList.contains("open")) {
        closeNewChatPopover();
        return;
    }

    const button = document.getElementById("new-chat-button");
    const rect = button.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 8}px`;
    popover.style.left = `${Math.max(12, rect.right - 260)}px`;

    document.getElementById("new-chat-search").value = "";
    filterNewChatResults();

    popover.classList.add("open");
    popover.setAttribute("aria-hidden", "false");
    document.getElementById("new-chat-search").focus();

}

function closeNewChatPopover() {
    const popover = document.getElementById("new-chat-popover");
    popover.classList.remove("open");
    popover.setAttribute("aria-hidden", "true");
}

let newChatSearchToken = 0;
let newChatSearchTimer = null;

function filterNewChatResults() {

    // В демо-режиме (без Supabase) — старое локальное поведение без изменений.
    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED) {

        const query = document.getElementById("new-chat-search").value.trim().toLocaleLowerCase();
        const results = document.getElementById("new-chat-results");
        const demoName = "Собеседник";
        const matches = !query || demoName.toLocaleLowerCase().includes(query) || "contact".includes(query);

        results.innerHTML = matches ? `
            <button class="new-chat-result-row" type="button" onclick="closeNewChatPopover(); openChat();">
                <span class="new-chat-result-avatar">🧑</span>
                <span>${escapeHTML(demoName)}</span>
            </button>
        ` : `<div class="new-chat-result-empty">Никого не нашлось</div>`;

        return;

    }

    // Настоящий поиск — по сети, поэтому с небольшой задержкой после
    // последнего нажатия клавиши, а не на каждый символ.
    clearTimeout(newChatSearchTimer);
    newChatSearchTimer = setTimeout(runRealUserSearch, 300);

}

async function runRealUserSearch() {

    const query = document.getElementById("new-chat-search").value.trim();
    const results = document.getElementById("new-chat-results");

    if (!query) {
        results.innerHTML = `<div class="new-chat-result-empty">Введите имя пользователя</div>`;
        return;
    }

    const token = ++newChatSearchToken;
    results.innerHTML = `<div class="new-chat-result-empty">Ищем…</div>`;

    if (typeof appendMessageSearchResults === "function") appendMessageSearchResults(query, token);

    let users;
    try {
        users = await KabanAPI.searchUsersByUsername(query);
    } catch (error) {
        if (token !== newChatSearchToken) return; // пришёл более новый запрос, этот ответ устарел
        results.innerHTML = `<div class="new-chat-result-empty">Ошибка поиска: ${escapeHTML(error?.message || String(error))}</div>`;
        return;
    }

    if (token !== newChatSearchToken) return;

    const me = await KabanAuth.getCurrentUser();
    const filtered = users.filter((user) => user.id !== me?.id);

    results.innerHTML = filtered.length ? filtered.map((user) => `
        <button class="new-chat-result-row" type="button" onclick="startRealChatWith('${user.id}')">
            <span class="new-chat-result-avatar${user.is_bot ? " chat-avatar-bot" : ""}">${user.is_bot ? "🤖" : "👤"}</span>
            <span>${escapeHTML(user.display_name)}${user.status_emoji ? ` ${escapeHTML(user.status_emoji)}` : ""} <span style="opacity:.6">@${escapeHTML(user.username)}</span></span>
        </button>
    `).join("") : `<div class="new-chat-result-empty">Никого не нашлось</div>`;

}


/* НОВАЯ ГРУППА: тот же поповер-поиск, что и "Новый чат", но с множественным
   выбором собеседников (чипы + чекбоксы) и вторым шагом "название/аватар".
   Тот же модал переиспользуется для "Добавить участников" в уже существующую
   группу (newGroupMode = "add") — там второй шаг не нужен, "Далее" сразу
   добавляет выбранных в chat_participants. */

let newGroupMode = "create"; // "create" | "add"
let newGroupTargetChatId = null;
let newGroupSelectedMembers = new Map(); // userId -> {display_name, username}
let newGroupAvatarFile = null;
let newGroupSearchToken = 0;
let newGroupSearchTimer = null;

function openNewGroupModal() {

    newGroupMode = "create";
    newGroupTargetChatId = null;
    newGroupSelectedMembers = new Map();
    newGroupAvatarFile = null;
    newGroupLastExtraUsers = [];
    newGroupLastExtraQuery = null;

    document.getElementById("new-group-step-title").textContent = "Новая группа";
    document.getElementById("new-group-next-btn").textContent = "Далее";
    document.getElementById("new-group-search").value = "";
    document.getElementById("new-group-step-members").hidden = false;
    document.getElementById("new-group-step-name").hidden = true;
    document.getElementById("new-group-title").value = "";
    resetGroupAvatarPreview("new-group-avatar-preview", "👥");
    renderNewGroupSelectedChips();
    // Сразу показываем список контактов, без ожидания ввода — печатать
    // ник нужно, только чтобы добавить того, с кем ещё не было чата.
    runNewGroupSearch();

    const backdrop = document.getElementById("new-group-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("new-group-search").focus();

}

async function openAddGroupMembersModal() {

    if (!currentChatId) return;
    closeGroupInfoModal();

    newGroupMode = "add";
    newGroupTargetChatId = currentChatId;
    newGroupSelectedMembers = new Map();
    newGroupLastExtraUsers = [];
    newGroupLastExtraQuery = null;

    document.getElementById("new-group-step-title").textContent = "Добавить участников";
    document.getElementById("new-group-next-btn").textContent = "Добавить";
    document.getElementById("new-group-search").value = "";
    document.getElementById("new-group-step-members").hidden = false;
    document.getElementById("new-group-step-name").hidden = true;
    renderNewGroupSelectedChips();
    runNewGroupSearch();

    const backdrop = document.getElementById("new-group-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("new-group-search").focus();

}

// forceClose — после УСПЕШНОГО создания группы/добавления участников
// (см. submitCreateGroup/goToGroupNameStep): закрываем без вопросов, это
// не отмена, а естественное завершение сценария.
function closeNewGroupModal(forceClose) {

    if (!forceClose && (newGroupSelectedMembers.size > 0 || document.getElementById("new-group-title").value.trim())) {
        const message = newGroupMode === "add"
            ? "Отменить добавление участников? Выбор будет потерян."
            : "Отменить создание группы? Выбор участников будет потерян.";
        if (!confirm(message)) return;
    }

    const backdrop = document.getElementById("new-group-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");

}

function closeNewGroupModalFromBackdrop(event) {
    if (event.target === event.currentTarget) closeNewGroupModal();
}

let newGroupLastExtraUsers = [];
let newGroupLastExtraQuery = null; // null — ещё не искали по текущему запросу

function filterNewGroupResults() {
    // Локальные контакты фильтруются мгновенно, без сети — ждём только
    // серверный поиск "чужих" пользователей (см. runNewGroupSearch).
    newGroupLastExtraQuery = null;
    rerenderNewGroupResults();
    clearTimeout(newGroupSearchTimer);
    newGroupSearchTimer = setTimeout(runNewGroupSearch, 300);
}

function buildNewGroupResultRowHTML(user) {
    const selected = newGroupSelectedMembers.has(user.id);
    const av = avatarParts({ id: user.id, name: user.display_name || user.username, url: user.avatar_url, kind: user.is_bot && !user.avatar_url ? "bot" : "user" });
    return `
        <button class="new-chat-result-row" type="button" data-user-id="${escapeHTML(user.id)}" data-user-name="${escapeHTML(user.display_name)}" onclick="toggleGroupMemberSelection(this.dataset.userId, this.dataset.userName)">
            <span class="new-chat-result-avatar${av.cls}${selected ? " selected" : ""}${user.is_bot ? " chat-avatar-bot" : ""}"${av.style}>${av.inner}${selected ? `<span class="new-chat-result-check">✓</span>` : ""}</span>
            <span>${escapeHTML(user.display_name || user.username || "Пользователь")} <span style="opacity:.6">@${escapeHTML(user.username || "")}</span></span>
        </button>
    `;
}

function getNewGroupExistingIds(me) {
    // В режиме "добавить участников" не показываем тех, кто уже состоит в группе.
    const ids = newGroupMode === "add"
        ? new Set(currentChatMembersById ? [...currentChatMembersById.keys()] : [])
        : new Set();
    if (me?.id) ids.add(me.id);
    return ids;
}

function getNewGroupLocalMatches(query) {
    const me = { id: myRealUserId };
    const existingIds = getNewGroupExistingIds(me);
    const queryLower = query.toLocaleLowerCase();
    return getContactsFromChats().filter((user) => {
        if (existingIds.has(user.id)) return false;
        if (!query) return true;
        return (user.display_name || "").toLocaleLowerCase().includes(queryLower)
            || (user.username || "").toLocaleLowerCase().includes(queryLower);
    });
}

// Мгновенный, синхронный рендер (локальные контакты + последний готовый
// серверный результат, если он ещё относится к текущему запросу) — без
// него каждый клик по чекбоксу или символ в поле ждал бы новый сетевой
// запрос, из-за чего список и ощущался "неудобным"/дёрганым.
function rerenderNewGroupResults() {
    const query = document.getElementById("new-group-search").value.trim();
    const results = document.getElementById("new-group-results");
    const matches = getNewGroupLocalMatches(query);

    const localHTML = matches.length
        ? `<div class="section-label">Контакты</div>${matches.map(buildNewGroupResultRowHTML).join("")}`
        : "";

    const extraHTML = (query && newGroupLastExtraQuery === query && newGroupLastExtraUsers.length)
        ? `<div class="section-label">Все пользователи</div>${newGroupLastExtraUsers.map(buildNewGroupResultRowHTML).join("")}`
        : "";

    results.innerHTML = localHTML + extraHTML || `<div class="new-chat-result-empty">${
        query ? "Никого не нашлось" : "Пока нет контактов — начните печатать @ник, чтобы найти человека"
    }</div>`;
}

async function runNewGroupSearch() {

    const query = document.getElementById("new-group-search").value.trim();
    rerenderNewGroupResults();
    if (!query) return; // без запроса контактов достаточно, в сеть не ходим

    const token = ++newGroupSearchToken;

    if (typeof appendMessageSearchResults === "function") appendMessageSearchResults(query, token);

    let users;
    try {
        users = await KabanAPI.searchUsersByUsername(query);
    } catch (error) {
        return; // локальные контакты уже показаны — молча игнорируем сетевую ошибку
    }
    if (token !== newGroupSearchToken) return;

    const me = await KabanAuth.getCurrentUser();
    const existingIds = getNewGroupExistingIds(me);
    const localIds = new Set(getNewGroupLocalMatches(query).map((u) => u.id));

    newGroupLastExtraUsers = (users || []).filter((u) => !existingIds.has(u.id) && !localIds.has(u.id));
    newGroupLastExtraQuery = query;
    rerenderNewGroupResults();

}

function toggleGroupMemberSelection(userId, displayName) {
    if (newGroupSelectedMembers.has(userId)) {
        newGroupSelectedMembers.delete(userId);
    } else {
        newGroupSelectedMembers.set(userId, displayName);
    }
    renderNewGroupSelectedChips();
    rerenderNewGroupResults();
}

function renderNewGroupSelectedChips() {

    const box = document.getElementById("new-group-selected-chips");
    const nextBtn = document.getElementById("new-group-next-btn");

    box.innerHTML = [...newGroupSelectedMembers.entries()].map(([userId, name]) => `
        <span class="new-group-chip">
            ${escapeHTML(name)}
            <button type="button" data-user-id="${escapeHTML(userId)}" data-user-name="${escapeHTML(name)}" onclick="toggleGroupMemberSelection(this.dataset.userId, this.dataset.userName)" aria-label="Убрать ${escapeHTML(name)}">×</button>
        </span>
    `).join("");

    nextBtn.disabled = newGroupSelectedMembers.size === 0;
    const baseLabel = newGroupMode === "add" ? "Добавить" : "Далее";
    nextBtn.textContent = newGroupSelectedMembers.size ? `${baseLabel} (${newGroupSelectedMembers.size})` : baseLabel;

}

function resetGroupAvatarPreview(elId, placeholder) {
    const el = document.getElementById(elId);
    const input = el.querySelector("input[type=file]"); // забираем ДО textContent ниже — он стирает всех детей, включая сам input
    el.style.backgroundImage = "";
    el.textContent = placeholder;
    if (input) el.appendChild(input);
}

function selectGroupAvatarFile(input) {
    const file = input.files?.[0];
    if (!file) return;
    newGroupAvatarFile = file;

    const preview = document.getElementById("new-group-avatar-preview");
    const reader = new FileReader();
    reader.onload = () => {
        preview.style.backgroundImage = `url(${reader.result})`;
        preview.style.backgroundSize = "cover";
        preview.style.backgroundPosition = "center";
    };
    reader.readAsDataURL(file);
}

let addingGroupMembers = false;

async function goToGroupNameStep() {

    if (!newGroupSelectedMembers.size) return;

    if (newGroupMode === "add") {
        // Двойной клик "Добавить" до ответа сервера отправлял один и тот же
        // список участников дважды параллельно (у submitCreateGroup такая
        // защита есть через disabled, у этой ветки — не было).
        if (addingGroupMembers) return;
        addingGroupMembers = true;
        try {
            await KabanAPI.addGroupMembers(newGroupTargetChatId, [...newGroupSelectedMembers.keys()]);
            toast("Участники добавлены");
            closeNewGroupModal(true);
            await refreshGroupInfoIfOpen();
        } catch (error) {
            toast("Не удалось добавить участников: " + (error?.message || error));
        } finally {
            addingGroupMembers = false;
        }
        return;
    }

    document.getElementById("new-group-step-members").hidden = true;
    document.getElementById("new-group-step-name").hidden = false;
    document.getElementById("new-group-title").focus();

}

function backToGroupMembersStep() {
    document.getElementById("new-group-step-members").hidden = false;
    document.getElementById("new-group-step-name").hidden = true;
}

async function submitCreateGroup() {

    const title = document.getElementById("new-group-title").value.trim();
    if (!title) {
        toast("Введите название группы");
        return;
    }

    const createBtn = document.getElementById("new-group-create-btn");
    createBtn.disabled = true;

    try {
        const chatId = await KabanAPI.createGroupChat(title, [...newGroupSelectedMembers.keys()]);

        if (newGroupAvatarFile) {
            const url = await KabanAPI.uploadGroupAvatar(chatId, newGroupAvatarFile);
            await KabanAPI.updateGroupInfo(chatId, { avatarUrl: url });
        }

        closeNewGroupModal(true);
        await loadChatList();
        await openRealChat(chatId);

    } catch (error) {
        toast("Не удалось создать группу: " + (error?.message || error));
    } finally {
        createBtn.disabled = false;
    }

}


/* ---- роли и права в группе (по образцу Telegram) ----------------------------
   Владелец (chats.owner_id) может всё. Админ имеет набор прав (admin_rights) и
   необязательную должность. Обычный участник ограничен разрешениями группы
   (member_permissions). Всё это дублируется проверками на сервере (schema.sql →
   "ГРУППЫ: РОЛИ И ПРАВА") — здесь только то, что показывать и что блокировать
   в интерфейсе. Пока миграция не накатана, currentGroupInfo === null и всё
   работает по-старому (админ = переименование/аватар/исключение). */

const GROUP_ADMIN_RIGHTS = [
    { key: "change_info",     label: "Изменение профиля группы",   hint: "Название, описание и фото" },
    { key: "delete_messages", label: "Удаление сообщений",         hint: "Удалять сообщения других участников у всех" },
    { key: "ban_users",       label: "Блокировка участников",      hint: "Исключать и блокировать, менять разрешения группы" },
    { key: "invite_users",    label: "Добавление участников",      hint: "Приглашать людей в группу" },
    { key: "pin_messages",    label: "Закрепление сообщений",      hint: "Закреплять сообщения для всех" },
    { key: "add_admins",      label: "Назначение администраторов", hint: "Добавлять новых администраторов" }
];

const GROUP_MEMBER_PERMISSIONS = [
    { key: "send_messages", label: "Отправка сообщений" },
    { key: "send_media",    label: "Отправка медиа и файлов" },
    { key: "add_members",   label: "Добавление участников" },
    { key: "pin_messages",  label: "Закрепление сообщений" },
    { key: "change_info",   label: "Изменение профиля группы" }
];

// { description, ownerId, memberPermissions } открытой группы; null — данных
// ещё нет или миграция не накатана.
let currentGroupInfo = null;
let groupAdminEditorTarget = null;

function iAmGroupOwner() {
    return !!currentGroupInfo && currentGroupInfo.ownerId === myRealUserId;
}

function myGroupMember() {
    return currentChatMembersById.get(myRealUserId) || null;
}

// Право админа (владелец — всегда). Без миграции — как раньше: админ мог только
// менять профиль и исключать.
function groupHasRight(right) {
    if (iAmGroupOwner()) return true;
    const me = myGroupMember();
    if (me?.role !== "admin") return false;
    if (!currentGroupInfo) return right === "change_info" || right === "ban_users";
    return !!me.admin_rights?.[right];
}

function groupMemberPermission(perm) {
    return !!currentGroupInfo?.memberPermissions?.[perm];
}

function groupMayChangeInfo() { return groupHasRight("change_info") || (!!currentGroupInfo && groupMemberPermission("change_info")); }
function groupMayAddMembers() { return groupHasRight("invite_users") || (currentGroupInfo ? groupMemberPermission("add_members") : true); }
function groupMayPin()        { return groupHasRight("pin_messages") || (currentGroupInfo ? groupMemberPermission("pin_messages") : true); }
function groupMayDeleteOthers() { return !!currentGroupInfo && groupHasRight("delete_messages"); }

// Писать/слать медиа могут владелец и все админы; обычные участники — по разрешениям.
function groupMayWrite() {
    if (!currentGroupInfo || iAmGroupOwner() || myGroupMember()?.role === "admin") return true;
    return groupMemberPermission("send_messages");
}

function groupMayAttach() {
    if (!currentGroupInfo || iAmGroupOwner() || myGroupMember()?.role === "admin") return true;
    return groupMemberPermission("send_media");
}

function groupMemberRoleLabel(userId, member) {
    if (currentGroupInfo && userId === currentGroupInfo.ownerId) return "Владелец";
    if (member?.role === "admin") return member.admin_title || "Администратор";
    return "";
}

// Блокирует поле ввода/вложения/запись в группе, где мне нельзя писать или
// слать медиа (владелец и админы — без ограничений). В личных чатах не
// трогает ничего — там своя логика блокировки (applyBlockUIState).
function syncGroupComposerLock() {

    const input = document.getElementById("input");
    const sendButton = document.getElementById("composer-send-button");
    if (!input) return;

    if (!input.dataset.defaultPlaceholder) input.dataset.defaultPlaceholder = input.placeholder || "";

    const isGroup = currentChatType === "group";
    const cannotWrite = isGroup && !groupMayWrite();
    const cannotAttach = isGroup && !cannotWrite && !groupMayAttach();

    // Не группа: снимаем только НАШУ блокировку (от прошлой открытой группы);
    // блокировку пользователя в личном чате выставляет applyBlockUIState.
    if (!isGroup && input.dataset.groupLocked !== "1") return;

    input.dataset.groupLocked = (cannotWrite || cannotAttach) ? "1" : "";
    input.disabled = cannotWrite;
    input.placeholder = cannotWrite ? "Писать здесь могут только администраторы" : input.dataset.defaultPlaceholder;
    if (sendButton) sendButton.disabled = cannotWrite;

    document.querySelectorAll('.record-button, [onclick^="toggleAttachMenu"]').forEach((control) => {
        control.disabled = cannotWrite || cannotAttach;
    });

}

async function loadGroupDetails(chatId) {

    try {
        const details = await KabanAPI.getGroupDetails(chatId);
        if (currentChatId !== chatId || currentChatType !== "group") return;
        currentGroupInfo = details
            ? { description: details.description || "", ownerId: details.owner_id || null, memberPermissions: details.member_permissions || {} }
            : null;
        syncGroupComposerLock();
        if (document.getElementById("group-info-backdrop").classList.contains("open")) renderGroupInfoModal();
    } catch (error) {
        console.warn("Не удалось загрузить данные группы", error);
    }

}

/* ИНФОРМАЦИЯ О ГРУППЕ: клик по шапке чата (.person) — для личных чатов
   открывает прежнюю карточку собеседника (toggleContactPopover), для
   групп — этот экран: профиль группы, разрешения, администраторы,
   участники с ролями и управление ими. */

function handlePersonClick() {
    if (currentChatType === "group") {
        openGroupInfoModal();
    } else {
        toggleContactPopover();
    }
}

async function openGroupInfoModal() {

    if (!currentChatId || currentChatType !== "group") return;

    renderGroupInfoModal();

    const backdrop = document.getElementById("group-info-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    refreshGroupInfoIfOpen(); // свежие данные подтянутся и перерисуют окно

}

function closeGroupInfoModal() {
    const backdrop = document.getElementById("group-info-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeGroupInfoModalFromBackdrop(event) {
    if (event.target === event.currentTarget) closeGroupInfoModal();
}

function openGroupSubModal(id) {
    const backdrop = document.getElementById(id);
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeGroupSubModal(id) {
    const backdrop = document.getElementById(id);
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeGroupSubModalFromBackdrop(event) {
    if (event.target === event.currentTarget) closeGroupSubModal(event.currentTarget.id);
}

function closeAllGroupModals() {
    ["group-info-backdrop", "group-member-backdrop", "group-admin-backdrop", "group-admins-backdrop",
     "group-perms-backdrop", "group-bans-backdrop", "group-invite-backdrop", "group-confirm-backdrop"].forEach(closeGroupSubModal);
}

// Диалог подтверждения (исключить, заблокировать, передать владение, удалить).
function openGroupConfirm({ title, text, confirmLabel = "Подтвердить", onConfirm }) {
    document.getElementById("group-confirm-title").textContent = title;
    document.getElementById("group-confirm-text").textContent = text;
    const ok = document.getElementById("group-confirm-ok");
    ok.textContent = confirmLabel;
    ok.onclick = async () => {
        closeGroupSubModal("group-confirm-backdrop");
        await onConfirm();
    };
    openGroupSubModal("group-confirm-backdrop");
}

// Перечитать участников и данные группы с сервера; если окно информации открыто —
// перерисовать. Заодно проверяем, не исключили ли меня самого.
async function refreshGroupInfoIfOpen() {

    if (!currentChatId || currentChatType !== "group") return;
    const chatId = currentChatId;

    let members;
    try {
        members = await KabanAPI.getChatMembers(chatId);
    } catch (error) {
        console.warn("Не удалось обновить участников группы", error);
        return;
    }
    if (currentChatId !== chatId) return;

    groupMembersCache.set(chatId, members);

    if (members.length && !members.some((m) => m.user_id === myRealUserId)) {
        handleRemovedFromGroup(chatId);
        return;
    }

    currentChatMembersById = new Map(members.map((m) => [m.user_id, { ...m.users, role: m.role, admin_rights: m.admin_rights, admin_title: m.admin_title, promoted_by: m.promoted_by }]));

    const el = document.querySelector(".person-status");
    if (el && !el.classList.contains("is-typing")) {
        el.textContent = `${currentChatMembersById.size} ${pluralRu(currentChatMembersById.size, "участник", "участника", "участников")}`;
    }

    await loadGroupDetails(chatId);
    syncGroupComposerLock();

    if (document.getElementById("group-info-backdrop").classList.contains("open")) {
        renderGroupInfoModal();
    }
    if (document.getElementById("group-admins-backdrop").classList.contains("open")) renderGroupAdminsModal();

}

// Меня исключили (или группу удалили) — закрываем чат и убираем его из списка.
function handleRemovedFromGroup(chatId) {
    closeAllGroupModals();
    if (currentChatId === chatId) backToChats();
    cachedChatRows = cachedChatRows.filter((row) => row.chat_id !== chatId);
    groupMembersCache.delete(chatId);
    refreshChatListLocally();
    toast("Вы больше не участник этой группы");
}

let groupRefreshTimer = null;

// Realtime: изменился состав/роли — перечитываем с небольшой задержкой (пачка
// событий, например при назначении админа, даёт один запрос, а не несколько).
function scheduleGroupRefresh() {
    if (currentChatType !== "group") return;
    clearTimeout(groupRefreshTimer);
    groupRefreshTimer = setTimeout(refreshGroupInfoIfOpen, 350);
}

// Realtime: изменилась строка самой группы (название, описание, аватар, разрешения).
function applyGroupChatUpdate(chat) {

    if (!chat || chat.id !== currentChatId || currentChatType !== "group") return;

    const row = cachedChatRows.find((r) => r.chat_id === chat.id);
    if (row?.chats) {
        row.chats.title = chat.title;
        row.chats.avatar_url = chat.avatar_url;
    }
    if (chat.title && chat.title !== currentChatTitle) {
        currentChatTitle = chat.title;
    }
    applyContactProfile({ name: currentChatTitle, avatar: "👥", photo: chat.avatar_url || null, username: "" });

    currentGroupInfo = {
        description: chat.description || "",
        ownerId: chat.owner_id || null,
        memberPermissions: chat.member_permissions || {}
    };

    syncGroupComposerLock();
    refreshChatListLocally();
    if (document.getElementById("group-info-backdrop").classList.contains("open")) renderGroupInfoModal();

}

function buildGroupAvatarHTML(user, size = "") {
    const av = avatarParts({ id: user.id, name: user.display_name || user.username, url: user.avatar_url, kind: user.is_bot && !user.avatar_url ? "bot" : "user" });
    return `<span class="new-chat-result-avatar${av.cls}${user.is_bot ? " chat-avatar-bot" : ""}${size}"${av.style}>${av.inner}</span>`;
}

function renderGroupInfoModal() {

    const canEdit = groupMayChangeInfo();
    const membersTotal = currentChatMembersById.size;

    const titleInput = document.getElementById("group-info-title");
    if (document.activeElement !== titleInput) titleInput.value = currentChatTitle;
    titleInput.readOnly = !canEdit;

    document.getElementById("group-info-subtitle").textContent =
        `${membersTotal} ${pluralRu(membersTotal, "участник", "участника", "участников")}`;

    const description = document.getElementById("group-info-description");
    if (document.activeElement !== description) description.value = currentGroupInfo?.description || "";
    description.readOnly = !canEdit;
    description.hidden = !currentGroupInfo || (!description.value && !canEdit);

    const avatarEl = document.getElementById("group-info-avatar");
    const hero = document.getElementById("group-info-hero");
    const meta = cachedChatRows.find((row) => row.chat_id === currentChatId);
    const avatarUrl = meta?.chats?.avatar_url;
    // Фон шапки: цвет из названия группы (у каждой свой) либо размытое фото группы.
    let hue = 0;
    for (const ch of currentChatTitle || "") hue = (hue * 31 + ch.charCodeAt(0)) % 360;
    hero.style.setProperty("--gh", String(hue));
    hero.style.setProperty("--gp", avatarUrl ? cssUrlValue(avatarUrl) : "none");
    hero.classList.toggle("has-photo", !!avatarUrl);
    avatarEl.style.backgroundImage = avatarUrl ? cssUrlValue(avatarUrl) : "";
    avatarEl.classList.toggle("has-photo", !!avatarUrl);
    avatarEl.classList.toggle("editable", canEdit);
    document.getElementById("group-info-about").hidden = description.hidden;
    document.getElementById("group-info-members-count").textContent = String(membersTotal);

    const adminCount = [...currentChatMembersById.values()].filter((m) => m.role === "admin").length;
    document.getElementById("group-info-admins-count").textContent = adminCount ? String(adminCount) : "";

    const canBan = !!currentGroupInfo && groupHasRight("ban_users");
    const permsBtn = document.getElementById("group-info-permissions-btn");
    permsBtn.hidden = !canBan;
    if (currentGroupInfo) {
        const enabled = GROUP_MEMBER_PERMISSIONS.filter((p) => groupMemberPermission(p.key)).length;
        document.getElementById("group-info-permissions-meta").textContent = `${enabled}/${GROUP_MEMBER_PERMISSIONS.length}`;
    }
    document.getElementById("group-info-bans-btn").hidden = !canBan;

    document.getElementById("group-info-add-btn").hidden = !groupMayAddMembers();
    const mayInvite = !!currentGroupInfo && groupMayAddMembers();
    document.getElementById("group-quick-add").hidden = !groupMayAddMembers();
    document.getElementById("group-quick-link").hidden = !mayInvite;
    document.getElementById("group-info-delete-btn").hidden = !iAmGroupOwner();

    // Владелец, затем администраторы, затем остальные (внутри — по давности вступления).
    const rank = (userId, member) => (currentGroupInfo && userId === currentGroupInfo.ownerId ? 0 : member.role === "admin" ? 1 : 2);
    const ordered = [...currentChatMembersById.entries()].sort((a, b) => rank(a[0], a[1]) - rank(b[0], b[1]));

    const list = document.getElementById("group-info-members-list");
    list.innerHTML = ordered.map(([userId, user]) => {
        const roleLabel = groupMemberRoleLabel(userId, user);
        const isOwner = currentGroupInfo && userId === currentGroupInfo.ownerId;
        const clickable = userId !== myRealUserId;
        return `
        <div class="new-chat-result-row group-info-member-row${clickable ? " clickable" : ""}"${clickable ? ` role="button" tabindex="0" data-user-id="${escapeHTML(userId)}" onclick="openGroupMemberModal(this.dataset.userId)" onkeydown="if (event.key === 'Enter') openGroupMemberModal(this.dataset.userId)"` : ""}>
            ${buildGroupAvatarHTML(user)}
            <span class="group-info-member-copy">
                <span class="group-info-member-name">${escapeHTML(user.display_name || "Пользователь")}${userId === myRealUserId ? " (вы)" : ""}</span>
                ${roleLabel ? `<span class="group-info-admin-badge${isOwner ? " owner" : ""}">${escapeHTML(roleLabel)}</span>` : ""}
                ${user.is_bot ? '<span class="group-info-admin-badge">бот</span>' : ""}
                ${userId !== myRealUserId ? (isUserEffectivelyOnline(user) ? '<span class="group-member-online">в сети</span>' : (lastSeenOf(user) ? `<span class="group-member-seen">${escapeHTML(formatLastSeen(lastSeenOf(user)))}</span>` : "")) : ""}
            </span>
            ${clickable ? '<span class="group-info-member-chevron" aria-hidden="true">›</span>' : ""}
        </div>`;
    }).join("");

}

async function saveGroupTitleEdit() {

    const titleInput = document.getElementById("group-info-title");
    const title = titleInput.value.trim();
    if (!title || title === currentChatTitle || !groupMayChangeInfo()) {
        titleInput.value = currentChatTitle;
        return;
    }

    try {
        await KabanAPI.updateGroupInfo(currentChatId, { title });
        currentChatTitle = title;
        const row = cachedChatRows.find((r) => r.chat_id === currentChatId);
        applyContactProfile({ name: title, avatar: "👥", photo: row?.chats?.avatar_url || null });
        if (row) { row.chats.title = title; refreshChatListLocally(); }
    } catch (error) {
        titleInput.value = currentChatTitle;
        toast("Не удалось переименовать группу: " + (error?.message || error));
    }

}

async function saveGroupDescriptionEdit() {

    const field = document.getElementById("group-info-description");
    const description = field.value.trim();
    if (!currentGroupInfo || description === (currentGroupInfo.description || "") || !groupMayChangeInfo()) {
        field.value = currentGroupInfo?.description || "";
        return;
    }

    try {
        await KabanAPI.updateGroupInfo(currentChatId, { description });
        currentGroupInfo.description = description;
        toast(description ? "Описание сохранено" : "Описание удалено");
    } catch (error) {
        field.value = currentGroupInfo.description || "";
        toast("Не удалось сохранить описание: " + (error?.message || error));
    }

}

async function selectGroupInfoAvatarFile(input) {

    let file = input.files?.[0];
    input.value = "";
    if (!file || !currentChatId || !groupMayChangeInfo()) return;
    // Раньше принималось что угодно (любой файл и любого размера) и без сжатия.
    if (!file.type.startsWith("image/")) { toast("Выберите файл изображения"); return; }
    file = await compressImageFile(file, { maxDimension: 512 });
    if (file.size > 5 * 1024 * 1024) { toast("Файл слишком большой (максимум 5 МБ)"); return; }

    // Снимок: пока файл грузится, могут открыть другой чат.
    const chatId = currentChatId;
    const oldAvatarUrl = cachedChatRows.find((row) => row.chat_id === chatId)?.chats?.avatar_url;
    let url = null;

    try {
        url = await KabanAPI.uploadGroupAvatar(chatId, file);
        await KabanAPI.updateGroupInfo(chatId, { avatarUrl: url });
        const row = cachedChatRows.find((r) => r.chat_id === chatId);
        if (row) { row.chats.avatar_url = url; refreshChatListLocally(); }
        if (currentChatId === chatId) {
            applyContactProfile({ name: currentChatTitle, avatar: "👥", photo: url });
            renderGroupInfoModal();
        }
        // Старый файл аватара группы больше не нужен — та же уборка, что и
        // для личного фото профиля (см. handleAvatarFileChange).
        KabanAPI.deleteStorageFile("attachments", oldAvatarUrl);
    } catch (error) {
        if (url) KabanAPI.deleteStorageFile("attachments", url);
        toast("Не удалось обновить аватар группы: " + (error?.message || error));
    }

}

/* ---- действия над участником -------------------------------------------- */

function renderGroupMemberCard(containerId, userId, user) {
    const roleLabel = groupMemberRoleLabel(userId, user);
    document.getElementById(containerId).innerHTML = `
        ${buildGroupAvatarHTML(user, " large")}
        <div class="group-member-card-copy">
            <div class="group-member-card-name">${escapeHTML(user.display_name || "Пользователь")}</div>
            <div class="group-member-card-sub">${escapeHTML(user.username ? "@" + user.username : "")}${roleLabel ? (user.username ? " · " : "") + escapeHTML(roleLabel) : ""}</div>
        </div>`;
}

function addGroupMemberAction(container, label, handler, { danger = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "delete-choice-btn" + (danger ? " danger" : "");
    button.textContent = label;
    button.addEventListener("click", handler);
    container.appendChild(button);
}

function openGroupMemberModal(userId) {

    const user = currentChatMembersById.get(userId);
    if (!user || userId === myRealUserId) return;

    renderGroupMemberCard("group-member-card", userId, user);
    const actions = document.getElementById("group-member-actions");
    actions.innerHTML = "";

    const targetIsOwner = !!currentGroupInfo && userId === currentGroupInfo.ownerId;
    const targetIsAdmin = user.role === "admin";
    const iOwn = iAmGroupOwner();

    addGroupMemberAction(actions, "Написать сообщение", () => {
        closeAllGroupModals();
        startRealChatWith(userId);
    });

    // Назначение / права администратора. Админ с правом add_admins правит только
    // тех, кого назначил сам (так же проверяет и сервер).
    if (currentGroupInfo && !targetIsOwner && (iOwn || groupHasRight("add_admins"))) {
        if (!targetIsAdmin) {
            addGroupMemberAction(actions, "Назначить администратором", () => openGroupAdminEditor(userId));
        } else if (iOwn || user.promoted_by === myRealUserId) {
            addGroupMemberAction(actions, "Права администратора", () => openGroupAdminEditor(userId));
            addGroupMemberAction(actions, "Снять с должности администратора", () => {
                closeGroupSubModal("group-member-backdrop");
                openGroupConfirm({
                    title: "Снять администратора?",
                    text: `${user.display_name || "Участник"} станет обычным участником группы.`,
                    confirmLabel: "Снять",
                    onConfirm: () => demoteGroupAdmin(userId)
                });
            }, { danger: true });
        }
    }

    // Исключить / заблокировать: владелец — любого, админ с правом ban_users — только обычных участников.
    const canRemove = !targetIsOwner && (iOwn || (groupHasRight("ban_users") && !targetIsAdmin));
    if (canRemove) {
        addGroupMemberAction(actions, "Исключить из группы", () => {
            closeGroupSubModal("group-member-backdrop");
            openGroupConfirm({
                title: "Исключить участника?",
                text: `${user.display_name || "Участник"} будет удалён из группы, но его можно будет добавить снова.`,
                confirmLabel: "Исключить",
                onConfirm: () => removeGroupMemberAction(userId, false)
            });
        }, { danger: true });
        if (currentGroupInfo) {
            addGroupMemberAction(actions, "Заблокировать в группе", () => {
                closeGroupSubModal("group-member-backdrop");
                openGroupConfirm({
                    title: "Заблокировать участника?",
                    text: `${user.display_name || "Участник"} будет удалён из группы и не сможет вернуться, пока вы не разблокируете его.`,
                    confirmLabel: "Заблокировать",
                    onConfirm: () => removeGroupMemberAction(userId, true)
                });
            }, { danger: true });
        }
    }

    // Только владелец; ботам владение не передаём.
    if (currentGroupInfo && iOwn && !user.is_bot) {
        addGroupMemberAction(actions, "Передать права владельца", () => {
            closeGroupSubModal("group-member-backdrop");
            openGroupConfirm({
                title: "Передать владение группой?",
                text: `${user.display_name || "Участник"} станет владельцем со всеми правами, а вы останетесь администратором. Отменить это сможет только новый владелец.`,
                confirmLabel: "Передать",
                onConfirm: () => transferGroupOwnership(userId)
            });
        }, { danger: true });
    }

    openGroupSubModal("group-member-backdrop");

}

async function removeGroupMemberAction(userId, ban) {
    try {
        await KabanAPI.kickGroupMember(currentChatId, userId, ban);
        toast(ban ? "Участник заблокирован" : "Участник исключён");
        await refreshGroupInfoIfOpen();
    } catch (error) {
        toast("Не удалось: " + (error?.message || error));
    }
}

async function demoteGroupAdmin(userId) {
    try {
        await KabanAPI.removeGroupAdmin(currentChatId, userId);
        toast("Администратор снят");
        await refreshGroupInfoIfOpen();
    } catch (error) {
        toast("Не удалось снять администратора: " + (error?.message || error));
    }
}

async function transferGroupOwnership(userId) {
    try {
        await KabanAPI.transferGroupOwner(currentChatId, userId);
        toast("Владение передано");
        await refreshGroupInfoIfOpen();
    } catch (error) {
        toast("Не удалось передать владение: " + (error?.message || error));
    }
}

/* ---- права администратора ------------------------------------------------ */

function buildSwitchRow({ id, label, hint, checked, disabled }) {
    return `
        <label class="group-switch-row${disabled ? " disabled" : ""}">
            <span class="group-switch-copy">
                <span class="group-switch-label">${escapeHTML(label)}</span>
                ${hint ? `<span class="group-switch-hint">${escapeHTML(hint)}</span>` : ""}
            </span>
            <input type="checkbox" class="group-switch-input" id="${id}"${checked ? " checked" : ""}${disabled ? " disabled" : ""}>
            <span class="group-switch-track" aria-hidden="true"></span>
        </label>`;
}

function openGroupAdminEditor(userId) {

    const user = currentChatMembersById.get(userId);
    if (!user) return;
    groupAdminEditorTarget = userId;

    closeGroupSubModal("group-member-backdrop");
    closeGroupSubModal("group-admins-backdrop");
    renderGroupMemberCard("group-admin-card", userId, user);

    const isAdmin = user.role === "admin";
    const iOwn = iAmGroupOwner();
    // Новому админу по умолчанию — всё, что есть у меня (кроме права назначать
    // других админов); существующему — его текущие права.
    const defaults = { change_info: true, delete_messages: true, ban_users: true, invite_users: true, pin_messages: true, add_admins: false };

    document.getElementById("group-admin-switches").innerHTML = GROUP_ADMIN_RIGHTS.map((right) => {
        const iHave = iOwn || groupHasRight(right.key);
        const checked = isAdmin ? !!user.admin_rights?.[right.key] : (iHave && defaults[right.key]);
        // Отдать можно только то, что есть у самого (владелец — любые).
        return buildSwitchRow({ id: `group-admin-right-${right.key}`, label: right.label, hint: right.hint, checked, disabled: !iHave });
    }).join("");

    document.getElementById("group-admin-title").value = isAdmin ? (user.admin_title || "") : "";
    document.getElementById("group-admin-save").textContent = isAdmin ? "Сохранить" : "Назначить администратором";
    document.getElementById("group-admin-remove").hidden = !isAdmin;

    openGroupSubModal("group-admin-backdrop");

}

async function saveGroupAdminRights() {

    const userId = groupAdminEditorTarget;
    if (!userId || !currentChatId) return;

    const rights = {};
    GROUP_ADMIN_RIGHTS.forEach((right) => {
        rights[right.key] = !!document.getElementById(`group-admin-right-${right.key}`)?.checked;
    });
    const title = document.getElementById("group-admin-title").value.trim();
    const wasAdmin = currentChatMembersById.get(userId)?.role === "admin";

    try {
        await KabanAPI.setGroupAdmin(currentChatId, userId, rights, title);
        closeGroupSubModal("group-admin-backdrop");
        toast(wasAdmin ? "Права сохранены" : "Администратор назначен");
        await refreshGroupInfoIfOpen();
    } catch (error) {
        toast("Не удалось сохранить: " + (error?.message || error));
    }

}

function removeGroupAdminFromEditor() {
    const userId = groupAdminEditorTarget;
    if (!userId) return;
    closeGroupSubModal("group-admin-backdrop");
    demoteGroupAdmin(userId);
}

/* ---- список администраторов ---------------------------------------------- */

function openGroupAdminsModal() {
    renderGroupAdminsModal();
    openGroupSubModal("group-admins-backdrop");
}

function renderGroupAdminsModal() {

    const entries = [...currentChatMembersById.entries()];
    const admins = entries
        .filter(([, member]) => member.role === "admin")
        .sort((a, b) => (currentGroupInfo && b[0] === currentGroupInfo.ownerId ? 1 : 0) - (currentGroupInfo && a[0] === currentGroupInfo.ownerId ? 1 : 0));

    const iOwn = iAmGroupOwner();
    const canManage = !!currentGroupInfo && (iOwn || groupHasRight("add_admins"));

    document.getElementById("group-admins-list").innerHTML = admins.length
        ? admins.map(([userId, user]) => {
            const editable = canManage && userId !== myRealUserId && !(currentGroupInfo && userId === currentGroupInfo.ownerId)
                && (iOwn || user.promoted_by === myRealUserId);
            return `
            <div class="new-chat-result-row group-info-member-row${editable ? " clickable" : ""}"${editable ? ` role="button" tabindex="0" data-user-id="${escapeHTML(userId)}" onclick="openGroupAdminEditor(this.dataset.userId)"` : ""}>
                ${buildGroupAvatarHTML(user)}
                <span class="group-info-member-copy">
                    <span class="group-info-member-name">${escapeHTML(user.display_name || "Пользователь")}${userId === myRealUserId ? " (вы)" : ""}</span>
                    <span class="group-info-admin-badge${currentGroupInfo && userId === currentGroupInfo.ownerId ? " owner" : ""}">${escapeHTML(groupMemberRoleLabel(userId, user))}</span>
                </span>
                ${editable ? '<span class="group-info-member-chevron" aria-hidden="true">›</span>' : ""}
            </div>`;
        }).join("")
        : '<div class="group-perms-hint">Администраторов нет</div>';

    const candidates = canManage
        ? entries.filter(([userId, member]) => member.role !== "admin" && !member.is_bot && userId !== myRealUserId)
        : [];
    document.getElementById("group-admins-candidates-label").hidden = !candidates.length;
    document.getElementById("group-admins-candidates").innerHTML = candidates.map(([userId, user]) => `
        <div class="new-chat-result-row group-info-member-row clickable" role="button" tabindex="0" data-user-id="${escapeHTML(userId)}" onclick="openGroupAdminEditor(this.dataset.userId)">
            ${buildGroupAvatarHTML(user)}
            <span class="group-info-member-copy"><span class="group-info-member-name">${escapeHTML(user.display_name || "Пользователь")}</span></span>
            <span class="group-info-member-chevron" aria-hidden="true">＋</span>
        </div>`).join("");

}

/* ---- разрешения участников ---------------------------------------------- */

function openGroupPermissionsModal() {

    if (!currentGroupInfo) return;

    document.getElementById("group-perms-switches").innerHTML = GROUP_MEMBER_PERMISSIONS.map((perm) =>
        buildSwitchRow({ id: `group-perm-${perm.key}`, label: perm.label, checked: groupMemberPermission(perm.key), disabled: false })
    ).join("");

    GROUP_MEMBER_PERMISSIONS.forEach((perm) => {
        document.getElementById(`group-perm-${perm.key}`).addEventListener("change", (event) => saveGroupPermission(perm.key, event.target));
    });

    openGroupSubModal("group-perms-backdrop");

}

// Каждое переключение сохраняется сразу (как в Telegram); при ошибке — откат.
async function saveGroupPermission(key, checkbox) {

    const value = checkbox.checked;
    try {
        await KabanAPI.setGroupPermissions(currentChatId, { [key]: value });
        currentGroupInfo.memberPermissions = { ...currentGroupInfo.memberPermissions, [key]: value };
        syncGroupComposerLock();
        renderGroupInfoModal();
    } catch (error) {
        checkbox.checked = !value;
        toast("Не удалось сохранить разрешение: " + (error?.message || error));
    }

}

/* ---- чёрный список группы ---------------------------------------------- */

async function openGroupBansModal() {

    const list = document.getElementById("group-bans-list");
    list.innerHTML = '<div class="group-perms-hint">Загрузка…</div>';
    openGroupSubModal("group-bans-backdrop");

    try {
        const bans = await KabanAPI.listGroupBans(currentChatId);
        if (!bans.length) {
            list.innerHTML = '<div class="group-perms-hint">Заблокированных нет</div>';
            return;
        }
        list.innerHTML = bans.map((ban) => `
            <div class="new-chat-result-row group-info-member-row">
                ${buildGroupAvatarHTML(ban)}
                <span class="group-info-member-copy"><span class="group-info-member-name">${escapeHTML(ban.display_name || "Пользователь")}</span></span>
                <button type="button" class="group-unban-btn" data-user-id="${escapeHTML(ban.user_id)}" onclick="unbanGroupMemberAction(this)">Разблокировать</button>
            </div>`).join("");
    } catch (error) {
        list.innerHTML = '<div class="group-perms-hint">Не удалось загрузить список</div>';
        console.warn("Не удалось загрузить заблокированных", error);
    }

}

async function unbanGroupMemberAction(button) {
    try {
        await KabanAPI.unbanGroupMember(currentChatId, button.dataset.userId);
        button.closest(".group-info-member-row")?.remove();
        toast("Участник разблокирован");
    } catch (error) {
        toast("Не удалось разблокировать: " + (error?.message || error));
    }
}

/* ---- пригласительная ссылка ------------------------------------------- */

function buildGroupInviteLink(code) {
    return window.location.href.split("#")[0] + "#join=" + code;
}

async function openGroupInviteModal(reset = false) {

    const field = document.getElementById("group-invite-link");
    field.value = "Загрузка…";
    openGroupSubModal("group-invite-backdrop");

    try {
        const code = await KabanAPI.getGroupInviteCode(currentChatId, reset);
        field.value = buildGroupInviteLink(code);
    } catch (error) {
        field.value = "";
        closeGroupSubModal("group-invite-backdrop");
        toast("Не удалось получить ссылку: " + (error?.message || error));
    }

}

async function copyGroupInviteLink() {
    const field = document.getElementById("group-invite-link");
    if (!field.value.includes("#join=")) return;
    try {
        await navigator.clipboard.writeText(field.value);
        toast("Ссылка скопирована");
    } catch {
        field.select();
        toast("Скопируйте ссылку вручную (Ctrl+C)");
    }
}

function resetGroupInviteLink() {
    openGroupConfirm({
        title: "Сбросить ссылку?",
        text: "Старая ссылка перестанет работать, будет создана новая.",
        confirmLabel: "Сбросить",
        onConfirm: () => openGroupInviteModal(true)
    });
}

// Открыли ссылку #join=КОД: показываем, в какую группу зовут, и вступаем по согласию.
async function handleJoinInviteHash() {

    const match = window.location.hash.match(/^#join=([A-Za-z0-9]+)$/);
    if (!match) return;
    const code = match[1];
    history.replaceState(null, "", window.location.pathname + window.location.search);

    let preview;
    try {
        preview = await KabanAPI.previewGroupInvite(code);
    } catch (error) {
        toast("Не удалось проверить ссылку: " + (error?.message || error));
        return;
    }

    if (!preview) { toast("Ссылка недействительна или была отозвана"); return; }
    if (preview.banned) { toast("Вы заблокированы в этой группе"); return; }
    if (preview.already_member) { openRealChat(preview.chat_id); return; }

    openGroupConfirm({
        title: "Вступить в группу?",
        text: `«${preview.title || "Группа"}» · ${preview.members} ${pluralRu(preview.members, "участник", "участника", "участников")}`,
        confirmLabel: "Вступить",
        onConfirm: async () => {
            try {
                const chatId = await KabanAPI.joinGroupByInvite(code);
                await loadChatList();
                openRealChat(chatId);
                toast("Вы вступили в группу");
            } catch (error) {
                toast("Не удалось вступить: " + (error?.message || error));
            }
        }
    });

}

/* ---- удалить группу ---------------------------------------------------- */

function confirmDeleteCurrentGroup() {

    if (!currentChatId || !iAmGroupOwner()) return;
    const chatId = currentChatId;

    openGroupConfirm({
        title: "Удалить группу?",
        text: `Группа «${currentChatTitle}» и вся её переписка будут удалены у всех участников без возможности восстановления.`,
        confirmLabel: "Удалить группу",
        onConfirm: async () => {
            try {
                await KabanAPI.deleteGroup(chatId);
                closeAllGroupModals();
                backToChats();
                cachedChatRows = cachedChatRows.filter((row) => row.chat_id !== chatId);
                groupMembersCache.delete(chatId);
                refreshChatListLocally();
                toast("Группа удалена");
            } catch (error) {
                toast("Не удалось удалить группу: " + (error?.message || error));
            }
        }
    });

}

function leaveCurrentGroup() {

    if (!currentChatId) return;

    const backdrop = document.getElementById("leave-group-backdrop");
    document.getElementById("leave-group-name").textContent = currentChatTitle;
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeLeaveGroupModal() {
    const backdrop = document.getElementById("leave-group-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeLeaveGroupModalFromBackdrop(event) {
    if (event.target === event.currentTarget) closeLeaveGroupModal();
}

async function confirmLeaveGroup() {

    if (!currentChatId || !myRealUserId) return;

    const leftChatId = currentChatId;

    try {
        await KabanAPI.removeGroupMember(leftChatId, myRealUserId);
        closeLeaveGroupModal();
        closeGroupInfoModal();
        backToChats();
        cachedChatRows = cachedChatRows.filter((r) => r.chat_id !== leftChatId);
        groupMembersCache.delete(leftChatId);
        refreshChatListLocally();
        toast("Вы покинули группу");
    } catch (error) {
        toast("Не удалось покинуть группу: " + (error?.message || error));
    }

}


const SHARED_MEDIA_TAB_LABELS = {
    media: "Медиа",
    files: "Файлы",
    links: "Ссылки",
    voice: "Голосовые",
    gifs: "GIF"
};

// Построчная иконка в развёрнутом списке (см. renderSharedMediaList) —
// line-art SVG вместо эмодзи, тот же стиль, что и везде по приложению.
const SHARED_MEDIA_KIND_ICON_SVG = {
    media: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10.5" r="1.8"/><path d="m21 16-5.5-5.5L7 19"/></svg>',
    files: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/></svg>',
    links: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5"/><path d="M11 7l1.3-1.3a3.5 3.5 0 0 1 5 5L16 12"/><path d="M13 17l-1.3 1.3a3.5 3.5 0 0 1-5-5L8 12"/></svg>',
    voice: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.14v13.72c0 .9.98 1.45 1.76.99l10.85-6.86a1.15 1.15 0 0 0 0-1.98L9.76 4.15C8.98 3.69 8 4.24 8 5.14Z"/></svg>',
    gifs: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10v4M12 10v4M12 12h1.5M16.5 10a2 2 0 1 0 0 4"/></svg>'
};

// НАСТОЯЩИЕ "Общие медиа" — собираются из сообщений текущего открытого
// чата (realMessagesById), а не захардкожены. message.type уже известен
// (см. sendRealAttachment/handleAttachFile): image/video → "media",
// document/audio-файл → "files", voice → "voice", текст со ссылкой →
// "links". GIF как отдельного реального типа сообщений в приложении нет —
// вкладка честно остаётся пустой, а не притворяется.
function formatSharedMediaDateLabel(createdAt) {

    const date = new Date(createdAt);
    const now = new Date();

    if (date.toDateString() === now.toDateString()) return "Сегодня";

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return "Вчера";

    return date.toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined
    });

}

const SHARED_LINK_PATTERN = /(https?:\/\/[^\s<]+|www\.[^\s<]+\.[a-z]{2,}[^\s<]*)/i;

function collectSharedMediaFromChat() {

    const items = [];

    realMessagesById.forEach((message) => {

        if (message.deleted_at) return;

        const meta = message.attachment_meta || {};
        const time = new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const dateLabel = formatSharedMediaDateLabel(message.created_at);

        if (message.type === "image" || message.type === "video") {
            items.push({
                kind: "media",
                messageId: message.id,
                name: message.type === "image" ? "Фото" : "Видео",
                metaText: `${dateLabel}, ${time}`,
                search: `${message.type === "image" ? "фото photo" : "видео video"} ${meta.name || ""}`.toLowerCase(),
                createdAt: message.created_at,
                thumbUrl: message.type === "image" ? message.attachment_url : null,
                thumbLabel: message.type === "image" ? "PHOTO" : "VIDEO"
            });
        } else if (message.type === "document" || message.type === "audio") {
            items.push({
                kind: "files",
                messageId: message.id,
                name: meta.name || "Файл",
                metaText: `${dateLabel}, ${time}${meta.size ? " · " + formatFileSize(meta.size) : ""}`,
                search: (meta.name || "файл").toLowerCase(),
                createdAt: message.created_at,
                thumbLabel: "FILE"
            });
        } else if (message.type === "voice") {
            items.push({
                kind: "voice",
                messageId: message.id,
                name: "Голосовое сообщение",
                metaText: `${dateLabel}, ${time}${meta.duration ? " · " + formatRecordingTime(Number(meta.duration)) : ""}`,
                search: "голосовое voice",
                createdAt: message.created_at,
                thumbLabel: "AUDIO"
            });
        } else if (message.type === "text" && message.text) {
            const urlMatch = message.text.match(SHARED_LINK_PATTERN);
            if (urlMatch) {
                items.push({
                    kind: "links",
                    messageId: message.id,
                    name: urlMatch[0],
                    metaText: `${dateLabel}, ${time}`,
                    search: urlMatch[0].toLowerCase(),
                    createdAt: message.created_at,
                    thumbLabel: "URL"
                });
            }
        }

    });

    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return items;

}

// Заполняет инлайн-превью (#shared-list в полной карточке собеседника)
// реальными материалами — вызывается при каждом открытии чата (см.
// openRealChat), а не один раз: иначе при переключении между чатами там
// оставались бы материалы ПРЕДЫДУЩЕГО собеседника.
function renderSharedMediaDataForCurrentChat() {

    const list = document.getElementById("shared-list");
    if (!list) return;

    const items = collectSharedMediaFromChat();

    const rows = items.map((item) => `
        <button class="shared-item" type="button" data-kind="${item.kind}" data-search="${escapeHTML(item.search)}" data-message-id="${item.messageId}" data-meta="${escapeHTML(item.metaText)}" onclick="jumpToSharedMediaMessage('${item.messageId}')">
            <span class="shared-thumb">${item.thumbUrl ? `<img src="${escapeHTML(item.thumbUrl)}" alt="" loading="lazy">` : escapeHTML(item.thumbLabel)}</span>
            <span class="shared-name">${escapeHTML(item.name)}</span>
        </button>
    `).join("");

    list.innerHTML = rows + `<div class="shared-empty" id="shared-empty">Ничего не найдено</div>`;
    filterSharedItems();

}

function jumpToSharedMediaMessage(messageId) {
    closeSharedMediaModal();
    closeContactPopover();
    closeInfoModal();
    flashMessage(messageId);
}

function getSharedMediaItems() {

    // Берём данные из уже заполненного реальными материалами списка в
    // большой карточке (см. renderSharedMediaDataForCurrentChat) — единый
    // источник правды, компактное окно ничего не дублирует руками.
    return [...document.querySelectorAll(".info .shared-item")].map((item) => ({
        kind: item.dataset.kind,
        search: (item.dataset.search || "").toLocaleLowerCase(),
        messageId: item.dataset.messageId,
        name: item.querySelector(".shared-name")?.textContent || "",
        meta: item.dataset.meta || ""
    }));

}


function openSharedMediaModal(kind) {

    closeContactPopover();

    const backdrop = document.getElementById("shared-media-backdrop");
    const tab = kind || "media";

    document.querySelectorAll("#shared-media-backdrop .shared-tab").forEach((button) => {
        const selected = button.dataset.mediaTab === tab;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
    });

    document.getElementById("shared-media-title").textContent = SHARED_MEDIA_TAB_LABELS[tab] || "Медиа";
    document.getElementById("shared-media-search").value = "";
    renderSharedMediaList(tab, "");

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}


function closeSharedMediaModal() {

    const backdrop = document.getElementById("shared-media-backdrop");

    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");

}


function closeSharedMediaFromBackdrop(event) {

    if (event.target === event.currentTarget) {
        closeSharedMediaModal();
    }

}


function backToContactPopoverFromMedia() {

    closeSharedMediaModal();
    toggleContactPopover();

}


function selectSharedMediaTab(button) {

    document.querySelectorAll("#shared-media-backdrop .shared-tab").forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
    });

    document.getElementById("shared-media-title").textContent =
        SHARED_MEDIA_TAB_LABELS[button.dataset.mediaTab] || "Медиа";

    filterSharedMediaModal();

}


function filterSharedMediaModal() {

    const activeTab = document.querySelector("#shared-media-backdrop .shared-tab.active")?.dataset.mediaTab || "media";
    const query = document.getElementById("shared-media-search").value.trim().toLocaleLowerCase();

    renderSharedMediaList(activeTab, query);

}


function renderSharedMediaList(kind, query) {

    const list = document.getElementById("shared-media-list");

    const items = getSharedMediaItems().filter((item) =>
        item.kind === kind && (!query || item.search.includes(query))
    );

    if (!items.length) {
        list.innerHTML = `<div class="shared-empty visible">Ничего не найдено</div>`;
        return;
    }

    const icon = SHARED_MEDIA_KIND_ICON_SVG[kind] || SHARED_MEDIA_KIND_ICON_SVG.media;

    // Группируем по РЕАЛЬНОЙ дате сообщения (meta начинается с "Сегодня"/
    // "Вчера"/конкретной даты — см. formatSharedMediaDateLabel), а не одним
    // общим заголовком "Сегодня" для вообще всего, как было в демо-версии.
    // Тап по материалу закрывает все карточки сверху и прыгает к настоящему
    // сообщению в чате (flashMessage) — раньше это был toast-пустышка.
    let lastDateLabel = null;
    const rows = items.map((item) => {
        const dateLabel = item.meta.split(",")[0];
        const header = dateLabel !== lastDateLabel ? `<div class="shared-group-label">${escapeHTML(dateLabel)}</div>` : "";
        lastDateLabel = dateLabel;
        return `
            ${header}
            <button class="shared-row" type="button" onclick="jumpToSharedMediaMessage('${item.messageId}')">
                <span class="shared-row-icon${kind === "voice" ? " voice" : ""}">${icon}</span>
                <span class="shared-row-copy">
                    <span class="shared-row-name">${escapeHTML(item.name)}</span>
                    <span class="shared-row-meta">${escapeHTML(item.meta)}</span>
                </span>
            </button>
        `;
    }).join("");

    list.innerHTML = rows;

}


function openFullContactInfo(tab) {

    closeContactPopover();
    openInfoModal();

    if (!tab) return;

    const tabButton = document.querySelector(`.shared-tab[data-media-tab="${tab}"]`);
    if (tabButton) {
        selectSharedTab(tabButton);
    }

}


function selectSharedTab(button) {

    document.querySelectorAll(".shared-tab").forEach((tab) => {
        const selected = tab === button;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
    });

    filterSharedItems();

}


function filterSharedItems() {

    const activeKind = document.querySelector(".shared-tab.active")?.dataset.mediaTab || "media";
    const query = document.getElementById("shared-search").value.trim().toLocaleLowerCase();
    let visibleCount = 0;

    document.querySelectorAll(".shared-item").forEach((item) => {
        const matches = item.dataset.kind === activeKind &&
            (!query || item.dataset.search.toLocaleLowerCase().includes(query));
        item.hidden = !matches;
        visibleCount += Number(matches);
    });

    document.getElementById("shared-empty").classList.toggle("visible", visibleCount === 0);

}


// "Уведомления" — настоящий is_muted чата (KabanAPI.setChatMuted), та же
// колонка, что и значок 🔕 в списке чатов, а не отдельное декоративное
// состояние, которое раньше сбрасывалось при каждом переоткрытии чата.
// "Звук" — локальная per-chat настройка (см. isChatSoundEnabled в
// script-chats.js): есть ли реальный смысл отдельно от общего mute —
// спорно, но раз уж кнопка здесь была, сделал её по-настоящему влияющей,
// а не тостом в пустоту.
async function toggleProfileAction(button) {

    if (!currentChatId) return;

    const isEnabled = button.getAttribute("aria-pressed") === "true";
    const enabled = !isEnabled;
    const hint = button.querySelector(".info-action-hint");

    if (button.dataset.profileToggle === "notifications") {

        if (contactMuteTimeouts.has(currentChatId)) {
            clearTimeout(contactMuteTimeouts.get(currentChatId));
            contactMuteTimeouts.delete(currentChatId);
            document.getElementById("mute-action-label").textContent = "Заглушить на время";
        }

        try {
            await KabanAPI.setChatMuted(currentChatId, !enabled);
            button.setAttribute("aria-pressed", String(enabled));
            hint.textContent = enabled ? "Включены" : "Отключены";
            toast(enabled ? "Уведомления включены" : "Уведомления отключены");
            const row = cachedChatRows.find((r) => r.chat_id === currentChatId);
            if (row) { row.is_muted = !enabled; refreshChatListLocally(); }
        } catch (error) {
            toast("Не удалось изменить уведомления: " + (error?.message || error));
        }

    } else if (button.dataset.profileToggle === "sound") {

        setChatSoundEnabled(currentChatId, enabled);
        button.setAttribute("aria-pressed", String(enabled));
        hint.textContent = enabled ? "Стандартный" : "Без звука";
        toast(enabled ? "Звук уведомлений включён" : "Звук уведомлений выключен");

    }

}


function toggleMuteDurations() {

    document.getElementById("mute-durations").classList.toggle("open");

}


// Реального "замолчать на N часов, потом само включится" поля в схеме нет
// (chat_participants.is_muted — просто bool, без времени истечения) —
// честный компромисс: выключаем по-настоящему (setChatMuted) ПРЯМО СЕЙЧАС,
// а обратно включаем локальным таймером. Работает, пока открыта эта
// вкладка браузера; если её закрыть раньше срока — чат останется молчать,
// и придётся включить вручную. Хуже закрытого сервером таймера, но честнее
// старой версии, где даже этого "сейчас" не происходило по-настоящему.
async function muteFor(duration) {

    if (!currentChatId) return;

    const notifications = document.querySelector('[data-profile-toggle="notifications"]');
    const chatId = currentChatId;

    try {
        await KabanAPI.setChatMuted(chatId, true);
    } catch (error) {
        toast("Не удалось заглушить: " + (error?.message || error));
        return;
    }

    notifications.setAttribute("aria-pressed", "false");
    notifications.querySelector(".info-action-hint").textContent = `Без звука ${duration}`;
    document.getElementById("mute-action-label").textContent = `Заглушено на ${duration}`;
    document.getElementById("mute-durations").classList.remove("open");
    const mutedRow = cachedChatRows.find((r) => r.chat_id === chatId);
    if (mutedRow) { mutedRow.is_muted = true; refreshChatListLocally(); }

    if (contactMuteTimeouts.has(chatId)) {
        clearTimeout(contactMuteTimeouts.get(chatId));
    }

    const muteDurations = {
        "1 час": 60 * 60 * 1000,
        "8 часов": 8 * 60 * 60 * 1000,
        "2 дня": 2 * 24 * 60 * 60 * 1000
    };

    contactMuteTimeouts.set(chatId, setTimeout(async () => {
        contactMuteTimeouts.delete(chatId);
        try {
            await KabanAPI.setChatMuted(chatId, false);
        } catch (error) {
            console.warn("Не удалось автоматически снять заглушение", error);
            return;
        }
        if (currentChatId === chatId) {
            notifications.setAttribute("aria-pressed", "true");
            notifications.querySelector(".info-action-hint").textContent = "Включены";
            document.getElementById("mute-action-label").textContent = "Заглушить на время";
        }
        const unmutedRow = cachedChatRows.find((r) => r.chat_id === chatId);
        if (unmutedRow) { unmutedRow.is_muted = false; refreshChatListLocally(); }
    }, muteDurations[duration]));

    toast(`Уведомления заглушены на ${duration}`);

}


async function shareContact() {

    closeContactPopover();

    const contactName = document.getElementById("contact-modal-name")?.textContent.trim() || "Собеседник";
    const username = document.querySelector('#contact-modal-backdrop [data-contact-field="username"]')?.textContent.trim();
    const contact = {
        title: contactName,
        text: username ? `${contactName} · ${username}` : contactName
    };

    // Раньше здесь вызывался navigator.share() — на Windows он открывает
    // системную панель «Поделиться» с иконками контактов справа экрана,
    // что выглядело как баг. Остаёмся внутри страницы: копируем в буфер.
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(contact.text);
            toast("Контакт скопирован");
        } else {
            toast(contact.text);
        }
    } catch (error) {
        toast("Не удалось поделиться контактом");
    }

}


// Применяет визуальное состояние блокировки к кнопке и композеру, БЕЗ
// похода в базу — используется и при живом переключении (toggleBlockContact),
// и при открытии чата, чтобы синхронизировать кнопку с уже сохранённым
// состоянием (см. openRealChat).
function applyBlockUIState(button, blocked) {

    button.setAttribute("aria-pressed", String(blocked));
    button.querySelector(".info-action-label").textContent = blocked
        ? "Разблокировать"
        : "Заблокировать";
    button.querySelector(".info-action-hint").textContent = blocked
        ? "Пользователь заблокирован"
        : "Ограничить сообщения";

    document.getElementById("input").disabled = blocked;
    document.querySelectorAll(".record-button").forEach((control) => {
        control.disabled = blocked;
    });
    document.getElementById("composer-send-button").disabled = blocked;

}

async function toggleBlockContact(button) {

    // Двойной клик/тап до ответа сервера запускал два параллельных setBlocked
    // с противоположными значениями — какой ответ придёт последним, то и
    // оставалось в базе, а кнопка могла показывать обратное.
    if (button.dataset.busy === "1") return;
    button.dataset.busy = "1";

    try {
        await toggleBlockContactInner(button);
    } finally {
        delete button.dataset.busy;
    }

}

async function toggleBlockContactInner(button) {

    const blocked = button.getAttribute("aria-pressed") !== "true";
    applyBlockUIState(button, blocked);
    toast(blocked ? "Пользователь заблокирован" : "Пользователь разблокирован");

    // В реальном 1:1 чате блокировка — это настоящая запись в базе
    // (chat_participants.is_blocked), которую проверяет RLS-политика
    // messages_insert_member: если Я заблокировал собеседника, он больше
    // физически не может отправить мне сообщение (не просто спрятано в
    // интерфейсе — сервер откажет). В демо-режиме/группе — только
    // визуальный эффект, как и было.
    if (currentChatId && currentChatType !== "group") {
        try {
            await KabanAPI.setBlocked(currentChatId, blocked);
        } catch (error) {
            // Откатываем UI, если запись не удалась — иначе кнопка покажет
            // не то, что реально сохранено в базе.
            applyBlockUIState(button, !blocked);
            toast("Не удалось сохранить блокировку: " + (error?.message || error));
        }
    }

}


/* РЕАКЦИИ НА СООБЩЕНИЯ (быстрая карусель + полный пикер) */

function react(button, emoji) {

    const row =
        button.closest(".message-row");

    // Добавление/снятие реакции меняет высоту строки (см. .has-reactions
    // margin-bottom) — без явного сохранения scrollTop это иногда
    // ощутимо дёргало список сообщений, если реагировали не на самое
    // нижнее сообщение. Восстанавливаем сразу и ещё раз кадром позже —
    // на случай, если реальная реакция дорисуется чуть погодя (см. ниже
    // renderReactionsInto из ответа сервера/realtime).
    const messagesEl = document.getElementById("messages");
    const preservedScrollTop = messagesEl.scrollTop;
    // Внизу ленты — остаёмся внизу (иначе чип реакции на последнем сообщении
    // уходил под поле ввода); в середине истории — держим позицию.
    const wasAtBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 24;
    const restoreScroll = () => { messagesEl.scrollTop = wasAtBottom ? messagesEl.scrollHeight : preservedScrollTop; };

    const messageId = row.dataset.messageId;
    if (currentChatId && messageId) {
        reactReal(row, messageId, emoji);
        closeReactionPickers();
        restoreScroll();
        requestAnimationFrame(restoreScroll);
        return;
    }

    let reactions =
        row.querySelector(".message-reactions");

    if (!reactions) {
        reactions = document.createElement("div");
        reactions.className = "message-reactions";
        row.appendChild(reactions);
    }

    const existingReaction =
        [...reactions.children].find((item) => item.dataset.emoji === emoji);

    if (existingReaction) {
        existingReaction.remove();
        if (!reactions.children.length) {
            row.classList.remove("has-reactions");
        }
        restoreScroll();
        return;
    }

    const reaction =
        document.createElement("button");

    reaction.type = "button";
    reaction.className = "reaction-chip active";
    reaction.dataset.emoji = emoji;
    reaction.setAttribute("aria-label", `Убрать реакцию ${emoji}`);
    reaction.title = "Нажмите, чтобы убрать реакцию";

    const emojiLabel = document.createElement("span");
    emojiLabel.textContent = emoji;
    reaction.append(emojiLabel);

    reaction.addEventListener("click", () => {
        reaction.remove();
        if (!reactions.children.length) {
            row.classList.remove("has-reactions");
        }
    });

    row.classList.add("has-reactions");
    reactions.appendChild(reaction);
    closeReactionPickers();
    restoreScroll();

}

// Реакция на настоящее сообщение: один пользователь = одна реакция
// (см. schema.sql → primary key (message_id, user_id)), поэтому клик по
// новому эмодзи заменяет мою предыдущую реакцию, а не добавляет ещё одну.
async function reactReal(row, messageId, emoji) {

    const message = realMessagesById.get(messageId);
    if (!message) return;

    // У опроса «реакция» — это голос; обычную реакцию поставить нельзя.
    if (message.attachment_meta?.poll) {
        toast("К опросу нельзя добавить реакцию — проголосуйте за вариант");
        return;
    }
    if (message.attachment_meta?.game) {
        toast("К игре нельзя добавить реакцию");
        return;
    }

    const mine = (message.reactions || []).find((r) => r.user_id === myRealUserId);
    const removing = mine?.emoji === emoji;
    const reactionsBefore = message.reactions || [];

    message.reactions = reactionsBefore.filter((r) => r.user_id !== myRealUserId);
    if (!removing) message.reactions.push({ user_id: myRealUserId, emoji });

    renderReactionsInto(row.querySelector(".message-reactions"), message.reactions, myRealUserId);

    try {
        await KabanAPI.toggleReaction(messageId, emoji);
    } catch (error) {
        toast("Не удалось поставить реакцию: " + (error?.message || error));
        // Откат оптимистичного обновления — без него реакция оставалась на
        // экране (и в локальном кеше), хотя сервер её не сохранил, и исчезала
        // бы только после перезагрузки чата.
        message.reactions = reactionsBefore;
        const currentRow = document.querySelector(`.message-row[data-message-id="${messageId}"] .message-reactions`);
        if (currentRow) renderReactionsInto(currentRow, message.reactions, myRealUserId);
    }

}


function toggleReactionPicker(button) {

    const tools =
        button.closest(".message-tools");

    const picker =
        tools.querySelector(".reaction-picker");

    const shouldOpen =
        !picker.classList.contains("open");

    closeReactionPickers();

    if (shouldOpen) {
        picker.classList.add("open");
        tools.closest(".message-row")?.classList.add("reaction-picker-open");
        button.setAttribute("aria-expanded", "true");
        positionReactionPicker(picker, button);
    }

}


function positionReactionPicker(picker, button) {

    const tools = picker.closest(".message-tools");
    const toolsRect = tools.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const messagesRect = document.getElementById("messages").getBoundingClientRect();
    picker.style.maxWidth = `${Math.max(0, messagesRect.width - 16)}px`;
    const pickerWidth = picker.getBoundingClientRect().width;
    const minLeft = messagesRect.left + 8;
    const maxLeft = Math.max(
        minLeft,
        messagesRect.right - pickerWidth - 8
    );
    const preferredLeft = buttonRect.right - pickerWidth;
    const pickerLeft = Math.max(
        minLeft,
        Math.min(preferredLeft, maxLeft)
    );

    picker.style.left = `${pickerLeft - toolsRect.left}px`;
    picker.style.right = "auto";

}


function closeReactionPickers() {

    document.querySelectorAll(".reaction-picker.open").forEach((picker) => {
        picker.classList.remove("open");
        picker.closest(".message-row")?.classList.remove("reaction-picker-open");
        picker.closest(".message-tools")
            ?.querySelector(".reaction-more")
            ?.setAttribute("aria-expanded", "false");
        picker.style.removeProperty("left");
        picker.style.removeProperty("right");
        picker.style.removeProperty("max-width");
    });

}


function toggleDark() {

    appSettings.darkMode = !appSettings.darkMode;
    applySettings();
    saveSettings();

}


// Один общий таймер скрытия на весь #toast: раньше каждый вызов ставил
// собственный setTimeout, и таймер ПЕРВОГО тоста гасил второй (показанный на
// полсекунды позже) раньше времени — два быстрых действия подряд (реакция +
// копирование) давали вторую подсказку, мигнувшую на долю секунды.
let toastHideTimer = null;
let undoToastActive = false;
let deferredToastText = null;
let settleActiveUndoToast = null;

function toast(text) {

    // Пока висит тост с кнопкой "Отмена", обычный тост не должен затирать его
    // innerHTML (кнопка пропала бы, а окно отмены, на деле, продолжало бы
    // тикать и молча подтвердило действие) — откладываем до его завершения.
    if (undoToastActive) {
        deferredToastText = text;
        return;
    }

    const element =
        document.getElementById("toast");

    element.textContent = text;

    element.classList.add("show");

    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => {

        element.classList.remove("show");

    }, 1800);

}

// Тост с кнопкой "Отмена" и собственным таймером — для действий, которые
// стоит дать откатить в короткое окно после нажатия (например, пересылку,
// см. forwardRealMessage). Использует тот же #toast, что и обычный toast(),
// поэтому не держать два одновременно надолго — но это и не нужно: действие
// либо подтверждается, либо отменяется за duration мс.
function toastWithUndo(text, onSettle, duration = 3000) {

    // Предыдущее окно отмены (если ещё идёт) закрываем как подтверждённое —
    // иначе его таймер позже скрыл бы уже ЭТОТ тост посреди его окна отмены.
    if (settleActiveUndoToast) settleActiveUndoToast(false);

    const element = document.getElementById("toast");
    clearTimeout(toastHideTimer);
    element.innerHTML = `<span class="toast-undo-text"></span><button type="button" class="toast-undo-btn">Отмена</button>`;
    element.querySelector(".toast-undo-text").textContent = text;
    element.classList.add("show");

    undoToastActive = true;
    let settled = false;

    const settle = (undone) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        undoToastActive = false;
        settleActiveUndoToast = null;
        element.classList.remove("show");
        onSettle(undone);
        if (deferredToastText) {
            const pending = deferredToastText;
            deferredToastText = null;
            toast(pending);
        }
    };

    const timer = setTimeout(() => settle(false), duration);
    settleActiveUndoToast = settle;

    element.querySelector(".toast-undo-btn").onclick = () => settle(true);

}


// textContent→innerHTML экранирует только & < > — НЕ кавычки, а результат
// повсеместно подставляется в атрибуты в двойных кавычках (title="…",
// aria-label="…", data-…="…"): имя контакта вида  x" onmouseover="…  выходило
// из атрибута и добавляло собственный обработчик (XSS через чужое имя).
// Кавычки экранируем явно — в текстовых узлах они по-прежнему отображаются
// как обычные символы.
function escapeHTML(text) {

    const div =
        document.createElement("div");

    div.textContent = text;

    return div.innerHTML.replace(/"/g, "&quot;").replace(/'/g, "&#39;");

}


// Лёгкая markdown-разметка в духе Telegram: **bold**/*bold*, _italic_,
// ~strike~, `code`, ```pre```, "> цитата" в начале строки. Текст сначала
// ПОЛНОСТЬЮ экранируется escapeHTML (защита от XSS) — разметка применяется
// уже поверх экранированной строки, поэтому вставить настоящий HTML-тег
// через это текстовое поле невозможно, что бы в нём ни набрали.
// Код/пре-блоки заменяются на временные метки ДО инлайновой разметки —
// иначе *звёздочки* внутри `кода` тоже красились бы жирным.
function applyInlineMarkup(html) {

    html = html.replace(/\*\*([^\n*]+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(^|[^\w*])\*([^\n*]+?)\*(?!\w)/g, "$1<strong>$2</strong>");
    html = html.replace(/(^|[^\w_])_([^\n_]+?)_(?!\w)/g, "$1<em>$2</em>");
    html = html.replace(/(^|[^\w~])~([^\n~]+?)~(?!\w)/g, "$1<s>$2</s>");
    // Перевод строки сразу ПОСЛЕ цитаты съедаем: блок цитаты и так начинается/кончается с новой строки,
    // а лишний \n в pre-wrap давал пустую строку между цитатой и ответом.
    html = html.replace(/(^|\n)&gt; ?(.*)(\n(?!&gt;))?/g, (m, pre, quote) => `${pre}<blockquote class="msg-quote">${quote}</blockquote>`);
    // Несколько строк цитаты подряд — один блок, а не стопка отдельных.
    html = html.replace(/<\/blockquote>\n<blockquote class="msg-quote">/g, "<br>");

    return html;

}

function copyCodeBlock(button) {
    const pre = button.previousElementSibling;
    if (!pre) return;
    // textContent у уже отрисованного <pre> возвращает текст с декодированными
    // HTML-сущностями (&lt; → <) — то, что человек реально печатал в ``` ```.
    navigator.clipboard?.writeText(pre.textContent)
        .then(() => toast("Код скопирован"))
        .catch(() => toast("Не удалось скопировать"));
}

function renderFormattedText(text) {

    // Сообщение из 1–3 эмодзи (в т.ч. стикер) — крупные анимированные эмодзи.
    const plainText = String(text || "");
    if (isEmojiOnly(plainText)) {
        const graphemes = splitGraphemes(plainText.replace(/\s+/g, ""));
        if (graphemes.length >= 1 && graphemes.length <= 3) return graphemes.map((g) => animEmojiHTML(g)).join("");
    }

    let html = escapeHTML(text);
    const stashed = [];
    const stash = (fragment) => {
        stashed.push(fragment);
        return `\u0000${stashed.length - 1}\u0000`;
    };

    html = html.replace(/```([\s\S]+?)```/g, (_, code) => stash(
        `<div class="msg-code-block-wrap"><pre class="msg-code-block">${code}</pre><button type="button" class="msg-code-copy-btn" onclick="copyCodeBlock(this)" aria-label="Копировать код" title="Копировать код">⧉</button></div>`
    ));
    html = html.replace(/`([^`\n]+?)`/g, (_, code) => stash(`<code class="msg-inline-code">${code}</code>`));

    // Спойлер — ||текст||, как в Telegram: размыт до тапа. Разметка ВНУТРИ
    // (жирный и т.п.) применяется сразу здесь, рекурсивно, до того как весь
    // спойлер уйдёт в стеш — иначе звёздочки внутри него потом красились бы
    // поверх уже готового <span>, ломая вёрстку.
    html = html.replace(/\|\|([^\n|]+?)\|\|/g, (_, inner) => stash(
        `<span class="msg-spoiler" role="button" tabindex="0" onclick="this.classList.toggle('revealed')" onkeydown="if(event.key===' '||event.key==='Enter'){event.preventDefault();this.classList.toggle('revealed')}">${applyInlineMarkup(inner)}</span>`
    ));

    // Ручная ссылка на произвольный текст — [текст](url), как markdown-линк,
    // вставляется кнопкой 🔗 в панели форматирования (см. applyComposerFormat).
    // Раньше автолинка ниже — иначе её собственный URL внутри скобок
    // подхватился бы автолинком как отдельная голая ссылка.
    html = html.replace(/\[([^\[\]\n]+?)\]\((https?:\/\/[^\s()<]+)\)/g, (_, label, url) => stash(
        `<a href="${url}" target="_blank" rel="noopener noreferrer" class="msg-link">${applyInlineMarkup(label)}</a>`
    ));

    // Ссылки — тоже до остальной разметки: подчёркивания/тильды внутри URL
    // не должны случайно сработать как markdown.
    html = html.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+\.[a-z]{2,}[^\s<]*)/gi, (match) => {
        const href = match.startsWith("http") ? match : `https://${match}`;
        return stash(`<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer" class="msg-link">${match}</a>`);
    });

    html = applyInlineMarkup(html);

    // @упоминания — подсвечиваем только реальных участников ТЕКУЩЕГО
    // группового чата (currentChatMembersById заполняется лишь для групп,
    // см. openRealChat), а не любое слово с @: иначе "спроси у @ меня потом"
    // подсветилось бы как упоминание несуществующего человека.
    if (typeof currentChatMembersById !== "undefined" && currentChatMembersById.size) {
        html = html.replace(/(^|[^\w@])@([a-zA-Z0-9_]{3,32})\b/g, (full, pre, uname) => {
            const member = [...currentChatMembersById.values()]
                .find((m) => m.username?.toLowerCase() === uname.toLowerCase());
            if (!member) return full;
            return `${pre}<span class="msg-mention" onclick="openContactFromMessage('${member.id}')">@${uname}</span>`;
        });
    }

    html = animateInlineEmojis(html);

    html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => stashed[Number(i)]);

    return html;

}


function isEmojiOnly(text) {

    const stripped = text.replace(/\s+/g, "");
    if (!stripped || stripped.length > 24) return false;

    // Строка целиком состоит из эмодзи (с учётом ZWJ-последовательностей
    // вроде 👨‍👩‍👧 и вариативных селекторов) — тогда сообщение можно
    // показать крупно, без пузыря, как в настоящих мессенджерах.
    try {
        return /^(?:\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)+$/u.test(stripped);
    } catch (error) {
        return false;
    }

}


// Группировать подряд идущие пузыри — не только "тот же отправитель", но и
// "в пределах короткого окна времени": иначе два сообщения от одного и того
// же человека, разделённые часами (а то и днями), слипались бы в один блок
// без зазора и с общей "хвостовой" галочкой пузыря, как будто это один
// присест переписки.
const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;

function isSameSender(rowA, rowB) {

    if (!rowA || !rowB) return false;
    if (rowA.classList.contains("system-message") || rowB.classList.contains("system-message")) return false;

    // В группе "тот же отправитель" — это буквально тот же sender_id, а не
    // просто "оба чужие" (иначе сообщения от РАЗНЫХ участников визуально
    // слипались бы в один блок и прятали повторную подпись имени).
    // try/catch — не подстраховка "на всякий случай": updateMessageGrouping()
    // вызывается один раз и на самой ранней демо-настройке страницы, ДО
    // того как "let realMessagesById"/"let currentChatType" ниже по файлу
    // успевают выполниться — обращение к ним в этот момент кидает
    // ReferenceError (temporal dead zone) вне какого-либо try/catch выше по
    // стеку, что обрывает остаток script.js, включая initAuthGate() в конце.
    let a, b, chatType;
    try {
        a = realMessagesById.get(rowA.dataset.messageId);
        b = realMessagesById.get(rowB.dataset.messageId);
        chatType = currentChatType;
    } catch (error) {
        return rowA.classList.contains("sent") === rowB.classList.contains("sent");
    }

    const sameSender = chatType === "group" && a && b
        ? a.sender_id === b.sender_id
        : rowA.classList.contains("sent") === rowB.classList.contains("sent");

    if (!sameSender) return false;
    if (!a || !b) return true; // демо-сообщения без записи в realMessagesById — прежнее поведение

    return Math.abs(messageTimeMs(b) - messageTimeMs(a)) <= MESSAGE_GROUP_WINDOW_MS;

}

// Разбор ISO-строки в Date — заметная доля стоимости updateMessageGrouping
// (вызывается на каждое новое сообщение по ВСЕМУ списку, по 2 парса на
// каждую пару соседей) — считаем один раз на сообщение и кладём в кеш.
function messageTimeMs(message) {
    if (message._createdMs === undefined) message._createdMs = new Date(message.created_at).getTime();
    return message._createdMs;
}


function updateMessageGrouping() {

    const rows = [...document.querySelectorAll("#messages .message-row")];

    // Связь между соседями симметрична (isSameSender(a,b) === isSameSender(b,a)):
    // считаем её ОДИН раз для каждой пары (i-1, i), а "grouped-next" у (i-1)
    // берём из того же результата — прежний код вычислял каждую пару дважды.
    // classList.toggle с тем же значением, что уже стоит, DOM не мутирует,
    // поэтому лишних инвалидаций стилей у неизменившихся строк нет.
    let sameAsPrev = false;
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        const sameAsNext = index + 1 < rows.length && isSameSender(row, rows[index + 1]);
        row.classList.toggle("grouped-prev", sameAsPrev);
        row.classList.toggle("grouped-next", sameAsNext);
        sameAsPrev = sameAsNext;
    }

    insertDateSeparators(rows);

}

// Разделители дня ("Сегодня"/"Вчера"/дата) — пересчитываются с нуля при
// каждом updateMessageGrouping (дёшево: в чате десятки-сотни сообщений,
// не тысячи), а не вставляются по кускам в каждом месте, где меняется
// список сообщений — так гарантированно не рассинхронизируются.
// Помеченные .date-auto удаляются и создаются заново; ручная метка
// "Начало переписки" (без этого класса) не трогается.
function dayKeyOf(dateInput) {
    const d = new Date(dateInput);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
}

function formatDateSeparatorLabel(dateInput) {
    const date = new Date(dateInput);
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
    if (diffDays === 0) return "Сегодня";
    if (diffDays === 1) return "Вчера";
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString("ru-RU", sameYear ? { day: "numeric", month: "long" } : { day: "numeric", month: "long", year: "numeric" });
}

function insertDateSeparators(rows) {

    const messagesContainer = document.getElementById("messages");
    // Существующие разделители не удаляем все подряд и не создаём заново на
    // каждое сообщение (это сотни вставок/удалений в живой DOM на длинной
    // переписке) — переиспользуем те, что уже стоят на нужном месте с нужной
    // подписью, а лишние убираем в конце.
    const staleSeparators = new Set(messagesContainer.querySelectorAll(".date.date-auto"));

    // updateMessageGrouping() (и через неё эта функция) вызывается один раз
    // и на самой ранней, ещё демо-настройке страницы — до того, как строка
    // "let realMessagesById = new Map()" ниже по файлу успела выполниться.
    // В этот момент обращение к realMessagesById кидает ReferenceError
    // (temporal dead zone), а поскольку этот самый ранний вызов — не внутри
    // try/catch, необработанное исключение обрывает остаток script.js,
    // включая initAuthGate() в самом конце файла. try/catch тут — не
    // заглушка на всякий случай, а обязательное условие, чтобы страница
    // вообще догружалась.
    let lastDayKey = null;
    rows.forEach((row) => {
        let message;
        try {
            message = realMessagesById.get(row.dataset.messageId);
        } catch (error) {
            return;
        }
        if (!message) return;
        const key = dayKeyOf(message.created_at);
        if (key !== lastDayKey) {
            const label = formatDateSeparatorLabel(message.created_at);
            const existing = row.previousElementSibling;
            if (existing && staleSeparators.has(existing) && existing.textContent === label) {
                staleSeparators.delete(existing); // уже на месте и с верной подписью
            } else {
                const divider = document.createElement("div");
                divider.className = "date date-auto";
                divider.textContent = label;
                messagesContainer.insertBefore(divider, row);
            }
            lastDayKey = key;
        }
    });

    staleSeparators.forEach((el) => el.remove());

}


function scheduleReadReceipt(row) {

    const status = row.querySelector(".message-status");
    if (!status) return;

    setTimeout(() => {
        status.dataset.status = "read";
        status.textContent = "✓✓";
    }, 900 + Math.random() * 700);

}


function updateChatListPreview(text, time) {

    const previewEl = document.getElementById("chat-list-preview");
    const timeEl = document.getElementById("chat-list-time");

    if (previewEl) previewEl.textContent = text;
    if (timeEl) timeEl.textContent = time;

}


function scrollElementIntoViewSafely(el, block) {

    if (!el) return;

    if (appSettings.reduceMotion) {
        el.scrollIntoView({ block, behavior: "instant" });
        return;
    }

    const before = el.getBoundingClientRect().top;
    el.scrollIntoView({ block, behavior: "smooth" });

    // Та же подстраховка, что и в scrollMessagesToBottom(): если плавная
    // прокрутка не сдвинула элемент (нет GPU-композитинга в окружении),
    // доводим до места мгновенно.
    setTimeout(() => {
        if (Math.abs(el.getBoundingClientRect().top - before) < 2) {
            el.scrollIntoView({ block, behavior: "instant" });
        }
    }, 450);

}


function scrollMessagesToBottom({ instant = false } = {}) {

    const messages = document.getElementById("messages");
    const target = messages.scrollHeight;
    setScrollToBottomBadge(0);

    // instant — при открытии чата: плавная прокрутка через всю историю выглядела
    // как «проматывание» и заставляла браузер отрисовать каждый кадр пути.
    if (instant || appSettings.reduceMotion) {
        messages.scrollTop = target;
        return;
    }

    const startTop = messages.scrollTop;
    messages.scrollTo({ top: target, behavior: "smooth" });

    // В некоторых окружениях (встроенные веб-вью без GPU-композитинга)
    // плавный scrollTo не выполняется вообще — подстраховываемся и
    // доводим до конца мгновенно, но ТОЛЬКО если прокрутка вообще не сдвинулась:
    // раньше, если человек за эти 450 мс успевал крутнуть колесо вверх, его
    // насильно возвращало вниз.
    setTimeout(() => {
        const stillFar = messages.scrollHeight - messages.scrollTop - messages.clientHeight > 40;
        if (stillFar && Math.abs(messages.scrollTop - startTop) < 2) {
            messages.scrollTop = messages.scrollHeight;
        }
    }, 450);

}


function updateScrollToBottomButton() {

    const messages = document.getElementById("messages");
    const button = document.getElementById("scroll-to-bottom");
    const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    const isFar = distanceFromBottom > 200;

    button.classList.toggle("visible", isFar);
    // Рядом с нижним краем новые сообщения и так видны — счётчик уже не нужен.
    if (!isFar) setScrollToBottomBadge(0);

}

// Счётчик новых сообщений, пришедших, пока человек читает историю выше —
// сбрасывается при реальном возврате к низу чата (scrollMessagesToBottom
// или естественный скролл в пределы 200px, см. updateScrollToBottomButton).
let unseenMessagesWhileScrolledUp = 0;

function setScrollToBottomBadge(count) {
    unseenMessagesWhileScrolledUp = count;
    const badge = document.getElementById("scroll-to-bottom-badge");
    badge.hidden = count <= 0;
    badge.textContent = count > 9 ? "9+" : String(count);
}

function noteNewMessageWhileMaybeScrolledUp() {
    if (document.getElementById("scroll-to-bottom").classList.contains("visible")) {
        setScrollToBottomBadge(unseenMessagesWhileScrolledUp + 1);
    }
}


let activeSwipe = null;

const messageList =
    document.getElementById("messages");

messageList.addEventListener("scroll", updateScrollToBottomButton, { passive: true });

// Подгрузка старой истории при скролле почти до самого верха — см.
// loadOlderMessages. Порог в пикселях, а не "scrollTop === 0", чтобы
// сработать чуть заранее и не заставлять ждать после уже полного докрутки.
messageList.addEventListener("scroll", () => {
    if (messageList.scrollTop < 200) loadOlderMessages();
}, { passive: true });

// Метка «идёт прокрутка» — на это время ставим на паузу дрейф живых обоев
// (см. .chat-area.is-scrolling в style.css).
(function markScrolling() {
    const area = document.querySelector(".chat-area");
    if (!area) return;
    let timer = null;
    messageList.addEventListener("scroll", () => {
        if (!timer) area.classList.add("is-scrolling");
        clearTimeout(timer);
        timer = setTimeout(() => { timer = null; area.classList.remove("is-scrolling"); }, 160);
    }, { passive: true });
})();

messageList.addEventListener("pointerdown", (event) => {

    let row =
        event.target.closest(".message-row");

    // Свайп влево можно начинать и с пустого места рядом с пузырём (строка
    // сообщения по ширине равна пузырю): берём сообщение на этой же высоте.
    if (!row && !event.target.closest("button, a, input, textarea, select, .typing, .system-message")) {
        const y = event.clientY;
        for (const candidate of messageList.querySelectorAll(".message-row:not(.system-message):not(.deleted)")) {
            const rect = candidate.getBoundingClientRect();
            if (rect.bottom < y) continue;
            if (rect.top <= y) row = candidate;
            break; // строки идут сверху вниз: первая с bottom >= y — единственный кандидат
        }
    }

    if (!row || event.target.closest("button") || (event.pointerType === "mouse" && event.button !== 0)) {
        return;
    }

    activeSwipe = {
        row,
        fromGap: !event.target.closest(".message-row"),
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY
    };

    // Захват указателя — только когда жест действительно стал свайпом (см.
    // pointermove): захват сразу на нажатии ломал выделение текста мышью через
    // несколько сообщений подряд.

});

// Жест начат с пустого места ленты — браузер по умолчанию начал бы выделять
// текст соседних сообщений синим. Гасим выделение на время жеста.
messageList.addEventListener("selectstart", (event) => {
    if (activeSwipe?.fromGap) event.preventDefault();
});
messageList.addEventListener("mousedown", (event) => {
    if (!event.target.closest(".message-row, button, a, input, textarea, select")) event.preventDefault();
});

messageList.addEventListener("pointermove", (event) => {

    if (!activeSwipe || activeSwipe.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - activeSwipe.startX;
    const deltaY = event.clientY - activeSwipe.startY;

    if (deltaX >= 0 || Math.abs(deltaX) <= Math.abs(deltaY)) return;

    // Мышью — свайп только после заметного сдвига, иначе обычное выделение текста.
    if (!activeSwipe.captured) {
        if (event.pointerType === "mouse" && deltaX > -12) return;
        if (event.pointerType === "mouse" && window.getSelection()?.toString()) { activeSwipe = null; return; }
        activeSwipe.captured = true;
        try { activeSwipe.row.setPointerCapture(event.pointerId); } catch { /* указатель уже отпущен */ }
    }

    // Запись стилей — один раз на кадр, а не на каждое pointermove (на
    // устройствах с высокой частотой опроса их приходит несколько на кадр,
    // и каждая запись --swipe-x заставляла браузер пересчитывать стили).
    const swipe = activeSwipe;
    swipe.pendingOffset = deltaX;
    if (!swipe.frame) {
        swipe.frame = requestAnimationFrame(() => {
            swipe.frame = 0;
            if (activeSwipe !== swipe) return; // жест уже завершён
            swipe.row.classList.add("swiping");
            swipe.row.style.setProperty("--swipe-x", `${swipe.pendingOffset}px`);
            swipe.row.classList.toggle("reply-ready", swipe.pendingOffset <= -44);
        });
    }

});

function finishMessageSwipe(event) {

    if (!activeSwipe || activeSwipe.pointerId !== event.pointerId) return;

    const swipe = activeSwipe;
    const deltaX = event.clientX - swipe.startX;
    const deltaY = event.clientY - swipe.startY;

    if (swipe.frame) cancelAnimationFrame(swipe.frame);
    swipe.row.classList.remove("swiping", "reply-ready");
    swipe.row.style.removeProperty("--swipe-x");
    activeSwipe = null;

    if (deltaX <= -68 && Math.abs(deltaX) > Math.abs(deltaY)) {
        reply(swipe.row);
        return;
    }

    // Реакции/ответ показываются по наведению мышью (см. CSS), но на
    // тач-экране наведения не существует в принципе — без этого панель
    // реакций была вообще недоступна пальцем. Тап без свайпа переключает
    // её так же, как это делает :hover для мыши.
    const isTap = Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10;
    if (isTap && !swipe.fromGap && event.pointerType !== "mouse") {
        const wasOpen = swipe.row.classList.contains("tools-open");
        document.querySelectorAll(".message-row.tools-open").forEach((row) => row.classList.remove("tools-open"));
        if (!wasOpen) swipe.row.classList.add("tools-open");
    }

}

messageList.addEventListener("pointerup", finishMessageSwipe);
messageList.addEventListener("pointercancel", finishMessageSwipe);

/* Реакции: колесо мыши над панелью реакций скроллит её по горизонтали
   (как в Telegram) вместо вертикальной прокрутки переписки. */

// Непассивный обработчик колеса на ВСЕЙ ленте заставлял браузер перед каждым
// шагом прокрутки ждать JavaScript (прокрутка переписки подтормаживала). Теперь
// он вешается только на сами панели реакций — при первом наведении на них.
function handleReactionPanelWheel(event) {

    const track = event.target.closest(".quick-reactions-track");
    if (track) {
        event.preventDefault();
        stepQuickReactions(track, event.deltaY + event.deltaX);
        return;
    }

    const picker = event.target.closest(".reaction-picker");
    if (!picker) return;

    event.preventDefault();
    picker.scrollLeft += event.deltaY + event.deltaX;

}

messageList.addEventListener("pointerover", (event) => {
    const panel = event.target.closest?.(".quick-reactions-track, .reaction-picker");
    if (!panel || panel._wheelBound) return;
    panel._wheelBound = true;
    panel.addEventListener("wheel", handleReactionPanelWheel, { passive: false });
}, { passive: true });

function stepQuickReactions(track, delta) {

    // Ширина одного эмодзи вместе с зазором — считаем по реальной
    // разметке, а не хардкодим, чтобы шаг всегда был ровно "один эмодзи".
    const firstButton = track.querySelector("button");
    if (!firstButton) return;

    // Колесо/тачпад шлёт десятки событий за один жест, каждое из которых
    // перезапускало бы плавную прокрутку заново — один шаг за ~120мс.
    const nowMs = performance.now();
    if (track._lastStepAt && nowMs - track._lastStepAt < 120) return;
    track._lastStepAt = nowMs;

    // getComputedStyle один раз (раньше — дважды в одном выражении, оба
    // раза с принудительным пересчётом стилей).
    const trackStyles = getComputedStyle(track);
    const gap = parseFloat(trackStyles.columnGap || trackStyles.gap) || 0;
    const step = firstButton.getBoundingClientRect().width + gap;

    track.scrollBy({
        left: delta > 0 ? step : -step,
        behavior: appSettings.reduceMotion ? "instant" : "smooth"
    });

}

/* Единый поиск в сайдбаре: по уже загруженным чатам (мгновенно, локально)
   + по пользователям на сервере (с debounce), чтобы можно было найти как
   существующую переписку, так и совсем нового человека, — см. Part 3
   спецификации ("unified search across chats/people/...").
   В демо-режиме (Supabase не настроен) остаётся старое поведение — просто
   показывает/прячет единственный демо-чат по подстроке имени. */

let unifiedSearchToken = 0;
let unifiedSearchTimer = null;

document
    .getElementById("search")
    .addEventListener("input", function() {

        if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED) {
            const chat = document.querySelector(".chat");
            const name = "собеседник";
            if (chat) chat.style.display = name.includes(this.value.toLowerCase()) ? "flex" : "none";
            return;
        }

        document.getElementById("search-clear-btn").hidden = !this.value;
        clearTimeout(unifiedSearchTimer);
        unifiedSearchTimer = setTimeout(() => runUnifiedSearch(this.value.trim()), 250);

    });

function clearSidebarSearch() {
    const input = document.getElementById("search");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
}

async function runUnifiedSearch(query) {

    const resultsEl = document.getElementById("unified-search-results");
    const listContainer = document.getElementById("real-chat-list");
    const emptyState = document.getElementById("sidebar-empty-chats");
    const foldersBar = document.getElementById("chat-folders");

    if (!query) {
        resultsEl.hidden = true;
        resultsEl.innerHTML = "";
        renderChatListFromCache();
        return;
    }

    listContainer.hidden = true;
    emptyState.hidden = true;
    if (foldersBar) foldersBar.hidden = true;
    resultsEl.hidden = false;

    const lowerQuery = query.toLocaleLowerCase();
    const matchedChats = cachedChatRows.filter((row) => {
        const name = row.chats?.type === "group" ? (row.chats.title || "") : (row.otherUser?.display_name || "");
        const username = row.chats?.type === "group" ? "" : (row.otherUser?.username || "");
        return name.toLocaleLowerCase().includes(lowerQuery) || username.toLocaleLowerCase().includes(lowerQuery);
    });
    const matchedChatUserIds = new Set(matchedChats.map((row) => row.otherUser?.id).filter(Boolean));

    const token = ++unifiedSearchToken;
    resultsEl.innerHTML = `
        ${matchedChats.length ? `<div class="section-label">Чаты</div>${matchedChats.map((row) => buildChatListItemHTML(row)).join("")}` : ""}
        <div class="section-label" id="unified-search-people-label" hidden>Люди</div>
        <div id="unified-search-people-results"></div>
        ${matchedChats.length ? "" : `<div class="chat-folder-empty" id="unified-search-empty">Ищем…</div>`}
    `;

    if (typeof appendMessageSearchResults === "function") appendMessageSearchResults(query, token);

    let users;
    try {
        users = await KabanAPI.searchUsersByUsername(query);
    } catch (error) {
        return;
    }
    if (token !== unifiedSearchToken) return;

    const peopleResults = (users || []).filter((u) => u.id !== myRealUserId && !matchedChatUserIds.has(u.id));
    const peopleLabel = document.getElementById("unified-search-people-label");
    const peopleContainer = document.getElementById("unified-search-people-results");
    const emptyNotice = document.getElementById("unified-search-empty");

    if (peopleContainer) {
        if (peopleResults.length) {
            peopleLabel.hidden = false;
            peopleContainer.innerHTML = peopleResults.map(buildContactRowHTML).join("");
        }
        if (emptyNotice && !matchedChats.length && !peopleResults.length) {
            emptyNotice.textContent = "Никого не нашлось";
        } else if (emptyNotice) {
            emptyNotice.remove();
        }
    }

}

// Поиск по чату проходит по ВСЕЙ отрисованной переписке (textContent каждой
// строки + подсветка) — на длинном диалоге запускать его на каждую
// набранную букву значит зависать при быстром наборе. Ждём паузы в наборе
// (как уже сделано для поиска в сайдбаре и в окнах нового чата/группы).
let chatSearchTimer = null;
document.getElementById("chat-search-input").addEventListener("input", () => {
    clearTimeout(chatSearchTimer);
    chatSearchTimer = setTimeout(() => { chatSearchTimer = null; updateChatSearch(); }, 160);
});
document.getElementById("chat-search-prev").addEventListener("click", () => navigateChatSearch(-1));
document.getElementById("chat-search-next").addEventListener("click", () => navigateChatSearch(1));
// (Здесь был оставшийся от демо-версии обработчик: клик по материалу в карточке
// показывал всплывашку «Общий материал: …» ПОВЕРХ перехода к сообщению — убран,
// переход делает сам элемент, см. jumpToSharedMediaMessage.)

document.getElementById("chat-search-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        // Enter сразу после набора — совпадения ещё не пересчитаны из-за
        // debounce выше: досчитываем сейчас, иначе листали бы устаревший список.
        if (chatSearchTimer) {
            clearTimeout(chatSearchTimer);
            chatSearchTimer = null;
            updateChatSearch();
        }
        navigateChatSearch(event.shiftKey ? -1 : 1);
    }
});

document
    .querySelectorAll(".settings-dialog input[type='checkbox']")
    .forEach((setting) => {

        setting.addEventListener("change", () => {
            appSettings[setting.name] = setting.checked;
            applySettings();
            saveSettings();

            if (setting.name === "saveDraft") {
                try {
                    if (setting.checked) {
                        const draft = document.getElementById("input").value;
                        if (draft) {
                            localStorage.setItem(draftStorageKey(currentChatId), draft);
                        }
                    } else {
                        localStorage.removeItem(draftStorageKey(currentChatId));
                    }
                } catch (error) {
                    console.warn("Не удалось обновить черновик", error);
                }
            }

            if (setting.name === "hideChatPreviews") refreshChatListLocally();
        });

    });

document
    .getElementById("input")
    .addEventListener("input", (event) => {

        resizeComposer();
        updateComposerAction();
        updateComposerCharCounter();
        updateComposerCalculatorHint();

        // "печатает…" собеседнику — не чаще раза в 2с, иначе на каждую
        // букву улетал бы отдельный broadcast.
        if (currentChatId && chatPresenceHandle && event.target.value.trim()) {
            const now = Date.now();
            if (now - lastTypingSentAt > 2000) {
                lastTypingSentAt = now;
                chatPresenceHandle.sendTyping();
            }
        }

        if (!appSettings.saveDraft) return;

        try {
            if (event.target.value) {
                localStorage.setItem(draftStorageKey(currentChatId), event.target.value);
            } else {
                localStorage.removeItem(draftStorageKey(currentChatId));
            }
        } catch (error) {
            console.warn("Не удалось сохранить черновик", error);
        }

    });

// Панель форматирования — видна, только пока в поле есть непустое выделение.
// "select" не всегда стабильно долетает во всех браузерах при выделении
// мышью/пальцем, поэтому дублируем на mouseup/touchend/keyup — тот же
// набор событий, которым можно словить смену выделения без web-only API
// selectionchange (у него на iOS Safari были проблемы с полями ввода).
["select", "mouseup", "touchend", "keyup"].forEach((eventName) => {
    document.getElementById("input").addEventListener(eventName, syncComposerFormatBar);
});

function syncComposerFormatBar() {
    const input = document.getElementById("input");
    const bar = document.getElementById("composer-format-bar");
    bar.hidden = input.selectionStart === input.selectionEnd;
}

const COMPOSER_FORMAT_MARKERS = { bold: "**", italic: "_", strike: "~", code: "`" };

function applyComposerFormat(kind) {

    const input = document.getElementById("input");
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === end) return;

    const selected = input.value.slice(start, end);

    if (kind === "link") {
        const url = prompt("Ссылка для «" + selected + "»:", "https://");
        if (!url || !url.trim()) return;
        input.setRangeText(`[${selected}](${url.trim()})`, start, end, "end");
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true }));
        syncComposerFormatBar();
        return;
    }

    const replacement = kind === "quote"
        ? selected.split("\n").map((line) => (line ? `> ${line}` : line)).join("\n")
        : `${COMPOSER_FORMAT_MARKERS[kind]}${selected}${COMPOSER_FORMAT_MARKERS[kind]}`;

    input.setRangeText(replacement, start, end, "select");
    input.focus();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    syncComposerFormatBar();

}

document
    .getElementById("input")
    .addEventListener("keydown", (event) => {

        if (event.key !== "Enter" || event.isComposing) return;

        if (event.shiftKey || !appSettings.enterToSend) {
            event.preventDefault();
            event.currentTarget.setRangeText(
                "\n",
                event.currentTarget.selectionStart,
                event.currentTarget.selectionEnd,
                "end"
            );
            event.currentTarget.dispatchEvent(
                new Event("input", { bubbles: true })
            );
            return;
        }

        event.preventDefault();
        send();

    });

document.querySelectorAll(".record-button").forEach((button) => {

    button.setAttribute("aria-pressed", "false");

    button.addEventListener("pointerdown", (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        startRecording(button, event);
    });

    button.addEventListener("pointermove", (event) => {
        handleRecordingPointerMove(button, event);
    });

    button.addEventListener("pointerup", (event) => {
        const state = activeRecording;
        // Быстрое нажатие (короче 0,4 с) — не «забыли удержать», а запись без
        // удержания: сразу закрепляем её, дальше кнопки «удалить» / «отправить».
        // Раньше короткий тап просто выдавал «удерживайте кнопку дольше» — на
        // компьютере держать мышь минуту неудобно.
        if (state && state.button === button && !state.locked && !state.cancelArmed && event.pointerId !== -1 && Date.now() - state.pressedAt < 400) {
            lockRecording(state);
            return;
        }
        stopRecording(event.pointerId, state?.button === button && state?.cancelArmed);
    });

    button.addEventListener("pointercancel", (event) => {
        // Системная отмена указателя (например, свайп открыл системное меню) —
        // если в этот момент жест уже был на грани отмены, безопаснее
        // трактовать это как отмену записи, а не как "отпустили — отправляем".
        const state = activeRecording;
        stopRecording(event.pointerId, state?.button === button && state?.cancelArmed);
    });

    button.addEventListener("lostpointercapture", () => {
        if (activeRecording?.button === button && !activeRecording.locked) {
            stopRecording(activeRecording.pointerId, activeRecording.cancelArmed);
        }
    });

    button.addEventListener("contextmenu", (event) => event.preventDefault());

    button.addEventListener("keydown", (event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
            startRecording(button, {
                preventDefault: () => event.preventDefault(),
                pointerId: -1
            });
        }
    });

    button.addEventListener("keyup", (event) => {
        if (event.key === " " || event.key === "Enter") {
            stopRecording(-1);
        }
    });

});

// Esc — удалить запись, Enter — отправить (в закреплённом режиме).
document.addEventListener("keydown", (event) => {
    const state = activeRecording;
    if (!state || !state.locked) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); stopRecording(state.pointerId, true, true); }
    else if (event.key === "Enter") { event.preventDefault(); event.stopImmediatePropagation(); stopRecording(state.pointerId, false, true); }
}, true);

window.addEventListener("blur", () => {
    if (activeRecording) {
        stopRecording(activeRecording.pointerId, false, true);
    }
});

document.addEventListener("visibilitychange", () => {
    if (document.hidden && activeRecording) {
        stopRecording(activeRecording.pointerId);
    }
});

document.addEventListener("keydown", (event) => {

    if (event.key === "Escape") {
        closeReactionPickers();
    }

    if (event.key !== "Escape") return;

    // Окна группы друг над другом: закрываем верхнее (подокна, потом сама информация).
    const topGroupModal = ["group-confirm-backdrop", "group-invite-backdrop", "group-admin-backdrop", "group-member-backdrop", "group-admins-backdrop",
        "group-perms-backdrop", "group-bans-backdrop", "group-info-backdrop"]
        .find((id) => document.getElementById(id)?.classList.contains("open"));
    if (topGroupModal) {
        closeGroupSubModal(topGroupModal);
        return;
    }

    if (document.getElementById("attach-menu").classList.contains("open")) {
        closeAttachMenu();
        return;
    }

    if (document.getElementById("emoji-popover").classList.contains("open")) {
        closeEmojiPopover();
        return;
    }

    if (document.getElementById("call-backdrop").classList.contains("open")) {
        endCall();
        return;
    }

    if (document.getElementById("settings-backdrop").classList.contains("open")) {
        closeSettings();
        return;
    }

    if (document.getElementById("chat-search").classList.contains("open")) {
        closeChatSearch();
        return;
    }

    if (document.getElementById("safety-modal-backdrop").classList.contains("open")) {
        closeSafetyNumberModal();
        return;
    }

    if (document.getElementById("edit-contact-backdrop").classList.contains("open")) {
        closeEditContactModal();
        return;
    }

    if (document.getElementById("shared-groups-backdrop").classList.contains("open")) {
        closeSharedGroupsModal();
        return;
    }

    if (document.getElementById("new-chat-popover").classList.contains("open")) {
        closeNewChatPopover();
        return;
    }

    if (document.getElementById("command-palette-backdrop").classList.contains("open")) {
        closeCommandPalette();
        return;
    }

    if (document.getElementById("reaction-picker-popover").classList.contains("open")) {
        closeReactionPickerPopover();
        return;
    }

    if (!document.getElementById("message-context-menu").hidden) {
        document.getElementById("message-context-menu").hidden = true;
        return;
    }

    if (document.getElementById("shared-media-backdrop").classList.contains("open")) {
        closeSharedMediaModal();
        return;
    }

    if (document.getElementById("contact-modal-backdrop").classList.contains("open")) {
        closeContactPopover();
        return;
    }

    if (document.getElementById("info-modal-backdrop").classList.contains("open")) {
        closeInfoModal();
        return;
    }

    if (document.body.classList.contains("chat-selected")) {
        backToChats();
    }

});

document.addEventListener("click", (event) => {

    if (
        !event.target.closest(".reaction-picker") &&
        !event.target.closest(".reaction-more")
    ) {
        closeReactionPickers();
    }

    if (
        !event.target.closest(".attach-menu") &&
        !event.target.closest('.input-button[aria-label="Прикрепить файл"]')
    ) {
        closeAttachMenu();
    }

    if (
        !event.target.closest("#emoji-popover") &&
        !event.target.closest("#emoji-button")
    ) {
        closeEmojiPopover();
    }

    if (
        !event.target.closest("#new-chat-popover") &&
        !event.target.closest("#new-chat-button")
    ) {
        closeNewChatPopover();
    }

    if (!event.target.closest(".message-row")) {
        document.querySelectorAll(".message-row.tools-open").forEach((row) => row.classList.remove("tools-open"));
    }

});

/* РЕСАЙЗ САЙДБАРА */

const SIDEBAR_WIDTH_KEY = "kaban-sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
// Раньше сайдбар нельзя было растянуть шире фиксированных 480px. Теперь
// предел — 70% ширины окна: чат при этом сужается ниже порога контейнерных
// запросов в style.css (.main { container-type }) и сам переключается на
// мобильную раскладку сообщений — см. @container (max-width: 650px) там же.
const SIDEBAR_MAX_WIDTH_RATIO = 0.7;
const SIDEBAR_MAIN_RESERVED = 280; // минимум места, которое всегда остаётся под переписку

const sidebarResizer = document.getElementById("sidebar-resizer");
let sidebarDrag = null;


function getSidebarMaxWidth() {
    return Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(window.innerWidth * SIDEBAR_MAX_WIDTH_RATIO, window.innerWidth - SIDEBAR_MAIN_RESERVED)
    );
}


function clampSidebarWidth(width) {
    return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(width, getSidebarMaxWidth())));
}


function setSidebarWidth(width, options = {}) {

    const clamped = clampSidebarWidth(width);

    document.documentElement.style.setProperty("--sidebar-w", `${clamped}px`);
    sidebarResizer.setAttribute("aria-valuenow", String(clamped));
    sidebarResizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
    sidebarResizer.setAttribute("aria-valuemax", String(Math.round(getSidebarMaxWidth())));

    if (options.persist) {
        try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
        } catch (error) {
            console.warn("Не удалось сохранить ширину списка чатов", error);
        }
    }

    return clamped;

}


function initializeSidebarWidth() {

    let savedWidth = null;

    try {
        savedWidth = parseFloat(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    } catch (error) {
        console.warn("Не удалось загрузить ширину списка чатов", error);
    }

    setSidebarWidth(Number.isFinite(savedWidth) ? savedWidth : SIDEBAR_DEFAULT_WIDTH);

}


sidebarResizer.addEventListener("pointerdown", (event) => {

    if (event.pointerType === "mouse" && event.button !== 0) return;

    sidebarDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: document.querySelector(".sidebar").getBoundingClientRect().width
    };

    sidebarResizer.setPointerCapture(event.pointerId);
    sidebarResizer.classList.add("dragging");
    document.querySelector(".app").classList.add("sidebar-dragging");
    event.preventDefault();

});

sidebarResizer.addEventListener("pointermove", (event) => {

    if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;

    // pointermove на тачпаде/мыши с высокой частотой опроса приходит чаще,
    // чем раз в кадр — каждое событие синхронно писало CSS-переменную ширины
    // (пересчёт стилей всего приложения). Запоминаем последнюю позицию и
    // применяем один раз на кадр.
    const delta = event.clientX - sidebarDrag.startX;
    sidebarPendingWidth = sidebarDrag.startWidth + delta;
    if (!sidebarDragFrame) {
        sidebarDragFrame = requestAnimationFrame(() => {
            sidebarDragFrame = 0;
            if (sidebarPendingWidth != null) setSidebarWidth(sidebarPendingWidth);
        });
    }

});

let sidebarDragFrame = 0;
let sidebarPendingWidth = null;

function finishSidebarDrag(event) {

    if (!sidebarDrag || sidebarDrag.pointerId !== event.pointerId) return;

    if (sidebarDragFrame) {
        cancelAnimationFrame(sidebarDragFrame);
        sidebarDragFrame = 0;
    }
    if (sidebarPendingWidth != null) setSidebarWidth(sidebarPendingWidth);
    sidebarPendingWidth = null;

    sidebarDrag = null;
    sidebarResizer.classList.remove("dragging");
    document.querySelector(".app").classList.remove("sidebar-dragging");

    const finalWidth = document.querySelector(".sidebar").getBoundingClientRect().width;
    setSidebarWidth(finalWidth, { persist: true });

}

sidebarResizer.addEventListener("pointerup", finishSidebarDrag);
sidebarResizer.addEventListener("pointercancel", finishSidebarDrag);

sidebarResizer.addEventListener("dblclick", () => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH, { persist: true });
    toast("Ширина списка чатов сброшена");
});

sidebarResizer.addEventListener("keydown", (event) => {

    const currentWidth = document.querySelector(".sidebar").getBoundingClientRect().width;

    if (event.key === "ArrowLeft") {
        event.preventDefault();
        setSidebarWidth(currentWidth - 16, { persist: true });
    } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setSidebarWidth(currentWidth + 16, { persist: true });
    } else if (event.key === "Home") {
        event.preventDefault();
        setSidebarWidth(SIDEBAR_MIN_WIDTH, { persist: true });
    } else if (event.key === "End") {
        event.preventDefault();
        setSidebarWidth(window.innerWidth, { persist: true });
    }

});

// resize летит десятками событий в секунду при перетаскивании границы
// окна; в каждом — принудительный reflow (getBoundingClientRect после
// записи стилей в positionReactionPicker + ещё одно чтение ширины сайдбара).
// Склеиваем в один проход на кадр.
let resizeFrame = 0;
window.addEventListener("resize", () => {

    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {

        resizeFrame = 0;

        document.querySelectorAll(".reaction-picker.open").forEach((picker) => {
            const button = picker.closest(".message-tools")?.querySelector(".reaction-more");
            if (button) {
                positionReactionPicker(picker, button);
            }
        });

        const currentSidebarWidth = document.querySelector(".sidebar").getBoundingClientRect().width;
        setSidebarWidth(currentSidebarWidth);

    });

});

initializeSidebarWidth();
initializeSettings();
filterSharedItems();
updateContactModalStats();
updateMessageGrouping();
updateScrollToBottomButton();


/* ВХОД / РЕГИСТРАЦИЯ: включается только когда в supabaseClient.js вписаны
   настоящие ключи (IS_SUPABASE_CONFIGURED === true). Пока их нет — весь
   этот блок ничего не делает, приложение остаётся демо-версией как раньше. */

let authMode = "signin";

// mode: "signin" | "signup" | "reset" (запросить письмо) | "recovery"
// (уже перешли по ссылке из письма, задаём новый пароль — см. initAuthGate
// → PASSWORD_RECOVERY). Вкладки Вход/Регистрация скрываются в reset/recovery,
// потому что это отдельный, однонаправленный шаг, а не выбор между двумя.
function setAuthMode(mode) {

    authMode = mode;

    document.querySelectorAll(".auth-tab").forEach((tab) => {
        const active = tab.dataset.authMode === mode;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
    });

    document.getElementById("auth-tabs").hidden = mode === "reset" || mode === "recovery";
    document.querySelector('[data-auth-field="username"]').hidden = mode !== "signup";
    document.querySelector('[data-auth-field="displayName"]').hidden = mode !== "signup";
    document.querySelector('[data-auth-field="email"]').hidden = mode === "recovery";
    document.querySelector('[data-auth-field="password"]').hidden = mode === "reset" || mode === "recovery";
    document.querySelector('[data-auth-field="newPassword"]').hidden = mode !== "recovery";
    document.querySelector('[data-auth-field="forgotLink"]').hidden = mode !== "signin";
    document.querySelector('[data-auth-field="backToSignin"]').hidden = mode !== "reset";

    const labels = { signup: "Создать аккаунт", reset: "Отправить письмо", recovery: "Сохранить пароль" };
    document.getElementById("auth-submit").textContent = labels[mode] || "Войти";

    document.getElementById("auth-error").hidden = true;
    document.getElementById("auth-success").hidden = true;

}

function describeAuthError(error) {

    const message = error?.message || String(error);

    if (message.includes("Supabase не настроен") || message.includes("supabase-js")) return message;
    if (message.includes("Invalid login credentials")) return "Неверный email или пароль";
    if (message.includes("already registered") || message.includes("already exists")) return "Такой email уже зарегистрирован";
    if (message.includes("username_format")) return "Имя пользователя: только строчные латинские буквы, цифры и _, от 3 до 32 символов";
    if (message.includes("Password should be")) return "Пароль слишком короткий (минимум 6 символов)";
    if (message.includes("Database error saving new user")) {
        return "Не удалось создать профиль — скорее всего, такое имя пользователя уже занято (или не подходит по формату: строчные латинские буквы, цифры и _, от 3 до 32 символов). Попробуйте другое имя.";
    }

    return message;

}

// Пока человек печатает — сразу приводим к разрешённому формату (строчные
// латинские буквы, цифры, _), а не даём напечатать что угодно и упасть
// с ошибкой только на отправке формы.
function sanitizeUsernameInput(input) {
    const cursor = input.selectionStart ?? input.value.length;
    // Курсор сдвигаем только на число удалённых символов ДО него: прежний код
    // вычитал все удалённые в строке целиком, и при вставке "abc!!!def" с
    // курсором после "abc" курсор уезжал левее, чем нужно.
    const lowerBeforeCursor = input.value.slice(0, cursor).toLocaleLowerCase().replace(/[^a-z0-9_]/g, "");
    input.value = input.value.toLocaleLowerCase().replace(/[^a-z0-9_]/g, "");
    const newCursor = Math.min(lowerBeforeCursor.length, input.value.length);
    input.setSelectionRange(newCursor, newCursor);
}

async function handleAuthSubmit(event) {

    event.preventDefault();

    const submitButton = document.getElementById("auth-submit");
    const errorBox = document.getElementById("auth-error");
    const successBox = document.getElementById("auth-success");
    errorBox.hidden = true;
    successBox.hidden = true;

    const email = document.getElementById("auth-email").value.trim();
    const password = document.getElementById("auth-password").value;

    submitButton.disabled = true;
    const originalLabel = submitButton.textContent;
    submitButton.textContent = "Подождите…";

    try {

        if (typeof KabanAuth === "undefined") {
            throw new Error("Supabase не настроен: впишите ключи в supabaseClient.js");
        }

        // Форма теперь с novalidate (см. index.html) — браузерная проверка
        // type="email"/required на мобильных иногда молча блокирует отправку
        // без заметной подсказки, человек просто не понимает, что произошло.
        // Проверяем явно сами, чтобы ошибка была видна гарантированно, на
        // любом устройстве и браузере — во всех режимах, где email вообще есть.
        if (authMode !== "recovery") {
            if (!email) throw new Error("Введите email");
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                throw new Error("Введите настоящий email (например, you@mail.com)");
            }
        }

        if (authMode === "reset") {

            await KabanAuth.resetPasswordForEmail(email);
            successBox.textContent = "Письмо со ссылкой для сброса пароля отправлено — проверьте почту";
            successBox.hidden = false;
            return;

        }

        if (authMode === "recovery") {

            const newPassword = document.getElementById("auth-new-password").value;
            if (!newPassword || newPassword.length < 6) throw new Error("Пароль слишком короткий (минимум 6 символов)");
            await KabanAuth.updatePassword(newPassword);
            const user = await KabanAuth.getCurrentUser();
            await onAuthSuccess(user);
            return;

        }

        if (!password) throw new Error("Введите пароль");
        if (authMode === "signup" && password.length < 6) {
            throw new Error("Пароль слишком короткий (минимум 6 символов)");
        }

        let user;

        if (authMode === "signup") {
            const username = document.getElementById("auth-username").value.trim();
            const displayName = document.getElementById("auth-display-name").value.trim() || username;
            if (!username) throw new Error("Придумайте имя пользователя");
            if (!/^[a-z0-9_]{3,32}$/.test(username)) {
                throw new Error("Имя пользователя: только строчные латинские буквы, цифры и _, от 3 до 32 символов");
            }
            user = await KabanAuth.signUp(email, password, username, displayName);
        } else {
            user = await KabanAuth.signIn(email, password);
        }

        await onAuthSuccess(user);

    } catch (error) {

        errorBox.textContent = describeAuthError(error);
        errorBox.hidden = false;

    } finally {

        submitButton.disabled = false;
        submitButton.textContent = originalLabel;

    }

}

async function onAuthSuccess(user) {

    closeAuthScreen();
    syncAccountSection();
    await applyRealSessionState(user);

    if (typeof KabanCrypto !== "undefined") {
        KabanCrypto.publishDeviceKey().catch((error) => {
            console.warn("Не удалось опубликовать публичный ключ устройства", error);
        });
    }

}

// Прячет демо-контакт и показывает пустой список чатов —
// у только что вошедшего реального аккаунта ещё нет ни одной переписки,
// показывать вместо этого выдуманного собеседника было бы обманом. Как
// только появится реальная загрузка чатов из базы, этот пустой экран
// станет отправной точкой, а не заглушкой.
async function applyRealSessionState(user) {

    document.getElementById("demo-chat-section").hidden = true;
    document.body.classList.remove("chat-selected");
    currentChatId = null;

    if (!user) return;

    myRealUserId = user.id; // нужно уже здесь, до открытия чата — см. buildChatListItemHTML ("Вы: …")
    updateCallHistoryBadge();

    // Пароли ретранслятора для звонков — заранее, чтобы звонок не ждал (и обновлять раз в час).
    if (typeof ensureTurnServers === "function") {
        ensureTurnServers();
        if (!window.__turnRefreshTimer) window.__turnRefreshTimer = setInterval(() => ensureTurnServers(), 3600 * 1000);
    }

    // Список чатов из снимка — сразу, до любых запросов к серверу.
    if (typeof restoreChatListSnapshot === "function") restoreChatListSnapshot();

    // Профиль грузится ПАРАЛЛЕЛЬНО со списком чатов (раньше вход ждал его отдельным
    // сетевым кругом, и только потом начиналась загрузка чатов).
    const profileReady = KabanAPI.getMyProfile()
        .then((profile) => {
            cachedMyProfile = profile;
            renderProfileName(cachedMyProfile.display_name, cachedMyProfile.status_emoji);
            fillProfileForm(cachedMyProfile);
        })
        .catch((error) => console.warn("Не удалось загрузить профиль", error))
        .finally(syncAccountSection);

    // Подписки на realtime/звонки/файлы/присутствие запускаем ДО (и независимо
    // от) загрузки списка чатов: loadChatList() может упасть из-за секундного
    // сбоя сети сразу после успешного входа — тогда исключение пролетало через
    // onAuthSuccess в handleAuthSubmit и показывалось как "не удалось войти",
    // а все start*() ниже вообще не выполнялись: человек оставался внутри без
    // входящих звонков, файлов и живых обновлений, пока не перезагрузит страницу.
    startPresenceHeartbeat();
    requestNotificationPermission();
    startInboxSubscription(user.id);
    startCallInbox(user.id);
    startFileInbox(user.id);
    startScreenInbox(user.id);
    startGroupCallInbox(user.id);
    if (typeof startStories === "function") startStories();
    if (typeof startReminders === "function") startReminders();

    try {
        await loadChatList();
        await ensureSavedMessagesChatExists();
    } catch (error) {
        console.warn("Не удалось загрузить список чатов при входе", error);
        toast("Не удалось загрузить чаты — потяните список вниз или обновите страницу");
    }
    await profileReady;

    // Открытие приложения по клику на push-уведомление в НОВОЙ вкладке
    // (когда ни одной открытой не было — см. notificationclick в sw.js,
    // clients.openWindow(...#chat=ID)), а не через postMessage в уже
    // открытую (тот путь — see the "message" listener рядом с
    // requestNotificationPermission).
    const chatHashMatch = window.location.hash.match(/^#chat=(.+)$/);
    if (chatHashMatch) {
        openRealChat(chatHashMatch[1]);
        history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    handleJoinInviteHash();

}

// Сообщения в чате, который СЕЙЧАС открыт, уже обрабатывает
// subscribeToChat внутри openRealChat (рисует строку и т.п.) — этот канал
// только про то, что происходит в ДРУГИХ чатах: обновить их превью в
// списке и, если вкладка не в фокусе, показать уведомление.
function startInboxSubscription(myUserId) {

    if (inboxUnsubscribe) return;

    inboxUnsubscribe = KabanAPI.subscribeToInbox({
        onMessage: async (message) => {

            if (message.chat_id === currentChatId) return; // тут уже отрисовало subscribeToChat
            // Кэш истории закрытого чата — чтобы при открытии новое уже было на месте.
            if (typeof appendToChatCache === "function") appendToChatCache(message);
            if (message.sender_id === myUserId) {
                // Своё сообщение с другого устройства — только обновить превью в списке.
                if (message.type !== "system") patchCachedChatLastMessage(message.chat_id, message);
                return;
            }

            // Частый случай — чат уже есть в кэше, просто дописываем новое
            // последнее сообщение на месте. Полный loadChatList() нужен только
            // если это СОВСЕМ новый для меня чат (например, меня только что
            // добавили в группу и сразу же написали) — тогда в кэше его ещё
            // нет и взять неоткуда. Раньше здесь ВСЕГДА был полный поход на
            // сервер на каждое входящее сообщение в любом чате — ощутимый
            // источник лагов при активной переписке в нескольких чатах сразу.
            const knownRow = cachedChatRows.find((row) => row.chat_id === message.chat_id);
            if (knownRow) {
                // Имя автора для превью группы «Аня: …» — раньше оставалось от ПРЕДЫДУЩЕГО
                // сообщения (и в уведомлении подписывался не тот человек).
                const senderName = knownRow.chats?.type === "group" ? await resolveUserDisplayName(message.chat_id, message.sender_id) : undefined;
                // Счётчик непрочитанных растёт сразу, без полной перезагрузки списка.
                if (message.type !== "system") knownRow.unreadCount = (knownRow.unreadCount || 0) + 1;
                patchCachedChatLastMessage(message.chat_id, message, senderName);
            } else {
                await loadChatList();
            }

            const meta = cachedChatRows.find((row) => row.chat_id === message.chat_id);
            const isGroup = meta?.chats?.type === "group";
            const isSecret = !!meta?.chats?.is_secret;
            if (message.type === "system") return; // служебные — без уведомлений и звука
            // Для секретного чата message.text здесь — сырой шифротекст (эта
            // подписка не открывает конкретный чат и не расшифровывает его,
            // см. buildChatListItemHTML про то же самое для превью в списке) —
            // показываем только факт нового сообщения, без содержимого.
            const text = isSecret ? "🔒 Новое сообщение" : messagePreviewText(message);

            notifyIncomingMessage({
                chatId: message.chat_id,
                senderName: isGroup ? (meta?.chats?.title || "Группа") : (meta?.otherUser?.display_name || "Новое сообщение"),
                text: isGroup && !isSecret && meta?.lastMessageSenderName ? `${meta.lastMessageSenderName}: ${text}` : text,
                avatarUrl: isGroup ? meta?.chats?.avatar_url : meta?.otherUser?.avatar_url
            });

            if (appSettings.receiveSound && isChatSoundEnabled(message.chat_id)) playReceiveSound();

        }
    });

}

// Имя участника по id: из уже загруженных составов групп, иначе одним запросом (с кэшем).
const userDisplayNameCache = new Map();

async function resolveUserDisplayName(chatId, userId) {
    if (!userId) return null;
    const fromGroup = (groupMembersCache.get(chatId) || []).find((m) => m.user_id === userId)?.users?.display_name;
    if (fromGroup) return fromGroup;
    if (userDisplayNameCache.has(userId)) return userDisplayNameCache.get(userId);
    try {
        const { data } = await getSupabaseClient().from("users").select("display_name").eq("id", userId).maybeSingle();
        const name = data?.display_name || null;
        userDisplayNameCache.set(userId, name);
        return name;
    } catch {
        return null;
    }
}

function stopInboxSubscription() {
    if (inboxUnsubscribe) {
        inboxUnsubscribe();
        inboxUnsubscribe = null;
    }
}


/* @-ПОДСКАЗКА УЧАСТНИКОВ В ГРУППЕ: набираешь "@" (+ начало имени/логина) —
   над полем ввода список участников; ↑/↓ + Enter/Tab или клик вставляют
   "@логин ". Подсветку готовых упоминаний в сообщениях делает
   renderFormattedText. Только для групп и только для участников с логином. */
(function initMentionAutocomplete() {

    const input = document.getElementById("input");
    const box = document.getElementById("composer-input-box");
    if (!input || !box) return;

    const popover = document.createElement("div");
    popover.className = "mention-popover";
    popover.hidden = true;
    popover.setAttribute("role", "listbox");
    box.appendChild(popover);

    let items = [];
    let activeIndex = 0;
    let tokenStart = -1;

    function close() {
        popover.hidden = true;
        items = [];
        tokenStart = -1;
    }

    // Текущее "@слово" под куркором: возвращает {start, query} или null.
    function currentToken() {
        const caret = input.selectionStart;
        const before = input.value.slice(0, caret);
        const match = before.match(/(^|[\s(])@([A-Za-z0-9_]{0,32})$/);
        if (!match) return null;
        return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
    }

    function render() {
        popover.innerHTML = items.map((member, index) => `
            <button type="button" class="mention-item${index === activeIndex ? " active" : ""}" role="option" data-index="${index}">
                <span class="mention-name">${escapeHTML(member.display_name || member.username)}</span>
                <span class="mention-username">@${escapeHTML(member.username)}</span>
            </button>`).join("");
        popover.hidden = !items.length;
    }

    function update() {
        if (currentChatType !== "group" || !currentChatMembersById.size) { close(); return; }
        const token = currentToken();
        if (!token) { close(); return; }

        items = [...currentChatMembersById.entries()]
            .filter(([userId, member]) => userId !== myRealUserId && member.username && !member.is_bot
                && (member.username.toLowerCase().startsWith(token.query)
                    || (member.display_name || "").toLowerCase().startsWith(token.query)))
            .map(([, member]) => member)
            .slice(0, 6);

        if (!items.length) { close(); return; }
        tokenStart = token.start;
        activeIndex = Math.min(activeIndex, items.length - 1);
        render();
    }

    function pick(index) {
        const member = items[index];
        if (!member || tokenStart < 0) return;
        const caret = input.selectionStart;
        const insertion = "@" + member.username + " ";
        input.value = input.value.slice(0, tokenStart) + insertion + input.value.slice(caret);
        const newCaret = tokenStart + insertion.length;
        input.setSelectionRange(newCaret, newCaret);
        close();
        input.focus();
        input.dispatchEvent(new Event("input", { bubbles: true })); // автовысота, счётчик и т.п.
    }

    input.addEventListener("input", () => { activeIndex = 0; update(); });
    input.addEventListener("click", update);
    input.addEventListener("blur", () => setTimeout(close, 120));

    // capture + stopImmediatePropagation: пока подсказка открыта, Enter выбирает
    // участника, а не отправляет сообщение.
    input.addEventListener("keydown", (event) => {
        if (popover.hidden || !items.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            event.stopImmediatePropagation();
            activeIndex = (activeIndex + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            render();
        } else if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            event.stopImmediatePropagation();
            pick(activeIndex);
        } else if (event.key === "Escape") {
            event.stopImmediatePropagation();
            close();
        }
    }, true);

    // mousedown, а не click: к моменту click поле уже потеряло бы фокус (blur).
    popover.addEventListener("mousedown", (event) => {
        const item = event.target.closest(".mention-item");
        if (!item) return;
        event.preventDefault();
        pick(Number(item.dataset.index));
    });

})();

// Колесо мыши над затемнённым фоном окна (а не над самим окном) тоже должно
// прокручивать окно — иначе при курсоре "в стороне" прокрутка молча не работала.
// Обработчик висит на самих фонах окон, а не на document: непассивный wheel на
// document заставлял браузер перед КАЖДЫМ шагом колеса во всём приложении (список
// чатов, переписка) ждать JavaScript — отсюда подтормаживание прокрутки.
function forwardBackdropWheel(event) {
    const backdrop = event.currentTarget;
    if (!backdrop.classList.contains("open") || event.target !== backdrop) return;
    const modal = backdrop.querySelector(".forward-modal");
    if (!modal) return;
    modal.scrollTop += event.deltaY;
    event.preventDefault();
}
document.querySelectorAll(".forward-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("wheel", forwardBackdropWheel, { passive: false });
});

/* ОКНО «ЕЩЁ» (полная карточка собеседника): позиция по центру при первом
   открытии и перетаскивание за цветную левую часть. Положение помним, пока
   страница открыта: закрыл, открыл снова — окно там, где его оставили. */
let infoWindowPos = null;
let infoWindowJustDragged = false;

function clampInfoWindowPos(x, y, win) {
    const margin = 60; // сколько окна минимум остаётся на экране
    const maxX = window.innerWidth - margin;
    const maxY = window.innerHeight - margin;
    return {
        x: Math.min(Math.max(x, margin - win.offsetWidth), maxX),
        y: Math.min(Math.max(y, 0), maxY)
    };
}

function positionInfoWindow(reset) {

    const win = document.getElementById("info-window");
    if (!win) return;

    // Узкий экран: окно на весь экран, перетаскивания нет.
    if (window.innerWidth <= 760) {
        win.style.left = "10px";
        win.style.top = "10px";
        return;
    }

    if (!infoWindowPos || reset) {
        infoWindowPos = {
            x: Math.round((window.innerWidth - win.offsetWidth) / 2),
            y: Math.round((window.innerHeight - win.offsetHeight) / 2)
        };
    }

    infoWindowPos = clampInfoWindowPos(infoWindowPos.x, infoWindowPos.y, win);
    win.style.left = infoWindowPos.x + "px";
    win.style.top = infoWindowPos.y + "px";

}

(function initInfoWindowDrag() {

    const handle = document.getElementById("info-window-handle");
    const win = document.getElementById("info-window");
    if (!handle || !win) return;

    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
        if (window.innerWidth <= 760) return;
        if (event.target.closest("button, a, input, textarea, select")) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: infoWindowPos ? infoWindowPos.x : win.offsetLeft,
            originY: infoWindowPos ? infoWindowPos.y : win.offsetTop,
            moved: false,
            frame: 0
        };
        handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event) => {
        if (!drag || drag.pointerId !== event.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (!drag.moved) {
            drag.moved = true;
            handle.classList.add("dragging");
            document.body.style.userSelect = "none";
        }
        infoWindowPos = clampInfoWindowPos(drag.originX + dx, drag.originY + dy, win);
        if (!drag.frame) {
            drag.frame = requestAnimationFrame(() => {
                drag.frame = 0;
                win.style.left = infoWindowPos.x + "px";
                win.style.top = infoWindowPos.y + "px";
            });
        }
    });

    function endDrag(event) {
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.moved) {
            infoWindowJustDragged = true; // сбросится при следующем нажатии на фон (см. ниже)
        }
        handle.classList.remove("dragging");
        document.body.style.userSelect = "";
        drag = null;
    }

    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);

    document.getElementById("info-modal-backdrop").addEventListener("pointerdown", () => { infoWindowJustDragged = false; }, true);

    // Двойной клик по шапке возвращает окно в центр.
    handle.addEventListener("dblclick", (event) => {
        if (event.target.closest("button, a, input, textarea, select")) return;
        positionInfoWindow(true);
    });

    window.addEventListener("resize", () => {
        if (document.getElementById("info-modal-backdrop")?.classList.contains("open")) positionInfoWindow();
    });

})();

// Лента сообщений и панель эмодзи: подключаем анимации к уже и вновь добавленным эмодзи.
observeAnimEmojiIn(document.getElementById("messages"));
observeAnimEmojiIn(document.getElementById("emoji-popover"));

/* ============================================================================
   ПАПКИ ЧАТОВ: при узкой панели не все вкладки помещаются. Как в Telegram
   Desktop — колесо мыши листает их вбок, можно тянуть мышью, по краям мягкое
   затухание («там ещё есть»), выбранная вкладка сама въезжает в видимую часть.
   ========================================================================= */
(function initChatFoldersScroller() {
    const bar = document.getElementById("chat-folders");
    if (!bar) return;

    const syncEdges = () => {
        const max = bar.scrollWidth - bar.clientWidth;
        bar.classList.toggle("fade-left", bar.scrollLeft > 4);
        bar.classList.toggle("fade-right", max - bar.scrollLeft > 4);
    };

    bar.addEventListener("wheel", (event) => {
        if (bar.scrollWidth <= bar.clientWidth) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (!delta) return;
        // Дошли до края — отдаём колесо дальше (прокрутка самой боковой панели).
        const max = bar.scrollWidth - bar.clientWidth;
        if ((delta < 0 && bar.scrollLeft <= 0) || (delta > 0 && bar.scrollLeft >= max - 1)) return;
        event.preventDefault();
        bar.scrollBy({ left: delta, behavior: Math.abs(delta) > 40 ? "smooth" : "auto" });
    }, { passive: false });

    // Перетаскивание мышью (на сенсоре прокрутка и так работает пальцем).
    let drag = null;
    bar.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "mouse" || event.button !== 0 || bar.scrollWidth <= bar.clientWidth) return;
        drag = { x: event.clientX, left: bar.scrollLeft, moved: false, id: event.pointerId };
    });
    bar.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.x;
        if (!drag.moved && Math.abs(dx) < 5) return;
        if (!drag.moved) { drag.moved = true; bar.setPointerCapture(event.pointerId); bar.classList.add("dragging"); }
        bar.scrollLeft = drag.left - dx;
    });
    const endDrag = () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        bar.classList.remove("dragging");
        // Отпустили после перетаскивания — это не клик по вкладке. Если клика так и
        // не последовало (отпустили за пределами полосы), перехватчик снимаем сразу,
        // иначе он «съел» бы следующий настоящий клик.
        if (moved) {
            const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
            bar.addEventListener("click", swallow, { capture: true, once: true });
            setTimeout(() => bar.removeEventListener("click", swallow, { capture: true }), 0);
        }
    };
    bar.addEventListener("pointerup", endDrag);
    bar.addEventListener("pointercancel", endDrag);

    bar.addEventListener("scroll", syncEdges, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(syncEdges).observe(bar);
    // Список вкладок перерисовывается при каждом новом сообщении — выбранную вкладку
    // подкручиваем в видимую часть ТОЛЬКО когда сменилась сама папка, иначе полоса
    // дёргалась бы назад, пока человек листает её.
    let lastActiveFolder = null;
    new MutationObserver(() => {
        syncEdges();
        const active = bar.querySelector(".chat-folder-tab.active");
        const key = active ? (active.dataset.folder || active.dataset.folderId || active.textContent) : null;
        if (!active || drag || key === lastActiveFolder) return;
        lastActiveFolder = key;
        const left = active.getBoundingClientRect().left - bar.getBoundingClientRect().left + bar.scrollLeft;
        const right = left + active.offsetWidth;
        if (left < bar.scrollLeft + 28) bar.scrollTo({ left: Math.max(0, left - 28), behavior: "smooth" });
        else if (right > bar.scrollLeft + bar.clientWidth - 28) bar.scrollTo({ left: right - bar.clientWidth + 28, behavior: "smooth" });
    }).observe(bar, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "hidden"] });
    syncEdges();
})();