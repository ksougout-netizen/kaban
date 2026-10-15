/* ============================================================================
   ПРОСМОТР ФОТО — как в Telegram.
   Заменяет простую галерею из script-messages.js (openImageGallery и др. —
   функции с теми же именами, поэтому все onclick в чате работают как раньше).
     • сверху: аватар и имя отправителя, дата и время, «скачать», «закрыть»;
     • внизу: подпись к фото и счётчик «3 из 12»;
     • колесо мыши / щипок / двойной тап — масштаб, перетаскивание увеличенного фото;
     • свайп вбок — соседнее фото (с анимацией), свайп вниз — закрыть;
     • клавиши ← → Esc, + − 0.
   ========================================================================= */

(function () {
    const MAX_SCALE = 6;
    const DOUBLE_SCALE = 2.5;

    let items = [];
    let index = 0;
    let root, stage, imgEl, videoEl, topName, topMeta, topAvatar, captionEl, counterEl, prevBtn, nextBtn;

    // состояние картинки
    let scale = 1, tx = 0, ty = 0;
    // жесты
    const pointers = new Map();
    let gesture = null;          // {mode, startX, startY, baseTx, baseTy, baseScale, dist0, mid0}
    let lastTap = 0;
    let animating = false;

    function build() {
        if (root) return;
        root = document.createElement("div");
        root.className = "pv";
        root.setAttribute("aria-hidden", "true");
        root.innerHTML = `
            <div class="pv-top">
                <span class="pv-avatar" id="pv-avatar"></span>
                <div class="pv-who"><div class="pv-name" id="pv-name"></div><div class="pv-meta" id="pv-meta"></div></div>
                <button type="button" class="pv-btn" id="pv-copy" aria-label="Копировать картинку" title="Копировать картинку">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>
                </button>
                <button type="button" class="pv-btn" id="pv-share" aria-label="Поделиться" title="Поделиться" hidden>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13"/></svg>
                </button>                <button type="button" class="pv-btn" id="pv-download" aria-label="Скачать" title="Скачать">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 19.5h14"/></svg>
                </button>
                <button type="button" class="pv-btn" id="pv-close" aria-label="Закрыть" title="Закрыть (Esc)">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
            </div>
            <div class="pv-stage" id="pv-stage"><img class="pv-img" id="pv-img" alt="Фото" draggable="false"><video class="pv-video" id="pv-video" controls playsinline hidden></video></div>
            <button type="button" class="pv-nav pv-prev" id="pv-prev" aria-label="Предыдущее фото"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.2 12 15 18.5"/></svg></button>
            <button type="button" class="pv-nav pv-next" id="pv-next" aria-label="Следующее фото"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5.5 6.8 6.5L9 18.5"/></svg></button>
            <div class="pv-bottom">
                <div class="pv-caption" id="pv-caption" hidden></div>
                <div class="pv-counter" id="pv-counter"></div>
            </div>`;
        document.body.appendChild(root);

        stage = root.querySelector("#pv-stage");
        imgEl = root.querySelector("#pv-img");
        videoEl = root.querySelector("#pv-video");
        topName = root.querySelector("#pv-name");
        topMeta = root.querySelector("#pv-meta");
        topAvatar = root.querySelector("#pv-avatar");
        captionEl = root.querySelector("#pv-caption");
        counterEl = root.querySelector("#pv-counter");
        prevBtn = root.querySelector("#pv-prev");
        nextBtn = root.querySelector("#pv-next");

        root.querySelector("#pv-close").addEventListener("click", closeViewer);
        root.querySelector("#pv-download").addEventListener("click", downloadCurrent);
        root.querySelector("#pv-copy").addEventListener("click", copyCurrent);
        root.querySelector("#pv-share").addEventListener("click", shareCurrent);
        if (navigator.share && navigator.canShare) root.querySelector("#pv-share").hidden = false;
        prevBtn.addEventListener("click", (e) => { e.stopPropagation(); go(-1); });
        nextBtn.addEventListener("click", (e) => { e.stopPropagation(); go(1); });

        stage.addEventListener("pointerdown", onDown);
        stage.addEventListener("pointermove", onMove);
        stage.addEventListener("pointerup", onUp);
        stage.addEventListener("pointercancel", onUp);
        stage.addEventListener("wheel", onWheel, { passive: false });
        stage.addEventListener("dblclick", (e) => { if (items[index]?.video) return; e.preventDefault(); toggleZoom(e.clientX, e.clientY); });
        imgEl.addEventListener("dragstart", (e) => e.preventDefault());

        // capture + остановка: Escape закрывает только просмотр, а не заодно то, что под ним
        // (например, режим выделения сообщений — selection.js тоже слушает Escape).
        document.addEventListener("keydown", (e) => {
            if (!root.classList.contains("open")) return;
            if (e.key === "Escape") { e.stopImmediatePropagation(); closeViewer(); }
            else if (e.key === " " && items[index]?.video) { e.preventDefault(); videoEl.paused ? videoEl.play() : videoEl.pause(); }
            else if (e.key === "ArrowLeft") go(-1);
            else if (e.key === "ArrowRight") go(1);
            else if (e.key === "+" || e.key === "=") zoomAround(innerWidth / 2, innerHeight / 2, scale * 1.4);
            else if (e.key === "-") zoomAround(innerWidth / 2, innerHeight / 2, scale / 1.4);
            else if (e.key === "0") resetTransform(true);
        }, true);
    }

    /* ---------- данные ---------- */

    function describe(el) {
        const row = el.closest(".message-row");
        const msg = row?.dataset?.messageId && typeof realMessagesById !== "undefined"
            ? realMessagesById.get(row.dataset.messageId) : null;
        const mine = !!row && row.classList.contains("sent");
        let name = "";
        let avatarUrl = "";
        let uid = msg?.sender_id || "";
        if (mine) {
            name = (typeof cachedMyProfile !== "undefined" && (cachedMyProfile?.display_name || cachedMyProfile?.username)) || "Вы";
            avatarUrl = (typeof cachedMyProfile !== "undefined" && cachedMyProfile?.avatar_url) || "";
        } else {
            const member = (typeof currentChatMembersById !== "undefined" && uid) ? currentChatMembersById.get(uid) : null;
            name = member?.display_name || member?.username
                || row?.querySelector(".message-sender-name")?.textContent?.trim()
                || document.getElementById("chat-title")?.textContent?.trim()
                || "";
            avatarUrl = member?.avatar_url || "";
        }
        return {
            video: el.classList.contains("message-video"),
            url: el.classList.contains("message-video") ? (el.querySelector("video")?.getAttribute("src") || "").split("#")[0] : (el.currentSrc || el.src),
            name,
            uid,
            avatarUrl,
            when: msg?.created_at ? new Date(msg.created_at) : null,
            caption: msg?.text || "",
            fileName: el.alt && el.alt !== "Фото" ? el.alt : ""
        };
    }

    function formatWhen(d) {
        if (!d || isNaN(d)) return "";
        const now = new Date();
        const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const sameDay = d.toDateString() === now.toDateString();
        const yest = new Date(now - 864e5).toDateString() === d.toDateString();
        if (sameDay) return `сегодня в ${time}`;
        if (yest) return `вчера в ${time}`;
        const date = d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
        return `${date} в ${time}`;
    }

    /* ---------- показ ---------- */

    function render(direction) {
        const it = items[index];
        if (!it) return;

        topName.textContent = it.name;
        topMeta.textContent = formatWhen(it.when);

        if (typeof avatarParts === "function") {
            const a = avatarParts({ id: it.uid || it.name, name: it.name || "?", url: it.avatarUrl });
            topAvatar.className = "pv-avatar" + (a.cls || "");
            topAvatar.setAttribute("style", (a.style || "").replace(/^\s*style="|"\s*$/g, ""));
            topAvatar.innerHTML = a.inner || "";
        }

        captionEl.hidden = !it.caption;
        captionEl.textContent = it.caption;
        counterEl.textContent = items.length > 1 ? `${index + 1} из ${items.length}` : "";
        counterEl.hidden = items.length < 2;
        prevBtn.hidden = items.length < 2;
        nextBtn.hidden = items.length < 2;

        resetTransform(false);
        videoEl.pause();
        imgEl.hidden = !!it.video;
        videoEl.hidden = !it.video;
        stage.classList.toggle("is-video", !!it.video);
        root.querySelector("#pv-copy").hidden = !!it.video;
        if (it.video) {
            imgEl.removeAttribute("src");
            videoEl.src = it.url;
            videoEl.play().catch(() => {});
        } else {
            videoEl.removeAttribute("src");
            videoEl.load();
            imgEl.src = it.url;
        }

        if (direction) {
            imgEl.classList.remove("pv-in-left", "pv-in-right");
            void imgEl.offsetWidth;
            imgEl.classList.add(direction > 0 ? "pv-in-right" : "pv-in-left");
        }

        // заранее грузим соседей, чтобы листать без паузы
        [index - 1, index + 1].forEach((i) => {
            if (items[i] && !items[i].video) { const p = new Image(); p.src = items[i].url; }
        });
    }

    function open(clicked) {
        build();
        const nodes = Array.from(document.querySelectorAll("#messages img.message-image, #messages .message-video"));
        items = nodes.map(describe);
        index = Math.max(0, nodes.indexOf(clicked));
        if (index === 0 && nodes[0] !== clicked) {
            const byUrl = items.findIndex((x) => x.url === (clicked.currentSrc || clicked.src));
            if (byUrl >= 0) index = byUrl;
        }
        root.style.setProperty("--pv-fade", 1);
        render(0);
        root.classList.add("open");
        root.setAttribute("aria-hidden", "false");
    }

    function closeViewer() {
        if (!root) return;
        root.classList.remove("open");
        root.setAttribute("aria-hidden", "true");
        videoEl.pause();
        setTimeout(() => { if (!root.classList.contains("open")) { imgEl.removeAttribute("src"); videoEl.removeAttribute("src"); videoEl.load(); } }, 220);
    }

    function go(delta) {
        if (items.length < 2) return;
        index = (index + delta + items.length) % items.length;
        render(delta);
    }

    /* ---------- масштаб и перемещение ---------- */

    function apply(animate) {
        imgEl.style.transition = animate ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
        imgEl.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    }

    function resetTransform(animate) {
        scale = 1; tx = 0; ty = 0;
        root.style.setProperty("--pv-fade", 1);
        apply(animate);
        stage.classList.remove("zoomed");
    }

    function clampPan() {
        const w = imgEl.clientWidth * scale;
        const h = imgEl.clientHeight * scale;
        const maxX = Math.max(0, (w - stage.clientWidth) / 2);
        const maxY = Math.max(0, (h - stage.clientHeight) / 2);
        tx = Math.min(maxX, Math.max(-maxX, tx));
        ty = Math.min(maxY, Math.max(-maxY, ty));
    }

    function zoomAround(cx, cy, next, animate) {
        next = Math.min(MAX_SCALE, Math.max(1, next));
        const rect = stage.getBoundingClientRect();
        const ox = cx - (rect.left + rect.width / 2);
        const oy = cy - (rect.top + rect.height / 2);
        const k = next / scale;
        tx = ox - (ox - tx) * k;
        ty = oy - (oy - ty) * k;
        scale = next;
        if (scale === 1) { tx = 0; ty = 0; }
        clampPan();
        stage.classList.toggle("zoomed", scale > 1.01);
        apply(!!animate);
    }

    function toggleZoom(cx, cy) {
        zoomAround(cx, cy, scale > 1.05 ? 1 : DOUBLE_SCALE, true);
    }

    function onWheel(e) {
        if (items[index]?.video) return;
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
        zoomAround(e.clientX, e.clientY, scale * factor);
    }

    /* ---------- жесты ---------- */

    function dist() {
        const [a, b] = [...pointers.values()];
        return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function mid() {
        const [a, b] = [...pointers.values()];
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    function onDown(e) {
        if (e.target.closest("button") || e.target.closest("video")) return;
        stage.setPointerCapture?.(e.pointerId);
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2) {
            gesture = { mode: "pinch", dist0: dist(), baseScale: scale };
        } else if (pointers.size === 1) {
            gesture = { mode: "pending", startX: e.clientX, startY: e.clientY, baseTx: tx, baseTy: ty, t: Date.now() };
        }
    }

    function onMove(e) {
        if (!pointers.has(e.pointerId) || !gesture) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (gesture.mode === "pinch" && pointers.size >= 2) {
            const m = mid();
            zoomAround(m.x, m.y, gesture.baseScale * (dist() / gesture.dist0));
            return;
        }

        const dx = e.clientX - gesture.startX;
        const dy = e.clientY - gesture.startY;

        if (gesture.mode === "pending") {
            if (Math.hypot(dx, dy) < 8) return;
            if (scale > 1.01) gesture.mode = "pan";
            else gesture.mode = Math.abs(dx) > Math.abs(dy) ? "swipe" : "dismiss";
        }

        if (gesture.mode === "pan") {
            tx = gesture.baseTx + dx;
            ty = gesture.baseTy + dy;
            clampPan();
            apply(false);
        } else if (gesture.mode === "swipe") {
            tx = dx;
            apply(false);
        } else if (gesture.mode === "dismiss") {
            ty = dy;
            root.style.setProperty("--pv-fade", String(Math.max(0.25, 1 - Math.abs(dy) / 420)));
            apply(false);
        }
    }

    function onUp(e) {
        const wasPinch = gesture?.mode === "pinch";
        pointers.delete(e.pointerId);
        if (!gesture) return;

        if (wasPinch) {
            if (pointers.size < 2) {
                gesture = null;
                if (scale < 1.02) resetTransform(true);
            }
            return;
        }

        const g = gesture;
        gesture = null;
        const dx = e.clientX - g.startX;
        const dy = e.clientY - g.startY;

        if (g.mode === "swipe") {
            if (Math.abs(dx) > 70 && items.length > 1) {
                go(dx < 0 ? 1 : -1);
            } else {
                tx = 0; apply(true);
            }
        } else if (g.mode === "dismiss") {
            if (Math.abs(dy) > 110) closeViewer();
            else { ty = 0; root.style.setProperty("--pv-fade", 1); apply(true); }
        } else if (g.mode === "pending") {
            // короткий тап: двойной — масштаб, одиночный по фону — закрыть
            const now = Date.now();
            if (now - lastTap < 300) {
                lastTap = 0;
                toggleZoom(e.clientX, e.clientY);
            } else {
                lastTap = now;
                const onImage = e.target === imgEl;
                setTimeout(() => {
                    if (lastTap === now && !onImage && scale <= 1.01 && root.classList.contains("open")) closeViewer();
                }, 310);
            }
        }
    }

    /* ---------- скачать ---------- */

    async function downloadCurrent() {
        const it = items[index];
        if (!it) return;
        const ext = it.video ? "mp4" : (it.url.split("?")[0].match(/\.(jpe?g|png|webp|gif)$/i) || [, "jpg"])[1];
        const fileName = it.fileName || `kaban-${it.video ? "video" : "photo"}-${Date.now()}.${ext}`;
        try {
            const blob = await (await fetch(it.url)).blob();
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 4000);
            if (typeof toast === "function") toast(it.video ? "Видео сохранено" : "Фото сохранено");
        } catch {
            window.open(it.url, "_blank", "noopener");
        }
    }

    /* ---------- копировать картинку / поделиться ---------- */

    async function currentBlob() {
        const it = items[index];
        const res = await fetch(it.url);
        return { it, blob: await res.blob() };
    }

    async function copyCurrent() {
        try {
            let { blob } = await currentBlob();
            if (blob.type !== "image/png") {            // буфер обмена надёжно принимает только PNG
                const bmp = await createImageBitmap(blob);
                const c = document.createElement("canvas");
                c.width = bmp.width; c.height = bmp.height;
                c.getContext("2d").drawImage(bmp, 0, 0);
                blob = await new Promise((r) => c.toBlob(r, "image/png"));
            }
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            if (typeof toast === "function") toast("Картинка скопирована");
        } catch {
            if (typeof toast === "function") toast("Не удалось скопировать картинку");
        }
    }

    async function shareCurrent() {
        try {
            const { it, blob } = await currentBlob();
            const ext = it.video ? "mp4" : ((blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg"));
            const file = new File([blob], it.fileName || `kaban-${it.video ? "video" : "photo"}.${ext}`, { type: blob.type });
            if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], text: it.caption || undefined });
            else await navigator.share({ url: it.url });
        } catch (error) {
            if (error?.name !== "AbortError" && typeof toast === "function") toast("Не удалось поделиться");
        }
    }
    /* ---------- публичные имена (их зовёт чат) ---------- */

    window.openImageGallery = open;
    window.openVideoViewer = open;
    window.formatVideoDuration = function (sec) {
        sec = Math.max(0, Math.round(Number(sec) || 0));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
    };
    window.setVideoDurationBadge = function (video) {
        const badge = video.parentElement?.querySelector(".message-video-dur");
        if (badge && isFinite(video.duration) && !badge.textContent) badge.textContent = window.formatVideoDuration(video.duration);
    };
    window.closeImageGallery = closeViewer;
    window.navigateImageGallery = go;
    window.closeImageGalleryFromBackdrop = function () {};
})();
