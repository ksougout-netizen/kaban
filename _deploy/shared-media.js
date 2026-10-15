/* ============================================================================
   ОБЩИЕ МЕДИА ЗА ВСЮ ИСТОРИЮ ЧАТА
   Раньше раздел «Медиа / Файлы / Ссылки / Голосовые» собирался только из уже
   загруженных сообщений (последние ~50): в длинной переписке старые фото и
   файлы появлялись там, лишь когда до них докрутишь. Теперь вложения и ссылки
   чата берутся с сервера отдельным запросом (до 600 последних), а при нажатии
   на старый материал лента сама догружает историю до нужного сообщения.
   ========================================================================= */

(function () {
    const CACHE_MS = 60000;
    const cache = new Map();          // chatId → { at, messages[], promise }

    async function fetchShared(chatId) {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from("messages")
            .select("id, chat_id, sender_id, type, text, attachment_url, attachment_meta, created_at, deleted_at, encryption_iv")
            .eq("chat_id", chatId)
            .or("type.in.(image,video,document,audio,voice),and(type.eq.text,text.ilike.*http*),and(type.eq.text,text.ilike.*www.*)")
            .is("encryption_iv", null)
            .order("created_at", { ascending: false })
            .limit(600);
        if (error) throw error;
        return data || [];
    }

    // Загрузить (или взять из кэша) материалы чата; по готовности — перерисовать то, что открыто.
    function ensureShared(chatId, force) {
        if (!chatId || (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret)) return Promise.resolve([]);
        const entry = cache.get(chatId);
        if (entry?.promise) return entry.promise;
        if (entry && !force && Date.now() - entry.at < CACHE_MS) return Promise.resolve(entry.messages);
        const promise = fetchShared(chatId)
            .then((messages) => {
                cache.set(chatId, { at: Date.now(), messages });
                if (currentChatId === chatId) refreshOpenViews();
                return messages;
            })
            .catch(() => {
                cache.set(chatId, { at: Date.now() - CACHE_MS + 10000, messages: entry?.messages || [] });   // повторим через 10 с
                return entry?.messages || [];
            });
        cache.set(chatId, { ...(entry || { at: 0, messages: [] }), promise });
        return promise;
    }

    function refreshOpenViews() {
        try { renderSharedMediaDataForCurrentChat(); } catch { /* ок */ }
        try { if (typeof updateContactModalStats === "function") updateContactModalStats(); } catch { /* ок */ }
        try { if (typeof updateGroupMediaStats === "function") updateGroupMediaStats(); } catch { /* ок */ }
        const modal = document.getElementById("shared-media-backdrop");
        if (modal?.classList.contains("open") && typeof renderSharedMediaList === "function") {
            const tab = document.querySelector("#shared-media-backdrop .shared-tab.active")?.dataset.mediaTab || "media";
            try { renderSharedMediaList(tab, document.getElementById("shared-media-search")?.value || ""); } catch { /* ок */ }
        }
    }

    // Сбор материалов: загруженные сообщения + материалы с сервера (без повторов).
    if (typeof collectSharedMediaFromChat === "function") {
        const original = collectSharedMediaFromChat;
        collectSharedMediaFromChat = function () {
            const extra = cache.get(currentChatId)?.messages || [];
            if (!extra.length) return original.apply(this, arguments);
            const added = [];
            extra.forEach((message) => {
                if (!realMessagesById.has(message.id)) { realMessagesById.set(message.id, message); added.push(message.id); }
            });
            try {
                return original.apply(this, arguments);
            } finally {
                // Подмешивали только на время сбора: в саму ленту эти сообщения не попадают.
                added.forEach((id) => realMessagesById.delete(id));
            }
        };
    }

    // Нажали на материал, которого ещё нет в ленте, — догружаем историю до него.
    if (typeof jumpToSharedMediaMessage === "function") {
        const originalJump = jumpToSharedMediaMessage;
        jumpToSharedMediaMessage = function (messageId) {
            if (document.querySelector(`.message-row[data-message-id="${messageId}"]`) || typeof jumpToMessage !== "function") {
                return originalJump.apply(this, arguments);
            }
            closeSharedMediaModal();
            closeContactPopover();
            closeInfoModal();
            if (typeof closeGroupInfoModal === "function") closeGroupInfoModal();
            jumpToMessage(currentChatId, messageId);
        };
    }

    // Когда подгружать: при открытии чата и при открытии окон, где видны материалы.
    const hook = (name, after) => {
        if (typeof window[name] !== "function") return;
        const original = window[name];
        window[name] = function () {
            const result = original.apply(this, arguments);
            after();
            return result;
        };
    };
    hook("openRealChat", () => setTimeout(() => ensureShared(currentChatId), 1200));
    hook("openSharedMediaModal", () => ensureShared(currentChatId));
    hook("openInfoModal", () => ensureShared(currentChatId));
    hook("openGroupInfoModal", () => ensureShared(currentChatId));
    hook("toggleContactPopover", () => ensureShared(currentChatId));

    window.KabanSharedMedia = { ensure: ensureShared, _cache: cache };
})();
