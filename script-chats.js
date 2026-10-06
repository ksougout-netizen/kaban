/* ============================================================================
   Этот файл — одна из частей script.js, разбитого на несколько файлов для
   удобства навигации (раньше был единый файл ~350КБ/8300+ строк). Порядок
   подключения в index.html ВАЖЕН и должен точно совпадать с исходным
   порядком кода — файлы выполняются последовательно, как один конкатенированный
   скрипт, функции между ними не изолированы (нет import/export, всё в общей
   глобальной области видимости, как и раньше).
   ============================================================================ */
/* ============================================================================
   БРАУЗЕРНЫЕ УВЕДОМЛЕНИЯ: новое сообщение, пока вкладка свёрнута/не в
   фокусе (через обычный Notification API — работает только пока страница
   открыта, см. notifyIncomingMessage ниже) — и НАСТОЯЩИЙ push через Service
   Worker (sw.js), который приходит, даже если вкладка/браузер закрыты (см.
   setupPushSubscription/send-push Edge Function). Разрешение спрашиваем
   один раз при входе — без него браузер молча ничего не показывает, не
   мешаем, если человек откажет.
   ========================================================================= */

// Публичный VAPID-ключ — безопасно хранить прямо в клиентском коде (как и
// anon key Supabase): он ТОЛЬКО удостоверяет push-подписку конкретному
// сервису доставки (FCM/Mozilla push), сам по себе ничего не расшифровывает
// и не даёт слать что-либо от чужого имени — это может только приватный
// ключ, который лежит исключительно в секретах Edge Function на сервере.
const VAPID_PUBLIC_KEY = "BM7SaayHK0Sjv0hr8KgmC43fPIVq-xA3pBpUUn1PFOCXxiBy95q07RGsSGXng8qFAf2yZLbi6Uge21pU9kSZufo";

function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Регистрирует Service Worker (если ещё не зарегистрирован) и оформляет
// push-подписку браузера, сохраняя её в push_subscriptions — вызывать
// только после того, как разрешение на уведомления уже получено (без него
// pushManager.subscribe() всё равно откажет).
async function setupPushSubscription() {

    // Программа для ПК получает сообщения сама (живёт в трее) — веб-push ей не нужен.
    if (window.kabanDesktop) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

    try {
        const registration = await navigator.serviceWorker.register("sw.js");
        await navigator.serviceWorker.ready;

        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }

        const json = subscription.toJSON();
        await KabanAPI.savePushSubscription({
            endpoint: json.endpoint,
            p256dh: json.keys.p256dh,
            auth: json.keys.auth
        });
    } catch (error) {
        console.warn("Не удалось оформить push-подписку", error);
    }

}

function requestNotificationPermission() {

    if (typeof Notification === "undefined") return;

    if (Notification.permission === "default") {
        Notification.requestPermission().then((permission) => {
            if (permission === "granted") setupPushSubscription();
        }).catch(() => {});
    } else if (Notification.permission === "granted") {
        // Разрешение уже было выдано раньше — подписки на push при этом
        // могло и не быть (например, после очистки данных браузера или на
        // новом устройстве), поэтому просто убеждаемся, что она живая.
        setupPushSubscription();
    }

}

// Клик по push-уведомлению, когда приложение уже открыто в какой-то
// вкладке — sw.js фокусирует её и присылает сюда chatId вместо того, чтобы
// открывать новую вкладку (см. notificationclick в sw.js).
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "open-chat" && event.data.chatId) {
            openRealChat(event.data.chatId);
        }
    });
}

function notifyIncomingMessage({ chatId, senderName, text, avatarUrl }) {

    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.hasFocus() && !document.hidden) return; // вкладка и так на виду — не дублируем
    // Заглушённый чат не должен всплывать уведомлениями.
    if (cachedChatRows.find((row) => row.chat_id === chatId)?.is_muted) return;

    let body = text || "Новое сообщение";
    if (body.length > 120) body = body.slice(0, 117) + "…";

    let notification;
    try {
        notification = new Notification(senderName || "Новое сообщение", {
            body,
            icon: avatarUrl || undefined,
            tag: `kaban-chat-${chatId}` // новое сообщение в том же чате заменяет предыдущее уведомление, а не копится стопкой
        });
    } catch (error) {
        return; // некоторые окружения (например, без установленного разрешения на ОС) кидают исключение прямо в конструкторе
    }

    notification.onclick = () => {
        window.focus();
        if (currentChatId !== chatId) openRealChat(chatId);
        notification.close();
    };

}

/* ============================================================================
   ОНЛАЙН-СТАТУС ("в сети" / "был(а) N минут назад"): простой heartbeat
   поверх users.is_online/last_seen — раз при входе, дальше по таймеру,
   пока вкладка активна, плюс сразу при сворачивании/уходе. Отдельно от
   этого — realtime-presence на конкретный ОТКРЫТЫЙ чат (см. openRealChat)
   даёт мгновенное "в сети"/"печатает…" без ожидания heartbeat-тика.
   ========================================================================= */

let presenceHeartbeatInterval = null;
let presenceTickInterval = null;
let lastReportedPresence = null;
let globalPresenceHandle = null;

// Кто СЕЙЧАС в сети — по общему realtime-каналу (см. KabanAPI.joinGlobalPresence).
// Пока канал не прислал первое состояние, статус берётся из users.is_online.
let globalOnlineIds = new Set();
let globalPresenceReady = false;
// Когда человек пропал из канала — запоминаем момент, чтобы сразу показать
// "был(а) только что", не дожидаясь, пока last_seen долетит из базы.
const lastSeenOverride = new Map();
let presenceUIFrame = 0;

function startPresenceHeartbeat() {

    if (presenceHeartbeatInterval) return;

    KabanAPI.updateMyPresence(true).catch(() => {});
    lastReportedPresence = true;
    presenceHeartbeatInterval = setInterval(() => {
        const visible = document.visibilityState === "visible";
        // Скрытая вкладка: «не в сети» уже записано при сворачивании — не повторяем
        // запись в базу каждые 45 секунд, пока вкладка просто висит в фоне.
        if (!visible && lastReportedPresence === false) return;
        lastReportedPresence = visible;
        KabanAPI.updateMyPresence(visible).catch(() => {});
    }, 45000);

    globalPresenceHandle = KabanAPI.joinGlobalPresence({
        onChange: (online) => {
            globalOnlineIds = online;
            globalPresenceReady = true;
            schedulePresenceUIRefresh();
        },
        onLeave: (userId) => {
            lastSeenOverride.set(userId, new Date().toISOString());
            schedulePresenceUIRefresh();
        }
    });

    // Раз в полминуты перерисовываем «был(а) N мин. назад» — иначе подпись
    // застывала бы на том значении, что было при открытии чата.
    presenceTickInterval = setInterval(schedulePresenceUIRefresh, 30000);

}

function stopPresenceHeartbeat() {
    if (presenceHeartbeatInterval) {
        clearInterval(presenceHeartbeatInterval);
        presenceHeartbeatInterval = null;
    }
    if (presenceTickInterval) {
        clearInterval(presenceTickInterval);
        presenceTickInterval = null;
    }
    if (globalPresenceHandle) {
        globalPresenceHandle.unsubscribe();
        globalPresenceHandle = null;
    }
    globalOnlineIds = new Set();
    globalPresenceReady = false;
    lastSeenOverride.clear();
}

// Последний раз в сети: самое свежее из значения в базе и момента, когда мы
// сами увидели, что человек пропал.
function lastSeenOf(user) {
    const stored = user?.last_seen || null;
    const override = user?.id ? lastSeenOverride.get(user.id) : null;
    if (!override) return stored;
    if (!stored) return override;
    return new Date(override) > new Date(stored) ? override : stored;
}

// Все места, где показан онлайн-статус, обновляются одной пачкой за кадр.
function schedulePresenceUIRefresh() {
    if (presenceUIFrame) return;
    presenceUIFrame = requestAnimationFrame(() => {
        presenceUIFrame = 0;
        refreshPresenceUI();
    });
}

function refreshPresenceUI() {

    // Шапка открытого личного чата (кроме "печатает…").
    if (currentChatId && currentChatType !== "group" && currentOtherUserId && !currentChatIsSecret) {
        const meta = cachedChatRows.find((row) => row.chat_id === currentChatId);
        const other = meta?.otherUser;
        const statusEl = document.querySelector(".person-status");
        if (other && !other.is_bot && statusEl && !statusEl.classList.contains("is-typing")) {
            renderChatHeaderStatus({ online: isUserEffectivelyOnline(other), lastSeen: lastSeenOf(other) });
        }
    }

    // Список чатов и контакты.
    if (typeof refreshChatListLocally === "function") refreshChatListLocally();
    if (document.body.classList.contains("mobile-tab-contacts") && typeof renderContactsList === "function") renderContactsList();

    // Окно «Информация о группе».
    if (document.getElementById("group-info-backdrop")?.classList.contains("open")) renderGroupInfoModal();

}

document.addEventListener("visibilitychange", () => {
    if (!presenceHeartbeatInterval) return; // не залогинены в настоящий аккаунт
    const visible = document.visibilityState === "visible";
    globalPresenceHandle?.setVisible(visible);
    lastReportedPresence = visible;
    KabanAPI.updateMyPresence(visible).catch(() => {});
});

window.addEventListener("pagehide", () => {
    if (!presenceHeartbeatInterval) return;
    KabanAPI.updateMyPresenceOnExit();
});
function restoreDemoState() {
    document.getElementById("demo-chat-section").hidden = false;
    document.getElementById("sidebar-empty-chats").hidden = true;
    document.getElementById("real-chat-list").hidden = true;
    document.getElementById("real-chat-list").innerHTML = "";
    document.getElementById("chat-folders").hidden = true;
    activeChatFolder = "all";
    isShowingArchivedChats = false;
    document.getElementById("unified-search-results").hidden = true;
    document.getElementById("unified-search-results").innerHTML = "";
    document.getElementById("search-clear-btn").hidden = true;
    document.getElementById("search").value = "";
    document.getElementById("tab-quick-menu-backdrop").hidden = true;
    // Вкладка "Контакты" (и её поиск) — отдельное от обычного списка чатов
    // состояние, его тоже нужно подчищать при выходе: иначе следующий
    // человек, вошедший на этом же устройстве, на секунду увидит чужой
    // недопечатанный запрос и чужие результаты поиска контактов.
    document.getElementById("contacts-search").value = "";
    document.getElementById("contacts-search-results").hidden = true;
    document.getElementById("contacts-search-results").innerHTML = "";
    document.getElementById("contacts-list").innerHTML = "";
    document.getElementById("contacts-empty").hidden = true;
    profileFormSnapshot = null;
    document.querySelector(".profile-name").textContent = "Мой профиль";
    document.body.classList.remove("chat-selected");
    document.body.classList.remove("mobile-tab-contacts", "mobile-tab-calls");
    document.querySelectorAll(".bottom-nav-item").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === "chats");
    });
    document.title = "KABAN";
    // Снимок списка чатов и кэши истории/участников — данные ПРЕДЫДУЩЕГО аккаунта:
    // следующий человек на этом устройстве не должен их увидеть ни на мгновение.
    try { if (myRealUserId) localStorage.removeItem(chatListSnapshotKey()); } catch { /* недоступно */ }
    chatMessageCache.clear();
    prefetchedMessages.clear();
    groupMembersCache.clear();
    pendingReadIds.clear();
    realMessagesById = new Map();
    const listEl = document.getElementById("real-chat-list");
    if (listEl) listEl._headerKey = null;
    cachedChatRows = [];
    currentChatId = null;
    cachedMyProfile = null;
    syncAccountSection();

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
    currentOtherUserId = null;
    currentChatType = "direct";
    currentChatMembersById = new Map();
    currentChatIsSecret = false;
    myRealUserId = null;
    updateCallHistoryBadge();
    stopPresenceHeartbeat();
    if (typeof stopStories === "function") stopStories();
    if (typeof stopReminders === "function") stopReminders();
    if (typeof listenShutdown === "function") listenShutdown();
    if (typeof voiceShutdown === "function") voiceShutdown();
    stopInboxSubscription();
    stopCallInbox();
    stopFileInbox();
    stopScreenInbox();
    if (activeScreenShare) stopScreenShare("logout");
    if (pendingScreenOffer) declineScreenShare(true);
    stopGroupCallInbox();
    if (activeGroupCall) leaveGroupCall("logout");
    if (pendingGroupCallInvite) declineGroupCallInvite();
    stopGroupCallBanner();
    teardownActiveCall();
}


/* ============================================================================
   ПРОФИЛЬ: отдельный экран (докнутая справа панель, тот же формат, что у
   карточки собеседника — см. #profile-screen-backdrop в index.html),
   открывается кликом по своему имени/аватару в сайдбаре. Эмодзи-статус —
   по образцу Telegram, показывается и в сайдбаре, и у собеседников в
   списке чатов/поиске.
   ========================================================================= */

let cachedMyProfile = null;

const STATUS_EMOJIS = ["🔥","💤","📚","🎧","✈️","☕","🎮","💻","😴","❤️","🥳","🏃","🌙","☀️","🎉","😅","🤫","🚀","🎨","📵"];

/* ЗВУК ДЛЯ КОНКРЕТНОГО ЧАТА: тоже локальная настройка просмотра (как и
   обои ниже) — независимый выключатель поверх общего appSettings.receiveSound
   (Настройки → Звук при получении). Оба должны быть включены, чтобы звук
   реально проигрался — см. оба места вызова playReceiveSound(). */

function chatSoundStorageKey(chatId) {
    return "kaban-chat-sound:" + chatId;
}

function isChatSoundEnabled(chatId) {
    if (!chatId) return true;
    // Чат с отключёнными уведомлениями (🔕 в списке) раньше всё равно звенел.
    if (cachedChatRows.find((row) => row.chat_id === chatId)?.is_muted) return false;
    try {
        return localStorage.getItem(chatSoundStorageKey(chatId)) !== "off";
    } catch {
        return true;
    }
}

function setChatSoundEnabled(chatId, enabled) {
    try {
        if (enabled) localStorage.removeItem(chatSoundStorageKey(chatId));
        else localStorage.setItem(chatSoundStorageKey(chatId), "off");
    } catch (error) {
        console.warn("Не удалось сохранить настройку звука чата", error);
    }
}

// Карточка собеседника держит кнопки "Уведомления"/"Звук" как статический
// HTML по умолчанию (aria-pressed="true" и т.п.) — без этой синхронизации
// при каждом открытии чата они показывали бы одно и то же вне зависимости
// от того, замьючен ли РЕАЛЬНО этот конкретный чат.
function syncNotificationActionState(chatId) {

    const row = cachedChatRows.find((r) => r.chat_id === chatId);

    const notifBtn = document.querySelector('[data-profile-toggle="notifications"]');
    if (notifBtn) {
        const muted = !!row?.is_muted;
        notifBtn.setAttribute("aria-pressed", String(!muted));
        const hint = notifBtn.querySelector(".info-action-hint");
        if (hint) hint.textContent = muted ? "Отключены" : "Включены";
    }

    const soundBtn = document.querySelector('[data-profile-toggle="sound"]');
    if (soundBtn) {
        const soundOn = isChatSoundEnabled(chatId);
        soundBtn.setAttribute("aria-pressed", String(soundOn));
        const hint = soundBtn.querySelector(".info-action-hint");
        if (hint) hint.textContent = soundOn ? "Стандартный" : "Без звука";
    }

}


/* ОБОИ ЧАТА: свой мягкий фон для КОНКРЕТНОГО чата, хранится только в
   localStorage этого браузера (не синхронизируется между устройствами и не
   виден собеседнику — чисто личная настройка просмотра). color-mix с var(--bg)
   вместо конкретных hex-цветов — чтобы один и тот же набор обоев корректно
   выглядел и в светлой, и в тёмной теме без отдельных вариантов на каждую. */

// Обои задаются в script-core.js (WALLPAPERS). Для каждого чата можно выбрать
// свои; без выбора действуют общие из «Оформления» (appSettings.chatWallpaper).
// "default" в хранилище чата = явно «без обоев».

function chatWallpaperStorageKey(chatId) {
    return "kaban-chat-wallpaper:" + chatId;
}

// Свой выбор для чата либо null (значит — как везде).
function getChatWallpaperId(chatId) {
    try {
        return localStorage.getItem(chatWallpaperStorageKey(chatId));
    } catch {
        return null;
    }
}

function applyChatWallpaper(chatId) {

    const ownId = getChatWallpaperId(chatId);
    const wallpaper = findWallpaper(ownId || appSettings.chatWallpaper || "default");

    // Обои — на всю область чата (а не только на ленту сообщений): иначе над
    // лентой оставалась полоса без обоев, цвета фона приложения.
    const chatArea = document.querySelector(".chat-area");
    if (chatArea) {
        // Обои рисуются отдельным слоем (.chat-area::before) — он плавно дрейфует
        // и сдвигается за курсором, не перерисовывая ленту сообщений.
        chatArea.style.removeProperty("background");
        if (wallpaper.css) chatArea.style.setProperty("--wp", wallpaper.css);
        else chatArea.style.removeProperty("--wp");
        chatArea.classList.toggle("has-wallpaper", !!wallpaper.css);
    }

    const hint = document.getElementById("chat-wallpaper-hint");
    // Что именно сейчас стоит: свои обои чата — их название; иначе общие из «Оформления».
    if (hint) hint.textContent = ownId ? wallpaper.label : (wallpaper.id === "default" ? "Без обоев" : `${wallpaper.label} · общие`);

}

function openChatWallpaperPicker() {

    if (!currentChatId) return;

    const ownId = getChatWallpaperId(currentChatId);
    const inherited = findWallpaper(appSettings.chatWallpaper || "default");
    const grid = document.getElementById("chat-wallpaper-grid");
    grid.className = "wp-grid";
    grid.innerHTML =
        wallpaperTileHTML(inherited, !ownId, "setChatWallpaper('inherit')", "Общие")
        + WALLPAPERS.filter((w) => !w.hidden)
            .map((w) => wallpaperTileHTML(w, ownId === w.id, `setChatWallpaper('${w.id}')`, w.label))
            .join("");

    const backdrop = document.getElementById("chat-wallpaper-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function setChatWallpaper(wallpaperId) {

    if (!currentChatId) return;

    try {
        if (wallpaperId === "inherit") {
            localStorage.removeItem(chatWallpaperStorageKey(currentChatId));
        } else {
            localStorage.setItem(chatWallpaperStorageKey(currentChatId), wallpaperId);
        }
    } catch (error) {
        console.warn("Не удалось сохранить обои чата", error);
    }

    applyChatWallpaper(currentChatId);
    closeChatWallpaperPicker();

}
function closeChatWallpaperPicker() {
    const backdrop = document.getElementById("chat-wallpaper-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}


function renderProfileName(name, statusEmoji) {
    const el = document.querySelector(".profile-name");
    if (!el) return;
    el.innerHTML = escapeHTML(name || "Мой профиль") +
        (statusEmoji ? `<span class="status-emoji-badge">${escapeHTML(statusEmoji)}</span>` : "");
}

function applyMyAvatar(url, videoUrl) {
    document.querySelectorAll("#sidebar-profile-avatar, #profile-screen-avatar, #bottom-nav-avatar").forEach((el) => {
        if (url) {
            el.style.backgroundImage = `url(${url})`;
            const fallback = el.querySelector("span:not(.profile-avatar-edit-overlay)");
            if (fallback) fallback.style.visibility = "hidden";
        } else {
            el.style.backgroundImage = "";
            const fallback = el.querySelector("span:not(.profile-avatar-edit-overlay)");
            if (fallback) fallback.style.visibility = "";
        }
        if (el.id !== "bottom-nav-avatar") applyAvatarVideo(el, videoUrl || null);
    });

    // Моя фотография рядом с моими же сообщениями на ПК (см. style.css →
    // .message-row.sent::before). Тот же приём, что и с фото собеседника:
    // одна переменная на #messages вместо разметки в каждом сообщении.
    const messagesEl = document.getElementById("messages");
    if (messagesEl) {
        messagesEl.style.setProperty("--my-chat-avatar-emoji", url ? '""' : '"Я"');
        messagesEl.style.setProperty("--my-chat-avatar-img", url ? `url(${url})` : "none");
    }
}

function fillProfileForm(profile) {
    document.getElementById("profile-name-input").value = profile.display_name || "";
    document.getElementById("profile-username-input").value = profile.username || "";
    document.getElementById("profile-bio-input").value = profile.bio || "";
    document.getElementById("profile-screen-name-display").textContent = profile.display_name || "Мой профиль";
    document.getElementById("profile-screen-username-display").textContent = profile.username ? `@${profile.username}` : "";
    setStatusEmojiPreview(profile.status_emoji || "");
    applyMyAvatar(profile.avatar_url || "", profile.avatar_video_url || "");

    // Шапка экрана профиля: цвет из имени либо размытое фото; буква-заглушка
    // в аватарах (в нижней навигации и в самом профиле) — первая буква имени.
    const screen = document.getElementById("profile-screen");
    if (screen) {
        let hue = 0;
        for (const ch of profile.display_name || "") hue = (hue * 31 + ch.charCodeAt(0)) % 360;
        screen.style.setProperty("--gh", String(hue));
        screen.style.setProperty("--gp", profile.avatar_url ? `url(${profile.avatar_url})` : "none");
        screen.classList.toggle("has-photo", !!profile.avatar_url);
    }
    const initial = (profile.display_name || "").trim().charAt(0).toUpperCase() || "Я";
    document.querySelectorAll("#bottom-nav-avatar > span, #profile-screen-avatar-fallback").forEach((el) => { el.textContent = initial; });
}

// Снимок полей формы на момент открытия/успешного сохранения — чтобы
// закрытие экрана (крестик, тап по фону ИЛИ новый свайп-вниз шторки, см.
// SHEET_CLOSE_BY_BACKDROP_ID) с недопечатанными правками не стирало их
// молча: несохранённое имя/юзернейм/био — это именно то, что человек мог
// только что намеренно набрать.
let profileFormSnapshot = null;

function captureProfileFormSnapshot() {
    profileFormSnapshot = {
        name: document.getElementById("profile-name-input").value,
        username: document.getElementById("profile-username-input").value,
        bio: document.getElementById("profile-bio-input").value
    };
}

function hasUnsavedProfileChanges() {
    if (!profileFormSnapshot) return false;
    return document.getElementById("profile-name-input").value !== profileFormSnapshot.name
        || document.getElementById("profile-username-input").value !== profileFormSnapshot.username
        || document.getElementById("profile-bio-input").value !== profileFormSnapshot.bio;
}

function openProfileScreen() {
    const configured = typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED;
    if (!configured || !cachedMyProfile) {
        toast("Профиль доступен после входа в настоящий аккаунт");
        return;
    }

    fillProfileForm(cachedMyProfile);
    captureProfileFormSnapshot();

    const backdrop = document.getElementById("profile-screen-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
    document.getElementById("bottom-nav-profile")?.classList.add("profile-open");
}

// forceClose — для случая "сами только что сохранили", когда подтверждение
// не нужно и уже поздно (поля обновлены, снимок ещё не обновлён).
function closeProfileScreen(forceClose) {

    if (!forceClose && hasUnsavedProfileChanges()) {
        if (!confirm("Отменить несохранённые изменения профиля?")) return;
    }

    const backdrop = document.getElementById("profile-screen-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
    document.getElementById("status-emoji-picker").hidden = true;
    document.getElementById("bottom-nav-profile")?.classList.remove("profile-open");

}

function closeProfileScreenFromBackdrop(event) {
    if (event.target === event.currentTarget) closeProfileScreen();
}

function triggerAvatarUpload() {
    document.getElementById("profile-avatar-input").click();
}

async function handleAvatarFileChange(event) {

    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) { toast("Выберите файл изображения"); return; }

    // Аватар показывается кружком на 40–120 px, а раньше уходил как есть — фото
    // с телефона на 4–5 МБ скачивал каждый, у кого вы есть в списке чатов.
    const compressed = await compressImageFile(file, { maxDimension: 512 });
    if (compressed.size > 5 * 1024 * 1024) { toast("Файл слишком большой (максимум 5 МБ)"); return; }

    toast("Загружаем фото…");
    const oldAvatarUrl = cachedMyProfile?.avatar_url;
    let uploadedUrl = null;

    try {
        const url = await KabanAPI.uploadAvatar(compressed);
        uploadedUrl = url;
        cachedMyProfile = await KabanAPI.updateProfile({ avatarUrl: url });
        applyMyAvatar(cachedMyProfile.avatar_url, cachedMyProfile.avatar_video_url);
        toast("Фото профиля обновлено");
        // Старое фото больше не нужно — каждая загрузка кладёт НОВЫЙ файл
        // (см. uploadAvatar), без уборки они копились бы в Storage навсегда.
        KabanAPI.deleteStorageFile("avatars", oldAvatarUrl);
    } catch (error) {
        // Файл залит, а профиль не сохранился — не оставляем его в хранилище.
        if (uploadedUrl && cachedMyProfile?.avatar_url !== uploadedUrl) KabanAPI.deleteStorageFile("avatars", uploadedUrl);
        toast("Не удалось загрузить фото: " + (error?.message || error));
    }

}


/* ВИДЕО-АВАТАР: запись короткого (до 8с) зацикленного ролика вместо
   статичного фото — тот же getUserMedia/MediaRecorder механизм, что и
   видео-кружки в чате (см. getRecordingOptions/stopRecordingTracks в
   script-core.js), только с фиксированным лимитом и без аудио. */

const AVATAR_VIDEO_MAX_MS = 8000;
const AVATAR_VIDEO_RING_CIRCUMFERENCE = 289; // 2*PI*46 — см. .avatar-video-ring-progress в style.css

let avatarVideoRecorderState = null;

function openAvatarEditMenu() {

    const hasVideo = !!cachedMyProfile?.avatar_video_url;

    document.getElementById("tab-quick-menu").innerHTML = `
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); triggerAvatarUpload()">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.2"/><path d="M8 5l1.3-2h5.4L16 5"/></svg></span>
            <span>Выбрать фото</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); openAvatarVideoRecorder()">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10 5-3v10l-5-3z"/></svg></span>
            <span>Записать видео</span>
        </button>
        ${hasVideo ? `
        <button type="button" class="tab-quick-menu-item danger" onclick="closeTabQuickMenu(); removeAvatarVideo()">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M9 6V4h6v2m-9 0 1 14h10l1-14"/></svg></span>
            <span>Убрать видео-аватар</span>
        </button>` : ""}
    `;
    document.getElementById("tab-quick-menu-backdrop").hidden = false;

}

async function openAvatarVideoRecorder() {

    const backdrop = document.getElementById("avatar-video-backdrop");
    const preview = document.getElementById("avatar-video-preview");
    const recordRow = document.getElementById("avatar-video-record-row");
    const reviewRow = document.getElementById("avatar-video-review-row");
    const recordBtn = document.getElementById("avatar-video-record-btn");

    if (preview.src) { URL.revokeObjectURL(preview.src); preview.removeAttribute("src"); }
    recordRow.hidden = false;
    reviewRow.hidden = true;
    recordBtn.classList.remove("recording");
    setAvatarVideoRingProgress(0);

    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
        toast("Запись видео недоступна в этом браузере");
        closeAvatarVideoRecorder();
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
        avatarVideoRecorderState = { stream, recorder: null, chunks: [], recordedBlob: null, timer: null, startedAt: 0 };
        preview.classList.add("mirrored");
        preview.srcObject = stream;
        preview.muted = true;
        await preview.play().catch(() => {});
    } catch (error) {
        toast("Не удалось получить доступ к камере: " + (error?.message || error));
        closeAvatarVideoRecorder();
    }

}

function setAvatarVideoRingProgress(fraction) {
    const ring = document.getElementById("avatar-video-ring-progress");
    if (!ring) return;
    ring.style.strokeDashoffset = String(AVATAR_VIDEO_RING_CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, fraction))));
}

function toggleAvatarVideoRecording() {

    if (!avatarVideoRecorderState?.stream) return;

    if (avatarVideoRecorderState.recorder && avatarVideoRecorderState.recorder.state === "recording") {
        stopAvatarVideoRecording();
        return;
    }

    const state = avatarVideoRecorderState;
    const options = getRecordingOptions("video");
    state.chunks = [];
    state.recorder = options ? new MediaRecorder(state.stream, options) : new MediaRecorder(state.stream);

    state.recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) state.chunks.push(event.data);
    });

    state.recorder.addEventListener("stop", () => {
        const mimeType = state.recorder.mimeType || "video/webm";
        state.recordedBlob = new Blob(state.chunks, { type: mimeType });
        showAvatarVideoReview(state.recordedBlob);
    });

    state.startedAt = Date.now();
    state.recorder.start();
    document.getElementById("avatar-video-record-btn").classList.add("recording");

    state.timer = setInterval(() => {
        const elapsed = Date.now() - state.startedAt;
        setAvatarVideoRingProgress(elapsed / AVATAR_VIDEO_MAX_MS);
        if (elapsed >= AVATAR_VIDEO_MAX_MS) stopAvatarVideoRecording();
    }, 60);

}

function stopAvatarVideoRecording() {

    const state = avatarVideoRecorderState;
    if (!state) return;

    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    document.getElementById("avatar-video-record-btn").classList.remove("recording");

    if (state.recorder && state.recorder.state === "recording") {
        state.recorder.stop();
    }

}

function showAvatarVideoReview(blob) {

    const preview = document.getElementById("avatar-video-preview");
    const state = avatarVideoRecorderState;

    if (state?.stream) {
        state.stream.getTracks().forEach((track) => track.stop());
        state.stream = null;
    }

    preview.classList.remove("mirrored");
    preview.srcObject = null;
    preview.src = URL.createObjectURL(blob);
    preview.loop = true;
    preview.muted = true;
    preview.play().catch(() => {});

    document.getElementById("avatar-video-record-row").hidden = true;
    document.getElementById("avatar-video-review-row").hidden = false;
    setAvatarVideoRingProgress(0);

}

function retakeAvatarVideo() {
    if (avatarVideoRecorderState) avatarVideoRecorderState.recordedBlob = null;
    openAvatarVideoRecorder();
}

async function saveAvatarVideo() {

    const blob = avatarVideoRecorderState?.recordedBlob;
    if (!blob) return;

    toast("Загружаем видео…");
    const oldVideoUrl = cachedMyProfile?.avatar_video_url;

    try {
        const file = new File([blob], `avatar_${Date.now()}.${blob.type.includes("mp4") ? "mp4" : "webm"}`, { type: blob.type });
        const url = await KabanAPI.uploadAvatar(file);
        cachedMyProfile = await KabanAPI.updateProfile({ avatarVideoUrl: url });
        applyMyAvatar(cachedMyProfile.avatar_url, cachedMyProfile.avatar_video_url);
        toast("Видео-аватар сохранён");
        // Старое видео (если было) больше не нужно — та же логика, что и у
        // обычного фото: каждая загрузка кладёт НОВЫЙ файл (см. uploadAvatar).
        if (oldVideoUrl) KabanAPI.deleteStorageFile("avatars", oldVideoUrl);
        closeAvatarVideoRecorder();
    } catch (error) {
        toast("Не удалось сохранить видео: " + (error?.message || error));
    }

}

async function removeAvatarVideo() {

    const oldVideoUrl = cachedMyProfile?.avatar_video_url;
    if (!oldVideoUrl) return;

    try {
        cachedMyProfile = await KabanAPI.updateProfile({ avatarVideoUrl: null });
        applyMyAvatar(cachedMyProfile.avatar_url, cachedMyProfile.avatar_video_url);
        toast("Видео-аватар убран");
        KabanAPI.deleteStorageFile("avatars", oldVideoUrl);
    } catch (error) {
        toast("Не удалось убрать видео-аватар: " + (error?.message || error));
    }

}

function closeAvatarVideoRecorder() {

    const backdrop = document.getElementById("avatar-video-backdrop");
    const preview = document.getElementById("avatar-video-preview");
    const state = avatarVideoRecorderState;

    if (state?.timer) clearInterval(state.timer);
    if (state?.recorder && state.recorder.state === "recording") {
        try { state.recorder.stop(); } catch { /* уже остановлен */ }
    }
    if (state?.stream) state.stream.getTracks().forEach((track) => track.stop());
    avatarVideoRecorderState = null;

    if (preview.src) { URL.revokeObjectURL(preview.src); preview.removeAttribute("src"); }
    preview.srcObject = null;

    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");

}

function closeAvatarVideoRecorderFromBackdrop(event) {
    if (event.target === event.currentTarget) closeAvatarVideoRecorder();
}

function setStatusEmojiPreview(emoji) {
    const btn = document.getElementById("profile-status-emoji-btn");
    const preview = document.getElementById("profile-status-emoji-preview");
    preview.textContent = emoji || "＋";
    btn.classList.toggle("has-emoji", !!emoji);
    btn.dataset.emoji = emoji || "";
}

function toggleStatusEmojiPicker() {
    const picker = document.getElementById("status-emoji-picker");
    if (picker.hidden && !picker.childElementCount) {
        picker.innerHTML = `
            <button type="button" title="Без статуса" onclick="pickStatusEmoji('')">✕</button>
            ${STATUS_EMOJIS.map((e) => `<button type="button" onclick="pickStatusEmoji('${e}')">${e}</button>`).join("")}
        `;
    }
    picker.hidden = !picker.hidden;
    document.getElementById("profile-status-emoji-btn").setAttribute("aria-expanded", String(!picker.hidden));
}

function pickStatusEmoji(emoji) {
    setStatusEmojiPreview(emoji);
    document.getElementById("status-emoji-picker").hidden = true;
    document.getElementById("profile-status-emoji-btn").setAttribute("aria-expanded", "false");
}

async function saveProfileChanges() {

    const displayName = document.getElementById("profile-name-input").value.trim();
    const username = document.getElementById("profile-username-input").value.trim();
    const bio = document.getElementById("profile-bio-input").value.trim();
    const statusEmoji = document.getElementById("profile-status-emoji-btn").dataset.emoji || null;

    if (!displayName) { toast("Введите имя"); return; }
    if (displayName.length > 64) { toast("Имя слишком длинное (максимум 64 символа)"); return; }
    if (bio.length > 300) { toast("«О себе» слишком длинно (максимум 300 символов)"); return; }
    if (!/^[a-z0-9_]{3,32}$/.test(username)) { toast("Юзернейм: 3–32 символа, латиница/цифры/«_»"); return; }

    const button = document.getElementById("profile-save-btn");
    button.disabled = true;
    button.textContent = "Сохраняем…";

    try {
        cachedMyProfile = await KabanAPI.updateProfile({ displayName, username, bio, statusEmoji });
        renderProfileName(cachedMyProfile.display_name, cachedMyProfile.status_emoji);
        document.getElementById("profile-screen-name-display").textContent = cachedMyProfile.display_name;
        document.getElementById("profile-screen-username-display").textContent = `@${cachedMyProfile.username}`;
        captureProfileFormSnapshot(); // успешно сохранили — это и есть новая база для "несохранённых изменений"
        toast("Профиль обновлён");
    } catch (error) {
        const message = /duplicate key|already exists/i.test(error?.message || "")
            ? "Этот юзернейм уже занят"
            : "Не удалось сохранить: " + (error?.message || error);
        toast(message);
    } finally {
        button.disabled = false;
        button.textContent = "Сохранить профиль";
    }

}


/* ============================================================================
   РЕАЛЬНЫЕ ЧАТЫ: список, открытие, отправка/приём сообщений — включается
   только для настоящего аккаунта (currentChatId остаётся null в демо-режиме,
   и весь этот блок просто не вызывается — см. applyRealSessionState выше).

   Ответы, реакции, редактирование, удаление и пересылка сообщений тоже
   сохраняются в базу (см. reactReal/startEditMessage/deleteRealMessage/
   openForwardPopover ниже) — визуальными-заглушками остаются только
   вложения (файлы/фото в настоящих чатах пока не поддерживаются).
   ========================================================================= */

// Shared chat state is initialized in script-core.js before script-ui.js runs.
// Keep this file free from duplicate declaration to avoid re-definition errors
// when the browser executes the scripts in the order defined in index.html.

// Общая с demo-разметкой панель реакций/ответа под сообщением — вынесена
// в константу, чтобы не копировать те же ~40 строк ещё раз внутри
// appendRealMessageRow (в send()/appendReceivedMessage() она остаётся
// как есть, трогать проверенный демо-путь незачем).
// Локальное обновление уже загруженного cachedChatRows — та же сортировка
// и побочные обновления (бейдж непрочитанных, вкладка "Контакты"), что и
// в loadChatList(), но БЕЗ похода на сервер. loadChatList() внутри не
// просто перекачивает список — getChats() это несколько последовательных
// запросов (участники, отправители в группах, счётчики непрочитанных), и
// раньше он дёргался на КАЖДОЕ отправленное/полученное сообщение и каждый
// пин/мьют — то есть по сети и с несколькими round-trip'ами там, где новое
// значение и так уже известно на месте. Это была прямая причина ощутимых
// лагов при активной переписке.
// Сортировка кэша делается сразу (данные должны быть актуальны для любого
// кода, читающего cachedChatRows следом), а вот ДОРОГАЯ часть — полная
// пересборка innerHTML всего списка чатов — откладывается на кадр: в
// оживлённой группе несколько сообщений за секунду (и каждое отправленное/
// принятое, пин, мьют) раньше пересобирали весь сайдбар синхронно на
// каждое событие, подряд. Теперь серия событий в пределах кадра даёт ОДНУ
// перерисовку.
let chatListRenderFrame = 0;

function refreshChatListLocally() {

    cachedChatRows.sort((a, b) => {
        if (!!b.is_pinned !== !!a.is_pinned) return b.is_pinned ? 1 : -1;
        const at = a.chats?.messages?.[0]?.created_at || a.chats?.created_at || "";
        const bt = b.chats?.messages?.[0]?.created_at || b.chats?.created_at || "";
        return bt.localeCompare(at);
    });

    if (chatListRenderFrame) return;
    chatListRenderFrame = requestAnimationFrame(() => {
        chatListRenderFrame = 0;
        updateUnreadTitleBadge();
        if (document.body.classList.contains("mobile-tab-contacts")) renderContactsList();
        renderChatListFromCache();
    });

}

// Подставляет message как новое "последнее сообщение" чата в кэше — для
// превью/сортировки в сайдбаре сразу после отправки/получения, без
// повторного похода на сервер за тем, что уже есть на руках.
function patchCachedChatLastMessage(chatId, message, senderName) {
    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return false;
    if (!row.chats) row.chats = {};
    row.chats.messages = [message];
    if (senderName !== undefined) row.lastMessageSenderName = senderName;
    refreshChatListLocally();
    return true;
}

// Несколько вызовов подряд (открыли чат, пришло сообщение, вернулась сеть…) раньше
// шли параллельно: каждый — 4 запроса к базе, и более СТАРЫЙ ответ мог прийти
// последним и откатить список назад. Теперь одновременно идёт только одна загрузка,
// а все просьбы, пришедшие во время неё, сливаются в ОДНУ следующую.
let chatListLoading = null;
let chatListReloadRequested = false;

function loadChatList() {
    if (chatListLoading) {
        chatListReloadRequested = true;
        return chatListLoading;
    }
    chatListLoading = (async () => {
        try {
            do {
                chatListReloadRequested = false;
                await loadChatListOnce();
            } while (chatListReloadRequested);
        } finally {
            chatListLoading = null;
        }
    })();
    return chatListLoading;
}

// Снимок списка чатов в браузере: при следующем запуске список показывается сразу,
// ещё до ответа сервера (потом тихо обновляется).
function chatListSnapshotKey() { return "kaban-chatlist-snapshot:" + (myRealUserId || ""); }

function saveChatListSnapshot() {
    if (!myRealUserId) return;
    try {
        const slim = cachedChatRows.slice(0, 80).map((row) => ({
            chat_id: row.chat_id, is_muted: row.is_muted, is_pinned: row.is_pinned, is_blocked: row.is_blocked,
            unreadCount: row.unreadCount, lastMessageSenderName: row.lastMessageSenderName,
            otherUser: row.otherUser ? { ...row.otherUser, bio: undefined } : null,
            chats: row.chats ? {
                id: row.chats.id, type: row.chats.type, title: row.chats.title, avatar_url: row.chats.avatar_url,
                is_secret: row.chats.is_secret, created_at: row.chats.created_at,
                // в секретных чатах текст — шифротекст, в снимок не кладём
                messages: (row.chats.messages || []).slice(0, 1).map((m) => ({ id: m.id, type: m.type, created_at: m.created_at, sender_id: m.sender_id, text: row.chats.is_secret ? null : m.text }))
            } : null
        }));
        localStorage.setItem(chatListSnapshotKey(), JSON.stringify(slim));
    } catch { /* место в браузере закончилось — просто без снимка */ }
}

function restoreChatListSnapshot() {
    if (cachedChatRows.length || !myRealUserId) return false;
    try {
        const rows = JSON.parse(localStorage.getItem(chatListSnapshotKey()) || "null");
        if (!Array.isArray(rows) || !rows.length) return false;
        cachedChatRows = rows;
        renderChatListFromCache();
        updateUnreadTitleBadge();
        return true;
    } catch {
        return false;
    }
}

async function loadChatListOnce() {

    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED) return;

    restoreChatListSnapshot();

    try {
        cachedChatRows = await KabanAPI.getChats();
    } catch (error) {
        console.warn("Не удалось загрузить список чатов", error);
        return;
    }

    // Локальная метка "непрочитано" (toggleChatManuallyUnread) не хранится
    // на сервере — накладываем её поверх свежих данных после каждого
    // полного перезапроса.
    const manuallyUnreadIds = getManuallyUnreadChatIds();
    cachedChatRows.forEach((row) => { row.manuallyUnread = manuallyUnreadIds.has(row.chat_id); });

    // Закреплённые — всегда наверху, дальше по свежести последнего
    // сообщения (сервер не гарантирует порядок сам, см. getChats).
    cachedChatRows.sort((a, b) => {
        if (!!b.is_pinned !== !!a.is_pinned) return b.is_pinned ? 1 : -1;
        const at = a.chats?.messages?.[0]?.created_at || a.chats?.created_at || "";
        const bt = b.chats?.messages?.[0]?.created_at || b.chats?.created_at || "";
        return bt.localeCompare(at);
    });

    updateUnreadTitleBadge();

    if (document.body.classList.contains("mobile-tab-contacts")) renderContactsList();

    renderChatListFromCache();
    saveChatListSnapshot();

}

// "Избранное" должно существовать у каждого пользователя с первого же
// входа, как Saved Messages в Telegram — а не появляться только после
// первой попытки что-то себе отправить. Создаём один раз за сессию (а не
// при каждом loadChatList — это РЕАЛЬНЫЙ новый чат только для тех, у кого
// его ещё нет, дальше find_direct_chat находит его мгновенно, но лишний
// сетевой запрос на каждую перезагрузку списка всё равно ни к чему).
//
// getOrCreateSavedMessagesChat() не проверяет на сервере "уже существует" —
// проверка только здесь, по cachedChatRows (см. комментарий в
// supabaseClient.js). Если открыть приложение в двух вкладках почти
// одновременно, обе могут не увидеть ещё не отражённое создание друг друга
// и завести по дубликату — поэтому самоисцеляемся: если self-чатов вдруг
// больше одного, оставляем самый старый, остальные тихо удаляем.
async function ensureSavedMessagesChatExists() {

    const savedChats = cachedChatRows.filter((row) =>
        row.chats?.type === "direct" && !row.chats?.is_secret && !row.otherUser
    );

    if (savedChats.length > 1) {
        savedChats.sort((a, b) => (a.chats?.created_at || "").localeCompare(b.chats?.created_at || ""));
        const duplicates = savedChats.slice(1);
        try {
            for (const row of duplicates) {
                await KabanAPI.removeGroupMember(row.chat_id, myRealUserId);
            }
            await loadChatList();
        } catch (error) {
            console.warn("Не удалось убрать дубликаты «Избранного»", error);
        }
        return;
    }

    if (savedChats.length === 1) return;

    try {
        await KabanAPI.getOrCreateSavedMessagesChat();
        await loadChatList();
    } catch (error) {
        console.warn("Не удалось создать «Избранное»", error);
    }
}

// Папки-фильтры (Все/Непрочитанные/Личные/Группы) — чистая фильтрация уже
// загруженного cachedChatRows, без обращения к серверу, поэтому переключение
// вкладки мгновенное. Полноценные пользовательские папки (создать свою,
// вручную раскладывать чаты) — отдельная задача с новой таблицей в БД,
// сознательно не входит в этот срез.
let activeChatFolder = "all";
let isShowingArchivedChats = false;
const ARCHIVED_CHAT_STORAGE_PREFIX = "kaban-archived-chats:";

function archivedChatsStorageKey() {
    return ARCHIVED_CHAT_STORAGE_PREFIX + (myRealUserId || "guest");
}

function getArchivedChatIds() {
    try {
        const ids = JSON.parse(localStorage.getItem(archivedChatsStorageKey()) || "[]");
        return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    } catch {
        return new Set();
    }
}

function persistArchivedChatIds(ids) {
    try {
        localStorage.setItem(archivedChatsStorageKey(), JSON.stringify([...ids]));
        return true;
    } catch {
        toast("Не удалось обновить архив: недостаточно места в браузере");
        return false;
    }
}

function showArchivedChats() {
    isShowingArchivedChats = true;
    activeChatFolder = "all";
    document.querySelectorAll(".chat-folder-tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.folder === "all");
    });
    renderChatListFromCache();
}

function showActiveChats() {
    isShowingArchivedChats = false;
    renderChatListFromCache();
}

function toggleChatArchived(chatId) {
    const archivedIds = getArchivedChatIds();
    const wasArchived = archivedIds.has(chatId);
    if (wasArchived) archivedIds.delete(chatId);
    else archivedIds.add(chatId);
    if (!persistArchivedChatIds(archivedIds)) return;
    renderChatListFromCache();
    toast(wasArchived ? "Чат возвращён в список" : "Чат перемещён в архив");
}

function filterChatRowsByFolder(rows) {
    if (activeChatFolder === "unread") return rows.filter((r) => (r.unreadCount || 0) > 0);
    if (activeChatFolder === "direct") return rows.filter((r) => r.chats?.type !== "group");
    if (activeChatFolder === "group") return rows.filter((r) => r.chats?.type === "group");
    if (activeChatFolder.startsWith("f:")) {
        const ids = new Set(loadFolders().find((f) => "f:" + f.id === activeChatFolder)?.chatIds || []);
        return rows.filter((r) => ids.has(r.chat_id));
    }
    return rows;
}

function switchChatFolder(folder) {
    isShowingArchivedChats = false;
    activeChatFolder = folder;
    document.querySelectorAll(".chat-folder-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.folder === folder);
    });
    renderChatListFromCache();
}

function renderChatListFromCache() {

    const listContainer = document.getElementById("real-chat-list");
    const emptyState = document.getElementById("sidebar-empty-chats");
    const foldersBar = document.getElementById("chat-folders");
    const archivedIds = getArchivedChatIds();
    const archiveCount = cachedChatRows.filter((row) => archivedIds.has(row.chat_id)).length;

    if (!cachedChatRows.length) {
        listContainer.hidden = true;
        listContainer.innerHTML = "";
        emptyState.hidden = false;
        if (foldersBar) foldersBar.hidden = true;
        return;
    }

    if (typeof renderCustomFolderTabs === "function") renderCustomFolderTabs();
    if (foldersBar) foldersBar.hidden = isShowingArchivedChats;
    const sourceRows = cachedChatRows.filter((row) => archivedIds.has(row.chat_id) === isShowingArchivedChats);
    const visibleRows = filterChatRowsByFolder(sourceRows);
    const archiveControl = isShowingArchivedChats
        ? `<button type="button" class="archive-shortcut" onclick="showActiveChats()"><span class="archive-shortcut-icon" aria-hidden="true">‹</span><span class="archive-shortcut-title">К списку чатов</span></button>`
        : archiveCount
            ? `<button type="button" class="archive-shortcut" onclick="showArchivedChats()"><span class="archive-shortcut-icon" aria-hidden="true">↓</span><span class="archive-shortcut-title">Архив</span><span class="archive-shortcut-count">${archiveCount}</span></button>`
            : "";

    emptyState.hidden = true;
    listContainer.hidden = false;

    // Раньше при КАЖДОМ новом сообщении весь список пересобирался через innerHTML
    // (все аватары, все строки) — заметный микрофриз при активной переписке.
    // Теперь строки сверяются по chat_id: меняются только изменившиеся, остальные
    // лишь переставляются (если поменялся порядок).
    const headerKey = archiveControl + "|" + isShowingArchivedChats + "|" + (visibleRows.length ? 1 : 0);
    const rowsHtml = visibleRows.map((row) => [row.chat_id, buildChatListItemHTML(row)]);

    if (listContainer._headerKey !== headerKey || !visibleRows.length) {
        listContainer.innerHTML = archiveControl + (visibleRows.length
            ? `<div class="section-label">${isShowingArchivedChats ? "Архив" : "Чаты"}</div>${rowsHtml.map(([, html]) => html).join("")}`
            : `<div class="chat-folder-empty">${isShowingArchivedChats ? "Архив пуст" : "В этой папке пока пусто"}</div>`);
        listContainer._headerKey = headerKey;
        const rendered = listContainer.querySelectorAll(".real-chat");
        rowsHtml.forEach(([, html], index) => { if (rendered[index]) rendered[index]._html = html; });
    } else {
        const existing = new Map();
        listContainer.querySelectorAll(".real-chat").forEach((el) => existing.set(el.dataset.chatId, el));
        let previous = listContainer.querySelector(".section-label");
        for (const [chatId, html] of rowsHtml) {
            let el = existing.get(chatId);
            if (!el || el._html !== html) {
                const template = document.createElement("template");
                template.innerHTML = html.trim();
                const fresh = template.content.firstElementChild;
                fresh._html = html;
                if (el) el.replaceWith(fresh);
                el = fresh;
            }
            existing.delete(chatId);
            if (previous.nextElementSibling !== el) previous.after(el);
            previous = el;
        }
        existing.forEach((el) => el.remove());
    }

    listContainer.querySelectorAll(".real-chat").forEach((el) => {
        const active = el.dataset.chatId === currentChatId;
        if (el.classList.contains("active") !== active) el.classList.toggle("active", active);
    });

}

// Короткая подпись для превью в списке чатов/уведомлениях — по типу
// сообщения, не только "📎 Вложение" на всё подряд.
const MESSAGE_TYPE_PREVIEW_LABELS = {
    image: "📷 Фото",
    video: "📹 Видео",
    voice: "🎤 Голосовое сообщение",
    video_note: "⭕ Видео-кружок",
    audio: "🎵 Аудио",
    document: "📎 Файл",
    location: "📍 Геопозиция",
    contact: "👤 Контакт"
};

function messagePreviewText(message) {
    if (message.type === "text") return message.text || "";
    return MESSAGE_TYPE_PREVIEW_LABELS[message.type] || "📎 Вложение";
}

// Время в списке чатов как в Telegram: сегодня — часы, вчера — «вчера», на этой
// неделе — день недели, раньше — дата. Раньше для сообщения недельной давности
// показывалось просто «14:05», будто оно пришло сегодня.
const chatListTimeFormatter = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const chatListWeekdayFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
const chatListDateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });
const chatListFullDateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" });

function formatChatListTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(now) - startOf(date)) / 86400000);
    if (days <= 0) return chatListTimeFormatter.format(date);
    if (days === 1) return "вчера";
    if (days < 7) return chatListWeekdayFormatter.format(date);
    if (date.getFullYear() === now.getFullYear()) return chatListDateFormatter.format(date);
    return chatListFullDateFormatter.format(date);
}

function buildChatListItemHTML(row) {

    const chat = row.chats;
    const other = row.otherUser;
    const isGroup = chat.type === "group";
    const isSecret = !!chat.is_secret;
    const isSavedMessages = !isGroup && !isSecret && !other;
    const isBot = !!other?.is_bot;
    const name = isGroup
        ? (chat.title || "Группа")
        : isSavedMessages
            ? "Избранное"
            : (loadContactAlias(other?.id) || other?.display_name || "Пользователь");
    const lastMessage = chat.messages?.[0];

    // В секретных чатах в превью НИКОГДА не показываем содержимое: сам
    // текст сообщения хранится на сервере только шифротекстом, а
    // расшифровка требует ratchet-состояния конкретного открытого чата —
    // прогонять её здесь для списка чатов означало бы либо тратить ключи
    // не по порядку (портит forward secrecy), либо дублировать состояние.
    // Ровно так же ведёт себя настоящий Telegram — контент секретного
    // чата не попадает даже в превью списка, не говоря об уведомлениях.
    let preview = isSecret
        ? "🔒 Секретное сообщение"
        : (lastMessage ? messagePreviewText(lastMessage) : "Нет сообщений");
    if (isGroup && lastMessage) {
        const senderLabel = lastMessage.sender_id === myRealUserId ? "Вы" : (row.lastMessageSenderName || "");
        if (senderLabel) preview = `${senderLabel}: ${preview}`;
    }

    // Незаконченный черновик перекрывает превью последнего сообщения — как
    // в любом настоящем мессенджере ("Черновик: ..."), только для чатов,
    // которые сейчас НЕ открыты (иначе перетирал бы собственное превью,
    // пока человек печатает у себя же на экране).
    let isDraft = false;
    if (chat.id !== currentChatId && appSettings.saveDraft) {
        try {
            const draft = localStorage.getItem(draftStorageKey(chat.id));
            if (draft && draft.trim()) {
                preview = draft.trim();
                isDraft = true;
            }
        } catch (error) { /* localStorage недоступен — просто без черновика в превью */ }
    }

    // Приватность: полностью скрыть содержимое превью (включая черновик) —
    // например, чтобы случайный взгляд на экран не раскрывал текст сообщений.
    if (appSettings.hideChatPreviews && lastMessage) {
        preview = "Новое сообщение";
        isDraft = false;
    } else if (appSettings.hideChatPreviews) {
        preview = "Нет сообщений";
        isDraft = false;
    }

    const time = lastMessage ? formatChatListTime(lastMessage.created_at) : "";

    const statusEmoji = !isGroup && other?.status_emoji
        ? `<span class="status-emoji-badge">${escapeHTML(other.status_emoji)}</span>` : "";

    // Раньше точка "в сети" была прибита намертво (всегда online), теперь
    // берётся из настоящего users.is_online — но не "в лоб": см.
    // isUserEffectivelyOnline про залипающий при аварийном отключении флаг.
    // У бота presence-эвристика не имеет смысла (он не ходит в сеть/офлайн
    // по-человечески) — точку "в сети" у него просто не показываем.
    const isOnline = !isGroup && !isBot && isUserEffectivelyOnline(other);

    const avatarStyle = isGroup && chat.avatar_url
        ? ` style="background-image:${escapeHTML(cssUrlValue(chat.avatar_url))};background-size:cover;background-position:center"`
        : "";
    const avatarGlyph = isGroup ? (chat.avatar_url ? "" : "👥") : (isSavedMessages ? "🔖" : isBot ? "🤖" : "👤");

    const unreadCount = row.unreadCount || 0;
    const unreadBadge = unreadCount > 0
        ? `<span class="chat-unread-badge" onclick="event.stopPropagation(); markChatReadWithoutOpening('${chat.id}')" title="Пометить прочитанным, не открывая">${unreadCount > 99 ? "99+" : unreadCount}</span>`
        : (row.manuallyUnread
            ? `<span class="chat-unread-badge chat-unread-dot" onclick="event.stopPropagation(); markChatReadWithoutOpening('${chat.id}')" title="Пометить прочитанным"></span>`
            : "");

    const pinIcon = row.is_pinned ? `<span class="chat-pin-icon" aria-label="Закреплён" title="Закреплён">📌</span>` : "";
    const muteIcon = row.is_muted ? `<span class="chat-mute-icon" aria-label="Без звука" title="Без звука">🔕</span>` : "";

    return `
        <div
            class="chat real-chat${unreadCount > 0 || row.manuallyUnread ? " has-unread" : ""}${row.is_pinned ? " is-pinned" : ""}"
            role="button"
            tabindex="0"
            data-chat-id="${chat.id}"
            aria-pressed="false"
            onclick="handleChatRowTap('${chat.id}', this)"
            onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRealChat('${chat.id}'); }"
        >
            <div class="chat-avatar${isOnline ? " online" : ""}${isSavedMessages ? " chat-avatar-saved" : ""}${isBot ? " chat-avatar-bot" : ""}"${avatarStyle}>${avatarGlyph}</div>
            <div class="chat-content">
                <div class="chat-line">
                    <span class="chat-name">${isSecret ? "🔒 " : ""}${escapeHTML(name)}${statusEmoji}${pinIcon}${muteIcon}</span>
                    <span class="chat-time">${escapeHTML(time)}</span>
                </div>
                <div class="chat-line">
                    <div class="chat-preview${isDraft ? " is-draft" : ""}">${isDraft ? `<span class="chat-draft-label">Черновик:</span> ` : ""}${escapeHTML(preview)}</div>
                    ${unreadBadge}
                </div>
            </div>
        </div>
    `;

}

// Общее число непрочитанных по всем чатам — в заголовке вкладки, чтобы
// было видно, не переключаясь на неё (как у любого настоящего мессенджера).
function updateUnreadTitleBadge() {

    const total = cachedChatRows.reduce((sum, row) => sum + (row.unreadCount || 0), 0);
    const baseTitle = "KABAN";
    document.title = total > 0 ? `(${total > 99 ? "99+" : total}) ${baseTitle}` : baseTitle;

    const dot = document.getElementById("bottom-nav-chats-dot");
    if (dot) {
        dot.hidden = total === 0;
        dot.textContent = total > 99 ? "99+" : String(total);
    }

    const chatsTab = document.getElementById("bottom-nav-chats");
    if (chatsTab) chatsTab.setAttribute("aria-label", total > 0 ? `Чаты, ${total} непрочитанных` : "Чаты");

}

function updateCallHistoryBadge() {
    const count = getCallHistory().filter((call) =>
        call.direction === "incoming" && call.result === "missed" && !call.seen
    ).length;
    const badge = document.getElementById("bottom-nav-calls-dot");
    if (badge) {
        badge.hidden = count === 0;
        badge.textContent = count > 99 ? "99+" : String(count);
    }
    const callsTab = document.getElementById("bottom-nav-calls");
    if (callsTab) callsTab.setAttribute("aria-label", count
        ? `Звонки, ${pluralRu(count, "пропущенный звонок", "пропущенных звонка", "пропущенных звонков")}`
        : "Звонки");
}

updateCallHistoryBadge();


/* НИЖНЯЯ МОБИЛЬНАЯ НАВИГАЦИЯ (Чаты / Контакты / Профиль) + вкладка
   "Контакты" + меню быстрых действий по долгому нажатию. Существует
   только на телефонной ширине (см. .bottom-nav в style.css), но код
   безвреден и на десктопе — просто ничего не делает видимым. */

// Универсальный обработчик "долгое нажатие" через Pointer Events — единый
// для вкладок нижней навигации и строк списка контактов, чтобы не плодить
// дублирующийся таймер-код. Отменяется при сдвиге пальца (скролл) или
// раннем отпускании — совсем не "голый setTimeout без отмены".
//
// После срабатывания долгого нажатия (или успешного свайпа чата) браузер
// всё равно потом пришлёт обычный click по тому же тапу — гасить его
// перехватом самого click-события ненадёжно (порядок capture/bubble-
// слушателей на ОДНОМ и том же элементе определяется порядком регистрации,
// а не флагом capture, так что успеть раньше inline onclick, уже
// разобранного при парсинге HTML, не гарантировано). Поэтому вместо этого
// обычные тап-обработчики (handleBottomNavTap, handleContactRowTap,
// handleChatRowTap) сами проверяют markGestureSuppression/isTapSuppressed.
//
// Подавление привязано к КОНКРЕТНОМУ элементу, а не просто к времени: иначе
// свайп (закрепить/замьютить), засчитанный на строке A, на следующие 400мс
// глушил бы и обычный тап по СОВСЕМ ДРУГОЙ строке B, если успеть тапнуть
// быстро — то есть открытие чата B молча не срабатывало бы без какой-либо
// видимой причины.
let lastGestureSuppressTime = 0;
let lastGestureSuppressElement = null;

function markGestureSuppression(element) {
    lastGestureSuppressTime = Date.now();
    lastGestureSuppressElement = element;
}

function isTapSuppressed(element) {
    return element === lastGestureSuppressElement && (Date.now() - lastGestureSuppressTime < 400);
}

function attachLongPress(container, rowSelector, onLongPress, duration = 480) {

    let timer = null;
    let startX = 0;
    let startY = 0;

    function cancelTimer() {
        clearTimeout(timer);
        timer = null;
    }

    container.addEventListener("pointerdown", (event) => {
        const row = event.target.closest(rowSelector);
        if (!row) return;
        startX = event.clientX;
        startY = event.clientY;
        cancelTimer();
        timer = setTimeout(() => {
            timer = null;
            markGestureSuppression(row);
            if (navigator.vibrate) {
                try { navigator.vibrate(8); } catch { /* iOS Safari: API отсутствует */ }
            }
            onLongPress(row);
        }, duration);
    });

    container.addEventListener("pointermove", (event) => {
        if (!timer) return;
        if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) cancelTimer();
    });

    container.addEventListener("pointerup", cancelTimer);
    container.addEventListener("pointercancel", cancelTimer);
    container.addEventListener("pointerleave", cancelTimer);

}

function handleBottomNavTap(tab, element) {
    if (isTapSuppressed(element)) return;
    switchMobileTab(tab);
}

function handleContactRowTap(userId, element) {
    if (isTapSuppressed(element)) return;
    startRealChatWith(userId);
}

function handleChatRowTap(chatId, element) {
    if (isTapSuppressed(element)) return;
    openRealChat(chatId).catch((error) => {
        console.warn("Не удалось открыть чат", error);
        toast("Не удалось открыть чат");
    });
}

// Профиль — не постоянная вкладка, а шторка поверх (переиспользует уже
// готовый openProfileScreen), поэтому её нажатие не меняет активный
// персистентный таб (Чаты/Контакты остаются как были под шторкой).
function switchMobileTab(tab) {

    if (document.body.classList.contains("chat-selected")) {
        backToChats();
    }

    if (tab === "profile") {
        openProfileScreen();
        return;
    }

    if (tab === "settings") {
        document.body.classList.remove("mobile-tab-contacts", "mobile-tab-calls");
        document.querySelectorAll(".bottom-nav-item").forEach((button) => {
            button.classList.toggle("active", button.dataset.tab === tab);
        });
        openSettings();
        return;
    }

    document.body.classList.toggle("mobile-tab-contacts", tab === "contacts");
    document.body.classList.toggle("mobile-tab-calls", tab === "calls");
    document.querySelectorAll(".bottom-nav-item").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tab);
    });

    if (tab === "contacts") {
        renderContactsList();
    } else if (tab === "calls") {
        markMissedCallsSeen();
        renderCallHistory();
    }

}

function openProfileFromSettings() {
    closeSettings();
    openProfileScreen();
}

function renderCallHistory() {

    const list = document.getElementById("calls-list");
    const empty = document.getElementById("calls-empty");
    if (!list || !empty) return;

    const query = document.getElementById("calls-search").value.trim().toLocaleLowerCase();
    const calls = getCallHistory()
        .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
        .filter((call) => !query || `${call.name} ${call.result} ${call.direction}`.toLocaleLowerCase().includes(query));

    empty.hidden = calls.length > 0;
    if (!calls.length) {
        list.innerHTML = "";
        empty.querySelector(".sidebar-empty-chats-title").textContent = query ? "Ничего не найдено" : "Звонков пока нет";
        return;
    }

    list.innerHTML = calls.map((call) => {
        const time = call.startedAt
            ? new Date(call.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : "";
        const direction = call.direction === "incoming" ? "Входящий" : "Исходящий";
        const outcome = call.result === "missed" ? " · пропущен"
            : call.result === "declined" ? " · отклонён"
                : call.result === "cancelled" ? " · отменён"
                    : call.result === "completed" && call.durationSeconds
                        ? ` · ${Math.floor(call.durationSeconds / 60)}:${String(call.durationSeconds % 60).padStart(2, "0")}`
                        : "";
        const callKind = call.kind === "video" ? "Видеозвонок" : "Аудиозвонок";
        return `
            <div class="call-history-row">
                <button class="call-history-main" type="button" onclick="openCallHistoryChat('${escapeHTML(call.remoteUserId || "")}')">
                    <span class="call-history-avatar">${call.avatarUrl ? `<img src="${escapeHTML(call.avatarUrl)}" alt="">` : "👤"}</span>
                    <span class="call-history-copy">
                        <span class="call-history-name">${escapeHTML(call.name || "Собеседник")}</span>
                        <span class="call-history-meta${call.result === "missed" ? " missed" : ""}">${direction} · ${callKind}${outcome}${time ? ` · ${time}` : ""}</span>
                    </span>
                </button>
                <button class="call-history-redial" type="button" onclick="redialFromHistory('${escapeHTML(call.id)}')" aria-label="${callKind} ${escapeHTML(call.name || "Собеседник")}" title="${callKind}">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        ${call.kind === "video" ? '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="m16 10 5-3v10l-5-3z"/>' : '<path d="M7.2 3.8 9.8 3.3l2 4.8-2.2 1.7a14 14 0 0 0 4.6 4.6l1.7-2.2 4.8 2-.5 2.6a2 2 0 0 1-2.2 1.6A15.8 15.8 0 0 1 3.6 6a2 2 0 0 1 1.6-2.2Z"/>'}
                    </svg>
                </button>
            </div>
        `;
    }).join("");

}

async function openCallHistoryChat(userId) {
    if (!userId) return;
    try {
        let chat = cachedChatRows.find((row) => row.otherUser?.id === userId && row.chats?.type !== "group");
        if (!chat) {
            const chatId = await KabanAPI.getOrCreateDirectChat(userId);
            await loadChatList();
            chat = cachedChatRows.find((row) => row.chat_id === chatId);
        }
        if (chat) await openRealChat(chat.chat_id);
    } catch (error) {
        toast("Не удалось открыть чат: " + (error?.message || error));
    }
}

async function redialFromHistory(callId) {
    const call = getCallHistory().find((item) => item.id === callId);
    if (!call?.remoteUserId) return;
    await openCallHistoryChat(call.remoteUserId);
    if (currentChatId) await startCall(call.kind === "video" ? "video" : "audio");
}

function openTabQuickMenu(tab) {

    const items = {
        chats: [
            { icon: "✏️", label: "Новый чат", action: "toggleNewChatPopover()" },
            { icon: "👥", label: "Новая группа", action: "openNewGroupModal()" }
        ],
        contacts: [
            { icon: "✏️", label: "Новый чат", action: "toggleNewChatPopover()" },
            { icon: "🔗", label: "Пригласить друга", action: "inviteFriend()" },
            { icon: "👥", label: "Новая группа", action: "openNewGroupModal()" }
        ],
        calls: [
            { icon: "👥", label: "Контакты", action: "handleBottomNavTap('contacts', document.getElementById('bottom-nav-contacts'))" }
        ],
        settings: [
            { icon: "👤", label: "Мой профиль", action: "openProfileFromSettings()" },
            { icon: "⚙️", label: "Настройки", action: "openSettings()" },
            { icon: "◐", label: "Сменить тему", action: "toggleDark()" },
            { icon: "🚪", label: "Выйти", action: "handleSignOut()", danger: true }
        ]
    }[tab];
    if (!items) return;

    document.getElementById("tab-quick-menu").innerHTML = items.map((item) => `
        <button type="button" class="tab-quick-menu-item${item.danger ? " danger" : ""}" onclick="closeTabQuickMenu(); ${item.action}">
            <span class="tqm-icon">${item.icon}</span>
            <span>${escapeHTML(item.label)}</span>
        </button>
    `).join("");
    document.getElementById("tab-quick-menu-backdrop").hidden = false;

}

function closeTabQuickMenu() {
    document.getElementById("tab-quick-menu-backdrop").hidden = true;
}

async function inviteFriend() {
    const username = cachedMyProfile?.username;
    const text = username ? `Заходи в KABAN, напиши мне: @${username}` : "Заходи в KABAN!";
    try {
        await navigator.clipboard.writeText(text);
        toast("Текст приглашения скопирован");
    } catch {
        toast(text);
    }
}

// Контакты = люди, с которыми уже есть личный (не групповой) чат — реальные
// данные из cachedChatRows, без выдуманного отдельного справочника.
// Три уровня активности для группировки вкладки "Контакты" (Part 6
// спецификации — "online/recently-active/..."): в сети прямо сейчас,
// недавно (последние 15 минут — тот же порядок величины, что и у heartbeat
// присутствия, см. startPresenceHeartbeat), остальные.
const CONTACT_RECENT_ACTIVE_MS = 15 * 60 * 1000;

// is_online — просто флаг, который выставляет heartbeat (раз в 45с, см.
// startPresenceHeartbeat) и явно снимает при уходе (visibilitychange/
// pagehide). Проблема: если вкладку/процесс убило аварийно — разрядился
// телефон, ОС прибила фон на мобильном, пропала сеть, краш — последний
// "ухожу" запрос просто не успевает уйти, и is_online навсегда залипает
// в true, потому что снять его больше НЕКОМУ (сервер сам его не трогает).
// Поэтому "в сети" по-настоящему — это is_online=true И последний heartbeat
// был не более PRESENCE_STALE_AFTER_MS назад; переживший максимум один
// пропущенный тик запас (45с цикл + сеть/рендер), дальше считаем, что
// человек на самом деле уже не в сети, что бы ни говорил сам флаг.
const PRESENCE_STALE_AFTER_MS = 90 * 1000;

function isUserEffectivelyOnline(user) {
    if (!user) return false;
    if (user.id && user.id === myRealUserId) return true;
    // Есть данные общего канала присутствия — доверяем только им (флаг в базе
    // мог залипнуть после аварийного закрытия вкладки).
    if (globalPresenceReady && user.id) return globalOnlineIds.has(user.id);
    if (!user.is_online) return false;
    if (!user.last_seen) return true; // нет метки времени — доверяем флагу как есть
    return Date.now() - new Date(user.last_seen).getTime() < PRESENCE_STALE_AFTER_MS;
}

function contactActivityTier(user) {
    if (isUserEffectivelyOnline(user)) return 0;
    const seen = lastSeenOf(user);
    if (seen && (Date.now() - new Date(seen).getTime()) <= CONTACT_RECENT_ACTIVE_MS) return 1;
    return 2;
}

function getContactsFromChats() {
    const byId = new Map();
    cachedChatRows.forEach((row) => {
        if (row.chats?.type === "group") return;
        const user = row.otherUser;
        if (user && !byId.has(user.id)) byId.set(user.id, user);
    });
    return [...byId.values()].sort((a, b) => {
        const tierDiff = contactActivityTier(a) - contactActivityTier(b);
        if (tierDiff !== 0) return tierDiff;
        return (a.display_name || "").localeCompare(b.display_name || "");
    });
}

function buildContactRowHTML(user) {
    const statusEmoji = user.status_emoji
        ? `<span class="status-emoji-badge">${escapeHTML(user.status_emoji)}</span>` : "";
    const avatarStyle = user.avatar_url
        ? ` style="background-image:${escapeHTML(cssUrlValue(user.avatar_url))};background-size:cover;background-position:center"`
        : "";
    const isBot = !!user.is_bot;
    const online = !isBot && isUserEffectivelyOnline(user);
    // "был(а) N мин. назад" вместо голого @username — та же формула, что уже
    // показывается в шапке открытого чата (formatLastSeen), для
    // единообразия, а не отдельная своя логика только для этого списка.
    const subtitle = isBot
        ? "ИИ-бот"
        : online
            ? "в сети"
            : (lastSeenOf(user) ? formatLastSeen(lastSeenOf(user)) : (user.username ? `@${user.username}` : ""));
    return `
        <div
            class="chat"
            role="button"
            tabindex="0"
            data-user-id="${user.id}"
            onclick="handleContactRowTap('${user.id}', this)"
            onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); startRealChatWith('${user.id}'); }"
        >
            <div class="chat-avatar${online ? " online" : ""}${isBot ? " chat-avatar-bot" : ""}"${avatarStyle}>${user.avatar_url ? "" : (isBot ? "🤖" : "👤")}</div>
            <div class="chat-content">
                <div class="chat-line">
                    <span class="chat-name">${escapeHTML(user.display_name || user.username || "Пользователь")}${statusEmoji}</span>
                </div>
                <div class="chat-line">
                    <div class="chat-preview">${escapeHTML(subtitle)}</div>
                </div>
            </div>
        </div>
    `;
}

function renderContactsList() {

    const listEl = document.getElementById("contacts-list");
    const emptyEl = document.getElementById("contacts-empty");
    const contacts = getContactsFromChats();

    if (!contacts.length) {
        listEl.innerHTML = "";
        emptyEl.hidden = false;
        return;
    }
    emptyEl.hidden = true;

    const online = contacts.filter((u) => contactActivityTier(u) === 0);
    const recent = contacts.filter((u) => contactActivityTier(u) === 1);
    const rest = contacts.filter((u) => contactActivityTier(u) === 2);

    const sections = [];
    if (online.length) sections.push(`<div class="section-label">В сети</div>${online.map(buildContactRowHTML).join("")}`);
    if (recent.length) sections.push(`<div class="section-label">Недавно были в сети</div>${recent.map(buildContactRowHTML).join("")}`);
    if (rest.length) sections.push(`<div class="section-label">Все контакты</div>${rest.map(buildContactRowHTML).join("")}`);

    listEl.innerHTML = sections.join("");

}

let contactsSearchToken = 0;
let contactsSearchTimer = null;

function handleContactsSearchInput() {
    clearTimeout(contactsSearchTimer);
    contactsSearchTimer = setTimeout(runContactsSearch, 300);
}

async function runContactsSearch() {

    const query = document.getElementById("contacts-search").value.trim();
    const resultsEl = document.getElementById("contacts-search-results");

    if (!query) {
        resultsEl.hidden = true;
        resultsEl.innerHTML = "";
        return;
    }

    const token = ++contactsSearchToken;
    resultsEl.hidden = false;
    resultsEl.innerHTML = `<div class="section-label">Ищем…</div>`;

    let users;
    try {
        users = await KabanAPI.searchUsersByUsername(query);
    } catch (error) {
        if (token !== contactsSearchToken) return;
        resultsEl.innerHTML = `<div class="section-label">Ошибка поиска: ${escapeHTML(error?.message || String(error))}</div>`;
        return;
    }
    if (token !== contactsSearchToken) return;

    const filtered = (users || []).filter((user) => user.id !== myRealUserId);
    resultsEl.innerHTML = filtered.length
        ? `<div class="section-label">Результаты поиска</div>${filtered.map(buildContactRowHTML).join("")}`
        : `<div class="section-label">Никого не нашлось</div>`;

}

function openContactQuickMenu(userId) {

    const user = getContactsFromChats().find((u) => u.id === userId);
    const name = escapeHTML(user?.display_name || "Собеседник");

    document.getElementById("tab-quick-menu").innerHTML = `
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); startRealChatWith('${userId}')">
            <span class="tqm-icon">✉️</span><span>Написать «${name}»</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); callContactFromList('${userId}', false)">
            <span class="tqm-icon">📞</span><span>Аудиозвонок</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); callContactFromList('${userId}', true)">
            <span class="tqm-icon">📹</span><span>Видеозвонок</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); openContactProfileFromList('${userId}')">
            <span class="tqm-icon">👤</span><span>Профиль</span>
        </button>
    `;
    document.getElementById("tab-quick-menu-backdrop").hidden = false;

}

async function callContactFromList(userId, isVideo) {
    try {
        const chatId = await KabanAPI.getOrCreateDirectChat(userId);
        // getOrCreateDirectChat часто отдаёт УЖЕ существующий чат (просто с
        // этим контактом раньше не звонили прямо из вкладки "Контакты") —
        // полный loadChatList() нужен только если его правда ещё нет в кэше.
        if (!cachedChatRows.some((row) => row.chat_id === chatId)) await loadChatList();
        await openRealChat(chatId);
        await startCall(isVideo ? "video" : "audio");
    } catch (error) {
        toast("Не удалось начать звонок: " + (error?.message || error));
    }
}

async function openContactProfileFromList(userId) {
    try {
        const chatId = await KabanAPI.getOrCreateDirectChat(userId);
        if (!cachedChatRows.some((row) => row.chat_id === chatId)) await loadChatList();
        await openRealChat(chatId);
        toggleContactPopover();
    } catch (error) {
        toast("Не удалось открыть профиль: " + (error?.message || error));
    }
}

// Долгое нажатие на строку чата открывает быстрые действия.
function openChatQuickMenu(chatId) {

    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return;

    const isGroup = row.chats?.type === "group";
    const isArchived = getArchivedChatIds().has(chatId);
    // Для группы "удалить" — это по сути "покинуть группу" (то же самое
    // действие, что и в карточке группы), отдельного "удаления" без выхода
    // для групп не бывает. Для личного чата — правда просто удаление своей
    // строки участия: описано ещё в schema.sql (chat_participants_delete),
    // но фронтенд никогда не давал до него добраться.
    const deleteLabel = isGroup ? "Покинуть группу" : "Удалить чат";

    document.getElementById("tab-quick-menu").innerHTML = `
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); toggleChatPinned('${chatId}')">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6M9 4l1 7-3 2v2h10v-2l-3-2 1-7"/><path d="M12 15v6"/></svg></span>
            <span>${row.is_pinned ? "Открепить" : "Закрепить"}</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); toggleChatMuted('${chatId}')">
            <span class="tqm-icon">${row.is_muted
                ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10a6 6 0 0 1 10.5-4M18 10v4l2 3H4l2-3v-1"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M3 3l18 18"/></svg>`
                : `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10a6 6 0 0 1 12 0v4l2 3H4l2-3Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>`}</span>
            <span>${row.is_muted ? "Включить уведомления" : "Отключить уведомления"}</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); ${row.manuallyUnread || row.unreadCount > 0 ? `markChatReadWithoutOpening('${chatId}')` : `toggleChatManuallyUnread('${chatId}')`}">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg></span>
            <span>${row.manuallyUnread || row.unreadCount > 0 ? "Пометить прочитанным" : "Пометить непрочитанным"}</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); toggleChatArchived('${chatId}')">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/></svg></span>
            <span>${isArchived ? "Вернуть из архива" : "В архив"}</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); exportChatHistory('${chatId}')">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M4 19h16"/></svg></span>
            <span>Экспортировать чат</span>
        </button>
        <button type="button" class="tab-quick-menu-item danger" onclick="closeTabQuickMenu(); deleteChatFromList('${chatId}')">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14M9 6V4h6v2m-9 0 1 14h10l1-14"/></svg></span>
            <span>${deleteLabel}</span>
        </button>
    `;
    document.getElementById("tab-quick-menu-backdrop").hidden = false;

}


/* ЭКСПОРТ ИСТОРИИ ЧАТА — скачивается как .txt. Секретные чаты исключены:
   messages.text там хранит шифротекст (расшифровка — только на лету в
   crypto.js при рендере), экспорт выдал бы нечитаемую кашу вместо текста. */

function messageToExportText(message) {

    if (message.deleted_at) return "[сообщение удалено]";

    const url = message.attachment_url;
    const meta = message.attachment_meta || {};

    switch (message.type) {
        case "text": return message.text || "";
        case "image": return "[фото]" + (url ? " " + url : "");
        case "video": return "[видео]" + (url ? " " + url : "");
        case "video_note": return "[видео-кружок]" + (url ? " " + url : "");
        case "voice": return "[голосовое сообщение]" + (url ? " " + url : "");
        case "audio": return `[аудио] ${meta.name || ""}` + (url ? " " + url : "");
        case "location": return `[геопозиция] ${meta.lat}, ${meta.lon}`;
        case "contact": return `[контакт] ${meta.display_name || ""}`;
        default: return meta.name ? `[файл] ${meta.name}` + (url ? " " + url : "") : "[вложение]";
    }

}

async function exportChatHistory(chatId) {

    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return;

    if (row.chats?.is_secret) {
        toast("Экспорт секретных чатов недоступен — сообщения хранятся зашифрованными");
        return;
    }

    toast("Готовим экспорт…");

    try {

        const isGroup = row.chats?.type === "group";
        const chatTitle = isGroup ? (row.chats?.title || "Группа") : (row.otherUser?.display_name || "Чат");

        const nameById = new Map();
        if (isGroup) {
            const members = await KabanAPI.getChatMembers(chatId);
            members.forEach((m) => nameById.set(m.user_id, m.users?.display_name || "Участник"));
        } else if (row.otherUser) {
            nameById.set(row.otherUser.id, row.otherUser.display_name || "Собеседник");
        }
        nameById.set(myRealUserId, "Я");

        // getMessages по умолчанию отдаёт только последнюю страницу —
        // докручиваем курсором по created_at самого старого уже полученного
        // сообщения, пока страницы не кончатся. Потолок страниц — просто
        // защита от бесконечного цикла при аномально огромной истории.
        let allMessages = [];
        let before = null;
        for (let page = 0; page < 200; page++) {
            const batch = await KabanAPI.getMessages(chatId, { limit: 100, before });
            if (!batch.length) break;
            allMessages = batch.concat(allMessages);
            before = batch[0].created_at;
            if (batch.length < 100) break;
        }

        if (!allMessages.length) {
            toast("В этом чате пока нет сообщений");
            return;
        }

        const lines = allMessages.map((m) => {
            const time = new Date(m.created_at).toLocaleString("ru-RU");
            const author = nameById.get(m.sender_id) || "Участник";
            return `[${time}] ${author}: ${messageToExportText(m)}`;
        });

        const header = `История переписки: ${chatTitle}\n` +
            `Экспортировано: ${new Date().toLocaleString("ru-RU")}\n` +
            `Сообщений: ${allMessages.length}\n${"=".repeat(40)}\n\n`;

        const blob = new Blob([header + lines.join("\n")], { type: "text/plain;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${(chatTitle.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "chat")}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(blobUrl);

        toast("Чат экспортирован");

    } catch (error) {
        toast("Не удалось экспортировать чат: " + (error?.message || error));
    }

}

async function deleteChatFromList(chatId) {

    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row || !myRealUserId) return;

    const isGroup = row.chats?.type === "group";
    const name = isGroup ? (row.chats?.title || "группу") : (row.otherUser?.display_name || "чат");
    const message = isGroup
        ? `Покинуть группу «${name}»?`
        : `Удалить чат с «${name}»? Переписка исчезнет из вашего списка (у собеседника останется).`;
    if (!confirm(message)) return;

    try {
        await KabanAPI.removeGroupMember(chatId, myRealUserId);
        if (chatId === currentChatId) backToChats();
        cachedChatRows = cachedChatRows.filter((r) => r.chat_id !== chatId);
        refreshChatListLocally();
        toast(isGroup ? "Вы покинули группу" : "Чат удалён");
    } catch (error) {
        toast("Не удалось удалить чат: " + (error?.message || error));
    }

}

async function toggleChatPinned(chatId) {
    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return;
    const nextPinned = !row.is_pinned;
    try {
        await KabanAPI.setChatPinned(chatId, nextPinned);
        row.is_pinned = nextPinned;
        refreshChatListLocally();
    } catch (error) {
        toast("Не удалось закрепить чат: " + (error?.message || error));
    }
}

async function toggleChatMuted(chatId) {
    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return;
    const nextMuted = !row.is_muted;
    try {
        await KabanAPI.setChatMuted(chatId, nextMuted);
        row.is_muted = nextMuted;
        refreshChatListLocally();
    } catch (error) {
        toast("Не удалось изменить уведомления: " + (error?.message || error));
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const nav = document.getElementById("bottom-nav");
    if (nav) attachLongPress(nav, ".bottom-nav-item", (row) => openTabQuickMenu(row.dataset.tab));
    const contactsList = document.getElementById("contacts-list");
    if (contactsList) attachLongPress(contactsList, ".chat", (row) => openContactQuickMenu(row.dataset.userId));
    const contactsSearchResults = document.getElementById("contacts-search-results");
    if (contactsSearchResults) attachLongPress(contactsSearchResults, ".chat", (row) => openContactQuickMenu(row.dataset.userId));
    const realChatList = document.getElementById("real-chat-list");
    if (realChatList) attachLongPress(realChatList, ".real-chat", (row) => openChatQuickMenu(row.dataset.chatId));
    if (realChatList) attachChatSwipeGestures(realChatList);
});

// Свайп по строке чата — влево закрепляет/открепляет уведомления (мьют),
// вправо закрепляет/открепляет чат в списке. Сопротивление после порога
// реакции (не улетает бесконечно за пальцем), лёгкая вибро-отметка при
// пересечении порога, решение принимается на отпускании — рядом с уже
// готовым attachLongPress на этом же контейнере (событие свайпа гасит
// таймер долгого нажатия само, через движение > 10px).
let activeChatSwipe = null;
const CHAT_SWIPE_THRESHOLD = 70;
const CHAT_SWIPE_MAX_REVEAL = 96;

function attachChatSwipeGestures(container) {

    container.addEventListener("pointerdown", (event) => {
        const row = event.target.closest(".real-chat");
        if (!row || event.target.closest("button") || (event.pointerType === "mouse" && event.button !== 0)) return;
        activeChatSwipe = { row, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, armedNotified: false };
        try { row.setPointerCapture(event.pointerId); } catch { /* палец мог уже отпуститься — не критично */ }
    });

    container.addEventListener("pointermove", (event) => {

        if (!activeChatSwipe || activeChatSwipe.pointerId !== event.pointerId) return;

        const deltaX = event.clientX - activeChatSwipe.startX;
        const deltaY = event.clientY - activeChatSwipe.startY;
        if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < 4) return;

        const row = activeChatSwipe.row;
        const overshoot = Math.abs(deltaX) - CHAT_SWIPE_MAX_REVEAL;
        const magnitude = overshoot > 0 ? CHAT_SWIPE_MAX_REVEAL + overshoot * 0.25 : Math.abs(deltaX);
        const offset = deltaX < 0 ? -magnitude : magnitude;

        row.classList.add("chat-swiping");
        row.style.transform = `translateX(${offset}px)`;

        const armed = Math.abs(offset) >= CHAT_SWIPE_THRESHOLD;
        row.classList.toggle("chat-swipe-armed", armed);
        row.classList.toggle("chat-swipe-left", offset < 0);
        row.classList.toggle("chat-swipe-right", offset > 0);

        if (armed && !activeChatSwipe.armedNotified) {
            activeChatSwipe.armedNotified = true;
            if (navigator.vibrate) { try { navigator.vibrate(6); } catch { /* iOS Safari: нет API */ } }
        } else if (!armed) {
            activeChatSwipe.armedNotified = false;
        }

    });

    function finishChatSwipe(event) {

        if (!activeChatSwipe || activeChatSwipe.pointerId !== event.pointerId) return;

        const swipe = activeChatSwipe;
        const deltaX = event.clientX - swipe.startX;
        const deltaY = event.clientY - swipe.startY;
        const row = swipe.row;

        row.classList.remove("chat-swiping", "chat-swipe-armed", "chat-swipe-left", "chat-swipe-right");
        row.style.transform = "";
        activeChatSwipe = null;

        if (Math.abs(deltaX) < CHAT_SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return;

        // Свайп засчитан — короткий тап по той же строке чуть позже не должен
        // случайно открыть чат (тот же приём подавления, что у долгого нажатия,
        // привязан именно к ЭТОЙ строке — см. markGestureSuppression).
        markGestureSuppression(row);

        const chatId = row.dataset.chatId;
        if (deltaX < 0) {
            toggleChatMuted(chatId);
        } else {
            toggleChatPinned(chatId);
        }

    }

    container.addEventListener("pointerup", finishChatSwipe);
    container.addEventListener("pointercancel", finishChatSwipe);

}


/* НАТИВНЫЙ СВАЙП ВНИЗ ДЛЯ ЗАКРЫТИЯ НИЖНИХ ШТОРОК (мобильная ширина).
   Один общий обработчик на document — на все шторки сразу (см. CSS-версию
   этого же списка в @media(max-width:650px) в style.css), а не по копии
   кода на каждую из полутора десятков модалок. Класс `.forward-modal`/`.info`
   переиспользуется НЕСКОЛЬКИМИ разными шторками с разными id backdrop'а —
   поэтому закрывающая функция определяется по id ближайшего backdrop, а
   не жёстко по классу самой панели. */
const SHEET_CLOSE_BY_BACKDROP_ID = {
    "contact-modal-backdrop": () => closeContactPopover(),
    "safety-modal-backdrop": () => closeSafetyNumberModal(),
    "new-group-backdrop": () => closeNewGroupModal(),
    "group-info-backdrop": () => closeGroupInfoModal(),
    "leave-group-backdrop": () => closeLeaveGroupModal(),
    "group-member-backdrop": () => closeGroupSubModal("group-member-backdrop"),
    "group-admin-backdrop": () => closeGroupSubModal("group-admin-backdrop"),
    "group-admins-backdrop": () => closeGroupSubModal("group-admins-backdrop"),
    "group-perms-backdrop": () => closeGroupSubModal("group-perms-backdrop"),
    "group-bans-backdrop": () => closeGroupSubModal("group-bans-backdrop"),
    "group-invite-backdrop": () => closeGroupSubModal("group-invite-backdrop"),
    "group-confirm-backdrop": () => closeGroupSubModal("group-confirm-backdrop"),
    "forward-popover": () => closeForwardPopover(),
    "theme-color-backdrop": () => closeThemeColorPicker(),
    "pin-choice-backdrop": () => closePinChoiceModal(),
    "delete-choice-backdrop": () => closeDeleteChoiceModal(),
    "command-palette-backdrop": () => closeCommandPalette(),
    "shared-media-backdrop": () => closeSharedMediaModal(),
    "saved-messages-backdrop": () => closeSavedMessages(),
    "profile-screen-backdrop": () => closeProfileScreen(),
    "info-modal-backdrop": () => closeInfoModal(),
    "settings-backdrop": () => closeSettings(),
    "avatar-video-backdrop": () => closeAvatarVideoRecorder()
};

const SHEET_PANEL_SELECTOR = ".contact-modal, .safety-modal, .forward-modal, .command-palette, .shared-media-modal, .info, .settings-dialog";
const SHEET_DISMISS_THRESHOLD = 110;

let activeSheetDrag = null;

document.addEventListener("pointerdown", (event) => {

    if (window.innerWidth > 650) return; // шторки — только мобильная ширина, см. CSS
    const panel = event.target.closest(SHEET_PANEL_SELECTOR);
    if (!panel) return;
    if (event.target.closest("button, a, input, textarea, select")) return;

    // Тянуть можно только за самый верх (где ручка) — иначе обычный скролл
    // содержимого шторки пальцем случайно утаскивал бы саму шторку вниз.
    const rect = panel.getBoundingClientRect();
    if (event.clientY - rect.top > 40) return;

    activeSheetDrag = { panel, startY: event.clientY, pointerId: event.pointerId };

});

document.addEventListener("pointermove", (event) => {
    if (!activeSheetDrag || activeSheetDrag.pointerId !== event.pointerId) return;
    const deltaY = Math.max(0, event.clientY - activeSheetDrag.startY);
    activeSheetDrag.panel.classList.add("sheet-dragging");
    activeSheetDrag.panel.style.transform = `translateY(${deltaY}px)`;
});

function finishSheetDrag(event) {

    if (!activeSheetDrag || activeSheetDrag.pointerId !== event.pointerId) return;

    const drag = activeSheetDrag;
    const deltaY = Math.max(0, event.clientY - drag.startY);
    drag.panel.classList.remove("sheet-dragging");
    drag.panel.style.transform = "";
    activeSheetDrag = null;

    if (deltaY <= SHEET_DISMISS_THRESHOLD) return;

    const backdrop = drag.panel.closest("[id$='-backdrop'], #forward-popover");
    const closeFn = backdrop && SHEET_CLOSE_BY_BACKDROP_ID[backdrop.id];
    if (closeFn) closeFn();

}

document.addEventListener("pointerup", finishSheetDrag);
document.addEventListener("pointercancel", finishSheetDrag);


/* НАСТОЯЩИЙ ИНТЕРАКТИВНЫЙ EDGE-BACK: свайп ИМЕННО от левого края экрана
   (не откуда угодно — это осознанно, иначе обычный свайп по сообщению или
   по строке чата постоянно бы путался с "назад") тянет открытый чат следом
   за пальцем, с пружинным возвратом, если не дотянули до порога. Слушатель
   в capture-фазе + stopPropagation() при захвате жеста — чтобы свайп-ответ
   на сообщении (см. messageList выше) не запускался параллельно тем же
   касанием у самого края. */
const EDGE_BACK_ZONE_PX = 24;
const EDGE_BACK_DISMISS_RATIO = 0.35;
const EDGE_BACK_VELOCITY_THRESHOLD = 0.5; // px/ms

let activeEdgeBackDrag = null;

document.addEventListener("pointerdown", (event) => {

    if (window.innerWidth > 650) return;
    if (!document.body.classList.contains("chat-selected")) return;
    if (event.clientX > EDGE_BACK_ZONE_PX) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // chat-selected остаётся true, пока поверх чата открыта шторка
    // (настройки, карточка контакта и т.п.) — в этот момент свайп от края
    // должен закрыть ШТОРКУ (см. её собственный drag-to-dismiss выше), а не
    // одновременно ещё и утащить чат под ней.
    if (document.querySelector(".contact-modal-backdrop.open, .safety-modal-backdrop.open, .forward-backdrop.open, .command-palette-backdrop.open, .shared-media-backdrop.open, .info-modal-backdrop.open, .settings-backdrop.open, .call-backdrop.open")) return;

    activeEdgeBackDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startTime: Date.now(),
        width: window.innerWidth,
        progress: 0
    };

    event.stopPropagation();

}, { capture: true });

document.addEventListener("pointermove", (event) => {

    if (!activeEdgeBackDrag || activeEdgeBackDrag.pointerId !== event.pointerId) return;

    const deltaX = Math.max(0, event.clientX - activeEdgeBackDrag.startX);
    activeEdgeBackDrag.progress = Math.min(1, deltaX / activeEdgeBackDrag.width);

    const main = document.querySelector(".main");
    const sidebar = document.querySelector(".sidebar");
    main.classList.add("edge-back-dragging");
    sidebar.classList.add("edge-back-dragging");
    main.style.transform = `translateX(${deltaX}px)`;
    sidebar.style.transform = `translateX(calc(-100% + ${deltaX}px))`;

}, { capture: true });

function finishEdgeBackDrag(event) {

    if (!activeEdgeBackDrag || activeEdgeBackDrag.pointerId !== event.pointerId) return;

    const drag = activeEdgeBackDrag;
    const deltaX = Math.max(0, event.clientX - drag.startX);
    const elapsed = Math.max(1, Date.now() - drag.startTime);
    const velocity = deltaX / elapsed;

    const main = document.querySelector(".main");
    const sidebar = document.querySelector(".sidebar");
    main.classList.remove("edge-back-dragging");
    sidebar.classList.remove("edge-back-dragging");
    main.style.transform = "";
    sidebar.style.transform = "";
    activeEdgeBackDrag = null;

    if (drag.progress >= EDGE_BACK_DISMISS_RATIO || velocity > EDGE_BACK_VELOCITY_THRESHOLD) {
        backToChats();
    }
    // Иначе ничего не делаем: сняли инлайн-transform — обычный CSS-переход
    // (.26s, см. body.chat-selected .main/.sidebar) сам плавно вернёт панели
    // на прежние места, class chat-selected не трогали.

}

document.addEventListener("pointerup", finishEdgeBackDrag, { capture: true });
document.addEventListener("pointercancel", finishEdgeBackDrag, { capture: true });


let realMessagesById = new Map();
let myRealUserId = null;

// Подгрузка старой истории по скроллу вверх (см. loadOlderMessages) —
// getMessages поддерживал курсор before с самого начала, просто никто его
// не вызывал повторно: чат показывал только последние 50 сообщений без
// возможности увидеть что-то раньше.
let hasMoreMessages = true;
let isLoadingOlderMessages = false;
let oldestLoadedMessageCreatedAt = null;
let olderMessagesRetryAt = 0;

// "был(а) в сети только что / N минут/часов/дней назад" — общая формула
// для шапки чата и списка чатов, единообразно с тем, как это выглядит в
// любом настоящем мессенджере.
function formatLastSeen(lastSeenIso) {

    if (!lastSeenIso) return "не в сети";

    const diffMs = Date.now() - new Date(lastSeenIso).getTime();
    const minutes = Math.floor(diffMs / 60000);

    if (minutes < 1) return "был(а) только что";
    if (minutes < 60) return `был(а) ${minutes} мин. назад`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `был(а) ${hours} ч. назад`;

    const days = Math.floor(hours / 24);
    if (days === 1) return "был(а) вчера";
    if (days < 7) return `был(а) ${days} дн. назад`;

    return "давно не был(а) в сети";

}

// online — сначала смотрим на realtime-presence (мгновенно, только пока
// открыт именно этот чат), при её отсутствии — на снимок is_online/last_seen
// из базы (см. cachedChatRows). typing — временно перекрывает оба.
function renderChatHeaderStatus({ online, lastSeen, typing }) {

    const el = document.querySelector(".person-status");
    if (!el) return;

    if (typing) {
        el.textContent = "печатает…";
        el.classList.add("is-typing");
        return;
    }

    el.classList.remove("is-typing");
    const statusText = online ? "в сети" : formatLastSeen(lastSeen);
    el.textContent = statusText;

    // Плашка статуса в карточке собеседника раньше была статичной «в сети» —
    // теперь показывает то же, что и шапка чата.
    setContactMood(statusText, online ? "online" : "offline");

}

// Плашка статуса в карточках собеседника (компактной и полной). state:
// online | offline | none (без точки — боты, «Избранное»).
function setContactMood(text, state) {
    document.querySelectorAll(".contact-modal-profile .mood, #info-window .mood").forEach((mood) => {
        const dot = state === "none" ? "" : `<span class="status-dot${state === "online" ? "" : " offline"}"></span> `;
        mood.innerHTML = dot + escapeHTML(text);
    });
}

// Русское склонение по числу: pluralRu(1,"участник","участника","участников") → "участник".
function pluralRu(n, one, few, many) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
}

function clearTypingIndicator() {
    if (typingClearTimer) {
        clearTimeout(typingClearTimer);
        typingClearTimer = null;
    }

    if (currentChatType === "group") {
        const el = document.querySelector(".person-status");
        if (el) {
            el.classList.remove("is-typing");
            el.textContent = `${currentChatMembersById.size} ${pluralRu(currentChatMembersById.size, "участник", "участника", "участников")}`;
        }
        return;
    }

    // После того как "печатает…" погас — возвращаем ПОСТОЯННЫЙ текст шапки того
    // типа чата, а не безусловное "был(а)" (оно подходит только живому человеку).
    const meta = cachedChatRows.find((row) => row.chat_id === currentChatId);
    const el = document.querySelector(".person-status");
    if (el && meta?.otherUser?.is_bot) { el.classList.remove("is-typing"); el.textContent = "ИИ-бот · Gemini"; return; }
    if (el && currentChatIsSecret) { el.classList.remove("is-typing"); el.textContent = "Секретный чат"; return; }
    if (el && !meta?.otherUser) { el.classList.remove("is-typing"); el.textContent = "Личные заметки"; return; }
    renderChatHeaderStatus({ online: isUserEffectivelyOnline(meta?.otherUser), lastSeen: lastSeenOf(meta?.otherUser) });
}

// chatId → последний полученный список участников группы: чтобы при повторном
// открытии группы шапка и имена отправителей были готовы сразу, без ожидания сети.
const groupMembersCache = new Map();

/* ---- кэш истории и предзагрузка: повторное открытие чата — мгновенно ----------------
   При уходе из чата его сообщения запоминаются в памяти; при следующем открытии они
   рисуются сразу, а свежая версия с сервера сверяется с ними без перерисовки всего
   списка. Наведение/нажатие на чат в списке заранее запускает загрузку истории. */

const chatMessageCache = new Map();     // chatId → { messages, hasMore }
const CHAT_CACHE_LIMIT = 30;
const CHAT_CACHE_MAX_MESSAGES = 120;
const CHAT_PAGE_SIZE = 50;

function rememberChatMessages(chatId, messages, hasMore) {
    if (!chatId || !Array.isArray(messages)) return;
    chatMessageCache.delete(chatId);
    chatMessageCache.set(chatId, { messages: messages.slice(-CHAT_CACHE_MAX_MESSAGES), hasMore: hasMore || messages.length > CHAT_CACHE_MAX_MESSAGES });
    while (chatMessageCache.size > CHAT_CACHE_LIMIT) chatMessageCache.delete(chatMessageCache.keys().next().value);
}

function snapshotOpenChatToCache() {
    if (!currentChatId || !realMessagesById?.size) return;
    const list = [...realMessagesById.values()]
        .filter((m) => m.chat_id === currentChatId)
        .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    rememberChatMessages(currentChatId, list, hasMoreMessages);
}

// Новое сообщение в ДРУГОМ чате (из общей подписки) — дописываем в его кэш, чтобы при
// открытии оно уже было на месте. Секретные сообщения тут не расшифрованы — такой кэш
// просто сбрасываем (история перечитается с сервера).
function appendToChatCache(message) {
    const entry = chatMessageCache.get(message?.chat_id);
    if (!entry) return;
    if (message.encryption_iv) { chatMessageCache.delete(message.chat_id); return; }
    if (entry.messages.some((m) => m.id === message.id)) return;
    entry.messages.push({ reactions: [], message_status: [], ...message });
    if (entry.messages.length > CHAT_CACHE_MAX_MESSAGES) { entry.messages.shift(); entry.hasMore = true; }
}

const prefetchedMessages = new Map();   // chatId → { promise, at }
const PREFETCH_TTL_MS = 10000;

function prefetchChatMessages(chatId) {
    if (!chatId || chatId === currentChatId || typeof KabanAPI === "undefined") return;
    const existing = prefetchedMessages.get(chatId);
    if (existing && Date.now() - existing.at < PREFETCH_TTL_MS) return;
    const promise = KabanAPI.getMessages(chatId, { limit: CHAT_PAGE_SIZE });
    promise.catch(() => prefetchedMessages.delete(chatId));
    prefetchedMessages.set(chatId, { promise, at: Date.now() });
}

function takePrefetchedMessages(chatId) {
    const entry = prefetchedMessages.get(chatId);
    prefetchedMessages.delete(chatId);
    return entry && Date.now() - entry.at < PREFETCH_TTL_MS ? entry.promise : null;
}

// Наведение мышью (с короткой задержкой, чтобы не грузить всё подряд при проводке
// курсора по списку) и нажатие пальцем/мышью — история начинает грузиться раньше клика.
(function setupChatPrefetch() {
    const list = document.getElementById("real-chat-list");
    if (!list) return;
    let hoverTimer = null;
    list.addEventListener("pointerover", (event) => {
        const row = event.target.closest?.(".real-chat");
        if (!row || event.pointerType === "touch") return;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => prefetchChatMessages(row.dataset.chatId), 90);
    });
    list.addEventListener("pointerout", () => clearTimeout(hoverTimer));
    list.addEventListener("pointerdown", (event) => {
        const row = event.target.closest?.(".real-chat");
        if (row) prefetchChatMessages(row.dataset.chatId);
    }, { passive: true });
})();

// Сравнение «то же ли сообщение»: если ничего не поменялось — строку не трогаем.
function messageRenderSignature(message, isSecret) {
    return [
        isSecret ? "" : message.text,
        message.edited_at, message.deleted_at, message.type,
        (message.pinned_for || []).join(","),
        JSON.stringify(message.attachment_meta || null),
        (message.reactions || []).map((r) => r.user_id + "=" + r.emoji).sort().join(","),
        (message.message_status || []).map((s) => s.user_id + "=" + s.status).sort().join(",")
    ].join("\u0001");
}

// Свежая история с сервера поверх уже показанной из кэша: добавить пропущенное,
// обновить изменившееся, убрать удалённое — без перерисовки всего чата.
async function reconcileOpenChatMessages(chatId, fresh, me, cachedIds) {

    if (currentChatId !== chatId) return;
    const container = document.getElementById("messages");
    const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    const freshIds = new Set(fresh.map((m) => m.id));
    let changed = false;

    // Удалённые «у всех» (или «у меня» на другом устройстве) за время, пока чат был закрыт.
    // Проверяем только то, что пришло из кэша: пришедшее по realtime уже после запроса
    // истории законно отсутствует в ответе сервера.
    const oldest = fresh[0]?.created_at || "";
    for (const [id, message] of [...realMessagesById]) {
        if (message.chat_id !== chatId || freshIds.has(id) || !cachedIds.has(id)) continue;
        if (!fresh.length || String(message.created_at || "") >= oldest) {
            removeMessageRowCompletely(id, { deferRefresh: true });
            changed = true;
        }
    }

    for (const message of fresh) {
        const known = realMessagesById.get(message.id);
        if (known) {
            if (messageRenderSignature(known, currentChatIsSecret) === messageRenderSignature(message, currentChatIsSecret)) continue;
            const decryptedText = currentChatIsSecret && known.encryption_iv ? known.text : null;
            Object.assign(known, message);
            if (decryptedText != null) known.text = decryptedText;
            updateRealMessageRow(message.id);
            changed = true;
            continue;
        }
        if (currentChatIsSecret && message.encryption_iv && typeof KabanCrypto !== "undefined") {
            try { message.text = await KabanCrypto.decryptMessage(chatId, message); } catch { message.text = "🔒 Не удалось расшифровать"; }
            if (currentChatId !== chatId) return;
        }
        realMessagesById.set(message.id, message);
        appendRealMessageRow(message, message.sender_id === me.id);
        // Встаёт на своё место по времени (обычно это и есть самый конец).
        const row = container.querySelector(`.message-row[data-message-id="${message.id}"]`);
        if (row) {
            const created = String(message.created_at || "");
            const next = [...container.querySelectorAll(".message-row")].find((other) =>
                other !== row && String(realMessagesById.get(other.dataset.messageId)?.created_at || "") > created);
            if (next) container.insertBefore(row, next);
        }
        changed = true;
    }

    // Пагинация: самая старая загруженная точка и признак «есть ещё».
    hasMoreMessages = fresh.length === CHAT_PAGE_SIZE || [...realMessagesById.values()].some((m) => m.chat_id === chatId && String(m.created_at || "") < oldest);
    const allLoaded = [...realMessagesById.values()].filter((m) => m.chat_id === chatId).map((m) => String(m.created_at || "")).sort();
    oldestLoadedMessageCreatedAt = allLoaded[0] || null;
    if (!hasMoreMessages && !container.querySelector(".date:not(.date-auto)") && realMessagesById.size) {
        const label = document.createElement("div");
        label.className = "date";
        label.textContent = "Начало переписки";
        container.insertBefore(label, container.firstChild);
    }

    if (changed) {
        updateMessageGrouping();
        renderPinnedBar();
        renderSharedMediaDataForCurrentChat();
        refreshAfterMessageRemoval();
        if (wasAtBottom) scrollMessagesToBottom({ instant: true });
    }

}

// «Прочитано» — только когда человек реально видит открытый чат: пока вкладка скрыта
// (свёрнута, другое окно), отметки копятся и уходят одной пачкой при возвращении.
const pendingReadIds = new Set();

function markReadWhenVisible(messageId) {
    if (!messageId) return;
    if (!document.hidden) {
        KabanAPI.markMessagesAsRead([messageId]).catch(() => {});
        return;
    }
    pendingReadIds.add(messageId);
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden || !pendingReadIds.size) return;
    // Отмечаем только то, что всё ещё в открытом чате (могли уйти в другой).
    const ids = [...pendingReadIds].filter((id) => realMessagesById.has(id));
    pendingReadIds.clear();
    if (ids.length) KabanAPI.markMessagesAsRead(ids).catch(() => {});
});

// Подписи авторов над чужими сообщениями группы — когда список участников пришёл
// уже после того, как история показана (открытие не ждёт этот запрос).
function refreshGroupSenderLabels() {
    document.querySelectorAll("#messages .message-row.received").forEach((row) => {
        const label = row.querySelector(".message-sender-name");
        const message = realMessagesById.get(row.dataset.messageId);
        if (!label || !message) return;
        const name = currentChatMembersById.get(message.sender_id)?.display_name || "Участник";
        if (label.textContent !== name) label.textContent = name;
    });
}

async function openRealChat(chatId) {

    // Если за время долгой цепочки await ниже пользователь успел открыть
    // ДРУГОЙ чат (быстрый повторный клик/свайп), myRequestToken перестанет
    // совпадать с chatOpenRequestToken, и продолжение этого вызова молча
    // прекратится вместо того, чтобы вставить чужие сообщения/подписки в
    // уже другой открытый чат (см. chatOpenRequestToken в script-core.js).
    // Повторный клик по уже открытому чату — не перезагружаем его (раньше вся
    // история заново шла с сервера и чат «моргал»).
    if (chatId === currentChatId && document.body.classList.contains("chat-selected") && realMessagesById.size) {
        return;
    }

    const myRequestToken = ++chatOpenRequestToken;

    // Уходим из прежнего чата — его история остаётся в памяти для мгновенного возврата.
    snapshotOpenChatToCache();

    closeContactPopover();
    closeInfoModal();
    closeSharedMediaModal();
    closeAttachMenu();
    exitSelectionMode();

    // Незавершённый ответ ("ответить на сообщение") принадлежит ТОМУ чату,
    // где его начали — без этой очистки pendingReply.messageId утёк бы в
    // новый чат и при отправке ушёл бы как reply_to_id на чужое сообщение
    // из совсем другого чата (его здесь даже не видно).
    pendingReply = null;
    document.getElementById("reply-preview").classList.remove("visible");

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

    currentChatId = chatId;
    // Открытие чата — это настоящее прочтение, снимаем локальную метку
    // "непрочитано", если она была выставлена вручную.
    const manuallyUnreadIds = getManuallyUnreadChatIds();
    if (manuallyUnreadIds.has(chatId)) {
        manuallyUnreadIds.delete(chatId);
        try { localStorage.setItem(manuallyUnreadStorageKey(), JSON.stringify([...manuallyUnreadIds])); } catch {}
        const openedRow = cachedChatRows.find((r) => r.chat_id === chatId);
        if (openedRow) openedRow.manuallyUnread = false;
    }
    realMessagesById = new Map();
    hasMoreMessages = true;
    isLoadingOlderMessages = false;
    oldestLoadedMessageCreatedAt = null;
    document.body.classList.add("chat-selected");

    // Черновик — свой на каждый чат (ключ включает chatId), а не один
    // общий на всё приложение: иначе набранный, но не отправленный текст
    // в чате A подменял бы собой то, что человек уже начал печатать в B.
    if (appSettings.saveDraft) {
        const inputEl = document.getElementById("input");
        inputEl.value = localStorage.getItem(draftStorageKey(chatId)) || "";
        resizeComposer();
        updateComposerAction();
        updateComposerCharCounter();
        updateComposerCalculatorHint();
    }

    document.querySelectorAll(".real-chat").forEach((el) => {
        const active = el.dataset.chatId === chatId;
        el.classList.toggle("active", active);
        el.setAttribute("aria-pressed", String(active));
    });

    const messagesContainer = document.getElementById("messages");
    const typing = document.getElementById("typing");
    messagesContainer.querySelectorAll(".message-row, .date, .older-messages-spinner").forEach((el) => el.remove());

    // Поиск по чату принадлежит ТОМУ чату, где его начали: chatSearchMatches
    // хранит ссылки на строки старого чата (уже удалённые выше), и без сброса
    // "следующее совпадение" листало бы мёртвые DOM-узлы, а счётчик показывал
    // бы результаты чужого чата.
    // Полоска закрепа и кнопка "вниз" принадлежали предыдущему чату — обновляем
    // сразу (realMessagesById уже пуст), а не оставляем чужое до загрузки истории.
    pinnedBarIndex = 0;
    renderPinnedBar();

    chatSearchMatches = [];
    chatSearchIndex = -1;
    const chatSearchInputEl = document.getElementById("chat-search-input");
    if (chatSearchInputEl && chatSearchInputEl.value) {
        chatSearchInputEl.value = "";
        updateChatSearch();
    }

    const meta = cachedChatRows.find((row) => row.chat_id === chatId);
    const otherName = meta?.otherUser?.display_name || "Пользователь";
    const otherEmoji = meta?.otherUser?.status_emoji;
    currentChatType = meta?.chats?.type || "direct";
    // getChats() подставляет "собеседника" (otherUser) КАЖДОМУ чату, включая
    // группы — там это просто первый попавшийся участник. Для группы единого
    // собеседника нет: оставленный id заставлял presence-обработчик ниже
    // затирать "N участников" в шапке статусом случайного человека
    // ("был(а) 10 ч. назад"), а блокировка/звонки/общие группы шли бы к нему же.
    currentOtherUserId = currentChatType === "group" ? null : (meta?.otherUser?.id || null);
    currentChatIsSecret = !!meta?.chats?.is_secret;
    currentChatMembersById = new Map();
    currentGroupInfo = null;
    syncGroupComposerLock(); // снимает блокировку ввода, оставшуюся от прошлой группы
    // "Избранное" — личный чат, где второй участник (otherUser) не
    // приходит с сервера: это тот же самый я (см. getOrCreateSavedMessagesChat
    // в supabaseClient.js и комментарий у getChats про .neq("user_id", me.id)).
    const isSavedMessages = currentChatType !== "group" && !currentChatIsSecret && !meta?.otherUser;
    const isBotChat = currentChatType !== "group" && !!meta?.otherUser?.is_bot;

    // История не зависит от результатов запросов ниже (участники группы,
    // статус блокировки, рукопожатие секретного чата) — раньше всё шло
    // СТРОГО по очереди, и открытие чата ждало сумму нескольких сетевых
    // round-trip'ов. Запускаем загрузку сразу, дальше только await результата.
    if (typeof playChatEnterAnimation === "function") playChatEnterAnimation();
    const cachedEntry = chatMessageCache.get(chatId) || null;
    const messagesPromise = takePrefetchedMessages(chatId) || KabanAPI.getMessages(chatId, { limit: CHAT_PAGE_SIZE });
    messagesPromise.catch(() => {}); // ошибку обработаем в месте await; здесь — чтобы не было unhandled при раннем выходе
    applyChatWallpaper(chatId);
    syncNotificationActionState(chatId);

    // Звонки: в личном чате — обычный 1:1 звонок собеседнику, в группе —
    // групповой (комната на весь чат, см. script-core.js → ГРУППОВЫЕ ЗВОНКИ).
    // Себе позвонить нельзя ("Избранное"), боту — тоже.
    const headerCallButton = document.getElementById("header-call-button");
    const headerVideoCallButton = document.getElementById("header-video-call-button");
    const headerCallDivider = document.getElementById("header-call-divider");
    const showCallButton = !isSavedMessages && !isBotChat;
    if (headerCallButton) headerCallButton.hidden = !showCallButton;
    if (headerVideoCallButton) headerVideoCallButton.hidden = !showCallButton;
    if (headerCallDivider) headerCallDivider.hidden = !showCallButton;

    // Баннер "Идёт групповой звонок — присоединиться" — только в открытой группе.
    if (currentChatType === "group") watchGroupCallBanner(chatId);
    else stopGroupCallBanner();
    if (typeof listenWatchChat === "function") listenWatchChat(chatId);
    if (typeof voiceWatchGroup === "function") voiceWatchGroup(currentChatType === "group" ? chatId : null);
    // Трансляция экрана — и в группах тоже (звонки там не поддерживаются, а
    // трансляция идёт отдельным соединением на каждого зрителя).
    syncScreenShareButton(!isSavedMessages && !isBotChat);

    if (isBotChat) {

        currentChatTitle = otherName;
        applyContactProfile({
            name: otherName,
            avatar: "🤖",
            photo: null,
            username: meta?.otherUser?.username || "",
            bio: meta?.otherUser?.bio || "",
            isBot: true
        });
        const botStatusEl = document.querySelector(".person-status");
        if (botStatusEl) { botStatusEl.classList.remove("is-typing"); botStatusEl.textContent = "ИИ-бот · Gemini"; }
        setContactMood("ИИ-бот", "none");

        const botBlockButton = document.querySelector('[data-profile-toggle="blocked"]');
        if (botBlockButton) applyBlockUIState(botBlockButton, false);

    } else if (isSavedMessages) {

        currentChatTitle = "Избранное";
        applyContactProfile({
            name: "Избранное",
            avatar: "🔖",
            photo: null,
            username: "",
            isSaved: true
        });
        const statusEl = document.querySelector(".person-status");
        if (statusEl) { statusEl.classList.remove("is-typing"); statusEl.textContent = "Личные заметки"; }
        setContactMood("Личные заметки", "none");

        // Себя заблокировать нельзя — кнопка не должна остаться в состоянии
        // "заблокирован", унаследованном от предыдущего открытого чата.
        const savedBlockButton = document.querySelector('[data-profile-toggle="blocked"]');
        if (savedBlockButton) applyBlockUIState(savedBlockButton, false);

    } else if (currentChatType === "group") {

        currentChatTitle = meta?.chats?.title || "Группа";
        applyContactProfile({
            name: currentChatTitle,
            avatar: "👥",
            photo: meta?.chats?.avatar_url || null,
            username: ""
        });

        // Шапка не должна показывать статус ПРЕДЫДУЩЕГО чата ("4 участника"
        // другой группы), пока список участников едет по сети: если участников
        // этой группы уже открывали — показываем их из кеша сразу (свежий список
        // подтянется фоном), иначе очищаем строку статуса до прихода данных.
        const applyGroupMembers = (members) => {
            if (myRequestToken !== chatOpenRequestToken) return;
            currentChatMembersById = new Map();
            members.forEach((m) => currentChatMembersById.set(m.user_id, { ...m.users, role: m.role, admin_rights: m.admin_rights, admin_title: m.admin_title, promoted_by: m.promoted_by }));
            syncGroupComposerLock();
            refreshGroupSenderLabels();
            const el = document.querySelector(".person-status");
            if (el && !el.classList.contains("is-typing")) {
                el.textContent = `${members.length} ${pluralRu(members.length, "участник", "участника", "участников")}`;
            }
        };

        // Права/разрешения группы (владелец, описание, member_permissions) —
        // отдельным запросом параллельно; до ответа действуют прежние правила.
        currentGroupInfo = null;
        loadGroupDetails(chatId);

        const cachedMembers = groupMembersCache.get(chatId);
        const statusEl = document.querySelector(".person-status");
        if (cachedMembers) {
            applyGroupMembers(cachedMembers);
        } else if (statusEl) {
            statusEl.classList.remove("is-typing");
            statusEl.textContent = "";
        }

        const membersPromise = KabanAPI.getChatMembers(chatId).then((members) => {
            groupMembersCache.set(chatId, members);
            applyGroupMembers(members);
            return members;
        });
        membersPromise.catch((error) => console.warn("Не удалось загрузить участников группы", error));

        // Открытие НЕ ждёт список участников: история показывается сразу, а подписи
        // авторов над сообщениями дописываются, когда участники придут
        // (refreshGroupSenderLabels в applyGroupMembers).

        // Группа — блокировки не бывает, композер точно не должен остаться
        // выключенным от предыдущего открытого 1:1 чата.
        const groupBlockButton = document.querySelector('[data-profile-toggle="blocked"]');
        if (groupBlockButton) applyBlockUIState(groupBlockButton, false);

    } else {

        currentChatTitle = otherName;
        applyContactProfile({
            name: (currentChatIsSecret ? "🔒 " : "") + (otherEmoji ? `${otherName} ${otherEmoji}` : otherName),
            avatar: "👤",
            photo: meta?.otherUser?.avatar_url || null,
            avatarVideo: meta?.otherUser?.avatar_video_url || null,
            username: meta?.otherUser?.username || "",
            bio: meta?.otherUser?.bio || ""
        });
        applyContactAliasIfSet(currentOtherUserId);

        if (currentChatIsSecret) {
            const el = document.querySelector(".person-status");
            if (el) { el.classList.remove("is-typing"); el.textContent = "Секретный чат"; }
            setContactMood("Секретный чат", "none");
        } else {
            renderChatHeaderStatus({ online: isUserEffectivelyOnline(meta?.otherUser), lastSeen: lastSeenOf(meta?.otherUser) });
        }

        // Синхронизируем кнопку/композер с уже сохранённой блокировкой —
        // без этого при каждом открытии чата кнопка "Заблокировать" не
        // помнила бы, что этот собеседник уже заблокирован (см. setBlocked).
        // Статус блокировки уже есть в списке чатов (is_blocked) — применяем сразу,
        // а уточнение с сервера идёт фоном: раньше открытие ждало этот запрос
        // ПЕРЕД показом истории (лишний сетевой круг на каждый личный чат).
        const blockButton = document.querySelector('[data-profile-toggle="blocked"]');
        if (blockButton) {
            applyBlockUIState(blockButton, !!meta?.is_blocked);
            KabanAPI.getBlocked(chatId)
                .then((blocked) => {
                    if (myRequestToken !== chatOpenRequestToken) return;
                    const shown = !!meta?.is_blocked;
                    if (meta) meta.is_blocked = blocked;
                    if (blocked !== shown) applyBlockUIState(blockButton, blocked);
                })
                .catch((error) => console.warn("Не удалось получить статус блокировки", error));
        }

        // "N групп" в карточке — тоже настоящее число, а не статика.
        const sharedGroupsHint = document.getElementById("shared-groups-hint");
        if (sharedGroupsHint && currentOtherUserId) {
            const hintForChatId = chatId;
            KabanAPI.getSharedGroups(currentOtherUserId)
                .then((groups) => {
                    // Пока шёл запрос, могли открыть другой чат — число групп
                    // ПРЕДЫДУЩЕГО собеседника не должно попасть в карточку нового.
                    if (currentChatId !== hintForChatId) return;
                    sharedGroupsHint.textContent = `${groups.length} ${pluralRu(groups.length, "группа", "группы", "групп")}`;
                })
                .catch((error) => console.warn("Не удалось посчитать общие группы", error));
        }

    }

    let me;
    try {
        me = await KabanAuth.getCurrentUser();
    } catch (error) {
        console.warn("Не удалось проверить сессию при открытии чата", error);
    }
    if (!me) {
        toast("Сессия прервалась — обновите страницу");
        return;
    }
    if (myRequestToken !== chatOpenRequestToken) return; // уже открыт другой чат
    myRealUserId = me.id;

    // Получатель приглашения в секретный чат узнаёт о нём здесь же, при
    // открытии (см. handshake_select_participant в schema.sql — до фикса
    // этого RLS-бага получатель вообще не мог увидеть рукопожатие). Если я
    // не инициатор и ответа с моим ключом ещё нет — отвечаю своим, дальше
    // у обеих сторон выводится общий ключ (см. crypto.js → acceptSecretChat).
    if (currentChatIsSecret && typeof KabanCrypto !== "undefined") {
        try {
            const db = getSupabaseClient();
            const { data: handshake } = await db
                .from("secret_chat_handshake")
                .select("initiator_id, responder_public_key")
                .eq("chat_id", chatId)
                .single();
            if (handshake && handshake.initiator_id !== myRealUserId && !handshake.responder_public_key) {
                await KabanCrypto.acceptSecretChat(chatId);
            }
        } catch (error) {
            console.warn("Не удалось принять секретный чат", error);
        }
    }

    // ---- история: из кэша мгновенно, свежая с сервера — сверкой --------------------------
    let resolveInitialRender;
    const initialRendered = new Promise((resolve) => { resolveInitialRender = resolve; });

    const renderInitialMessages = (messages, { hasMore }) => {
        messages.forEach((message) => realMessagesById.set(message.id, message));
        renderSharedMediaDataForCurrentChat();

        // Полная страница — скорее всего, есть ещё более старые сообщения; подгрузятся
        // по скроллу вверх (см. loadOlderMessages). Меньше — это и есть вся история.
        hasMoreMessages = hasMore;
        oldestLoadedMessageCreatedAt = messages[0]?.created_at ?? null;

        if (messages.length) {
            if (!hasMoreMessages) {
                const dateLabel = document.createElement("div");
                dateLabel.className = "date";
                dateLabel.textContent = "Начало переписки";
                messagesContainer.insertBefore(dateLabel, typing);
            }
            messages.forEach((message) => appendRealMessageRow(message, message.sender_id === me.id));
        }

        updateMessageGrouping();
        // При открытии — сразу вниз, без анимации прокрутки через всю историю.
        scrollMessagesToBottom({ instant: true });
        pinnedBarIndex = 0;
        renderPinnedBar();
        if (typeof KabanOutbox !== "undefined") KabanOutbox.renderFor(chatId);
        resolveInitialRender();
    };

    const nearBottom = () => {
        const box = document.getElementById("messages");
        return box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    };

    chatRealtimeUnsubscribe = KabanAPI.subscribeToChat(chatId, {

        onChatUpdate: (chat) => applyGroupChatUpdate(chat),
        onMembersChange: () => scheduleGroupRefresh(),

        onMessage: async (message) => {

            await initialRendered;
            if (myRequestToken !== chatOpenRequestToken) return;

            // Своё, отправленное из ЭТОЙ вкладки, уже нарисовано при отправке (или ждёт
            // в очереди неотправленных). Своё с другого устройства/вкладки — показываем.
            if (message.sender_id === me.id && message.type !== "system") {
                if (realMessagesById.has(message.id)) return;
                if (document.querySelector(`#messages .message-row[data-message-id="pending-${message.id}"]`)) return;
                realMessagesById.set(message.id, message);
                if (currentChatIsSecret && message.encryption_iv) {
                    // своё сообщение с другого устройства в секретном чате здесь не расшифровать
                    message.text = "🔒 Отправлено с другого устройства";
                }
                const stick = nearBottom();
                appendRealMessageRow(message, true);
                updateMessageGrouping();
                if (stick) scrollMessagesToBottom();
                patchCachedChatLastMessage(chatId, message);
                return;
            }

            if (message.type === "system") {
                const stick = nearBottom();
                realMessagesById.set(message.id, message);
                appendRealMessageRow(message, false);
                updateMessageGrouping();
                if (appSettings.autoScroll && stick) scrollMessagesToBottom();
                scheduleGroupRefresh();
                return;
            }

            if (realMessagesById.has(message.id)) return; // уже пришло вместе с историей

            if (currentChatIsSecret && message.encryption_iv && typeof KabanCrypto !== "undefined") {
                try {
                    message.text = await KabanCrypto.decryptMessage(chatId, message);
                } catch (error) {
                    message.text = "🔒 Не удалось расшифровать";
                }
                if (myRequestToken !== chatOpenRequestToken) return;
            }

            // Отметку «прочитано» ставим, только если человек реально видит чат: пока
            // вкладка скрыта, сообщение ждёт (markReadWhenVisible).
            markReadWhenVisible(message.id);

            const stick = nearBottom();
            message.reactions = message.reactions || [];
            message.message_status = message.message_status || [];
            realMessagesById.set(message.id, message);
            appendRealMessageRow(message, false);
            updateMessageGrouping();
            if (typeof maybePlayEffectForMessage === "function") maybePlayEffectForMessage(message);

            // Пользователь листает историю выше — не утаскиваем его вниз, а показываем счётчик.
            if (appSettings.autoScroll && stick) scrollMessagesToBottom();
            else noteNewMessageWhileMaybeScrolledUp();
            if (appSettings.receiveSound && isChatSoundEnabled(chatId)) playReceiveSound();

            const senderName = currentChatType === "group"
                ? (currentChatMembersById.get(message.sender_id)?.display_name || "Участник")
                : otherName;
            const notifyTitle = currentChatType === "group" ? currentChatTitle : senderName;
            const notifyText = currentChatIsSecret
                ? "🔒 Новое сообщение"
                : messagePreviewText(message);

            notifyIncomingMessage({
                chatId,
                senderName: notifyTitle,
                text: currentChatType === "group" && !currentChatIsSecret ? `${senderName}: ${notifyText}` : notifyText,
                avatarUrl: currentChatType === "group" ? meta?.chats?.avatar_url : meta?.otherUser?.avatar_url
            });

            patchCachedChatLastMessage(chatId, message, currentChatType === "group" ? senderName : undefined);

        },

        onReaction: async ({ eventType, row: reactionRow }) => {
            await initialRendered;
            if (myRequestToken !== chatOpenRequestToken) return;
            handleReactionEvent(eventType, reactionRow);
        },

        // Правка/закреп/«удалить у меня» — прилетает как обычный UPDATE.
        onMessageUpdate: async (message) => {
            await initialRendered;
            if (myRequestToken !== chatOpenRequestToken) return;
            const known = realMessagesById.get(message.id);
            if (!known) return; // не из этого чата / уже удалено у меня
            // «Удалить у меня» сделано на другом устройстве — убираем и здесь.
            if (Array.isArray(message.deleted_for) && message.deleted_for.includes(me.id)) {
                removeMessageRowCompletely(message.id);
                return;
            }
            const decryptedText = known.encryption_iv ? known.text : null;
            const merged = { ...known, ...message };
            // В секретном чате в событии лежит шифротекст — расшифрованный текст сохраняем.
            if (decryptedText != null && currentChatIsSecret) merged.text = decryptedText;
            realMessagesById.set(message.id, merged);
            updateRealMessageRow(message.id);
            renderPinnedBar();
        },

        // "Удалить у нас обоих" от собеседника — реальный DELETE строки,
        // у меня сообщение должно пропасть точно так же, как если бы я
        // удалил его сам.
        onMessageDelete: async (message) => {
            await initialRendered;
            if (myRequestToken !== chatOpenRequestToken) return;
            if (!realMessagesById.has(message.id)) return;
            removeMessageRowCompletely(message.id);
        },

        // Собеседник отметил моё сообщение прочитанным — живое ✓ → ✓✓. Меняем
        // только галочку, а не всю строку (раньше каждая отметка пересобирала
        // пузырь целиком — с анимациями эмодзи и медиа).
        onStatusChange: async (status) => {
            if (!status) return;
            await initialRendered;
            if (myRequestToken !== chatOpenRequestToken) return;
            const message = realMessagesById.get(status.message_id);
            if (!message || status.user_id === myRealUserId) return;

            message.message_status = (message.message_status || []).filter((s) => s.user_id !== status.user_id);
            message.message_status.push({ user_id: status.user_id, status: status.status });
            updateMessageStatusTick(message.id);
        }

    });
    // Подписка — ДО ответа сервера: сообщения, пришедшие, пока грузится история, не теряются
    // (обработчики ждут первой отрисовки, дубли отсекаются по id).
    const cachedIds = new Set((cachedEntry?.messages || []).map((m) => m.id));
    if (cachedEntry) renderInitialMessages(cachedEntry.messages.slice(), { hasMore: !!cachedEntry.hasMore });

    let messages;
    try {
        messages = await messagesPromise;
    } catch (error) {
        if (myRequestToken === chatOpenRequestToken && !cachedEntry) toast("Не удалось загрузить сообщения: " + (error?.message || error));
        if (cachedEntry && typeof KabanConn !== "undefined") KabanConn.suspect();
        messages = null;
    }
    if (myRequestToken !== chatOpenRequestToken) return; // уже открыт другой чат

    if (messages) {
        if (cachedEntry) {
            await reconcileOpenChatMessages(chatId, messages, me, cachedIds);
        } else {
            // Расшифровываем ДО того, как сообщения попадут в realMessagesById/рендер —
            // дальше по всему коду message.text используется как готовый текст.
            if (currentChatIsSecret && typeof KabanCrypto !== "undefined") {
                for (const message of messages) {
                    if (!message.encryption_iv) continue;
                    try {
                        message.text = await KabanCrypto.decryptMessage(chatId, message);
                    } catch (error) {
                        message.text = "🔒 Не удалось расшифровать";
                    }
                }
            }
            if (myRequestToken !== chatOpenRequestToken) return; // уже открыт другой чат
            renderInitialMessages(messages, { hasMore: messages.length === CHAT_PAGE_SIZE });
        }
        if (myRequestToken !== chatOpenRequestToken) return;

        // Прочитанными отмечаем только то, что ещё НЕ отмечено мной: раньше при каждом
        // открытии все 50 чужих сообщений заново писались в message_status (и каждое
        // разлеталось realtime-событием всем участникам), а затем полностью
        // перезагружался список чатов.
        const unreadIds = messages
            .filter((m) => m.sender_id !== me.id && m.type !== "system" && !(m.message_status || []).some((s) => s.user_id === me.id && s.status === "read"))
            .map((m) => m.id);
        const listRow = cachedChatRows.find((row) => row.chat_id === chatId);
        if (unreadIds.length || listRow?.unreadCount) {
            const markAll = (listRow?.unreadCount || 0) > unreadIds.length
                ? KabanAPI.markChatRead(chatId).catch(() => KabanAPI.markMessagesAsRead(unreadIds))
                : KabanAPI.markMessagesAsRead(unreadIds);
            markAll.catch(() => {});
            if (listRow) { listRow.unreadCount = 0; refreshChatListLocally(); }
        }
    } else if (!cachedEntry) {
        return;
    }
    chatPresenceHandle = KabanAPI.subscribeToPresence(chatId, {

        onSync: (onlineUserIds) => {
            // Статус "в сети / был(а)" — только у обычного личного чата с живым
            // человеком. У группы, бота, "Избранного" и секретного чата в шапке
            // свой постоянный текст (ставится выше при открытии) — его нельзя
            // затирать чужим last_seen ("Gemini · был(а) 10 ч. назад").
            if (currentChatType === "group" || isBotChat || isSavedMessages || currentChatIsSecret || !currentOtherUserId) return;
            // Этот канал знает только тех, у кого ИМЕННО ЭТОТ чат открыт; человек,
            // который в приложении, но в другом чате, не попадал бы в список и
            // шапка врала бы «был(а) …». Поэтому смотрим ещё и общее присутствие.
            const online = onlineUserIds.includes(currentOtherUserId) || isUserEffectivelyOnline(meta?.otherUser);
            // "печатает" уже могло что-то показать поверх — не перетираем его
            // здесь молча, просто обновляем базовый online/offline статус.
            if (!document.querySelector(".person-status")?.classList.contains("is-typing")) {
                renderChatHeaderStatus({ online, lastSeen: lastSeenOf(meta?.otherUser) });
            }
        },

        onTyping: (userId) => {
            if (userId === myRealUserId) return;

            if (currentChatType === "group") {
                if (!currentChatMembersById.has(userId)) return;
                const el = document.querySelector(".person-status");
                if (el) {
                    el.textContent = `${currentChatMembersById.get(userId).display_name} печатает…`;
                    el.classList.add("is-typing");
                }
            } else {
                if (userId !== currentOtherUserId) return;
                renderChatHeaderStatus({ typing: true });
            }

            if (typingClearTimer) clearTimeout(typingClearTimer);
            typingClearTimer = setTimeout(clearTypingIndicator, 3000);
        }

    });

}

// Группирует реакции по эмодзи (счётчик + подсвечена ли моя собственная),
// как в Telegram, вместо отдельного чипа на каждого человека.
function renderReactionsInto(container, reactions, myId) {

    const groups = new Map();
    // Голоса опросов лежат в той же таблице, но реакциями не показываются.
    (reactions || []).filter((r) => !/^(poll|game):/.test(String(r.emoji))).forEach((r) => {
        if (!groups.has(r.emoji)) groups.set(r.emoji, { count: 0, mine: false });
        const g = groups.get(r.emoji);
        g.count += 1;
        if (r.user_id === myId) g.mine = true;
    });

    container.innerHTML = "";
    if (!groups.size) {
        container.closest(".message-row")?.classList.remove("has-reactions");
        return;
    }

    container.closest(".message-row")?.classList.add("has-reactions");
    groups.forEach((g, emoji) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "reaction-chip" + (g.mine ? " active" : "");
        chip.dataset.emoji = emoji;
        chip.setAttribute("aria-label", g.mine ? `Убрать реакцию ${emoji}` : `Поставить реакцию ${emoji}`);
        chip.innerHTML = `<span>${escapeHTML(emoji)}</span>${g.count > 1 ? `<span class="reaction-count">${g.count}</span>` : ""}`;
        chip.addEventListener("click", () => react(chip, emoji));
        container.appendChild(chip);
    });

}

// Замена реакции без политики UPDATE (см. KabanAPI.writeMyReactionRow) идёт как
// «удалить + вставить»: события DELETE и INSERT приходят подряд. DELETE держим
// 350 мс — если следом пришёл INSERT той же пары, это замена, а не снятие, и
// чипы не должны мигать (и «взрываться» заново).
const pendingReactionDeletes = new Map();

function handleReactionEvent(eventType, reactionRow) {

    const key = reactionRow.message_id + ":" + reactionRow.user_id;

    if (eventType === "DELETE") {
        clearTimeout(pendingReactionDeletes.get(key));
        pendingReactionDeletes.set(key, setTimeout(() => {
            pendingReactionDeletes.delete(key);
            applyReactionEvent("DELETE", reactionRow);
        }, 350));
        return;
    }

    if (pendingReactionDeletes.has(key)) {
        clearTimeout(pendingReactionDeletes.get(key));
        pendingReactionDeletes.delete(key);
    }
    applyReactionEvent(eventType, reactionRow);

}

function applyReactionEvent(eventType, reactionRow) {

    const messagesContainer = document.getElementById("messages");
    const message = realMessagesById.get(reactionRow.message_id);
    if (!message) return; // реакция на сообщение не из этого открытого чата

    const previousRow = (message.reactions || []).find((r) => r.user_id === reactionRow.user_id);
    const previousEmojis = new Set(typeof splitReactionEmojis === "function" ? splitReactionEmojis(previousRow?.emoji) : []);
    message.reactions = (message.reactions || []).filter((r) => r.user_id !== reactionRow.user_id);
    if (eventType !== "DELETE") message.reactions.push({ user_id: reactionRow.user_id, emoji: reactionRow.emoji });

    // Чужая новая реакция (не опрос/игра) — мягкая анимация над сообщением.
    if (eventType !== "DELETE" && reactionRow.user_id !== myRealUserId && typeof playReactionBurst === "function") {
        const added = splitReactionEmojis(reactionRow.emoji).find((e) => !previousEmojis.has(e));
        const burstRow = messagesContainer.querySelector(`[data-message-id="${message.id}"]`);
        if (added && burstRow) playReactionBurst(burstRow, added, { light: true });
    }

    if (message.attachment_meta?.poll) updatePollRow(message.id);
    if (message.attachment_meta?.game) updateGameRow(message.id);

    const rowEl = messagesContainer.querySelector(`[data-message-id="${message.id}"] .message-reactions`);
    if (rowEl) {
        const preservedScrollTop = messagesContainer.scrollTop;
        const wasAtBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 24;
        renderReactionsInto(rowEl, message.reactions, myRealUserId);
        // Внизу ленты — остаёмся внизу (чужая реакция на последнем сообщении не
        // должна прятать его под поле ввода).
        messagesContainer.scrollTop = wasAtBottom ? messagesContainer.scrollHeight : preservedScrollTop;
    }

}
function buildReplyQuoteHTML(replyToId, replyExcerpt) {
    if (!replyToId) return "";
    const original = realMessagesById.get(replyToId);
    // replyExcerpt — конкретная выделенная фраза, на которую ответили (см.
    // reply() в script-ui.js и частичное цитирование), а не всё сообщение;
    // приходит с САМИМ ответом (attachment_meta.reply_excerpt), а не с
    // оригиналом, поэтому видна одинаково у отправителя и у получателя.
    const text = replyExcerpt
        ? `«${replyExcerpt}»`
        : original
            ? (original.deleted_at ? "Сообщение удалено" : (original.text || "Вложение"))
            : "Сообщение";
    // data-reply-to — клик по цитате переносит к исходному сообщению (как в Telegram).
    return `<span class="message-reply-quote" data-reply-to="${escapeHTML(replyToId)}" role="button" tabindex="0" title="Перейти к сообщению">${escapeHTML(text)}</span>`;
}

document.getElementById("messages")?.addEventListener("click", (event) => {
    const quote = event.target.closest?.(".message-reply-quote[data-reply-to]");
    if (!quote || document.getElementById("messages").classList.contains("selection-mode")) return;
    event.stopPropagation();
    flashMessage(quote.dataset.replyTo);
});

function appendRealMessageRow(message, isMine, { prepend = false } = {}) {

    const messagesContainer = document.getElementById("messages");
    const typing = document.getElementById("typing");

    // Строка для этого сообщения уже есть (то же событие пришло дважды —
    // например, из-за пересекающихся подписок при быстром переоткрытии чата,
    // либо эхо собственной отправки) — второй пузырь с тем же сообщением и
    // повторное уведомление показывать не нужно.
    if (messagesContainer.querySelector(`.message-row[data-message-id="${message.id}"]`)) return;

    const row = document.createElement("div");
    row.dataset.messageId = message.id;

    // Служебное сообщение группы ("Влад назначил(а) … администратором") —
    // центрированная плашка без пузыря, действий и реакций.
    if (message.type === "system") {
        row.className = "message-row system-message";
        row.innerHTML = `<span class="system-message-text">${escapeHTML(message.text || "")}</span>`;
        if (prepend) messagesContainer.insertBefore(row, messagesContainer.firstChild);
        else messagesContainer.insertBefore(row, typing);
        return;
    }

    row.className = "message-row " + (isMine ? "sent" : "received");
    // Одно «кривое» сообщение (битые attachment_meta от чужого клиента) не должно
    // ронять отрисовку всего чата — показываем его как неподдерживаемое.
    try {
        row.innerHTML = buildMessageRowInnerHTML(message, isMine);
    } catch (error) {
        console.warn("Не удалось отрисовать сообщение", message?.id, error);
        row.innerHTML = `<div class="message"><span class="message-text">⚠️ Сообщение не удалось показать</span></div><div class="message-reactions"></div>`;
    }

    if (message.deleted_at) row.classList.add("deleted");

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

    // prepend — для подгрузки старой истории при скролле вверх (см.
    // loadOlderMessages): новая страница вставляется ПЕРЕД самым первым
    // элементом, а не перед индикатором "печатает" в конце чата.
    if (prepend) {
        messagesContainer.insertBefore(row, messagesContainer.firstChild);
    } else {
        messagesContainer.insertBefore(row, typing);
    }

}

// Подгрузка более старой страницы истории — вызывается по скроллу вверх
// (см. слушатель у messageList ниже). Сохраняет позицию скролла: без этого
// вставка контента НАД текущим взглядом молча дёргает вьюпорт наверх.
// Пометить чат прочитанным БЕЗ его открытия — тап по бейджу счётчика в
// списке чатов (не по самой строке, иначе навигация в чат делала бы это
// и так). Чужие сообщения берём тем же способом, что и при открытии чата
// (getMessages), просто не рендерим их в DOM.
async function markChatReadWithoutOpening(chatId) {

    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (!row) return;

    try {
        try {
            await KabanAPI.markChatRead(chatId);
        } catch (rpcError) {
            // RPC mark_chat_read ещё не накатан в Supabase (см. schema.sql) —
            // откат на прежний путь через getMessages, он отметит только
            // последние 50 (прежнее поведение), но хотя бы не сломает действие.
            console.warn("mark_chat_read недоступен, использую запасной путь", rpcError);
            const messages = await KabanAPI.getMessages(chatId);
            const unreadIds = messages.filter((m) => m.sender_id !== myRealUserId).map((m) => m.id);
            if (unreadIds.length) await KabanAPI.markMessagesAsRead(unreadIds);
        }
        row.unreadCount = 0;
        if (row.manuallyUnread) {
            row.manuallyUnread = false;
            const ids = getManuallyUnreadChatIds();
            ids.delete(chatId);
            try { localStorage.setItem(manuallyUnreadStorageKey(), JSON.stringify([...ids])); } catch {}
        }
        refreshChatListLocally();
    } catch (error) {
        toast("Не удалось пометить прочитанным: " + (error?.message || error));
    }

}

// Обратное действие — вручную пометить чат непрочитанным, чтобы вернуться
// к нему позже (как в Telegram/WhatsApp). Реальных "непрочитанных"
// сообщений может и не быть, поэтому это ЛОКАЛЬНЫЙ флаг-оверрайд, а не
// запись в message_status — он живёт только до следующего реального
// прочтения чата (открытие чата снимает его как обычно через markMessagesAsRead/loadChatList).
const MANUALLY_UNREAD_STORAGE_PREFIX = "kaban-manually-unread:";

function manuallyUnreadStorageKey() {
    return MANUALLY_UNREAD_STORAGE_PREFIX + (myRealUserId || "guest");
}

function getManuallyUnreadChatIds() {
    try {
        const ids = JSON.parse(localStorage.getItem(manuallyUnreadStorageKey()) || "[]");
        return new Set(Array.isArray(ids) ? ids : []);
    } catch {
        return new Set();
    }
}

function toggleChatManuallyUnread(chatId) {

    const ids = getManuallyUnreadChatIds();
    const wasUnread = ids.has(chatId);
    if (wasUnread) ids.delete(chatId);
    else ids.add(chatId);

    try {
        localStorage.setItem(manuallyUnreadStorageKey(), JSON.stringify([...ids]));
    } catch (error) {
        toast("Не удалось обновить метку: недостаточно места в браузере");
        return;
    }

    const row = cachedChatRows.find((r) => r.chat_id === chatId);
    if (row) {
        row.manuallyUnread = !wasUnread;
        refreshChatListLocally();
    }
    toast(wasUnread ? "Чат снова прочитан" : "Чат помечен непрочитанным");

}

async function loadOlderMessages() {

    if (!currentChatId || !hasMoreMessages || isLoadingOlderMessages || !oldestLoadedMessageCreatedAt) return;
    // После ошибки сети — пауза: прокрутка у верха шлёт десятки событий в секунду,
    // и каждое повторяло бы запрос (и всплывающее сообщение).
    if (Date.now() < olderMessagesRetryAt) return;
    isLoadingOlderMessages = true;

    // Чат могли переключить, пока идёт запрос — тогда по возвращении это
    // уже не тот чат, и трогать DOM/состояние текущего открытого чата чужими
    // (старыми) сообщениями нельзя.
    const requestedChatId = currentChatId;

    const messagesContainer = document.getElementById("messages");
    const spinner = document.createElement("div");
    spinner.className = "older-messages-spinner";
    spinner.textContent = "Загружаем историю…";
    messagesContainer.prepend(spinner);

    let older;
    try {
        older = await KabanAPI.getMessages(requestedChatId, { before: oldestLoadedMessageCreatedAt, limit: CHAT_PAGE_SIZE });
    } catch (error) {
        spinner.remove();
        isLoadingOlderMessages = false;
        olderMessagesRetryAt = Date.now() + 5000;
        // Без сети — подсказка, а не молчаливо исчезнувший «Загружаем историю…».
        toast("Не удалось загрузить историю — проверьте соединение");
        return;
    }
    const pageSize = older.length;

    if (requestedChatId !== currentChatId) {
        // Чат сменился, пока грузили — просто выходим, ничего не трогая.
        // isLoadingOlderMessages для СТАРОГО чата уже не имеет значения
        // (openRealChat сбросил его в false при открытии нового чата).
        spinner.remove();
        return;
    }

    // try/finally — если что-то из блока ниже бросит исключение (сеть при
    // decryptMessage, неожиданная форма message и т.п.), isLoadingOlderMessages
    // всё равно сбросится, а не застрянет в true навсегда, блокируя любую
    // следующую подгрузку истории этого чата до перезагрузки/переоткрытия.
    try {

        if (currentChatIsSecret && typeof KabanCrypto !== "undefined") {
            await Promise.all(older.map(async (message) => {
                if (!message.encryption_iv) return;
                try {
                    message.text = await KabanCrypto.decryptMessage(currentChatId, message);
                } catch (error) {
                    message.text = "🔒 Не удалось расшифровать";
                }
            }));
        }

        // Уже показанные (могли прийти и иначе) — не дублируем.
        older = older.filter((message) => !realMessagesById.has(message.id));
        older.forEach((message) => realMessagesById.set(message.id, message));
        renderSharedMediaDataForCurrentChat();

        // Якорь — первое видимое сообщение: после вставки истории сверху оно должно
        // остаться ровно на том же месте экрана. Прежний расчёт через scrollHeight
        // не учитывал высоту удаляемого «Загружаем историю…» и новые разделители
        // дат — лента прыгала на пару десятков пикселей при каждой подгрузке.
        const anchorRow = messagesContainer.querySelector(".message-row");
        const anchorTop = anchorRow ? anchorRow.getBoundingClientRect().top : 0;

        spinner.remove();

        // older уже в хронологическом порядке (старые → новые внутри страницы);
        // prepend вставляет строго в начало, поэтому идём с конца страницы к
        // началу, иначе порядок внутри страницы перевернётся.
        for (let i = older.length - 1; i >= 0; i--) {
            appendRealMessageRow(older[i], older[i].sender_id === myRealUserId, { prepend: true });
        }

        if (older.length) {
            oldestLoadedMessageCreatedAt = older[0].created_at;
        }

        hasMoreMessages = pageSize === CHAT_PAGE_SIZE;
        if (!hasMoreMessages && !messagesContainer.querySelector(".date:not(.date-auto)")) {
            const dateLabel = document.createElement("div");
            dateLabel.className = "date";
            dateLabel.textContent = "Начало переписки";
            messagesContainer.prepend(dateLabel);
        }

        updateMessageGrouping();
        if (anchorRow?.isConnected) {
            messagesContainer.scrollTop += anchorRow.getBoundingClientRect().top - anchorTop;
        }

    } finally {
        isLoadingOlderMessages = false;
    }

}

// Быстрый переход к самому первому сообщению чата — дотягивает всю более
// раннюю историю через loadOlderMessages() постранично (своего отдельного
// API для "самого начала" нет), затем скроллит и подсвечивает первую строку.
// Лимит страниц — просто защита от бесконечного цикла на аномально
// огромной истории, а не ожидаемый кейс для обычного диалога.
let isJumpingToChatBeginning = false;

async function jumpToChatBeginning() {

    if (!currentChatId || isJumpingToChatBeginning) return;
    isJumpingToChatBeginning = true;
    const requestedChatId = currentChatId;

    let pagesLoaded = 0;
    while (hasMoreMessages && requestedChatId === currentChatId && pagesLoaded < 200) {
        const beforeCursor = oldestLoadedMessageCreatedAt;
        await loadOlderMessages();
        pagesLoaded++;
        // loadOlderMessages тихо глотает собственные ошибки сети (см. её catch) —
        // если курсор не сдвинулся, страница на самом деле не загрузилась (а не
        // "в чате закончилась история"), и долбить сеть ещё 199 раз подряд
        // при, например, временном офлайне — только нагрузка без толку.
        if (oldestLoadedMessageCreatedAt === beforeCursor) break;
    }

    isJumpingToChatBeginning = false;
    if (requestedChatId !== currentChatId) return;

    const messagesContainer = document.getElementById("messages");
    const firstRow = messagesContainer.querySelector(".message-row");
    if (firstRow) {
        messagesContainer.scrollTop = 0;
        flashMessage(firstRow.dataset.messageId);
    }

}

async function sendRealMessage(text) {

    // Снимок чата на момент отправки — если пользователь успеет переключиться
    // в другой чат, пока await ниже в полёте (медленная сеть), сообщение не
    // должно появиться в УЖЕ другом открытом чате и не должно обновлять его
    // превью в сайдбаре (см. sendRealRecording — тот же паттерн уже
    // применён там, здесь просто не был скопирован).
    const targetChatId = currentChatId;

    const input = document.getElementById("input");
    const replyToId = pendingReply?.messageId || null;
    const replyExcerpt = pendingReply?.quotedExcerpt || null;
    const isSticker = pendingStickerSend;
    pendingStickerSend = false;

    // Эффект сообщения (выбран удержанием кнопки отправки) — см. effects.js.
    const messageEffect = (typeof pendingMessageEffect !== "undefined" && !currentChatIsSecret) ? pendingMessageEffect : null;

    const baseAttachmentMeta = (isSticker || messageEffect)
        ? { ...(isSticker ? { sticker: true } : {}), ...(messageEffect ? { effect: messageEffect } : {}) }
        : null;
    const attachmentMeta = replyExcerpt
        ? { ...(baseAttachmentMeta || {}), reply_excerpt: replyExcerpt }
        : baseAttachmentMeta;

    input.value = "";
    resizeComposer();
    updateComposerAction();

    const isSecretAtSend = currentChatIsSecret;

    if (appSettings.saveDraft) {
        try {
            localStorage.removeItem(draftStorageKey(targetChatId));
        } catch (error) {
            console.warn("Не удалось очистить черновик", error);
        }
    }

    // Очередь неотправленных (resilience.js): без сети сообщение не пропадает, а
    // остаётся в чате «ожидает сети» и уходит само. Секретные чаты — как раньше
    // (шифрование привязано к цепочке ключей, повтор «вслепую» небезопасен).
    const outbox = !isSecretAtSend && typeof KabanOutbox !== "undefined" ? KabanOutbox : null;
    const clientId = outbox ? outbox.newId() : null;
    const outboxItem = { clientId, chatId: targetChatId, text, replyToId, attachmentMeta };

    const afterQueued = () => {
        if (currentChatId === targetChatId) {
            pendingReply = null;
            document.getElementById("reply-preview").classList.remove("visible");
            if (appSettings.autoScroll) scrollMessagesToBottom();
        }
    };

    if (outbox && !navigator.onLine) {
        outbox.enqueue(outboxItem);
        afterQueued();
        return;
    }

    // Сообщение появляется в ленте сразу, не дожидаясь ответа сервера.
    if (outbox && currentChatId === targetChatId) {
        outbox.showSending(outboxItem);
        if (currentChatId === targetChatId) {
            pendingReply = null;
            document.getElementById("reply-preview").classList.remove("visible");
            scrollMessagesToBottom();
        }
    }

    let message;
    try {
        message = isSecretAtSend
            ? await KabanCrypto.sendSecretMessage(targetChatId, text, {
                replyToId,
                attachmentMeta
            })
            : await KabanAPI.sendMessage(targetChatId, {
                type: "text",
                text,
                replyToId,
                attachmentMeta,
                ...(clientId ? { id: clientId } : {})
            });
    } catch (error) {
        if (outbox && outbox.isNetworkError(error)) {
            outbox.enqueue(outboxItem);
            afterQueued();
            return;
        }
        if (outbox) outbox.finishSending(clientId);
        toast("Не удалось отправить сообщение: " + (error?.message || error));
        if (currentChatId === targetChatId && !input.value) input.value = text;
        return;
    }

    // sendSecretMessage вернул строку из базы с ШИФРОТЕКСТОМ в .text (так и
    // должно быть — это ровно то, что реально лежит на сервере) — для
    // немедленной отрисовки своего же сообщения подменяем на открытый текст,
    // который и так уже есть в руках, не дожидаясь decryptMessage.
    if (isSecretAtSend) message.text = text;

    // Если пользователь уже переключился в другой чат за время await выше —
    // сообщение всё равно успешно отправлено (и будет видно при следующем
    // открытии ЭТОГО чата через realtime/загрузку истории), просто не лезем
    // в DOM/группировку текущего (уже другого) открытого чата — см.
    // sendRealRecording чуть ниже, тот же паттерн.
    realMessagesById.set(message.id, message);
    if (outbox) outbox.finishSending(clientId);
    if (currentChatId === targetChatId) {
        appendRealMessageRow(message, true);
        updateMessageGrouping();
        if (typeof maybePlayEffectForMessage === "function") maybePlayEffectForMessage(message);
    }

    if (currentChatId === targetChatId) {
        pendingReply = null;
        document.getElementById("reply-preview").classList.remove("visible");

        if (document.getElementById("chat-search").classList.contains("open")) {
            updateChatSearch();
        }

        if (appSettings.sendSound) playSendSound();
        if (appSettings.autoScroll) scrollMessagesToBottom();
    }

    patchCachedChatLastMessage(targetChatId, message);

}

const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024; // 20 МБ — щадящий клиентский лимит, не завязанный на точный лимит бакета

// Фото/видео/аудио/файл в настоящем чате: сначала грузим в Storage
// (тот же bucket "attachments", что и раньше был не подключён к реальным
// сообщениям), затем обычным sendMessage с attachment_url/attachment_meta.
// Сжимаем фото перед отправкой — большинство телефонных снимков исходно
// 3000-4000px и по несколько МБ, а в чате реально показываются где-то
// 280px шириной (см. .message-image). Ресайз до разумного максимума +
// перекодирование в JPEG ощутимо ускоряет отправку и экономит место в
// Storage без заметной потери качества на экране. GIF не трогаем —
// пересжатие убило бы анимацию.
const MAX_IMAGE_DIMENSION = 1600;
const IMAGE_COMPRESS_QUALITY = 0.82;

async function compressImageFile(file, { maxDimension = MAX_IMAGE_DIMENSION } = {}) {

    if (!file.type.startsWith("image/") || file.type === "image/gif") return file;

    try {

        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));

        // Уже меньше лимита и это и так JPEG небольшого размера — пересжатие
        // почти наверняка только ухудшит картинку без выигрыша в размере.
        if (scale === 1 && file.type === "image/jpeg" && file.size < 600 * 1024) {
            bitmap.close?.();
            return file;
        }

        const width = Math.round(bitmap.width * scale);
        const height = Math.round(bitmap.height * scale);

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context2d = canvas.getContext("2d");
        // JPEG не умеет прозрачность: без белой подложки прозрачные места PNG
        // (скриншоты, логотипы, стикеры) превращались в чёрный фон.
        context2d.fillStyle = "#ffffff";
        context2d.fillRect(0, 0, width, height);
        context2d.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY));
        if (!blob || blob.size >= file.size) return file; // сжатие не помогло — шлём оригинал

        const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        return new File([blob], newName, { type: "image/jpeg" });

    } catch (error) {
        console.warn("Не удалось сжать изображение, отправляем как есть", error);
        return file;
    }

}

// Вложения (файлы, голосовые, видео-кружки) в секретных чатах НЕ шифруются —
// шифруется только text (см. sendSecretMessage в crypto.js), всё остальное
// ушло бы в публичный Storage открытым файлом, создавая у человека ложное
// ощущение защищённости. handleAttachFile отсекает это для обычных файлов,
// но голосовые/кружки (sendRealRecording) шли в обход той проверки.
function isSecretChatId(chatId) {
    if (chatId === currentChatId && currentChatIsSecret) return true;
    return !!cachedChatRows.find((r) => r.chat_id === chatId)?.chats?.is_secret;
}

async function sendRealAttachment(file, type) {

    // Снимок на момент вызова — та же причина, что и в sendRealMessage:
    // загрузка файла может занять заметное время, пользователь может
    // успеть переключиться в другой чат до того, как она завершится.
    const targetChatId = currentChatId;

    if (isSecretChatId(targetChatId)) {
        toast("Вложения в секретных чатах пока не поддерживаются");
        return;
    }

    closeAttachMenu();

    // Сначала сжатие, потом проверка размера: снимок с телефона на 25 МБ после
    // сжатия весит ~1 МБ, а раньше отвергался ещё до попытки.
    if (type === "image") {
        file = await compressImageFile(file);
    }

    if (file.size > MAX_ATTACHMENT_SIZE) {
        toast(`Файл слишком большой (максимум ${formatFileSize(MAX_ATTACHMENT_SIZE)})`);
        return;
    }

    const replyToId = pendingReply?.messageId || null;
    if (currentChatId === targetChatId) {
        pendingReply = null;
        document.getElementById("reply-preview").classList.remove("visible");
    }

    toast("Загружаем файл…");

    let message;
    let uploadedUrl = null;
    try {
        uploadedUrl = await KabanAPI.uploadAttachment(targetChatId, file);
        message = await KabanAPI.sendMessage(targetChatId, {
            type,
            attachmentUrl: uploadedUrl,
            attachmentMeta: { name: file.name, size: file.size, mime: file.type },
            replyToId
        });
    } catch (error) {
        // Файл уже залит, а сообщение не создалось (нет прав слать медиа, обрыв) —
        // не оставляем «сироту» в хранилище.
        if (uploadedUrl) KabanAPI.deleteStorageFile("attachments", uploadedUrl).catch(() => {});
        toast("Не удалось отправить файл: " + (error?.message || error));
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

// Звуковая волна голосового — считается ОДИН раз, в момент записи, а не
// при каждом открытии чата: decodeAudioData разбирает блоб на PCM-сэмплы,
// дальше они усредняются по модулю в WAVEFORM_BAR_COUNT бакетов (это и
// есть "столбики" волны) и нормализуются к диапазону [0.08, 1] — минимум
// 0.08, чтобы тихие паузы не схлопывались в невидимую линию, как в
// настоящих мессенджерах. Результат кладётся прямо в attachment_meta.waveform,
// рендер в script-messages.js просто рисует готовый массив, ничего не
// декодируя повторно. Если decodeAudioData не осилил формат — не страшно,
// null, и плеер молча показывает обычную плоскую полосу прогресса.
const WAVEFORM_BAR_COUNT = 42;

async function computeWaveformPeaks(blob) {

    try {

        const arrayBuffer = await blob.arrayBuffer();
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;

        const audioCtx = new AudioContextClass();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        const channelData = audioBuffer.getChannelData(0);
        audioCtx.close?.();

        const samplesPerBucket = Math.max(1, Math.floor(channelData.length / WAVEFORM_BAR_COUNT));
        // Для визуализации достаточно примерной огибающей — сканировать
        // КАЖДЫЙ сэмпл многоминутной записи (десятки миллионов проходов)
        // синхронно на основном потоке подряд реально подвешивает интерфейс
        // прямо в момент отправки голосового. Шаг прорежает проходимые сэмплы
        // внутри бакета (не сами бакеты — их видимое разрешение не меняется),
        // а периодический await отдаёт поток браузеру между бакетами, чтобы
        // тост/анимации успевали перерисовываться даже на очень длинной записи.
        const stride = Math.max(1, Math.floor(samplesPerBucket / 400));
        const peaks = [];

        for (let i = 0; i < WAVEFORM_BAR_COUNT; i++) {
            const start = i * samplesPerBucket;
            const end = Math.min(start + samplesPerBucket, channelData.length);
            let sum = 0;
            let count = 0;
            for (let j = start; j < end; j += stride) { sum += Math.abs(channelData[j]); count++; }
            peaks.push(count > 0 ? sum / count : 0);
            if (i % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const max = Math.max(...peaks, 0.0001);
        return peaks.map((p) => Math.round(Math.max(0.08, Math.min(1, p / max)) * 100) / 100);

    } catch (error) {
        console.warn("Не удалось построить звуковую волну", error);
        return null;
    }

}

// Голосовое/видео-кружок из startRecording (MediaRecorder) — тот же путь
// загрузки, что и обычный файл (attachments-бакет), просто Blob без имени
// оборачиваем в File, потому что uploadAttachment строит путь из file.name.
async function sendRealRecording(blob, mode, duration, targetChatId = currentChatId, replyToId = null) {

    if (isSecretChatId(targetChatId)) {
        toast("Голосовые и видео-кружки в секретных чатах пока не поддерживаются");
        return;
    }

    const type = mode === "video" ? "video_note" : "voice";
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const file = new File([blob], `${type}_${Date.now()}.${ext}`, { type: blob.type });

    if (file.size > MAX_ATTACHMENT_SIZE) {
        toast(`Запись слишком большая (максимум ${formatFileSize(MAX_ATTACHMENT_SIZE)})`);
        return;
    }

    // Очищаем только тот ответ, который был выбран для этой записи. Если
    // пользователь уже открыл другой чат, его состояние компоновщика не трогаем.
    if (currentChatId === targetChatId && (pendingReply?.messageId || null) === replyToId) {
        pendingReply = null;
        document.getElementById("reply-preview").classList.remove("visible");
    }

    toast("Отправляем запись…");

    const waveform = type === "voice" ? await computeWaveformPeaks(blob) : null;

    let message;
    let uploadedUrl = null;
    try {
        uploadedUrl = await KabanAPI.uploadAttachment(targetChatId, file);
        message = await KabanAPI.sendMessage(targetChatId, {
            type,
            attachmentUrl: uploadedUrl,
            attachmentMeta: waveform ? { duration, mime: file.type, waveform } : { duration, mime: file.type },
            replyToId
        });
    } catch (error) {
        if (uploadedUrl) KabanAPI.deleteStorageFile("attachments", uploadedUrl).catch(() => {});
        toast("Не удалось отправить запись: " + (error?.message || error));
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

async function startRealChatWith(userId) {

    closeNewChatPopover();

    try {
        const chatId = await KabanAPI.getOrCreateDirectChat(userId);
        if (!cachedChatRows.some((row) => row.chat_id === chatId)) await loadChatList();
        await openRealChat(chatId);
    } catch (error) {
        toast("Не удалось начать чат: " + (error?.message || error));
    }

}

async function handleSignOut() {

    if (typeof KabanAuth === "undefined" || typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED) {
        toast("Supabase не настроен");
        return;
    }

    try {
        await KabanAPI.updateMyPresence(false); // до signOut — после него запрос уйдёт неавторизованным
        await KabanAuth.signOut();
        // Явный выход: черновики и расшифровки голосовых — личный текст этого
        // аккаунта, на общем устройстве после выхода они не должны оставаться.
        try {
            Object.keys(localStorage)
                .filter((key) => key.startsWith(DRAFT_STORAGE_KEY + ":") || key === "kaban-transcripts")
                .forEach((key) => localStorage.removeItem(key));
        } catch { /* хранилище недоступно */ }
        closeSettings();
        document.getElementById("auth-form").reset();
        setAuthMode("signin");
        restoreDemoState();
        openAuthScreen();
    } catch (error) {
        toast("Не удалось выйти: " + (error?.message || error));
    }

}

function openAuthScreen() {
    const screen = document.getElementById("auth-screen");
    screen.classList.add("open");
    screen.setAttribute("aria-hidden", "false");
}

function closeAuthScreen() {
    const screen = document.getElementById("auth-screen");
    screen.classList.remove("open");
    screen.setAttribute("aria-hidden", "true");
}

// Кнопка "Выйти" в настройках нужна только когда реально есть из чего выходить.
function syncAccountSection() {
    const configured = typeof IS_SUPABASE_CONFIGURED !== "undefined" && IS_SUPABASE_CONFIGURED;
    document.getElementById("settings-account-label").hidden = !configured;
    document.getElementById("settings-account-section").hidden = !configured;
    const profileLink = document.getElementById("settings-profile-link");
    if (profileLink) profileLink.hidden = !cachedMyProfile;
}

async function initAuthGate() {

    syncAccountSection();

    if (typeof IS_SUPABASE_CONFIGURED === "undefined" || !IS_SUPABASE_CONFIGURED) {
        return; // демо-режим без бэкенда — экран входа не нужен
    }

    // Переход по ссылке "сбросить пароль" из письма — Supabase кладёт
    // access_token и type=recovery в хэш URL. Проверяем это синхронно ДО
    // getCurrentUser(), а не через событие PASSWORD_RECOVERY: так надёжнее —
    // не зависит от того, успеет ли обработчик подписаться раньше, чем
    // supabase-js сам разберёт токен из URL при создании клиента.
    const isRecoveryLink = window.location.hash.includes("type=recovery");

    try {
        const user = await KabanAuth.getCurrentUser();
        if (isRecoveryLink) {
            // К этому моменту supabase-js уже успел создать временную сессию
            // восстановления из токена в URL (getCurrentUser выше это
            // гарантирует) — показываем экран задания нового пароля вместо
            // обычного входа в приложение с этой сессией.
            openAuthScreen();
            setAuthMode("recovery");
            history.replaceState(null, "", window.location.pathname + window.location.search);
        } else if (user) {
            await applyRealSessionState(user);
        } else {
            openAuthScreen();
        }
    } catch (error) {
        openAuthScreen();
    }

}

initAuthGate();

