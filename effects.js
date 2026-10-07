/* ============================================================================
   ЭФФЕКТЫ СООБЩЕНИЙ, АВТО-ЭФФЕКТЫ, ЖИВЫЕ ОБОИ, ПЛАВНЫЙ ВХОД В ЧАТ.
   Загружается после остальных скриптов. Эффект — анимация на canvas поверх
   всего приложения (pointer-events: none), ничего не блокирует. Отправитель
   выбирает эффект удержанием кнопки отправки (или правым кликом); эффект едет
   в attachment_meta.effect — у получателя проигрывается, когда сообщение
   приходит в открытый чат. «Авто»: по словам и эмодзи в тексте (см.
   autoEffectFor) — считается на каждой стороне сам, в базу не пишется.
   ========================================================================= */

const MESSAGE_EFFECTS = [
    { id: "confetti",  label: "Конфетти",   icon: "🎉" },
    { id: "fireworks", label: "Салют",      icon: "🎆" },
    { id: "hearts",    label: "Сердца",     icon: "❤️" },
    { id: "balloons",  label: "Шары",       icon: "🎈" },
    { id: "snow",      label: "Снегопад",   icon: "❄️" },
    { id: "sparkles",  label: "Магия",      icon: "✨" }
];

const EFFECT_ICONS = Object.fromEntries(MESSAGE_EFFECTS.map((effect) => [effect.id, effect.icon]));

let pendingMessageEffect = null;
let lastEffectAt = 0;

function messageEffectsEnabled() {
    return appSettings.messageEffects !== false && !appSettings.reduceMotion;
}

/* ---- холст и частицы ---------------------------------------------------- */

let fxCanvas = null;
let fxCtx = null;
let fxParticles = [];
let fxFrame = 0;
let fxLast = 0;
let fxScale = 1;

const FX_COLORS = ["#ff5a5f", "#ffb400", "#2fc67a", "#1fb5ff", "#8b5cf6", "#ff4fa3", "#ffd93d"];

function ensureFxCanvas() {
    if (fxCanvas) return;
    fxCanvas = document.createElement("canvas");
    fxCanvas.id = "fx-canvas";
    fxCanvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(fxCanvas);
    fxCtx = fxCanvas.getContext("2d");
    window.addEventListener("resize", resizeFxCanvas);
}

function resizeFxCanvas() {
    if (!fxCanvas) return;
    fxScale = Math.min(window.devicePixelRatio || 1, 2);
    fxCanvas.width = Math.round(window.innerWidth * fxScale);
    fxCanvas.height = Math.round(window.innerHeight * fxScale);
    fxCanvas.style.width = window.innerWidth + "px";
    fxCanvas.style.height = window.innerHeight + "px";
}

function fxRand(min, max) { return min + Math.random() * (max - min); }
function fxPick(list) { return list[Math.floor(Math.random() * list.length)]; }

function accentFxColors() {
    const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    return /^#[0-9a-f]{6}$/i.test(accent) ? [accent, ...FX_COLORS] : FX_COLORS;
}

/* Каждая частица: x, y, vx, vy, life (сек), age, draw(ctx, p) и update(p, dt). */

function spawnConfetti(width, height) {
    const colors = accentFxColors();
    for (let i = 0; i < 170; i++) {
        fxParticles.push({
            kind: "confetti", x: fxRand(0, width), y: fxRand(-height * 0.3, -10),
            vx: fxRand(-60, 60), vy: fxRand(160, 380), size: fxRand(6, 11),
            rot: fxRand(0, 6.28), vr: fxRand(-7, 7), sway: fxRand(0, 6.28), swaySpeed: fxRand(2, 5),
            color: fxPick(colors), life: fxRand(2.6, 4.2), age: 0, delay: fxRand(0, 0.5)
        });
    }
}

function spawnFirework(width, height, delay) {
    const cx = fxRand(width * 0.15, width * 0.85);
    const cy = fxRand(height * 0.12, height * 0.5);
    const color = fxPick(FX_COLORS);
    const count = 64;
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + fxRand(-0.05, 0.05);
        const speed = fxRand(120, 340);
        fxParticles.push({
            kind: "spark", x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
            size: fxRand(2, 3.4), color, life: fxRand(0.9, 1.6), age: 0, delay, gravity: 220, trail: []
        });
    }
}

function spawnHearts(width, height) {
    for (let i = 0; i < 46; i++) {
        fxParticles.push({
            kind: "heart", x: fxRand(0, width), y: height + fxRand(10, 160),
            vx: 0, vy: -fxRand(90, 230), size: fxRand(14, 34),
            sway: fxRand(0, 6.28), swaySpeed: fxRand(1.2, 3), swayAmp: fxRand(10, 34),
            color: fxPick(["#ff4f7b", "#ff2d55", "#ff7aa2", "#e11d48", "#ff8fb1"]),
            life: fxRand(3, 4.6), age: 0, delay: fxRand(0, 1.1)
        });
    }
}

function spawnBalloons(width, height) {
    const colors = accentFxColors();
    for (let i = 0; i < 18; i++) {
        fxParticles.push({
            kind: "balloon", x: fxRand(30, width - 30), y: height + fxRand(40, 260),
            vx: 0, vy: -fxRand(70, 150), size: fxRand(26, 42),
            sway: fxRand(0, 6.28), swaySpeed: fxRand(0.8, 1.8), swayAmp: fxRand(10, 26),
            color: fxPick(colors), life: fxRand(5, 7), age: 0, delay: fxRand(0, 1.2)
        });
    }
}

function spawnSnow(width, height) {
    for (let i = 0; i < 130; i++) {
        fxParticles.push({
            kind: "snow", x: fxRand(0, width), y: fxRand(-height * 0.4, -5),
            vx: 0, vy: fxRand(50, 130), size: fxRand(2, 5.5),
            sway: fxRand(0, 6.28), swaySpeed: fxRand(0.8, 2), swayAmp: fxRand(8, 26),
            color: "#ffffff", life: fxRand(4, 6.5), age: 0, delay: fxRand(0, 2)
        });
    }
}

function spawnSparkles(width, height) {
    for (let i = 0; i < 70; i++) {
        fxParticles.push({
            kind: "star", x: fxRand(0, width), y: fxRand(height * 0.1, height * 0.95),
            vx: fxRand(-14, 14), vy: fxRand(-40, -8), size: fxRand(6, 17),
            rot: fxRand(0, 1), color: fxPick(["#fff3b0", "#ffe066", "#ffffff", "#ffd6f5", "#c7e8ff"]),
            life: fxRand(1.4, 2.8), age: 0, delay: fxRand(0, 1.4)
        });
    }
}

function drawHeart(ctx, size) {
    const s = size / 2;
    ctx.beginPath();
    ctx.moveTo(0, s * 0.9);
    ctx.bezierCurveTo(-s * 1.7, -s * 0.2, -s * 0.9, -s * 1.3, 0, -s * 0.45);
    ctx.bezierCurveTo(s * 0.9, -s * 1.3, s * 1.7, -s * 0.2, 0, s * 0.9);
    ctx.closePath();
}

function drawStar4(ctx, size) {
    const r = size / 2;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
        const radius = i % 2 === 0 ? r : r * 0.28;
        const angle = (i * Math.PI) / 4 - Math.PI / 2;
        ctx.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    ctx.closePath();
}

function stepParticle(p, dt) {

    p.age += dt;
    if (p.age < 0) return;

    switch (p.kind) {
        case "confetti":
            p.sway += p.swaySpeed * dt;
            p.x += (p.vx + Math.sin(p.sway) * 40) * dt;
            p.y += p.vy * dt;
            p.vy = Math.min(p.vy + 40 * dt, 420);
            p.rot += p.vr * dt;
            break;
        case "spark":
            p.trail.push(p.x, p.y);
            if (p.trail.length > 8) p.trail.splice(0, 2);
            p.vy += p.gravity * dt;
            p.vx *= 0.985;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            break;
        case "heart":
        case "balloon":
        case "snow":
            p.sway += p.swaySpeed * dt;
            p.x += Math.cos(p.sway) * p.swayAmp * dt;
            p.y += p.vy * dt;
            break;
        case "star":
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rot += dt * 0.6;
            break;
    }

}

function drawParticle(ctx, p) {

    const progress = p.age / p.life;
    const fadeIn = Math.min(1, p.age / 0.25);
    const fadeOut = progress > 0.75 ? Math.max(0, (1 - progress) / 0.25) : 1;
    const alpha = Math.max(0, Math.min(1, fadeIn * fadeOut));
    if (alpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = alpha;

    switch (p.kind) {
        case "confetti":
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.scale(1, Math.abs(Math.cos(p.sway)) * 0.9 + 0.1);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
            break;
        case "spark":
            ctx.strokeStyle = p.color;
            ctx.lineWidth = p.size;
            ctx.lineCap = "round";
            if (p.trail.length >= 4) {
                ctx.globalAlpha = alpha * 0.5;
                ctx.beginPath();
                ctx.moveTo(p.trail[0], p.trail[1]);
                for (let i = 2; i < p.trail.length; i += 2) ctx.lineTo(p.trail[i], p.trail[i + 1]);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                ctx.globalAlpha = alpha;
            }
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * (1 - progress * 0.5), 0, Math.PI * 2);
            ctx.fill();
            break;
        case "heart":
            ctx.translate(p.x, p.y);
            ctx.rotate(Math.sin(p.sway) * 0.25);
            ctx.fillStyle = p.color;
            drawHeart(ctx, p.size);
            ctx.fill();
            break;
        case "balloon": {
            ctx.translate(p.x, p.y);
            ctx.rotate(Math.sin(p.sway) * 0.1);
            const w = p.size * 0.78, h = p.size;
            ctx.strokeStyle = "rgba(120,120,120,.55)";
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(0, h * 0.5);
            ctx.quadraticCurveTo(-6, h * 1.1, 0, h * 1.6);
            ctx.stroke();
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(255,255,255,.35)";
            ctx.beginPath();
            ctx.ellipse(-w * 0.16, -h * 0.16, w * 0.1, h * 0.17, -0.5, 0, Math.PI * 2);
            ctx.fill();
            break;
        }
        case "snow":
            ctx.fillStyle = "rgba(255,255,255,.92)";
            ctx.shadowColor = "rgba(160,200,255,.7)";
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
            break;
        case "star": {
            const twinkle = 0.55 + 0.45 * Math.sin(p.age * 7 + p.rot * 10);
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.fillStyle = p.color;
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 10;
            drawStar4(ctx, p.size * twinkle);
            ctx.fill();
            break;
        }
    }

    ctx.restore();

}

function fxTick(now) {

    const dt = Math.min(0.05, (now - fxLast) / 1000 || 0.016);
    fxLast = now;

    const width = window.innerWidth, height = window.innerHeight;
    fxCtx.setTransform(fxScale, 0, 0, fxScale, 0, 0);
    fxCtx.clearRect(0, 0, width, height);

    for (let i = fxParticles.length - 1; i >= 0; i--) {
        const p = fxParticles[i];
        if (p.delay > 0) { p.delay -= dt; continue; }
        stepParticle(p, dt);
        const offscreen = p.y < -80 || p.y > height + 220 || p.x < -80 || p.x > width + 80;
        if (p.age >= p.life || (offscreen && p.age > 0.5)) { fxParticles.splice(i, 1); continue; }
        drawParticle(fxCtx, p);
    }

    if (fxParticles.length) {
        fxFrame = requestAnimationFrame(fxTick);
    } else {
        fxFrame = 0;
        fxCtx.clearRect(0, 0, width, height);
        fxCanvas.classList.remove("active");
    }

}

function playMessageEffect(kind) {

    if (!messageEffectsEnabled() || document.hidden) return;

    ensureFxCanvas();
    resizeFxCanvas();
    const width = window.innerWidth, height = window.innerHeight;

    switch (kind) {
        case "confetti": spawnConfetti(width, height); break;
        case "fireworks": for (let i = 0; i < 5; i++) spawnFirework(width, height, i * 0.45); break;
        case "hearts": spawnHearts(width, height); break;
        case "balloons": spawnBalloons(width, height); break;
        case "snow": spawnSnow(width, height); break;
        case "sparkles": spawnSparkles(width, height); break;
        default: return;
    }

    // Страховка от накопления при подряд идущих эффектах.
    if (fxParticles.length > 700) fxParticles.splice(0, fxParticles.length - 700);

    fxCanvas.classList.add("active");
    if (!fxFrame) { fxLast = performance.now(); fxFrame = requestAnimationFrame(fxTick); }

}

/* ---- авто-эффекты по тексту ---------------------------------------------- */

function autoEffectFor(text) {

    const value = String(text || "").toLowerCase();
    if (!value) return null;

    const count = (re) => (value.match(re) || []).length;

    if (/🎆|🎇|салют|фейерверк/.test(value)) return "fireworks";
    if (/🎈|воздушн\S* шар/.test(value)) return "balloons";
    if (/с днем рождения|с днём рождения|с новым годом|с рождеством|с праздником|поздравля|happy birthday|congrat|🎉|🥳|🎊/.test(value) || /(^|[\s,.!?])ура+/.test(value)) return "confetti";
    if (count(/[❤💕💖💗💘💝😍🥰]/gu) >= 3 || /люблю тебя|i love you|обожаю тебя/.test(value)) return "hearts";
    if (/❄|⛄|☃|снегопад|с первым снегом/.test(value)) return "snow";
    if (count(/✨/gu) >= 2 || /волшебств|магия/.test(value)) return "sparkles";

    return null;

}

// Вызывать для каждого НОВОГО (только что отправленного/пришедшего) сообщения.
function maybePlayEffectForMessage(message) {

    if (!message || message.deleted_at || message.type !== "text") return;
    if (message.chat_id && message.chat_id !== currentChatId) return;
    if (!messageEffectsEnabled()) return;

    // Старые сообщения (история, догрузка после офлайна) не должны «стрелять».
    const age = Date.now() - new Date(message.created_at).getTime();
    if (!Number.isFinite(age) || age > 20000) return;

    const now = Date.now();
    if (now - lastEffectAt < 2500) return;

    const explicit = message.attachment_meta?.effect;
    const kind = EFFECT_ICONS[explicit]
        ? explicit
        : (appSettings.autoEffects !== false ? autoEffectFor(message.text) : null);
    if (!kind) return;

    lastEffectAt = now;
    playMessageEffect(kind);

}

function replayEffectFrom(button) {
    lastEffectAt = 0;
    playMessageEffect(button.dataset.effect);
}

/* ---- выбор эффекта при отправке ------------------------------------------ */

function buildEffectPicker() {

    if (document.getElementById("effect-picker")) return;

    const picker = document.createElement("div");
    picker.className = "effect-picker";
    picker.id = "effect-picker";
    picker.hidden = true;
    picker.setAttribute("role", "menu");
    picker.innerHTML = `
        <div class="effect-picker-title">Отправить с эффектом</div>
        <div class="effect-picker-grid">
            ${MESSAGE_EFFECTS.map((effect) => `
                <button type="button" class="effect-tile" role="menuitem" data-effect="${effect.id}">
                    <span class="effect-tile-icon">${effect.icon}</span>
                    <span class="effect-tile-label">${effect.label}</span>
                </button>`).join("")}
        </div>`;
    document.body.appendChild(picker);

    picker.addEventListener("click", (event) => {
        const tile = event.target.closest(".effect-tile");
        if (!tile) return;
        closeEffectPicker();
        sendWithEffect(tile.dataset.effect);
    });

    document.addEventListener("pointerdown", (event) => {
        if (!picker.hidden && !event.target.closest("#effect-picker")) closeEffectPicker();
    }, true);

}

function openEffectPicker() {

    const input = document.getElementById("input");
    if (!input || !input.value.trim()) { toast("Сначала напишите сообщение, потом выберите эффект"); return; }
    if (currentChatIsSecret) { toast("В секретных чатах эффекты отключены"); return; }

    buildEffectPicker();
    const picker = document.getElementById("effect-picker");
    const anchor = document.getElementById("composer-send-button");
    picker.hidden = false;

    const rect = anchor.getBoundingClientRect();
    const width = picker.offsetWidth, height = picker.offsetHeight;
    picker.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
    picker.style.top = Math.max(8, rect.top - height - 10) + "px";
    requestAnimationFrame(() => picker.classList.add("open"));

}

function closeEffectPicker() {
    const picker = document.getElementById("effect-picker");
    if (!picker) return;
    picker.classList.remove("open");
    picker.hidden = true;
}

function sendWithEffect(effectId) {
    pendingMessageEffect = effectId;
    try { send(); } finally { pendingMessageEffect = null; }
}

// Удержание кнопки отправки (или правый клик) открывает выбор эффекта.
(function initSendButtonEffects() {

    const button = document.getElementById("composer-send-button");
    if (!button) return;

    button.title = "Нажмите — отправить, удерживайте — отправить с эффектом";

    let timer = null;
    let longPressed = false;

    button.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        longPressed = false;
        clearTimeout(timer);
        timer = setTimeout(() => { longPressed = true; openEffectPicker(); }, 480);
    });

    const cancel = () => clearTimeout(timer);
    button.addEventListener("pointerup", cancel);
    button.addEventListener("pointerleave", cancel);
    button.addEventListener("pointercancel", cancel);

    // Долгое нажатие не должно ещё и отправлять сообщение обычным кликом.
    button.addEventListener("click", (event) => {
        if (longPressed) { event.preventDefault(); event.stopImmediatePropagation(); longPressed = false; }
    }, true);

    button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        openEffectPicker();
    });

})();

/* ---- ЖИВЫЕ ОБОИ: параллакс от мыши/наклона ---------------------------------
   Сами обои дрейфуют CSS-анимацией (см. .chat-area::before); здесь только
   лёгкий сдвиг слоя за курсором и наклоном устройства. Пишем две CSS-переменные
   раз на кадр — слой двигается на композиторе, перерисовки нет. */
(function initWallpaperParallax() {

    let frame = 0;
    let targetX = 0, targetY = 0;
    let appliedX = 0, appliedY = 0;
    const area = document.querySelector(".chat-area");

    function apply() {
        frame = 0;
        if (!area) return;
        // Изменение CSS-переменной на .chat-area пересчитывает стили ВСЕЙ ленты
        // сообщений — поэтому пишем только заметные сдвиги (не каждые 0.1px).
        if (Math.abs(targetX - appliedX) < 0.6 && Math.abs(targetY - appliedY) < 0.6) return;
        appliedX = targetX;
        appliedY = targetY;
        // На отдельном слое обоев, а не на .chat-area — иначе пересчитывались стили всей ленты.
        const layer = area.querySelector(":scope > .chat-wallpaper-layer") || area;
        layer.style.setProperty("--px", targetX.toFixed(1) + "px");
        layer.style.setProperty("--py", targetY.toFixed(1) + "px");
    }

    function schedule(x, y) {
        if (appSettings.liveWallpapers === false || appSettings.reduceMotion) return;
        // Без обоев параллаксить нечего — а раньше КАЖДОЕ движение мыши в любом
        // месте окна пересчитывало стили всего чата (микрофризы при большой ленте).
        if (!area || !area.classList.contains("has-wallpaper") || document.hidden) return;
        targetX = x;
        targetY = y;
        if (!frame) frame = requestAnimationFrame(apply);
    }

    window.addEventListener("pointermove", (event) => {
        if (event.pointerType === "touch") return;
        schedule(((event.clientX / window.innerWidth) - 0.5) * -22, ((event.clientY / window.innerHeight) - 0.5) * -22);
    }, { passive: true });

    window.addEventListener("deviceorientation", (event) => {
        if (event.gamma == null || event.beta == null) return;
        schedule(Math.max(-1, Math.min(1, event.gamma / 30)) * -14, Math.max(-1, Math.min(1, (event.beta - 45) / 30)) * -14);
    }, { passive: true });

})();

/* ---- ПЛАВНЫЙ ВХОД В ЧАТ ---------------------------------------------------- */
function playChatEnterAnimation() {
    if (appSettings.reduceMotion) return;
    const area = document.querySelector(".chat-area");
    if (!area) return;
    area.classList.remove("chat-enter");
    void area.offsetWidth; // перезапуск анимации
    area.classList.add("chat-enter");
    setTimeout(() => area.classList.remove("chat-enter"), 420);
}
