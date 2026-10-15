/* ============================================================================
   ЖИВЫЕ МЕЛОЧИ
   1. Полёт сообщения: отправленное сообщение вылетает из поля ввода и встаёт
      на своё место в ленте (как в Telegram).
   2. Живые галочки: вторая галочка «прочитано» дорисовывается слева направо
      (сами галочки — в style.css, «ЖИВЫЕ ГАЛОЧКИ»).
   3. Капсула времени: сообщение запечатано до выбранной даты; у получателя —
      обратный отсчёт, а в срок капсула «вскрывается» с анимацией.
   4. Анимированный эмодзи-статус рядом с именем (список чатов, шапка, профиль)
      и расширенный выбор статусов.
   5. Перелёт аватарки из списка чатов в шапку при открытии чата и мягкий въезд
      сообщений лесенкой.
   Всё отключается настройкой «Уменьшить анимации».
   ========================================================================= */

(function () {
    "use strict";

    // + системная настройка «уменьшить движение», раньше учитывалась только своя.
    const osReduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const motionOff = () => !!appSettings.reduceMotion || !!osReduceMotion?.matches || document.hidden;
    const messagesEl = document.getElementById("messages");

    /* ---- 1. ПОЛЁТ СООБЩЕНИЯ ------------------------------------------------------- */

    let flyPending = null;   // { at, from: DOMRect }

    if (typeof sendRealMessage === "function") {
        const originalSend = sendRealMessage;
        sendRealMessage = function () {
            const input = document.getElementById("input");
            if (input && !motionOff()) flyPending = { at: performance.now(), from: input.getBoundingClientRect() };
            return originalSend.apply(this, arguments);
        };
    }

    function flyIn(row, from) {
        const bubble = row.querySelector(".message");
        if (!bubble || !messagesEl) return;
        requestAnimationFrame(() => {
            const r = bubble.getBoundingClientRect();
            if (!r.width) return;
            // Текст в поле ввода начинается у левого края поля — оттуда и «вылетает» пузырь.
            const dx = from.left + 14 - r.left;
            const dy = from.top + from.height / 2 - (r.top + r.height / 2);
            const scale = Math.min(1, Math.max(0.6, (from.height + 6) / Math.max(r.height, 1)));
            bubble.animate([
                { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.35, transformOrigin: "left center" },
                { opacity: 1, offset: 0.45 },
                { transform: "translate(0, 0) scale(1)", opacity: 1, transformOrigin: "left center" }
            ], { duration: 430, easing: "cubic-bezier(.2,.9,.25,1)" });
        });
    }

    /* ---- наблюдатель за лентой (полёт + лесенка при входе в чат) ---- */

    let enterRows = null;   // { until } — окно, в которое новые строки въезжают лесенкой

    if (messagesEl) {
        new MutationObserver((mutations) => {
            const added = [];
            mutations.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1 && n.classList.contains("message-row")) added.push(n); }));
            if (!added.length) return;
            if (flyPending && performance.now() - flyPending.at < 1500) {
                const row = added.find((n) => n.classList.contains("sent"));
                if (row) { const from = flyPending.from; flyPending = null; flyIn(row, from); }
            }
        }).observe(messagesEl, { childList: true });
    }

    /* ---- 2. ЖИВЫЕ ГАЛОЧКИ — целиком в CSS (дорисовка при смене data-status) ---- */

    /* ---- 3. КАПСУЛА ВРЕМЕНИ ---------------------------------------------------------- */

    const CAP_OPENED_KEY = "kaban-capsules-opened";
    const HOURGLASS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 4.5 4.5 5.5 4.5 8.5s-4.5 4-4.5 8.5M16.5 3.5c0 4.5-4.5 5.5-4.5 8.5s4.5 4 4.5 8.5"/><path class="cap-sand" d="M9.5 18.5h5L12 15.5z"/></svg>`;

    const capDateFmt = (d) => {
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }), hour: "2-digit", minute: "2-digit" }).format(d);
    };

    function capLeft(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        const p = (n) => String(n).padStart(2, "0");
        return d ? `${d} д ${p(h)}:${p(m)}:${p(sec)}` : `${p(h)}:${p(m)}:${p(sec)}`;
    }

    function capOpenAt(message) {
        const t = Date.parse(message.attachment_meta?.capsule?.open_at || "");
        return Number.isFinite(t) ? t : null;
    }

    function openedCapsules() {
        try { return new Set(JSON.parse(localStorage.getItem(CAP_OPENED_KEY) || "[]")); } catch { return new Set(); }
    }
    function markCapsuleOpened(id) {
        const list = [...openedCapsules()].filter((x) => x !== id);
        list.push(id);
        try { localStorage.setItem(CAP_OPENED_KEY, JSON.stringify(list.slice(-400))); } catch { /* ок */ }
    }

    function capTag(bubble, text) {
        let tag = bubble.querySelector(".cap-tag");
        if (!tag) {
            bubble.insertAdjacentHTML("afterbegin", `<span class="cap-tag">${HOURGLASS}<span></span></span>`);
            tag = bubble.querySelector(".cap-tag");
        }
        // Пишем только изменившийся текст: иначе каждая запись снова будит наблюдатель
        // за лентой (wow.js) — и так по кругу, страница зависает.
        const label = tag.querySelector("span");
        if (label.textContent !== text) label.textContent = text;
    }

    function decorateCapsule(row, message) {
        const bubble = row.querySelector(".message");
        if (!bubble || bubble.querySelector(".message-edit-form")) return;
        const openAt = capOpenAt(message);
        if (!openAt) return;
        row.classList.add("cap-row");
        if (message.sender_id === myRealUserId) {
            capTag(bubble, openAt > Date.now() ? `Капсула · откроется ${capDateFmt(new Date(openAt))}` : "Капсула времени");
            return;
        }
        if (openedCapsules().has(message.id)) { capTag(bubble, "Капсула времени"); return; }
        if (bubble.querySelector(".cap-cover")) return;
        row.classList.add("cap-sealed");
        bubble.insertAdjacentHTML("afterbegin", `
            <button type="button" class="cap-cover" aria-label="Капсула времени">
                <span class="cap-icon">${HOURGLASS}</span>
                <b>Капсула времени</b>
                <span class="cap-when">Откроется ${capDateFmt(new Date(openAt))}</span>
                <span class="cap-count" data-open-at="${openAt}">${capLeft(openAt - Date.now())}</span>
            </button>`);
        const cover = bubble.querySelector(".cap-cover");
        cover.addEventListener("click", (event) => {
            event.stopPropagation();
            if (Date.now() < openAt) {
                cover.classList.remove("nudge");
                void cover.offsetWidth;
                cover.classList.add("nudge");
                return;
            }
            openCapsule(row, message, cover);
        });
        cover.addEventListener("contextmenu", (event) => event.stopPropagation());
        updateCapCover(cover, openAt);
        ensureCapTicker();
    }

    function updateCapCover(cover, openAt) {
        const left = openAt - Date.now();
        const count = cover.querySelector(".cap-count");
        if (left <= 0) {
            if (!cover.classList.contains("ready")) {
                cover.classList.add("ready");
                cover.querySelector(".cap-when").textContent = "Срок настал";
                count.textContent = "Нажмите, чтобы открыть";
            }
            return false;
        }
        count.textContent = capLeft(left);
        return true;
    }

    let capTimer = null;
    function ensureCapTicker() {
        if (capTimer) return;
        capTimer = setInterval(() => {
            const covers = document.querySelectorAll(".cap-cover:not(.ready)");
            if (!covers.length) { clearInterval(capTimer); capTimer = null; return; }
            covers.forEach((cover) => updateCapCover(cover, Number(cover.querySelector(".cap-count")?.dataset.openAt)));
        }, 1000);
    }

    function openCapsule(row, message, cover) {
        if (cover.classList.contains("opening")) return;
        markCapsuleOpened(message.id);
        const finish = () => {
            cover.remove();
            row.classList.remove("cap-sealed");
            row.classList.add("cap-revealed");
            const bubble = row.querySelector(".message");
            if (bubble) capTag(bubble, "Капсула времени");
            setTimeout(() => row.classList.remove("cap-revealed"), 800);
        };
        if (motionOff()) { finish(); return; }
        cover.classList.add("opening");
        const icon = cover.querySelector(".cap-icon").getBoundingClientRect();
        if (window.KabanWow?.particles) {
            const cx = icon.left + icon.width / 2, cy = icon.top + icon.height / 2;
            const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#0a7cff";
            const colors = ["#ffd36b", "#ffffff", "#9fd3ff", accent, "#ff9ad5"];
            const list = [];
            for (let i = 0; i < 110; i++) {
                const a = Math.random() * Math.PI * 2, sp = 120 + Math.random() * 360;
                list.push(KabanWow.particle(cx, cy, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, ay: 260, drag: 1.4, size: 2 + Math.random() * 4, color: colors[i % colors.length], life: 0.8 + Math.random() * 0.8, delay: 0.42 + Math.random() * 0.06, round: i % 2 === 0 }));
            }
            KabanWow.particles(list);
        }
        setTimeout(() => { if (typeof playMessageEffect === "function") playMessageEffect("sparkles"); }, 480);
        setTimeout(finish, 760);
    }

    if (typeof window.KabanWowDecorate === "function") {
        window.KabanWowDecorate((row, message) => {
            if (message.attachment_meta?.capsule && message.type === "text" && !message.deleted_at) decorateCapsule(row, message);
        });
    }

    // Окно «Капсула времени»
    let capChoice = null;

    const CAP_PRESETS = [
        { id: "tomorrow", label: "Завтра утром", at: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
        { id: "week", label: "Через неделю", at: () => new Date(Date.now() + 7 * 864e5) },
        { id: "month", label: "Через месяц", at: () => { const d = new Date(); d.setMonth(d.getMonth() + 1); return d; } },
        { id: "newyear", label: "В Новый год", at: () => new Date(new Date().getFullYear() + 1, 0, 1, 0, 0, 0) },
        { id: "custom", label: "Своя дата", at: null }
    ];

    function localInputValue(d) {
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }

    function openCapsuleComposer() {
        if (typeof closeAttachMenu === "function") closeAttachMenu();
        if (!currentChatId) { toast("Сначала откройте чат"); return; }
        if (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret) { toast("Капсулы в секретных чатах пока не поддерживаются"); return; }
        let backdrop = document.getElementById("cap-backdrop");
        if (!backdrop) {
            backdrop = document.createElement("div");
            backdrop.id = "cap-backdrop";
            backdrop.className = "wow-gift-backdrop cap-backdrop";
            backdrop.setAttribute("aria-hidden", "true");
            backdrop.innerHTML = `
                <div class="wow-gift-dialog cap-dialog" role="dialog" aria-modal="true" aria-labelledby="cap-title">
                    <div class="cap-hero"><span class="cap-icon big">${HOURGLASS}</span></div>
                    <h3 id="cap-title">Капсула времени</h3>
                    <p class="wow-gift-hint">Собеседник увидит запечатанную капсулу с обратным отсчётом. Открыть её можно только в выбранный момент.</p>
                    <textarea id="cap-text" maxlength="2000" rows="3" placeholder="Письмо в будущее…"></textarea>
                    <div class="cap-presets" role="radiogroup" aria-label="Когда открыть">
                        ${CAP_PRESETS.map((p) => `<button type="button" role="radio" class="cap-preset" data-preset="${p.id}">${p.label}</button>`).join("")}
                    </div>
                    <input type="datetime-local" id="cap-date" class="cap-date" hidden>
                    <div class="cap-summary" id="cap-summary"></div>
                    <div class="wow-gift-actions">
                        <button type="button" class="wow-gift-cancel">Отмена</button>
                        <button type="button" class="wow-gift-send cap-send">Запечатать</button>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.addEventListener("click", (event) => {
                if (event.target === backdrop || event.target.closest(".wow-gift-cancel")) { closeCapsuleComposer(); return; }
                const preset = event.target.closest(".cap-preset");
                if (preset) selectPreset(preset.dataset.preset);
                if (event.target.closest(".cap-send")) sendCapsule();
            });
            backdrop.addEventListener("keydown", (event) => {
                if (event.key === "Escape") { event.stopPropagation(); closeCapsuleComposer(); }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) sendCapsule();
            });
            document.getElementById("cap-date").addEventListener("input", (event) => {
                const t = Date.parse(event.target.value);
                capChoice = Number.isFinite(t) ? new Date(t) : null;
                syncCapSummary();
            });
        }
        selectPreset("tomorrow");
        backdrop.classList.add("open");
        backdrop.setAttribute("aria-hidden", "false");
        setTimeout(() => document.getElementById("cap-text")?.focus(), 60);
    }

    function selectPreset(id) {
        const preset = CAP_PRESETS.find((p) => p.id === id) || CAP_PRESETS[0];
        document.querySelectorAll(".cap-preset").forEach((b) => {
            const on = b.dataset.preset === preset.id;
            b.classList.toggle("active", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
        });
        const input = document.getElementById("cap-date");
        input.min = localInputValue(new Date(Date.now() + 60000));
        input.max = localInputValue(new Date(Date.now() + 5 * 365 * 864e5));
        if (preset.at) {
            capChoice = preset.at();
            input.hidden = true;
        } else {
            capChoice = capChoice && capChoice > new Date() ? capChoice : new Date(Date.now() + 3 * 864e5);
            input.value = localInputValue(capChoice);
            input.hidden = false;
            input.focus();
        }
        syncCapSummary();
    }

    function syncCapSummary() {
        const el = document.getElementById("cap-summary");
        if (!el) return;
        if (!capChoice || capChoice.getTime() < Date.now() + 30000) { el.textContent = "Выберите время в будущем"; el.classList.add("bad"); return; }
        el.classList.remove("bad");
        const mins = Math.round((capChoice.getTime() - Date.now()) / 60000);
        const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
        const span = d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
        el.textContent = `Откроется ${capDateFmt(capChoice)} · через ${span}`;
    }

    function closeCapsuleComposer() {
        const backdrop = document.getElementById("cap-backdrop");
        if (!backdrop) return;
        backdrop.classList.remove("open");
        backdrop.setAttribute("aria-hidden", "true");
    }

    async function sendCapsule() {
        const field = document.getElementById("cap-text");
        const text = (field?.value || "").trim();
        if (!text) { field?.focus(); field?.classList.add("shake"); setTimeout(() => field?.classList.remove("shake"), 400); return; }
        if (!capChoice || capChoice.getTime() < Date.now() + 30000 || capChoice.getTime() > Date.now() + 5 * 366 * 864e5) { syncCapSummary(); return; }
        const chatId = currentChatId;
        if (!chatId) return;
        const openAt = capChoice.toISOString();
        closeCapsuleComposer();
        let message;
        try {
            message = await KabanAPI.sendMessage(chatId, { type: "text", text, attachmentMeta: { capsule: { open_at: openAt } } });
        } catch (error) {
            toast("Не удалось отправить капсулу: " + (typeof sendErrorText === "function" ? sendErrorText(error) : (error?.message || error)));
            return;
        }
        if (field) field.value = "";
        realMessagesById.set(message.id, message);
        if (currentChatId === chatId) {
            appendRealMessageRow(message, true);
            updateMessageGrouping();
            if (appSettings.sendSound && typeof playSendSound === "function") playSendSound();
            if (typeof scrollMessagesToBottom === "function") scrollMessagesToBottom();
        }
        if (typeof patchCachedChatLastMessage === "function") patchCachedChatLastMessage(chatId, message);
        toast(`Капсула запечатана до ${capDateFmt(new Date(openAt))}`);
    }

    window.openCapsuleComposer = openCapsuleComposer;
    window.closeCapsuleComposer = closeCapsuleComposer;

    (function addCapsuleMenuItem() {
        const menu = document.getElementById("attach-menu");
        if (!menu || menu.querySelector(".cap-menu-item")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "attach-menu-item cap-menu-item";
        button.setAttribute("role", "menuitem");
        button.innerHTML = `<span class="attach-menu-icon capsule" aria-hidden="true">${HOURGLASS}</span> Капсула времени`;
        button.addEventListener("click", openCapsuleComposer);
        const gift = menu.querySelector(".wow-gift-item");
        if (gift) gift.after(button); else menu.appendChild(button);
    })();

    if (typeof messagePreviewText === "function") {
        const originalPreview = messagePreviewText;
        messagePreviewText = function (message) {
            if (message?.attachment_meta?.capsule && !message.deleted_at) return "⏳ Капсула времени";
            return originalPreview.apply(this, arguments);
        };
    }

    /* ---- 4. АНИМИРОВАННЫЙ ЭМОДЗИ-СТАТУС --------------------------------------------- */

    // Больше статусов на выбор (у всех есть живая анимация).
    if (typeof STATUS_EMOJIS !== "undefined" && Array.isArray(STATUS_EMOJIS)) {
        ["😎", "🤩", "😇", "🤯", "🥶", "🤖", "👻", "💎", "⭐", "🌈", "🍀", "⚡", "🎯", "🏆", "🎸", "🍕", "🐱", "🦊", "💪", "🙏", "👑", "💫", "🌸", "🧠", "🥰", "😈", "🦄", "🐸"]
            .forEach((e) => { if (!STATUS_EMOJIS.includes(e)) STATUS_EMOJIS.push(e); });
    }

    function upgradeBadge(badge, loops) {
        if (badge.dataset.animUp || typeof animEmojiHTML !== "function") return;
        const emoji = badge.textContent.trim();
        if (!emoji) return;
        badge.dataset.animUp = "1";
        badge.innerHTML = animEmojiHTML(emoji, "status-anim", loops);
        const el = badge.firstElementChild;
        if (el && typeof registerAnimEmoji === "function") registerAnimEmoji(el);
    }

    function upgradeIn(root, loops) {
        if (!root || root.nodeType !== 1) return;
        if (root.matches?.(".status-emoji-badge")) upgradeBadge(root, loops);
        root.querySelectorAll?.(".status-emoji-badge").forEach((b) => upgradeBadge(b, loops));
    }

    // В списке чатов — проигрывается пару раз и замирает (лента не мельтешит),
    // при наведении на строку — снова; в шапке и профиле — постоянно.
    const sidebar = document.querySelector(".sidebar");
    if (sidebar) {
        upgradeIn(sidebar, 2);
        new MutationObserver((mutations) => mutations.forEach((m) => m.addedNodes.forEach((n) => upgradeIn(n, 2)))).observe(sidebar, { childList: true, subtree: true });
        sidebar.addEventListener("pointerover", (event) => {
            const row = event.target.closest?.(".chat");
            if (!row || row._statusReplayAt > performance.now() - 2500) return;
            row._statusReplayAt = performance.now();
            row.querySelectorAll(".status-anim").forEach((el) => {
                if (!el._animDone) return;
                el._animDone = false;
                if (typeof startAnimEmoji === "function") startAnimEmoji(el);
            });
        });
    }

    // Шапка чата и карточка собеседника: имя приходит строкой «Имя 🔥» — превращаем эмодзи в живой значок.
    if (typeof applyContactProfile === "function") {
        const originalApply = applyContactProfile;
        applyContactProfile = function (profile) {
            const result = originalApply.apply(this, arguments);
            try {
                const meta = cachedChatRows.find((r) => r.chat_id === currentChatId);
                const emoji = currentChatType === "direct" ? meta?.otherUser?.status_emoji : null;
                if (emoji && typeof profile?.name === "string" && profile.name.endsWith(" " + emoji)) {
                    const base = profile.name.slice(0, -(emoji.length + 1));
                    document.querySelectorAll('[data-contact-field="name"]').forEach((el) => {
                        el.innerHTML = `${escapeHTML(base)}<span class="status-emoji-badge">${escapeHTML(emoji)}</span>`;
                        upgradeIn(el, 0);
                    });
                }
            } catch { /* без анимации */ }
            return result;
        };
    }

    // Свой профиль (внизу панели и на экране профиля).
    if (typeof renderProfileName === "function") {
        const originalName = renderProfileName;
        renderProfileName = function () {
            const result = originalName.apply(this, arguments);
            upgradeIn(document.querySelector(".profile-name"), 0);
            return result;
        };
    }

    // Выбор статуса — с живыми превью; выбранный «вспыхивает» искрами.
    if (typeof toggleStatusEmojiPicker === "function") {
        const originalToggle = toggleStatusEmojiPicker;
        toggleStatusEmojiPicker = function () {
            const result = originalToggle.apply(this, arguments);
            const picker = document.getElementById("status-emoji-picker");
            if (picker && !picker.dataset.animUp && typeof animEmojiHTML === "function") {
                picker.dataset.animUp = "1";
                picker.querySelectorAll("button").forEach((b) => {
                    const e = b.textContent.trim();
                    if (!e || e === "✕") return;
                    b.innerHTML = animEmojiHTML(e, "", 1);
                });
                if (typeof observeAnimEmojiIn === "function") observeAnimEmojiIn(picker);
            }
            return result;
        };
    }
    if (typeof pickStatusEmoji === "function") {
        const originalPick = pickStatusEmoji;
        pickStatusEmoji = function (emoji) {
            const result = originalPick.apply(this, arguments);
            const btn = document.getElementById("profile-status-emoji-btn");
            if (emoji && btn && window.KabanWow?.particles && !motionOff()) {
                const r = btn.getBoundingClientRect();
                const list = [];
                for (let i = 0; i < 26; i++) {
                    const a = (i / 26) * Math.PI * 2;
                    list.push(KabanWow.particle(r.left + r.width / 2, r.top + r.height / 2, { vx: Math.cos(a) * 140, vy: Math.sin(a) * 140, drag: 3, size: 3, round: true, color: i % 2 ? "#ffd36b" : (getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#0a7cff"), life: 0.6 }));
                }
                KabanWow.particles(list);
            }
            return result;
        };
    }

    /* ---- 5. ПЕРЕЛЁТ АВАТАРКИ И ВЪЕЗД ЛЕНТЫ ------------------------------------------ */

    function flyAvatar(chatId) {
        if (motionOff() || window.innerWidth <= 860) return;
        const src = document.querySelector(`.sidebar .chat[data-chat-id="${CSS.escape(String(chatId))}"] .chat-avatar`);
        const target = document.querySelector(".header .person-avatar");
        if (!src || !target) return;
        const a = src.getBoundingClientRect(), b = target.getBoundingClientRect();
        if (!a.width || !b.width || a.bottom < 0 || a.top > window.innerHeight) return;
        const clone = src.cloneNode(true);
        clone.classList.remove("online");
        clone.classList.add("avatar-flyer");
        Object.assign(clone.style, { left: a.left + "px", top: a.top + "px", width: a.width + "px", height: a.height + "px" });
        document.body.appendChild(clone);
        target.style.visibility = "hidden";
        const dx = b.left + b.width / 2 - (a.left + a.width / 2);
        const dy = b.top + b.height / 2 - (a.top + a.height / 2);
        const s = b.width / a.width;
        // Дуга: по пути аватарка чуть приподнимается.
        const anim = clone.animate([
            { transform: "translate(0,0) scale(1)" },
            { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 26}px) scale(${1 + (s - 1) * 0.6 + 0.08})`, offset: 0.55 },
            { transform: `translate(${dx}px, ${dy}px) scale(${s})` }
        ], { duration: 420, easing: "cubic-bezier(.3,.7,.2,1)" });
        const done = () => { clone.remove(); target.style.visibility = ""; };
        anim.onfinish = done;
        anim.oncancel = done;
        setTimeout(done, 900);
    }

    function staggerRows() {
        if (motionOff() || !messagesEl) return;
        const box = messagesEl.getBoundingClientRect();
        const rows = [...messagesEl.querySelectorAll(".message-row")].filter((r) => {
            const rr = r.getBoundingClientRect();
            return rr.bottom > box.top && rr.top < box.bottom;
        }).reverse().slice(0, 14);
        rows.forEach((row, i) => {
            row.animate([
                { transform: "translateY(16px)", opacity: 0 },
                { transform: "translateY(0)", opacity: 1 }
            ], { duration: 360, delay: i * 22, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
        });
        const head = document.querySelector(".header .person-name");
        head?.animate([{ transform: "translateX(10px)", opacity: 0 }, { transform: "translateX(0)", opacity: 1 }], { duration: 320, delay: 80, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    }

    if (typeof openRealChat === "function") {
        const originalOpen = openRealChat;
        openRealChat = function (chatId) {
            const fresh = chatId && chatId !== currentChatId;
            if (fresh) flyAvatar(chatId);
            const started = performance.now();
            const result = originalOpen.apply(this, arguments);
            if (fresh) {
                const after = () => { if (performance.now() - started < 2500) requestAnimationFrame(staggerRows); };
                Promise.resolve(result).then(after, () => {});
            }
            return result;
        };
    }

    /* ---- ПРОИЗВОДИТЕЛЬНОСТЬ: закрытые окна «спят» (см. .cv-keep в style.css) ----------
       Здесь только одно: пока окно доигрывает анимацию закрытия, его содержимое
       остаётся видимым (.cv-keep), иначе оно опустело бы посреди затухания. */

    (function keepContentWhileClosing() {
        // «Спят» (.cv-sleep) только окна, которые открываются классом .open. Часть окон
        // (фоторедактор, просмотрщик…) показывается атрибутом hidden — у них .open нет
        // никогда, и правило спрятало бы их содержимое навсегда. Поэтому: проверенный
        // список сразу, остальные — только после того, как хоть раз открылись через .open.
        // Панель эмодзи тоже «спит», но на широком экране прогрев её будит (.emoji-awake,
        // см. prewarm ниже и style.css): спящую панель браузер при каждом открытии строил заново.
        const KNOWN = ["emoji-popover", "attach-menu", "settings-backdrop", "theme-color-backdrop", "info-modal-backdrop", "group-info-backdrop", "contact-modal-backdrop", "profile-screen-backdrop", "voice-settings-backdrop"];
        const watch = (el) => {
            if (!el || el._cvWatched || el.id === "call-backdrop") return;
            el._cvWatched = true;
            if (KNOWN.includes(el.id) || el.classList.contains("open")) el.classList.add("cv-sleep");
            let wasOpen = el.classList.contains("open");
            let timer = null;
            new MutationObserver(() => {
                const open = el.classList.contains("open");
                if (open === wasOpen) return;      // наши же .cv-keep сюда не доходят
                wasOpen = open;
                clearTimeout(timer);
                if (open) { el.classList.remove("cv-keep"); el.classList.add("cv-sleep"); return; }
                el.classList.add("cv-keep");       // колбэк до отрисовки — пустого кадра не будет
                timer = setTimeout(() => el.classList.remove("cv-keep"), 340);
            }).observe(el, { attributes: true, attributeFilter: ["class"] });
        };
        const scan = () => {
            watch(document.getElementById("emoji-popover"));
            watch(document.getElementById("attach-menu"));
            document.querySelectorAll('[id$="-backdrop"]').forEach(watch);
        };
        scan();
        // Окна, которые создаются позже (подарок, капсула, стикер из фото…).
        new MutationObserver((mutations) => {
            mutations.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1 && /-backdrop$/.test(n.id || "")) watch(n); }));
        }).observe(document.body, { childList: true });
    })();

    /* ---- ПРОИЗВОДИТЕЛЬНОСТЬ: прогрев панели эмодзи и движка анимаций в простое -------------
       Первая раскладка панели эмодзи — дорогая (цветные эмодзи долго измеряются: ~80 мс,
       на слабых телефонах ~300 мс). Повторная — мгновенная: браузер её запоминает. Поэтому
       первую делаем заранее, пока приложение простаивает, по одному куску (49 эмодзи)
       за раз — без заметных пауз. Так же заранее грузим движок анимированных эмодзи. */

    // Прежний прогрев не работал по двум причинам (выяснено трассировкой): ждал разметку
    // панели, которая создаётся только при первом открытии, — и сдавался; а «спящая» панель
    // (content-visibility: hidden) при каждом открытии строилась заново, так что прогретое
    // всё равно выбрасывалось. Теперь на широком экране прогрев панель «будит» (.emoji-awake)
    // и раскладывает по одному блоку (21 эмодзи) за раз — только когда чат открыт (иначе
    // зона чата скрыта и раскладывать нечего). На телефоне зона чата скрывается при каждом
    // возврате к списку, и бодрствующая панель раскладывалась бы при каждом открытии чата, —
    // там она по-прежнему спит до открытия.
    (function prewarm() {
        const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 10 }), 200));
        const pop = document.getElementById("emoji-popover");
        if (!pop) return;
        const wide = window.matchMedia("(min-width: 651px)");
        let warming = false;
        const sleepAgain = () => { pop.classList.remove("emoji-awake"); delete pop.dataset.warmed; };
        const warmEmoji = () => {
            if (warming || pop.dataset.warmed || pop.classList.contains("open")) return;
            if (!wide.matches || !document.body.classList.contains("chat-selected")) return;   // позовут снова при открытии чата
            if (!pop.querySelector(".emoji-grid") && typeof renderEmojiPopover === "function"
                && typeof emojiPopoverRendered !== "undefined" && !emojiPopoverRendered) {
                try { renderEmojiPopover(); } catch { /* откроется и прорисуется как раньше */ }
            }
            const grids = [...pop.querySelectorAll(".emoji-grid")];
            if (!grids.length) return;
            warming = true;
            pop.dataset.warmed = "1";
            grids.forEach((g) => g.classList.add("cv-cold"));
            pop.classList.add("emoji-awake");
            // Первые 10 блоков — это видимая часть с запасом, который браузер всё равно
            // разложил бы при открытии (остальные дорисуются при прокрутке, см. .emoji-grid).
            const first = grids.slice(0, 10);
            let i = 0;
            const finish = () => { warming = false; grids.forEach((g) => g.classList.remove("cv-cold")); };
            const step = () => {
                if (pop.classList.contains("open") || !pop.classList.contains("emoji-awake")) { finish(); return; }
                const grid = first[i++];
                if (grid) { grid.classList.remove("cv-cold"); void grid.offsetHeight; }
                if (i < first.length) idle(step, { timeout: 3000 }); else finish();
            };
            idle(step, { timeout: 3000 });
        };
        const schedule = () => setTimeout(() => idle(warmEmoji, { timeout: 5000 }), 1500);
        let wasSelected = document.body.classList.contains("chat-selected");
        new MutationObserver(() => {
            const selected = document.body.classList.contains("chat-selected");
            if (selected === wasSelected) return;
            wasSelected = selected;
            if (selected) schedule(); else sleepAgain();
        }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
        wide.addEventListener?.("change", () => { if (wide.matches) schedule(); else sleepAgain(); });
        schedule();
        setTimeout(() => idle(() => {
            if (typeof loadLottie === "function" && typeof animatedEmojiEnabled === "function" && animatedEmojiEnabled()) loadLottie().catch(() => {});
        }, { timeout: 8000 }), 5000);
    })();

    window.KabanDelight = { flyAvatar, staggerRows, openCapsuleComposer };
})();
