/* ============================================================================
   СТИКЕР ИЗ ЛЮБОГО ФОТО
   Выбираете фото → нажимаете на то, что нужно вырезать (человек, кот, кружка…) →
   нейросеть прямо в браузере отделяет объект от фона, KABAN обводит его белым
   контуром с тенью, как в Telegram, — и стикер уходит в чат. Фото никуда не
   отправляется ради вырезания: модель (MediaPipe «Magic Touch», ~6 МБ) скачивается
   один раз и работает на устройстве.
   Готовые стикеры хранятся на устройстве («Мои стикеры» в панели стикеров).
   В ленте стикер — обычное фото с attachment_meta.sticker: без пузыря, крупно.
   ========================================================================= */

(function () {
    "use strict";

    const VISION_VERSION = "0.10.14";
    const VISION_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
    const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";
    const SIZE = 512;          // стикер — квадрат 512×512, как в Telegram
    const WORK_MAX = 1024;     // фото для нейросети уменьшаем до этой стороны
    const OUTLINE = 9;         // толщина белого контура (px на стикере 512)

    let segmenterPromise = null;

    function loadSegmenter() {
        if (segmenterPromise) return segmenterPromise;
        segmenterPromise = (async () => {
            const vision = await import(`${VISION_BASE}/vision_bundle.mjs`);
            const fileset = await vision.FilesetResolver.forVisionTasks(`${VISION_BASE}/wasm`);
            const make = (delegate) => vision.InteractiveSegmenter.createFromOptions(fileset, {
                baseOptions: { modelAssetPath: MODEL_URL, delegate },
                outputCategoryMask: true,
                outputConfidenceMasks: false
            });
            try { return await make("GPU"); } catch { return await make("CPU"); }
        })();
        segmenterPromise.catch(() => { segmenterPromise = null; });
        return segmenterPromise;
    }

    /* ---- состояние окна ---- */

    const st = {
        open: false, work: null, maskCanvas: null, point: null, cutout: true,
        busy: false, result: null, token: 0, sourceName: "sticker"
    };

    function el(id) { return document.getElementById(id); }

    function buildModal() {
        if (el("sm-backdrop")) return;
        const backdrop = document.createElement("div");
        backdrop.id = "sm-backdrop";
        backdrop.className = "sm-backdrop";
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `
            <div class="sm-window" role="dialog" aria-modal="true" aria-labelledby="sm-title">
                <div class="sm-head">
                    <button type="button" class="sm-icon-btn" data-sm="close" aria-label="Закрыть" title="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
                    <b id="sm-title">Стикер из фото</b>
                    <button type="button" class="sm-icon-btn" data-sm="pick" aria-label="Другое фото" title="Другое фото"><svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m4 17 5-5 3.5 3.5 2.5-2.5 5 5"/></svg></button>
                </div>
                <div class="sm-stage" id="sm-stage">
                    <div class="sm-canvas-wrap"><canvas id="sm-canvas"></canvas><span class="sm-tap" id="sm-tap" hidden></span></div>
                    <div class="sm-status" id="sm-status"></div>
                </div>
                <div class="sm-bottom">
                    <div class="sm-preview-wrap"><canvas class="sm-preview" id="sm-preview" width="${SIZE}" height="${SIZE}"></canvas></div>
                    <div class="sm-controls">
                        <div class="sm-seg" role="radiogroup" aria-label="Режим">
                            <button type="button" role="radio" data-sm="mode-cut" class="active" aria-checked="true">Вырезать объект</button>
                            <button type="button" role="radio" data-sm="mode-full" aria-checked="false">Всё фото</button>
                        </div>
                        <label class="sm-save"><input type="checkbox" id="sm-save" checked> Сохранить в «Мои стикеры»</label>
                        <button type="button" class="sm-send" data-sm="send" id="sm-send" disabled>Отправить стикер</button>
                    </div>
                </div>
                <input type="file" id="sm-file" accept="image/*" hidden>
            </div>`;
        document.body.appendChild(backdrop);

        backdrop.addEventListener("click", (event) => {
            if (event.target === backdrop) { closeStickerMaker(); return; }
            const action = event.target.closest("[data-sm]")?.dataset.sm;
            if (action === "close") closeStickerMaker();
            if (action === "pick") el("sm-file").click();
            if (action === "send") sendFromMaker();
            if (action === "mode-cut" || action === "mode-full") {
                st.cutout = action === "mode-cut";
                backdrop.querySelectorAll(".sm-seg button").forEach((b) => {
                    const on = b.dataset.sm === action;
                    b.classList.toggle("active", on);
                    b.setAttribute("aria-checked", on ? "true" : "false");
                });
                if (st.cutout && !st.maskCanvas) segmentAt(st.point || { x: 0.5, y: 0.5 });
                else render();
            }
        });
        backdrop.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.stopPropagation(); closeStickerMaker(); }
        });
        el("sm-file").addEventListener("change", (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) loadPhoto(file);
        });
        el("sm-canvas").addEventListener("click", (event) => {
            if (!st.work || !st.cutout) return;
            const r = event.currentTarget.getBoundingClientRect();
            segmentAt({ x: (event.clientX - r.left) / r.width, y: (event.clientY - r.top) / r.height });
        });
    }

    function setStatus(text, kind) {
        const status = el("sm-status");
        status.textContent = text || "";
        status.dataset.kind = kind || "";
        status.hidden = !text;
    }

    function openStickerMaker(file) {
        if (typeof closeAttachMenu === "function") closeAttachMenu();
        if (typeof closeEmojiPopover === "function") { try { closeEmojiPopover(); } catch { /* ок */ } }
        if (!currentChatId) { toast("Сначала откройте чат"); return; }
        if (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret) { toast("Стикеры из фото в секретных чатах пока не поддерживаются"); return; }
        buildModal();
        const backdrop = el("sm-backdrop");
        backdrop.classList.add("open");
        backdrop.setAttribute("aria-hidden", "false");
        st.open = true;
        if (file) loadPhoto(file);
        else if (!st.work) { setStatus("Выберите фото", ""); el("sm-file").click(); }
        // Модель начинаем качать сразу, пока человек выбирает фото.
        loadSegmenter().catch(() => {});
    }

    function closeStickerMaker() {
        const backdrop = el("sm-backdrop");
        if (!backdrop) return;
        backdrop.classList.remove("open");
        backdrop.setAttribute("aria-hidden", "true");
        st.open = false;
        st.token++;
    }

    async function loadPhoto(file) {
        if (!/^image\//.test(file.type || "")) { toast("Нужна картинка"); return; }
        const token = ++st.token;
        st.sourceName = (file.name || "sticker").replace(/\.[^.]+$/, "").slice(0, 40) || "sticker";
        let bitmap;
        try {
            bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        } catch {
            toast("Не удалось открыть фото");
            return;
        }
        if (token !== st.token) return;
        const scale = Math.min(1, WORK_MAX / Math.max(bitmap.width, bitmap.height));
        const work = document.createElement("canvas");
        work.width = Math.max(1, Math.round(bitmap.width * scale));
        work.height = Math.max(1, Math.round(bitmap.height * scale));
        work.getContext("2d").drawImage(bitmap, 0, 0, work.width, work.height);
        bitmap.close?.();
        st.work = work;
        st.maskCanvas = null;
        st.point = null;
        st.result = null;
        render();
        if (st.cutout) segmentAt({ x: 0.5, y: 0.5 }, true);
    }

    async function segmentAt(point, auto) {
        if (!st.work) return;
        const token = st.token;
        st.point = point;
        st.busy = true;
        render();
        setStatus(segmenterPromise ? "Вырезаю…" : "Загружаю нейросеть (один раз, ~6 МБ)…", "busy");
        let segmenter;
        try {
            segmenter = await loadSegmenter();
        } catch (error) {
            console.warn("Сегментация недоступна", error);
            st.busy = false;
            if (token !== st.token) return;
            setStatus("Не удалось загрузить нейросеть — можно отправить всё фото", "error");
            st.cutout = false;
            el("sm-backdrop").querySelectorAll(".sm-seg button").forEach((b) => b.classList.toggle("active", b.dataset.sm === "mode-full"));
            render();
            return;
        }
        if (token !== st.token) return;
        let mask = null;
        try {
            mask = await new Promise((resolve, reject) => {
                try {
                    segmenter.segment(st.work, { keypoint: { x: point.x, y: point.y } }, (result) => {
                        try {
                            const m = result.categoryMask;
                            const data = m.getAsUint8Array().slice();
                            resolve({ data, width: m.width, height: m.height });
                            m.close?.();
                        } catch (error) { reject(error); }
                    });
                } catch (error) { reject(error); }
            });
        } catch (error) {
            console.warn("Ошибка сегментации", error);
        }
        st.busy = false;
        if (token !== st.token) return;
        const maskCanvas = mask && maskToCanvas(mask, point);
        if (!maskCanvas) {
            st.maskCanvas = null;
            setStatus(auto ? "Нажмите на то, что нужно вырезать" : "Здесь не нашлось объекта — нажмите на другое место", auto ? "" : "error");
            render();
            return;
        }
        st.maskCanvas = maskCanvas;
        setStatus("Нажмите на другой объект, чтобы выбрать его", "");
        render();
    }

    // Маска категорий → холст с альфой. Какое значение — «объект», узнаём по точке
    // нажатия (так не зависим от того, как модель нумерует классы).
    function maskToCanvas(mask, point) {
        const { data, width, height } = mask;
        const px = Math.min(width - 1, Math.max(0, Math.round(point.x * (width - 1))));
        const py = Math.min(height - 1, Math.max(0, Math.round(point.y * (height - 1))));
        const fg = data[py * width + px];
        let count = 0;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        const img = ctx.createImageData(width, height);
        for (let i = 0; i < data.length; i++) {
            if (data[i] === fg) { img.data[i * 4 + 3] = 255; count++; }
        }
        const share = count / data.length;
        if (share < 0.004 || share > 0.97) return null;
        ctx.putImageData(img, 0, 0);
        // Мягкий край: чуть размываем маску, чтобы контур не был «лесенкой».
        const soft = document.createElement("canvas");
        soft.width = st.work.width;
        soft.height = st.work.height;
        const sctx = soft.getContext("2d");
        sctx.filter = "blur(1.2px)";
        sctx.drawImage(canvas, 0, 0, soft.width, soft.height);
        return soft;
    }

    function alphaBounds(canvas) {
        const { width, height } = canvas;
        const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
        let minX = width, minY = height, maxX = -1, maxY = -1;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (data[(y * width + x) * 4 + 3] > 40) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }

    // Готовый стикер 512×512: объект по центру, белый контур и мягкая тень.
    function composeSticker() {
        const work = st.work;
        if (!work) return null;
        const out = document.createElement("canvas");
        out.width = out.height = SIZE;
        const ctx = out.getContext("2d");
        const pad = OUTLINE + 14;

        if (!st.cutout || !st.maskCanvas) {
            // Всё фото: скруглённая карточка с белой рамкой.
            const s = Math.min((SIZE - pad * 2) / work.width, (SIZE - pad * 2) / work.height);
            const w = work.width * s, h = work.height * s;
            const x = (SIZE - w) / 2, y = (SIZE - h) / 2;
            const radius = Math.min(w, h) * 0.12;
            ctx.save();
            ctx.shadowColor = "rgba(0,0,0,.28)";
            ctx.shadowBlur = 14;
            ctx.shadowOffsetY = 4;
            ctx.fillStyle = "#fff";
            roundRect(ctx, x - OUTLINE, y - OUTLINE, w + OUTLINE * 2, h + OUTLINE * 2, radius + OUTLINE);
            ctx.fill();
            ctx.restore();
            ctx.save();
            roundRect(ctx, x, y, w, h, radius);
            ctx.clip();
            ctx.drawImage(work, x, y, w, h);
            ctx.restore();
            return out;
        }

        // Вырезанный объект на прозрачном фоне.
        const cut = document.createElement("canvas");
        cut.width = work.width;
        cut.height = work.height;
        const cctx = cut.getContext("2d");
        cctx.drawImage(work, 0, 0);
        cctx.globalCompositeOperation = "destination-in";
        cctx.drawImage(st.maskCanvas, 0, 0);
        const box = alphaBounds(st.maskCanvas);
        if (!box) return null;

        const s = Math.min((SIZE - pad * 2) / box.w, (SIZE - pad * 2) / box.h);
        const w = box.w * s, h = box.h * s;
        const x = (SIZE - w) / 2, y = (SIZE - h) / 2;

        // Белый силуэт = объект, залитый белым.
        const sil = document.createElement("canvas");
        sil.width = sil.height = SIZE;
        const sctx = sil.getContext("2d");
        sctx.drawImage(cut, box.x, box.y, box.w, box.h, x, y, w, h);
        sctx.globalCompositeOperation = "source-in";
        sctx.fillStyle = "#fff";
        sctx.fillRect(0, 0, SIZE, SIZE);

        // Контур: силуэт, нарисованный по кругу со сдвигом.
        const outline = document.createElement("canvas");
        outline.width = outline.height = SIZE;
        const octx = outline.getContext("2d");
        for (let r = OUTLINE / 2; r <= OUTLINE; r += OUTLINE / 2) {
            for (let i = 0; i < 24; i++) {
                const a = (i / 24) * Math.PI * 2;
                octx.drawImage(sil, Math.cos(a) * r, Math.sin(a) * r);
            }
        }
        octx.drawImage(sil, 0, 0);

        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,.3)";
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;
        ctx.drawImage(outline, 0, 0);
        ctx.restore();
        ctx.drawImage(cut, box.x, box.y, box.w, box.h, x, y, w, h);
        return out;
    }

    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    // Большая картинка: фото, выбранный объект подсвечен, остальное затемнено.
    function render() {
        const canvas = el("sm-canvas");
        if (!canvas) return;
        const work = st.work;
        const send = el("sm-send");
        if (!work) { canvas.width = canvas.height = 1; send.disabled = true; return; }
        canvas.width = work.width;
        canvas.height = work.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(work, 0, 0);
        if (st.cutout && st.maskCanvas) {
            const dim = document.createElement("canvas");
            dim.width = work.width;
            dim.height = work.height;
            const dctx = dim.getContext("2d");
            dctx.fillStyle = "rgba(8,10,14,.62)";
            dctx.fillRect(0, 0, dim.width, dim.height);
            dctx.globalCompositeOperation = "destination-out";
            dctx.drawImage(st.maskCanvas, 0, 0);
            ctx.drawImage(dim, 0, 0);
        }
        const tap = el("sm-tap");
        tap.hidden = !(st.cutout && st.point);
        if (st.point) { tap.style.left = st.point.x * 100 + "%"; tap.style.top = st.point.y * 100 + "%"; }
        tap.classList.toggle("busy", st.busy);
        el("sm-stage").classList.toggle("busy", st.busy);

        st.result = st.busy ? null : composeSticker();
        const preview = el("sm-preview");
        const pctx = preview.getContext("2d");
        pctx.clearRect(0, 0, SIZE, SIZE);
        if (st.result) pctx.drawImage(st.result, 0, 0);
        preview.parentElement.classList.toggle("empty", !st.result);
        send.disabled = !st.result || st.busy;
        if (!st.cutout) setStatus("", "");
    }

    function canvasToFile(canvas) {
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                if (blob && blob.type === "image/webp") { resolve(new File([blob], `${st.sourceName}-sticker.webp`, { type: "image/webp" })); return; }
                canvas.toBlob((png) => resolve(png ? new File([png], `${st.sourceName}-sticker.png`, { type: "image/png" }) : null), "image/png");
            }, "image/webp", 0.92);
        });
    }

    async function sendFromMaker() {
        if (!st.result) return;
        const file = await canvasToFile(st.result);
        if (!file) { toast("Не удалось подготовить стикер"); return; }
        if (el("sm-save").checked) saveMySticker(file).catch(() => {});
        closeStickerMaker();
        st.work = null;
        st.maskCanvas = null;
        await sendImageSticker(file);
    }

    async function sendImageSticker(file) {
        const chatId = currentChatId;
        if (!chatId) return;
        let message;
        try {
            message = await sendAttachmentReliably(chatId, file, (url) => ({
                type: "image",
                attachmentUrl: url,
                attachmentMeta: { sticker: true, name: file.name, size: file.size, mime: file.type, w: SIZE, h: SIZE }
            }), "стикер");
        } catch (error) {
            toast("Не удалось отправить стикер: " + (typeof sendErrorText === "function" ? sendErrorText(error) : (error?.message || error)));
            return;
        }
        realMessagesById.set(message.id, message);
        if (currentChatId === chatId) {
            appendRealMessageRow(message, true);
            updateMessageGrouping();
            if (appSettings.sendSound && typeof playSendSound === "function") playSendSound();
            if (typeof scrollMessagesToBottom === "function") scrollMessagesToBottom();
        }
        if (typeof patchCachedChatLastMessage === "function") patchCachedChatLastMessage(chatId, message);
    }

    /* ---- «Мои стикеры» на устройстве (IndexedDB) ---- */

    const DB_NAME = "kaban-my-stickers";
    let dbPromise = null;
    const objectUrls = new Map();

    function db() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => req.result.createObjectStore("stickers", { keyPath: "id" });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        dbPromise.catch(() => { dbPromise = null; });
        return dbPromise;
    }

    async function saveMySticker(file) {
        const conn = await db();
        const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now());
        await new Promise((resolve, reject) => {
            const tx = conn.transaction("stickers", "readwrite");
            tx.objectStore("stickers").put({ id, blob: file, name: file.name, type: file.type, at: Date.now() });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        const list = await listMyStickers();
        // Не больше 80: самые старые уходят.
        if (list.length > 80) await Promise.all(list.slice(80).map((item) => deleteMySticker(item.id)));
    }

    async function listMyStickers() {
        const conn = await db();
        return new Promise((resolve, reject) => {
            const req = conn.transaction("stickers").objectStore("stickers").getAll();
            req.onsuccess = () => resolve((req.result || []).sort((a, b) => b.at - a.at));
            req.onerror = () => reject(req.error);
        });
    }

    async function deleteMySticker(id) {
        const conn = await db();
        await new Promise((resolve) => {
            const tx = conn.transaction("stickers", "readwrite");
            tx.objectStore("stickers").delete(id);
            tx.oncomplete = resolve;
            tx.onerror = resolve;
        });
        const url = objectUrls.get(id);
        if (url) { URL.revokeObjectURL(url); objectUrls.delete(id); }
    }

    function stickerUrl(item) {
        if (!objectUrls.has(item.id)) objectUrls.set(item.id, URL.createObjectURL(item.blob));
        return objectUrls.get(item.id);
    }

    async function fillMyStickers() {
        const title = el("sticker-pack-title");
        const grid = el("sticker-grid");
        if (!grid) return;
        if (title) title.textContent = "Мои стикеры";
        grid.innerHTML = `<button type="button" class="sticker-btn sm-make-tile" title="Сделать стикер из фото"><span>＋</span><em>Из фото</em></button>`;
        grid.querySelector(".sm-make-tile").addEventListener("click", () => openStickerMaker());
        let list = [];
        try { list = await listMyStickers(); } catch { /* нет IndexedDB */ }
        if (typeof activeStickerPack !== "undefined" && activeStickerPack !== "mine") return;
        list.forEach((item) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "sticker-btn sm-my-sticker";
            button.title = "Отправить · правый клик — удалить";
            button.innerHTML = `<img alt="Стикер" src="${stickerUrl(item)}">`;
            button.addEventListener("click", () => {
                if (typeof closeEmojiPopover === "function") { try { closeEmojiPopover(); } catch { /* ок */ } }
                const file = new File([item.blob], item.name || "sticker.webp", { type: item.type || item.blob.type || "image/webp" });
                sendImageSticker(file);
            });
            button.addEventListener("contextmenu", async (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!confirm("Удалить стикер из «Моих стикеров»?")) return;
                await deleteMySticker(item.id);
                button.remove();
            });
            grid.appendChild(button);
        });
        if (!list.length) grid.insertAdjacentHTML("beforeend", `<div class="sm-empty">Сделайте свой первый стикер — из любого фото: человек, питомец, еда, что угодно.</div>`);
        grid.scrollTop = 0;
    }

    // Пак «Мои» — первым в панели стикеров.
    if (typeof renderStickerPacks === "function") {
        const originalRender = renderStickerPacks;
        renderStickerPacks = function () {
            const result = originalRender.apply(this, arguments);
            const packs = document.querySelector("#emoji-popover-stickers .sticker-packs");
            if (packs && !packs.querySelector('[data-pack="mine"]')) {
                packs.insertAdjacentHTML("afterbegin", `<button type="button" class="sticker-pack-btn sm-pack-btn${activeStickerPack === "mine" ? " active" : ""}" data-pack="mine" title="Мои стикеры" onclick="selectStickerPack('mine')"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3.5H8A4.5 4.5 0 0 0 3.5 8v8A4.5 4.5 0 0 0 8 20.5h5L20.5 13V8A4.5 4.5 0 0 0 16 3.5"/><path d="M13 20.5V17a4 4 0 0 1 4-4h3.5M9 10h.01M15 10h.01M9 14.5c1.6 1.2 3.5 1.2 5 0"/></svg></button>`);
            }
            return result;
        };
    }
    if (typeof fillStickerGrid === "function") {
        const originalFill = fillStickerGrid;
        fillStickerGrid = function () {
            if (typeof activeStickerPack !== "undefined" && activeStickerPack === "mine") { fillMyStickers(); return; }
            return originalFill.apply(this, arguments);
        };
    }

    // Пункт в меню скрепки.
    (function addMenuItem() {
        const menu = document.getElementById("attach-menu");
        if (!menu || menu.querySelector(".sm-menu-item")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "attach-menu-item sm-menu-item";
        button.setAttribute("role", "menuitem");
        button.innerHTML = `<span class="attach-menu-icon sticker" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M14 3.5H8A4.5 4.5 0 0 0 3.5 8v8A4.5 4.5 0 0 0 8 20.5h5L20.5 13V8A4.5 4.5 0 0 0 16 3.5"/><path d="M13 20.5V17a4 4 0 0 1 4-4h3.5"/></svg></span> Стикер из фото`;
        button.addEventListener("click", () => openStickerMaker());
        const media = [...menu.querySelectorAll(".attach-menu-item")].find((b) => /triggerAttachPick\('media'\)/.test(b.getAttribute("onclick") || ""));
        if (media) media.after(button); else menu.appendChild(button);
    })();

    // В ленте: фото-стикер — без пузыря и крупно.
    if (typeof window.KabanWowDecorate === "function") {
        window.KabanWowDecorate((row, message) => {
            if (message.type !== "image" || !message.attachment_meta?.sticker || message.deleted_at) return;
            const bubble = row.querySelector(".message");
            if (bubble && !bubble.classList.contains("sticker-image")) bubble.classList.add("sticker", "sticker-image");
        });
    }

    if (typeof messagePreviewText === "function") {
        const originalPreview = messagePreviewText;
        messagePreviewText = function (message) {
            if (message?.type === "image" && message.attachment_meta?.sticker && !message.deleted_at) return "Стикер";
            return originalPreview.apply(this, arguments);
        };
    }

    window.openStickerMaker = openStickerMaker;
    window.closeStickerMaker = closeStickerMaker;
    window.KabanStickerMaker = { loadSegmenter, composeSticker, _st: st, listMyStickers, saveMySticker };
})();
