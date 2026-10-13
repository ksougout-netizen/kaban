/* ============================================================================
   «ВАУ»-ЭФФЕКТЫ
   1. Удалённое сообщение рассыпается в пыль (слева направо, как «щелчок Таноса»).
   2. Спойлер — мерцающие частицы; при открытии они разлетаются от точки нажатия.
   3. Реакция на весь экран: своя — всегда, чужая — когда реагируют на ваше сообщение.
   4. Подарок: сообщение приходит упакованным в коробку, получатель открывает его сам.
   5. Сезонная атмосфера в чате: снег зимой, листопад осенью, лепестки весной;
      конфетти в день рождения собеседника (и в ваш).
   6. Экран звонка дышит голосом собеседника: кольца, сияние вокруг фото, фон.
   Всё отключается настройкой «Уменьшить анимации».
   ========================================================================= */

(function () {
    "use strict";

    const rnd = (a, b) => a + Math.random() * (b - a);
    const motionOff = () => !!appSettings.reduceMotion || document.hidden;

    /* ---- общий холст частиц поверх всего приложения ---------------------------- */

    const P = { canvas: null, ctx: null, list: [], raf: 0, last: 0, dpr: 1 };

    function particlesCanvas() {
        if (!P.canvas) {
            P.canvas = document.createElement("canvas");
            P.canvas.className = "wow-particles";
            P.canvas.setAttribute("aria-hidden", "true");
            document.body.appendChild(P.canvas);
            P.ctx = P.canvas.getContext("2d");
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
        if (P.canvas.width !== w || P.canvas.height !== h) { P.canvas.width = w; P.canvas.height = h; }
        P.dpr = dpr;
    }

    function addParticles(list) {
        if (!list.length) return;
        particlesCanvas();
        for (const p of list) P.list.push(p);
        if (P.list.length > 9000) P.list.splice(0, P.list.length - 9000);
        if (!P.raf) { P.last = performance.now(); P.raf = requestAnimationFrame(particlesTick); }
    }

    function particlesTick(now) {
        const dt = Math.min(0.05, (now - P.last) / 1000 || 0.016);
        P.last = now;
        const ctx = P.ctx;
        ctx.setTransform(P.dpr, 0, 0, P.dpr, 0, 0);
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        let alive = 0;
        for (let i = 0; i < P.list.length; i++) {
            const p = P.list[i];
            if (p.delay > 0) { p.delay -= dt; P.list[alive++] = p; continue; }
            p.age += dt;
            if (p.age >= p.life) continue;
            p.vx += p.ax * dt;
            p.vy += p.ay * dt;
            if (p.drag) { const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= k; }
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            const t = p.age / p.life;
            ctx.globalAlpha = p.alpha * (1 - t * t);
            ctx.fillStyle = p.color;
            const s = p.size * (1 - t * 0.45);
            if (p.round) { ctx.beginPath(); ctx.arc(p.x, p.y, s / 2, 0, 6.2832); ctx.fill(); }
            else ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
            P.list[alive++] = p;
        }
        P.list.length = alive;
        ctx.globalAlpha = 1;
        if (alive) P.raf = requestAnimationFrame(particlesTick);
        else { P.raf = 0; ctx.clearRect(0, 0, window.innerWidth, window.innerHeight); }
    }

    function particle(x, y, props) {
        return { x, y, vx: 0, vy: 0, ax: 0, ay: 0, drag: 0, size: 2, color: "#fff", life: 1, age: 0, delay: 0, alpha: 1, round: false, ...props };
    }

    function accentColor() {
        const value = getComputedStyle(document.body).getPropertyValue("--accent").trim();
        return value || "#0a7cff";
    }

    function isTransparent(color) {
        return !color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
    }

    /* ---- 1. ПЫЛЬ ПРИ УДАЛЕНИИ ------------------------------------------------------ */

    const DUST_MS = 650;
    let dustingRows = 0;
    let regroupTimer = null;

    function dustFrom(el) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const cs = getComputedStyle(el);
        const bg = cs.backgroundColor;
        // Свои пузыри часто залиты градиентом — берём его цвета.
        const gradient = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []).filter((c) => !isTransparent(c));
        const fill = !isTransparent(bg) ? [bg, ...gradient] : gradient;
        const palette = fill.length
            ? [...fill, ...fill, ...fill, cs.color]
            : ["#8e99a8", "#b8c1cc", "#d7dde4", "#6f7a89", accentColor()];
        const step = Math.max(3, Math.ceil(Math.sqrt((r.width * r.height) / 1500)));
        const out = [];
        for (let y = r.top; y < r.bottom; y += step) {
            for (let x = r.left; x < r.right; x += step) {
                const f = (x - r.left) / r.width;
                out.push(particle(x + step / 2, y + step / 2, {
                    vx: rnd(10, 70), vy: rnd(-70, -8), ax: rnd(20, 110), ay: rnd(-70, -10), drag: 0.6,
                    size: step * rnd(0.7, 1.05), color: palette[(Math.random() * palette.length) | 0],
                    life: rnd(0.55, 1.05),
                    // Частица «отрывается», когда до неё доходит край растворения (см. wow-dissolve в CSS).
                    delay: Math.max(0, ((0.25 + f) / 1.5) * DUST_MS / 1000 + rnd(-0.04, 0.04))
                }));
            }
        }
        addParticles(out);
    }

    function canDust(row) {
        if (motionOff() || dustingRows >= 14) return false;
        const bubble = row.querySelector(".message");
        if (!bubble) return false;
        const r = bubble.getBoundingClientRect();
        const box = document.getElementById("messages")?.getBoundingClientRect();
        if (!box || r.width < 2) return false;
        return r.bottom > box.top && r.top < box.bottom;
    }

    function regroupSoon() {
        clearTimeout(regroupTimer);
        regroupTimer = setTimeout(() => { try { updateMessageGrouping(); } catch { /* ок */ } }, 60);
    }

    if (typeof removeMessageRowCompletely === "function") {
        const originalRemove = removeMessageRowCompletely;
        removeMessageRowCompletely = function (messageId) {
            const row = document.querySelector(`.message-row[data-message-id="${CSS.escape(String(messageId))}"]`);
            if (!row || !canDust(row)) return originalRemove.apply(this, arguments);
            // Строка остаётся на экране, пока рассыпается, но для остального кода её уже нет.
            row.removeAttribute("data-message-id");
            row.dataset.dustOf = messageId;
            dustingRows++;
            dustFrom(row.querySelector(".message"));
            row.classList.add("wow-dusting");
            const result = originalRemove.apply(this, arguments);
            setTimeout(() => {
                const h = row.offsetHeight;
                row.style.height = h + "px";
                row.classList.add("wow-collapsing");
                requestAnimationFrame(() => { row.style.height = "0px"; row.style.marginTop = row.style.marginBottom = "0px"; });
                setTimeout(() => { row.remove(); dustingRows--; regroupSoon(); }, 230);
            }, DUST_MS);
            return result;
        };
    }

    /* ---- 2. СПОЙЛЕР ИЗ ЧАСТИЦ ------------------------------------------------------ */

    // Текстура «пыли» для спойлеров: случайные точки разной яркости (две разные —
    // они едут в разные стороны, и точки будто мерцают).
    (function makeSpoilerNoise() {
        const make = (w, h, count) => {
            const c = document.createElement("canvas");
            c.width = w * 2;
            c.height = h * 2;
            const ctx = c.getContext("2d");
            for (let i = 0; i < count; i++) {
                ctx.globalAlpha = rnd(0.25, 1);
                ctx.fillStyle = "#000";
                ctx.beginPath();
                ctx.arc(rnd(0, c.width), rnd(0, c.height), rnd(0.7, 1.5), 0, 6.2832);
                ctx.fill();
            }
            return `url(${c.toDataURL("image/png")})`;
        };
        try {
            document.documentElement.style.setProperty("--wow-noise-a", make(90, 30, 170));
            document.documentElement.style.setProperty("--wow-noise-b", make(70, 26, 110));
        } catch { /* без текстуры — сплошная плашка */ }
    })();

    function spoilerBurst(spoiler, event) {
        if (motionOff()) return;
        const color = getComputedStyle(spoiler).color;
        const rects = [...spoiler.getClientRects()];
        if (!rects.length) return;
        const first = rects[0];
        const cx = event && event.clientX ? event.clientX : first.left + first.width / 2;
        const cy = event && event.clientY ? event.clientY : first.top + first.height / 2;
        const out = [];
        rects.forEach((r) => {
            const step = Math.max(2.5, Math.sqrt((r.width * r.height) / 900));
            for (let y = r.top + 1; y < r.bottom - 1; y += step) {
                for (let x = r.left; x < r.right; x += step) {
                    if (Math.random() < 0.35) continue;
                    const dx = x - cx, dy = y - cy;
                    const d = Math.hypot(dx, dy) + 1;
                    const speed = rnd(50, 150);
                    out.push(particle(x, y, {
                        vx: (dx / d) * speed + rnd(-25, 25), vy: (dy / d) * speed + rnd(-35, 15), ay: 40, drag: 2.2,
                        size: rnd(1.3, 2.3), round: true, color, life: rnd(0.35, 0.7), delay: d / 1100, alpha: 0.9
                    }));
                }
            }
        });
        addParticles(out);
    }

    document.addEventListener("click", (event) => {
        const spoiler = event.target.closest?.(".msg-spoiler:not(.revealed)");
        if (spoiler) spoilerBurst(spoiler, event);
    }, true);
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const spoiler = event.target.closest?.(".msg-spoiler:not(.revealed)");
        if (spoiler) spoilerBurst(spoiler, null);
    }, true);

    /* ---- 3. РЕАКЦИЯ НА ВЕСЬ ЭКРАН -------------------------------------------------- */

    let lastScreenBurst = 0;

    function screenBurst(emoji, x, y) {
        const now = performance.now();
        if (now - lastScreenBurst < 900) return false;
        lastScreenBurst = now;
        const W = window.innerWidth, H = window.innerHeight;
        const size = Math.round(Math.min(230, Math.max(130, Math.min(W, H) * 0.34)));
        const reach = Math.hypot(W, H);
        const glyph = escapeHTML(emoji);
        const flyers = Array.from({ length: 20 }, (_, i) => {
            const angle = (i / 20) * Math.PI * 2 + rnd(-0.15, 0.15);
            const dist = reach * rnd(0.3, 0.55);
            return `<span class="wow-rx-fly" style="--dx:${Math.round(Math.cos(angle) * dist)}px;--dy:${Math.round(Math.sin(angle) * dist)}px;--r:${Math.round(rnd(-90, 90))}deg;--d:${Math.round(rnd(520, 640))}ms;font-size:${Math.round(rnd(22, 46))}px">${glyph}</span>`;
        }).join("");
        const layer = document.createElement("div");
        layer.className = "wow-rx";
        layer.setAttribute("aria-hidden", "true");
        const main = typeof animEmojiHTML === "function" ? animEmojiHTML(emoji) : glyph;
        layer.innerHTML = `<span class="wow-rx-ring"></span>${flyers}<span class="wow-rx-main" style="--sx:${Math.round(x - W / 2)}px;--sy:${Math.round(y - H / 2)}px;font-size:${size}px">${main}</span>`;
        document.body.appendChild(layer);
        const anim = layer.querySelector(".anim-emoji");
        if (anim && typeof registerAnimEmoji === "function") registerAnimEmoji(anim);
        setTimeout(() => { if (anim && typeof releaseAnimEmoji === "function") releaseAnimEmoji(anim); layer.remove(); }, 2000);
        return true;
    }

    if (typeof playReactionBurst === "function") {
        const originalBurst = playReactionBurst;
        playReactionBurst = function (row, emoji, options = {}) {
            const onMine = !!row?.classList?.contains("sent");
            const big = !options.light || onMine;
            if (big && !motionOff() && appSettings.messageEffects !== false) {
                let x = options.x, y = options.y;
                if (x == null) {
                    const rect = row?.querySelector(".message")?.getBoundingClientRect();
                    const visible = rect && rect.bottom > 0 && rect.top < window.innerHeight;
                    x = visible ? rect.left + rect.width / 2 : window.innerWidth / 2;
                    y = visible ? rect.top + rect.height / 2 : window.innerHeight * 0.7;
                }
                if (screenBurst(emoji, x, y)) return;
            }
            return originalBurst.apply(this, arguments);
        };
    }

    /* ---- 4. ПОДАРОК ---------------------------------------------------------------- */

    const GIFT_COLORS = {
        red:    { g1: "#ff6b6b", g2: "#d63447", rb: "#ffd36b", label: "Красная" },
        blue:   { g1: "#5b9bff", g2: "#2b5fd9", rb: "#ffffff", label: "Синяя" },
        green:  { g1: "#3ad48a", g2: "#159458", rb: "#ffe08a", label: "Зелёная" },
        purple: { g1: "#b07cff", g2: "#7340d8", rb: "#ffd1f0", label: "Фиолетовая" },
        gold:   { g1: "#ffd25a", g2: "#e09a12", rb: "#d6336c", label: "Золотая" }
    };
    const GIFT_OPENED_KEY = "kaban-gifts-opened";
    let giftColor = "red";

    function giftColors(id) { return GIFT_COLORS[id] || GIFT_COLORS.red; }

    function giftBoxHTML(colorId) {
        const c = giftColors(colorId);
        return `<span class="wow-box" style="--g1:${c.g1};--g2:${c.g2};--rb:${c.rb}" aria-hidden="true"><span class="wow-box-body"></span><span class="wow-box-lid"></span><span class="wow-box-bow"></span></span>`;
    }

    function openedGifts() {
        try { return new Set(JSON.parse(localStorage.getItem(GIFT_OPENED_KEY) || "[]")); } catch { return new Set(); }
    }

    function markGiftOpened(id) {
        const list = [...openedGifts()].filter((x) => x !== id);
        list.push(id);
        try { localStorage.setItem(GIFT_OPENED_KEY, JSON.stringify(list.slice(-400))); } catch { /* ок */ }
    }

    function decorateGift(row, message) {
        const bubble = row.querySelector(".message");
        if (!bubble || bubble.querySelector(".message-edit-form")) return;
        const gift = message.attachment_meta.gift;
        row.classList.add("wow-gift");
        const addTag = () => { if (!bubble.querySelector(".wow-gift-tag")) bubble.insertAdjacentHTML("afterbegin", `<span class="wow-gift-tag">🎁 Подарок</span>`); };
        if (message.sender_id === myRealUserId || openedGifts().has(message.id)) { addTag(); return; }
        if (bubble.querySelector(".wow-gift-cover")) return;
        row.classList.add("wow-gift-wrapped");
        bubble.insertAdjacentHTML("afterbegin", `<button type="button" class="wow-gift-cover" aria-label="Открыть подарок">${giftBoxHTML(gift?.c)}<b>Подарок</b><em>Нажмите, чтобы открыть</em></button>`);
        const cover = bubble.querySelector(".wow-gift-cover");
        cover.addEventListener("click", (event) => { event.stopPropagation(); unwrapGift(row, message, cover); });
        cover.addEventListener("contextmenu", (event) => event.stopPropagation());
    }

    function unwrapGift(row, message, cover) {
        if (cover.classList.contains("opening")) return;
        markGiftOpened(message.id);
        const finish = () => {
            cover.remove();
            const bubble = row.querySelector(".message");
            if (bubble && !bubble.querySelector(".wow-gift-tag")) bubble.insertAdjacentHTML("afterbegin", `<span class="wow-gift-tag">🎁 Подарок</span>`);
            row.classList.remove("wow-gift-wrapped");
            row.classList.add("wow-gift-revealed");
            setTimeout(() => row.classList.remove("wow-gift-revealed"), 700);
        };
        if (motionOff()) { finish(); return; }
        cover.classList.add("opening");
        const box = cover.querySelector(".wow-box").getBoundingClientRect();
        const c = giftColors(message.attachment_meta.gift?.c);
        const colors = [c.g1, c.rb, "#ffffff", "#ffd36b", accentColor()];
        const cx = box.left + box.width / 2, cy = box.top + box.height * 0.4;
        const out = [];
        for (let i = 0; i < 90; i++) {
            const angle = rnd(-Math.PI, 0);
            const speed = rnd(140, 420);
            out.push(particle(cx + rnd(-20, 20), cy, {
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, ay: 520, drag: 1.1,
                size: rnd(3, 6), color: colors[i % colors.length], life: rnd(0.8, 1.4), delay: 0.28 + rnd(0, 0.08), round: i % 3 === 0
            }));
        }
        addParticles(out);
        setTimeout(() => { if (typeof playMessageEffect === "function") playMessageEffect("confetti"); }, 380);
        setTimeout(finish, 620);
    }

    function openGiftComposer() {
        if (typeof closeAttachMenu === "function") closeAttachMenu();
        if (!currentChatId) { toast("Сначала откройте чат"); return; }
        if (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret) { toast("Подарки в секретных чатах пока не поддерживаются"); return; }
        let backdrop = document.getElementById("wow-gift-backdrop");
        if (!backdrop) {
            backdrop = document.createElement("div");
            backdrop.id = "wow-gift-backdrop";
            backdrop.className = "wow-gift-backdrop";
            backdrop.setAttribute("aria-hidden", "true");
            backdrop.innerHTML = `
                <div class="wow-gift-dialog" role="dialog" aria-modal="true" aria-labelledby="wow-gift-title">
                    <div class="wow-gift-stage" id="wow-gift-stage"></div>
                    <h3 id="wow-gift-title">Подарок</h3>
                    <p class="wow-gift-hint">Собеседник увидит упакованную коробку и откроет её сам — с конфетти.</p>
                    <textarea id="wow-gift-text" maxlength="1000" rows="3" placeholder="Что внутри? Поздравление, секрет, ссылка…"></textarea>
                    <div class="wow-gift-colors" role="radiogroup" aria-label="Цвет упаковки">
                        ${Object.entries(GIFT_COLORS).map(([id, c]) => `<button type="button" role="radio" class="wow-gift-color" data-color="${id}" style="--g1:${c.g1};--g2:${c.g2}" title="${c.label}" aria-label="${c.label}"></button>`).join("")}
                    </div>
                    <div class="wow-gift-actions">
                        <button type="button" class="wow-gift-cancel">Отмена</button>
                        <button type="button" class="wow-gift-send">Подарить</button>
                    </div>
                </div>`;
            document.body.appendChild(backdrop);
            backdrop.addEventListener("click", (event) => {
                if (event.target === backdrop || event.target.closest(".wow-gift-cancel")) closeGiftComposer();
                const swatch = event.target.closest(".wow-gift-color");
                if (swatch) { giftColor = swatch.dataset.color; syncGiftComposer(); }
                if (event.target.closest(".wow-gift-send")) sendGift();
            });
            backdrop.addEventListener("keydown", (event) => {
                if (event.key === "Escape") { event.stopPropagation(); closeGiftComposer(); }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) sendGift();
            });
        }
        syncGiftComposer();
        backdrop.classList.add("open");
        backdrop.setAttribute("aria-hidden", "false");
        setTimeout(() => document.getElementById("wow-gift-text")?.focus(), 60);
    }

    function syncGiftComposer() {
        const stage = document.getElementById("wow-gift-stage");
        if (stage) stage.innerHTML = giftBoxHTML(giftColor);
        document.querySelectorAll(".wow-gift-color").forEach((b) => {
            const on = b.dataset.color === giftColor;
            b.classList.toggle("active", on);
            b.setAttribute("aria-checked", on ? "true" : "false");
        });
    }

    function closeGiftComposer() {
        const backdrop = document.getElementById("wow-gift-backdrop");
        if (!backdrop) return;
        backdrop.classList.remove("open");
        backdrop.setAttribute("aria-hidden", "true");
    }

    async function sendGift() {
        const field = document.getElementById("wow-gift-text");
        const text = (field?.value || "").trim();
        if (!text) { field?.focus(); field?.classList.add("shake"); setTimeout(() => field?.classList.remove("shake"), 400); return; }
        const chatId = currentChatId;
        if (!chatId) return;
        closeGiftComposer();
        let message;
        try {
            message = await KabanAPI.sendMessage(chatId, { type: "text", text, attachmentMeta: { gift: { c: giftColor } } });
        } catch (error) {
            toast("Не удалось отправить подарок: " + (typeof sendErrorText === "function" ? sendErrorText(error) : (error?.message || error)));
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
    }

    window.openGiftComposer = openGiftComposer;
    window.closeGiftComposer = closeGiftComposer;

    // Пункт «Подарок» в меню скрепки — рядом с «Опросом».
    (function addGiftMenuItem() {
        const menu = document.getElementById("attach-menu");
        if (!menu || menu.querySelector(".wow-gift-item")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "attach-menu-item wow-gift-item";
        button.setAttribute("role", "menuitem");
        button.innerHTML = `<span class="attach-menu-icon gift" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20M12 8.5c-1.5-3.5-5.5-4-5.5-1.5S10 8.5 12 8.5Zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 8.5 12 8.5Z"/></svg></span> Подарок`;
        button.addEventListener("click", openGiftComposer);
        const poll = [...menu.querySelectorAll(".attach-menu-item")].find((b) => /openPollModal/.test(b.getAttribute("onclick") || ""));
        if (poll) poll.after(button); else menu.appendChild(button);
    })();

    // Подпись в списке чатов и уведомлениях: содержимое подарка не раскрываем.
    if (typeof messagePreviewText === "function") {
        const originalPreview = messagePreviewText;
        messagePreviewText = function (message) {
            if (message?.attachment_meta?.gift && !message.deleted_at) return "🎁 Подарок";
            return originalPreview.apply(this, arguments);
        };
    }

    /* ---- наблюдатель за лентой: оформление особых сообщений -------------------------- */

    const rowDecorators = [];
    window.KabanWowDecorate = (fn) => { rowDecorators.push(fn); };

    rowDecorators.push((row, message) => {
        if (message.attachment_meta?.gift && message.type === "text" && !message.deleted_at && !currentChatIsSecretSafe()) decorateGift(row, message);
    });

    function currentChatIsSecretSafe() {
        return typeof currentChatIsSecret !== "undefined" && !!currentChatIsSecret;
    }

    let pendingRows = new Set();
    let decorateQueued = false;

    function decorateRows() {
        decorateQueued = false;
        const rows = pendingRows;
        pendingRows = new Set();
        rows.forEach((row) => {
            if (!row.isConnected) return;
            const id = row.dataset.messageId;
            const message = id && realMessagesById.get(id);
            if (!message) return;
            rowDecorators.forEach((fn) => { try { fn(row, message); } catch (error) { console.warn("wow decorate", error); } });
        });
    }

    function queueRow(row) {
        if (!row || !row.classList?.contains("message-row")) return;
        pendingRows.add(row);
        if (!decorateQueued) { decorateQueued = true; queueMicrotask(decorateRows); }
    }

    const messagesEl = document.getElementById("messages");
    if (messagesEl) {
        new MutationObserver((mutations) => {
            mutations.forEach((m) => {
                if (m.target === messagesEl) m.addedNodes.forEach((node) => queueRow(node));
                else queueRow(m.target.closest?.(".message-row"));
            });
        }).observe(messagesEl, { childList: true, subtree: true });
    }

    /* ---- 5. СЕЗОННАЯ АТМОСФЕРА ------------------------------------------------------- */

    if (appSettings.seasonalAtmosphere === undefined) appSettings.seasonalAtmosphere = true;

    function seasonFor(date) {
        let forced = null;
        try { forced = new URLSearchParams(location.search).get("season") || localStorage.getItem("kaban-season-force"); } catch { /* ок */ }
        if (forced === "snow" || forced === "leaves" || forced === "petals") return forced;
        if (forced === "off") return null;
        const m = date.getMonth(), d = date.getDate();
        if (m === 11 || (m === 0 && d <= 14)) return "snow";
        if ((m === 8 && d >= 15) || m === 9 || m === 10) return "leaves";
        if (m >= 2 && m <= 4) return "petals";
        return null;
    }

    const S = { canvas: null, ctx: null, kind: null, items: [], raf: 0, last: 0, w: 0, h: 0, dpr: 1, dark: false };
    const LEAF_COLORS = ["#e8833a", "#d9534f", "#f2b134", "#c0662b", "#e5a03c", "#b84a2a"];
    const PETAL_COLORS = ["#ffb7c9", "#ffc8d6", "#f7a1b8", "#ffd9e3", "#fbc4e2"];

    function chatArea() { return document.querySelector(".chat-area"); }

    function seasonActive() {
        const area = chatArea();
        return !!(S.kind && appSettings.seasonalAtmosphere !== false && !appSettings.reduceMotion && !document.hidden && area && area.clientWidth > 0 && area.clientHeight > 0);
    }

    function seasonItem(fresh) {
        const k = S.kind;
        const base = { x: rnd(0, S.w), y: fresh ? rnd(-S.h * 0.15, S.h) : rnd(-60, -15), phase: rnd(0, 6.28) };
        if (k === "snow") return { ...base, r: rnd(1, 3.2), vy: rnd(16, 42), sway: rnd(8, 26), freq: rnd(0.4, 1.1), a: rnd(0.45, 0.95) };
        const leaf = k === "leaves";
        return {
            ...base, size: leaf ? rnd(7, 12) : rnd(4.5, 7.5), vy: leaf ? rnd(20, 38) : rnd(16, 30), sway: leaf ? rnd(26, 52) : rnd(18, 38),
            freq: rnd(0.3, 0.7), rot: rnd(0, 6.28), vr: rnd(-1.4, 1.4), flip: rnd(0, 6.28), vf: rnd(1.2, 2.6),
            color: (leaf ? LEAF_COLORS : PETAL_COLORS)[(Math.random() * (leaf ? LEAF_COLORS : PETAL_COLORS).length) | 0], a: leaf ? rnd(0.7, 0.9) : rnd(0.7, 0.95)
        };
    }

    function seasonCount() {
        const area = S.w * S.h;
        if (S.kind === "snow") return Math.min(90, Math.round(area / 9000));
        if (S.kind === "leaves") return Math.min(16, Math.max(5, Math.round(area / 48000)));
        return Math.min(22, Math.max(6, Math.round(area / 36000)));
    }

    function ensureSeasonCanvas() {
        const area = chatArea();
        if (!area) return false;
        if (!S.canvas) {
            S.canvas = document.createElement("canvas");
            S.canvas.className = "wow-season";
            S.canvas.setAttribute("aria-hidden", "true");
            S.ctx = S.canvas.getContext("2d");
        }
        // Над обоями, но под сообщениями: сразу после слоя обоев.
        const wallpaper = area.querySelector(":scope > .chat-wallpaper-layer");
        if (wallpaper) { if (wallpaper.nextSibling !== S.canvas) wallpaper.after(S.canvas); }
        else if (S.canvas.parentNode !== area) area.prepend(S.canvas);
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
        const w = area.clientWidth, h = area.clientHeight;
        if (w !== S.w || h !== S.h || dpr !== S.dpr) {
            S.w = w; S.h = h; S.dpr = dpr;
            S.canvas.width = Math.round(w * dpr);
            S.canvas.height = Math.round(h * dpr);
        }
        return true;
    }

    function refreshSeason() {
        S.kind = seasonFor(new Date());
        if (!seasonActive() || !ensureSeasonCanvas()) { stopSeason(); return; }
        S.dark = document.body.classList.contains("dark");
        const need = seasonCount();
        if (S.items.length > need) S.items.length = need;
        while (S.items.length < need) S.items.push(seasonItem(true));
        S.canvas.hidden = false;
        if (!S.raf) { S.last = performance.now(); S.raf = requestAnimationFrame(seasonTick); }
    }

    function stopSeason() {
        if (S.raf) cancelAnimationFrame(S.raf);
        S.raf = 0;
        if (S.canvas) { S.canvas.hidden = true; S.ctx.clearRect(0, 0, S.canvas.width, S.canvas.height); }
    }

    function drawLeaf(ctx, it) {
        const s = it.size;
        ctx.save();
        ctx.translate(it.x, it.y);
        ctx.rotate(it.rot);
        ctx.scale(Math.cos(it.flip) * 0.8 + 0.2, 1);
        ctx.globalAlpha = it.a;
        ctx.fillStyle = it.color;
        ctx.beginPath();
        if (S.kind === "leaves") {
            ctx.moveTo(0, -s);
            ctx.quadraticCurveTo(s * 0.95, -s * 0.25, 0, s);
            ctx.quadraticCurveTo(-s * 0.95, -s * 0.25, 0, -s);
            ctx.fill();
            ctx.globalAlpha = it.a * 0.5;
            ctx.strokeStyle = "rgba(90,40,10,.55)";
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(0, -s * 0.85);
            ctx.lineTo(0, s * 1.25);
            ctx.stroke();
        } else {
            ctx.ellipse(0, 0, s * 0.62, s, 0, 0, 6.2832);
            ctx.fill();
        }
        ctx.restore();
    }

    function seasonTick(now) {
        S.raf = requestAnimationFrame(seasonTick);
        if (now - S.last < 30) return;       // ~30 кадров/с — глазу хватает, батарее легче
        const dt = Math.min(0.08, (now - S.last) / 1000);
        S.last = now;
        const ctx = S.ctx;
        ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        ctx.clearRect(0, 0, S.w, S.h);
        const t = now / 1000;
        if (S.kind === "snow") ctx.fillStyle = S.dark ? "#ffffff" : "#a9bfdc";
        for (const it of S.items) {
            it.y += it.vy * dt;
            const x = it.x + Math.sin(t * it.freq + it.phase) * it.sway;
            if (it.y > S.h + 20) Object.assign(it, seasonItem(false));
            if (S.kind === "snow") {
                ctx.globalAlpha = it.a;
                ctx.beginPath();
                ctx.arc(x, it.y, it.r, 0, 6.2832);
                ctx.fill();
            } else {
                it.rot += it.vr * dt;
                it.flip += it.vf * dt;
                drawLeaf(ctx, { ...it, x });
            }
        }
        ctx.globalAlpha = 1;
    }

    document.addEventListener("visibilitychange", refreshSeason);
    window.addEventListener("resize", () => { clearTimeout(S.resizeTimer); S.resizeTimer = setTimeout(refreshSeason, 150); });
    if (window.ResizeObserver && chatArea()) new ResizeObserver(() => { clearTimeout(S.resizeTimer); S.resizeTimer = setTimeout(refreshSeason, 150); }).observe(chatArea());

    if (typeof applySettings === "function") {
        const originalApply = applySettings;
        applySettings = function () {
            const result = originalApply.apply(this, arguments);
            refreshSeason();
            return result;
        };
    }

    /* ---- конфетти в день рождения -------------------------------------------------- */

    function isBirthdayToday(iso) {
        const match = /(\d{2})-(\d{2})$/.exec(String(iso || ""));
        if (!match) return false;
        const now = new Date();
        return Number(match[1]) === now.getMonth() + 1 && Number(match[2]) === now.getDate();
    }

    function onceToday(key) {
        const stamp = new Date().toDateString();
        try {
            if (localStorage.getItem(key) === stamp) return false;
            localStorage.setItem(key, stamp);
        } catch { /* ок */ }
        return true;
    }

    function celebrate(text) {
        toast(text);
        if (typeof playMessageEffect === "function") {
            playMessageEffect("confetti");
            setTimeout(() => playMessageEffect("balloons"), 900);
        }
    }

    async function checkPartnerBirthday() {
        if (appSettings.seasonalAtmosphere === false) return;
        if (typeof currentChatType === "undefined" || currentChatType !== "direct" || !currentOtherUserId) return;
        if (!KabanAPI?.getUserExtras) return;
        const userId = currentOtherUserId, chatId = currentChatId;
        const extras = await KabanAPI.getUserExtras(userId).catch(() => null);
        if (!extras?.birthday || !isBirthdayToday(extras.birthday) || currentChatId !== chatId) return;
        if (!onceToday("kaban-bday-shown:" + userId)) return;
        const name = (typeof currentChatTitle !== "undefined" && currentChatTitle) || "собеседника";
        celebrate(`🎂 Сегодня у ${name} день рождения — поздравьте!`);
    }

    function checkMyBirthday(attempt = 0) {
        const extras = typeof myProfileExtras !== "undefined" ? myProfileExtras : null;
        if (!extras) { if (attempt < 10) setTimeout(() => checkMyBirthday(attempt + 1), 3000); return; }
        if (appSettings.seasonalAtmosphere === false || !isBirthdayToday(extras.birthday)) return;
        if (onceToday("kaban-bday-mine")) celebrate("🎂 С днём рождения! KABAN поздравляет вас");
    }
    setTimeout(checkMyBirthday, 4000);

    if (typeof openRealChat === "function") {
        const originalOpen = openRealChat;
        openRealChat = function () {
            const result = originalOpen.apply(this, arguments);
            const after = () => {
                refreshSeason();
                setTimeout(() => checkPartnerBirthday().catch(() => {}), 700);
            };
            Promise.resolve(result).then(after, after);
            return result;
        };
    }

    /* ---- 6. ЭКРАН ЗВОНКА ДЫШИТ ГОЛОСОМ ------------------------------------------------ */

    (function callScreen() {
        const wrap = document.querySelector("#call-backdrop .call-avatar-wrap");
        const dialog = wrap?.closest(".call-dialog");
        if (!wrap || !dialog) return;
        if (!wrap.querySelector(".call-aura")) wrap.insertAdjacentHTML("afterbegin", `<span class="call-aura" aria-hidden="true"></span>`);
        // Уровень голоса пишется в --level на обёртке аватара; фону звонка он нужен тоже.
        new MutationObserver(() => {
            dialog.style.setProperty("--vl", wrap.style.getPropertyValue("--level") || "0");
        }).observe(wrap, { attributes: true, attributeFilter: ["style"] });
    })();

    window.KabanWow = {
        dust: dustFrom,
        screenBurst,
        particles: addParticles,
        particle,
        refreshSeason,
        seasonFor,
        _S: S
    };

    refreshSeason();
})();
