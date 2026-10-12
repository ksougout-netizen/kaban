/* ============================================================================
   РЕДАКТОР АВАТАРКИ — как в Telegram: фото подгоняется прямо под кружок.
   Тянуть — двигать, колесо / щипок / ползунок — масштаб, «Повернуть» и «Отразить».
   На выходе квадрат 512×512 (в чатах он и так показывается кружком).

   Подключается ко всем местам, где ставится круглое фото:
     • моё фото профиля (handleAvatarFileChange),
     • фото при создании группы (selectGroupAvatarFile),
     • фото существующей группы (selectGroupInfoAvatarFile).
   Каждый обработчик оборачивается: сначала редактор, потом прежний код с готовым файлом.
   ========================================================================= */

(function () {
    const OUT = 512;          // размер итогового квадрата
    const ZOOM_MAX = 4;

    let root, stage, imgEl, slider, titleEl, okBtn;
    let resolver = null;

    // состояние
    let img = null;           // загруженный Image
    let rot = 0;              // 0..3 — четверти оборота
    let flip = 1;             // 1 или -1 (зеркало по горизонтали)
    let zoom = 1;             // 1 = «вписано в кружок», до ZOOM_MAX
    let tx = 0, ty = 0;       // сдвиг центра картинки от центра кружка (в px окна)
    let D = 280;              // диаметр кружка в px
    const pointers = new Map();
    let gesture = null;

    const swapped = () => rot % 2 === 1;
    const dims = () => (swapped() ? { w: img.naturalHeight, h: img.naturalWidth } : { w: img.naturalWidth, h: img.naturalHeight });
    const baseScale = () => { const { w, h } = dims(); return Math.max(D / w, D / h); };   // «cover»: кружок всегда закрыт картинкой

    function build() {
        if (root) return;
        root = document.createElement("div");
        root.className = "ac-backdrop";
        root.setAttribute("aria-hidden", "true");
        root.innerHTML = `
            <div class="ac-card" role="dialog" aria-modal="true" aria-label="Редактор фото">
                <div class="ac-head">
                    <button type="button" class="ac-x" data-ac="cancel" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
                    <span class="ac-title">Фото профиля</span>
                </div>
                <div class="ac-stage" id="ac-stage">
                    <img class="ac-img" id="ac-img" alt="" draggable="false">
                    <div class="ac-mask" aria-hidden="true"></div>
                </div>
                <div class="ac-zoom">
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="ac-zoom-ico"><circle cx="11" cy="11" r="6"/><path d="m20 20-4-4M8.5 11h5"/></svg>
                    <input type="range" class="ac-slider" id="ac-slider" min="1" max="${ZOOM_MAX}" step="0.01" value="1" aria-label="Масштаб">
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="ac-zoom-ico"><circle cx="11" cy="11" r="6"/><path d="m20 20-4-4M8.5 11h5M11 8.5v5"/></svg>
                </div>
                <div class="ac-tools">
                    <button type="button" class="ac-tool" data-ac="rotate"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/></svg>Повернуть</button>
                    <button type="button" class="ac-tool" data-ac="flip"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M8 7 3.5 17H8zM16 7l4.5 10H16z"/></svg>Отразить</button>
                    <button type="button" class="ac-tool" data-ac="reset"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4"/></svg>Сбросить</button>
                </div>
                <div class="ac-actions">
                    <button type="button" class="ac-cancel" data-ac="cancel">Отмена</button>
                    <button type="button" class="ac-ok" data-ac="ok">Готово</button>
                </div>
            </div>`;
        document.body.appendChild(root);

        stage = root.querySelector("#ac-stage");
        imgEl = root.querySelector("#ac-img");
        slider = root.querySelector("#ac-slider");
        titleEl = root.querySelector(".ac-title");
        okBtn = root.querySelector('[data-ac="ok"]');

        root.addEventListener("click", (e) => {
            if (e.target === root) { finish(null); return; }
            const act = e.target.closest("[data-ac]")?.dataset.ac;
            if (act === "cancel") finish(null);
            else if (act === "ok") exportAndFinish();
            else if (act === "rotate") { rot = (rot + 1) % 4; clamp(); apply(true); }
            else if (act === "flip") { flip = -flip; apply(true); }
            else if (act === "reset") { rot = 0; flip = 1; zoom = 1; tx = ty = 0; slider.value = "1"; apply(true); }
        });

        slider.addEventListener("input", () => setZoom(Number(slider.value)));

        stage.addEventListener("pointerdown", (e) => {
            stage.setPointerCapture?.(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) { const [a, b] = [...pointers.values()]; gesture = { mode: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), z0: zoom }; }
            else if (pointers.size === 1) gesture = { mode: "pan", x0: e.clientX, y0: e.clientY, tx0: tx, ty0: ty };
            stage.classList.add("grabbing");
        });
        stage.addEventListener("pointermove", (e) => {
            if (!pointers.has(e.pointerId) || !gesture) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (gesture.mode === "pinch" && pointers.size >= 2) {
                const [a, b] = [...pointers.values()];
                setZoom(gesture.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0));
            } else if (gesture.mode === "pan") {
                tx = gesture.tx0 + (e.clientX - gesture.x0);
                ty = gesture.ty0 + (e.clientY - gesture.y0);
                clamp(); apply(false);
            }
        });
        const up = (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size === 1) { const p = [...pointers.values()][0]; gesture = { mode: "pan", x0: p.x, y0: p.y, tx0: tx, ty0: ty }; }
            else if (!pointers.size) { gesture = null; stage.classList.remove("grabbing"); }
        };
        stage.addEventListener("pointerup", up);
        stage.addEventListener("pointercancel", up);
        stage.addEventListener("wheel", (e) => { e.preventDefault(); setZoom(zoom * Math.exp(-e.deltaY * 0.0016)); }, { passive: false });

        document.addEventListener("keydown", (e) => {
            if (!root.classList.contains("open")) return;
            if (e.key === "Escape") { e.stopPropagation(); finish(null); }
            else if (e.key === "Enter" && !e.target.closest("button")) exportAndFinish();
        }, true);
    }

    function clamp() {
        if (!img) return;
        const { w, h } = dims();
        const s = baseScale() * zoom;
        const maxX = Math.max(0, (w * s - D) / 2);
        const maxY = Math.max(0, (h * s - D) / 2);
        tx = Math.min(maxX, Math.max(-maxX, tx));
        ty = Math.min(maxY, Math.max(-maxY, ty));
    }

    function setZoom(z) {
        zoom = Math.min(ZOOM_MAX, Math.max(1, z));
        slider.value = String(zoom);
        clamp(); apply(false);
    }

    function apply(animate) {
        if (!img) return;
        const s = baseScale() * zoom;
        imgEl.style.transition = animate ? "transform .2s cubic-bezier(.2,.8,.2,1)" : "none";
        imgEl.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px) scale(${s}) rotate(${rot * 90}deg) scaleX(${flip})`;
    }

    function finish(result) {
        if (!root) return;
        root.classList.remove("open");
        root.setAttribute("aria-hidden", "true");
        pointers.clear(); gesture = null;
        const r = resolver; resolver = null;
        if (img?.src?.startsWith("blob:")) URL.revokeObjectURL(img.src);
        img = null;
        r?.(result);
    }

    async function exportAndFinish() {
        if (!img) return;
        okBtn.disabled = true;
        try {
            const k = OUT / D;
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = OUT;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#fff";                        // у PNG с прозрачностью фон белый (JPEG прозрачности не держит)
            ctx.fillRect(0, 0, OUT, OUT);
            ctx.imageSmoothingQuality = "high";
            ctx.translate(OUT / 2 + tx * k, OUT / 2 + ty * k);
            ctx.scale(baseScale() * zoom * k, baseScale() * zoom * k);
            ctx.rotate((rot * Math.PI) / 2);
            ctx.scale(flip, 1);
            ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
            const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
            if (!blob) throw new Error("не удалось собрать изображение");
            finish(new File([blob], "avatar.jpg", { type: "image/jpeg" }));
        } catch (error) {
            if (typeof toast === "function") toast("Не удалось подготовить фото: " + (error?.message || error));
            finish(null);
        } finally {
            okBtn.disabled = false;
        }
    }

    // Открыть редактор. Вернёт готовый File или null, если пользователь отказался.
    function openAvatarCropper(file, { title = "Фото профиля" } = {}) {
        build();
        if (resolver) return Promise.resolve(null);
        return new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                resolver = resolve;
                img = image;
                rot = 0; flip = 1; zoom = 1; tx = ty = 0;
                slider.value = "1";
                titleEl.textContent = title;
                imgEl.src = url;
                root.classList.add("open");
                root.setAttribute("aria-hidden", "false");
                D = stage.clientWidth * 0.82;
                root.style.setProperty("--ac-d", `${D}px`);
                apply(false);
                okBtn.focus({ preventScroll: true });
            };
            image.onerror = () => {
                URL.revokeObjectURL(url);
                if (typeof toast === "function") toast("Не удалось открыть изображение");
                resolve(null);
            };
            image.src = url;
        });
    }
    window.openAvatarCropper = openAvatarCropper;

    /* ---------- подключение к местам, где ставится фото ---------- */

    const croppable = (file) => file && /^image\/(jpeg|png|webp|bmp|avif)$/i.test(file.type);   // GIF и прочее — как раньше

    async function prepare(inputLike, title) {
        const file = inputLike?.files?.[0];
        if (!croppable(file)) return { pass: true };
        const cropped = await openAvatarCropper(file, { title });
        return cropped ? { file: cropped } : { cancelled: true };
    }

    if (typeof handleAvatarFileChange === "function") {
        const original = handleAvatarFileChange;
        handleAvatarFileChange = async function (event) {
            const input = event?.target;
            const r = await prepare(input, "Фото профиля");
            if (r.cancelled) { try { input.value = ""; } catch { /* ignore */ } return; }
            if (r.pass) return original.apply(this, arguments);
            try { input.value = ""; } catch { /* ignore */ }
            return original.call(this, { target: { files: [r.file], value: "" } });
        };
    }

    if (typeof selectGroupAvatarFile === "function") {
        const original = selectGroupAvatarFile;
        selectGroupAvatarFile = async function (input) {
            const files = [...(input?.files || [])];
            const r = await prepare({ files }, "Фото группы");
            try { input.value = ""; } catch { /* ignore */ }
            if (r.cancelled) return;
            return original.call(this, { files: r.pass ? files : [r.file], value: "" });
        };
    }

    if (typeof selectGroupInfoAvatarFile === "function") {
        const original = selectGroupInfoAvatarFile;
        selectGroupInfoAvatarFile = async function (input) {
            const files = [...(input?.files || [])];
            const r = await prepare({ files }, "Фото группы");
            try { input.value = ""; } catch { /* ignore */ }
            if (r.cancelled) return;
            return original.call(this, { files: r.pass ? files : [r.file], value: "" });
        };
    }
})();
