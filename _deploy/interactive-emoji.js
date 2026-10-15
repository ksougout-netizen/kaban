/* ============================================================================
   ИНТЕРАКТИВНЫЕ ЭМОДЗИ (как в Telegram)
   Нажатие на крупный эмодзи в ленте (сообщение из одних эмодзи или эмодзи-стикер)
   — эмодзи вырастает из пузыря, «оживает» и сопровождается своим эффектом:
   сердечки, конфетти, фейерверк, искры огня, брызги… Собеседник, у которого этот
   чат открыт, видит то же самое в тот же момент (лёгкий канал fx:<чат> в Realtime,
   ничего не пишется в базу).
   ========================================================================= */

(function () {
    "use strict";

    const messagesEl = document.getElementById("messages");
    if (!messagesEl) return;

    const motionOff = () => !!appSettings.reduceMotion || document.hidden;
    const rnd = (a, b) => a + Math.random() * (b - a);
    const norm = (e) => String(e || "").replace(/️/g, "");

    const KIND_OF = new Map();
    const setKind = (list, kind) => list.forEach((e) => KIND_OF.set(norm(e), kind));
    setKind(["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💖", "💗", "💓", "💞", "💕", "💘", "💝", "😍", "🥰", "😘", "❣️", "😻", "🫶"], "hearts");
    setKind(["🎉", "🥳", "🎊", "🎁", "🎂", "🍾", "🏆"], "confetti");
    setKind(["🎆", "🎇", "✨", "⭐", "🌟", "💫", "🤩"], "fireworks");
    setKind(["🔥", "💥", "🚀", "😡", "🤬"], "fire");
    setKind(["💩", "😂", "🤣", "😭", "👻", "🤮", "💦"], "splash");

    const HEART_SET = ["❤️", "💖", "💕", "💗", "💘"];
    const CONFETTI_COLORS = ["#ff5a5f", "#ffb400", "#2fc67a", "#1fb5ff", "#8b5cf6", "#ff4fa3", "#ffd93d"];

    function bubbleOf(target) {
        const bubble = target.closest?.(".message.emoji-only, .message.sticker:not(.sticker-image):not(.dice-message)");
        if (!bubble || bubble.closest(".message-row.pending, .message-row.deleted")) return null;
        return bubble;
    }

    function emojiAt(bubble, target) {
        const own = target.closest?.(".anim-emoji");
        if (own?.getAttribute("aria-label")) return own.getAttribute("aria-label");
        const text = (bubble.querySelector(".message-text")?.textContent || bubble.textContent || "").trim();
        const parts = typeof splitGraphemes === "function" ? splitGraphemes(text) : Array.from(text);
        return parts.find((p) => /\p{Extended_Pictographic}/u.test(p)) || null;
    }

    /* ---- сама анимация ---- */

    let active = 0;

    function play(bubble, emoji, { anchor } = {}) {
        if (motionOff() || active >= 3) return;
        const glyph = anchor || bubble.querySelector(".anim-emoji") || bubble;
        const r = glyph.getBoundingClientRect();
        if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return;
        active++;
        const W = window.innerWidth, H = window.innerHeight;
        const size = Math.round(Math.min(W * 0.55, H * 0.42, 300));
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const mine = !!bubble.closest(".message-row.sent");
        let tx = cx + (mine ? -1 : 1) * size * 0.3;
        let ty = cy - size * 0.3;
        tx = Math.max(size / 2 + 8, Math.min(W - size / 2 - 8, tx));
        ty = Math.max(size / 2 + 8, Math.min(H - size / 2 - 8, ty));
        const dx = cx - tx, dy = cy - ty;
        const s0 = Math.max(0.12, r.height / size);

        const layer = document.createElement("div");
        layer.className = "ix-layer";
        layer.setAttribute("aria-hidden", "true");
        const main = document.createElement("span");
        main.className = "ix-main";
        Object.assign(main.style, { left: tx + "px", top: ty + "px", fontSize: size + "px" });
        main.innerHTML = typeof animEmojiHTML === "function" ? animEmojiHTML(emoji) : emoji;
        layer.appendChild(main);
        document.body.appendChild(layer);
        const anim = main.querySelector(".anim-emoji");
        if (anim && typeof registerAnimEmoji === "function") registerAnimEmoji(anim);

        const DURATION = 2300;
        main.animate([
            { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${s0})`, opacity: 0.9 },
            { transform: "translate(-50%, -50%) translate(0, 0) scale(1.1)", opacity: 1, offset: 0.17 },
            { transform: "translate(-50%, -50%) translate(0, 0) scale(.95)", offset: 0.25 },
            { transform: "translate(-50%, -50%) translate(0, 0) scale(1.03)", offset: 0.32 },
            { transform: "translate(-50%, -50%) translate(0, 0) scale(1)", opacity: 1, offset: 0.8 },
            { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(${s0})`, opacity: 0 }
        ], { duration: DURATION, easing: "cubic-bezier(.25,.8,.3,1)", fill: "both" });

        // Свой эмодзи в пузыре на время полёта приглушаем — будто это он и вылетел.
        glyph.animate([{ opacity: 1 }, { opacity: 0.25, offset: 0.12 }, { opacity: 0.25, offset: 0.85 }, { opacity: 1 }], { duration: DURATION });

        const kind = KIND_OF.get(norm(emoji)) || "default";
        setTimeout(() => effect(kind, layer, tx, ty, size, emoji), 330);

        setTimeout(() => {
            if (anim && typeof releaseAnimEmoji === "function") releaseAnimEmoji(anim);
            layer.remove();
            active--;
        }, DURATION + 1200);
    }

    function flyer(layer, text, x, y, { dx, dy, rot = 0, size = 30, delay = 0, duration = 1300, gravity = 0, from = 0.4, to = 1 }) {
        const el = document.createElement("span");
        el.className = "ix-flyer";
        el.textContent = text;
        Object.assign(el.style, { left: x + "px", top: y + "px", fontSize: size + "px" });
        layer.appendChild(el);
        const mid = gravity ? `translate(-50%, -50%) translate(${dx * 0.55}px, ${dy * 0.55 - gravity}px) rotate(${rot * 0.5}deg) scale(${to})` : `translate(-50%, -50%) translate(${dx * 0.6}px, ${dy * 0.6}px) rotate(${rot * 0.6}deg) scale(${to})`;
        el.animate([
            { transform: `translate(-50%, -50%) scale(${from})`, opacity: 0 },
            { opacity: 1, offset: 0.12 },
            { transform: mid, opacity: 1, offset: 0.55 },
            { transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(${rot}deg) scale(${to * 0.9})`, opacity: 0 }
        ], { duration, delay, easing: gravity ? "cubic-bezier(.2,.6,.5,1)" : "cubic-bezier(.15,.7,.3,1)", fill: "both" });
    }

    function ring(layer, x, y, size, color) {
        const el = document.createElement("span");
        el.className = "ix-ring";
        Object.assign(el.style, { left: x + "px", top: y + "px", width: size * 0.5 + "px", height: size * 0.5 + "px", borderColor: color });
        layer.appendChild(el);
        el.animate([
            { transform: "translate(-50%, -50%) scale(.4)", opacity: 0.9 },
            { transform: "translate(-50%, -50%) scale(3.2)", opacity: 0 }
        ], { duration: 900, easing: "cubic-bezier(.1,.6,.3,1)", fill: "both" });
    }

    function particles(list) {
        if (window.KabanWow?.particles) KabanWow.particles(list);
    }

    function effect(kind, layer, x, y, size, emoji) {
        const P = (px, py, o) => (window.KabanWow?.particle ? KabanWow.particle(px, py, o) : null);
        if (kind === "hearts") {
            for (let i = 0; i < 14; i++) {
                const a = rnd(-Math.PI * 0.95, -Math.PI * 0.05);
                const d = rnd(size * 0.45, size * 1.05);
                flyer(layer, HEART_SET[i % HEART_SET.length], x, y, { dx: Math.cos(a) * d, dy: Math.sin(a) * d, rot: rnd(-40, 40), size: rnd(20, 40), delay: rnd(0, 380), duration: rnd(1200, 1700) });
            }
            ring(layer, x, y, size, "rgba(255,90,140,.7)");
        } else if (kind === "confetti") {
            const list = [];
            for (let i = 0; i < 110; i++) {
                const a = rnd(-Math.PI, 0), sp = rnd(220, 620);
                const p = P(x + rnd(-20, 20), y, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 640, drag: 1.2, size: rnd(5, 9), color: CONFETTI_COLORS[i % CONFETTI_COLORS.length], life: rnd(1.2, 2) });
                if (p) list.push(p);
            }
            particles(list);
        } else if (kind === "fireworks") {
            [0, 330, 640, 900].forEach((delay, k) => setTimeout(() => {
                const bx = x + rnd(-size * 0.9, size * 0.9), by = y + rnd(-size * 0.75, size * 0.2);
                const color = CONFETTI_COLORS[(k * 2 + 1) % CONFETTI_COLORS.length];
                const list = [];
                for (let i = 0; i < 46; i++) {
                    const a = (i / 46) * Math.PI * 2, sp = rnd(140, 260);
                    const p = P(bx, by, { vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ay: 120, drag: 2, size: rnd(2.5, 4), round: true, color: i % 3 ? color : "#fff", life: rnd(0.8, 1.3) });
                    if (p) list.push(p);
                }
                particles(list);
            }, delay));
        } else if (kind === "fire") {
            const list = [];
            for (let i = 0; i < 90; i++) {
                const p = P(x + rnd(-size * 0.3, size * 0.3), y + rnd(0, size * 0.35), { vx: rnd(-60, 60), vy: rnd(-320, -110), ay: -80, drag: 1.4, size: rnd(2, 5), round: true, color: ["#ffb400", "#ff7a00", "#ff3d00", "#ffd93d"][i % 4], life: rnd(0.7, 1.5), delay: rnd(0, 0.6) });
                if (p) list.push(p);
            }
            particles(list);
            ring(layer, x, y, size, "rgba(255,140,0,.7)");
        } else if (kind === "splash") {
            for (let i = 0; i < 10; i++) {
                const a = rnd(-Math.PI * 0.9, -Math.PI * 0.1);
                const d = rnd(size * 0.5, size * 1.0);
                flyer(layer, emoji, x, y, { dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.4 + size * 0.7, rot: rnd(-120, 120), size: rnd(22, 40), delay: rnd(0, 200), duration: rnd(1100, 1500), gravity: size * 0.5 });
            }
        } else {
            ring(layer, x, y, size, "rgba(255,255,255,.75)");
            for (let i = 0; i < 9; i++) {
                const a = (i / 9) * Math.PI * 2 + rnd(-0.2, 0.2);
                const d = rnd(size * 0.55, size * 0.9);
                flyer(layer, emoji, x, y, { dx: Math.cos(a) * d, dy: Math.sin(a) * d, rot: rnd(-60, 60), size: rnd(20, 34), delay: rnd(0, 150), duration: rnd(1000, 1300) });
            }
        }
    }

    /* ---- нажатие ---- */

    let lastTapAt = 0;

    messagesEl.addEventListener("click", (event) => {
        if (messagesEl.classList.contains("selection-mode")) return;
        if (String(window.getSelection?.() || "").trim()) return;
        const bubble = bubbleOf(event.target);
        if (!bubble) return;
        const emoji = emojiAt(bubble, event.target);
        if (!emoji) return;
        const now = performance.now();
        if (now - lastTapAt < 350) return;
        lastTapAt = now;
        try { navigator.vibrate?.(12); } catch { /* ок */ }
        const anchor = event.target.closest?.(".anim-emoji") || null;
        play(bubble, emoji, { anchor });
        const messageId = bubble.closest(".message-row")?.dataset.messageId;
        if (messageId) broadcast({ m: messageId, e: emoji });
    });

    /* ---- синхронизация с собеседником ---- */

    let channel = null;
    let channelChatId = null;
    const lastFrom = new Map();

    function subscribe(chatId) {
        if (channelChatId === chatId) return;
        try { if (channel) getSupabaseClient().removeChannel(channel); } catch { /* ок */ }
        channel = null;
        channelChatId = chatId;
        if (!chatId || (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret)) return;
        try {
            channel = getSupabaseClient().channel(`fx:${chatId}`, { config: { broadcast: { self: false } } });
            channel.on("broadcast", { event: "emoji" }, ({ payload }) => onRemote(chatId, payload)).subscribe();
        } catch { channel = null; }
    }

    function broadcast(payload) {
        if (!channel || channelChatId !== currentChatId) return;
        try { channel.send({ type: "broadcast", event: "emoji", payload: { ...payload, u: myRealUserId } }); } catch { /* ок */ }
    }

    function onRemote(chatId, payload) {
        if (chatId !== currentChatId || !payload || typeof payload.m !== "string" || typeof payload.e !== "string") return;
        if (payload.u === myRealUserId || payload.e.length > 16) return;
        const now = performance.now();
        if (now - (lastFrom.get(payload.u) || 0) < 300) return;
        lastFrom.set(payload.u, now);
        // Только настоящие сообщения этого чата и только эмодзи из них самих.
        const message = realMessagesById.get(payload.m);
        if (!message || message.chat_id !== chatId || !norm(message.text).includes(norm(payload.e))) return;
        const row = messagesEl.querySelector(`.message-row[data-message-id="${CSS.escape(payload.m)}"]`);
        const bubble = row && bubbleOf(row.querySelector(".message") || row);
        if (bubble) play(bubble, payload.e);
    }

    if (typeof openRealChat === "function") {
        const originalOpen = openRealChat;
        openRealChat = function (chatId) {
            const result = originalOpen.apply(this, arguments);
            const after = () => subscribe(currentChatId);
            Promise.resolve(result).then(after, after);
            return result;
        };
    }
    if (typeof currentChatId !== "undefined" && currentChatId) subscribe(currentChatId);

    window.KabanInteractiveEmoji = { play, _subscribe: subscribe, _onRemote: onRemote };
})();
