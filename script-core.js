/* ============================================================================
   Этот файл — одна из частей script.js, разбитого на несколько файлов для
   удобства навигации (раньше был единый файл ~350КБ/8300+ строк). Порядок
   подключения в index.html ВАЖЕН и должен точно совпадать с исходным
   порядком кода — файлы выполняются последовательно, как один конкатенированный
   скрипт, функции между ними не изолированы (нет import/export, всё в общей
   глобальной области видимости, как и раньше).
   ============================================================================ */
/* ВЫСОТА ПРИЛОЖЕНИЯ НА iOS SAFARI: при открытии клавиатуры Safari меняет
   видимую (visual) область экрана, но не всегда честно пересчитывает под
   неё 100dvh, и вдобавок сам пытается проскроллить ВСЮ страницу, чтобы
   показать сфокусированное поле — в сумме это выглядит как "панель ввода
   зависла посреди пустого экрана". Держим реальную высоту в --app-height
   через window.visualViewport (там, где он есть) и гасим попытки Safari
   сдвинуть документ скроллом — наш интерфейс сам вписывается в размер. */

function setAppHeight() {
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", `${height}px`);
    // html/body зафиксированы (position:fixed), скроллить их не должно быть
    // возможности в принципе, но подстраховываемся на случай, если Safari
    // всё-таки сдвинет документ при фокусе на поле ввода.
    window.scrollTo(0, 0);
}

// Глобальные переменные состояния, используемые в UI-скриптах и в логике
// реальных чатов. Их нужно объявить до инициализации настроек и до вызова
// script-ui.js, иначе при порядке подключения script-core.js → script-ui.js →
// script-chats.js будут выбрасываться ReferenceError из-за TDZ/порядка загрузки.
// Безопасное CSS-значение url("…") для вставки в HTML-атрибут style="…" —
// результат нужно дополнительно пропустить через escapeHTML. Ссылка на аватар
// приходит из профиля ДРУГОГО пользователя (колонка users.avatar_url он
// редактирует сам), а раньше подставлялась в style без кавычек: значение вида
//   x);background:url(//чужой-сайт/трекер.gif
// дописывало собственные CSS-декларации. Здесь допускаются только http(s)/
// blob/data:image, а символы, которыми можно выйти из url("…"), кодируются.
function cssUrlValue(rawUrl) {
    const url = String(rawUrl ?? "");
    if (!/^(https?:|blob:|data:image\/)/i.test(url)) return "none";
    return `url("${url.replace(/["'\\()\s]/g, (ch) => encodeURIComponent(ch))}")`;
}

// Аватар без фото — как в Telegram: градиентный круг с инициалами, у каждого
// человека/группы СВОЙ постоянный цвет (по id). Раньше был бежевый квадрат с 👤.
const AVATAR_GRADIENTS = [
    ["#ff885e", "#ff516a"], ["#ffcd6a", "#ffa85c"], ["#82b1ff", "#665fff"], ["#a0de7e", "#54cb68"],
    ["#53edd6", "#28c9b7"], ["#72d5fd", "#2a9ef1"], ["#e0a2f3", "#d669ed"], ["#f9a8c9", "#ef5d8e"]
];

function avatarInitials(name) {
    const words = String(name || "").replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    const first = [...words[0]][0] || "";
    const second = words.length > 1 ? [...words[1]][0] || "" : "";
    return (first + second).toUpperCase();
}

// kind: "user" | "group" | "saved" | "bot". Возвращает { style, inner, cls } для вставки в HTML.
function avatarParts({ id, name, url, kind = "user" }) {
    if (url) return { cls: " has-photo", inner: "", style: ` style="background-image:${escapeHTML(cssUrlValue(url))};background-size:cover;background-position:center"` };
    let hash = 0;
    // По имени (а не id) — чтобы цвет совпадал в списке, шапке чата и карточке, где id не всегда под рукой.
    for (const ch of String(name || id || "")) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const [a, b] = kind === "saved" ? ["#6ec6ff", "#3a8dff"] : kind === "bot" ? ["#a78bfa", "#6c4fd6"] : AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
    const style = ` style="background:linear-gradient(160deg,${a},${b});color:#fff"`;
    const icons = {
        saved: '<svg class="avatar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z"/></svg>',
        bot: '<svg class="avatar-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="8" width="15" height="11" rx="4"/><path d="M12 4.5V8M9 13h.01M15 13h.01M9.5 16h5"/></svg>'
    };
    const inner = icons[kind] || `<span class="avatar-initials">${escapeHTML(avatarInitials(name))}</span>`;
    return { cls: " has-initials", inner, style };
}

let currentChatId = null;
let cachedChatRows = [];
let chatRealtimeUnsubscribe = null;
let chatPresenceHandle = null;
// Увеличивается на каждый вызов openRealChat — если он изменился к моменту,
// когда долгая цепочка await внутри openRealChat наконец резолвится, значит
// пользователь уже открыл другой чат, и эта продолжившаяся работа должна
// молча прерваться, а не затирать currentChatId/DOM/подписки от чата,
// который уже не открыт.
let chatOpenRequestToken = 0;
let currentOtherUserId = null;
let typingClearTimer = null;
let lastTypingSentAt = 0;
let inboxUnsubscribe = null;
let currentChatType = "direct";
let currentChatMembersById = new Map();
let currentChatTitle = "";
let currentChatIsSecret = false;

setAppHeight();

// resize/scroll у visualViewport летят очень часто (открытие/закрытие
// клавиатуры на iOS, инерционная прокрутка, перетаскивание границы окна) —
// каждый вызов setAppHeight пишет CSS-переменную (пересчёт стилей всего
// приложения) и дёргает scrollTo. Склеиваем всплеск событий в один вызов на
// кадр вместо десятков синхронных пересчётов подряд.
let appHeightFrame = 0;
function scheduleAppHeight() {
    if (appHeightFrame) return;
    appHeightFrame = requestAnimationFrame(() => {
        appHeightFrame = 0;
        setAppHeight();
    });
}

if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleAppHeight);
    window.visualViewport.addEventListener("scroll", scheduleAppHeight);
} else {
    window.addEventListener("resize", scheduleAppHeight);
}

// scrollTo(0,0) только если документ реально сместился — а не на каждое
// scroll-событие подряд (оно дублировало ту же работу, что уже делает
// setAppHeight выше).
window.addEventListener("scroll", () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
});


/* НАСТРОЙКИ ПРИЛОЖЕНИЯ (тема, размер текста, поведение сообщений) */

const SETTINGS_STORAGE_KEY = "kaban-chat-settings";
const DRAFT_STORAGE_KEY = "kaban-chat-draft";

// Черновик — отдельно на каждый чат (реальный ли, из Supabase, или демо-чат
// без бэкенда), а не один общий ключ на всё приложение.
function draftStorageKey(chatId) {
    return DRAFT_STORAGE_KEY + ":" + (chatId || "demo");
}

const appSettings = {
    darkMode: false,
    reduceMotion: false,
    enterToSend: true,
    sendSound: false,
    receiveSound: false,
    compactMessages: false,
    // Как в Telegram Desktop: свои и чужие сообщения одной колонкой слева, с аватарами.
    messagesLeft: false,
    // Яркость узора на фоне чата: 1 — тише, 2 — обычно, 3 — ярче.
    patternStrength: 2,
    showMessageTime: true,
    autoScroll: true,
    saveDraft: true,
    hideChatPreviews: false,
    largeEmoji: true,
    textSize: "md",
    accentColor: "default",
    // Подкраска фона акцентом: 0 — нет, 1 — лёгкая, 2 — средняя, 3 — яркая.
    tintLevel: 0,
    // Пузыри: форма (round|soft|sharp|pill), хвостик, заливка своих
    // (solid|gradient|soft), входящие (neutral|tint). Обои чатов по умолчанию.
    bubbleShape: "round",
    bubbleTail: true,
    bubbleFill: "solid",
    bubbleIn: "neutral",
    chatWallpaper: "default",
    animatedEmoji: true,
    messageEffects: true,
    autoEffects: true,
    liveWallpapers: true,
    linkPreviews: true
};

/* ============================================================================
   ТЕМА ОФОРМЛЕНИЯ: режим + акцентный цвет + подкраска фона + пузыри + обои.
   Все производные цвета считаются ЗДЕСЬ, под текущий режим (светлый/тёмный),
   и кладутся в CSS-переменные на <body>. Так акцент всегда читаем на
   поверхности (ссылки, иконки), текст на цветном пузыре — контрастен, а тёмные
   цвета не "тонут" в чёрном фоне: в тёмной теме их осветляет ensureContrast.
   Пока всё по умолчанию — переменные не выставляются и действует исходный CSS.
   ========================================================================= */

const DEFAULT_ACCENT_HEX = "#0a7cff";

// Старые пастельные темы (id) → цвет; при первом запуске переносятся в новый формат.
const LEGACY_ACCENTS = {
    lavender: "#7c6fd1", mint: "#3fae82", peach: "#e08a4f", sky: "#4a90c9", rose: "#d1608c",
    sage: "#6f9c5e", vanilla: "#b8912e", lilac: "#a25fc0", terracotta: "#c96d47"
};

// Насыщенные акценты: id = сам цвет "#rrggbb" (так же хранится и «свой цвет»).
const VIVID_COLORS = [
    { id: "#2f7df6", label: "Кобальт" },
    { id: "#0ea5e9", label: "Небесный" },
    { id: "#06b6d4", label: "Циан" },
    { id: "#14b8a6", label: "Бирюза" },
    { id: "#10b981", label: "Изумруд" },
    { id: "#22c55e", label: "Зелёный" },
    { id: "#84cc16", label: "Лайм" },
    { id: "#eab308", label: "Золото" },
    { id: "#f59e0b", label: "Янтарь" },
    { id: "#f97316", label: "Мандарин" },
    { id: "#ef4444", label: "Алый" },
    { id: "#e11d48", label: "Малина" },
    { id: "#be123c", label: "Гранат" },
    { id: "#ec4899", label: "Фуксия" },
    { id: "#d946ef", label: "Орхидея" },
    { id: "#a855f7", label: "Аметист" },
    { id: "#8b5cf6", label: "Фиолет" },
    { id: "#6366f1", label: "Индиго" },
    { id: "#1d4ed8", label: "Сапфир" },
    { id: "#0f766e", label: "Хвоя" },
    { id: "#65a30d", label: "Мох" },
    { id: "#b45309", label: "Медь" },
    { id: "#78350f", label: "Шоколад" },
    { id: "#64748b", label: "Сталь" }
];

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/* ---- цветовая математика ------------------------------------------------ */

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

function relativeLuminance(hex) {
    const channel = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const [r, g, b] = hexToRgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
    const l1 = relativeLuminance(a);
    const l2 = relativeLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function hexToHsl(hex) {
    let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return [h, s, l];
}

function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rgb;
    if (h < 60) rgb = [c, x, 0];
    else if (h < 120) rgb = [x, c, 0];
    else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c];
    else if (h < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

function shiftLightness(hex, delta) {
    const [h, s, l] = hexToHsl(hex);
    return hslToHex(h, s, Math.max(0, Math.min(1, l + delta)));
}

// share — доля цвета b в смеси (0 — чистый a, 1 — чистый b).
function mixHex(a, b, share) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return rgbToHex(A[0] + (B[0] - A[0]) * share, A[1] + (B[1] - A[1]) * share, A[2] + (B[2] - A[2]) * share);
}

// Сдвигает светлоту цвета, пока контраст с against не достигнет min
// (в тёмной теме — светлее, в светлой — темнее).
function ensureContrast(hex, against, min, dark) {
    let color = hex;
    for (let i = 0; i < 40 && contrastRatio(color, against) < min; i++) {
        color = shiftLightness(color, dark ? 0.025 : -0.025);
    }
    return color;
}

/* ---- расчёт набора переменных темы -------------------------------------- */

function computeThemeTokens(hex, dark, options) {

    const surface = dark ? "#171717" : "#ffffff";
    const bg = dark ? "#101010" : "#f5f5f3";
    const neutralIn = dark ? "#2c2c2e" : "#e9e9eb";

    // Акцент для текста/иконок/кнопок на поверхности.
    const ui = ensureContrast(hex, surface, 3.4, dark);
    const uiText = contrastRatio(ui, "#ffffff") >= 3.2 ? "#ffffff" : "#141414";

    // Основа цветного пузыря: в тёмной теме не должна сливаться с фоном чата,
    // а текст на ней — читаться (белый, либо тёмный на светлых цветах).
    let base = hex;
    if (dark) {
        for (let i = 0; i < 30 && contrastRatio(base, bg) < 2.1; i++) base = shiftLightness(base, 0.02);
    } else {
        // Почти белый/жёлтый пузырь иначе сливался бы со светлым фоном чата.
        for (let i = 0; i < 30 && contrastRatio(base, bg) < 1.3; i++) base = shiftLightness(base, -0.03);
    }
    let outText = "#ffffff";
    if (contrastRatio(base, "#ffffff") < 3.6) {
        if (contrastRatio(base, "#141414") >= 4.5) {
            outText = "#141414";
        } else {
            for (let i = 0; i < 40 && contrastRatio(base, "#ffffff") < 4; i++) base = shiftLightness(base, -0.02);
        }
    }

    let outBackground = base;
    let outSolid = base;

    if (options.bubbleFill === "gradient") {
        let light = shiftLightness(base, 0.07);
        if (outText === "#ffffff" && contrastRatio(light, "#ffffff") < 3.2) light = base;
        const [h, s, l] = hexToHsl(base);
        // С тёмным текстом оба конца градиента должны оставаться светлыми.
        let deep = hslToHex(h + 16, s, outText === "#ffffff" ? Math.max(0.12, l - 0.07) : l);
        if (outText !== "#ffffff" && contrastRatio(deep, outText) < 4) deep = base;
        outBackground = `linear-gradient(135deg, ${light}, ${deep})`;
        outSolid = deep;
    } else if (options.bubbleFill === "soft") {
        outSolid = mixHex(ui, surface, dark ? 0.7 : 0.8);
        outBackground = outSolid;
        outText = dark ? "#f4f4f4" : "#171717";
    }

    const bubbleIn = options.bubbleIn === "tint" ? mixHex(neutralIn, ui, dark ? 0.2 : 0.14) : neutralIn;

    // Подкраска фона: доля акцента в фоне приложения/сайдбаре.
    const shares = dark ? [0, 0.08, 0.14, 0.22] : [0, 0.06, 0.12, 0.2];
    const share = shares[Math.max(0, Math.min(3, options.tintLevel || 0))];
    const tintSource = dark ? ui : hex;

    return {
        "--accent": ui,
        "--accent-text": uiText,
        "--accent-wash": mixHex(ui, surface, dark ? 0.78 : 0.86),
        "--bubble-out": outBackground,
        "--bubble-out-solid": outSolid,
        "--bubble-out-text": outText,
        "--bubble-out-read": outText,
        "--bubble-in": bubbleIn,
        "--tint-main": mixHex(bg, tintSource, share),
        "--tint-side": mixHex(surface, tintSource, share * 0.6)
    };

}

const THEME_VAR_NAMES = [
    "--accent", "--accent-text", "--accent-wash", "--bubble-out", "--bubble-out-solid",
    "--bubble-out-text", "--bubble-out-read", "--bubble-in", "--tint-main", "--tint-side"
];

function saveSettings() {

    try {
        localStorage.setItem(
            SETTINGS_STORAGE_KEY,
            JSON.stringify(appSettings)
        );
    } catch (error) {
        console.warn("Не удалось сохранить настройки", error);
    }

}


function applyThemeTokens() {

    const body = document.body;
    const accentIsHex = HEX_COLOR_RE.test(appSettings.accentColor || "");
    const untouched = !accentIsHex
        && (appSettings.tintLevel || 0) === 0
        && appSettings.bubbleFill === "solid"
        && appSettings.bubbleIn === "neutral";

    body.dataset.accent = accentIsHex ? "custom" : "default";

    if (untouched) {
        THEME_VAR_NAMES.forEach((name) => body.style.removeProperty(name));
        body.removeAttribute("data-tint");
        return;
    }

    const hex = accentIsHex ? appSettings.accentColor.toLowerCase() : DEFAULT_ACCENT_HEX;
    const tokens = computeThemeTokens(hex, !!appSettings.darkMode, appSettings);
    // Без выбранного цвета акцент интерфейса остаётся штатным — подкрашиваем
    // только то, что просили (фон, заливку пузырей).
    if (!accentIsHex) {
        ["--accent", "--accent-text", "--accent-wash"].forEach((name) => delete tokens[name]);
        ["--accent", "--accent-text", "--accent-wash"].forEach((name) => body.style.removeProperty(name));
    }
    Object.entries(tokens).forEach(([name, value]) => body.style.setProperty(name, value));

    if ((appSettings.tintLevel || 0) > 0) body.setAttribute("data-tint", String(appSettings.tintLevel));
    else body.removeAttribute("data-tint");

}


function applySettings() {

    document.body.classList.toggle("dark", appSettings.darkMode);
    document.body.classList.toggle("reduce-motion", appSettings.reduceMotion);
    document.body.classList.toggle("compact-messages", appSettings.compactMessages);
    document.body.classList.toggle("messages-left", !!appSettings.messagesLeft);
    document.body.dataset.patternStrength = String(appSettings.patternStrength || 2);
    document.querySelectorAll("#pattern-strength-control .settings-segmented-item").forEach((b) => b.classList.toggle("active", Number(b.dataset.strength) === (appSettings.patternStrength || 2)));
    document.body.classList.toggle("hide-message-time", !appSettings.showMessageTime);
    document.body.classList.toggle("text-scale-sm", appSettings.textSize === "sm");
    document.body.classList.toggle("text-scale-lg", appSettings.textSize === "lg");
    document.body.classList.toggle("bubble-no-tail", !appSettings.bubbleTail);
    document.body.classList.toggle("no-live-wallpapers", appSettings.liveWallpapers === false);
    document.body.dataset.bubbleShape = appSettings.bubbleShape || "round";

    applyThemeTokens();

    document
        .querySelectorAll(".settings-dialog input[type='checkbox']")
        .forEach((checkbox) => {
            checkbox.checked = appSettings[checkbox.name];
        });

    document
        .querySelectorAll("#text-size-control .settings-segmented-item")
        .forEach((button) => {
            button.classList.toggle("active", button.dataset.textSize === appSettings.textSize);
        });

    syncThemeColorSelection();

    // Анимации эмодзи выключили — оживлённые экземпляры возвращаются к символам.
    if (typeof animatedEmojiEnabled === "function" && !animatedEmojiEnabled()) {
        document.querySelectorAll(".anim-emoji.anim-ready").forEach(destroyAnimEmoji);
    }

}


function setThemeColor(id) {
    appSettings.accentColor = id;
    applySettings();
    saveSettings();
}

function setDarkMode(dark) {
    appSettings.darkMode = !!dark;
    applySettings();
    saveSettings();
}

// Один обработчик для всех сегментных переключателей и тумблеров окна «Оформление».
function setThemeOption(key, value) {
    appSettings[key] = value;
    applySettings();
    saveSettings();
}

// «Тема из фото»: берём самый выразительный цвет снимка (по насыщенности и
// площади), делаем из него акцент и включаем подкраску фона — приложение
// становится «в тон» картинке.
function dominantColorFromImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const size = 56;
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, size, size);
                const { data } = ctx.getImageData(0, 0, size, size);

                const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] < 200) continue;
                    const hex = rgbToHex(data[i], data[i + 1], data[i + 2]);
                    const [h, s, l] = hexToHsl(hex);
                    if (s < 0.22 || l < 0.14 || l > 0.9) continue; // серые, почти чёрные и почти белые не годятся
                    const weight = s * (1 - Math.abs(2 * l - 1));
                    const bin = bins[Math.floor(h / 15) % 24];
                    bin.weight += weight;
                    bin.r += data[i] * weight;
                    bin.g += data[i + 1] * weight;
                    bin.b += data[i + 2] * weight;
                }

                const best = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
                if (best.weight <= 0) { reject(new Error("no color")); return; }

                const [h, s, l] = hexToHsl(rgbToHex(best.r / best.weight, best.g / best.weight, best.b / best.weight));
                // Делаем цвет «акцентным»: достаточно насыщенный и не слишком тёмный/светлый.
                resolve(hslToHex(h, Math.max(s, 0.6), Math.min(0.58, Math.max(0.42, l))));
            } catch (error) {
                reject(error);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("bad image")); };
        img.src = url;
    });
}

async function pickThemeFromPhoto(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
        const hex = await dominantColorFromImage(file);
        appSettings.accentColor = hex;
        if (!appSettings.tintLevel) appSettings.tintLevel = 2;
        applySettings();
        saveSettings();
        toast("Тема подобрана по фото");
    } catch {
        toast("Не удалось подобрать цвет по этому фото — попробуйте более яркое");
    }
}
function setPatternStrength(level) {
    appSettings.patternStrength = level;
    saveSettings();
    applySettings();
}

function setGlobalWallpaper(id) {
    appSettings.chatWallpaper = id;
    saveSettings();
    syncThemeColorSelection();
    if (typeof currentChatId !== "undefined" && currentChatId && typeof applyChatWallpaper === "function") {
        applyChatWallpaper(currentChatId);
    }
}

/* ---- обои чатов ----------------------------------------------------------
   css — готовое значение background для ленты сообщений. Всё на color-mix с
   var(--bg)/var(--text), поэтому одинаково пристойно в светлой и тёмной теме
   и не мешает читать пузыри. */
const WALLPAPERS = [
    { id: "default", label: "Без обоев", css: "" },
    { id: "aurora", label: "Аврора", css: "linear-gradient(155deg, color-mix(in srgb, #7c5cff 26%, var(--bg)), color-mix(in srgb, #22d3ee 22%, var(--bg)))" },
    { id: "sunset", label: "Закат", css: "linear-gradient(160deg, color-mix(in srgb, #ff7a59 26%, var(--bg)), color-mix(in srgb, #ff3d8b 24%, var(--bg)))" },
    { id: "ocean", label: "Океан", css: "linear-gradient(160deg, color-mix(in srgb, #0ea5e9 26%, var(--bg)), color-mix(in srgb, #1d4ed8 26%, var(--bg)))" },
    { id: "forest", label: "Лес", css: "linear-gradient(160deg, color-mix(in srgb, #22c55e 24%, var(--bg)), color-mix(in srgb, #0f766e 26%, var(--bg)))" },
    { id: "candy", label: "Конфета", css: "linear-gradient(160deg, color-mix(in srgb, #f472b6 26%, var(--bg)), color-mix(in srgb, #a78bfa 26%, var(--bg)))" },
    { id: "ember", label: "Янтарь", css: "linear-gradient(160deg, color-mix(in srgb, #f59e0b 26%, var(--bg)), color-mix(in srgb, #dc2626 22%, var(--bg)))" },
    { id: "night", label: "Ночь", css: "linear-gradient(160deg, color-mix(in srgb, #6366f1 24%, var(--bg)), color-mix(in srgb, #0f172a 60%, var(--bg)))" },
    { id: "accent", label: "Акцент", css: "linear-gradient(160deg, color-mix(in srgb, var(--accent) 26%, var(--bg)), color-mix(in srgb, var(--accent) 7%, var(--bg)))" },
    { id: "dots", label: "Точки", css: "radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--accent) 22%, transparent) 1.3px, transparent 1.8px) 0 0 / 20px 20px, var(--bg)" },
    { id: "grid", label: "Клетка", css: "linear-gradient(color-mix(in srgb, var(--text) 7%, transparent) 1px, transparent 1px) 0 0 / 24px 24px, linear-gradient(90deg, color-mix(in srgb, var(--text) 7%, transparent) 1px, transparent 1px) 0 0 / 24px 24px, var(--bg)" },
    { id: "stripes", label: "Диагональ", css: "repeating-linear-gradient(135deg, transparent 0 16px, color-mix(in srgb, var(--accent) 10%, transparent) 16px 32px), var(--bg)" },
    { id: "glow", label: "Свечение", css: "radial-gradient(circle at 20% 15%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 55%), radial-gradient(circle at 85% 85%, color-mix(in srgb, #ec4899 24%, transparent), transparent 55%), var(--bg)" },
    // Старые id из прежней версии — остаются рабочими у тех, кто их уже выбрал.
    { id: "lavender", label: "Лаванда", hidden: true, css: "color-mix(in srgb, #8e7cff 11%, var(--bg))" },
    { id: "sky", label: "Небо", hidden: true, css: "color-mix(in srgb, #4aa3e0 11%, var(--bg))" },
    { id: "mint", label: "Мята", hidden: true, css: "color-mix(in srgb, #3ec792 11%, var(--bg))" },
    { id: "peach", label: "Персик", hidden: true, css: "color-mix(in srgb, #f2a35f 11%, var(--bg))" },
    { id: "rose", label: "Роза", hidden: true, css: "color-mix(in srgb, #e07a9e 11%, var(--bg))" }
];

/* ---- узоры (как в Telegram): рисованные «каракули» поверх мягкого градиента.
   Узор — отдельный слой-маска (.chat-area::after), окрашенный цветом текста
   темы, поэтому одинаково аккуратен и в светлой, и в тёмной теме. */
const DOODLE = {
    heart: "<path d='M0 -3C-6 -10-14 -4-10 3L0 11L10 3C14 -4 6 -10 0 -3Z'/>",
    star: "<path d='M0 -9L2.6 -3L9 -2.8L4 1.4L5.6 8L0 4.4L-5.6 8L-4 1.4L-9 -2.8L-2.6 -3Z'/>",
    sparkle: "<path d='M0 -8Q1 -1 8 0Q1 1 0 8Q-1 1-8 0Q-1 -1 0 -8Z'/>",
    paw: "<g fill='black' stroke='none'><ellipse cx='0' cy='4' rx='6.5' ry='5.5'/><circle cx='-7.5' cy='-3.5' r='2.8'/><circle cx='-2.8' cy='-8.5' r='2.8'/><circle cx='2.8' cy='-8.5' r='2.8'/><circle cx='7.5' cy='-3.5' r='2.8'/></g>",
    fish: "<path d='M-11 0C-5 -7 5 -7 9 0C5 7-5 7-11 0ZM9 0L15 -6V6Z'/><circle cx='-5' cy='-1' r='1' fill='black'/>",
    yarn: "<circle r='8'/><path d='M-6 -5Q0 2 7 -3M-8 2Q0 7 6 5M-2 -8Q3 0-1 8'/><path d='M7 5Q12 9 15 6'/>",
    planet: "<circle r='7'/><path d='M-15 4Q0 -6 15 -4'/>",
    moon: "<path d='M3 -9A9.5 9.5 0 1 0 3 9A7 7 0 1 1 3 -9Z'/>",
    rocket: "<path d='M0 -12C5 -7 5 2 3 6H-3C-5 2-5 -7 0 -12Z'/><circle cy='-3' r='2'/><path d='M-3 2L-7 7V9L-3 6M3 2L7 7V9L3 6M-1.5 9V12M1.5 9V12'/>",
    gamepad: "<path d='M-12 -6H12A6 6 0 0 1 18 0V2A5 5 0 0 1 9 5L7 2H-7L-9 5A5 5 0 0 1-18 2V0A6 6 0 0 1-12 -6Z'/><path d='M-10 -2V4M-13 1H-7'/><circle cx='9' cy='-1' r='1.4' fill='black'/><circle cx='13' cy='2' r='1.4' fill='black'/>",
    dice: "<rect x='-9' y='-9' width='18' height='18' rx='4'/><g fill='black' stroke='none'><circle cx='-4' cy='-4' r='1.7'/><circle r='1.7'/><circle cx='4' cy='4' r='1.7'/></g>",
    coin: "<circle r='8.5'/><path d='M0 -4.5L1.5 -1.5L4.5 -1L2.3 1.2L2.8 4.5L0 3L-2.8 4.5L-2.3 1.2L-4.5 -1L-1.5 -1.5Z'/>",
    note: "<circle cx='-3' cy='7' r='3.4' fill='black'/><path d='M0.4 7V-9Q8 -6 6 2'/>",
    notes: "<circle cx='-7' cy='8' r='3.2' fill='black'/><circle cx='6' cy='5' r='3.2' fill='black'/><path d='M-4 8V-8L9 -11V5M-4 -4L9 -7'/>",
    headphones: "<path d='M-10 4V0A10 10 0 0 1 10 0V4'/><rect x='-12' y='2' width='5' height='9' rx='2'/><rect x='7' y='2' width='5' height='9' rx='2'/>",
    daisy: "<g><ellipse cy='-7' rx='3' ry='5'/><ellipse cy='-7' rx='3' ry='5' transform='rotate(60)'/><ellipse cy='-7' rx='3' ry='5' transform='rotate(120)'/><ellipse cy='-7' rx='3' ry='5' transform='rotate(180)'/><ellipse cy='-7' rx='3' ry='5' transform='rotate(240)'/><ellipse cy='-7' rx='3' ry='5' transform='rotate(300)'/></g><circle r='2.6' fill='black'/>",
    leaf: "<path d='M0 11C-8 3-6 -8 0 -12C6 -8 8 3 0 11ZM0 11V-6'/>",
    tulip: "<path d='M-6 -8L-3 -4L0 -9L3 -4L6 -8V-1A6 6 0 0 1-6 -1Z'/><path d='M0 5V13M0 9Q5 6 7 9'/>",
    donut: "<circle r='9'/><circle r='3.4'/><path d='M-5 -6L-4 -4.5M4 -6.5L5.5 -5.5M6 3L7.5 4M-6.5 4L-5 5.5'/>",
    icecream: "<path d='M-6 0L0 13L6 0'/><path d='M-7 0A7 7 0 1 1 7 0Z'/>",
    cherry: "<circle cx='-5' cy='7' r='4'/><circle cx='5' cy='8' r='4'/><path d='M-5 3Q-2 -7 4 -10M5 4Q3 -4 4 -10L9 -11'/>",
    pizza: "<path d='M-9 -7Q0 -11 9 -7L0 11Z'/><circle cx='-2' cy='-3' r='1.6' fill='black'/><circle cx='3' cy='1' r='1.6' fill='black'/>",
    triangle: "<path d='M0 -9L8 6H-8Z'/>",
    ring: "<circle r='7'/>",
    squiggle: "<path d='M-14 0Q-10.5 -6-7 0T0 0T7 0T14 0'/>",
    cross: "<path d='M-6 -6L6 6M6 -6L-6 6'/>"
};

const DOODLE_SPOTS = [
    [30, 30, -15, 1], [100, 22, 10, .8], [176, 38, 20, 1.1], [222, 108, -10, .9], [58, 96, 25, .9], [140, 92, -20, 1.15],
    [24, 166, 10, 1], [96, 158, -5, .8], [168, 170, 15, 1], [216, 214, -25, .85], [58, 220, 5, 1.1], [134, 226, -15, .9]
];

function doodlePattern(names) {
    const body = DOODLE_SPOTS.map(([x, y, r, s], i) => `<g transform='translate(${x} ${y}) rotate(${r}) scale(${s})'>${DOODLE[names[i % names.length]]}</g>`).join("");
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'>${body}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const PATTERN_WALLPAPERS = [
    { id: "pat-cats", label: "Котики", base: ["#ffb38a", "#ff8fab"], doodles: ["paw", "fish", "heart", "yarn", "paw", "sparkle"] },
    { id: "pat-space", label: "Космос", base: ["#8b8cff", "#4b3fa8"], doodles: ["star", "planet", "moon", "rocket", "sparkle", "star"] },
    { id: "pat-games", label: "Игры", base: ["#5ee6c3", "#3b9dff"], doodles: ["gamepad", "dice", "coin", "heart", "star", "cross"] },
    { id: "pat-music", label: "Музыка", base: ["#c3a6ff", "#7cc4ff"], doodles: ["note", "notes", "headphones", "sparkle", "note", "star"] },
    { id: "pat-love", label: "Сердечки", base: ["#ff9ac1", "#ff6b81"], doodles: ["heart", "sparkle", "heart", "star", "heart", "ring"] },
    { id: "pat-flowers", label: "Цветы", base: ["#b6e388", "#ffd56b"], doodles: ["daisy", "leaf", "tulip", "sparkle", "daisy", "leaf"] },
    { id: "pat-food", label: "Вкусняшки", base: ["#ffcf7a", "#ff8a8a"], doodles: ["donut", "icecream", "cherry", "pizza", "sparkle", "donut"] },
    { id: "pat-geo", label: "Геометрия", base: ["var(--accent)", "var(--accent)"], doodles: ["triangle", "ring", "squiggle", "cross", "triangle", "ring"] }
].map((p) => ({
    id: p.id,
    label: p.label,
    pattern: doodlePattern(p.doodles),
    css: `linear-gradient(155deg, color-mix(in srgb, ${p.base[0]} 30%, var(--bg)), color-mix(in srgb, ${p.base[1]} ${p.base[1].startsWith("var") ? 10 : 30}%, var(--bg)))`
}));
WALLPAPERS.splice(1, 0, ...PATTERN_WALLPAPERS);

function findWallpaper(id) {
    return WALLPAPERS.find((w) => w.id === id) || WALLPAPERS[0];
}

function wallpaperTileHTML(wallpaper, selected, onclick, label) {
    const style = wallpaper && wallpaper.css ? `background:${wallpaper.css}` : "";
    return `
        <button type="button" class="wp-tile${selected ? " selected" : ""}" onclick="${onclick}">
            <span class="wp-tile-preview${wallpaper && wallpaper.css ? "" : " plain"}" style="${style}">${wallpaper?.pattern ? `<span class="wp-tile-pattern" style="--wpp:${wallpaper.pattern.replace(/"/g, "&quot;")}"></span>` : ""}</span>
            <span class="wp-tile-label">${label}</span>
        </button>`;
}

function renderThemeColorGrid() {

    const vivid = document.getElementById("theme-vivid-grid");
    if (vivid) {
        vivid.innerHTML = VIVID_COLORS.map((c) => `
            <button type="button" class="theme-color-swatch-item" data-accent="${c.id}" onclick="setThemeColor('${c.id}')" title="${c.label}" aria-label="${c.label}">
                <span class="theme-color-swatch" style="background:${c.id}"></span>
            </button>
        `).join("");
    }

    const wallpapers = document.getElementById("theme-wallpaper-grid");
    if (wallpapers) {
        wallpapers.innerHTML = WALLPAPERS.filter((w) => !w.hidden)
            .map((w) => wallpaperTileHTML(w, false, `setGlobalWallpaper('${w.id}')`, w.label))
            .join("");
        wallpapers.querySelectorAll(".wp-tile").forEach((tile, index) => {
            tile.dataset.wallpaper = WALLPAPERS.filter((w) => !w.hidden)[index].id;
        });
    }

    syncThemeColorSelection();
}

function syncThemeColorSelection() {

    const accent = (appSettings.accentColor || "").toLowerCase();
    const isHex = HEX_COLOR_RE.test(accent);

    document.querySelectorAll("#theme-vivid-grid .theme-color-swatch-item").forEach((btn) => {
        btn.classList.toggle("selected", btn.dataset.accent === accent);
    });

    const vividMatch = isHex ? VIVID_COLORS.find((c) => c.id === accent) : null;
    const current = isHex
        ? { label: vividMatch ? vividMatch.label : "Свой цвет", swatch: accent }
        : { label: "Стандартный", swatch: DEFAULT_ACCENT_HEX };
    const rowIcon = document.getElementById("theme-color-row-icon");
    const rowLabel = document.getElementById("theme-color-row-label");
    if (rowIcon) rowIcon.style.background = current.swatch;
    if (rowLabel) rowLabel.textContent = current.label;

    document.getElementById("theme-mode-light")?.classList.toggle("active", !appSettings.darkMode);
    document.getElementById("theme-mode-dark")?.classList.toggle("active", !!appSettings.darkMode);

    const customInput = document.getElementById("theme-custom-input");
    if (customInput && isHex) customInput.value = accent;
    document.getElementById("theme-custom-row")?.classList.toggle("selected", isHex && !vividMatch);
    document.getElementById("theme-default-accent")?.classList.toggle("selected", !isHex);

    // Сегментные переключатели: кнопка активна, если её data-value совпадает с настройкой.
    document.querySelectorAll("[data-theme-key]").forEach((button) => {
        const value = button.dataset.themeValue;
        const current = appSettings[button.dataset.themeKey];
        button.classList.toggle("active", String(current) === value);
    });
    const tail = document.getElementById("theme-tail-input");
    if (tail) tail.checked = !!appSettings.bubbleTail;

    document.querySelectorAll("#theme-wallpaper-grid .wp-tile").forEach((tile) => {
        tile.classList.toggle("selected", tile.dataset.wallpaper === (appSettings.chatWallpaper || "default"));
    });

    const preview = document.getElementById("theme-preview");
    if (preview) preview.style.background = findWallpaper(appSettings.chatWallpaper).css;

}

function openThemeColorPicker() {
    syncThemeColorSelection();
    const backdrop = document.getElementById("theme-color-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeThemeColorPicker() {
    const backdrop = document.getElementById("theme-color-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}


function setTextSize(size) {

    appSettings.textSize = size;
    applySettings();
    saveSettings();

}


function initializeSettings() {

    try {
        const savedSettings = JSON.parse(
            localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}"
        );

        Object.keys(appSettings).forEach((name) => {
            if (typeof savedSettings[name] === "boolean") {
                appSettings[name] = savedSettings[name];
            }
        });

        if (typeof savedSettings.textSize === "string") {
            appSettings.textSize = savedSettings.textSize;
        }

        if (typeof savedSettings.accentColor === "string") {
            appSettings.accentColor = savedSettings.accentColor;
        }

        ["bubbleShape", "bubbleFill", "bubbleIn", "chatWallpaper"].forEach((name) => {
            if (typeof savedSettings[name] === "string") appSettings[name] = savedSettings[name];
        });
        if (Number.isInteger(savedSettings.tintLevel)) appSettings.tintLevel = savedSettings.tintLevel;

        // Прежние пастельные темы → цвет + средняя подкраска фона (как они и выглядели).
        if (LEGACY_ACCENTS[appSettings.accentColor]) {
            appSettings.accentColor = LEGACY_ACCENTS[appSettings.accentColor];
            if (!Number.isInteger(savedSettings.tintLevel)) appSettings.tintLevel = 2;
        }

        if (appSettings.saveDraft) {
            document.getElementById("input").value =
                localStorage.getItem(draftStorageKey(currentChatId)) || "";
        }
    } catch (error) {
        console.warn("Не удалось загрузить настройки", error);
    }

    renderThemeColorGrid();
    syncTurnSettingsHint();
    applySettings();
    resizeComposer();
    updateComposerAction();

}


/* КОД-ПАРОЛЬ ПРИЛОЖЕНИЯ: локальная блокировка (не настоящая серверная
   защита) — PIN хранится только как SHA-256-хэш в localStorage ЭТОГО
   браузера. Один и тот же экран/клавиатура используется для разблокировки
   при запуске, первичной настройки (ввод + повтор) и подтверждения перед
   отключением — режим переключается через appLockMode. */

const APP_LOCK_STORAGE_KEY = "kaban-app-lock-hash";
let appLockEnteredDigits = "";
let appLockMode = "unlock"; // unlock | setup-new | setup-confirm | disable-confirm
let appLockPendingFirstPin = null;

async function sha256Hex(text) {
    const data = new TextEncoder().encode("kaban-app-lock-salt:" + text);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hasAppLock() {
    return !!localStorage.getItem(APP_LOCK_STORAGE_KEY);
}

function updateAppLockSettingsRow() {
    const hint = document.getElementById("app-lock-settings-hint");
    if (hint) hint.textContent = hasAppLock() ? "Включён" : "Выключен";
}

// Вызывается один раз при загрузке страницы (см. DOMContentLoaded ниже) —
// если код-пароль когда-то был включён, экран блокировки встаёт поверх
// всего ДО того, как с приложением можно будет хоть как-то взаимодействовать.
function checkAppLockOnLoad() {
    if (!hasAppLock()) return;
    appLockMode = "unlock";
    appLockEnteredDigits = "";
    appLockPendingFirstPin = null;
    document.getElementById("app-lock-title").textContent = "KABAN заблокирован";
    document.getElementById("app-lock-error").hidden = true;
    document.getElementById("app-lock-cancel").hidden = true;
    renderAppLockDots();
    document.getElementById("app-lock-screen").classList.add("open");
}

// Из настроек — предлагает включить (если ещё выключен) либо, если уже
// включён, сперва просит ввести текущий код и только потом отключает.
function openAppLockSetup() {
    appLockEnteredDigits = "";
    appLockPendingFirstPin = null;
    document.getElementById("app-lock-error").hidden = true;
    document.getElementById("app-lock-cancel").hidden = false;

    if (hasAppLock()) {
        appLockMode = "disable-confirm";
        document.getElementById("app-lock-title").textContent = "Введите код, чтобы отключить";
    } else {
        appLockMode = "setup-new";
        document.getElementById("app-lock-title").textContent = "Придумайте код-пароль";
    }

    renderAppLockDots();
    document.getElementById("app-lock-screen").classList.add("open");
}

function cancelAppLockSetup() {
    // Кнопка "Отмена" скрыта в режиме unlock (appLockMode не меняем) —
    // туда эта функция попасть не должна, но на всякий случай не закрываем
    // экран, если код всё-таки уже требуется для входа.
    if (appLockMode === "unlock") return;
    document.getElementById("app-lock-screen").classList.remove("open");
}

function renderAppLockDots() {
    document.querySelectorAll("#app-lock-dots .app-lock-dot").forEach((dot, i) => {
        dot.classList.toggle("filled", i < appLockEnteredDigits.length);
    });
}

async function appLockPressDigit(digit) {
    if (appLockEnteredDigits.length >= 4) return;
    appLockEnteredDigits += digit;
    renderAppLockDots();
    document.getElementById("app-lock-error").hidden = true;
    if (appLockEnteredDigits.length === 4) {
        await appLockSubmitPin();
    }
}

function appLockBackspace() {
    appLockEnteredDigits = appLockEnteredDigits.slice(0, -1);
    renderAppLockDots();
}

function appLockShakeAndClear() {
    document.getElementById("app-lock-error").hidden = false;
    const dots = document.getElementById("app-lock-dots");
    dots.classList.remove("shake");
    void dots.offsetWidth; // перезапускает CSS-анимацию, если она уже проигрывалась
    dots.classList.add("shake");
    appLockEnteredDigits = "";
    setTimeout(renderAppLockDots, 120);
}

async function appLockSubmitPin() {

    const pin = appLockEnteredDigits;
    const savedHash = localStorage.getItem(APP_LOCK_STORAGE_KEY);

    if (appLockMode === "unlock" || appLockMode === "disable-confirm") {
        const hash = await sha256Hex(pin);
        if (hash !== savedHash) {
            appLockShakeAndClear();
            return;
        }
        if (appLockMode === "disable-confirm") {
            localStorage.removeItem(APP_LOCK_STORAGE_KEY);
            toast("Код-пароль отключён");
            updateAppLockSettingsRow();
        }
        document.getElementById("app-lock-screen").classList.remove("open");
        return;
    }

    if (appLockMode === "setup-new") {
        appLockPendingFirstPin = pin;
        appLockMode = "setup-confirm";
        appLockEnteredDigits = "";
        renderAppLockDots();
        document.getElementById("app-lock-title").textContent = "Повторите код-пароль";
        return;
    }

    if (appLockMode === "setup-confirm") {
        if (pin !== appLockPendingFirstPin) {
            toast("Коды не совпадают, попробуйте снова");
            appLockMode = "setup-new";
            appLockPendingFirstPin = null;
            appLockEnteredDigits = "";
            renderAppLockDots();
            document.getElementById("app-lock-title").textContent = "Придумайте код-пароль";
            return;
        }
        localStorage.setItem(APP_LOCK_STORAGE_KEY, await sha256Hex(pin));
        toast("Код-пароль включён");
        updateAppLockSettingsRow();
        document.getElementById("app-lock-screen").classList.remove("open");
    }

}

document.addEventListener("DOMContentLoaded", () => {
    checkAppLockOnLoad();
    updateAppLockSettingsRow();
});


/* ОКНО НАСТРОЕК */

function openSettings() {

    const backdrop =
        document.getElementById("settings-backdrop");

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("settings-close").focus();

}


function closeSettings() {

    const backdrop =
        document.getElementById("settings-backdrop");

    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.querySelector(".profile .icon-btn").focus();

}


function closeSettingsFromBackdrop(event) {

    if (event.target === event.currentTarget) {
        closeSettings();
    }

}


/* ============================================================================
   ЗВОНКИ: настоящий WebRTC (аудио/видео), сигнализация (обмен SDP/ICE) —
   через Supabase Realtime Broadcast (см. supabaseClient.js), сам голос и
   видео идут напрямую между браузерами через STUN, в базу вообще не
   попадают. Шифрование медиа — обязательная часть протокола WebRTC
   (DTLS-SRTP), отдельно делать ничего не нужно (в отличие от текста в
   секретных чатах — см. crypto.js, там шифрование пришлось строить самим).
   Только 1:1 — групповые звонки архитектурно другая задача (нужен SFU или
   mesh на N участников), сознательно не делаем.
   TURN-сервер не подключён (см. договорённость с пользователем) — в
   большинстве сетей STUN достаточно, но за особо "вредным" NAT соединение
   иногда не установится: это ограничение инфраструктуры, не баг кода.
   ========================================================================= */

// TURN (ретранслятор) — по желанию: без него звонки идут напрямую через STUN
// и могут не соединиться за строгим NAT/файрволом. Адрес и логин с паролем
// вписываются в Настройки → «Сервер для звонков (TURN)» и хранятся только на
// этом устройстве. iceServers — геттер: настройки подхватываются при создании
// каждого нового соединения, перезагрузка не нужна.
const TURN_STORAGE_KEY = "kaban-turn-server";

function loadTurnConfig() {
    try {
        const config = JSON.parse(localStorage.getItem(TURN_STORAGE_KEY) || "null");
        if (config && Array.isArray(config.urls) && config.urls.length) return config;
    } catch { /* повреждённое значение — как будто не задано */ }
    return null;
}

// Общий TURN «по умолчанию» для всех пользователей — чтобы звонки работали и на
// мобильных сетях без ручной настройки на каждом телефоне. Заполняется данными
// из личного кабинета Metered (Open Relay); пустой — используется только свой
// сервер из Настроек (если задан).
const DEFAULT_TURN = {
    // ExpressTURN, бесплатный тариф (1 ТБ/мес). Сменить — в кабинете expressturn.com.
    urls: ["turn:free.expressturn.com:3478", "turn:free.expressturn.com:3478?transport=tcp"],
    username: "000000002106652098",
    credential: "TfU59UoW0piOwwj4vaXNZIw3pBc="
};

// Ретранслятор Cloudflare: временные пароли выдаёт функция Supabase
// «turn-credentials» (ключ Cloudflare лежит только на сервере). Получаем при
// входе и перед каждым звонком; пароли живут сутки, обновляем заранее.
let managedIceServers = null;
let managedIceExpiresAt = 0;
let managedIcePromise = null;

// Включить, если будет развёрнута функция turn-credentials (Cloudflare); сейчас
// ретранслятор — ExpressTURN из DEFAULT_TURN, и лишний запрос не нужен.
const USE_MANAGED_TURN = false;

function ensureTurnServers(timeoutMs = 3000) {
    if (!USE_MANAGED_TURN) return Promise.resolve();
    if (managedIceServers && Date.now() < managedIceExpiresAt) return Promise.resolve();
    if (typeof getSupabaseClient !== "function" || typeof myRealUserId === "undefined" || !myRealUserId) return Promise.resolve();
    if (!managedIcePromise) {
        managedIcePromise = getSupabaseClient().functions.invoke("turn-credentials")
            .then(({ data, error }) => {
                if (error || !Array.isArray(data?.iceServers) || !data.iceServers.length) return;
                managedIceServers = data.iceServers;
                managedIceExpiresAt = Date.now() + Math.max(600, (Number(data.ttl) || 86400) - 3600) * 1000;
            })
            .catch(() => { /* функция не развёрнута или сеть — звонок пойдёт напрямую */ })
            .finally(() => { managedIcePromise = null; });
    }
    // Звонок не должен ждать дольше пары секунд, даже если сервер не отвечает.
    return Promise.race([managedIcePromise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

const RTC_CONFIG = {
    get iceServers() {
        const servers = [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
        ];
        if (managedIceServers && Date.now() < managedIceExpiresAt + 3600 * 1000) servers.push(...managedIceServers);
        if (DEFAULT_TURN.urls.length) servers.push({ urls: DEFAULT_TURN.urls, username: DEFAULT_TURN.username, credential: DEFAULT_TURN.credential });
        const turn = loadTurnConfig();
        if (turn) servers.push({ urls: turn.urls, username: turn.username || undefined, credential: turn.credential || undefined });
        return servers;
    }
};

function syncTurnSettingsHint() {
    const hint = document.getElementById("turn-row-hint");
    if (hint) hint.textContent = loadTurnConfig() ? "Подключён" : "Не настроен";
}

function openTurnModal() {
    const config = loadTurnConfig();
    document.getElementById("turn-urls-input").value = config ? config.urls.join("\n") : "";
    document.getElementById("turn-user-input").value = config?.username || "";
    document.getElementById("turn-pass-input").value = config?.credential || "";
    setTurnStatus("");
    const backdrop = document.getElementById("turn-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeTurnModal() {
    const backdrop = document.getElementById("turn-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function setTurnStatus(text, kind) {
    const el = document.getElementById("turn-status");
    el.textContent = text;
    el.dataset.kind = kind || "";
    el.hidden = !text;
}

function readTurnForm() {
    const urls = document.getElementById("turn-urls-input").value
        .split(/[\n,]+/).map((u) => u.trim()).filter(Boolean);
    return {
        urls,
        username: document.getElementById("turn-user-input").value.trim(),
        credential: document.getElementById("turn-pass-input").value
    };
}

function saveTurnSettings() {
    const config = readTurnForm();
    if (!config.urls.length) { setTurnStatus("Укажите хотя бы один адрес, например turn:turn.example.com:3478", "error"); return; }
    if (config.urls.some((u) => !/^turns?:/i.test(u))) { setTurnStatus("Адрес должен начинаться с turn: или turns:", "error"); return; }
    try {
        localStorage.setItem(TURN_STORAGE_KEY, JSON.stringify(config));
    } catch {
        setTurnStatus("Не удалось сохранить настройки в этом браузере", "error");
        return;
    }
    syncTurnSettingsHint();
    setTurnStatus("Сохранено. Новые звонки пойдут через этот сервер, если прямое соединение не получится.", "ok");
}

function resetTurnSettings() {
    try { localStorage.removeItem(TURN_STORAGE_KEY); } catch { /* нечего сбрасывать */ }
    document.getElementById("turn-urls-input").value = "";
    document.getElementById("turn-user-input").value = "";
    document.getElementById("turn-pass-input").value = "";
    syncTurnSettingsHint();
    setTurnStatus("Сервер отключён — звонки идут напрямую (STUN).", "ok");
}

// Проверка: собираем кандидатов ТОЛЬКО через этот сервер (relay). Нашёлся
// relay-кандидат — адрес и логин с паролем верные, сервер отвечает.
async function testTurnSettings() {

    const config = readTurnForm();
    if (!config.urls.length) { setTurnStatus("Сначала укажите адрес сервера", "error"); return; }

    setTurnStatus("Проверяем соединение с сервером…", "");
    document.getElementById("turn-test-btn").disabled = true;

    const result = await new Promise((resolve) => {
        let pc;
        try {
            pc = new RTCPeerConnection({
                iceServers: [{ urls: config.urls, username: config.username || undefined, credential: config.credential || undefined }],
                iceTransportPolicy: "relay"
            });
        } catch (error) {
            resolve({ ok: false, reason: "Некорректный адрес сервера" });
            return;
        }
        let lastError = "";
        const finish = (value) => { clearTimeout(timer); try { pc.close(); } catch { /* уже закрыто */ } resolve(value); };
        const timer = setTimeout(() => finish({ ok: false, reason: lastError || "Сервер не ответил за 10 секунд" }), 10000);
        pc.createDataChannel("turn-test");
        pc.onicecandidate = (event) => {
            if (event.candidate && /typ relay/.test(event.candidate.candidate)) finish({ ok: true });
        };
        pc.onicecandidateerror = (event) => {
            if (event.errorCode === 401) lastError = "Сервер отклонил логин или пароль";
            else if (event.errorText) lastError = event.errorText;
        };
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => finish({ ok: false, reason: "Не удалось начать проверку" }));
    });

    document.getElementById("turn-test-btn").disabled = false;
    setTurnStatus(result.ok ? "Сервер работает: ретрансляция доступна ✓" : "Не получилось: " + result.reason, result.ok ? "ok" : "error");

}

const CALL_RING_TIMEOUT_MS = 30000;

let callInboxUnsubscribe = null;
let activeCall = null;       // { callId, pc, localStream, isVideo, isCaller, remoteUserId, remoteName, remoteAvatarUrl, state, channel, timeoutTimer }
let pendingIncomingCall = null; // { callId, sdp, callerId, callerName, callerAvatarUrl, isVideo } — ждёт accept/decline

const CALL_HISTORY_STORAGE_PREFIX = "kaban-call-history:";

function callHistoryStorageKey() {
    return CALL_HISTORY_STORAGE_PREFIX + (myRealUserId || "guest");
}

function getCallHistory() {
    try {
        const history = JSON.parse(localStorage.getItem(callHistoryStorageKey()) || "[]");
        return Array.isArray(history) ? history.filter((call) => call && typeof call === "object") : [];
    } catch {
        return [];
    }
}

function saveCallHistoryEntry(entry) {
    const history = getCallHistory();
    const existingIndex = history.findIndex((call) => call.id === entry.id);
    if (existingIndex >= 0) history[existingIndex] = { ...history[existingIndex], ...entry };
    else history.unshift(entry);

    try {
        localStorage.setItem(callHistoryStorageKey(), JSON.stringify(history.slice(0, 100)));
    } catch (error) {
        console.warn("Не удалось сохранить историю звонков", error);
    }

    if (typeof updateCallHistoryBadge === "function") updateCallHistoryBadge();
    if (document.body.classList.contains("mobile-tab-calls")) renderCallHistory();
}

function updateCallHistoryEntry(callId, patch) {
    const entry = getCallHistory().find((call) => call.id === callId);
    if (entry) saveCallHistoryEntry({ ...entry, ...patch });
}

function markMissedCallsSeen() {
    const history = getCallHistory().map((call) =>
        call.direction === "incoming" && call.result === "missed" ? { ...call, seen: true } : call
    );
    try {
        localStorage.setItem(callHistoryStorageKey(), JSON.stringify(history));
    } catch (error) {
        console.warn("Не удалось отметить пропущенные звонки", error);
    }
    if (typeof updateCallHistoryBadge === "function") updateCallHistoryBadge();
}

function startCallInbox(myUserId) {
    if (callInboxUnsubscribe) return;
    callInboxUnsubscribe = KabanAPI.subscribeToCallInbox(myUserId, {
        onOffer: (payload) => handleIncomingCallOffer(payload)
    });
}

function stopCallInbox() {
    if (callInboxUnsubscribe) { callInboxUnsubscribe(); callInboxUnsubscribe = null; }
}

function handleIncomingCallOffer(payload) {

    saveCallHistoryEntry({
        id: payload.callId,
        remoteUserId: payload.callerId,
        name: payload.callerName || "Собеседник",
        avatarUrl: payload.callerAvatarUrl || null,
        kind: payload.isVideo ? "video" : "audio",
        direction: "incoming",
        result: "ringing",
        seen: false,
        startedAt: new Date().toISOString(),
        durationSeconds: 0
    });

    // Уже говорю с кем-то (или уже звонят) — автоматически "занято", как у
    // любого настоящего телефона, вместо того чтобы молча проигнорировать.
    if (activeCall || pendingIncomingCall || activeGroupCall || startingGroupCall) {
        updateCallHistoryEntry(payload.callId, { result: "missed", seen: false });
        const busy = KabanAPI.joinCallChannel(payload.callId, {});
        busy.ready.then(() => busy.sendEnd({ reason: "busy" })).catch(() => {}).finally(() => { try { busy.leave(); } catch {} });
        return;
    }

    pendingIncomingCall = payload;
    showIncomingCallUI(payload);

    // Пока звонок только звонит — слушаем канал звонка: звонящий мог сбросить
    // вызов или не дождаться ответа. Раньше отмена сюда не доходила, и окно
    // «Звонит вам…» (теперь ещё и с мелодией) висело у собеседника бесконечно.
    payload._watch = KabanAPI.joinCallChannel(payload.callId, {
        onEnd: () => { if (pendingIncomingCall === payload) dismissIncomingCall(payload); }
    });
    payload._ringTimer = setTimeout(() => {
        if (pendingIncomingCall === payload) dismissIncomingCall(payload);
    }, CALL_RING_TIMEOUT_MS + 5000);

}

// Отписаться от «наблюдения» за входящим (перед ответом/отклонением — у них свой канал).
function closeIncomingWatch(offer) {
    clearTimeout(offer?._ringTimer);
    const watch = offer?._watch;
    if (offer) offer._watch = null;
    try { return Promise.resolve(watch?.leave()).catch(() => {}); } catch { return Promise.resolve(); }
}

// Звонящий сбросил или не дождался ответа — тихо убрать входящий, записать «пропущенный».
function dismissIncomingCall(offer) {
    closeIncomingWatch(offer);
    if (pendingIncomingCall !== offer) return;
    pendingIncomingCall = null;
    stopCallTone();
    updateCallHistoryEntry(offer.callId, { result: "missed", seen: false });
    if (typeof updateCallHistoryBadge === "function") updateCallHistoryBadge();
    hideCallUI();
    toast(`Пропущенный звонок${offer.callerName ? " от " + offer.callerName : ""}`);
}

// kind: "audio" | "video" — вызывается с кнопок в шапке/карточке чата,
// звонит СОБЕСЕДНИКУ уже открытого 1:1 чата (currentOtherUserId уже
// отслеживается для реальных личных чатов, см. openRealChat).
let startingCall = false;

async function startCall(kind) {

    closeContactPopover();

    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED || !currentChatId) {
        toast("Звонки доступны только в настоящих чатах");
        return;
    }
    if (currentChatType === "group") {
        startOrJoinGroupCall(kind);
        return;
    }
    if (!currentOtherUserId) {
        toast("Нельзя позвонить в этом чате");
        return;
    }
    if (activeGroupCall || startingGroupCall) {
        toast("Вы уже в групповом звонке");
        return;
    }
    // startingCall закрывает окно между этой проверкой и присвоением
    // activeCall ниже: getUserMedia ждёт ответа на запрос разрешения (может
    // длиться секунды), и повторное нажатие кнопки звонка за это время иначе
    // тоже прошло бы проверку activeCall и запустило второй параллельный звонок.
    if (activeCall || pendingIncomingCall || startingCall) {
        toast("У вас уже есть активный звонок");
        return;
    }
    startingCall = true;

    // Снимок на момент нажатия — getUserMedia может висеть на запросе
    // разрешения сколь угодно долго, и если за это время пользователь
    // переключился на другой чат, звонок иначе ушёл бы уже ДРУГОМУ человеку
    // (см. sendP2PFile — тот же паттерн уже применён там).
    const remoteUserId = currentOtherUserId;
    const remoteName = currentChatTitle || "Собеседник";
    const remoteAvatarUrl = cachedChatRows.find((r) => r.chat_id === currentChatId)?.otherUser?.avatar_url || null;

    const isVideo = kind === "video";

    let localStream;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    } catch (error) {
        startingCall = false;
        toast("Не удалось получить доступ к " + (isVideo ? "камере/микрофону" : "микрофону"));
        return;
    }

    const callId = crypto.randomUUID();
    let pc = null;
    let channelHandle = null;

    try {

        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        await ensureTurnServers(); // ретранслятор для мобильных сетей
        pc = new RTCPeerConnection(RTC_CONFIG);
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        // В аудиозвонке заранее открываем «пустой» видеоканал: тогда камеру или показ
        // экрана можно включить посреди разговора (как в Telegram) без переподключения.
        if (!isVideo) pc.addTransceiver("video", { direction: "sendrecv" });

        activeCall = {
            callId, pc, localStream, isVideo,
            isCaller: true,
            remoteUserId,
            remoteName,
            remoteAvatarUrl,
            state: "calling",
            local: { muted: false, video: isVideo, screen: false },
            remote: { muted: false, video: isVideo, screen: false }
        };

        setupCallPeerConnection(pc, callId);

        // Кандидаты собеседника могут прийти раньше, чем применён его ответ (answer):
        // addIceCandidate до setRemoteDescription падает, и раньше такие кандидаты
        // молча терялись — соединение на мобильных сетях не устанавливалось.
        const pendingRemoteCandidates = [];

        channelHandle = KabanAPI.joinCallChannel(callId, {
            onAnswer: async (payload) => {
                if (!activeCall || activeCall.callId !== callId) return;
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                    for (const candidate of pendingRemoteCandidates.splice(0)) {
                        await pc.addIceCandidate(candidate).catch(() => {});
                    }
                    // Таймер "не ответил" снимаем ТОЛЬКО после успешного
                    // применения ответа — иначе при битом SDP звонок навсегда
                    // оставался бы в "calling" без единого предохранителя.
                    if (activeCall?.callId === callId) clearTimeout(activeCall.timeoutTimer);
                } catch (error) {
                    console.warn("Не удалось применить answer", error);
                    if (activeCall?.callId === callId) {
                        toast("Не удалось установить звонок");
                        teardownActiveCall("missed");
                    }
                }
            },
            onIceCandidate: (payload) => {
                if (!activeCall || activeCall.callId !== callId || !payload?.candidate) return;
                const candidate = new RTCIceCandidate(payload.candidate);
                if (!pc.remoteDescription) { pendingRemoteCandidates.push(candidate); return; }
                pc.addIceCandidate(candidate).catch(() => {});
            },
            onRenegotiate: (payload) => handleCallRenegotiate(callId, payload),
            onRestartRequest: () => { if (activeCall?.callId === callId) restartCallIce(callId); },
            onState: (payload) => handleCallRemoteState(callId, payload),
            onEnd: (payload) => {
                if (!activeCall || activeCall.callId !== callId) return;
                toast(payload?.reason === "busy" ? "Собеседник сейчас на другом звонке" : "Звонок завершён");
                teardownActiveCall(payload?.reason === "declined" ? "declined" : payload?.reason === "timeout" ? "missed" : undefined);
            }
        });
        activeCall.channel = channelHandle;
        await channelHandle.ready;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Собеседник подключается к каналу звонка только после того, как
        // нажмёт «Принять», — кандидаты, разосланные до этого по одному, уходили
        // в пустоту. Ждём сбора кандидатов (до 2,5 с) и отправляем их прямо
        // внутри предложения: так они гарантированно дойдут.
        await waitForIceGathering(pc, 2500);

        await KabanAPI.sendCallOffer(remoteUserId, {
            callId,
            sdp: pc.localDescription?.toJSON ? pc.localDescription.toJSON() : offer,
            callerId: me.id,
            callerName: cachedMyProfile?.display_name || "Пользователь",
            callerAvatarUrl: cachedMyProfile?.avatar_url || null,
            isVideo
        });

    } catch (error) {
        // Любой сбой настройки/сигнализации до showOutgoingCallUI — без этого
        // камера/микрофон оставались открытыми, activeCall навсегда не null
        // (блокирует все будущие звонки), а интерфейса звонка при этом нет.
        console.warn("Не удалось начать звонок", error);
        toast("Не удалось начать звонок");
        if (activeCall?.callId === callId) {
            teardownActiveCall("missed");
        } else {
            localStream.getTracks().forEach((track) => track.stop());
            try { pc?.close(); } catch {}
            try { channelHandle?.leave(); } catch {}
        }
        startingCall = false;
        return;
    }

    startingCall = false;

    saveCallHistoryEntry({
        id: callId,
        remoteUserId,
        name: remoteName,
        avatarUrl: remoteAvatarUrl,
        kind,
        direction: "outgoing",
        result: "missed",
        startedAt: new Date().toISOString(),
        durationSeconds: 0
    });

    showOutgoingCallUI();
    startCallTone("ringback");

    activeCall.timeoutTimer = setTimeout(() => {
        if (activeCall?.callId === callId && activeCall.state === "calling") {
            toast("Собеседник не ответил");
            channelHandle.sendEnd({ reason: "timeout" });
            teardownActiveCall("missed");
        }
    }, CALL_RING_TIMEOUT_MS);

}

async function acceptIncomingCall() {

    if (!pendingIncomingCall) return;
    const offer = pendingIncomingCall;
    pendingIncomingCall = null;
    stopCallTone();
    const watchClosed = closeIncomingWatch(offer);

    let localStream;
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: offer.isVideo });
    } catch (error) {
        toast("Не удалось получить доступ к " + (offer.isVideo ? "камере/микрофону" : "микрофону"));
        updateCallHistoryEntry(offer.callId, { result: "missed", seen: false });
        await watchClosed;
        // pendingIncomingCall уже обнулён выше — если уведомление собеседника
        // упадёт и hideCallUI() не выполнится, экран входящего звонка навсегда
        // остался бы висеть с мёртвыми кнопками (повторно принять/отклонить
        // его уже нечем). try/finally гарантирует закрытие экрана в любом случае.
        const channelHandle = KabanAPI.joinCallChannel(offer.callId, {});
        try {
            await channelHandle.ready;
            await channelHandle.sendEnd({ reason: "no-device" });
        } catch (signalError) {
            console.warn("Не удалось сообщить собеседнику об отказе", signalError);
        } finally {
            try { channelHandle.leave(); } catch {}
            hideCallUI();
        }
        return;
    }

    await ensureTurnServers(); // ретранслятор для мобильных сетей
    await watchClosed;         // канал «наблюдения» за этим звонком закрыт — открываем рабочий
    const pc = new RTCPeerConnection(RTC_CONFIG);
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    activeCall = {
        callId: offer.callId, pc, localStream, isVideo: offer.isVideo,
        isCaller: false,
        remoteUserId: offer.callerId,
        remoteName: offer.callerName,
        remoteAvatarUrl: offer.callerAvatarUrl,
        state: "connecting",
        connectedAt: null,
        local: { muted: false, video: !!offer.isVideo, screen: false },
        remote: { muted: false, video: !!offer.isVideo, screen: false }
    };
    updateCallHistoryEntry(offer.callId, { result: "connecting", seen: true });

    setupCallPeerConnection(pc, offer.callId);

    const pendingRemoteCandidates = [];
    const channelHandle = KabanAPI.joinCallChannel(offer.callId, {
        onIceCandidate: (payload) => {
            if (!activeCall || activeCall.callId !== offer.callId || !payload?.candidate) return;
            const candidate = new RTCIceCandidate(payload.candidate);
            // Пока предложение ещё не применено — копим, а не теряем.
            if (!pc.remoteDescription) { pendingRemoteCandidates.push(candidate); return; }
            pc.addIceCandidate(candidate).catch(() => {});
        },
        onRenegotiate: (payload) => handleCallRenegotiate(offer.callId, payload),
        onState: (payload) => handleCallRemoteState(offer.callId, payload),
        onEnd: () => {
            if (!activeCall || activeCall.callId !== offer.callId) return;
            toast("Звонок завершён");
            const connected = activeCall.state === "connected";
            teardownActiveCall(connected ? "completed" : "missed", !connected);
        }
    });
    activeCall.channel = channelHandle;

    try {
        await channelHandle.ready;
        await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
        for (const candidate of pendingRemoteCandidates.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => {});
        }
        // Видеоканал звонящего (в аудиозвонке он пустой) — делаем двусторонним,
        // чтобы и отвечающий мог включить камеру или показать экран посреди разговора.
        pc.getTransceivers().forEach((t) => {
            if (t.receiver?.track?.kind === "video" && t.direction === "recvonly") t.direction = "sendrecv";
        });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        // Свои кандидаты — внутри ответа (как и у звонящего): не зависят от
        // того, успел ли он их принять по одному.
        await waitForIceGathering(pc, 2000);
        await channelHandle.sendAnswer({ sdp: pc.localDescription?.toJSON ? pc.localDescription.toJSON() : answer });
    } catch (error) {
        toast("Не удалось установить соединение");
        teardownActiveCall("missed");
        return;
    }

    showInCallUI();

    // Звонящий мог сбросить вызов как раз в момент ответа — тогда соединение
    // не установится никогда, а «Соединение…» висело бы вечно.
    const acceptedCall = activeCall;
    acceptedCall.timeoutTimer = setTimeout(() => {
        if (activeCall === acceptedCall && !acceptedCall.connectedAt) {
            toast("Не удалось соединиться");
            Promise.resolve(acceptedCall.channel?.sendEnd({ reason: "failed" })).catch(() => {});
            teardownActiveCall("missed");
        }
    }, 25000);

}

function declineIncomingCall() {
    if (!pendingIncomingCall) return;
    const offer = pendingIncomingCall;
    pendingIncomingCall = null;
    stopCallTone();
    updateCallHistoryEntry(offer.callId, { result: "missed", seen: false });
    // Отказ отправляем через уже открытый канал «наблюдения», если он есть, — не открывая второй такой же.
    const watch = offer._watch;
    clearTimeout(offer._ringTimer);
    offer._watch = null;
    const channelHandle = watch || KabanAPI.joinCallChannel(offer.callId, {});
    // .finally(leave) — без него при сбое ready/sendEnd канал сигнализации
    // оставался подписанным навсегда (утечка на каждый отклонённый звонок
    // при нестабильной сети), плюс необработанный rejection в консоли.
    channelHandle.ready
        .then(() => channelHandle.sendEnd({ reason: "declined" }))
        .catch((error) => console.warn("Не удалось сообщить собеседнику об отклонении", error))
        .finally(() => { try { channelHandle.leave(); } catch {} });
    hideCallUI();
}

// Дождаться, пока браузер соберёт сетевые кандидаты (или истечёт время): тогда
// localDescription уже содержит их все и годится для отправки «одним куском».
function waitForIceGathering(pc, timeoutMs) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", check); resolve(); };
        const check = () => { if (pc.iceGatheringState === "complete") done(); };
        const timer = setTimeout(done, timeoutMs);
        pc.addEventListener("icegatheringstatechange", check);
    });
}

function setupCallPeerConnection(pc, callId) {

    pc.onicecandidate = (event) => {
        if (event.candidate && activeCall?.channel && activeCall.callId === callId) {
            activeCall.channel.sendIceCandidate({ candidate: event.candidate });
        }
    };

    pc.ontrack = (event) => {
        if (!activeCall || activeCall.callId !== callId) return;
        // Все дорожки собеседника — в один поток: видеоканал аудиозвонка приходит
        // без своего MediaStream (event.streams пуст), и раньше он затирал звук.
        if (!activeCall.remoteStream) activeCall.remoteStream = new MediaStream();
        const stream = activeCall.remoteStream;
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
        event.track.addEventListener("unmute", () => renderCallMedia());
        event.track.addEventListener("mute", () => renderCallMedia());
        const remoteVideoOrAudio = document.getElementById("call-remote-video");
        if (remoteVideoOrAudio && remoteVideoOrAudio.srcObject !== stream) {
            remoteVideoOrAudio.srcObject = stream;
            if (activeCall.outputId && remoteVideoOrAudio.setSinkId) remoteVideoOrAudio.setSinkId(activeCall.outputId).catch(() => {});
        }
        // Мобильные браузеры (особенно iPhone) не всегда сами запускают
        // воспроизведение после смены источника — без этого был чёрный экран без звука.
        remoteVideoOrAudio?.play?.().catch(() => {});
        if (event.track.kind === "audio") startCallVoiceMeter(activeCall);
        renderCallMedia();
    };

    pc.oniceconnectionstatechange = () => {
        if (activeCall?.callId === callId && (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed")) {
            finishCallRecoveryIfConnected(activeCall);
        }
    };

    pc.onconnectionstatechange = () => {
        if (!activeCall || activeCall.callId !== callId) return;
        if (pc.connectionState === "connected") {
            // connectedAt/тикер фиксируются ТОЛЬКО при первом соединении —
            // после переподключения длительность не обнуляется.
            if (activeCall.reconnecting) {
                activeCall.reconnecting = false;
                activeCall.reconnectStartedAt = null;
                clearTimeout(activeCall.recoveryTimer);
            }
            activeCall.state = "connected";
            if (!activeCall.connectedAt) {
                activeCall.connectedAt = Date.now();
                updateCallHistoryEntry(callId, { result: "completed", seen: true });
                document.getElementById("call-state").textContent = formatCallDuration(0);
                stopCallTone();
                playCallTone("connect");
                startCallDurationTicker(activeCall.connectedAt);
                startCallQualityMonitor(callId);
                sendCallState();
                showCallEncryptionKey(activeCall);
                const dialog = document.querySelector("#call-backdrop .call-dialog");
                if (dialog) { dialog.classList.add("is-connected"); dialog.dataset.phase = "connected"; }
                renderCallMedia();
            }
        } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            // Раньше: «disconnected» 5 секунд — и звонок сбрасывался, «failed» —
            // сразу. Смена Wi-Fi ↔ мобильный интернет так и выглядит. Теперь
            // звонок переподключается (ICE restart), пока не пройдёт 30 секунд.
            beginCallRecovery(callId, pc.connectionState === "failed" ? 0 : 1500);
        }
    };

}

/* ---- переподключение звонка без обрыва ---------------------------------------------------------
   Только звонящий создаёт новое предложение (iceRestart), иначе обе стороны могут
   одновременно начать переговоры и помешать друг другу. Принимающий при обрыве
   просит звонящего об этом. */

const CALL_RECOVERY_LIMIT_MS = 30000;

function beginCallRecovery(callId, delayMs) {
    const call = activeCall;
    if (!call || call.callId !== callId) return;
    if (!call.connectedAt) {
        // Ещё ни разу не соединились — это не обрыв, а неудачный звонок.
        if (call.pc.connectionState === "failed") { toast("Не удалось соединиться"); teardownActiveCall("missed", !call.isCaller); }
        return;
    }
    if (!call.reconnecting) {
        call.reconnecting = true;
        call.reconnectStartedAt = Date.now();
        const el = document.getElementById("call-state");
        if (el) el.textContent = "Переподключаемся…";
    }
    clearTimeout(call.recoveryTimer);
    call.recoveryTimer = setTimeout(() => attemptCallRecovery(callId), delayMs);
}

// Соединение уже живо (обрыв был мнимым или ICE restart прошёл без смены состояния,
// и событие «connected» не повторилось) — снимаем «Переподключаемся…».
function finishCallRecoveryIfConnected(call) {
    if (!call || !call.reconnecting) return false;
    const ice = call.pc.iceConnectionState;
    if (call.pc.connectionState === "connected" && (ice === "connected" || ice === "completed") && call.pc.signalingState === "stable") {
        call.reconnecting = false;
        call.reconnectStartedAt = null;
        clearTimeout(call.recoveryTimer);
        return true;
    }
    return false;
}

function attemptCallRecovery(callId) {
    const call = activeCall;
    if (!call || call.callId !== callId || !call.reconnecting) return;
    if (Date.now() - call.reconnectStartedAt > 2500 && finishCallRecoveryIfConnected(call)) return;
    if (Date.now() - call.reconnectStartedAt > CALL_RECOVERY_LIMIT_MS) {
        toast("Соединение прервалось");
        teardownActiveCall("completed");
        return;
    }
    if (call.isCaller) restartCallIce(callId);
    else Promise.resolve(call.channel?.sendRestartRequest?.()).catch(() => {});
    // Повторяем, пока не соединимся (сеть могла ещё не подняться).
    call.recoveryTimer = setTimeout(() => attemptCallRecovery(callId), 6000);
}

async function restartCallIce(callId) {
    const call = activeCall;
    if (!call || call.callId !== callId || !call.isCaller || call.renegotiating) return;
    call.renegotiating = true;
    try {
        const offer = await call.pc.createOffer({ iceRestart: true });
        await call.pc.setLocalDescription(offer);
        await waitForIceGathering(call.pc, 1500);
        if (activeCall !== call) return;
        await call.channel?.sendRenegotiate?.({ kind: "offer", sdp: call.pc.localDescription.toJSON() });
    } catch (error) {
        console.warn("Не удалось переподключить звонок", error);
    } finally {
        setTimeout(() => { if (activeCall === call) call.renegotiating = false; }, 2500);
    }
}

async function handleCallRenegotiate(callId, payload) {
    const call = activeCall;
    if (!call || call.callId !== callId || !payload?.sdp) return;
    try {
        if (payload.kind === "offer" && !call.isCaller) {
            await call.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            const answer = await call.pc.createAnswer();
            await call.pc.setLocalDescription(answer);
            await waitForIceGathering(call.pc, 1500);
            if (activeCall !== call) return;
            await call.channel?.sendRenegotiate?.({ kind: "answer", sdp: call.pc.localDescription.toJSON() });
        } else if (payload.kind === "answer" && call.isCaller && call.pc.signalingState === "have-local-offer") {
            await call.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        }
        // Через пару секунд после обмена — если связь жива, переподключение закончено.
        setTimeout(() => { if (activeCall === call) finishCallRecoveryIfConnected(call); }, 2000);
    } catch (error) {
        console.warn("Ошибка переподключения звонка", error);
    }
}

// Сеть сменилась (Wi-Fi ↔ мобильный) — не ждём, пока браузер сам заметит обрыв.
function nudgeCallOnNetworkChange() {
    const call = activeCall;
    if (!call || !call.connectedAt) return;
    setTimeout(() => {
        if (activeCall !== call) return;
        if (call.pc.connectionState !== "connected" || call.isCaller) beginCallRecovery(call.callId, 0);
    }, 800);
}
window.addEventListener("online", nudgeCallOnNetworkChange);
navigator.connection?.addEventListener?.("change", nudgeCallOnNetworkChange);

/* ---- адаптивное качество видео -------------------------------------------------------------------
   Каждые 3 секунды смотрим статистику отправки: потери пакетов и задержку.
   Плохо два раза подряд — снижаем разрешение и битрейт на ступень; хорошо
   четыре раза — возвращаем ступень выше. Звук не трогаем: он важнее картинки. */

const CALL_VIDEO_LEVELS = [
    { maxBitrate: 1500000, scale: 1 },
    { maxBitrate: 800000, scale: 1.5 },
    { maxBitrate: 450000, scale: 2 },
    { maxBitrate: 220000, scale: 3 }
];

async function applyCallVideoLevel(call, level) {
    const sender = call.pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;
    try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = CALL_VIDEO_LEVELS[level].maxBitrate;
        params.encodings[0].scaleResolutionDownBy = CALL_VIDEO_LEVELS[level].scale;
        params.degradationPreference = "balanced";
        await sender.setParameters(params);
        call.videoLevel = level;
    } catch { /* браузер не поддерживает — остаётся его собственная подстройка */ }
}

// Качество связи (для всех звонков): задержка и потери → «полоски» сигнала.
// Для видео — ещё и адаптация: плохо два раза подряд — снижаем разрешение и
// битрейт на ступень; хорошо четыре раза — возвращаем ступень выше.
function startCallQualityMonitor(callId) {
    const call = activeCall;
    if (!call || call.callId !== callId) return;
    clearInterval(call.qualityTimer);
    call.videoLevel = 0;
    call.signal = 4;
    let bad = 0, good = 0, prevLost = null, prevSent = null, prevInLost = null, prevInRecv = null;
    if (call.pc.getSenders().some((s) => s.track?.kind === "video")) applyCallVideoLevel(call, 0);
    call.qualityTimer = setInterval(async () => {
        if (activeCall !== call) { clearInterval(call.qualityTimer); return; }
        if (call.reconnecting) { call.signal = 1; renderCallSignal(); return; }
        let rtt = 0, lost = null, sent = null, inLost = null, inRecv = null;
        try {
            const stats = await call.pc.getStats();
            stats.forEach((report) => {
                if (report.type === "candidate-pair" && report.nominated && typeof report.currentRoundTripTime === "number") rtt = Math.max(rtt, report.currentRoundTripTime);
                if (report.type === "remote-inbound-rtp" && report.kind === "video") {
                    rtt = Math.max(rtt, report.roundTripTime || 0);
                    lost = report.packetsLost || 0;
                }
                if (report.type === "outbound-rtp" && report.kind === "video") sent = report.packetsSent || 0;
                if (report.type === "inbound-rtp" && report.kind === "audio") { inLost = report.packetsLost || 0; inRecv = report.packetsReceived || 0; }
            });
        } catch { return; }
        // Доля потерь за последние 3 секунды (по приросту счётчиков).
        let lossRatio = 0;
        if (lost !== null && sent !== null && prevLost !== null && prevSent !== null && sent > prevSent) {
            lossRatio = Math.max(0, lost - prevLost) / (sent - prevSent);
        }
        let audioLoss = 0;
        if (inLost !== null && inRecv !== null && prevInLost !== null && prevInRecv !== null) {
            const total = (inRecv - prevInRecv) + Math.max(0, inLost - prevInLost);
            if (total > 0) audioLoss = Math.max(0, inLost - prevInLost) / total;
        }
        prevLost = lost; prevSent = sent; prevInLost = inLost; prevInRecv = inRecv;

        const worst = Math.max(lossRatio, audioLoss);
        call.signal = rtt < 0.15 && worst < 0.02 ? 4 : rtt < 0.3 && worst < 0.05 ? 3 : rtt < 0.6 && worst < 0.12 ? 2 : 1;
        renderCallSignal();

        if (!call.pc.getSenders().some((s) => s.track?.kind === "video")) return;
        const isBad = lossRatio > 0.08 || rtt > 0.6;
        const isGood = lossRatio < 0.02 && rtt < 0.3;
        if (isBad) { bad++; good = 0; } else if (isGood) { good++; bad = 0; } else { bad = 0; good = 0; }
        if (bad >= 2 && call.videoLevel < CALL_VIDEO_LEVELS.length - 1) { bad = 0; await applyCallVideoLevel(call, call.videoLevel + 1); }
        else if (good >= 4 && call.videoLevel > 0) { good = 0; await applyCallVideoLevel(call, call.videoLevel - 1); }
    }, 3000);
}

function renderCallSignal() {
    const el = document.getElementById("call-signal");
    if (!el || !activeCall) return;
    el.hidden = !activeCall.connectedAt;
    el.dataset.level = String(activeCall.signal || 4);
    el.title = ["", "Очень слабая связь", "Слабая связь", "Хорошая связь", "Отличная связь"][activeCall.signal || 4];
}

let callDurationTicker = null;

function formatCallDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function callStatusText() {
    const call = activeCall;
    if (!call) return "";
    if (call.reconnecting) return "Переподключаемся…";
    if (call.state === "calling") return "Вызов…";
    if (!call.connectedAt) return "Соединение…";
    const weak = (call.signal || 4) <= 1 ? " · слабая связь" : "";
    return formatCallDuration(Math.floor((Date.now() - call.connectedAt) / 1000)) + weak;
}

function startCallDurationTicker(startedAt = Date.now()) {
    clearInterval(callDurationTicker);
    callDurationTicker = setInterval(() => {
        if (!activeCall || activeCall.state !== "connected") { clearInterval(callDurationTicker); return; }
        document.querySelector("#call-backdrop .call-dialog")?.classList.toggle("reconnecting", !!activeCall.reconnecting);
        const text = callStatusText();
        const el = document.getElementById("call-state");
        if (el && el.textContent !== text) el.textContent = text;
        const mini = document.getElementById("call-mini-state");
        if (mini && mini.textContent !== text) mini.textContent = text;
    }, 1000);
}

function endCall() {
    if (pendingIncomingCall) { declineIncomingCall(); return; }
    if (!activeCall) { hideCallUI(); return; }
    Promise.resolve(activeCall.channel?.sendEnd({ reason: "hangup" })).catch(() => {});
    teardownActiveCall(activeCall.state === "connected" ? "completed" : "cancelled");
}

function teardownActiveCall(result, unseenMissedCall = false) {
    clearInterval(callDurationTicker);
    stopCallTone();
    if (activeCall) {
        if (activeCall.connectedAt || result === "declined") playCallTone("end");
        const durationSeconds = activeCall.connectedAt
            ? Math.floor((Date.now() - activeCall.connectedAt) / 1000)
            : 0;
        updateCallHistoryEntry(activeCall.callId, {
            result: result || (durationSeconds ? "completed" : "missed"),
            seen: !unseenMissedCall,
            durationSeconds
        });
        clearTimeout(activeCall.timeoutTimer);
        clearTimeout(activeCall.recoveryTimer);
        clearInterval(activeCall.qualityTimer);
        activeCall.voiceMeter?.stop();
        activeCall.localStream?.getTracks().forEach((track) => track.stop());
        activeCall.screenTrack?.stop();
        try { activeCall.pc?.close(); } catch {}
        activeCall.channel?.leave();
        activeCall = null;
    }
    ["call-remote-video", "call-local-video", "call-mini-video"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.srcObject = null;
    });
    hideCallUI();
}

/* ---- микрофон, камера, показ экрана ---------------------------------------------------------- */

function callVideoSender(call) {
    const t = call.pc.getTransceivers().find((tr) => tr.receiver?.track?.kind === "video" && tr.direction !== "inactive");
    return t ? t.sender : null;
}

function sendCallState() {
    const call = activeCall;
    if (!call?.channel?.sendState) return;
    Promise.resolve(call.channel.sendState({ ...call.local })).catch(() => {});
}

function handleCallRemoteState(callId, payload) {
    const call = activeCall;
    if (!call || call.callId !== callId || !payload || typeof payload !== "object") return;
    const firstState = !call.remoteStateKnown;
    call.remoteStateKnown = true;
    call.remote = { muted: !!payload.muted, video: !!payload.video, screen: !!payload.screen };
    // Собеседник впервые прислал своё состояние — значит, его клиент умеет
    // принимать наше: отвечаем своим (на случай, если наше ушло раньше, чем он подключился).
    if (firstState) sendCallState();
    renderCallMedia();
}

async function toggleCallControl(button) {

    const call = activeCall;
    if (!call) return;
    const action = button.dataset.callAction;

    if (action === "mute") {
        call.local.muted = !call.local.muted;
        call.localStream.getAudioTracks().forEach((track) => { track.enabled = !call.local.muted; });
        playCallTone(call.local.muted ? "mute" : "unmute");
    } else if (action === "camera" || action === "screen") {
        // Пока камера/экран включаются (запрос разрешения может висеть секунды),
        // повторное нажатие не должно запускать второй такой же запрос.
        if (call.mediaBusy) return;
        call.mediaBusy = true;
        try {
            if (action === "camera") { if (call.local.video) await stopCallCamera(call); else await startCallCamera(call); }
            else { if (call.local.screen) await stopCallScreen(call); else await startCallScreen(call); }
        } finally {
            call.mediaBusy = false;
        }
    }
    if (activeCall !== call) return;
    sendCallState();
    renderCallControls();
    renderCallMedia();

}

async function startCallCamera(call, deviceId) {
    const sender = callVideoSender(call);
    if (!sender) { toast("Собеседник пользуется старой версией — видео в этом звонке недоступно"); return; }
    let track;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        });
        track = stream.getVideoTracks()[0];
    } catch (error) {
        toast(error?.name === "NotAllowedError" ? "Нет доступа к камере" : "Камера не найдена");
        return;
    }
    if (activeCall !== call) { track.stop(); return; }
    call.localStream.getVideoTracks().forEach((old) => { old.stop(); call.localStream.removeTrack(old); });
    call.localStream.addTrack(track);
    call.cameraId = deviceId || track.getSettings?.().deviceId || null;
    if (!call.local.screen) await sender.replaceTrack(track).catch(() => {});
    call.local.video = true;
    if (!call.qualityTimer && call.connectedAt) startCallQualityMonitor(call.callId);
}

async function stopCallCamera(call) {
    const sender = callVideoSender(call);
    call.localStream.getVideoTracks().forEach((track) => { track.stop(); call.localStream.removeTrack(track); });
    if (sender && !call.local.screen) await sender.replaceTrack(null).catch(() => {});
    call.local.video = false;
}

async function startCallScreen(call) {
    const sender = callVideoSender(call);
    if (!sender) { toast("Собеседник пользуется старой версией — показ экрана в этом звонке недоступен"); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast("Показ экрана не поддерживается на этом устройстве"); return; }
    let track;
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false, selfBrowserSurface: "exclude" });
        track = stream.getVideoTracks()[0];
    } catch (error) {
        if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") toast("Не удалось показать экран");
        return;
    }
    if (activeCall !== call) { track.stop(); return; }
    try { track.contentHint = "detail"; } catch {}
    track.addEventListener("ended", () => {
        if (activeCall === call && call.screenTrack === track) stopCallScreen(call).then(() => { sendCallState(); renderCallControls(); renderCallMedia(); });
    });
    call.screenTrack = track;
    await sender.replaceTrack(track).catch(() => {});
    call.local.screen = true;
}

async function stopCallScreen(call) {
    const sender = callVideoSender(call);
    call.screenTrack?.stop();
    call.screenTrack = null;
    call.local.screen = false;
    // Вернуть камеру, если она была включена до показа экрана.
    const camera = call.localStream.getVideoTracks()[0] || null;
    if (sender) await sender.replaceTrack(camera).catch(() => {});
}

/* ---- окно звонка ------------------------------------------------------------------------------ */

function closeCallFromBackdrop(event) {
    // Раньше клик мимо окна ЗАВЕРШАЛ звонок — легко сбросить разговор случайно.
    // Теперь окно просто сворачивается (входящий — не трогаем).
    if (event.target === event.currentTarget && activeCall) minimizeCall();
}

function setCallPersonInfo(name, avatarUrl) {
    document.getElementById("call-name").textContent = name || "Собеседник";
    // Стиль ставим через style.*, а не setAttribute(... из avatarParts): там адрес фото
    // уже экранирован под HTML (&quot;), и как CSS он не читался — фото не показывалось.
    const paint = (el) => {
        if (!el) return;
        const parts = avatarParts({ name: name || "Собеседник", url: null });
        el.removeAttribute("style");
        if (avatarUrl) {
            el.innerHTML = "";
            el.style.backgroundImage = cssUrlValue(avatarUrl);
            el.style.backgroundSize = "cover";
            el.style.backgroundPosition = "center";
        } else {
            el.innerHTML = parts.inner;
            el.style.background = (parts.style.match(/background:([^;"]+)/) || [])[1] || "";
            el.style.color = "#fff";
        }
    };
    const avatarEl = document.getElementById("call-avatar");
    paint(avatarEl);
    avatarEl.classList.toggle("has-initials", !avatarUrl);
    const bg = document.getElementById("call-bg-photo");
    if (bg) {
        bg.style.backgroundImage = avatarUrl ? cssUrlValue(avatarUrl) : "";
        bg.hidden = !avatarUrl;
    }
    paint(document.getElementById("call-mini-avatar"));
    const miniName = document.getElementById("call-mini-name");
    if (miniName) miniName.textContent = name || "Собеседник";
}

function openCallBackdrop(phase) {
    const backdrop = document.getElementById("call-backdrop");
    const dialog = backdrop.querySelector(".call-dialog");
    dialog.dataset.phase = phase;   // ringing-out | ringing-in | connecting | connected
    dialog.classList.toggle("is-connected", phase === "connected" || !!activeCall?.connectedAt);
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("call-mini").hidden = true;
    document.body.classList.add("in-call-ui");
    callPokeControls();
}

function showOutgoingCallUI() {
    document.getElementById("call-kind").textContent = activeCall.isVideo ? "Видеозвонок" : "Аудиозвонок";
    document.getElementById("call-state").textContent = "Вызов…";
    setCallPersonInfo(activeCall.remoteName, activeCall.remoteAvatarUrl);
    document.getElementById("call-controls-incoming").hidden = true;
    document.getElementById("call-controls-incall").hidden = false;
    document.getElementById("call-remote-muted").hidden = true;
    document.getElementById("call-key").hidden = true;
    renderCallControls();
    renderCallMedia();
    openCallBackdrop("ringing-out");
}

function showIncomingCallUI(offer) {

    document.getElementById("call-kind").textContent = offer.isVideo ? "Входящий видеозвонок" : "Входящий звонок";
    document.getElementById("call-state").textContent = offer.isVideo ? "Видеозвонок…" : "Звонит вам…";
    setCallPersonInfo(offer.callerName, offer.callerAvatarUrl);

    document.getElementById("call-video-area").hidden = true;
    document.getElementById("call-controls-incall").hidden = true;
    document.getElementById("call-controls-incoming").hidden = false;
    document.getElementById("call-remote-muted").hidden = true;
    document.getElementById("call-key").hidden = true;
    document.getElementById("call-signal").hidden = true;
    const dialog = document.querySelector("#call-backdrop .call-dialog");
    dialog.classList.remove("has-remote-video", "has-local-video", "is-connected");
    openCallBackdrop("ringing-in");
    startCallTone("ringtone");

    // Окно не на виду (другая вкладка, свёрнуто, в трее) — системное уведомление о звонке.
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && (document.hidden || !document.hasFocus())) {
        try {
            const notification = new Notification(offer.callerName || "Входящий звонок", {
                body: offer.isVideo ? "Входящий видеозвонок" : "Входящий звонок",
                icon: offer.callerAvatarUrl || undefined,
                tag: "kaban-call",
                requireInteraction: true
            });
            notification.onclick = () => { window.focus(); notification.close(); };
            const closeWhenDone = setInterval(() => {
                if (pendingIncomingCall !== offer) { notification.close(); clearInterval(closeWhenDone); }
            }, 1000);
        } catch { /* без уведомления — окно звонка всё равно открыто */ }
    }

}

function showInCallUI() {
    document.getElementById("call-kind").textContent = activeCall.isVideo ? "Видеозвонок" : "Аудиозвонок";
    document.getElementById("call-state").textContent = "Соединение…";
    setCallPersonInfo(activeCall.remoteName, activeCall.remoteAvatarUrl);
    document.getElementById("call-controls-incoming").hidden = true;
    document.getElementById("call-controls-incall").hidden = false;
    renderCallControls();
    renderCallMedia();
    openCallBackdrop("connecting");
}

function hideCallUI() {
    const backdrop = document.getElementById("call-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.getElementById("call-video-area").hidden = true;
    document.getElementById("call-mini").hidden = true;
    document.getElementById("call-devices").hidden = true;
    document.getElementById("call-key-hint").hidden = true;
    const dialog = backdrop.querySelector(".call-dialog");
    dialog.classList.remove("has-remote-video", "has-local-video", "is-connected", "controls-idle", "swapped");
    document.body.classList.remove("in-call-ui");
    clearTimeout(callIdleTimer);
}

// Кнопки: подписи и «нажатость» по реальному состоянию.
function renderCallControls() {
    const call = activeCall;
    if (!call) return;
    const set = (action, pressed, label, title) => {
        const button = document.querySelector(`#call-controls-incall [data-call-action="${action}"]`);
        if (!button) return;
        button.setAttribute("aria-pressed", String(pressed));
        const span = button.querySelector(".call-control-label");
        if (span) span.textContent = label;
        button.title = title;
    };
    set("mute", call.local.muted, call.local.muted ? "Вкл. звук" : "Микрофон", call.local.muted ? "Включить микрофон (M)" : "Выключить микрофон (M)");
    set("camera", call.local.video, call.local.video ? "Камера" : "Видео", call.local.video ? "Выключить камеру (V)" : "Включить камеру (V)");
    set("screen", call.local.screen, call.local.screen ? "Стоп" : "Экран", call.local.screen ? "Остановить показ экрана" : "Показать экран");
    const screenBtn = document.querySelector('#call-controls-incall [data-call-action="screen"]');
    if (screenBtn) screenBtn.hidden = !navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/.test(navigator.userAgent);
    const miniMute = document.getElementById("call-mini-mute");
    if (miniMute) miniMute.classList.toggle("on", call.local.muted);
}

// Что показывать: видео собеседника на весь экран, своё — в окошке, или аватар.
function renderCallMedia() {
    const call = activeCall;
    const dialog = document.querySelector("#call-backdrop .call-dialog");
    if (!call || !dialog) return;
    const remoteVideoTrack = call.remoteStream?.getVideoTracks().find((t) => t.readyState === "live");
    const remoteVideo = !!remoteVideoTrack && (call.remote.video || call.remote.screen) && !remoteVideoTrack.muted;
    const localVideo = call.local.video || call.local.screen;
    const area = document.getElementById("call-video-area");
    area.hidden = !remoteVideo && !localVideo;
    dialog.classList.toggle("has-remote-video", remoteVideo);
    dialog.classList.toggle("has-local-video", localVideo);
    dialog.classList.toggle("remote-screen", remoteVideo && call.remote.screen);
    if (!remoteVideo || !localVideo) dialog.classList.remove("swapped");

    // Привязка к конкретной дорожке: после «выкл → вкл» камеры дорожка новая, и
    // элемент со старым потоком мог остаться чёрным.
    const localEl = document.getElementById("call-local-video");
    const localTrack = call.local.screen && call.screenTrack ? call.screenTrack : call.localStream.getVideoTracks()[0];
    const wantKey = localTrack ? localTrack.id : "";
    if (localVideo && localTrack && localEl.dataset.src !== wantKey) {
        localEl.srcObject = new MediaStream([localTrack]);
        localEl.dataset.src = wantKey;
        localEl.play?.().catch(() => {});
    } else if (!localVideo && localEl.srcObject) {
        localEl.srcObject = null;
        localEl.dataset.src = "";
    }
    localEl.classList.toggle("mirror", !call.local.screen);

    // Включили видео посреди аудиозвонка — и подпись сверху меняется.
    const kind = document.getElementById("call-kind");
    if (kind && call.connectedAt) kind.textContent = remoteVideo || localVideo ? (call.remote.screen || call.local.screen ? "Показ экрана" : "Видеозвонок") : "Аудиозвонок";

    const muted = document.getElementById("call-remote-muted");
    if (muted) {
        muted.hidden = !call.remote.muted || !call.connectedAt;
        const label = muted.querySelector("span");
        if (label) label.textContent = `${(call.remoteName || "Собеседник").split(" ")[0]} выключил(а) микрофон`;
    }
    const miniVideo = document.getElementById("call-mini-video");
    if (miniVideo) {
        miniVideo.hidden = !remoteVideo;
        if (remoteVideo && miniVideo.srcObject !== call.remoteStream) { miniVideo.srcObject = call.remoteStream; miniVideo.play?.().catch(() => {}); }
    }
    renderCallSignal();
}

/* ---- свернуть / развернуть ---- */

function minimizeCall() {
    if (!activeCall) return;
    const backdrop = document.getElementById("call-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.body.classList.remove("in-call-ui");
    document.getElementById("call-devices").hidden = true;
    const mini = document.getElementById("call-mini");
    mini.hidden = false;
    document.getElementById("call-mini-state").textContent = callStatusText();
    renderCallControls();
    renderCallMedia();
}

function restoreCall() {
    if (!activeCall) return;
    const dialog = document.querySelector("#call-backdrop .call-dialog");
    openCallBackdrop(dialog.dataset.phase || "connected");
    renderCallMedia();
}

/* ---- элементы управления исчезают в видеозвонке, если мышь не двигается ---- */

let callIdleTimer = null;
function callPokeControls() {
    const dialog = document.querySelector("#call-backdrop .call-dialog");
    if (!dialog) return;
    dialog.classList.remove("controls-idle");
    clearTimeout(callIdleTimer);
    callIdleTimer = setTimeout(() => {
        if (dialog.classList.contains("has-remote-video") && document.getElementById("call-devices").hidden) dialog.classList.add("controls-idle");
    }, 3500);
}

/* ---- своё видео: перетаскивается в любой угол, клик — поменять местами с собеседником ---- */

(function initCallPip() {
    const pip = document.getElementById("call-local-video");
    if (!pip) return;
    let drag = null;
    pip.addEventListener("pointerdown", (event) => {
        const dialog = pip.closest(".call-dialog");
        if (dialog.classList.contains("swapped")) return;   // крупно своё — тянуть нечего
        const rect = pip.getBoundingClientRect();
        drag = { x: event.clientX, y: event.clientY, dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false, id: event.pointerId };
        pip.setPointerCapture(event.pointerId);
    });
    pip.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
        drag.moved = true;
        const box = pip.parentElement.getBoundingClientRect();
        pip.classList.add("dragging");
        pip.style.left = (event.clientX - drag.dx - box.left) + "px";
        pip.style.top = (event.clientY - drag.dy - box.top) + "px";
        pip.style.right = pip.style.bottom = "auto";
    });
    const end = (event) => {
        if (!drag) return;
        const wasDrag = drag.moved;
        drag = null;
        pip.classList.remove("dragging");
        if (!wasDrag) {
            const dialog = pip.closest(".call-dialog");
            if (dialog.classList.contains("has-remote-video")) dialog.classList.toggle("swapped");
            return;
        }
        // Прилипнуть к ближайшему углу.
        const box = pip.parentElement.getBoundingClientRect();
        const rect = pip.getBoundingClientRect();
        const right = rect.left + rect.width / 2 > box.left + box.width / 2;
        const bottom = rect.top + rect.height / 2 > box.top + box.height / 2;
        pip.style.left = pip.style.top = pip.style.right = pip.style.bottom = "";
        pip.dataset.corner = (bottom ? "b" : "t") + (right ? "r" : "l");
    };
    pip.addEventListener("pointerup", end);
    pip.addEventListener("pointercancel", end);
    // Клик по большому своему видео (после «поменять местами») — вернуть как было.
    document.getElementById("call-remote-video")?.addEventListener("click", () => {
        document.querySelector("#call-backdrop .call-dialog")?.classList.remove("swapped");
    });
})();

/* ---- устройства: микрофон, динамик, камера ---- */

async function toggleCallDevices() {
    const panel = document.getElementById("call-devices");
    if (!panel.hidden) { panel.hidden = true; return; }
    const call = activeCall;
    if (!call) return;
    let devices = [];
    try { devices = await navigator.mediaDevices.enumerateDevices(); } catch { /* без списка */ }
    const micId = call.localStream.getAudioTracks()[0]?.getSettings?.().deviceId || "";
    const camId = call.cameraId || call.localStream.getVideoTracks()[0]?.getSettings?.().deviceId || "";
    const remoteEl = document.getElementById("call-remote-video");
    const canPickOutput = typeof remoteEl?.setSinkId === "function";
    const select = (kind, current, label, onchange) => {
        const list = devices.filter((d) => d.kind === kind);
        if (!list.length) return "";
        return `<label class="call-device-row"><span>${label}</span><select onchange="${onchange}(this.value)">${
            list.map((d, i) => `<option value="${escapeHTML(d.deviceId)}"${d.deviceId === current ? " selected" : ""}>${escapeHTML(d.label || `${label} ${i + 1}`)}</option>`).join("")}</select></label>`;
    };
    panel.innerHTML =
        select("audioinput", micId, "Микрофон", "switchCallMic") +
        (canPickOutput ? select("audiooutput", call.outputId || "default", "Динамик", "switchCallOutput") : "") +
        select("videoinput", camId, "Камера", "switchCallCamera") ||
        `<div class="call-device-empty">Устройства не найдены</div>`;
    panel.hidden = false;
}

async function switchCallMic(deviceId) {
    const call = activeCall;
    if (!call) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
        const track = stream.getAudioTracks()[0];
        track.enabled = !call.local.muted;
        const sender = call.pc.getSenders().find((s) => s.track?.kind === "audio");
        await sender?.replaceTrack(track);
        call.localStream.getAudioTracks().forEach((old) => { old.stop(); call.localStream.removeTrack(old); });
        call.localStream.addTrack(track);
        toast("Микрофон переключён");
    } catch { toast("Не удалось переключить микрофон"); }
}

async function switchCallOutput(deviceId) {
    const call = activeCall;
    if (!call) return;
    call.outputId = deviceId;
    try { await document.getElementById("call-remote-video").setSinkId(deviceId); toast("Звук переключён"); }
    catch { toast("Не удалось переключить динамик"); }
}

async function switchCallCamera(deviceId) {
    const call = activeCall;
    if (!call) return;
    if (!call.local.video) { call.cameraId = deviceId; return; }
    await startCallCamera(call, deviceId);
    renderCallMedia();
}

/* ---- «ключ» шифрования: 4 эмодзи из отпечатков DTLS обеих сторон ----
   Совпадают у вас и у собеседника — между вами никто не вклинился (как в Telegram). */

const CALL_KEY_EMOJI = ["🐶","🐱","🦊","🐻","🐼","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🐔","🐧","🐦","🦉","🦄","🐝","🦋","🐢","🐙","🐬","🐳","🦈","🌵","🌲","🍀","🌻","🌹","🍄","🌙","⭐","🔥","🌈","☀️","❄️","🍎","🍋","🍉","🍇","🍓","🍒","🥝","🍕","🍔","🍩","🍪","🎂","⚽","🏀","🎸","🎧","🎲","🚀","✈️","🚗","⚓","🔑","💎","🎁","📷","💡","🔔","🎈"];

async function showCallEncryptionKey(call) {
    try {
        const prints = [call.pc.localDescription?.sdp, call.pc.remoteDescription?.sdp]
            .map((sdp) => (/a=fingerprint:\S+ (\S+)/.exec(sdp || "") || [])[1] || "")
            .filter(Boolean).sort();
        if (prints.length < 2 || !crypto.subtle) return;
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prints.join("|"))));
        if (activeCall !== call) return;
        const emoji = [0, 1, 2, 3].map((i) => CALL_KEY_EMOJI[digest[i] % CALL_KEY_EMOJI.length]).join("");
        document.getElementById("call-key-emoji").textContent = emoji;
        document.getElementById("call-key").hidden = false;
    } catch { /* без ключа */ }
}

function toggleCallKeyHint() {
    const hint = document.getElementById("call-key-hint");
    hint.hidden = !hint.hidden;
}

// Аватар собеседника «дышит» в такт его голосу — как в Telegram (только анализ, звук не дублируется).
function startCallVoiceMeter(call) {
    if (!call || call.voiceMeter) return;
    const track = call.remoteStream?.getAudioTracks()[0];
    const ctx = track && callAudioCtx();
    if (!ctx) return;
    try {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buffer = new Float32Array(analyser.fftSize);
        const wrap = document.querySelector("#call-backdrop .call-avatar-wrap");
        let raf = 0, last = 0, level = 0;
        const tick = (now) => {
            raf = requestAnimationFrame(tick);
            if (now - last < 66) return;
            last = now;
            analyser.getFloatTimeDomainData(buffer);
            let sum = 0;
            for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
            const target = call.remote.muted ? 0 : Math.min(1, Math.sqrt(sum / buffer.length) * 7);
            level = level * 0.55 + target * 0.45;
            wrap?.style.setProperty("--level", level.toFixed(3));
        };
        raf = requestAnimationFrame(tick);
        call.voiceMeter = { stop: () => { cancelAnimationFrame(raf); try { source.disconnect(); } catch {} wrap?.style.setProperty("--level", "0"); } };
    } catch { /* без анимации голоса */ }
}

/* ---- звуки звонка: гудки, мелодия входящего, соединение, отбой ---- */

let callToneCtx = null;
let callToneTimer = null;

function callAudioCtx() {
    if (!callToneCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        callToneCtx = new Ctx();
    }
    if (callToneCtx.state === "suspended") callToneCtx.resume().catch(() => {});
    return callToneCtx;
}

function callBeep(freq, start, duration, volume = 0.12, type = "sine") {
    const ctx = callAudioCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
    gain.gain.setValueAtTime(volume, t0 + Math.max(0.03, duration - 0.05));
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
}

function startCallTone(kind) {
    stopCallTone();
    const play = kind === "ringback"
        ? () => callBeep(425, 0, 0.9, 0.08)                         // длинный гудок, как в телефоне
        : () => { [660, 880, 990, 880].forEach((f, i) => callBeep(f, i * 0.16, 0.15, 0.11, "triangle")); };
    play();
    callToneTimer = setInterval(play, kind === "ringback" ? 4000 : 2200);
}

function stopCallTone() {
    clearInterval(callToneTimer);
    callToneTimer = null;
}

function playCallTone(kind) {
    if (kind === "connect") { callBeep(660, 0, 0.09, 0.09); callBeep(990, 0.11, 0.12, 0.09); }
    else if (kind === "end") { [480, 480, 480].forEach((f, i) => callBeep(f, i * 0.32, 0.18, 0.08)); }
    else if (kind === "mute") callBeep(330, 0, 0.1, 0.07);
    else if (kind === "unmute") callBeep(520, 0, 0.1, 0.07);
}

/* ---- клавиши: M — микрофон, V — камера, Esc — свернуть ---- */

document.addEventListener("keydown", (event) => {
    if (!activeCall || !document.getElementById("call-backdrop").classList.contains("open")) return;
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']") || event.ctrlKey || event.metaKey || event.altKey) return;
    const button = (action) => document.querySelector(`#call-controls-incall [data-call-action="${action}"]`);
    if (event.code === "KeyM") { event.preventDefault(); toggleCallControl(button("mute")); }
    else if (event.code === "KeyV" && activeCall.connectedAt) { event.preventDefault(); toggleCallControl(button("camera")); }
    else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Сначала закрываем открытые панели (устройства, подсказку), потом — сворачиваем.
        const devices = document.getElementById("call-devices"), hint = document.getElementById("call-key-hint");
        if (!devices.hidden || !hint.hidden) { devices.hidden = true; hint.hidden = true; return; }
        minimizeCall();
    }
}, true);


/* ============================================================================
   ТРАНСЛЯЦИЯ ЭКРАНА (P2P) — стример → один зритель, видео и звук идут
   напрямую между браузерами (RTCPeerConnection, шифрование DTLS-SRTP), через
   Supabase проходит только сигнализация (SDP/ICE). Поэтому качество не
   ограничено сервисом: пресеты ниже выставляют потолок битрейта/кадров, а
   реально достижимое упирается в исходящий канал стримера и входящий —
   зрителя (WebRTC сам подстраивает битрейт под сеть; причину ограничения —
   сеть или процессор — показываем в статистике).

   Намеренно ОТДЕЛЬНЫЕ каналы (screen-inbox / screen:<id>) и состояние от
   звонков и передачи файлов — сбой одной фичи не задевает другие.
   Ограничение: TURN не подключён (только STUN), за строгим NAT соединение
   не поднимется — как и у звонков.
   ========================================================================= */

// bitrate — потолок (бит/с), который просим у кодека; fps — потолок кадров.
// hint: "motion" — приоритет плавности (игры), "detail" — чёткости (текст/слайды).
const SCREEN_PRESETS = [
    { id: "720p30",   label: "720p · 30 fps",    note: "Экономно, ~3.5 Мбит/с",              width: 1280, height: 720,  fps: 30, bitrate: 3500000,  hint: "detail" },
    { id: "1080p30",  label: "1080p · 30 fps",   note: "Чётко для текста, ~8 Мбит/с",        width: 1920, height: 1080, fps: 30, bitrate: 8000000,  hint: "detail" },
    { id: "1080p60",  label: "1080p · 60 fps",   note: "Игры, ~14 Мбит/с",                   width: 1920, height: 1080, fps: 60, bitrate: 14000000, hint: "motion" },
    { id: "1440p60",  label: "1440p · 60 fps",   note: "Игры, ~24 Мбит/с",                   width: 2560, height: 1440, fps: 60, bitrate: 24000000, hint: "motion" },
    { id: "2160p60",  label: "4K · 60 fps",      note: "Нужен очень быстрый канал, ~40 Мбит/с", width: 3840, height: 2160, fps: 60, bitrate: 40000000, hint: "motion" },
    { id: "source",   label: "Оригинал (Source)", note: "Родное разрешение экрана, 60 fps, до ~30 Мбит/с", width: null, height: null, fps: 60, bitrate: 30000000, hint: "motion" }
];

let screenInboxUnsubscribe = null;
let activeScreenShare = null;     // текущая трансляция (я стример или зритель), максимум одна
let pendingScreenOffer = null;    // входящее приглашение, пока зритель не ответил
let pendingScreenOfferTimer = null;
let selectedScreenPresetId = "1080p60";
let screenShareTarget = null;     // { chatId, otherUserId, name } на момент открытия окна выбора
let startingScreenShare = false;

function isScreenShareSupported() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function" && window.RTCPeerConnection);
}

function startScreenInbox(myUserId) {
    if (screenInboxUnsubscribe) return;
    screenInboxUnsubscribe = KabanAPI.subscribeToScreenInbox(myUserId, {
        onOffer: (payload) => handleIncomingScreenOffer(payload)
    });
}

function stopScreenInbox() {
    if (screenInboxUnsubscribe) { screenInboxUnsubscribe(); screenInboxUnsubscribe = null; }
}

// Кнопка в шапке — только там, где трансляция имеет смысл: настоящий личный
// чат с живым человеком, не секретный, и браузер умеет захват экрана
// (на телефонах getDisplayMedia обычно нет).
function syncScreenShareButton(visible) {
    const button = document.getElementById("header-screen-button");
    if (button) button.hidden = !(visible && isScreenShareSupported() && !currentChatIsSecret);
}

function formatMbps(bitsPerSecond) {
    return (bitsPerSecond / 1e6).toFixed(bitsPerSecond >= 10e6 ? 1 : 2).replace(/\.?0+$/, "") + " Мбит/с";
}

function openScreenShareDialog() {

    closeContactPopover();

    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED || !currentChatId) {
        toast("Трансляция доступна только в настоящих чатах");
        return;
    }
    const isGroup = currentChatType === "group";
    if (!isGroup && !currentOtherUserId) {
        toast("Нельзя транслировать в этом чате");
        return;
    }
    if (currentChatIsSecret) {
        toast("В секретных чатах недоступно");
        return;
    }
    if (!isScreenShareSupported()) {
        toast("Трансляция экрана недоступна в этом браузере — нужен компьютер (Chrome/Edge/Firefox)");
        return;
    }
    if (activeScreenShare || pendingScreenOffer || startingScreenShare) {
        toast("Трансляция уже идёт");
        return;
    }

    // Получатели: в личном чате — собеседник, в группе — все участники кроме
    // меня и ботов (каждому уйдёт своё приглашение; кто не в сети — его не
    // увидит, приглашение не хранится).
    let recipients;
    if (isGroup) {
        recipients = [...currentChatMembersById.entries()]
            .filter(([userId, member]) => userId !== myRealUserId && !member?.is_bot)
            .map(([userId, member]) => ({ id: userId, name: member?.display_name || "Участник" }));
        if (!recipients.length) {
            toast("В группе некому смотреть трансляцию");
            return;
        }
    } else {
        recipients = [{ id: currentOtherUserId, name: currentChatTitle || "Собеседник" }];
    }

    screenShareTarget = { chatId: currentChatId, isGroup, title: currentChatTitle || "", recipients };

    const presetsEl = document.getElementById("screen-presets");
    presetsEl.innerHTML = SCREEN_PRESETS.map((preset) => `
        <label class="screen-preset${preset.id === selectedScreenPresetId ? " selected" : ""}">
            <input type="radio" name="screen-preset" value="${preset.id}"${preset.id === selectedScreenPresetId ? " checked" : ""} onchange="selectScreenPreset('${preset.id}')">
            <span class="screen-preset-label">${escapeHTML(preset.label)}</span>
            <span class="screen-preset-note">${escapeHTML(preset.note)}</span>
        </label>
    `).join("");

    const backdrop = document.getElementById("screen-share-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function selectScreenPreset(presetId) {
    selectedScreenPresetId = presetId;
    document.querySelectorAll("#screen-presets .screen-preset").forEach((el) => {
        el.classList.toggle("selected", el.querySelector("input").value === presetId);
    });
}

function closeScreenShareDialog() {
    const backdrop = document.getElementById("screen-share-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function closeScreenShareDialogFromBackdrop(event) {
    if (event.target === event.currentTarget) closeScreenShareDialog();
}

// Предпочтительные видеокодеки: для 60 fps и 1440p+ — H.264 первым (почти везде
// аппаратное кодирование видеокартой, не грузит процессор в игре), для
// остальных — VP9 (лучше сжимает чёткий текст/интерфейс при том же битрейте).
// Список только ПЕРЕУПОРЯДОЧИВАЕТСЯ (ничего не удаляется) — если у зрителя
// нужного кодека нет, согласование само выберет общий.
function preferVideoCodecs(transceiver, preset) {
    try {
        const capabilities = RTCRtpSender.getCapabilities("video");
        if (!capabilities || !transceiver.setCodecPreferences) return;
        const h264First = preset.fps >= 60 || (preset.height || 0) >= 1440 || preset.id === "source";
        const rank = (codec) => {
            const mime = codec.mimeType.toLowerCase();
            if (mime.includes("h264")) return h264First ? 0 : 2;
            if (mime.includes("vp9")) return h264First ? 1 : 0;
            if (mime.includes("av1")) return 3;
            if (mime.includes("vp8")) return 4;
            return 9; // rtx/red/ulpfec — в конец, но остаются
        };
        const sorted = [...capabilities.codecs].sort((a, b) => rank(a) - rank(b));
        transceiver.setCodecPreferences(sorted);
    } catch (error) {
        console.warn("Не удалось задать приоритет кодеков", error);
    }
}

// Chrome по умолчанию наращивает битрейт медленно (десятки секунд до потолка) —
// стартовый/минимальный/максимальный битрейт кодека передаём через fmtp
// x-google-*-bitrate; их читает ОТПРАВИТЕЛЬ из SDP собеседника, поэтому
// вызывается зрителем на его answer (см. acceptScreenShare).
function addVideoBitrateHints(sdp, maxBitrate) {

    const maxKbps = Math.round(maxBitrate / 1000);
    const hints = `x-google-min-bitrate=${Math.round(maxKbps * 0.3)};x-google-start-bitrate=${Math.round(maxKbps * 0.6)};x-google-max-bitrate=${maxKbps}`;
    const sections = sdp.split(/\r?\nm=/);

    return sections.map((section, index) => {
        const text = index === 0 ? section : "m=" + section;
        if (!text.startsWith("m=video")) return text;

        const lines = text.split(/\r?\n/);
        const mediaPayloads = [];
        lines.forEach((line) => {
            const match = line.match(/^a=rtpmap:(\d+) ([A-Za-z0-9-]+)\//);
            if (match && !/^(rtx|red|ulpfec|flexfec-03)$/i.test(match[2])) mediaPayloads.push(match[1]);
        });

        const withFmtp = new Set();
        const patched = lines.map((line) => {
            const match = line.match(/^a=fmtp:(\d+) (.*)$/);
            if (match && mediaPayloads.includes(match[1])) {
                withFmtp.add(match[1]);
                return `${line};${hints}`;
            }
            return line;
        });

        const result = [];
        patched.forEach((line) => {
            result.push(line);
            const match = line.match(/^a=rtpmap:(\d+) /);
            if (match && mediaPayloads.includes(match[1]) && !withFmtp.has(match[1])) {
                result.push(`a=fmtp:${match[1]} ${hints}`);
            }
        });
        return result.join("\r\n");
    }).join("\r\n");

}

// Максимум одновременных зрителей одной трансляции: у каждого зрителя СВОЁ
// соединение, и видео кодируется заново для каждого (нагрузка на процессор/
// видеокарту и исходящий канал стримера растёт линейно) — для компании в
// несколько человек этого хватает с запасом.
const SCREEN_MAX_VIEWERS = 4;

// Одно соединение стример → зритель. Для личного чата сессия одна, в группе —
// по одной на каждого приглашённого. Возвращает сессию (или кидает ошибку —
// вызывающий код убирает её и идёт дальше к остальным).
async function addScreenViewerSession(share, recipient, me) {

    const sessionId = crypto.randomUUID();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const session = {
        sessionId, viewerId: recipient.id, viewerName: recipient.name, pc, channel: null,
        remoteSet: false, pendingCandidates: [], connectedAt: null, answerTimer: null, lastStats: null
    };
    share.sessions.set(sessionId, session);

    try {

        share.stream.getTracks().forEach((track) => pc.addTrack(track, share.stream));
        await configureScreenSender(pc, share.stream.getVideoTracks()[0], share.preset);

        pc.onicecandidate = (event) => {
            if (event.candidate) session.channel?.sendIceCandidate({ candidate: event.candidate });
        };
        wireScreenConnectionState(pc, sessionId);

        session.channel = KabanAPI.joinScreenChannel(sessionId, {
            onAnswer: async (payload) => {
                if (activeScreenShare !== share || !share.sessions.has(sessionId)) return;
                clearTimeout(session.answerTimer);
                const answered = [...share.sessions.values()].filter((s) => s !== session && s.remoteSet).length;
                if (answered >= SCREEN_MAX_VIEWERS) {
                    removeScreenSession(share, sessionId, { reason: "full" });
                    return;
                }
                try {
                    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
                    session.remoteSet = true;
                    await flushPendingScreenCandidates(session);
                } catch (error) {
                    console.warn("Не удалось применить ответ зрителя", error);
                    removeScreenSession(share, sessionId, { reason: "failed", toastText: "Не удалось установить соединение" });
                }
            },
            onIceCandidate: (payload) => queueOrAddScreenCandidate(sessionId, payload.candidate),
            onEnd: (payload) => {
                if (activeScreenShare !== share || !share.sessions.has(sessionId)) return;
                const reason = payload?.reason;
                const name = recipient.name || "Собеседник";
                const toastText = share.isGroup
                    ? (reason === "left" || reason === "peer-ended" ? `${name} вышел(а) из трансляции` : null)
                    : (reason === "busy" ? "Собеседник уже смотрит другую трансляцию"
                        : reason === "declined" ? "Собеседник отклонил трансляцию"
                        : "Собеседник вышел из трансляции");
                removeScreenSession(share, sessionId, { notify: false, toastText });
            }
        });
        await session.channel.ready;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await KabanAPI.sendScreenOffer(recipient.id, {
            streamId: share.streamId,
            sessionId,
            sdp: offer,
            hostId: me.id,
            hostName: cachedMyProfile?.display_name || "Пользователь",
            hostAvatarUrl: cachedMyProfile?.avatar_url || null,
            preset: { id: share.preset.id, label: share.preset.label, bitrate: share.preset.bitrate, fps: share.preset.fps },
            hasAudio: share.stream.getAudioTracks().length > 0,
            isGroup: share.isGroup,
            chatTitle: share.isGroup ? share.chatTitle : null
        });

        // Не ответили за минуту — убираем только эту сессию, остальные живут.
        session.answerTimer = setTimeout(() => {
            if (activeScreenShare === share && share.sessions.has(sessionId) && !session.connectedAt) {
                removeScreenSession(share, sessionId, {
                    reason: "no-answer",
                    toastText: share.isGroup ? null : "Собеседник не ответил на трансляцию"
                });
            }
        }, 60000);

        return session;

    } catch (error) {
        closeScreenSession(session, false);
        share.sessions.delete(sessionId);
        throw error;
    }

}

// Потолок битрейта/кадров и приоритет "плавность важнее разрешения" для
// игровых пресетов — иначе при нехватке канала WebRTC роняет fps, а не
// разрешение, что для игры хуже.
async function configureScreenSender(pc, videoTrack, preset) {

    const transceiver = pc.getTransceivers().find((t) => t.sender.track === videoTrack);
    if (!transceiver) return;
    preferVideoCodecs(transceiver, preset);

    try {
        const sender = transceiver.sender;
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = preset.bitrate;
        params.encodings[0].maxFramerate = preset.fps;
        params.encodings[0].scaleResolutionDownBy = 1;
        params.degradationPreference = preset.hint === "motion" ? "maintain-framerate" : "maintain-resolution";
        await sender.setParameters(params);
    } catch (error) {
        console.warn("Не удалось задать параметры кодирования", error);
    }

}

async function startScreenShare() {

    if (!screenShareTarget || activeScreenShare || startingScreenShare) return;
    startingScreenShare = true;

    const target = screenShareTarget;
    const preset = SCREEN_PRESETS.find((item) => item.id === selectedScreenPresetId) || SCREEN_PRESETS[2];
    const wantAudio = !!document.getElementById("screen-share-audio")?.checked;
    closeScreenShareDialog();

    // getDisplayMedia показывает системный выбор "что транслировать" — это
    // и есть явное согласие пользователя; отмена даёт NotAllowedError.
    let stream;
    try {
        const video = { frameRate: { ideal: preset.fps, max: preset.fps } };
        if (preset.width) {
            video.width = { ideal: preset.width };
            video.height = { ideal: preset.height };
        }
        stream = await navigator.mediaDevices.getDisplayMedia({
            video,
            audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } : false,
            systemAudio: "include",
            surfaceSwitching: "include",
            selfBrowserSurface: "exclude"
        });
    } catch (error) {
        startingScreenShare = false;
        if (error?.name !== "NotAllowedError" && error?.name !== "AbortError") {
            toast("Не удалось начать трансляцию: " + (error?.message || error));
        }
        return;
    }

    const videoTrack = stream.getVideoTracks()[0];
    try { videoTrack.contentHint = preset.hint; } catch {}

    let me;
    try {
        me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");
    } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        startingScreenShare = false;
        toast("Не удалось начать трансляцию");
        return;
    }

    const share = {
        role: "host", streamId: crypto.randomUUID(), stream, preset,
        chatId: target.chatId, isGroup: target.isGroup, chatTitle: target.title,
        sessions: new Map(), statsTimer: null
    };
    activeScreenShare = share;

    // Пользователь нажал "Прекратить доступ" в системной плашке браузера.
    videoTrack.addEventListener("ended", () => {
        if (activeScreenShare === share) stopScreenShare("ended-by-user");
    });

    // Каждому приглашённому — своё соединение; сбой одного (нет в сети, не
    // подписан) не должен мешать остальным.
    const results = await Promise.allSettled(target.recipients.map((recipient) => addScreenViewerSession(share, recipient, me)));
    if (activeScreenShare !== share) { startingScreenShare = false; return; } // успели остановить

    const started = results.filter((r) => r.status === "fulfilled").length;
    if (!started) {
        console.warn("Не удалось начать трансляцию", results.map((r) => r.reason));
        toast("Не удалось начать трансляцию");
        stopScreenShare("failed", { notify: false });
        return;
    }

    startingScreenShare = false;
    updateScreenHostBar(share);
    document.getElementById("screen-host-bar").hidden = false;

}

function queueOrAddScreenCandidate(sessionId, candidateInit) {
    const share = activeScreenShare;
    if (!share || !candidateInit) return;
    const session = share.role === "host" ? share.sessions.get(sessionId) : (share.sessionId === sessionId ? share : null);
    if (!session) return;
    if (!session.remoteSet) {
        session.pendingCandidates.push(candidateInit);
        return;
    }
    session.pc.addIceCandidate(new RTCIceCandidate(candidateInit)).catch(() => {});
}

async function flushPendingScreenCandidates(session) {
    const queued = session.pendingCandidates.splice(0);
    for (const candidate of queued) {
        try { await session.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
}

function findScreenSession(share, sessionId) {
    if (!share) return null;
    return share.role === "host" ? (share.sessions.get(sessionId) || null) : (share.sessionId === sessionId ? share : null);
}

function wireScreenConnectionState(pc, sessionId) {

    let graceTimer = null;

    pc.onconnectionstatechange = () => {
        const share = activeScreenShare;
        const session = findScreenSession(share, sessionId);
        if (!session) return;

        if (pc.connectionState === "connected") {
            clearTimeout(graceTimer);
            if (!session.connectedAt) {
                session.connectedAt = Date.now();
                clearTimeout(session.answerTimer);
                if (share.role === "host") updateScreenHostBar(share);
                else document.getElementById("screen-viewer-waiting").hidden = true;
                startScreenStatsLoop(share);
            }
        } else if (pc.connectionState === "failed") {
            clearTimeout(graceTimer);
            handleScreenConnectionLost(share, sessionId);
        } else if (pc.connectionState === "disconnected") {
            // Короткий ICE-блик самоисправляется — даём 6 секунд, как и у звонков.
            clearTimeout(graceTimer);
            graceTimer = setTimeout(() => {
                if (findScreenSession(activeScreenShare, sessionId) && pc.connectionState !== "connected") {
                    handleScreenConnectionLost(activeScreenShare, sessionId);
                }
            }, 6000);
        }
    };

}

function handleScreenConnectionLost(share, sessionId) {
    if (share.role === "host") {
        removeScreenSession(share, sessionId, {
            reason: "failed",
            toastText: share.isGroup ? null : "Соединение трансляции прервалось"
        });
    } else {
        toast("Соединение трансляции прервалось");
        stopScreenShare("failed");
    }
}

// Читает реальные показатели одного соединения и считает его битрейт по
// разнице байт с прошлого вызова.
async function readScreenStats(session, role) {

    let stats;
    try { stats = await session.pc.getStats(); } catch { return null; }

    let rtp = null;
    let rtt = null;
    stats.forEach((report) => {
        if (role === "host" && report.type === "outbound-rtp" && report.kind === "video") rtp = report;
        if (role === "viewer" && report.type === "inbound-rtp" && report.kind === "video") rtp = report;
        if (report.type === "candidate-pair" && (report.nominated || report.selected) && report.currentRoundTripTime != null) {
            rtt = report.currentRoundTripTime;
        }
    });
    if (!rtp) return null;

    const bytes = role === "host" ? rtp.bytesSent : rtp.bytesReceived;
    const now = performance.now();
    let bitrate = null;
    if (session.lastStats && now > session.lastStats.time) {
        bitrate = ((bytes - session.lastStats.bytes) * 8) / ((now - session.lastStats.time) / 1000);
    }
    session.lastStats = { bytes, time: now };

    return {
        width: rtp.frameWidth, height: rtp.frameHeight, fps: rtp.framesPerSecond, bitrate,
        codec: rtp.codecId ? (stats.get(rtp.codecId)?.mimeType?.replace("video/", "") || null) : null,
        rtt,
        lossPercent: (role === "viewer" && rtp.packetsLost > 0 && rtp.packetsReceived)
            ? (rtp.packetsLost / (rtp.packetsLost + rtp.packetsReceived)) * 100 : 0,
        limit: rtp.qualityLimitationReason
    };

}

// Раз в секунду показываем: разрешение, кадры, битрейт, кодек — и ПРИЧИНУ
// ограничения качества (сеть или процессор), чтобы стример видел, почему
// картинка не "Source", а не гадал. В группе битрейт суммируется по всем
// зрителям — это реальная нагрузка на исходящий канал стримера.
function startScreenStatsLoop(share) {

    if (share.statsTimer) return;

    share.statsTimer = setInterval(async () => {

        if (activeScreenShare !== share) { clearInterval(share.statsTimer); return; }

        const sessions = share.role === "host"
            ? [...share.sessions.values()].filter((s) => s.connectedAt)
            : (share.connectedAt ? [share] : []);
        if (!sessions.length) return;

        const infos = (await Promise.all(sessions.map((s) => readScreenStats(s, share.role)))).filter(Boolean);
        if (!infos.length || activeScreenShare !== share) return;

        const first = infos[0];
        const totalBitrate = infos.reduce((sum, info) => sum + (info.bitrate > 0 ? info.bitrate : 0), 0);
        const rtt = Math.max(...infos.map((info) => info.rtt ?? 0));
        const limited = infos.map((info) => info.limit).find((limit) => limit && limit !== "none");

        const parts = [];
        if (first.width && first.height) parts.push(`${first.width}×${first.height}`);
        if (first.fps != null) parts.push(`${Math.round(first.fps)} fps`);
        if (totalBitrate > 0) parts.push(formatMbps(totalBitrate) + (share.role === "host" && infos.length > 1 ? " всего" : ""));
        if (first.codec) parts.push(first.codec);
        if (share.role === "viewer" && first.lossPercent > 0) parts.push(`потери ${first.lossPercent.toFixed(1)}%`);
        parts.push(`${Math.round(rtt * 1000)} мс`);
        if (share.role === "host" && limited) {
            parts.push(limited === "bandwidth" ? "⚠ ограничено сетью" : limited === "cpu" ? "⚠ ограничено процессором" : "⚠ ограничено");
        }

        const target = document.getElementById(share.role === "host" ? "screen-host-stats" : "screen-viewer-stats");
        if (target) target.textContent = parts.join(" · ");

    }, 1000);

}

function updateScreenHostBar(share) {
    const connected = [...share.sessions.values()].filter((s) => s.connectedAt);
    const text = !connected.length
        ? (share.isGroup ? "Ждём зрителей…" : "Ждём подключения зрителя…")
        : (share.isGroup ? `В эфире · зрителей: ${connected.length}` : `В эфире · ${connected[0].viewerName}`);
    document.getElementById("screen-host-text").textContent = text;
    if (!connected.length) document.getElementById("screen-host-stats").textContent = "";
}

function closeScreenSession(session, notify, reason = "stopped") {
    clearTimeout(session.answerTimer);
    if (notify) Promise.resolve(session.channel?.sendEnd({ reason })).catch(() => {});
    // leave после небольшой паузы: сообщение end должно успеть уйти до отписки.
    const channel = session.channel;
    setTimeout(() => { try { channel?.leave(); } catch {} }, 400);
    try { session.pc?.close(); } catch {}
}

// Убрать одного зрителя (вышел, не ответил, оборвалось соединение), не трогая
// остальных. Когда зрителей не осталось совсем — эфир завершается.
function removeScreenSession(share, sessionId, { notify = true, reason = "stopped", toastText = null } = {}) {

    const session = share.sessions.get(sessionId);
    if (!session) return;
    share.sessions.delete(sessionId);
    closeScreenSession(session, notify, reason);

    if (toastText) toast(toastText);

    if (!share.sessions.size) {
        if (share.isGroup && !toastText) toast("Трансляция завершена — зрителей не осталось");
        stopScreenShare("no-viewers", { notify: false });
    } else {
        updateScreenHostBar(share);
    }

}

function stopScreenShare(reason = "stopped", { notify = true } = {}) {

    const share = activeScreenShare;
    if (!share) return;
    activeScreenShare = null;

    clearInterval(share.statsTimer);

    if (share.role === "host") {
        share.sessions.forEach((session) => closeScreenSession(session, notify, reason));
        share.sessions.clear();
        share.stream.getTracks().forEach((track) => track.stop());
    } else {
        clearTimeout(share.answerTimer);
        closeScreenSession(share, notify, reason);
    }

    document.getElementById("screen-host-bar").hidden = true;
    hideScreenViewer();
    startingScreenShare = false;

}

// ---- сторона зрителя ----

function handleIncomingScreenOffer(payload) {

    if (!payload?.streamId || !payload?.sdp) return;
    const sessionId = payload.sessionId || payload.streamId;

    // Уже смотрю/транслирую/есть неотвеченное приглашение — отвечаем "занят".
    if (activeScreenShare || pendingScreenOffer || startingScreenShare) {
        const busy = KabanAPI.joinScreenChannel(sessionId, {});
        busy.ready.then(() => busy.sendEnd({ reason: "busy" })).catch(() => {}).finally(() => { try { busy.leave(); } catch {} });
        return;
    }

    pendingScreenOffer = { ...payload, sessionId };
    const preset = payload.preset || {};
    const hostName = payload.hostName || "Собеседник";
    document.getElementById("screen-incoming-text").textContent = payload.isGroup && payload.chatTitle
        ? `${hostName} транслирует экран в «${payload.chatTitle}»` + (preset.label ? ` · ${preset.label}` : "")
        : `${hostName} транслирует экран` + (preset.label ? ` · ${preset.label}` : "");
    document.getElementById("screen-incoming").hidden = false;

    // Приглашение живёт минуту — потом стример всё равно уберёт эту сессию.
    clearTimeout(pendingScreenOfferTimer);
    pendingScreenOfferTimer = setTimeout(() => declineScreenShare(true), 60000);

}

function hideScreenIncoming() {
    clearTimeout(pendingScreenOfferTimer);
    pendingScreenOfferTimer = null;
    document.getElementById("screen-incoming").hidden = true;
}

function declineScreenShare(silent = false) {

    const offer = pendingScreenOffer;
    if (!offer) return;
    pendingScreenOffer = null;
    hideScreenIncoming();

    const channel = KabanAPI.joinScreenChannel(offer.sessionId, {});
    channel.ready.then(() => channel.sendEnd({ reason: silent ? "timeout" : "declined" }))
        .catch(() => {})
        .finally(() => { try { channel.leave(); } catch {} });

}

async function acceptScreenShare() {

    const offer = pendingScreenOffer;
    if (!offer || activeScreenShare) return;
    pendingScreenOffer = null;
    hideScreenIncoming();

    const sessionId = offer.sessionId;
    const preset = offer.preset || {};
    let pc = null;
    let channelHandle = null;

    try {

        pc = new RTCPeerConnection(RTC_CONFIG);

        const share = {
            role: "viewer", streamId: offer.streamId, sessionId, pc, preset,
            peerId: offer.hostId, peerName: offer.hostName || "Собеседник",
            pendingCandidates: [], remoteSet: false, lastStats: null, connectedAt: null
        };
        activeScreenShare = share;

        const videoEl = document.getElementById("screen-viewer-video");
        pc.ontrack = (event) => {
            if (activeScreenShare !== share) return;
            if (videoEl.srcObject !== event.streams[0]) videoEl.srcObject = event.streams[0];
            // Минимальная буферизация на приёме — меньше задержка картинки;
            // 150 мс — разумный запас от микрозаиканий. Не везде поддерживается.
            try { event.receiver.jitterBufferTarget = 150; } catch {}
            try { if ("playoutDelayHint" in event.receiver) event.receiver.playoutDelayHint = 0.15; } catch {}
        };
        pc.onicecandidate = (event) => {
            if (event.candidate && activeScreenShare === share) {
                share.channel?.sendIceCandidate({ candidate: event.candidate });
            }
        };
        wireScreenConnectionState(pc, sessionId);

        channelHandle = KabanAPI.joinScreenChannel(sessionId, {
            onIceCandidate: (payload) => queueOrAddScreenCandidate(sessionId, payload.candidate),
            onEnd: (payload) => {
                if (activeScreenShare !== share) return;
                toast(payload?.reason === "full" ? "В трансляции уже максимум зрителей" : "Трансляция завершена");
                stopScreenShare("peer-ended", { notify: false });
            }
        });
        share.channel = channelHandle;

        showScreenViewer(share.peerName);
        await channelHandle.ready;

        await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
        share.remoteSet = true;
        await flushPendingScreenCandidates(share);

        const answer = await pc.createAnswer();
        const hintedSdp = preset.bitrate ? addVideoBitrateHints(answer.sdp, preset.bitrate) : answer.sdp;
        await pc.setLocalDescription({ type: answer.type, sdp: hintedSdp });
        await channelHandle.sendAnswer({ sdp: { type: answer.type, sdp: hintedSdp } });

    } catch (error) {
        console.warn("Не удалось подключиться к трансляции", error);
        toast("Не удалось подключиться к трансляции");
        if (activeScreenShare?.sessionId === sessionId) {
            stopScreenShare("failed");
        } else {
            try { pc?.close(); } catch {}
            try { channelHandle?.leave(); } catch {}
            hideScreenViewer();
        }
    }

}

function showScreenViewer(hostName) {
    const viewer = document.getElementById("screen-viewer");
    document.getElementById("screen-viewer-title").textContent = `Трансляция · ${hostName}`;
    document.getElementById("screen-viewer-stats").textContent = "";
    document.getElementById("screen-viewer-waiting").hidden = false;
    document.getElementById("screen-viewer-mute").setAttribute("aria-pressed", "false");
    document.getElementById("screen-viewer-video").muted = false;
    viewer.hidden = false;
    viewer.setAttribute("aria-hidden", "false");
}

function hideScreenViewer() {
    const viewer = document.getElementById("screen-viewer");
    if (!viewer || viewer.hidden) return;
    if (document.fullscreenElement === viewer) document.exitFullscreen?.().catch(() => {});
    document.getElementById("screen-viewer-video").srcObject = null;
    viewer.hidden = true;
    viewer.setAttribute("aria-hidden", "true");
}

function leaveScreenShare() {
    if (activeScreenShare?.role === "viewer") stopScreenShare("left");
    else hideScreenViewer();
}

function toggleScreenViewerMute() {
    const video = document.getElementById("screen-viewer-video");
    video.muted = !video.muted;
    document.getElementById("screen-viewer-mute").setAttribute("aria-pressed", String(video.muted));
}

function toggleScreenViewerStats() {
    const button = document.getElementById("screen-viewer-stats-toggle");
    const show = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(show));
    document.getElementById("screen-viewer-stats").hidden = !show;
}

function toggleScreenViewerFullscreen() {
    const viewer = document.getElementById("screen-viewer");
    if (document.fullscreenElement) document.exitFullscreen?.();
    else viewer.requestFullscreen?.().catch(() => {});
}

// Закрыли вкладку/приложение во время эфира — предупреждаем собеседника сразу,
// а не заставляем его ждать таймаута ICE.
window.addEventListener("pagehide", () => {
    if (activeScreenShare) stopScreenShare("closed");
});

/* ============================================================================
   ГРУППОВЫЕ ЗВОНКИ (аудио/видео) — до 5 участников, соединение "каждый с
   каждым" (mesh): у каждого с каждым другим своё RTCPeerConnection, медиа идёт
   напрямую, через Supabase проходит только сигнализация. Для компании в
   несколько человек этого хватает; нагрузка на канал/процессор растёт с
   числом участников (каждый шлёт видео N-1 раз).

   Комната звонка — один Realtime-канал на чат (gcall:<chatId>):
     • presence = кто в звонке (по нему же остальные участники группы видят
       баннер "Идёт звонок — присоединиться");
     • broadcast "signal" = SDP/ICE/состояние (микрофон/камера) между парами.
   Чтобы два участника не отправили друг другу offer одновременно, offer всегда
   шлёт тот, кто вошёл в комнату ПОЗЖЕ.

   В каждое соединение сразу закладываются и аудио-, и видео-трансивер:
   включить/выключить камеру посреди звонка — это replaceTrack, без новых
   переговоров. Отдельно от личных звонков (activeCall) — состояние и каналы
   свои, взаимно исключают друг друга.
   ========================================================================= */

const GCALL_MAX_PARTICIPANTS = 5;
const GCALL_VIDEO_BITRATE = 1600000;

let groupCallInboxUnsubscribe = null;
let activeGroupCall = null;
let startingGroupCall = false;
let pendingGroupCallInvite = null;
let pendingGroupCallInviteTimer = null;
let groupCallWatcherUnsubscribe = null;
let groupCallWatcherChatId = null;
let groupCallWatcherCount = 0;

function startGroupCallInbox(myUserId) {
    if (groupCallInboxUnsubscribe) return;
    groupCallInboxUnsubscribe = KabanAPI.subscribeToGroupCallInbox(myUserId, {
        onInvite: (payload) => handleIncomingGroupCallInvite(payload)
    });
}

function stopGroupCallInbox() {
    if (groupCallInboxUnsubscribe) { groupCallInboxUnsubscribe(); groupCallInboxUnsubscribe = null; }
}

// ---- баннер "Идёт звонок" в открытой группе ----

function watchGroupCallBanner(chatId) {

    if (groupCallWatcherChatId === chatId && groupCallWatcherUnsubscribe) return;
    stopGroupCallBanner();
    if (activeGroupCall) return; // я уже в звонке — баннер не нужен

    groupCallWatcherChatId = chatId;
    groupCallWatcherUnsubscribe = KabanAPI.watchGroupCallRoom(chatId, (participants) => {
        if (groupCallWatcherChatId !== chatId) return;
        groupCallWatcherCount = participants.size;
        renderGroupCallBanner(participants.size);
    });

}

function stopGroupCallBanner() {
    if (groupCallWatcherUnsubscribe) { groupCallWatcherUnsubscribe(); groupCallWatcherUnsubscribe = null; }
    groupCallWatcherChatId = null;
    groupCallWatcherCount = 0;
    renderGroupCallBanner(0);
}

function renderGroupCallBanner(count) {
    const banner = document.getElementById("gcall-banner");
    if (!banner) return;
    banner.hidden = !(count > 0) || !!activeGroupCall;
    if (count > 0) {
        document.getElementById("gcall-banner-text").textContent =
            `Идёт групповой звонок · ${count} ${pluralRu(count, "участник", "участника", "участников")}`;
    }
}

// ---- вход в звонок ----

// Кнопка звонка в шапке группы: если звонок уже идёт — присоединяемся к нему,
// иначе начинаем новый и зовём остальных.
function startOrJoinGroupCall(kind) {
    return joinGroupCall(currentChatId, {
        withVideo: kind === "video",
        title: currentChatTitle || "Группа",
        announce: groupCallWatcherCount === 0
    });
}

function joinOngoingGroupCall(kind) {
    return joinGroupCall(currentChatId, { withVideo: kind === "video", title: currentChatTitle || "Группа", announce: false });
}

async function joinGroupCall(chatId, { withVideo = false, title = "Группа", announce = false, invited = false } = {}) {

    if (!chatId) return;
    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED) {
        toast("Звонки доступны только в настоящих чатах");
        return;
    }
    if (activeGroupCall || startingGroupCall) {
        toast("Вы уже в групповом звонке");
        return;
    }
    if (activeCall || pendingIncomingCall) {
        toast("У вас уже есть активный звонок");
        return;
    }
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
        toast("Звонки не поддерживаются в этом браузере");
        return;
    }

    startingGroupCall = true;
    closeContactPopover();

    let stream = null;
    let cameraFailed = false;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } : false
        });
    } catch (error) {
        if (withVideo) {
            // Камеры нет/запрещена — не отказываемся от звонка совсем, идём с одним звуком.
            cameraFailed = true;
            try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); } catch {}
        }
    }
    if (!stream) {
        startingGroupCall = false;
        toast("Не удалось получить доступ к микрофону");
        return;
    }
    if (cameraFailed) toast("Камера недоступна — звонок только со звуком");

    let me;
    try {
        const user = await KabanAuth.getCurrentUser();
        if (!user) throw new Error("Нужно войти в аккаунт");
        me = { id: user.id, name: cachedMyProfile?.display_name || "Я", avatar: cachedMyProfile?.avatar_url || null };
    } catch (error) {
        stream.getTracks().forEach((track) => track.stop());
        startingGroupCall = false;
        toast("Не удалось начать звонок");
        return;
    }

    // Тот же топик, что и у баннера-наблюдателя — две подписки на один канал
    // сразу не держим: на время звонка наблюдателя снимаем.
    stopGroupCallBanner();

    const call = {
        chatId, title, me,
        localStream: stream,
        audioTrack: stream.getAudioTracks()[0] || null,
        videoTrack: stream.getVideoTracks()[0] || null,
        peers: new Map(), room: null, tiles: new Map(),
        participants: new Map(), syncedOnce: false,
        joinedAt: Date.now(), startedAt: null, timer: null,
        micOn: true, ended: false
    };
    activeGroupCall = call;
    showGroupCallUI(call);

    try {

        call.room = KabanAPI.joinGroupCallRoom(chatId, me.id, {
            onSignal: (payload) => handleGroupCallSignal(call, payload),
            onParticipants: (participants) => {
                call.syncedOnce = true;
                call.participants = participants;
                reconcileGroupCallPeers(call);
            }
        });
        await call.room.ready;

        // Первый presence-sync приходит чуть позже подписки — дожидаемся,
        // чтобы понять, пуста ли комната (тогда я начинаю звонок и зову остальных).
        const syncDeadline = Date.now() + 4000;
        while (!call.syncedOnce && Date.now() < syncDeadline) await new Promise((r) => setTimeout(r, 100));

        let existing = call.room.getParticipants();
        existing.delete(me.id);

        // Приглашённый пришёл по звонку, который идёт: список присутствующих
        // может дойти с опозданием (особенно при медленной сети) — комнату
        // считаем пустой ("звонок завершён") только если и через ~10 секунд в
        // ней так никого и не появилось, а не по первому пустому ответу.
        if (invited && existing.size === 0) {
            const waitUntil = Date.now() + 10000;
            while (existing.size === 0 && Date.now() < waitUntil && activeGroupCall === call) {
                await new Promise((r) => setTimeout(r, 300));
                existing = call.room.getParticipants();
                existing.delete(me.id);
            }
            if (activeGroupCall !== call) return; // успели выйти сами
        }

        if (existing.size >= GCALL_MAX_PARTICIPANTS - 1) {
            toast(`В звонке уже максимум участников (${GCALL_MAX_PARTICIPANTS})`);
            leaveGroupCall("full");
            return;
        }
        if (invited && existing.size === 0) {
            toast("Групповой звонок уже завершён");
            leaveGroupCall("ended");
            return;
        }

        await call.room.track({
            userId: me.id, name: me.name, avatar: me.avatar,
            joinedAt: call.joinedAt, withVideo: !!call.videoTrack
        });

        if (announce && existing.size === 0) sendGroupCallInvites(call, withVideo);

    } catch (error) {
        console.warn("Не удалось войти в групповой звонок", error);
        toast("Не удалось войти в групповой звонок");
        leaveGroupCall("failed");
        startingGroupCall = false;
        return;
    }

    startingGroupCall = false;

}

async function sendGroupCallInvites(call, withVideo) {

    let members = [];
    try {
        if (currentChatId === call.chatId && currentChatMembersById.size) {
            members = [...currentChatMembersById.entries()].map(([userId, member]) => ({ id: userId, is_bot: member?.is_bot }));
        } else {
            const rows = await KabanAPI.getChatMembers(call.chatId);
            members = rows.map((row) => ({ id: row.user_id, is_bot: row.users?.is_bot }));
        }
    } catch (error) {
        console.warn("Не удалось получить участников для приглашения", error);
        return;
    }

    const payload = {
        chatId: call.chatId, chatTitle: call.title,
        fromId: call.me.id, fromName: call.me.name,
        withVideo, sentAt: Date.now()
    };
    members
        .filter((member) => member.id !== call.me.id && !member.is_bot)
        .forEach((member) => KabanAPI.sendGroupCallInvite(member.id, payload).catch(() => {}));

}

// ---- приглашение ----

function handleIncomingGroupCallInvite(payload) {

    if (!payload?.chatId || payload.fromId === myRealUserId) return;
    if (payload.sentAt && Date.now() - payload.sentAt > 60000) return; // устарело
    if (activeGroupCall || startingGroupCall || pendingGroupCallInvite || activeCall || pendingIncomingCall) return;

    pendingGroupCallInvite = payload;
    document.getElementById("gcall-incoming-text").textContent =
        `${payload.fromName || "Участник"} ${payload.withVideo ? "начал(а) групповой видеозвонок" : "звонит в группу"} «${payload.chatTitle || "Группа"}»`;
    document.getElementById("gcall-incoming").hidden = false;

    clearTimeout(pendingGroupCallInviteTimer);
    pendingGroupCallInviteTimer = setTimeout(declineGroupCallInvite, 45000);

}

function hideGroupCallIncoming() {
    clearTimeout(pendingGroupCallInviteTimer);
    pendingGroupCallInviteTimer = null;
    document.getElementById("gcall-incoming").hidden = true;
}

function declineGroupCallInvite() {
    pendingGroupCallInvite = null;
    hideGroupCallIncoming();
}

function acceptGroupCallInvite() {
    const invite = pendingGroupCallInvite;
    pendingGroupCallInvite = null;
    hideGroupCallIncoming();
    if (!invite) return;
    joinGroupCall(invite.chatId, { withVideo: !!invite.withVideo, title: invite.chatTitle || "Группа", invited: true });
}

// ---- соединения с участниками ----

// Кто шлёт offer: тот, кто вошёл в комнату позже (при равенстве — по userId),
// иначе оба одновременно отправили бы offer друг другу.
function iAmGroupCallInitiator(call, otherId, otherMeta) {
    const theirs = otherMeta?.joinedAt || 0;
    if (call.joinedAt !== theirs) return call.joinedAt > theirs;
    return call.me.id > otherId;
}

function reconcileGroupCallPeers(call) {

    if (activeGroupCall !== call || call.ended) return;

    const others = new Map(call.participants);
    others.delete(call.me.id);

    // Ушедших убираем.
    [...call.peers.keys()].forEach((userId) => {
        if (!others.has(userId)) removeGroupCallPeer(call, userId);
    });

    // Новых заводим; offer шлёт только "более поздний" из пары.
    others.forEach((meta, userId) => {
        let peer = call.peers.get(userId);
        if (!peer) {
            if (call.peers.size >= GCALL_MAX_PARTICIPANTS - 1) return;
            const initiator = iAmGroupCallInitiator(call, userId, meta);
            peer = createGroupCallPeer(call, userId, meta, initiator);
            if (initiator) startGroupCallOffer(call, peer);
        } else if (meta.name && peer.name !== meta.name) {
            peer.name = meta.name;
            updateGroupCallTile(call, peer);
        }
    });

    updateGroupCallHeader(call);

}

function limitGroupCallVideoSender(sender) {
    try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = GCALL_VIDEO_BITRATE;
        params.encodings[0].maxFramerate = 30;
        sender.setParameters(params).catch(() => {});
    } catch {}
}

// asInitiator=true — я шлю offer: заранее закладываем аудио- и видеотрансиверы
// (камеру потом включаем/выключаем через replaceTrack, без переговоров).
// asInitiator=false — я отвечаю на чужой offer: собственные трансиверы здесь
// НЕ создаём — после setRemoteDescription браузер сам заводит трансиверы под
// секции offer, и свои дорожки подключаем уже к ним (см.
// attachGroupCallLocalTracks). Раньше отвечающий создавал трансиверы заранее —
// они не сопоставлялись с секциями offer, и его звук/видео до собеседника не
// доходили вовсе (медиа шло только от того, кто отправил offer).
function createGroupCallPeer(call, userId, meta, asInitiator) {

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const remoteStream = new MediaStream();
    const peer = {
        userId, pc, remoteStream,
        name: meta?.name || "Участник", avatar: meta?.avatar || null,
        pendingCandidates: [], remoteSet: false, connected: false,
        mic: true, cam: false, videoSender: null, graceTimer: null
    };

    if (asInitiator) {
        pc.addTransceiver(call.audioTrack || "audio", { direction: "sendrecv", streams: [call.localStream] });
        const videoTransceiver = pc.addTransceiver(call.videoTrack || "video", { direction: "sendrecv", streams: [call.localStream] });
        peer.videoSender = videoTransceiver.sender;
        limitGroupCallVideoSender(peer.videoSender);
    }

    pc.ontrack = (event) => {
        remoteStream.addTrack(event.track);
        try { event.receiver.jitterBufferTarget = 100; } catch {}
        updateGroupCallTile(call, peer);
    };
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            call.room?.sendSignal({ to: userId, from: call.me.id, kind: "ice", data: event.candidate });
        }
    };
    pc.onconnectionstatechange = () => {
        if (activeGroupCall !== call || call.peers.get(userId) !== peer) return;
        if (pc.connectionState === "connected") {
            clearTimeout(peer.graceTimer);
            if (!peer.connected) {
                peer.connected = true;
                if (!call.startedAt) startGroupCallTimer(call);
                sendGroupCallState(call, userId); // сообщаем новому собеседнику, включены ли у меня микрофон/камера
                updateGroupCallTile(call, peer);
                updateGroupCallHeader(call);
            }
        } else if (pc.connectionState === "failed") {
            clearTimeout(peer.graceTimer);
            retryGroupCallPeer(call, userId);
        } else if (pc.connectionState === "disconnected") {
            clearTimeout(peer.graceTimer);
            peer.graceTimer = setTimeout(() => {
                if (activeGroupCall === call && call.peers.get(userId) === peer && pc.connectionState !== "connected") {
                    retryGroupCallPeer(call, userId);
                }
            }, 6000);
        }
    };

    call.peers.set(userId, peer);
    addGroupCallTile(call, peer);
    return peer;

}

// Соединение с участником оборвалось, а он всё ещё в комнате — пересоздаём
// (offer снова шлёт тот, кто по правилу выше "более поздний").
function retryGroupCallPeer(call, userId) {
    removeGroupCallPeer(call, userId);
    setTimeout(() => {
        if (activeGroupCall === call && !call.ended) {
            call.participants = call.room?.getParticipants() || call.participants;
            reconcileGroupCallPeers(call);
        }
    }, 1500);
}

async function startGroupCallOffer(call, peer) {
    try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        call.room.sendSignal({ to: peer.userId, from: call.me.id, kind: "offer", data: offer });
    } catch (error) {
        console.warn("Не удалось отправить offer участнику звонка", error);
    }
}

async function handleGroupCallSignal(call, message) {

    if (activeGroupCall !== call || call.ended || !message) return;
    if (message.to !== call.me.id && message.to !== "*") return;
    const from = message.from;
    if (!from || from === call.me.id) return;

    if (message.kind === "state") {
        const peer = call.peers.get(from);
        if (peer) {
            peer.mic = !!message.data?.mic;
            peer.cam = !!message.data?.cam;
            updateGroupCallTile(call, peer);
        }
        return;
    }

    let peer = call.peers.get(from);

    if (message.kind === "offer") {
        // Новый offer от уже известного участника = он пересоздал соединение
        // (перезашёл/оборвалось) — старое заменяем.
        if (peer && (peer.remoteSet || peer.pc.signalingState !== "stable")) {
            removeGroupCallPeer(call, from);
            peer = null;
        }
        if (!peer) {
            if (call.peers.size >= GCALL_MAX_PARTICIPANTS - 1) return;
            peer = createGroupCallPeer(call, from, call.participants.get(from), false);
        }
        try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(message.data));
            peer.remoteSet = true;
            await attachGroupCallLocalTracks(call, peer);
            await flushGroupCallCandidates(peer);
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            call.room.sendSignal({ to: from, from: call.me.id, kind: "answer", data: answer });
        } catch (error) {
            console.warn("Не удалось ответить участнику звонка", error);
        }
        return;
    }

    if (!peer) return;

    if (message.kind === "answer") {
        if (peer.pc.signalingState !== "have-local-offer") return;
        try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription(message.data));
            peer.remoteSet = true;
            await flushGroupCallCandidates(peer);
        } catch (error) {
            console.warn("Не удалось применить ответ участника звонка", error);
        }
        return;
    }

    if (message.kind === "ice") {
        if (!peer.remoteSet) { peer.pendingCandidates.push(message.data); return; }
        peer.pc.addIceCandidate(new RTCIceCandidate(message.data)).catch(() => {});
    }

}

// Отвечающая сторона: после setRemoteDescription подключаем свой звук/видео к
// трансиверам, которые браузер завёл под секции чужого offer, и разрешаем им
// отправку (по умолчанию они recvonly) — до createAnswer.
async function attachGroupCallLocalTracks(call, peer) {
    for (const transceiver of peer.pc.getTransceivers()) {
        const kind = transceiver.receiver?.track?.kind;
        if (kind === "audio" && call.audioTrack) {
            transceiver.direction = "sendrecv";
            await transceiver.sender.replaceTrack(call.audioTrack).catch(() => {});
            try { transceiver.sender.setStreams?.(call.localStream); } catch {}
        } else if (kind === "video") {
            transceiver.direction = "sendrecv";
            if (call.videoTrack) await transceiver.sender.replaceTrack(call.videoTrack).catch(() => {});
            try { transceiver.sender.setStreams?.(call.localStream); } catch {}
            peer.videoSender = transceiver.sender;
            limitGroupCallVideoSender(transceiver.sender);
        }
    }
}

async function flushGroupCallCandidates(peer) {
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
}

function removeGroupCallPeer(call, userId) {
    const peer = call.peers.get(userId);
    if (!peer) return;
    call.peers.delete(userId);
    clearTimeout(peer.graceTimer);
    try { peer.pc.close(); } catch {}
    removeGroupCallTile(call, userId);
    updateGroupCallHeader(call);
}

// Состояние моих микрофона/камеры — всем (to "*") или одному вновь
// подключившемуся.
function sendGroupCallState(call, to = "*") {
    call.room?.sendSignal({
        to, from: call.me.id, kind: "state",
        data: { mic: call.micOn, cam: !!call.videoTrack }
    });
}

function toggleGroupCallMic() {
    const call = activeGroupCall;
    if (!call || !call.audioTrack) return;
    call.micOn = !call.micOn;
    call.audioTrack.enabled = call.micOn;
    document.getElementById("gcall-mic").setAttribute("aria-pressed", String(!call.micOn));
    document.getElementById("gcall-mic").textContent = call.micOn ? "Микрофон" : "Микрофон выкл.";
    updateGroupCallTile(call, null);
    sendGroupCallState(call);
}

async function toggleGroupCallCamera() {

    const call = activeGroupCall;
    if (!call || call.cameraBusy) return;
    call.cameraBusy = true;

    try {
        if (call.videoTrack) {
            const old = call.videoTrack;
            call.videoTrack = null;
            call.peers.forEach((peer) => { peer.videoSender?.replaceTrack(null).catch(() => {}); });
            old.stop();
            call.localStream.removeTrack(old);
        } else {
            let cameraStream;
            try {
                cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } });
            } catch (error) {
                toast("Не удалось включить камеру");
                return;
            }
            const track = cameraStream.getVideoTracks()[0];
            call.videoTrack = track;
            call.localStream.addTrack(track);
            call.peers.forEach((peer) => { peer.videoSender?.replaceTrack(track).catch(() => {}); });
        }
    } finally {
        call.cameraBusy = false;
    }

    document.getElementById("gcall-cam").setAttribute("aria-pressed", String(!call.videoTrack));
    document.getElementById("gcall-cam").textContent = call.videoTrack ? "Камера" : "Камера выкл.";
    updateGroupCallTile(call, null);
    sendGroupCallState(call);

}

function leaveGroupCall(reason = "left") {

    const call = activeGroupCall;
    if (!call) return;
    activeGroupCall = null;
    call.ended = true;
    startingGroupCall = false;

    clearInterval(call.timer);
    call.peers.forEach((peer) => { clearTimeout(peer.graceTimer); try { peer.pc.close(); } catch {} });
    call.peers.clear();
    call.localStream.getTracks().forEach((track) => track.stop());
    call.room?.leave();

    const root = document.getElementById("gcall");
    document.getElementById("gcall-grid").innerHTML = "";
    root.hidden = true;
    root.setAttribute("aria-hidden", "true");

    // Если смотрю эту же группу — возвращаем баннер "Идёт звонок" (если он ещё идёт).
    if (currentChatId === call.chatId && currentChatType === "group") {
        setTimeout(() => watchGroupCallBanner(call.chatId), 800);
    }

}

// ---- интерфейс звонка ----

function groupCallInitial(name) {
    return (String(name || "?").trim()[0] || "?").toUpperCase();
}

function showGroupCallUI(call) {

    const root = document.getElementById("gcall");
    document.getElementById("gcall-title").textContent = call.title;
    document.getElementById("gcall-count").textContent = "";
    document.getElementById("gcall-grid").innerHTML = "";
    document.getElementById("gcall-mic").setAttribute("aria-pressed", "false");
    document.getElementById("gcall-mic").textContent = "Микрофон";
    document.getElementById("gcall-cam").setAttribute("aria-pressed", String(!call.videoTrack));
    document.getElementById("gcall-cam").textContent = call.videoTrack ? "Камера" : "Камера выкл.";
    root.hidden = false;
    root.setAttribute("aria-hidden", "false");

    addGroupCallLocalTile(call);
    updateGroupCallHeader(call);

}

function buildGroupCallTile(userId, name, avatar, muted, initialSource = name) {
    const tile = document.createElement("div");
    tile.className = "gcall-tile no-video";
    tile.dataset.user = userId;
    tile.innerHTML = `
        <video autoplay playsinline${muted ? " muted" : ""}></video>
        <div class="gcall-avatar"></div>
        <div class="gcall-name"><span class="gcall-mic-off" hidden>Без звука</span><span class="gcall-name-text"></span></div>
    `;
    tile.querySelector(".gcall-name-text").textContent = name;
    const avatarEl = tile.querySelector(".gcall-avatar");
    if (avatar) avatarEl.style.backgroundImage = cssUrlValue(avatar);
    else avatarEl.textContent = groupCallInitial(initialSource);
    if (muted) tile.querySelector("video").muted = true;
    return tile;
}

function addGroupCallLocalTile(call) {
    const tile = buildGroupCallTile(call.me.id, "Вы", call.me.avatar, true, call.me.name);
    tile.classList.add("local");
    call.tiles.set(call.me.id, tile);
    document.getElementById("gcall-grid").appendChild(tile);
    updateGroupCallTile(call, null);
    refreshGroupCallGrid();
}

function addGroupCallTile(call, peer) {
    const tile = buildGroupCallTile(peer.userId, peer.name, peer.avatar, false);
    peer.tile = tile;
    call.tiles.set(peer.userId, tile);
    document.getElementById("gcall-grid").appendChild(tile);
    tile.querySelector("video").srcObject = peer.remoteStream;
    refreshGroupCallGrid();
}

function removeGroupCallTile(call, userId) {
    const tile = call.tiles.get(userId);
    if (tile) { tile.remove(); call.tiles.delete(userId); }
    refreshGroupCallGrid();
}

// peer = null — обновить свою плитку (и подписи кнопок).
function updateGroupCallTile(call, peer) {

    if (!peer) {
        const tile = call.tiles.get(call.me.id);
        if (!tile) return;
        const video = tile.querySelector("video");
        if (call.videoTrack) {
            if (!video.srcObject || video.srcObject.getVideoTracks()[0] !== call.videoTrack) {
                video.srcObject = new MediaStream([call.videoTrack]);
            }
        } else {
            video.srcObject = null;
        }
        tile.classList.toggle("no-video", !call.videoTrack);
        tile.querySelector(".gcall-mic-off").hidden = call.micOn;
        return;
    }

    const tile = peer.tile;
    if (!tile) return;
    tile.querySelector(".gcall-name-text").textContent = peer.name;
    tile.classList.toggle("no-video", !peer.cam || !peer.remoteStream.getVideoTracks().length);
    tile.classList.toggle("connecting", !peer.connected);
    tile.querySelector(".gcall-mic-off").hidden = peer.mic;

}

function refreshGroupCallGrid() {
    const grid = document.getElementById("gcall-grid");
    grid.dataset.count = String(grid.children.length);
}

function updateGroupCallHeader(call) {
    if (activeGroupCall !== call) return;
    const total = call.peers.size + 1;
    const time = call.startedAt ? " · " + formatCallDuration(Math.floor((Date.now() - call.startedAt) / 1000)) : "";
    document.getElementById("gcall-count").textContent = `${total} ${pluralRu(total, "участник", "участника", "участников")}${time}`;
}

function startGroupCallTimer(call) {
    call.startedAt = Date.now();
    clearInterval(call.timer);
    call.timer = setInterval(() => updateGroupCallHeader(call), 1000);
}

window.addEventListener("pagehide", () => {
    if (activeGroupCall) leaveGroupCall("closed");
});



/* ============================================================================
   P2P-ПЕРЕДАЧА БОЛЬШИХ ФАЙЛОВ — та же сигнализация, что у звонков выше:
   Supabase Realtime Broadcast — это WebSocket-соединение, уже открытое и
   поддерживаемое всем приложением (то же самое "наше" соединение, что
   несёт presence/typing/звонки), отдельного сервера не заводим. Намеренно
   НЕ переиспользует call-inbox/activeCall — отдельные каналы и состояние,
   чтобы баг в одной фиче не задел другую (см. supabaseClient.js →
   file-inbox/joinFileTransferChannel).

   Сами байты идут через RTCDataChannel напрямую между браузерами — Supabase
   Storage не участвует вообще. Чтение файла — ТОЛЬКО через Streams API
   (ReadableStreamBYOBReader), чанками по 64 КБ, без Blob.slice()+arrayBuffer()
   и без накопления файла в памяти целиком: это и даёт возможность передавать
   файлы, которые физически не влезли бы в оперативную память вкладки.
   Запись на диск у получателя — FileSystemWritableFileStream, те же
   последовательные write() без явного укорочения — то есть настоящий append.

   Обрыв соединения ПЕРЕУСТАНАВЛИВАЕТСЯ по-настоящему: при разрыве
   RTCPeerConnection отправитель создаёт новое соединение (тот же transferId,
   тот же Realtime-канал сигнализации — он не закрывается при обрыве P2P,
   только при завершении/отмене передачи) и присылает re-offer; получатель
   отвечает и сообщает, с какого байта реально продолжать (его собственный
   bytesReceived, а не оптимистичный bytesSent отправителя) — тот же
   FileSystemWritableFileStream продолжает дозапись с этой позиции, его не
   пересоздаём. Чтение у отправителя тоже стартует новым потоком с нужного
   смещения (file.slice(offset).stream()).

   Целостность — SHA-256 поверх всего файла, но тоже потоково (не грузя файл
   в память целиком): хешируем каждый 64-КБ чанк отдельно, затем хешируем
   склейку этих хешей (дешёвый и безопасный по памяти способ проверить
   большой файл нативным crypto.subtle, без сторонних библиотек — у Web
   Crypto API нет инкрементального digest, поэтому "хеш хешей" вместо
   одного потокового SHA-256). Отправитель шлёт свой хеш в конце передачи,
   получатель отдельно хеширует то, что реально записалось на диск (через
   fileHandle.getFile() после закрытия потока — именно то, что легло на
   диск, а не то, что отправитель думает, что отправил), и сравнивает.

   Известное ограничение: если закрыть вкладку/приложение ПОСРЕДИ передачи —
   состояние не переживает перезагрузку, начинать заново. Обрыв сети при
   ОТКРЫТОЙ вкладке — переживает, см. выше.
   ========================================================================= */

const FILE_TRANSFER_CHUNK_SIZE = 64 * 1024; // байт на один чанк — и дата-канала, и Streams-чтения, и хеширования
const FILE_TRANSFER_BUFFERED_HIGH = 4 * 1024 * 1024; // пауза отправки выше этого объёма в исходящем буфере браузера
const FILE_TRANSFER_BUFFERED_LOW = 1 * 1024 * 1024;  // возобновление отправки ниже этого порога (onbufferedamountlow)
const FILE_TRANSFER_MAX_RECONNECT_ATTEMPTS = 6;
const FILE_TRANSFER_HEARTBEAT_INTERVAL_MS = 3000; // пинг раз в 3 сек поверх control-канала
const FILE_TRANSFER_HEARTBEAT_TIMEOUT_MS = 9000;  // если 9 сек вообще ничего не пришло — считаем соединение мёртвым

let fileInboxUnsubscribe = null;
const activeFileTransfers = new Map(); // transferId -> состояние конкретной передачи

// Единственная платформа, которая реально умеет писать принимаемый файл на
// диск по мере поступления байт, а не копить его в памяти — Chrome/Edge на
// десктопе. Без этого API принимать файлы в несколько гигабайт — значит либо
// упасть по памяти, либо городить костыли (IndexedDB-буфер, StreamSaver) —
// сознательно не делаем ради надёжности, лучше честно скрыть кнопку.
function isP2PFileTransferSupported() {
    return typeof window.showSaveFilePicker === "function";
}

function startFileInbox(myUserId) {
    if (fileInboxUnsubscribe) return;
    fileInboxUnsubscribe = KabanAPI.subscribeToFileInbox(myUserId, {
        onOffer: (payload) => handleIncomingFileOffer(payload)
    });
}

function stopFileInbox() {
    if (fileInboxUnsubscribe) { fileInboxUnsubscribe(); fileInboxUnsubscribe = null; }
}

function bufferToHex(buffer) {
    return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 "хеш хешей" по 64-КБ чанкам, потоково через Streams API (BYOB) —
// в памяти одновременно держится только текущий чанк плюс список уже
// посчитанных 32-байтных хешей (для файла в 50 ГБ это ~800 тыс. чанков ×
// 32 байта ≈ 25 МБ — на три порядка меньше самого файла, а не 50 ГБ разом).
async function hashFileStreaming(file) {

    const reader = file.stream().getReader({ mode: "byob" });
    const chunkHashes = [];
    let buffer = new ArrayBuffer(FILE_TRANSFER_CHUNK_SIZE);

    try {
        while (true) {
            // BYOB: передаваемый буфер "забирается" ридером и возвращается
            // внутри value.buffer — забираем его обратно в `buffer`, чтобы
            // следующая итерация переиспользовала ТУ ЖЕ память, а не
            // аллоцировала новый Uint8Array на каждый чанк (на файле в
            // десятки ГБ это сотни тысяч мусорных объектов и GC-фризы).
            const { value, done } = await reader.read(new Uint8Array(buffer));
            if (done) break;
            buffer = value.buffer;
            if (value.byteLength === 0) continue;
            const chunkDigest = await crypto.subtle.digest("SHA-256", value);
            chunkHashes.push(new Uint8Array(chunkDigest));
        }
    } finally {
        reader.releaseLock();
    }

    const combined = new Uint8Array(chunkHashes.length * 32);
    chunkHashes.forEach((h, i) => combined.set(h, i * 32));
    const finalDigest = await crypto.subtle.digest("SHA-256", combined);
    return bufferToHex(finalDigest);

}

// Прикладной heartbeat поверх control-канала — WebRTC/ICE сам по себе может
// понять, что собеседник пропал ("failed"/"disconnected"), с задержкой до
// десятков секунд, особенно если обрыв "тихий" (выдернули кабель/Wi-Fi, а не
// корректно закрыли соединение). Пинг раз в 3 сек + отсутствие ЛЮБОГО
// сообщения от собеседника дольше 9 сек — быстрый и дешёвый сигнал "там
// никого", не дожидаясь, пока это признает сам браузер.
function startHeartbeat(transfer) {

    stopHeartbeat(transfer);
    transfer.lastHeartbeatAt = Date.now();

    transfer.heartbeatInterval = setInterval(() => {

        if (transfer.finished || transfer.reconnecting) return;

        if (transfer.controlChannel?.readyState === "open") {
            try { transfer.controlChannel.send(JSON.stringify({ type: "ping" })); } catch {}
        }

        if (Date.now() - transfer.lastHeartbeatAt > FILE_TRANSFER_HEARTBEAT_TIMEOUT_MS) {
            stopHeartbeat(transfer);
            if (transfer.role === "sender") {
                // Та же реакция, что и на connectionState "failed"/"closed" —
                // просто узнаём об этом быстрее, чем через нативный ICE-таймаут.
                attemptSenderReconnect(transfer);
            } else {
                // Получатель сам реконнект не инициирует (так уже устроен
                // протокол — см. attemptSenderReconnect) — только честно
                // показываем, что канал молчит, пока не придёт re-offer.
                setP2PStatus(transfer, "reconnecting", "Собеседник не отвечает, ждём переподключения…");
            }
        }

    }, FILE_TRANSFER_HEARTBEAT_INTERVAL_MS);

}

function stopHeartbeat(transfer) {
    clearInterval(transfer.heartbeatInterval);
    transfer.heartbeatInterval = null;
}

function setupFileTransferPeerConnection(transfer) {

    const pc = transfer.pc;

    pc.onicecandidate = (event) => {
        if (event.candidate && transfer.channel) {
            transfer.channel.sendIceCandidate({ candidate: event.candidate });
        }
    };

    pc.onconnectionstatechange = () => {

        if (transfer.finished || transfer.reconnecting) return;

        // "connected" — явно ожили (например, после короткого блика
        // disconnected, который сам себя исправил) — снимаем отложенную
        // проверку, если она была запланирована.
        if (pc.connectionState === "connected") {
            clearTimeout(transfer.disconnectGraceTimer);
            detectLanConnection(transfer);
            return;
        }

        // "failed"/"closed" — окончательные состояния, реагируем сразу.
        // Намеренные close() (в finishFileTransfer/при самом переподключении)
        // не зациклят реконнект — к этому моменту transfer.finished или
        // transfer.reconnecting уже true, и этот обработчик выходит по
        // гварду выше.
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            clearTimeout(transfer.disconnectGraceTimer);
            if (transfer.role === "sender") attemptSenderReconnect(transfer);
            return;
        }

        // "disconnected" — может быть временным сбоем ICE, который сам
        // восстановится за пару секунд (особенно часто мелькает прямо во
        // время установки свежего соединения, ДО того как оно успело дойти
        // до "connected") — не рвём сразу, даём шанс самовосстановиться.
        if (pc.connectionState === "disconnected") {
            clearTimeout(transfer.disconnectGraceTimer);
            transfer.disconnectGraceTimer = setTimeout(() => {
                if (transfer.finished || transfer.reconnecting) return;
                if (pc.connectionState !== "connected" && transfer.pc === pc) {
                    if (transfer.role === "sender") attemptSenderReconnect(transfer);
                }
            }, 4000);
        }

    };

}

// LAN-индикатор — если установленная пара ICE-кандидатов "host" (прямое
// соединение, не через STUN-рефлексию/TURN-релей), скорее всего оба в одной
// локальной сети — тогда скорость ограничена уже не интернет-тарифом, а
// только локальной сетью (до ~1 Гбит/с по Wi-Fi). Это эвристика, не 100%
// гарантия (бывает host-host и напрямую через интернет), но для "вау-эффекта"
// достаточно точная.
async function detectLanConnection(transfer) {
    if (!transfer.pc || transfer.finished) return;
    try {
        const stats = await transfer.pc.getStats();
        let isLan = false;
        stats.forEach((report) => {
            if (report.type === "candidate-pair" && report.state === "succeeded" && (report.selected || report.nominated)) {
                const localCandidate = stats.get(report.localCandidateId);
                if (localCandidate?.candidateType === "host") isLan = true;
            }
        });
        transfer.isLan = isLan;
        const badge = document.querySelector(`[data-transfer-id="${transfer.transferId}"] .p2p-file-lan-badge`);
        if (badge) badge.hidden = !isLan;
    } catch (error) {
        console.warn("Не удалось определить тип соединения", error);
    }
}

// Проверка свободного места ДО старта приёма — у File System Access API нет
// прямого способа узнать свободное место именно в выбранной пользователем
// папке (showSaveFilePicker может указывать на любой диск), поэтому это
// оценка через общую квоту хранилища источника (navigator.storage) — на
// практике Chrome считает её от реального свободного места на диске, но
// если пользователь выбрал ДРУГОЙ физический диск, оценка может быть не
// точной. Это лучшее, что даёт браузер — честная эвристика, не гарантия.
async function hasEnoughDiskSpace(requiredBytes) {
    if (!navigator.storage?.estimate) return true; // API недоступен — не блокируем приём
    try {
        const { quota, usage } = await navigator.storage.estimate();
        if (quota == null) return true;
        return (quota - (usage || 0)) >= requiredBytes;
    } catch {
        return true;
    }
}

// Сеть вернулась (например, переключились с одного Wi-Fi на другой) —
// подталкиваем застрявшие передачи сразу, не дожидаясь, пока WebRTC сам
// распознает обрыв через ICE-таймаут (это может занять заметно больше
// времени, чем системное событие "online").
window.addEventListener("online", () => {
    for (const transfer of activeFileTransfers.values()) {
        if (transfer.role !== "sender" || transfer.finished || transfer.reconnecting || transfer.paused) continue;
        if (transfer.pc?.connectionState !== "connected") attemptSenderReconnect(transfer);
    }
});

// Отправитель — выбор файла уже сделан (см. triggerP2PFilePick/handleP2PFileSelect
// в script-ui.js), здесь только сама отправка: создаём сообщение, открываем
// P2P-соединение, зовём собеседника через file-inbox.
// Только ОДНА исходящая P2P-передача одновременно (не per-чат, на всё
// приложение сразу) — параллельные потоки душили бы друг друга по сети и
// хаотично писали бы на диск получателя одновременно в несколько файлов.
// Остальные выбранные файлы получают статус "В очереди…" и запускаются
// автоматически по цепочке, как только текущая передача освобождается
// (см. advanceFileSendQueue, вызывается из finishFileTransfer).
let activeSendTransferId = null;
const fileSendQueue = []; // [{ file, transferId, messageId, chatId, otherUserId }]

async function sendP2PFile(file) {

    if (!isP2PFileTransferSupported()) {
        toast("Передача больших файлов работает только в Chrome/Edge на компьютере");
        return;
    }
    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED || !currentChatId) {
        toast("Доступно только в настоящих чатах");
        return;
    }
    if (currentChatType === "group") {
        toast("P2P-передача доступна только в личных чатах");
        return;
    }
    if (!currentOtherUserId) {
        toast("Нельзя отправить файл в этом чате");
        return;
    }
    if (currentChatIsSecret) {
        toast("В секретных чатах недоступно");
        return;
    }

    const transferId = crypto.randomUUID();
    // chatId/otherUserId фиксируем ЗДЕСЬ, а не читаем заново из currentChatId
    // в момент реального старта — если файл пойдёт в очередь, пользователь
    // вполне может успеть переключиться в другой чат до того, как очередь
    // до него дойдёт, а слать файл нужно туда, куда его выбрали изначально.
    const chatId = currentChatId;
    const otherUserId = currentOtherUserId;

    // Решение "в очередь или стартуем сразу" принимаем и слот занимаем СРАЗУ,
    // синхронно, до await sendMessage ниже — иначе два быстрых вызова подряд
    // оба видели бы свободный слот при формировании статуса сообщения
    // ("pending" у обоих), хотя фактически второй потом всё равно уходил в
    // очередь, и у получателя его карточка успевала показать кнопки
    // "Принять/Отклонить" ещё до того, как его очередь вообще дошла.
    const shouldQueue = !!activeSendTransferId;
    if (!shouldQueue) activeSendTransferId = transferId;

    let message;
    try {
        message = await KabanAPI.sendMessage(chatId, {
            type: "document",
            attachmentUrl: null,
            attachmentMeta: {
                p2p: true,
                status: shouldQueue ? "queued" : "pending",
                transferId,
                fileName: file.name,
                fileSize: file.size,
                mime: file.type || "application/octet-stream"
            }
        });
    } catch (error) {
        toast("Не удалось создать сообщение: " + (error?.message || error));
        if (!shouldQueue) advanceFileSendQueue(transferId); // отдаём занятый слот следующему в очереди
        return;
    }

    // Сообщение показываем сразу (видно в чате, что файл поставлен в
    // очередь), независимо от того, стартует передача прямо сейчас или нет.
    if (chatId === currentChatId) {
        realMessagesById.set(message.id, message);
        appendRealMessageRow(message, true);
        updateMessageGrouping();
        if (appSettings.autoScroll) scrollMessagesToBottom();
    }
    patchCachedChatLastMessage(chatId, message);

    if (shouldQueue) {
        fileSendQueue.push({ file, transferId, messageId: message.id, chatId, otherUserId });
        return;
    }

    await startP2PFileSendNow({ file, transferId, messageId: message.id, chatId, otherUserId });

}

async function startP2PFileSendNow({ file, transferId, messageId, chatId, otherUserId }) {

    activeSendTransferId = transferId;

    let transfer = null;

    try {
        await runP2PFileSend();
    } catch (error) {
        // Любой сбой настройки (сеть/сигнализация/WebRTC) до реального старта
        // передачи — без этого activeSendTransferId навсегда оставался бы
        // занятым, и очередь (fileSendQueue) никогда бы не двигалась дальше:
        // пользователь не мог бы отправить ни одного P2P-файла до перезагрузки.
        console.warn("Не удалось начать P2P-передачу", error);
        if (transfer) {
            finishFileTransfer(transfer, "failed"); // сам освободит слот и продвинет очередь
        } else {
            advanceFileSendQueue(transferId);
            KabanAPI.updateMessageAttachmentMeta(messageId, { status: "failed" }).catch(() => {});
        }
    }

    async function runP2PFileSend() {

    const me = await KabanAuth.getCurrentUser();
    if (!me) throw new Error("Нужно войти в аккаунт");

    transfer = {
        transferId,
        role: "sender",
        file,
        messageId,
        chatId,
        peerId: otherUserId,
        bytesSent: 0,
        reconnectAttempts: 0,
        status: "pending",
        finished: false
    };
    activeFileTransfers.set(transferId, transfer);
    setP2PStatus(transfer, "pending", "Ожидает подтверждения…");

    // Если файл стоял в очереди — в БД у него всё ещё status:"queued".
    // Патчим на "pending" ИМЕННО сейчас (реальный offer вот-вот уйдёт) —
    // без этого у получателя кнопки "Принять/Отклонить" не появятся
    // (buildP2PFileHTML рисует их только при status === "pending",
    // ориентируясь на само сообщение, а не на activeFileTransfers).
    KabanAPI.updateMessageAttachmentMeta(messageId, { status: "pending" }).catch((error) => {
        console.warn("Не удалось обновить статус очереди", error);
    });

    // Хешируем файл отдельным, независимым проходом параллельно с
    // отправкой — не зависит от того, сколько раз порвётся и
    // переустановится P2P-соединение, читает один и тот же неизменный
    // File с начала до конца один раз.
    transfer.hashPromise = hashFileStreaming(file).catch((error) => {
        console.warn("Не удалось посчитать хеш файла", error);
        return null;
    });

    const channelHandle = KabanAPI.joinFileTransferChannel(transferId, {
        onAnswer: async (payload) => {
            try {
                await transfer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
            } catch (error) {
                console.warn("Не удалось применить answer на передачу файла", error);
            }
        },
        onIceCandidate: (payload) => {
            transfer.pc?.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
        },
        onEnd: (payload) => {
            const reason = payload?.reason;
            finishFileTransfer(transfer, reason === "declined" ? "declined" : reason === "unsupported" ? "unsupported" : "failed");
        }
    });
    transfer.channel = channelHandle;
    await channelHandle.ready;

    createSenderConnection(transfer, 0, false);

    const offer = await transfer.pc.createOffer();
    await transfer.pc.setLocalDescription(offer);

    await KabanAPI.sendFileOffer(otherUserId, {
        transferId,
        chatId,
        messageId,
        senderId: me.id,
        senderName: cachedMyProfile?.display_name || "Пользователь",
        fileName: file.name,
        fileSize: file.size,
        mime: file.type || "application/octet-stream",
        sdp: offer
    });

    }

}

// Вызывается из finishFileTransfer, когда освобождается активный слот —
// если в очереди что-то есть, запускаем следующее по порядку (FIFO).
function advanceFileSendQueue(finishedTransferId) {
    if (activeSendTransferId !== finishedTransferId) return;
    activeSendTransferId = null;
    const next = fileSendQueue.shift();
    if (next) {
        startP2PFileSendNow(next).catch((error) => {
            console.warn("Не удалось запустить следующий файл из очереди", error);
        });
    }
}

// Заводит pc + оба дата-канала на стороне отправителя — используется и при
// первом offer, и при re-offer после обрыва (resumeFromByte > 0 — читаем
// файл не с начала, а с байта, который реально подтвердил получатель).
//
// isReconnect=true НЕ запускает отправку сразу по открытию байт-канала —
// у двух дата-каналов нет гарантии, какой откроется раньше, а безопасную
// позицию для продолжения знает только получатель (через "resume-from" по
// control-каналу, см. handleFileControlMessage) — отправка стартует оттуда,
// а не оптимистично от своего же bytesSent.
function createSenderConnection(transfer, resumeFromByte, isReconnect) {

    const pc = new RTCPeerConnection(RTC_CONFIG);
    transfer.pc = pc;
    transfer.bytesSent = resumeFromByte;
    transfer.reader = null; // создастся лениво в pumpFileBytes с нужного смещения
    setupFileTransferPeerConnection(transfer);

    const byteChannel = pc.createDataChannel("file-bytes", { ordered: true });
    byteChannel.binaryType = "arraybuffer";
    byteChannel.bufferedAmountLowThreshold = FILE_TRANSFER_BUFFERED_LOW;
    byteChannel.onopen = () => {
        transfer.reconnecting = false;
        if (!isReconnect) pumpFileBytes(transfer);
    };
    byteChannel.onbufferedamountlow = () => pumpFileBytes(transfer);
    transfer.byteChannel = byteChannel;

    const controlChannel = pc.createDataChannel("file-control", { ordered: true });
    controlChannel.onmessage = (event) => handleFileControlMessage(transfer, event);
    controlChannel.onopen = () => startHeartbeat(transfer);
    transfer.controlChannel = controlChannel;

}

async function attemptSenderReconnect(transfer) {

    if (transfer.finished || transfer.reconnecting) return;
    if (transfer.reconnectAttempts >= FILE_TRANSFER_MAX_RECONNECT_ATTEMPTS) {
        // Получатель сам никакую связь не инициирует — без явного sendEnd он
        // бы завис в "Переподключение…" навсегда, никогда не узнав, что
        // отправитель сдался.
        try { await transfer.channel.sendEnd({ reason: "failed" }); } catch {}
        finishFileTransfer(transfer, "failed");
        return;
    }

    transfer.reconnecting = true;
    transfer.reconnectAttempts += 1;
    setP2PStatus(transfer, "reconnecting", `Переподключение… (${transfer.reconnectAttempts}/${FILE_TRANSFER_MAX_RECONNECT_ATTEMPTS})`);

    stopHeartbeat(transfer);
    try { transfer.pc?.close(); } catch {}

    // Продолжаем с того, что сами успели отправить — точную позицию
    // скорректирует получатель через control-сообщение "resume-from" после
    // того, как новое соединение установится (см. handleFileControlMessage).
    createSenderConnection(transfer, transfer.bytesSent, true);

    try {
        const offer = await transfer.pc.createOffer();
        await transfer.pc.setLocalDescription(offer);
        await transfer.channel.sendReoffer({ sdp: offer });
    } catch (error) {
        console.warn("Не удалось переподключиться", error);
        transfer.reconnecting = false;
        attemptSenderReconnect(transfer);
    }

}

// Качает чанки, пока есть что слать и пока исходящий буфер браузера не
// переполнен (backpressure) — при переполнении просто выходит, продолжит
// сам же через onbufferedamountlow, когда буфер освободится. Чтение —
// ТОЛЬКО через Streams API (BYOB-ридер с фиксированным 64-КБ буфером), а
// не Blob.slice()+arrayBuffer(): в любой момент в памяти лежит максимум
// один такой буфер, независимо от размера всего файла.
async function pumpFileBytes(transfer) {

    const { file, byteChannel } = transfer;
    if (!file || !byteChannel || byteChannel.readyState !== "open" || transfer.finished || transfer.reconnecting || transfer.paused) return;
    if (transfer.pumping) return; // уже качает в другом вызове (onopen + onbufferedamountlow могли наложиться)
    transfer.pumping = true;

    try {

        if (!transfer.reader) {
            transfer.reader = file.slice(transfer.bytesSent).stream().getReader({ mode: "byob" });
            transfer.readBuffer = new ArrayBuffer(FILE_TRANSFER_CHUNK_SIZE);
        }

        while (true) {

            if (transfer.paused) return; // проверяем и внутри цикла — пауза могла прийти посреди передачи

            if (byteChannel.bufferedAmount > FILE_TRANSFER_BUFFERED_HIGH) return;

            // Переиспользуем один и тот же ArrayBuffer на все чанки (см.
            // комментарий в hashFileStreaming) — byteChannel.send() копирует
            // байты синхронно до возврата, так что сразу после send() этот
            // же буфер безопасно отдавать на следующее BYOB-чтение.
            const { value, done } = await transfer.reader.read(new Uint8Array(transfer.readBuffer));

            if (byteChannel.readyState !== "open" || transfer.finished) return; // порвалось, пока читали чанк

            if (done) {
                const sha256 = await transfer.hashPromise;
                transfer.controlChannel.send(JSON.stringify({ type: "sender-done", sha256 }));
                return;
            }
            if (value.byteLength === 0) { transfer.readBuffer = value.buffer; continue; }

            byteChannel.send(value);
            transfer.readBuffer = value.buffer;
            transfer.bytesSent += value.byteLength;
            updateP2PProgress(transfer, transfer.bytesSent, file.size);

        }

    } finally {
        transfer.pumping = false;
    }

}

function handleFileControlMessage(transfer, event) {

    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    // Любое сообщение от собеседника — доказательство, что канал жив, не
    // только явные ping/pong (так heartbeat не ложно сработает во время
    // активной передачи, где управляющие сообщения и так редки).
    transfer.lastHeartbeatAt = Date.now();

    if (msg.type === "ping") {
        try { transfer.controlChannel.send(JSON.stringify({ type: "pong" })); } catch {}
        return;
    } else if (msg.type === "pong") {
        return;
    } else if (msg.type === "accepted") {
        setP2PStatus(transfer, "transferring", "Передаётся…");
    } else if (msg.type === "declined") {
        finishFileTransfer(transfer, "declined");
    } else if (msg.type === "resume-from") {
        // Получатель после переподключения сообщает, сколько байт у него
        // реально уже записано — источник истины для возобновления, а не
        // наш собственный (возможно, оптимистичный) bytesSent.
        transfer.reader = null;
        transfer.bytesSent = msg.offset;
        pumpFileBytes(transfer);
    } else if (msg.type === "sender-done") {
        // Прилетает ТОЛЬКО получателю (отправитель сам его шлёт, не получает).
        // Порядок доставки между file-bytes и file-control не гарантирован —
        // последний байт может прийти раньше или позже этого сообщения,
        // поэтому finalizeReceivedFile() ждёт expectedHashPromise, а не
        // просто проверяет transfer.expectedHash синхронно.
        transfer.expectedHash = msg.sha256;
        transfer.resolveExpectedHash?.(msg.sha256);
    } else if (msg.type === "received-done") {
        finishFileTransfer(transfer, msg.match === false ? "hash-mismatch" : "completed");
    } else if (msg.type === "pause") {
        // Пришло от собеседника (не обязательно от отправителя — поставить
        // на паузу может любая сторона, см. pauseFileTransfer) — синхронизируем
        // свою копию состояния и, если я отправитель, действительно
        // останавливаем отправку (pumpFileBytes сам проверяет transfer.paused).
        transfer.paused = true;
        setP2PStatus(transfer, "paused", "Собеседник поставил на паузу");
    } else if (msg.type === "resume") {
        transfer.paused = false;
        setP2PStatus(transfer, "transferring", "Передаётся…");
        if (transfer.role === "sender") pumpFileBytes(transfer);
    }

}

// Доступно ОБЕИМ сторонам (не только отправителю) — тому, кому в моменте
// нужно освободить канал (например, запустить игру), а передавать байты
// реально умеет только отправитель, поэтому решение всегда долетает до
// него через control-канал и там же применяется (pumpFileBytes проверяет
// transfer.paused перед каждым чанком).
function pauseFileTransfer(transferId) {
    const transfer = activeFileTransfers.get(transferId);
    if (!transfer || transfer.finished || transfer.paused) return;
    transfer.paused = true;
    setP2PStatus(transfer, "paused", "На паузе");
    transfer.controlChannel?.send(JSON.stringify({ type: "pause" }));
}

function resumeFileTransferManual(transferId) {
    const transfer = activeFileTransfers.get(transferId);
    if (!transfer || transfer.finished || !transfer.paused) return;
    transfer.paused = false;
    setP2PStatus(transfer, "transferring", "Передаётся…");
    transfer.controlChannel?.send(JSON.stringify({ type: "resume" }));
    if (transfer.role === "sender") pumpFileBytes(transfer);
}

// Входящее предложение файла (из file-inbox, подписан весь залогиненный
// сеанс — см. startFileInbox) — просто запоминаем offer, реальная работа
// (выбор места на диске, ответ) начнётся по клику "Принять" на самом
// сообщении (см. buildP2PFileHTML в script-messages.js), а не во
// всплывающем окне поверх всего интерфейса, как у звонков.
function handleIncomingFileOffer(payload) {

    if (!isP2PFileTransferSupported()) {
        const busy = KabanAPI.joinFileTransferChannel(payload.transferId, {});
        busy.ready.then(() => busy.sendEnd({ reason: "unsupported" })).catch(() => {}).finally(() => { try { busy.leave(); } catch {} });
        return;
    }

    let resolveExpectedHash;
    const expectedHashPromise = new Promise((resolve) => { resolveExpectedHash = resolve; });

    activeFileTransfers.set(payload.transferId, {
        transferId: payload.transferId,
        role: "receiver",
        chatId: payload.chatId,
        messageId: payload.messageId,
        peerId: payload.senderId,
        fileName: payload.fileName,
        fileSize: payload.fileSize,
        mime: payload.mime,
        offerSdp: payload.sdp,
        bytesReceived: 0,
        expectedHash: null,
        expectedHashPromise,
        resolveExpectedHash,
        status: "pending",
        finished: false
    });

}

// Общая часть установки соединения на стороне получателя — используется и
// при первом accept, и при каждом re-offer после обрыва связи.
function wireReceiverDataChannels(transfer, pc) {

    pc.ondatachannel = (event) => {
        if (event.channel.label === "file-bytes") {
            transfer.byteChannel = event.channel;
            event.channel.binaryType = "arraybuffer";
            event.channel.onmessage = (e) => handleFileByteChunk(transfer, e.data);
        } else if (event.channel.label === "file-control") {
            transfer.controlChannel = event.channel;
            event.channel.onmessage = (e) => handleFileControlMessage(transfer, e);
            event.channel.onopen = () => {
                transfer.reconnecting = false;
                if (transfer.bytesReceived > 0) {
                    // Это переподключение, а не первый accept — сообщаем
                    // отправителю реальную позицию, с которой продолжать.
                    transfer.controlChannel.send(JSON.stringify({ type: "resume-from", offset: transfer.bytesReceived }));
                } else {
                    transfer.controlChannel.send(JSON.stringify({ type: "accepted" }));
                }
                setP2PStatus(transfer, "transferring", "Передаётся…");
                startHeartbeat(transfer);
            };
        }
    };

}

async function acceptFileTransfer(transferId) {

    const transfer = activeFileTransfers.get(transferId);
    if (!transfer || transfer.role !== "receiver") return;

    // Двойной клик "Принять" (или повторный вызов, пока открыт диалог
    // сохранения) иначе запустил бы второй параллельный accept: второй
    // системный диалог выбора файла и два потока, перетирающих одни и те же
    // transfer.fileHandle/writable/pc друг у друга.
    if (transfer.accepting) return;
    transfer.accepting = true;

    // Лучше отказать ДО того, как человек потратит время на выбор файла и
    // начнётся сама передача, чем на середине, когда 100 ГБ зальются в
    // десятикратно меньший диск и уронят систему.
    if (!(await hasEnoughDiskSpace(transfer.fileSize))) {
        transfer.accepting = false;
        toast(`Недостаточно места на устройстве для файла ${formatFileSize(transfer.fileSize)}`);
        return;
    }

    let fileHandle;
    try {
        fileHandle = await window.showSaveFilePicker({ suggestedName: transfer.fileName });
    } catch (error) {
        transfer.accepting = false;
        return; // отменил выбор места сохранения — просто ничего не делаем
    }

    let writable;
    try {
        writable = await fileHandle.createWritable();
    } catch (error) {
        transfer.accepting = false;
        toast("Не удалось создать файл: " + (error?.message || error));
        return;
    }
    transfer.fileHandle = fileHandle;
    transfer.writable = writable;

    setP2PStatus(transfer, "accepted", "Подключение…");

    const pc = new RTCPeerConnection(RTC_CONFIG);
    transfer.pc = pc;
    setupFileTransferPeerConnection(transfer);
    wireReceiverDataChannels(transfer, pc);

    const channelHandle = KabanAPI.joinFileTransferChannel(transferId, {
        onReoffer: (payload) => handleFileReoffer(transfer, payload),
        onIceCandidate: (payload) => {
            transfer.pc?.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
        },
        onEnd: (payload) => finishFileTransfer(transfer, payload?.reason === "failed" ? "failed" : "cancelled")
    });
    transfer.channel = channelHandle;

    // channelHandle.ready тоже внутри try: writable уже создан выше, и при
    // сбое подписки на канал finishFileTransfer(...,"failed") откатит его
    // через abort() — иначе открытый файловый поток навсегда оставался бы
    // висеть на диске у получателя, а передача — в состоянии "Подключение…".
    try {
        await channelHandle.ready;
        await pc.setRemoteDescription(new RTCSessionDescription(transfer.offerSdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await channelHandle.sendAnswer({ sdp: answer });
    } catch (error) {
        toast("Не удалось установить соединение");
        finishFileTransfer(transfer, "failed");
        return;
    }

    try {
        await KabanAPI.updateMessageAttachmentMeta(transfer.messageId, { status: "accepted" });
    } catch (error) {
        console.warn("Не удалось обновить статус передачи", error);
    }

}

// Отправитель переустановил соединение после обрыва — отвечаем так же, как
// на первый offer, но БЕЗ пересоздания writable (тот же поток на диск
// продолжает дозапись с того места, где остановился).
async function handleFileReoffer(transfer, payload) {

    if (transfer.finished) return;
    transfer.reconnecting = true;
    setP2PStatus(transfer, "reconnecting", "Переподключение…");

    stopHeartbeat(transfer);
    try { transfer.pc?.close(); } catch {}

    const pc = new RTCPeerConnection(RTC_CONFIG);
    transfer.pc = pc;
    setupFileTransferPeerConnection(transfer);
    wireReceiverDataChannels(transfer, pc);

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await transfer.channel.sendAnswer({ sdp: answer });
    } catch (error) {
        console.warn("Не удалось ответить на переподключение", error);
        transfer.reconnecting = false;
    }

}

async function declineFileTransfer(transferId) {

    const transfer = activeFileTransfers.get(transferId);
    if (!transfer || transfer.declining) return;
    transfer.declining = true;

    // Сбой уведомления отправителя не должен оставлять у получателя в чате
    // живые кнопки "Принять/Отклонить" для уже принятого им решения — UI и
    // локальное состояние обновляем в любом случае (отправитель при
    // следующей попытке всё равно увидит, что передача не продолжилась).
    const channelHandle = KabanAPI.joinFileTransferChannel(transferId, {});
    try {
        await channelHandle.ready;
        await channelHandle.sendEnd({ reason: "declined" });
    } catch (error) {
        console.warn("Не удалось сообщить отправителю об отказе", error);
    } finally {
        try { channelHandle.leave(); } catch {}
    }

    activeFileTransfers.delete(transferId);
    setP2PStatus(transfer, "declined", "Вы отклонили");

    try {
        await KabanAPI.updateMessageAttachmentMeta(transfer.messageId, { status: "declined" });
    } catch (error) {
        console.warn("Не удалось обновить статус передачи", error);
    }

}

async function handleFileByteChunk(transfer, data) {

    if (transfer.finished) return;

    try {
        await transfer.writable.write(data);
    } catch (error) {
        finishFileTransfer(transfer, "failed");
        return;
    }

    transfer.bytesReceived += data.byteLength;
    updateP2PProgress(transfer, transfer.bytesReceived, transfer.fileSize);

    if (transfer.bytesReceived >= transfer.fileSize) {
        await finalizeReceivedFile(transfer);
    }

}

// Все байты на месте — закрываем поток записи и сверяем хеш того, что РЕАЛЬНО
// легло на диск (через fileHandle.getFile(), не то, что отправитель думает,
// что отправил), с хешем, который прислал отправитель в "sender-done".
async function finalizeReceivedFile(transfer) {

    try {
        await transfer.writable.close();
    } catch (error) {
        console.warn("Не удалось закрыть сохранённый файл", error);
    }

    setP2PStatus(transfer, "verifying", "Проверка целостности…");

    let match = null;
    try {
        const savedFile = await transfer.fileHandle.getFile();
        const actualHash = await hashFileStreaming(savedFile);
        // "sender-done" (несёт хеш) мог ещё не долететь к этому моменту —
        // ждём его отдельно, с коротким таймаутом на случай, если он вообще
        // потерялся (тогда просто не проверяем, а не зависаем навсегда).
        const expectedHash = transfer.expectedHash ?? await Promise.race([
            transfer.expectedHashPromise,
            new Promise((resolve) => setTimeout(() => resolve(null), 5000))
        ]);
        match = expectedHash ? actualHash === expectedHash : null;
    } catch (error) {
        console.warn("Не удалось проверить хеш полученного файла", error);
    }

    transfer.controlChannel?.send(JSON.stringify({ type: "received-done", match }));
    finishFileTransfer(transfer, match === false ? "hash-mismatch" : "completed");

}

function finishFileTransfer(transfer, finalStatus) {

    if (!transfer || transfer.finished) return;
    transfer.finished = true;

    stopHeartbeat(transfer);
    try { transfer.channel?.leave(); } catch {}
    try { transfer.pc?.close(); } catch {}
    try { transfer.reader?.releaseLock(); } catch {}

    // Получатель, у которого ещё открыт поток записи (т.е. провал ДО
    // finalizeReceivedFile — тот сам уже закрыл его через .close()) — явно
    // откатываем createWritable(). По спеку File System Access API запись
    // идёт в swap-файл и подменяет оригинал только на успешном close(),
    // так что .abort() тут не портит и не оставляет половину файла на
    // месте, где пользователь ожидает увидеть финальный результат — это и
    // есть "запись во временный файл" на практике, просто без ручного
    // управления именем temp-файла.
    if (transfer.role === "receiver" && transfer.writable && (finalStatus === "failed" || finalStatus === "cancelled")) {
        transfer.writable.abort().catch(() => {});
    }

    const statusText = {
        completed: transfer.role === "sender" ? "Файл отправлен, хеш совпадает" : "Файл сохранён, хеш совпадает",
        "hash-mismatch": "⚠️ Файл передан, но хеш не совпал — возможна повреждённая копия",
        failed: "Передача не удалась",
        cancelled: "Передача отменена",
        declined: transfer.role === "sender" ? "Собеседник отклонил" : "Вы отклонили",
        unsupported: "У собеседника нет поддержки (нужен Chrome/Edge на компьютере)"
    }[finalStatus] || "";

    setP2PStatus(transfer, finalStatus, statusText);
    activeFileTransfers.delete(transfer.transferId);
    if (transfer.role === "sender") advanceFileSendQueue(transfer.transferId);

    // declined патчит статус сам declineFileTransfer (там же, где решение
    // приняли) — здесь persist'им все остальные терминальные статусы, чтобы
    // при перезагрузке чата не оставалась вечно висящая плашка "pending".
    if (finalStatus !== "declined") {
        KabanAPI.updateMessageAttachmentMeta(transfer.messageId, { status: finalStatus }).catch((error) => {
            console.warn("Не удалось обновить статус передачи", error);
        });
    }

}

function formatEtaSeconds(seconds) {
    if (!Number.isFinite(seconds)) return "";
    if (seconds < 60) return `${Math.ceil(seconds)} сек`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} мин ${Math.round(seconds % 60)} сек`;
    const hours = Math.floor(minutes / 60);
    return `${hours} ч ${minutes % 60} мин`;
}

function updateP2PProgress(transfer, bytesDone, totalBytes) {

    // Вызывается на КАЖДЫЙ 64-КБ чанк (на быстрой LAN — тысячи раз в секунду):
    // три getElementById + запись width/textContent на каждый — устойчивая
    // нагрузка на основной поток, пропорциональная скорости передачи. Глазу
    // достаточно ~10 обновлений в секунду; финальный кадр (100%) пропускаем
    // без ограничения, чтобы не застрять на 99%.
    const renderNow = performance.now();
    const isFinalUpdate = totalBytes && bytesDone >= totalBytes;
    if (!isFinalUpdate && transfer.lastRenderAt != null && renderNow - transfer.lastRenderAt < 100) return;
    transfer.lastRenderAt = renderNow;

    const wrap = document.getElementById(`p2p-progress-wrap-${transfer.transferId}`);
    const fill = document.getElementById(`p2p-progress-${transfer.transferId}`);
    const statusEl = document.getElementById(`p2p-status-${transfer.transferId}`);

    if (wrap) wrap.hidden = false;
    if (fill && totalBytes) fill.style.width = `${Math.min(100, (bytesDone / totalBytes) * 100)}%`;

    // Скорость — экспоненциальное скользящее среднее между последовательными
    // вызовами (вызывается на каждый чанк, сырая мгновенная скорость была
    // бы слишком дёрганой для читаемого UI); сбрасывается после каждого
    // переподключения (lastProgressTime обнуляется в createSenderConnection/
    // wireReceiverDataChannels не нужен — новый расчёт просто стартует
    // заново с первого чанка после реконнекта, это и есть нужное поведение).
    const now = performance.now();
    // Пауза/обрыв/переподключение длиннее нескольких секунд — "скорость" за
    // такой промежуток была бы искусственно ничтожной и на долго отравила бы
    // скользящее среднее; начинаем расчёт заново с текущего чанка.
    if (transfer.lastProgressTime != null && (now - transfer.lastProgressTime) > 3000) {
        transfer.lastProgressTime = null;
        transfer.speedBps = null;
    }
    if (transfer.lastProgressTime != null && bytesDone > transfer.lastProgressBytes) {
        const dt = (now - transfer.lastProgressTime) / 1000;
        if (dt > 0.05) { // слишком частые тики (соседние чанки) дают шумную скорость — пропускаем
            const instantSpeed = (bytesDone - transfer.lastProgressBytes) / dt;
            transfer.speedBps = transfer.speedBps == null ? instantSpeed : (transfer.speedBps * 0.8 + instantSpeed * 0.2);
            transfer.lastProgressTime = now;
            transfer.lastProgressBytes = bytesDone;
        }
    } else {
        transfer.lastProgressTime = now;
        transfer.lastProgressBytes = bytesDone;
    }

    if (statusEl && typeof formatFileSize === "function") {
        const speed = transfer.speedBps;
        const remaining = totalBytes - bytesDone;
        const etaText = speed > 0 ? formatEtaSeconds(remaining / speed) : "";
        const speedText = speed > 0 ? `${formatFileSize(speed)}/с` : "";
        const extra = [speedText, etaText && `осталось ${etaText}`].filter(Boolean).join(" · ");
        statusEl.textContent = `${formatFileSize(bytesDone)} из ${formatFileSize(totalBytes)}${extra ? " · " + extra : ""}`;
    }

}

function setP2PStatus(transfer, status, text) {

    transfer.status = status;

    const statusEl = document.getElementById(`p2p-status-${transfer.transferId}`);
    if (statusEl && text) statusEl.textContent = text;

    const row = document.querySelector(`[data-transfer-id="${transfer.transferId}"]`);
    const actionsEl = row?.querySelector(".p2p-file-actions");

    // .p2p-file-actions существует в разметке ВСЕГДА (см. buildP2PFileHTML),
    // просто пустой, если действий нет — переписываем её содержимое, а не
    // удаляем сам узел: иначе кнопке "Пауза" было бы некуда появиться у
    // отправителя, чей первый рендер идёт без accept/decline.
    if (actionsEl) {
        if (status === "transferring" || status === "paused") {
            actionsEl.innerHTML = status === "paused"
                ? `<button type="button" class="p2p-file-pause" onclick="resumeFileTransferManual('${transfer.transferId}')">Продолжить</button>`
                : `<button type="button" class="p2p-file-pause" onclick="pauseFileTransfer('${transfer.transferId}')">Пауза</button>`;
        } else if (status !== "pending") {
            actionsEl.innerHTML = "";
        }
        // status === "pending" — не трогаем, там уже accept/decline (если это чужое) из начального рендера.
    }

    if (row && ["completed", "hash-mismatch", "declined", "failed", "cancelled"].includes(status)) {
        const wrap = row.querySelector(".p2p-file-progress");
        if (wrap) wrap.hidden = true;
    }

}


/* ПОИСК ПО ЧАТУ */

let chatSearchMatches = [];
let chatSearchIndex = -1;


function toggleChatSearch() {

    const panel = document.getElementById("chat-search");
    const button = document.querySelector("[aria-label='Поиск по чату']");
    const shouldOpen = !panel.classList.contains("open");

    if (!shouldOpen) {
        closeChatSearch();
        return;
    }

    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-open");
    document.getElementById("chat-search-input").focus();

}


function clearSearchHighlights() {

    // normalize() нужен только там, где реально были подсветки (они дробили
    // текстовый узел на куски) — прежний вариант вызывал его для КАЖДОГО
    // .message в чате при каждом нажатии клавиши в поле поиска, то есть
    // сотни лишних обходов DOM на длинной переписке даже при пустом запросе.
    const touchedParents = new Set();

    document.querySelectorAll(".search-highlight").forEach((highlight) => {
        if (highlight.parentNode) touchedParents.add(highlight.parentNode);
        highlight.replaceWith(document.createTextNode(highlight.textContent));
    });

    touchedParents.forEach((parent) => parent.normalize());

}


function highlightSearchText(message, query) {

    const lowerQuery = query.toLocaleLowerCase();
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
    const textNodes = [];

    while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement.closest(".message-time") &&
            node.textContent.toLocaleLowerCase().includes(lowerQuery)) {
            textNodes.push(node);
        }
    }

    textNodes.forEach((node) => {
        const text = node.textContent;
        const lowerText = text.toLocaleLowerCase();
        const fragment = document.createDocumentFragment();
        let position = 0;
        let matchIndex = lowerText.indexOf(lowerQuery, position);

        while (matchIndex !== -1) {
            fragment.append(text.slice(position, matchIndex));
            const mark = document.createElement("mark");
            mark.className = "search-highlight";
            mark.textContent = text.slice(matchIndex, matchIndex + query.length);
            fragment.appendChild(mark);
            position = matchIndex + query.length;
            matchIndex = lowerText.indexOf(lowerQuery, position);
        }

        fragment.append(text.slice(position));
        node.replaceWith(fragment);
    });

}


function updateChatSearch() {

    clearSearchHighlights();
    chatSearchIndex = -1;
    const query = document.getElementById("chat-search-input").value.trim();
    const rows = [...document.querySelectorAll("#messages .message-row")];

    if (!query) {
        chatSearchMatches = [];
        rows.forEach((row) => row.classList.remove("search-hidden", "search-current"));
        document.getElementById("chat-search-count").textContent = "0 из 0";
        document.getElementById("chat-search-prev").disabled = true;
        document.getElementById("chat-search-next").disabled = true;
        return;
    }

    const lowerQuery = query.toLocaleLowerCase();
    chatSearchMatches = rows.filter((row) =>
        row.querySelector(".message")?.textContent.toLocaleLowerCase().includes(lowerQuery)
    );
    const matchSet = new Set(chatSearchMatches);

    rows.forEach((row) => {
        const match = matchSet.has(row);
        row.classList.toggle("search-hidden", !match);
        row.classList.remove("search-current");
        if (match) {
            highlightSearchText(row.querySelector(".message"), query);
        }
    });

    if (chatSearchMatches.length) {
        chatSearchIndex = 0;
        chatSearchMatches[0].classList.add("search-current");
        scrollElementIntoViewSafely(chatSearchMatches[0], "center");
    }

    document.getElementById("chat-search-count").textContent = chatSearchMatches.length
        ? `1 из ${chatSearchMatches.length}`
        : "Нет совпадений";
    document.getElementById("chat-search-prev").disabled = !chatSearchMatches.length;
    document.getElementById("chat-search-next").disabled = !chatSearchMatches.length;

}


function navigateChatSearch(direction) {

    if (!chatSearchMatches.length) return;

    chatSearchMatches[chatSearchIndex]?.classList.remove("search-current");
    chatSearchIndex = (chatSearchIndex + direction + chatSearchMatches.length) % chatSearchMatches.length;
    const match = chatSearchMatches[chatSearchIndex];
    match.classList.add("search-current");
    scrollElementIntoViewSafely(match, "center");
    document.getElementById("chat-search-count").textContent =
        `${chatSearchIndex + 1} из ${chatSearchMatches.length}`;

}


function closeChatSearch() {

    const panel = document.getElementById("chat-search");
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    const searchButton = document.querySelector("[aria-label='Поиск по чату']");
    searchButton.setAttribute("aria-expanded", "false");
    searchButton.classList.remove("is-open");
    document.getElementById("chat-search-input").value = "";
    updateChatSearch();
    document.querySelector("[aria-label='Поиск по чату']").focus();

}


// Один общий AudioContext на все короткие сигналы: раньше на КАЖДЫЙ звук создавался
// новый контекст (дорогая операция, и браузер ограничивает их число — после
// нескольких десятков сообщений звук мог пропасть, а создание давало подтормаживание).
let uiSoundContext = null;

function playUiTone(frequency, durationSec) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) return;
    try {
        if (!uiSoundContext || uiSoundContext.state === "closed") uiSoundContext = new AudioContextConstructor();
        const ctx = uiSoundContext;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const oscillator = ctx.createOscillator();
        const volume = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        volume.gain.setValueAtTime(0.035, ctx.currentTime);
        volume.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);
        oscillator.connect(volume);
        volume.connect(ctx.destination);
        oscillator.start();
        oscillator.stop(ctx.currentTime + durationSec);
        oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
    } catch { /* звук необязателен */ }
}

function playSendSound() {
    playUiTone(660, 0.08);
}

// Ниже и чуть длиннее сигнала отправки — на слух легко отличить, кто написал.
function playReceiveSound() {
    playUiTone(460, 0.12);
}
function resizeComposer() {

    const input =
        document.getElementById("input");

    // scrollHeight читаем ОДИН раз после сброса высоты: прежний вариант читал
    // его повторно уже после записи style.height, и браузер вынужден был
    // делать второй синхронный пересчёт layout на каждое нажатие клавиши.
    input.style.height = "auto";
    const contentHeight = input.scrollHeight;
    input.style.height = `${Math.min(contentHeight, 120)}px`;
    input.style.overflowY = contentHeight > 120 ? "auto" : "hidden";

    // resizeComposer вызывается после каждой реальной смены состояния поля
    // ввода (набор текста, отправка, очистка) — заодно синхронизируем и
    // видимость панели форматирования, а не дублируем это в каждом месте,
    // где input.value обнуляется.
    if (typeof syncComposerFormatBar === "function") syncComposerFormatBar();

}


// Баннер "нет соединения" под шапкой чата — чисто информационный: реальное
// переподключение Realtime-каналов Supabase делает сама библиотека сама,
// это только видимый сигнал человеку, почему сообщения не долетают.
function updateConnectionBanner() {
    const banner = document.getElementById("connection-banner");
    if (banner) banner.hidden = navigator.onLine;
}
window.addEventListener("online", updateConnectionBanner);
window.addEventListener("offline", updateConnectionBanner);
updateConnectionBanner();

// Предупреждение при закрытии вкладки/перезагрузке с недописанным
// текстом — только когда автосохранение черновиков ОТКЛЮЧЕНО: если оно
// включено, текст и так переживёт закрытие (см. appSettings.saveDraft),
// а значит предупреждать не о чём.
window.addEventListener("beforeunload", (event) => {
    if (appSettings.saveDraft) return;
    const text = document.getElementById("input")?.value || "";
    if (text.trim().length < 20) return;
    event.preventDefault();
    event.returnValue = "";
});

function updateComposerAction() {

    const hasText =
        document.getElementById("input").value.trim().length > 0;

    const sendButton =
        document.getElementById("composer-send-button");

    document.querySelectorAll(".record-button").forEach((button) => {
        button.hidden = hasText;
    });
    sendButton.classList.toggle("visible", hasText);

}


// Мягкий лимит длины сообщения — как в Telegram (4096 символов): счётчик
// показывается только когда до лимита осталось немного, не отвлекая на
// коротких сообщениях, а при превышении блокирует отправку.
const MAX_MESSAGE_LENGTH = 4096;
const CHAR_COUNTER_SHOW_THRESHOLD = 150;

function updateComposerCharCounter() {

    const text = document.getElementById("input").value;
    const counter = document.getElementById("composer-char-counter");
    const remaining = MAX_MESSAGE_LENGTH - text.length;

    if (remaining > CHAR_COUNTER_SHOW_THRESHOLD) {
        counter.hidden = true;
        return false;
    }

    counter.hidden = false;
    counter.textContent = remaining < 0 ? `${-remaining}` : `${remaining}`;
    const overLimit = remaining < 0;
    counter.classList.toggle("over-limit", overLimit);
    counter.title = overLimit ? "Сообщение слишком длинное" : "Осталось символов";
    return overLimit;

}

// Caps Lock включён скорее всего по ошибке — показываем тихую подсказку
// рядом с полем ввода, а не молча переписываем то, что человек напечатал
// (вдруг это нарочный акроним) — см. обсуждение в задаче про 500 фич.
document.getElementById("input").addEventListener("keydown", (event) => {
    const capsOn = typeof event.getModifierState === "function" && event.getModifierState("CapsLock");
    document.getElementById("composer-input-box")?.classList.toggle("caps-lock-on", !!capsOn);
});
document.getElementById("input").addEventListener("blur", () => {
    document.getElementById("composer-input-box")?.classList.remove("caps-lock-on");
});

// Инлайн-калькулятор: если всё содержимое поля похоже на математическое
// выражение ("=2+2", "12*7"), показываем всплывающую подсказку с готовым
// результатом — тап по ней заменяет текст на сам результат.
let composerCalcResult = null;

function evaluateSimpleArithmetic(expr) {

    // Маленький safe-парсер +,-,*,/,(),десятичных чисел — без eval()/Function(),
    // источник — текст, который человек сам печатает в поле ввода.
    let pos = 0;

    function peek() { return expr[pos]; }
    function error() { throw new Error("bad expr"); }

    function parseNumber() {
        const start = pos;
        if (peek() === "-") pos++;
        let sawDigit = false;
        while (pos < expr.length && /[0-9]/.test(peek())) { pos++; sawDigit = true; }
        if (peek() === ".") { pos++; while (pos < expr.length && /[0-9]/.test(peek())) { pos++; sawDigit = true; } }
        if (!sawDigit) error();
        return parseFloat(expr.slice(start, pos));
    }

    function parseFactor() {
        if (peek() === "(") {
            pos++;
            const value = parseExpr();
            if (peek() !== ")") error();
            pos++;
            return value;
        }
        return parseNumber();
    }

    function parseTerm() {
        let value = parseFactor();
        while (peek() === "*" || peek() === "/") {
            const op = peek(); pos++;
            const rhs = parseFactor();
            value = op === "*" ? value * rhs : value / rhs;
        }
        return value;
    }

    function parseExpr() {
        let value = parseTerm();
        while (peek() === "+" || peek() === "-") {
            const op = peek(); pos++;
            const rhs = parseTerm();
            value = op === "+" ? value + rhs : value - rhs;
        }
        return value;
    }

    const result = parseExpr();
    if (pos !== expr.length) error();
    if (!Number.isFinite(result)) error();
    return result;

}

function updateComposerCalculatorHint() {

    const hint = document.getElementById("composer-calc-hint");
    const raw = document.getElementById("input").value.trim().replace(/^=/, "");

    // Хотя бы один оператор обязателен — иначе голое число "42" каждый раз
    // предлагало бы само себя как "результат", что бесполезно и навязчиво.
    if (!raw || !/[+\-*/]/.test(raw) || !/^[0-9.\s+\-*/()]+$/.test(raw)) {
        hint.hidden = true;
        composerCalcResult = null;
        return;
    }

    try {
        const result = evaluateSimpleArithmetic(raw.replace(/\s+/g, ""));
        composerCalcResult = result;
        hint.hidden = false;
        hint.textContent = `= ${result}`;
    } catch (error) {
        hint.hidden = true;
        composerCalcResult = null;
    }

}

function insertCalculatorResult() {
    if (composerCalcResult === null) return;
    const input = document.getElementById("input");
    input.value = String(composerCalcResult);
    document.getElementById("composer-calc-hint").hidden = true;
    resizeComposer();
    updateComposerAction();
    input.focus();
}


/* ЗАПИСЬ ГОЛОСОВЫХ И ВИДЕОСООБЩЕНИЙ */

let activeRecording = null;
const MAX_RECORDING_MS = 60000;


function formatRecordingTime(milliseconds) {

    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;

}


function setRecordingStatus(state, text) {

    const status = document.getElementById("recording-status");
    const label = document.getElementById("recording-status-text");
    const preview = document.getElementById("recording-preview");

    if (!state) {
        status.classList.remove("visible", "audio-recording", "video-recording");
        preview.pause();
        preview.srcObject = null;
        return;
    }

    status.classList.add("visible");
    status.classList.toggle("audio-recording", state.mode === "audio");
    status.classList.toggle("video-recording", state.mode === "video");
    // В панели — только время («00:07»); подписи вроде «Подключаем камеру…» — целиком.
    const timeOnly = /(\d\d:\d\d)\s*$/.exec(text);
    label.textContent = timeOnly ? timeOnly[1] : text;

    // Пока идёт подключение второй камеры, recordStream ещё не готов —
    // в превью на это время просто временно показывается сырая фронталка,
    // а как только (если) готов композит с PiP — превью переключается на
    // него же, то есть видно ровно то, что реально пишется в файл.
    const previewStream = state.recordStream || state.stream;
    if (state.mode === "video" && previewStream && preview.srcObject !== previewStream) {
        preview.srcObject = previewStream;
        preview.play().catch(() => {});
    }

}


function resetRecordingState(state) {

    if (state.timer) {
        clearInterval(state.timer);
    }

    state.button.classList.remove("recording");
    state.button.setAttribute("aria-pressed", "false");

    if (activeRecording === state) {
        activeRecording = null;
        setRecordingStatus(null);
        document.body.classList.remove("recording-active", "recording-cancel-armed", "recording-lock-armed", "recording-locked");
        document.body.style.removeProperty("--record-drag-x");
        document.body.style.removeProperty("--record-drag-lock-y");
        document.getElementById("record-stop-locked-btn").hidden = true;
        document.getElementById("record-cancel-locked-btn").hidden = true;
        document.getElementById("recording-status")?.classList.remove("locked");
        stopRecordingMeter(state);
        const ringEl = document.getElementById("rec-ring-progress");
        if (ringEl) ringEl.style.strokeDashoffset = "295";
    }

}

// Живая волна по реальному уровню микрофона: 12 столбиков, каждый кадр сдвигаем
// историю громкости (новое значение справа) — волна «бежит», как в Telegram.
const REC_WAVE_BARS = 12;

function startRecordingMeter(state) {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const track = state.stream?.getAudioTracks()[0];
        if (!AudioContextClass || !track) return;
        const ctx = new AudioContextClass();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        source.connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const bars = [...document.querySelectorAll("#recording-wave span")];
        const history = new Array(REC_WAVE_BARS).fill(0.12);
        let lastPush = 0;
        let frame = 0;
        const tick = (now) => {
            frame = requestAnimationFrame(tick);
            if (now - lastPush < 70) return;
            lastPush = now;
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
            const level = Math.min(1, Math.sqrt(sum / data.length) * 5);
            history.push(Math.max(0.12, level));
            history.shift();
            bars.forEach((bar, i) => { bar.style.transform = `scaleY(${history[i].toFixed(2)})`; });
        };
        frame = requestAnimationFrame(tick);
        state.meter = { ctx, source, stop: () => { cancelAnimationFrame(frame); try { source.disconnect(); } catch {} ctx.close?.().catch(() => {}); } };
        document.getElementById("recording-wave")?.classList.add("live");
    } catch { /* без живой волны — останется анимация-заглушка */ }
}

function stopRecordingMeter(state) {
    state?.meter?.stop();
    if (state) state.meter = null;
    const wave = document.getElementById("recording-wave");
    if (wave) { wave.classList.remove("live"); wave.querySelectorAll("span").forEach((bar) => { bar.style.transform = ""; }); }
}

function activeRecordingPointerId() {
    return activeRecording ? activeRecording.pointerId : -1;
}


function stopRecordingTracks(state) {

    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;

    state.dualCamera?.cleanup();
    state.dualCamera = null;
    state.recordStream = null;

}


/* ДВОЙНАЯ КАМЕРА ДЛЯ ВИДЕО-КРУЖКОВ (как в BeReal): задняя камера на весь
   кадр + фронтальная маленьким кружком-PiP поверх. Веб не умеет писать
   два видеотрека одним файлом — поэтому оба потока рисуются каждый кадр
   на offscreen-canvas, и пишется именно канвас (canvas.captureStream), а
   не исходные камеры. На iOS Safari вторую камеру открыть нельзя физически
   (getUserMedia отдаёт только одну одновременно) — в этом случае (и на
   любой другой ошибке/таймауте) просто возвращаем null, и startRecording
   остаётся на одной фронтальной камере, как было до этой фичи. */

const DUAL_CAMERA_ENABLED = false;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
    ]);
}

function drawVideoCover(ctx, video, dx, dy, dw, dh) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(dw / vw, dh / vh);
    const sw = dw / scale, sh = dh / scale;
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
}

async function trySetupDualCamera(state) {

    try {

        const gumPromise = navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment" } });
        const backStream = await withTimeout(gumPromise, 2500);

        // Если промис выше подождали по таймауту, а он всё же позже
        // разрешится САМ — на нём останется включённая камера, про которую
        // мы уже "забыли". Подчищаем на всякий случай отдельно.
        gumPromise.then((lateStream) => {
            if (lateStream !== backStream) lateStream.getTracks().forEach((track) => track.stop());
        }).catch(() => {});

        if (activeRecording !== state || state.stopRequested) {
            backStream.getTracks().forEach((track) => track.stop());
            return null;
        }

        if (typeof HTMLCanvasElement.prototype.captureStream !== "function") {
            backStream.getTracks().forEach((track) => track.stop());
            return null;
        }

        const frontVideoEl = document.createElement("video");
        frontVideoEl.muted = true;
        frontVideoEl.playsInline = true;
        frontVideoEl.srcObject = state.stream;

        const backVideoEl = document.createElement("video");
        backVideoEl.muted = true;
        backVideoEl.playsInline = true;
        backVideoEl.srcObject = backStream;

        await withTimeout(Promise.all([frontVideoEl.play(), backVideoEl.play()]), 2000);

        const SIZE = 480;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");

        let rafId = null;
        const drawFrame = () => {

            drawVideoCover(ctx, backVideoEl, 0, 0, SIZE, SIZE);

            const pipSize = SIZE * 0.32;
            const pipX = SIZE - pipSize - 14;
            const pipY = SIZE - pipSize - 14;

            ctx.save();
            ctx.beginPath();
            ctx.arc(pipX + pipSize / 2, pipY + pipSize / 2, pipSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            ctx.translate(pipX + pipSize, pipY); // зеркалим фронталку — как в привычном живом превью
            ctx.scale(-1, 1);
            drawVideoCover(ctx, frontVideoEl, 0, 0, pipSize, pipSize);
            ctx.restore();

            ctx.beginPath();
            ctx.arc(pipX + pipSize / 2, pipY + pipSize / 2, pipSize / 2, 0, Math.PI * 2);
            ctx.lineWidth = 4;
            ctx.strokeStyle = "#fff";
            ctx.stroke();

            rafId = requestAnimationFrame(drawFrame);

        };
        drawFrame();

        const canvasStream = canvas.captureStream(30);
        const micTrack = state.stream.getAudioTracks()[0];
        const combinedStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...(micTrack ? [micTrack] : [])
        ]);

        return {
            combinedStream,
            cleanup: () => {
                if (rafId) cancelAnimationFrame(rafId);
                backStream.getTracks().forEach((track) => track.stop());
                frontVideoEl.srcObject = null;
                backVideoEl.srcObject = null;
            }
        };

    } catch {
        return null;
    }

}


function getRecordingOptions(mode) {

    const candidates = mode === "video"
        ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

    const mimeType = typeof MediaRecorder.isTypeSupported === "function"
        ? candidates.find((type) => MediaRecorder.isTypeSupported(type))
        : null;
    return mimeType ? { mimeType } : undefined;

}


async function startRecording(button, event) {

    if (activeRecording) return;

    if (currentChatIsSecret) {
        toast("Голосовые и видео-кружки в секретных чатах пока не поддерживаются");
        return;
    }

    event.preventDefault();
    const state = {
        button,
        mode: button.dataset.recordMode,
        // Запись всегда принадлежит тому чату и ответу, которые были выбраны
        // в момент нажатия. Переключение чата во время записи не должно
        // перенаправить уже записанное сообщение в новую переписку.
        chatId: currentChatId || null,
        replyToId: pendingReply?.messageId || null,
        pointerId: event.pointerId ?? -1,
        stopRequested: false,
        pressedAt: Date.now(),
        stream: null,
        recorder: null,
        chunks: [],
        startedAt: 0,
        timer: null,
        // Жесты во время удержания: проведение влево — отмена (по факту
        // подтверждается только на отпускании, пока палец слева от порога —
        // "cancelArmed"), проведение вверх — блокировка (запись продолжается
        // без удержания пальца, остановка только явным тапом по кнопке).
        startX: event.clientX ?? 0,
        startY: event.clientY ?? 0,
        cancelArmed: false,
        locked: false,
        cancelled: false
    };

    activeRecording = state;
    button.classList.add("recording");
    button.setAttribute("aria-pressed", "true");
    document.body.classList.add("recording-active");
    setRecordingStatus(
        state,
        state.mode === "video" ? "Подключаем камеру…" : "Подключаем микрофон…"
    );

    if (event.pointerId !== undefined) {
        try {
            button.setPointerCapture(event.pointerId);
        } catch {
            // Capture may fail if the pointer ended while permission was pending.
        }
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        resetRecordingState(state);
        toast("Запись недоступна в этом браузере или контексте");
        return;
    }

    try {
        const constraints = state.mode === "video"
            ? { audio: true, video: { facingMode: "user" } }
            : { audio: true };

        state.stream = await navigator.mediaDevices.getUserMedia(constraints);

        if (activeRecording !== state || state.stopRequested) {
            stopRecordingTracks(state);
            resetRecordingState(state);
            return;
        }

        // Видео-кружок — пробуем ещё и заднюю камеру разом с фронтальной
        // (как BeReal): если получилось, пишем не сырой поток фронталки, а
        // скомпонованный канвас (задняя камера на весь кадр + фронталка
        // кружком-picture-in-picture в углу). Не вышло (типично для iOS
        // Safari — там физически нельзя открыть две камеры одновременно) —
        // тихо остаёмся на одной фронтальной камере, как и было раньше.
        state.recordStream = state.stream;
        // Двойная камера (BeReal) выключена: на компьютере с одной веб-камерой «задняя»
        // камера — та же самая, и в углу кружка рисовалось пустое колечко-дубликат.
        // Видеокружок — чистая фронтальная камера, как в Telegram.
        if (state.mode === "video" && DUAL_CAMERA_ENABLED) {
            state.dualCamera = await trySetupDualCamera(state);
            if (state.dualCamera) {
                state.recordStream = state.dualCamera.combinedStream;
            }
        }

        if (activeRecording !== state || state.stopRequested) {
            stopRecordingTracks(state);
            resetRecordingState(state);
            return;
        }

        const options = getRecordingOptions(state.mode);
        state.recorder = options
            ? new MediaRecorder(state.recordStream, options)
            : new MediaRecorder(state.recordStream);

        state.recorder.addEventListener("dataavailable", (recordEvent) => {
            if (recordEvent.data?.size) {
                state.chunks.push(recordEvent.data);
            }
        });

        state.recorder.addEventListener("stop", () => {
            const mimeType = state.recorder.mimeType ||
                (state.mode === "video" ? "video/webm" : "audio/webm");
            const blob = new Blob(state.chunks, { type: mimeType });
            const duration = state.startedAt ? Date.now() - state.startedAt : 0;
            const wasCancelled = state.cancelled;

            stopRecordingTracks(state);
            resetRecordingState(state);

            if (wasCancelled) {
                toast("Запись отменена");
            } else if (blob.size && duration >= 300) {
                if (state.chatId) {
                    sendRealRecording(blob, state.mode, duration, state.chatId, state.replyToId);
                } else if (!currentChatId) {
                    appendRecordedMedia(blob, state.mode, duration);
                } else {
                    toast("Запись оставлена в исходном чате");
                }
            } else if (duration > 0) {
                toast("Удерживайте кнопку дольше, чтобы записать сообщение");
            }
        });

        state.recorder.addEventListener("error", () => {
            stopRecordingTracks(state);
            resetRecordingState(state);
            toast("Не удалось записать сообщение");
        });

        state.recorder.start(200);
        state.startedAt = Date.now();
        startRecordingMeter(state);
        setRecordingStatus(
            state,
            `${state.mode === "video" ? "Видеокружок" : "Запись"} 00:00`
        );

        const modeLabel = state.mode === "video" ? "Видеокружок" : "Запись";
        state.timer = setInterval(() => {
            const elapsed = Date.now() - state.startedAt;
            setRecordingStatus(state, `${modeLabel} ${formatRecordingTime(elapsed)}`);
            const ring = document.getElementById("rec-ring-progress");
            if (ring) ring.style.strokeDashoffset = String(295 * (1 - Math.min(1, elapsed / MAX_RECORDING_MS)));

            if (elapsed >= MAX_RECORDING_MS) {
                stopRecording(state.pointerId, false, true);
            }
        }, 200);

        setRecordingStatus(state, `${modeLabel} 00:00`);
    } catch (error) {
        stopRecordingTracks(state);
        resetRecordingState(state);
        const message = error.name === "NotAllowedError" || error.name === "PermissionDeniedError"
            ? "Разрешите доступ к микрофону или камере в браузере"
            : "Не удалось начать запись";
        toast(message);
    }

}


// forceStop — вызов с явной кнопки "остановить" в заблокированном режиме
// (там pointerId уже ни при чём — палец давно отпущен), обходит защиту
// "заблокировано — отпускание пальца не останавливает запись" ниже.
const RECORD_CANCEL_THRESHOLD_X = -80;
const RECORD_LOCK_THRESHOLD_Y = -60;

// Жест во время удержания кнопки записи: проведение влево вооружает отмену
// (решается на отпускании, не здесь — resistance/snap, а не мгновенный обрыв
// записи ещё до того, как человек понял, что промахнулся), проведение
// вверх сразу блокирует запись (руки свободны, дальше только явный тап по
// кнопке остановки). Приоритет — вертикали: небольшое дрожание влево при
// явном вертикальном свайпе не должно случайно засчитаться отменой.
function handleRecordingPointerMove(button, event) {

    const state = activeRecording;
    if (!state || state.button !== button || state.locked) return;
    if (state.pointerId !== -1 && event.pointerId !== state.pointerId) return;

    const dx = Math.min(0, (event.clientX ?? state.startX) - state.startX);
    const dy = Math.min(0, (event.clientY ?? state.startY) - state.startY);

    if (dy <= RECORD_LOCK_THRESHOLD_Y && Math.abs(dy) > Math.abs(dx)) {
        lockRecording(state);
        return;
    }

    const clampedX = Math.max(dx, RECORD_CANCEL_THRESHOLD_X * 1.4);
    document.body.style.setProperty("--record-drag-x", `${clampedX}px`);
    document.body.style.setProperty("--record-drag-lock-y", `${Math.max(dy, RECORD_LOCK_THRESHOLD_Y * 1.4)}px`);

    state.cancelArmed = dx <= RECORD_CANCEL_THRESHOLD_X;
    document.body.classList.toggle("recording-cancel-armed", state.cancelArmed);
    document.body.classList.toggle("recording-lock-armed", dy <= RECORD_LOCK_THRESHOLD_Y * 0.5);

}

function lockRecording(state) {

    state.locked = true;
    document.body.classList.add("recording-locked");
    document.body.classList.remove("recording-cancel-armed", "recording-lock-armed");
    document.body.style.removeProperty("--record-drag-x");
    document.body.style.removeProperty("--record-drag-lock-y");
    document.getElementById("record-stop-locked-btn").hidden = false;
    document.getElementById("record-cancel-locked-btn").hidden = false;
    document.getElementById("recording-status")?.classList.add("locked");

    if (state.pointerId !== -1) {
        try { state.button.releasePointerCapture(state.pointerId); } catch { /* уже отпущен системой — не критично */ }
    }
    if (navigator.vibrate) {
        try { navigator.vibrate(10); } catch { /* iOS Safari: API отсутствует */ }
    }

}

function stopRecording(pointerId, cancel, forceStop) {

    const state = activeRecording;
    if (!state || (pointerId !== undefined && pointerId !== -1 && state.pointerId !== pointerId)) return;

    // Заблокированная запись (жест "вверх") продолжается после отпускания
    // пальца — остановить её может только явный тап по кнопке остановки.
    if (state.locked && !forceStop) return;

    state.stopRequested = true;
    if (cancel) state.cancelled = true;

    if (state.recorder?.state === "recording") {
        state.recorder.stop();
    } else if (!state.recorder) {
        stopRecordingTracks(state);
        resetRecordingState(state);
    }

}


function appendRecordedMedia(blob, mode, duration) {

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

    const media = document.createElement(mode === "video" ? "video" : "audio");
    media.className = mode === "video" ? "message-video" : "message-audio";
    media.controls = true;
    media.preload = "metadata";
    media.src = URL.createObjectURL(blob);

    if (mode === "video") {
        media.playsInline = true;
    }

    bubble.appendChild(media);

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });

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
    updateChatListPreview(
        mode === "video" ? "📹 Видеосообщение" : "🎤 Голосовое сообщение",
        time.firstChild.textContent
    );

    if (appSettings.autoScroll) {
        messages.scrollTop = messages.scrollHeight;
    }

    if (appSettings.sendSound) {
        playSendSound();
    }

}


/* МЕНЮ ВЛОЖЕНИЙ ("+" в поле ввода) */

function toggleAttachMenu(button) {

    const menu = document.getElementById("attach-menu");
    const shouldOpen = !menu.classList.contains("open");

    closeAttachMenu();

    if (shouldOpen) {
        menu.classList.add("open");
        button.setAttribute("aria-expanded", "true");
        button.classList.add("is-open");
    }

}


function closeAttachMenu() {

    const menu = document.getElementById("attach-menu");
    const button = document.querySelector('.input-button[aria-label="Прикрепить файл"]');

    menu.classList.remove("open");
    button?.setAttribute("aria-expanded", "false");
    button?.classList.remove("is-open");

}


function triggerAttachPick(kind) {

    closeAttachMenu();

    const inputId = {
        media: "attach-media-input",
        document: "attach-document-input",
        music: "attach-music-input"
    }[kind];

    document.getElementById(inputId)?.click();

}

function triggerP2PFilePick() {

    closeAttachMenu();

    if (!isP2PFileTransferSupported()) {
        toast("Доступно только в Chrome/Edge на компьютере");
        return;
    }

    document.getElementById("attach-p2p-input")?.click();

}

function handleP2PFileSelect(input) {
    const file = input.files?.[0];
    input.value = ""; // чтобы повторный выбор того же файла снова сработал
    if (file) sendP2PFile(file);
}

