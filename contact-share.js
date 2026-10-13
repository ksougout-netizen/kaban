/* ============================================================================
   «ПОДЕЛИТЬСЯ КОНТАКТОМ» — как в Telegram.
     • Кнопка в карточке собеседника открывает окно «Отправить контакт»: список моих
       чатов и контактов с поиском; тап по строке — карточка уходит в этот чат.
     • Получатель нажимает на карточку — открывается профиль человека (имя, @ник,
       «О себе»), оттуда можно написать ему, добавить в контакты, скопировать @ник.
   Переопределяет shareContact() и openContactFromMessage() из script-ui.js /
   script-messages.js (те же имена — все onclick в разметке продолжают работать).
   ========================================================================= */

(function () {
    const esc = (s) => escapeHTML(String(s ?? ""));

    function avatarHTML(user, cls) {
        const a = avatarParts({ id: user.id || user.name, name: user.name || "?", url: user.avatar_url });
        return `<span class="${cls}${a.cls}"${a.style}>${a.inner}</span>`;
    }

    /* ---------- кого отправляем ---------- */

    async function currentPerson() {
        const id = typeof currentOtherUserId !== "undefined" ? currentOtherUserId : null;
        if (!id) return null;
        const row = cachedChatRows.find((r) => r.chats?.type !== "group" && r.otherUser?.id === id);
        let user = row?.otherUser ? { ...row.otherUser } : null;
        if (!user?.username || user.avatar_url === undefined) {
            try {
                const { data } = await getSupabaseClient().from("users").select("id, display_name, username, avatar_url").eq("id", id).maybeSingle();
                if (data) user = { ...(user || {}), ...data };
            } catch { /* обойдёмся тем, что есть */ }
        }
        if (!user) return null;
        return {
            id,
            name: user.display_name || user.username || "Пользователь",
            username: user.username || "",
            avatar_url: user.avatar_url || ""
        };
    }

    /* ---------- окно выбора, куда отправить ---------- */

    let picker = null;
    let shared = null;

    function targets() {
        return cachedChatRows
            .filter((row) => !row.chats?.is_secret)
            .map((row) => {
                const chat = row.chats || {};
                const isGroup = chat.type === "group";
                // У групп в строке списка тоже бывает otherUser (последний автор) — не путаем с личным чатом.
                const other = isGroup ? null : row.otherUser;
                const isSaved = !isGroup && !other;
                if (other && shared && other.id === shared.id) return null;     // себе же его не шлём
                const name = isGroup ? (chat.title || "Группа")
                    : isSaved ? "Избранное"
                    : (loadContactAlias(other.id) || other.display_name || "Пользователь");
                return {
                    chatId: chat.id || row.chat_id,
                    name,
                    sub: isGroup ? "Группа" : isSaved ? "Сохранённые сообщения" : (other.username ? "@" + other.username : ""),
                    avatar_url: isGroup ? chat.avatar_url : other?.avatar_url,
                    saved: isSaved,
                    group: isGroup,
                    avatarId: isGroup ? chat.id : other?.id
                };
            })
            .filter(Boolean);
    }

    function renderTargets() {
        const q = picker.querySelector(".cs-search").value.trim().toLocaleLowerCase();
        const list = picker.querySelector(".cs-list");
        const items = targets().filter((t) => !q || t.name.toLocaleLowerCase().includes(q) || t.sub.toLocaleLowerCase().includes(q));
        list.innerHTML = items.map((t) => `
            <button type="button" class="cs-row" data-chat="${esc(t.chatId)}">
                ${t.saved
                    ? `<span class="cs-avatar cs-avatar-saved"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z"/></svg></span>`
                    : avatarHTML({ id: t.avatarId, name: t.name, avatar_url: t.avatar_url }, "cs-avatar")}
                <span class="cs-row-copy"><span class="cs-row-name">${esc(t.name)}</span>${t.sub ? `<span class="cs-row-sub">${esc(t.sub)}</span>` : ""}</span>
            </button>`).join("") || `<div class="cs-empty">${q ? "Никого не нашли" : "Пока нет чатов, куда можно отправить"}</div>`;
    }

    function buildPicker() {
        if (picker) return picker;
        picker = document.createElement("div");
        picker.className = "cs-backdrop";
        picker.setAttribute("aria-hidden", "true");
        picker.innerHTML = `
            <div class="cs-card" role="dialog" aria-modal="true" aria-label="Отправить контакт">
                <div class="cs-head">
                    <button type="button" class="cs-close" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
                    <span class="cs-title">Отправить контакт</span>
                </div>
                <div class="cs-preview"></div>
                <input type="search" class="cs-search" placeholder="Кому отправить?" autocomplete="off" aria-label="Поиск чата">
                <div class="cs-list"></div>
            </div>`;
        document.body.appendChild(picker);

        picker.addEventListener("click", (e) => {
            if (e.target === picker || e.target.closest(".cs-close")) { closePicker(); return; }
            const row = e.target.closest(".cs-row");
            if (row) sendTo(row.dataset.chat);
        });
        picker.querySelector(".cs-search").addEventListener("input", renderTargets);
        document.addEventListener("keydown", (e) => {
            if (picker.classList.contains("open") && e.key === "Escape") closePicker();
        });
        return picker;
    }

    function closePicker() {
        if (!picker) return;
        picker.classList.remove("open");
        picker.setAttribute("aria-hidden", "true");
    }

    async function sendTo(chatId) {
        const person = shared;
        closePicker();
        if (!person || !chatId) return;
        const target = targets().find((t) => t.chatId === chatId);
        let message;
        try {
            message = await KabanAPI.sendMessage(chatId, {
                type: "contact",
                attachmentMeta: {
                    user_id: person.id,
                    display_name: person.name,
                    ...(person.username ? { username: person.username } : {}),
                    ...(person.avatar_url ? { avatar_url: person.avatar_url } : {})
                }
            });
        } catch (error) {
            toast("Не удалось отправить контакт: " + sendErrorText(error));
            return;
        }
        realMessagesById.set(message.id, message);
        if (currentChatId === chatId) {
            appendRealMessageRow(message, true);
            updateMessageGrouping();
            if (appSettings.sendSound) playSendSound();
            if (appSettings.autoScroll) scrollMessagesToBottom();
        }
        patchCachedChatLastMessage(chatId, message);
        toast(`Контакт «${person.name}» отправлен${target ? ": " + target.name : ""}`);
    }

    window.shareContact = async function () {
        if (typeof closeContactPopover === "function") closeContactPopover();
        if (currentChatIsSecret) { toast("В секретных чатах контакты не отправляются"); return; }
        const person = await currentPerson();
        if (!person) { toast("Не удалось определить контакт"); return; }
        shared = person;

        buildPicker();
        picker.querySelector(".cs-preview").innerHTML = `
            ${avatarHTML({ id: person.id, name: person.name, avatar_url: person.avatar_url }, "cs-avatar")}
            <span class="cs-row-copy"><span class="cs-row-name">${esc(person.name)}</span><span class="cs-row-sub">${person.username ? "@" + esc(person.username) : "Контакт"}</span></span>`;
        const input = picker.querySelector(".cs-search");
        input.value = "";
        renderTargets();
        picker.classList.add("open");
        picker.setAttribute("aria-hidden", "false");
        input.focus();
    };

    /* ---------- профиль по тапу на карточку контакта ---------- */

    let profile = null;
    let profileUser = null;

    function closeProfile() {
        if (!profile) return;
        profile.classList.remove("open");
        profile.setAttribute("aria-hidden", "true");
    }

    function buildProfile() {
        if (profile) return profile;
        profile = document.createElement("div");
        profile.className = "cs-backdrop";
        profile.setAttribute("aria-hidden", "true");
        profile.innerHTML = `
            <div class="cs-card cs-profile" role="dialog" aria-modal="true" aria-label="Профиль">
                <button type="button" class="cs-close cs-close-abs" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
                <div class="cs-profile-top"></div>
                <div class="cs-profile-info"></div>
                <div class="cs-profile-actions">
                    <button type="button" class="cs-primary" data-act="write">Написать сообщение</button>
                    <button type="button" class="cs-secondary" data-act="save"></button>
                    <button type="button" class="cs-secondary" data-act="copy">Скопировать @ник</button>
                </div>
            </div>`;
        document.body.appendChild(profile);
        profile.addEventListener("click", async (e) => {
            if (e.target === profile || e.target.closest(".cs-close")) { closeProfile(); return; }
            const act = e.target.closest("[data-act]")?.dataset.act;
            const u = profileUser;
            if (!act || !u) return;
            if (act === "write") { closeProfile(); startRealChatWith(u.id); }
            else if (act === "copy") {
                navigator.clipboard?.writeText("@" + u.username).then(() => toast("Скопировано: @" + u.username)).catch(() => toast("Не удалось скопировать"));
            } else if (act === "save") {
                const was = isSavedContact(u.id);
                await setSavedContact(u.id, !was);
                syncSaveButton();
            }
        });
        document.addEventListener("keydown", (e) => { if (profile.classList.contains("open") && e.key === "Escape") closeProfile(); });
        return profile;
    }

    function syncSaveButton() {
        const btn = profile.querySelector('[data-act="save"]');
        const saved = isSavedContact(profileUser.id);
        btn.textContent = saved ? "Убрать из контактов" : "Добавить в контакты";
        btn.classList.toggle("is-danger", saved);
    }

    function paintProfile(u) {
        profileUser = u;
        const name = loadContactAlias(u.id) || u.display_name || u.username || "Пользователь";
        profile.querySelector(".cs-profile-top").innerHTML = avatarHTML({ id: u.id, name, avatar_url: u.avatar_url }, "cs-avatar cs-avatar-big")
            + `<div class="cs-profile-name">${esc(name)}${u.status_emoji ? ` <span class="cs-profile-status">${esc(u.status_emoji)}</span>` : ""}</div>`
            + (u.username ? `<div class="cs-profile-user">@${esc(u.username)}</div>` : "");
        profile.querySelector(".cs-profile-info").innerHTML = u.bio
            ? `<div class="cs-info-block"><div class="cs-info-label">О себе</div><div class="cs-info-text">${esc(u.bio)}</div></div>` : "";
        profile.querySelector('[data-act="copy"]').hidden = !u.username;
        syncSaveButton();
    }

    window.openContactFromMessage = async function (userId, el) {
        if (!userId) { toast("Профиль недоступен"); return; }
        if (userId === myRealUserId) { openProfileScreen(); return; }

        // что знаем из самой карточки сообщения — показываем сразу, остальное дозагружаем
        const card = el?.closest?.(".message-contact") || el || null;
        const known = {
            id: userId,
            display_name: card?.querySelector(".message-contact-title")?.textContent?.trim() || "",
            username: (card?.querySelector(".message-contact-hint")?.textContent || "").startsWith("@")
                ? card.querySelector(".message-contact-hint").textContent.trim().slice(1) : ""
        };
        const row = cachedChatRows.find((r) => r.chats?.type !== "group" && r.otherUser?.id === userId);
        const base = { ...known, ...(row?.otherUser || {}) };

        buildProfile();
        paintProfile(base);
        profile.classList.add("open");
        profile.setAttribute("aria-hidden", "false");

        try {
            const { data } = await getSupabaseClient().from("users")
                .select("id, display_name, username, avatar_url, bio, status_emoji").eq("id", userId).maybeSingle();
            if (data && profile.classList.contains("open") && profileUser?.id === userId) paintProfile({ ...base, ...data });
        } catch { /* остаёмся с тем, что было в карточке */ }
    };
})();
