/* ============================================================================
   РИСУНОК ПОВЕРХ ТРАНСЛЯЦИИ ЭКРАНА (голосовые комнаты)
   На плитке с показом экрана есть карандаш: включаете — и обводите, рисуете
   стрелки прямо поверх чужого экрана. Линию видят все в комнате (и тот, кто
   показывает, — на своей плитке), подписана именем автора и сама тает через
   несколько секунд. Почти прямая линия превращается в стрелку.
   Координаты — в долях кадра видео, поэтому рисунок совпадает у всех, при любом
   размере окна. Передаётся тем же каналом комнаты, что и сигналы (voiceSend).
   ========================================================================= */

(function () {
    "use strict";

    const HOLD_MS = 3200;     // сколько линия висит после окончания
    const FADE_MS = 900;      // затем тает
    const SEND_EVERY = 60;    // мс между пакетами точек
    const COLORS = ["#ff4d4f", "#2fd27a", "#3b9bff", "#ffc53d", "#c06bff", "#ff7ac6", "#29d3d3"];

    const strokes = new Map();       // key → stroke { tile, owner, by, name, color, pts:[[x,y]], done, endAt }
    const overlays = new Map();      // tileId → { canvas, ctx, tile }
    let drawingTile = null;          // tileId, где включён карандаш
    let raf = 0;

    function colorFor(userId) {
        let h = 0;
        for (const ch of String(userId || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return COLORS[h % COLORS.length];
    }

    function nameFor(userId) {
        if (userId === myRealUserId) return "Вы";
        try { return voiceMemberName(userId, voiceCall?.members?.[userId] || {}) || "Участник"; } catch { return "Участник"; }
    }

    // id плитки показа экрана для владельца трансляции — у себя и у других он разный.
    function tileIdFor(owner) { return owner === myRealUserId ? "me:screen" : owner + ":screen"; }
    function ownerOf(tileId) { return tileId === "me:screen" ? myRealUserId : tileId.replace(/:screen$/, ""); }

    /* ---- оверлеи на плитках ---- */

    // Свой показ ВСЕГО экрана: живое превью снимало бы само себя («зеркальный коридор»),
    // поэтому вместо него — заглушка со стоп-кадром (на нём видно, где рисуют зрители).
    // Окно или вкладку показываем вживую, как раньше. Превью можно включить кнопкой.
    let selfPreview = false;
    let lastSnapAt = 0;

    function sharingWholeScreen() {
        const track = voiceCall?.media?.screenTrack;
        if (!track) return false;
        let surface = "";
        try { surface = track.getSettings?.().displaySurface || ""; } catch { /* ок */ }
        if (surface) return surface === "monitor";
        // Неизвестно (бывает в программе для Windows) — смотрим на подпись дорожки.
        return !/^(window|web-contents-media-stream|tab)[:\s]/i.test(track.label || "");
    }

    function ensureSelfPlaceholder(o) {
        let ph = o.tile.querySelector(".sdraw-self");
        if (!ph) {
            ph = document.createElement("div");
            ph.className = "sdraw-self";
            ph.innerHTML = `<canvas class="sdraw-snap"></canvas><div class="sdraw-self-card"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8.5 20h7M12 16.5V20"/></svg><b title="Зрители видят ваш экран. Живое превью скрыто, чтобы картинка не отражалась сама в себе (как два зеркала друг напротив друга).">Вы показываете весь экран</b><button type="button" class="sdraw-self-show">Показать превью</button></div>`;
            ph.querySelector(".sdraw-self-show").addEventListener("click", (event) => {
                event.stopPropagation();
                selfPreview = true;
                syncOverlays();
            });
            ph.addEventListener("click", (event) => event.stopPropagation());
            ph.addEventListener("dblclick", (event) => event.stopPropagation());
            o.tile.insertBefore(ph, o.canvas);
            setTimeout(() => takeSnapshot(o), 1200);
        }
        return ph;
    }

    // Стоп-кадр своего экрана — подложка, чтобы было понятно, куда показывают зрители.
    function takeSnapshot(o) {
        const video = o.tile.querySelector("video");
        const snap = o.tile.querySelector(".sdraw-snap");
        if (!video || !snap || video.readyState < 2 || !video.videoWidth) return;
        lastSnapAt = performance.now();
        const scale = Math.min(1, 960 / video.videoWidth);
        snap.width = Math.round(video.videoWidth * scale);
        snap.height = Math.round(video.videoHeight * scale);
        try { snap.getContext("2d").drawImage(video, 0, 0, snap.width, snap.height); } catch { /* ок */ }
    }

    function syncOverlays() {
        const grid = document.getElementById("voice-stage-grid");
        if (!grid) return;
        const live = new Set();
        if (!voiceCall?.media?.screenTrack) selfPreview = false;
        grid.querySelectorAll(".vstage-tile.live").forEach((tile) => {
            const id = tile.dataset.tile;
            live.add(id);
            let o = overlays.get(id);
            if (!o || o.tile !== tile || !o.canvas.isConnected) {
                const canvas = document.createElement("canvas");
                canvas.className = "sdraw-canvas";
                tile.appendChild(canvas);
                const pen = document.createElement("button");
                pen.type = "button";
                pen.className = "sdraw-pen";
                pen.title = "Рисовать поверх экрана — увидят все";
                pen.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/></svg><span>Рисовать</span>`;
                pen.addEventListener("click", (event) => { event.stopPropagation(); toggleDrawing(id); });
                pen.addEventListener("dblclick", (event) => event.stopPropagation());
                tile.appendChild(pen);
                const hint = document.createElement("div");
                hint.className = "sdraw-hint";
                hint.textContent = "Рисуйте мышью — увидят все · Esc — выйти";
                tile.appendChild(hint);
                o = { canvas, ctx: canvas.getContext("2d"), tile, pen, hint };
                overlays.set(id, o);
                bindPointer(o, id);
            }
            const self = id === "me:screen";
            const placeholder = self && !selfPreview && sharingWholeScreen();
            tile.classList.toggle("sdraw-self-mode", placeholder);
            if (placeholder) ensureSelfPlaceholder(o);
            else tile.querySelector(".sdraw-self")?.remove();
            tile.classList.toggle("sdraw-on", drawingTile === id);
            o.pen.querySelector("span").textContent = drawingTile === id ? "Готово" : "Рисовать";
        });
        [...overlays.keys()].forEach((id) => {
            if (!live.has(id)) {
                const o = overlays.get(id);
                o.canvas.remove();
                o.pen.remove();
                o.hint.remove();
                o.tile.querySelector(".sdraw-self")?.remove();
                overlays.delete(id);
                if (drawingTile === id) drawingTile = null;
            }
        });
        kick();
    }

    function toggleDrawing(id) {
        drawingTile = drawingTile === id ? null : id;
        overlays.forEach((o, key) => {
            o.tile.classList.toggle("sdraw-on", key === drawingTile);
            o.pen.querySelector("span").textContent = key === drawingTile ? "Готово" : "Рисовать";
        });
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && drawingTile) { event.stopPropagation(); toggleDrawing(drawingTile); }
    }, true);
    // Где на плитке реально картинка (видео вписано в плитку с полями).
    function videoRect(o) {
        const box = o.tile.getBoundingClientRect();
        const video = o.tile.querySelector("video");
        const vw = video?.videoWidth || 16, vh = video?.videoHeight || 9;
        const scale = Math.min(box.width / vw, box.height / vh);
        const w = vw * scale, h = vh * scale;
        return { left: box.left + (box.width - w) / 2, top: box.top + (box.height - h) / 2, width: w, height: h, box };
    }

    function bindPointer(o, tileId) {
        let current = null;
        let sendTimer = null;
        let sentUpTo = 0;
        const toNorm = (event) => {
            const r = videoRect(o);
            return [
                Math.round(Math.min(1, Math.max(0, (event.clientX - r.left) / r.width)) * 1000) / 1000,
                Math.round(Math.min(1, Math.max(0, (event.clientY - r.top) / r.height)) * 1000) / 1000
            ];
        };
        const flush = (done) => {
            if (!current) return;
            const pts = current.pts.slice(sentUpTo);
            if (!pts.length && !done) return;
            sentUpTo = current.pts.length;
            if (voiceCall) voiceSend(voiceCall, { type: "draw", owner: current.owner, sid: current.sid, pts, start: current.sentStart ? undefined : 1, done: done ? 1 : undefined });
            current.sentStart = true;
        };
        o.canvas.addEventListener("pointerdown", (event) => {
            if (drawingTile !== tileId || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            try { o.canvas.setPointerCapture(event.pointerId); } catch { /* ок */ }
            const sid = Math.random().toString(36).slice(2, 10);
            current = { key: myRealUserId + ":" + sid, sid, owner: ownerOf(tileId), by: myRealUserId, pts: [toNorm(event)], sentStart: false };
            sentUpTo = 0;
            strokes.set(current.key, { tile: tileId, owner: current.owner, by: myRealUserId, name: "Вы", color: colorFor(myRealUserId), pts: current.pts, done: false, endAt: 0 });
            flush(false);
            sendTimer = setInterval(() => flush(false), SEND_EVERY);
            kick();
        });
        o.canvas.addEventListener("pointermove", (event) => {
            if (!current) return;
            const p = toNorm(event);
            const last = current.pts[current.pts.length - 1];
            if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.002) return;
            if (current.pts.length > 1500) return;
            current.pts.push(p);
            kick();
        });
        const end = () => {
            if (!current) return;
            clearInterval(sendTimer);
            flush(true);
            const s = strokes.get(current.key);
            if (s) { s.done = true; s.endAt = performance.now(); }
            current = null;
            kick();
        };
        o.canvas.addEventListener("pointerup", end);
        o.canvas.addEventListener("pointercancel", end);
        // Клик по холсту в режиме рисования не должен переключать фокус плитки.
        o.canvas.addEventListener("click", (event) => { if (drawingTile === tileId) event.stopPropagation(); });
        o.canvas.addEventListener("dblclick", (event) => { if (drawingTile === tileId) event.stopPropagation(); });
    }

    /* ---- приём ---- */

    function onDraw(payload) {
        const from = payload.from;
        if (!from || from === myRealUserId || typeof payload.sid !== "string" || !Array.isArray(payload.pts)) return;
        const owner = String(payload.owner || "");
        // Рисовать можно только поверх реально идущей трансляции.
        if (!voiceCall || (owner !== myRealUserId && !voiceCall.members?.[owner]?.screen)) return;
        const key = from + ":" + payload.sid.slice(0, 16);
        let s = strokes.get(key);
        if (!s) {
            if (strokes.size > 60) return;
            s = { tile: tileIdFor(owner), owner, by: from, name: nameFor(from), color: colorFor(from), pts: [], done: false, endAt: 0, lastAt: performance.now() };
            strokes.set(key, s);
            const own = overlays.get(s.tile);
            if (own && s.tile === "me:screen" && performance.now() - lastSnapAt > 2500) takeSnapshot(own);
        }
        payload.pts.slice(0, 400).forEach((p) => {
            if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && s.pts.length < 1600) {
                s.pts.push([Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1]))]);
            }
        });
        s.lastAt = performance.now();
        if (payload.done) { s.done = true; s.endAt = performance.now(); }
        kick();
    }

    if (typeof voiceHandleSig === "function") {
        const originalSig = voiceHandleSig;
        voiceHandleSig = function (payload) {
            if (payload?.type === "draw") { try { onDraw(payload); } catch (error) { console.warn("draw", error); } return; }
            return originalSig.apply(this, arguments);
        };
    }

    /* ---- отрисовка ---- */

    function kick() { if (!raf) raf = requestAnimationFrame(frame); }

    function isArrow(pts) {
        if (pts.length < 4) return false;
        const a = pts[0], b = pts[pts.length - 1];
        const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (straight < 0.06) return false;
        let length = 0;
        for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        return length / straight < 1.12;
    }

    function frame(now) {
        raf = 0;
        let active = false;
        overlays.forEach((o, tileId) => {
            const r = videoRect(o);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cw = Math.round(r.box.width * dpr), ch = Math.round(r.box.height * dpr);
            if (o.canvas.width !== cw || o.canvas.height !== ch) { o.canvas.width = cw; o.canvas.height = ch; }
            const ctx = o.ctx;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, r.box.width, r.box.height);
            const ox = r.left - r.box.left, oy = r.top - r.box.top;
            const width = Math.max(3, Math.min(7, r.width / 220));
            strokes.forEach((s, key) => {
                if (s.tile !== tileId) return;
                // Потерянный конец линии (обрыв связи) — считаем законченной.
                if (!s.done && s.by !== myRealUserId && now - (s.lastAt || now) > 2500) { s.done = true; s.endAt = now; }
                let alpha = 1;
                if (s.done) {
                    const t = now - s.endAt - HOLD_MS;
                    if (t > FADE_MS) { strokes.delete(key); return; }
                    if (t > 0) alpha = 1 - t / FADE_MS;
                }
                active = true;
                if (!s.pts.length) return;
                const pts = s.pts.map((p) => [ox + p[0] * r.width, oy + p[1] * r.height]);
                ctx.globalAlpha = alpha;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                // Тёмная подложка, чтобы линия читалась на любом экране.
                for (const pass of [0, 1]) {
                    ctx.strokeStyle = pass ? s.color : "rgba(0,0,0,.45)";
                    ctx.lineWidth = pass ? width : width + 3;
                    ctx.beginPath();
                    ctx.moveTo(pts[0][0], pts[0][1]);
                    if (s.done && isArrow(s.pts)) {
                        ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
                    } else {
                        for (let i = 1; i < pts.length - 1; i++) {
                            const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
                            ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
                        }
                        if (pts.length > 1) ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
                        else ctx.lineTo(pts[0][0] + 0.1, pts[0][1]);
                    }
                    ctx.stroke();
                    if (s.done && isArrow(s.pts)) {
                        const a = pts[0], b = pts[pts.length - 1];
                        const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
                        const head = width * 4.2;
                        ctx.beginPath();
                        ctx.moveTo(b[0] - Math.cos(angle - 0.5) * head, b[1] - Math.sin(angle - 0.5) * head);
                        ctx.lineTo(b[0], b[1]);
                        ctx.lineTo(b[0] - Math.cos(angle + 0.5) * head, b[1] - Math.sin(angle + 0.5) * head);
                        ctx.stroke();
                    }
                }
                // Подпись автора у начала линии.
                if (s.by !== myRealUserId) {
                    const label = s.name;
                    ctx.font = "600 11px system-ui, -apple-system, Segoe UI, sans-serif";
                    const tw = ctx.measureText(label).width;
                    const lx = Math.min(r.box.width - tw - 14, Math.max(2, pts[0][0] + 8));
                    const ly = Math.max(2, pts[0][1] - 24);
                    ctx.fillStyle = s.color;
                    ctx.beginPath();
                    if (ctx.roundRect) ctx.roundRect(lx, ly, tw + 12, 18, 9); else ctx.rect(lx, ly, tw + 12, 18);
                    ctx.fill();
                    ctx.fillStyle = "#fff";
                    ctx.fillText(label, lx + 6, ly + 13);
                }
                ctx.globalAlpha = 1;
            });
        });
        // Линии на плитках, которых больше нет (трансляция закончилась), — убираем.
        strokes.forEach((s, key) => { if (!overlays.has(s.tile)) strokes.delete(key); });
        if (active) raf = requestAnimationFrame(frame);
    }

    if (typeof voiceVideoRefresh === "function") {
        const originalRefresh = voiceVideoRefresh;
        voiceVideoRefresh = function () {
            const result = originalRefresh.apply(this, arguments);
            try { syncOverlays(); } catch (error) { console.warn("draw overlays", error); }
            return result;
        };
    }

    window.KabanScreenDraw = { _strokes: strokes, _overlays: overlays, toggleDrawing, sync: syncOverlays };
})();
