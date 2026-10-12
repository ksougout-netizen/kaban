/* ============================================================================
   ФОТОРЕДАКТОР ПЕРЕД ОТПРАВКОЙ (MediaPreviewModal)

   Открывается, когда картинку бросают в окно чата, вставляют из буфера (Ctrl+V)
   или выбирают через «+ → Фото». Перед отправкой её можно подправить:
     • рисование: карандаш, маркер, стрелка;
     • размытие (пикселизация) — скрыть лица, пароли, личные данные;
     • текст: двигать мышью, менять размер за уголок, «просто текст» или «плашка»;
     • коррекция: яркость, контраст, насыщенность, «Автоулучшение»;
     • поворот на 90° и кадрирование (свободно, 1:1, 4:3, 3:4, 16:9);
     • отмена/повтор (Ctrl+Z / Ctrl+Shift+Z) и «Сбросить всё».

   Устройство. Всё нарисованное хранится ВЕКТОРНО (список слоёв в координатах
   картинки), а не запекается в пиксели, поэтому правки можно двигать, отменять и
   они не портят оригинал. Два холста друг над другом: нижний — фото (+ размытые
   области; к нему применяется CSS-фильтр коррекции), верхний — рисунки, текст,
   рамка выделения и кадрирования (без фильтра: цвета рисунков не «плывут»).
   «Отправить» склеивает всё в один холст → toBlob → существующая отправка
   (sendRealAttachment). Если ничего не менялось, уходит исходный файл без
   пересжатия. Подключается последним (после script-chats / script-messages).
   ========================================================================= */

(function () {

    "use strict";

    const MAX_SIDE = 2400;                     // рабочий размер: больше не нужно, дальше сожмёт sendRealAttachment
    const MIN_CROP = 24;
    const HISTORY_LIMIT = 60;
    const COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#0a84ff", "#bf5af2", "#ffffff", "#1c1c1e"];
    const RATIOS = [
        { id: "free", label: "Свободно", value: null },
        { id: "1:1", label: "1:1", value: 1 },
        { id: "4:3", label: "4:3", value: 4 / 3 },
        { id: "3:4", label: "3:4", value: 3 / 4 },
        { id: "16:9", label: "16:9", value: 16 / 9 }
    ];

    const ICONS = {
        move: '<path d="M5 3.5 18.5 11l-5.6 1.6L10.5 18z"/>',
        pen: '<path d="M4 20l1-4.5L16.8 3.7a2 2 0 0 1 2.8 0l.7.7a2 2 0 0 1 0 2.8L8.5 19z"/><path d="m14.5 6 3.5 3.5"/>',
        marker: '<path d="m9 14.5 6.8-6.8 3 3L12 17.5z"/><path d="m9 14.5-1.2 3.7 3.7-.7M15.8 7.7l1.4-1.4a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1l-1.4 1.4"/><path d="M4 21h9" opacity=".55"/>',
        arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
        blur: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9h16M4 14h16M9 4v16M14 4v16" opacity=".55"/>',
        text: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
        emoji: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14c.9 1.4 2.1 2.1 3.5 2.1s2.6-.7 3.5-2.1M9.2 9.8h.01M14.8 9.8h.01"/>',
        crop: '<path d="M7 3v14h14M3 7h14v14"/>',
        undo: '<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h8.5a5 5 0 0 1 0 10H11"/>',
        redo: '<path d="m15 7 4.5 4.5L15 16"/><path d="M19 11.5h-8.5a5 5 0 0 0 0 10H13"/>',
        rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.6"/><path d="M20 4.5V11h-6.5"/>',
        wand: '<path d="m4 20 11-11M13 4.5v2.5M18.5 7l-1.8 1.8M19.5 12.5H17M10 6.5 12 8.5"/>',
        send: '<path d="M21 3.5 10 14M21 3.5 14.5 20.5l-4.5-6.5L3.5 9.5z"/>'
    };

    const TOOLS = [
        { id: "move", label: "Выбор и перемещение", key: "V" },
        { id: "pen", label: "Карандаш", key: "P" },
        { id: "marker", label: "Маркер", key: "M" },
        { id: "arrow", label: "Стрелка", key: "A" },
        { id: "blur", label: "Размытие", key: "B" },
        { id: "text", label: "Текст", key: "T" },
        { id: "emoji", label: "Эмодзи", key: "E" },
        { id: "crop", label: "Кадрирование", short: "Кадр", key: "C" }
    ];

    const EMOJIS = ["😀", "😂", "🥹", "😍", "😎", "🥳", "😭", "😡", "🤔", "😱", "🙈", "👀",
        "👍", "👎", "👏", "🙏", "💪", "🤝", "🔥", "❤️", "💔", "⭐", "✨", "🎉",
        "🎈", "🎂", "🎁", "🌈", "☀️", "🌙", "⚡", "💯", "✅", "❌", "❗", "❓",
        "➡️", "⬅️", "⬆️", "⬇️", "🔴", "🟢", "🟡", "🔵", "📍", "🚗", "🏠", "☕"];

    const SIZE_RANGE = {
        pen: [1, 30], marker: [6, 60], arrow: [2, 24], blur: [12, 90], text: [12, 120]
    };

    const state = {
        open: false,
        file: null,
        onSend: null,
        orig: null,                       // исходный холст (после ограничения размера)
        base: null,                       // текущая «подложка» (после поворотов / кадрирования)
        layers: [],
        adjust: { b: 100, c: 100, s: 100 },
        tool: "move",
        color: COLORS[0],
        size: { pen: 5, marker: 22, arrow: 6, blur: 34, text: 34 },
        textStyle: "plain",
        selectedId: null,
        nextId: 1,
        history: [],
        hIdx: -1,
        crop: null,
        ratio: null,
        drag: null,
        editing: null,
        busy: false
    };

    let els = null;
    let photoCtx = null;
    let overlayCtx = null;
    let cssScale = 1;
    const pixCache = new WeakMap();
    const scratch = document.createElement("canvas");
    const scratchCtx = scratch.getContext("2d");

    /* ---- вспомогательное ------------------------------------------------- */

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const unit = () => Math.max(0.4, Math.max(state.base?.width || 1000, state.base?.height || 1000) / 1000);

    function svg(name, extra = "") {
        return `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${ICONS[name]}</svg>`;
    }

    function note(text) {
        if (typeof toast === "function") toast(text);
    }

    function luminance(hex) {
        const n = parseInt(hex.slice(1), 16);
        const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

    function makeCanvas(w, h) {
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(w));
        c.height = Math.max(1, Math.round(h));
        return c;
    }

    function isEditableImage(file) {
        return !!file && /^image\/(png|jpe?g|webp|bmp|avif|heic|heif)$/i.test(file.type);
    }

    /* ---- построение окна ------------------------------------------------- */

    function build() {

        if (els) return;

        const root = document.createElement("div");
        root.className = "pe-backdrop";
        root.id = "pe-backdrop";
        root.hidden = true;
        root.innerHTML = `
            <section class="pe-window" role="dialog" aria-modal="true" aria-label="Редактор фото">
                <header class="pe-header">
                    <div class="pe-title">Редактор фото</div>
                    <div class="pe-hist">
                        <button type="button" class="pe-icon-btn" data-pe="undo" title="Отменить (Ctrl+Z)" aria-label="Отменить">${svg("undo")}</button>
                        <button type="button" class="pe-icon-btn" data-pe="redo" title="Повторить (Ctrl+Shift+Z)" aria-label="Повторить">${svg("redo")}</button>
                        <button type="button" class="pe-chip-btn" data-pe="reset" title="Вернуть исходное фото">Сбросить всё</button>
                    </div>
                    <div class="pe-spacer"></div>
                    <button type="button" class="pe-ghost-btn" data-pe="send-original">Отправить без изменений</button>
                    <button type="button" class="pe-close" data-pe="close" aria-label="Закрыть" title="Закрыть (Esc)">×</button>
                </header>

                <div class="pe-body">
                    <nav class="pe-tools" id="pe-tools" aria-label="Инструменты">
                        ${TOOLS.map((t) => `<button type="button" class="pe-tool" data-tool="${t.id}" title="${t.label} (${t.key})" aria-label="${t.label}">${svg(t.id)}<span>${t.short || t.label.split(" ")[0]}</span></button>`).join("")}
                    </nav>

                    <div class="pe-stage" id="pe-stage">
                        <div class="pe-canvas-wrap" id="pe-wrap">
                            <canvas class="pe-photo" id="pe-photo"></canvas>
                            <canvas class="pe-overlay" id="pe-overlay"></canvas>
                            <textarea class="pe-text-input" id="pe-text-input" hidden rows="1" spellcheck="false" aria-label="Текст на фото"></textarea>
                        </div>
                        <div class="pe-loading" id="pe-loading">Открываем фото…</div>
                    </div>

                    <aside class="pe-panel" id="pe-panel">

                        <section class="pe-sec" id="pe-sec-hint">
                            <p class="pe-hint" id="pe-hint"></p>
                        </section>

                        <section class="pe-sec" id="pe-sec-color" hidden>
                            <h3>Цвет</h3>
                            <div class="pe-colors" id="pe-colors">
                                ${COLORS.map((c) => `<button type="button" class="pe-swatch" data-color="${c}" style="--c:${c}" aria-label="Цвет ${c}"></button>`).join("")}
                                <label class="pe-swatch pe-swatch-custom" title="Свой цвет"><input type="color" id="pe-color-custom" value="#ff3b30" aria-label="Свой цвет"></label>
                            </div>
                        </section>

                        <section class="pe-sec" id="pe-sec-size" hidden>
                            <h3><span id="pe-size-label">Толщина</span><output id="pe-size-out"></output></h3>
                            <input type="range" id="pe-size" min="1" max="30" step="1" value="5">
                        </section>

                        <section class="pe-sec" id="pe-sec-textstyle" hidden>
                            <h3>Стиль текста</h3>
                            <div class="pe-seg" id="pe-textstyle">
                                <button type="button" data-style="plain">Текст</button>
                                <button type="button" data-style="bubble">Плашка</button>
                            </div>
                        </section>

                        <section class="pe-sec" id="pe-sec-emoji" hidden>
                            <h3>Эмодзи</h3>
                            <div class="pe-emojis" id="pe-emojis">
                                ${EMOJIS.map((e) => `<button type="button" data-emoji="${e}" aria-label="Эмодзи ${e}">${e}</button>`).join("")}
                            </div>
                        </section>

                        <section class="pe-sec" id="pe-sec-crop" hidden>
                            <h3>Пропорции</h3>
                            <div class="pe-ratios" id="pe-ratios">
                                ${RATIOS.map((r) => `<button type="button" data-ratio="${r.id}">${r.label}</button>`).join("")}
                            </div>
                            <div class="pe-row">
                                <button type="button" class="pe-btn" data-pe="crop-cancel">Отмена</button>
                                <button type="button" class="pe-btn pe-btn-accent" data-pe="crop-apply">Применить</button>
                            </div>
                        </section>

                        <section class="pe-sec pe-sec-adjust">
                            <h3>Коррекция</h3>
                            <label class="pe-slider-row"><span>Яркость</span><output data-out="b">0</output>
                                <input type="range" data-adj="b" min="50" max="150" step="1" value="100"></label>
                            <label class="pe-slider-row"><span>Контраст</span><output data-out="c">0</output>
                                <input type="range" data-adj="c" min="50" max="150" step="1" value="100"></label>
                            <label class="pe-slider-row"><span>Насыщенность</span><output data-out="s">0</output>
                                <input type="range" data-adj="s" min="0" max="200" step="1" value="100"></label>
                            <button type="button" class="pe-btn pe-btn-wide" data-pe="auto">${svg("wand")}Автоулучшение</button>
                        </section>

                        <section class="pe-sec">
                            <h3>Поворот</h3>
                            <button type="button" class="pe-btn pe-btn-wide" data-pe="rotate">${svg("rotate")}Повернуть на 90°</button>
                        </section>

                    </aside>
                </div>

                <footer class="pe-footer">
                    <span class="pe-info" id="pe-info"></span>
                    <input type="text" class="pe-caption" id="pe-caption" maxlength="1024" placeholder="Добавить подпись…" autocomplete="off" aria-label="Подпись к фото">
                    <button type="button" class="pe-send" data-pe="send">${svg("send")}<span>Отправить</span></button>
                </footer>
            </section>`;
        document.body.appendChild(root);

        els = {
            root,
            window: root.querySelector(".pe-window"),
            stage: root.querySelector("#pe-stage"),
            wrap: root.querySelector("#pe-wrap"),
            photo: root.querySelector("#pe-photo"),
            overlay: root.querySelector("#pe-overlay"),
            textInput: root.querySelector("#pe-text-input"),
            loading: root.querySelector("#pe-loading"),
            info: root.querySelector("#pe-info"),
            hint: root.querySelector("#pe-hint"),
            sendBtn: root.querySelector('[data-pe="send"]'),
            undoBtn: root.querySelector('[data-pe="undo"]'),
            redoBtn: root.querySelector('[data-pe="redo"]'),
            size: root.querySelector("#pe-size"),
            sizeOut: root.querySelector("#pe-size-out"),
            sizeLabel: root.querySelector("#pe-size-label"),
            customColor: root.querySelector("#pe-color-custom"),
            caption: root.querySelector("#pe-caption")
        };
        photoCtx = els.photo.getContext("2d");
        overlayCtx = els.overlay.getContext("2d");

        bindEvents();

    }

    /* ---- события интерфейса ---------------------------------------------- */

    function bindEvents() {

        els.root.addEventListener("pointerdown", (event) => {
            if (event.target === els.root) closeEditor();
        });

        els.root.addEventListener("click", (event) => {

            const button = event.target.closest("[data-pe], [data-tool], [data-color], [data-ratio], [data-style], [data-emoji]");
            if (!button) return;

            if (button.dataset.emoji) { addEmoji(button.dataset.emoji); return; }
            if (button.dataset.tool) { setTool(button.dataset.tool); return; }
            if (button.dataset.color) { applyColor(button.dataset.color); return; }
            if (button.dataset.ratio) { setRatio(button.dataset.ratio); return; }
            if (button.dataset.style) { applyTextStyle(button.dataset.style); return; }

            switch (button.dataset.pe) {
                case "close": closeEditor(); break;
                case "undo": undo(); break;
                case "redo": redo(); break;
                case "reset": resetAll(); break;
                case "rotate": rotate90(); break;
                case "auto": autoEnhance(); break;
                case "crop-apply": applyCrop(); break;
                case "crop-cancel": setTool("move"); break;
                case "send": send(false); break;
                case "send-original": send(true); break;
            }

        });

        els.customColor.addEventListener("input", () => applyColor(els.customColor.value, true));

        // Подпись: Enter — отправить (как в поле сообщения), Escape не закрывает окно целиком.
        els.caption.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(false); }
            else if (event.key === "Escape") { event.stopPropagation(); els.caption.blur(); }
        });

        // Ползунки коррекции: фильтр применяется мгновенно, в историю — когда отпустили.
        els.root.querySelectorAll("[data-adj]").forEach((input) => {
            input.addEventListener("input", () => {
                state.adjust[input.dataset.adj] = Number(input.value);
                syncAdjustUI();
                applyFilter();
            });
            input.addEventListener("change", () => record());
            input.addEventListener("dblclick", () => {
                input.value = 100;
                state.adjust[input.dataset.adj] = 100;
                syncAdjustUI();
                applyFilter();
                record();
            });
        });

        els.size.addEventListener("input", () => {
            const value = Number(els.size.value);
            const layer = selectedLayer();
            if (!layer?.emoji) state.size[sizeToolKey()] = value;
            if (layer?.type === "text") { layer.size = value * unit(); render(); }
            syncSizeUI();
        });
        els.size.addEventListener("change", () => { if (selectedLayer()?.type === "text") record(); });

        // Рисование и перетаскивание — на верхнем холсте.
        const overlay = els.overlay;
        overlay.addEventListener("pointerdown", onPointerDown);
        // Без этого браузер после клика отдаёт фокус странице и поле ввода текста сразу закрывается.
        overlay.addEventListener("mousedown", (event) => event.preventDefault());
        overlay.addEventListener("pointermove", onPointerMove);
        overlay.addEventListener("pointerup", onPointerUp);
        overlay.addEventListener("pointercancel", onPointerUp);
        overlay.addEventListener("dblclick", (event) => {
            const layer = hitText(toImage(event));
            if (layer && !layer.emoji) startTextEdit(layer, false);
        });
        overlay.addEventListener("wheel", (event) => {
            const layer = selectedLayer();
            if (layer?.type !== "text") return;
            event.preventDefault();
            layer.size = clamp(layer.size * (event.deltaY < 0 ? 1.06 : 0.94), 8 * unit(), 400 * unit());
            render();
            clearTimeout(bindEvents.wheelTimer);
            bindEvents.wheelTimer = setTimeout(() => { syncSizeUI(); record(); }, 250);
        }, { passive: false });

        // Поле ввода текста
        els.textInput.addEventListener("input", resizeTextInput);
        els.textInput.addEventListener("blur", () => {
            const editing = state.editing;
            // Сразу после клика фокус мог «уйти» — возвращаем, а не закрываем пустое поле.
            if (editing && Date.now() - editing.t0 < 350 && !editing.leave) {
                setTimeout(() => { if (state.editing === editing) els.textInput.focus(); }, 0);
                return;
            }
            finishTextEdit();
        });
        els.textInput.addEventListener("keydown", (event) => {
            if (event.key === "Escape") { event.stopPropagation(); event.preventDefault(); if (state.editing) state.editing.leave = true; finishTextEdit(); }
            else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (state.editing) state.editing.leave = true; finishTextEdit(); }
        });

        window.addEventListener("resize", () => { if (state.open) fit(); });
        document.addEventListener("keydown", onKeyDown, true);

    }

    function onKeyDown(event) {

        if (!state.open) return;

        const typing = event.target === els.textInput || event.target === els.caption;   // в полях ввода горячие клавиши и Ctrl+Z — обычные
        const key = event.key;
        const mod = event.ctrlKey || event.metaKey;

        if (key === "Escape") {
            if (typing) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (state.tool === "crop") setTool("move"); else closeEditor();
            return;
        }
        if (typing) return;

        if (mod && key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
        if (mod && key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
        if ((key === "Delete" || key === "Backspace") && selectedLayer() && event.target.tagName !== "INPUT") {
            event.preventDefault();
            state.layers = state.layers.filter((l) => l.id !== state.selectedId);
            state.selectedId = null;
            record(); syncPanel(); render();
            return;
        }
        if (!mod && !event.altKey && event.target.tagName !== "INPUT") {
            const tool = TOOLS.find((t) => t.key.toLowerCase() === key.toLowerCase());
            if (tool) { event.preventDefault(); setTool(tool.id); }
        }

    }

    /* ---- открытие / закрытие -------------------------------------------- */

    async function openPhotoEditor(file, onSend) {

        build();
        if (state.open) return;

        state.open = true;
        state.file = file;
        state.onSend = onSend;
        state.layers = [];
        state.adjust = { b: 100, c: 100, s: 100 };
        state.selectedId = null;
        state.nextId = 1;
        state.history = [];
        state.hIdx = -1;
        state.crop = null;
        state.drag = null;
        state.editing = null;
        state.tool = "move";
        state.busy = false;

        accentCache = "";
        drawnPhotoKey = "";
        els.caption.value = "";
        els.root.hidden = false;
        els.root.classList.remove("is-visible");
        requestAnimationFrame(() => els.root.classList.add("is-visible"));
        els.loading.hidden = false;
        els.wrap.style.visibility = "hidden";
        els.sendBtn.disabled = true;
        document.body.classList.add("pe-open");

        try {
            const bitmap = await createImageBitmap(file);
            const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
            const canvas = makeCanvas(bitmap.width * scale, bitmap.height * scale);
            canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close?.();
            state.orig = canvas;
            state.base = canvas;
        } catch (error) {
            console.warn("Редактор: не удалось открыть изображение", error);
            closeEditor(true);
            note("Не удалось открыть фото в редакторе — отправляем как есть");
            onSend?.(file);
            return;
        }

        els.loading.hidden = true;
        els.wrap.style.visibility = "";
        els.sendBtn.disabled = false;
        setBase(state.base);
        syncAdjustUI();
        applyFilter();
        record();
        setTool("move");
        els.sendBtn.focus({ preventScroll: true });

    }

    function closeEditor(force) {

        if (!state.open) return;
        if (!force && state.hIdx > 0 && !confirm("Закрыть редактор? Изменения не сохранятся.")) return;

        finishTextEdit(true);
        state.open = false;
        els.root.hidden = true;
        els.root.classList.remove("is-visible");
        document.body.classList.remove("pe-open");
        state.orig = state.base = null;
        state.layers = [];
        state.history = [];
        state.file = null;

    }

    /* ---- холсты и отрисовка ---------------------------------------------- */

    function setBase(canvas) {

        state.base = canvas;
        els.photo.width = els.overlay.width = canvas.width;
        els.photo.height = els.overlay.height = canvas.height;
        drawnPhotoKey = "";
        fit();
        render();

    }

    function fit() {

        if (!state.base) return;
        const availW = Math.max(120, els.stage.clientWidth - 40);
        const availH = Math.max(120, els.stage.clientHeight - 40);
        cssScale = Math.min(availW / state.base.width, availH / state.base.height, 1.6);
        els.wrap.style.width = Math.round(state.base.width * cssScale) + "px";
        els.wrap.style.height = Math.round(state.base.height * cssScale) + "px";
        cssScale = els.wrap.clientWidth / state.base.width || cssScale;
        els.info.textContent = `${state.base.width} × ${state.base.height}`;
        if (state.editing) positionTextInput();
        render();

    }

    function filterCss() {
        const a = state.adjust;
        return `brightness(${a.b}%) contrast(${a.c}%) saturate(${a.s}%)`;
    }

    function applyFilter() {
        const a = state.adjust;
        els.photo.style.filter = (a.b === 100 && a.c === 100 && a.s === 100) ? "" : filterCss();
    }

    function pixelated(base) {
        let small = pixCache.get(base);
        if (!small) {
            const step = Math.max(8, Math.round(Math.max(base.width, base.height) / 60));
            small = makeCanvas(Math.ceil(base.width / step), Math.ceil(base.height / step));
            const ctx = small.getContext("2d");
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(base, 0, 0, small.width, small.height);
            pixCache.set(base, small);
        }
        return small;
    }

    function tracePath(ctx, points) {

        ctx.beginPath();
        if (points.length === 1) {
            ctx.moveTo(points[0][0], points[0][1]);
            ctx.lineTo(points[0][0] + 0.01, points[0][1]);
            return;
        }
        ctx.moveTo(points[0][0], points[0][1]);
        for (let i = 1; i < points.length - 1; i++) {
            const mx = (points[i][0] + points[i + 1][0]) / 2;
            const my = (points[i][1] + points[i + 1][1]) / 2;
            ctx.quadraticCurveTo(points[i][0], points[i][1], mx, my);
        }
        const last = points[points.length - 1];
        ctx.lineTo(last[0], last[1]);

    }

    // Фото + размытые области (пикселизация поверх фото). CSS-фильтр коррекции
    // накладывается на этот холст целиком, поэтому размытие меняется вместе с фото.
    function drawPhotoInto(ctx) {

        const base = state.base;
        ctx.clearRect(0, 0, base.width, base.height);
        ctx.drawImage(base, 0, 0);

        const blurs = state.layers.filter((l) => l.type === "blur");
        if (!blurs.length) return;

        if (scratch.width !== base.width || scratch.height !== base.height) {
            scratch.width = base.width;
            scratch.height = base.height;
        }
        const small = pixelated(base);
        const W = base.width, H = base.height;
        const kx = small.width / W, ky = small.height / H;

        blurs.forEach((layer) => {
            // Работаем только в рамке мазка, а не на всём холсте (до 2400 px): так размытие
            // не тормозит, даже когда мазков много.
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            layer.points.forEach(([x, y]) => {
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            });
            const pad = layer.width / 2 + 2;
            const x0 = Math.max(0, Math.floor(minX - pad)), y0 = Math.max(0, Math.floor(minY - pad));
            const bw = Math.min(W, Math.ceil(maxX + pad)) - x0, bh = Math.min(H, Math.ceil(maxY + pad)) - y0;
            if (bw <= 0 || bh <= 0) return;

            scratchCtx.globalCompositeOperation = "source-over";
            scratchCtx.clearRect(x0, y0, bw, bh);
            scratchCtx.lineCap = scratchCtx.lineJoin = "round";
            scratchCtx.strokeStyle = "#fff";
            scratchCtx.lineWidth = layer.width;
            tracePath(scratchCtx, layer.points);
            scratchCtx.stroke();
            scratchCtx.globalCompositeOperation = "source-in";
            scratchCtx.imageSmoothingEnabled = false;
            scratchCtx.drawImage(small, x0 * kx, y0 * ky, bw * kx, bh * ky, x0, y0, bw, bh);
            ctx.drawImage(scratch, x0, y0, bw, bh, x0, y0, bw, bh);
        });
        scratchCtx.globalCompositeOperation = "source-over";

    }

    function roundRect(ctx, x, y, w, h, r) {
        const radius = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.arcTo(x + w, y, x + w, y + h, radius);
        ctx.arcTo(x + w, y + h, x, y + h, radius);
        ctx.arcTo(x, y + h, x, y, radius);
        ctx.arcTo(x, y, x + w, y, radius);
        ctx.closePath();
    }

    function textFont(layer) {
        if (layer.emoji) return `${layer.size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
        return `600 ${layer.size}px Inter, "Segoe UI", system-ui, -apple-system, sans-serif`;
    }

    function textBox(ctx, layer) {

        ctx.font = textFont(layer);
        const lines = String(layer.text || " ").split("\n");
        const lineHeight = layer.size * 1.25;
        let width = 0;
        lines.forEach((line) => { width = Math.max(width, ctx.measureText(line || " ").width); });
        const pad = layer.style === "bubble" ? layer.size * 0.42 : layer.size * 0.12;
        return {
            lines, lineHeight, width, height: lines.length * lineHeight, pad,
            // рамка в локальных координатах (центр текста — начало координат)
            x: -(width / 2 + pad), y: -(lines.length * lineHeight / 2 + pad * 0.6),
            w: width + pad * 2, h: lines.length * lineHeight + pad * 1.2
        };

    }

    function drawText(ctx, layer) {

        const box = textBox(ctx, layer);
        ctx.save();
        ctx.translate(layer.x, layer.y);
        ctx.rotate(layer.angle || 0);
        ctx.font = textFont(layer);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        let fill = layer.color;
        if (layer.emoji) {
            ctx.shadowColor = "rgba(0,0,0,.28)";
            ctx.shadowBlur = layer.size * 0.06;
        } else if (layer.style === "bubble") {
            ctx.fillStyle = layer.color;
            roundRect(ctx, box.x, box.y, box.w, box.h, layer.size * 0.5);
            ctx.fill();
            fill = luminance(layer.color) > 0.62 ? "#111111" : "#ffffff";
        } else {
            ctx.shadowColor = luminance(layer.color) > 0.55 ? "rgba(0,0,0,.55)" : "rgba(255,255,255,.35)";
            ctx.shadowBlur = layer.size * 0.12;
        }
        ctx.fillStyle = fill;
        box.lines.forEach((line, i) => {
            ctx.fillText(line, 0, -box.height / 2 + box.lineHeight * (i + 0.5));
        });
        ctx.restore();

    }

    function drawArrow(ctx, layer) {

        const { x1, y1, x2, y2, width, color } = layer;
        const length = Math.hypot(x2 - x1, y2 - y1);
        if (length < 1) return;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const head = Math.min(length * 0.7, Math.max(width * 3.4, 16 * unit()));
        const bx = x2 - Math.cos(angle) * head * 0.82;
        const by = y2 - Math.sin(angle) * head * 0.82;

        ctx.save();
        ctx.strokeStyle = ctx.fillStyle = color;
        ctx.lineCap = ctx.lineJoin = "round";
        ctx.shadowColor = "rgba(0,0,0,.28)";
        ctx.shadowBlur = width * 0.8;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - Math.cos(angle - 0.42) * head, y2 - Math.sin(angle - 0.42) * head);
        ctx.lineTo(x2 - Math.cos(angle + 0.42) * head, y2 - Math.sin(angle + 0.42) * head);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

    }

    function drawLayers(ctx, withUI) {

        state.layers.forEach((layer) => {
            if (layer.type === "pen" || layer.type === "marker") {
                ctx.save();
                ctx.lineCap = ctx.lineJoin = "round";
                ctx.strokeStyle = layer.color;
                ctx.lineWidth = layer.width;
                if (layer.type === "marker") ctx.globalAlpha = 0.42;
                tracePath(ctx, layer.points);
                ctx.stroke();
                ctx.restore();
            } else if (layer.type === "arrow") {
                drawArrow(ctx, layer);
            } else if (layer.type === "text") {
                if (withUI && state.editing?.id === layer.id) return;   // его сейчас рисует поле ввода
                drawText(ctx, layer);
            }
        });

    }

    let accentCache = "";
    function accentColor() {
        if (!accentCache) accentCache = getComputedStyle(els.root).getPropertyValue("--pe-accent").trim() || "#3390ec";
        return accentCache;
    }

    function drawSelection(ctx, layer) {

        const box = textBox(ctx, layer);
        const px = 1 / cssScale;
        ctx.save();
        ctx.translate(layer.x, layer.y);
        ctx.rotate(layer.angle || 0);
        ctx.lineWidth = 1.6 * px;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.strokeStyle = "#ffffff";
        ctx.shadowColor = "rgba(0,0,0,.5)";
        ctx.shadowBlur = 3 * px;
        ctx.strokeRect(box.x - 4 * px, box.y - 4 * px, box.w + 8 * px, box.h + 8 * px);
        ctx.setLineDash([]);
        ctx.shadowBlur = 0;
        // уголок масштабирования
        const hx = box.x + box.w + 4 * px, hy = box.y + box.h + 4 * px;
        ctx.fillStyle = "#ffffff";
        ctx.strokeStyle = accentColor();
        ctx.lineWidth = 2.4 * px;
        ctx.beginPath();
        ctx.arc(hx, hy, 8 * px, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

    }

    function drawCropUI(ctx) {

        const r = state.crop;
        if (!r) return;
        const w = state.base.width, h = state.base.height, px = 1 / cssScale;

        ctx.save();
        ctx.fillStyle = "rgba(6,7,9,.66)";
        ctx.fillRect(0, 0, w, r.y);
        ctx.fillRect(0, r.y + r.h, w, h - r.y - r.h);
        ctx.fillRect(0, r.y, r.x, r.h);
        ctx.fillRect(r.x + r.w, r.y, w - r.x - r.w, r.h);

        ctx.strokeStyle = "rgba(255,255,255,.35)";
        ctx.lineWidth = 1 * px;
        ctx.beginPath();
        for (let i = 1; i < 3; i++) {
            ctx.moveTo(r.x + r.w * i / 3, r.y); ctx.lineTo(r.x + r.w * i / 3, r.y + r.h);
            ctx.moveTo(r.x, r.y + r.h * i / 3); ctx.lineTo(r.x + r.w, r.y + r.h * i / 3);
        }
        ctx.stroke();

        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2 * px;
        ctx.strokeRect(r.x, r.y, r.w, r.h);

        ctx.fillStyle = "#ffffff";
        const s = 12 * px;
        cropHandles(r).forEach((hd) => ctx.fillRect(hd.x - s / 2, hd.y - s / 2, s, s));
        ctx.restore();

    }

    // Фото (с размытыми областями) — самая тяжёлая часть: холст до 2400 px. Перерисовываем его
    // ТОЛЬКО когда изменилась подложка (поворот, кадр) или размытые области; смена вкладки,
    // выделение, перетаскивание текста и рисование поверх фото его не трогают.
    const baseIds = new WeakMap();
    let baseIdCounter = 0;
    let drawnPhotoKey = "";

    function photoKey() {
        const base = state.base;
        if (!baseIds.has(base)) baseIds.set(base, ++baseIdCounter);
        let key = baseIds.get(base) + ":" + base.width + "x" + base.height;
        for (const layer of state.layers) {
            if (layer.type === "blur") key += "|" + layer.id + ":" + layer.points.length + ":" + Math.round(layer.width);
        }
        return key;
    }

    function render() {

        if (!state.base) return;
        const key = photoKey();
        if (key !== drawnPhotoKey) {
            drawPhotoInto(photoCtx);
            drawnPhotoKey = key;
        }
        overlayCtx.clearRect(0, 0, els.overlay.width, els.overlay.height);
        drawLayers(overlayCtx, true);
        const selected = selectedLayer();
        if (selected?.type === "text" && !state.editing) drawSelection(overlayCtx, selected);
        if (state.tool === "crop") drawCropUI(overlayCtx);

    }

    /* ---- координаты и попадание ------------------------------------------ */

    function toImage(event) {
        const rect = els.overlay.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * els.overlay.width / rect.width,
            y: (event.clientY - rect.top) * els.overlay.height / rect.height
        };
    }

    function selectedLayer() {
        return state.layers.find((l) => l.id === state.selectedId) || null;
    }

    function toLocal(layer, p) {
        const dx = p.x - layer.x, dy = p.y - layer.y;
        const cos = Math.cos(-(layer.angle || 0)), sin = Math.sin(-(layer.angle || 0));
        return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    }

    function hitText(p) {
        const slack = 6 / cssScale;
        for (let i = state.layers.length - 1; i >= 0; i--) {
            const layer = state.layers[i];
            if (layer.type !== "text") continue;
            const box = textBox(overlayCtx, layer);
            const l = toLocal(layer, p);
            if (l.x >= box.x - slack && l.x <= box.x + box.w + slack && l.y >= box.y - slack && l.y <= box.y + box.h + slack) return layer;
        }
        return null;
    }

    function hitHandle(layer, p) {
        const box = textBox(overlayCtx, layer);
        const l = toLocal(layer, p);
        const px = 1 / cssScale;
        return Math.hypot(l.x - (box.x + box.w + 4 * px), l.y - (box.y + box.h + 4 * px)) <= 14 * px;
    }

    function cropHandles(r) {
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2, x2 = r.x + r.w, y2 = r.y + r.h;
        return [
            { id: "nw", x: r.x, y: r.y }, { id: "n", x: cx, y: r.y }, { id: "ne", x: x2, y: r.y },
            { id: "e", x: x2, y: cy }, { id: "se", x: x2, y: y2 }, { id: "s", x: cx, y: y2 },
            { id: "sw", x: r.x, y: y2 }, { id: "w", x: r.x, y: cy }
        ];
    }

    function cropHit(p) {
        const r = state.crop;
        if (!r) return null;
        const tol = 16 / cssScale;
        const handle = cropHandles(r).find((h) => Math.hypot(h.x - p.x, h.y - p.y) <= tol);
        if (handle) return handle.id;
        if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return "move";
        return null;
    }

    const CROP_CURSORS = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move" };

    /* ---- указатель -------------------------------------------------------- */

    function onPointerDown(event) {

        if (!state.base || (event.button !== undefined && event.button > 0)) return;
        if (state.editing) finishTextEdit();

        const p = toImage(event);
        const tool = state.tool;
        try { els.overlay.setPointerCapture(event.pointerId); } catch { /* указатель уже не активен */ }

        if (tool === "crop") {
            const handle = cropHit(p);
            if (handle) state.drag = { mode: "crop", handle, start: p, rect: { ...state.crop } };
            return;
        }

        if (tool === "move" || tool === "text") {
            const selected = selectedLayer();
            if (selected?.type === "text" && hitHandle(selected, p)) {
                state.drag = { mode: "scale", id: selected.id, d0: Math.max(1, Math.hypot(p.x - selected.x, p.y - selected.y)), size0: selected.size };
                return;
            }
            const hit = hitText(p);
            if (hit) {
                select(hit.id);
                state.drag = { mode: "move", id: hit.id, ox: p.x - hit.x, oy: p.y - hit.y, moved: false };
                render();
                return;
            }
            if (tool === "text") { createText(p); return; }
            select(null);
            render();
            return;
        }

        select(null);
        const width = state.size[tool] * unit();

        if (tool === "pen" || tool === "marker" || tool === "blur") {
            const layer = { id: state.nextId++, type: tool, color: state.color, width, points: [[p.x, p.y]] };
            state.layers.push(layer);
            state.drag = { mode: "draw", id: layer.id };
        } else if (tool === "arrow") {
            const layer = { id: state.nextId++, type: "arrow", color: state.color, width, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
            state.layers.push(layer);
            state.drag = { mode: "arrow", id: layer.id };
        }
        render();

    }

    function onPointerMove(event) {

        if (!state.base) return;
        const p = toImage(event);
        const drag = state.drag;

        if (!drag) {
            // подсказка курсором
            if (state.tool === "crop") {
                const h = cropHit(p);
                els.overlay.style.cursor = h ? CROP_CURSORS[h] : "default";
            } else if (state.tool === "move" || state.tool === "text") {
                const selected = selectedLayer();
                if (selected?.type === "text" && hitHandle(selected, p)) els.overlay.style.cursor = "nwse-resize";
                else els.overlay.style.cursor = hitText(p) ? "move" : (state.tool === "text" ? "text" : "default");
            }
            return;
        }

        const layer = state.layers.find((l) => l.id === drag.id);

        if (drag.mode === "draw" && layer) {
            const last = layer.points[layer.points.length - 1];
            if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5 / cssScale) layer.points.push([p.x, p.y]);
        } else if (drag.mode === "arrow" && layer) {
            if (event.shiftKey) {
                const angle = Math.round(Math.atan2(p.y - layer.y1, p.x - layer.x1) / (Math.PI / 4)) * (Math.PI / 4);
                const length = Math.hypot(p.x - layer.x1, p.y - layer.y1);
                layer.x2 = layer.x1 + Math.cos(angle) * length;
                layer.y2 = layer.y1 + Math.sin(angle) * length;
            } else { layer.x2 = p.x; layer.y2 = p.y; }
        } else if (drag.mode === "move" && layer) {
            layer.x = clamp(p.x - drag.ox, 0, state.base.width);
            layer.y = clamp(p.y - drag.oy, 0, state.base.height);
            drag.moved = true;
        } else if (drag.mode === "scale" && layer) {
            layer.size = clamp(drag.size0 * Math.hypot(p.x - layer.x, p.y - layer.y) / drag.d0, 8 * unit(), 400 * unit());
        } else if (drag.mode === "crop") {
            state.crop = cropDrag(drag.handle, drag.start, drag.rect, p);
        }
        render();

    }

    function onPointerUp(event) {

        const drag = state.drag;
        if (!drag) return;
        state.drag = null;
        try { els.overlay.releasePointerCapture(event.pointerId); } catch { /* уже отпущен */ }

        const layer = state.layers.find((l) => l.id === drag.id);

        if (drag.mode === "draw" && layer) {
            if (layer.points.length === 1) layer.points.push([layer.points[0][0] + 0.01, layer.points[0][1]]);
            record();
        } else if (drag.mode === "arrow" && layer) {
            if (Math.hypot(layer.x2 - layer.x1, layer.y2 - layer.y1) < 8 / cssScale) {
                state.layers = state.layers.filter((l) => l !== layer);
            } else record();
        } else if (drag.mode === "move" && drag.moved) {
            record();
        } else if (drag.mode === "scale") {
            syncSizeUI();
            record();
        }
        render();

    }

    /* ---- текст ------------------------------------------------------------- */

    // Эмодзи — тот же слой, что и текст (двигается, масштабируется уголком и колесом), только без цвета и стиля.
    function addEmoji(char) {

        if (!state.base) return;
        const layer = {
            id: state.nextId++, type: "text", emoji: true, text: char,
            x: state.base.width / 2 + (state.layers.length % 5) * 18 * unit(),
            y: state.base.height / 2 + (state.layers.length % 5) * 18 * unit(),
            size: 90 * unit(), color: "#ffffff", style: "plain", angle: 0
        };
        state.layers.push(layer);
        setTool("move");
        select(layer.id);
        record();
        syncPanel();
        render();

    }

    function createText(p) {

        const layer = {
            id: state.nextId++, type: "text", text: "", x: p.x, y: p.y,
            size: state.size.text * unit(), color: state.color, style: state.textStyle, angle: 0
        };
        state.layers.push(layer);
        select(layer.id);
        startTextEdit(layer, true);

    }

    function startTextEdit(layer, isNew) {

        select(layer.id);
        state.editing = { id: layer.id, isNew, before: layer.text, t0: Date.now() };
        const input = els.textInput;
        input.hidden = false;
        input.value = layer.text;
        positionTextInput();
        render();
        const focusInput = () => { if (state.editing?.id === layer.id) { input.focus({ preventScroll: true }); input.select(); } };
        focusInput();
        setTimeout(focusInput, 0);           // и после того, как завершится обработка нажатия мыши
        setTimeout(focusInput, 120);

    }

    function positionTextInput() {

        const layer = state.layers.find((l) => l.id === state.editing?.id);
        if (!layer) return;
        const input = els.textInput;
        const bubble = layer.style === "bubble";
        input.style.left = layer.x * cssScale + "px";
        input.style.top = layer.y * cssScale + "px";
        input.style.fontSize = layer.size * cssScale + "px";
        input.style.lineHeight = "1.25";
        input.style.transform = `translate(-50%, -50%) rotate(${layer.angle || 0}rad)`;
        input.style.color = bubble ? (luminance(layer.color) > 0.62 ? "#111111" : "#ffffff") : layer.color;
        input.style.background = bubble ? layer.color : "transparent";
        input.style.padding = (bubble ? layer.size * 0.42 * 0.6 : layer.size * 0.12 * 0.6) * cssScale + "px " + (bubble ? layer.size * 0.42 : layer.size * 0.12) * cssScale + "px";
        input.style.borderRadius = bubble ? layer.size * 0.5 * cssScale + "px" : "6px";
        resizeTextInput();

    }

    function resizeTextInput() {

        const layer = state.layers.find((l) => l.id === state.editing?.id);
        if (!layer) return;
        const input = els.textInput;
        const lines = input.value.split("\n");
        input.rows = Math.max(1, lines.length);
        overlayCtx.font = textFont(layer);
        let width = 0;
        lines.forEach((line) => { width = Math.max(width, overlayCtx.measureText(line || " ").width); });
        input.style.width = Math.max(layer.size * 1.2, width + layer.size * 0.5) * cssScale + "px";
        input.style.height = "auto";
        input.style.height = input.scrollHeight + "px";

    }

    function finishTextEdit(silent) {

        const editing = state.editing;
        if (!editing) return;
        state.editing = null;
        const layer = state.layers.find((l) => l.id === editing.id);
        const value = els.textInput.value.replace(/\s+$/, "");
        els.textInput.hidden = true;
        if (!layer) return;

        if (!value) {
            state.layers = state.layers.filter((l) => l !== layer);
            state.selectedId = null;
            if (!editing.isNew && !silent) record();
        } else {
            layer.text = value;
            if (!silent && (editing.isNew || value !== editing.before)) record();
        }
        syncPanel();
        render();

    }

    /* ---- выбор слоя, панель, инструменты ---------------------------------- */

    function select(id) {
        if (state.selectedId === id) return;
        state.selectedId = id;
        const layer = selectedLayer();
        if (layer?.type === "text" && !layer.emoji) {
            state.color = layer.color;
            state.textStyle = layer.style;
            state.size.text = Math.round(layer.size / unit());
        }
        syncPanel();
    }

    function sizeToolKey() {
        return state.tool === "move" ? "text" : state.tool;
    }

    function setTool(tool) {

        finishTextEdit();
        if (tool !== "crop" && state.tool === "crop") state.crop = null;
        state.tool = tool;
        if (tool !== "move" && tool !== "text") state.selectedId = null;
        if (tool === "crop") {
            state.crop = { x: 0, y: 0, w: state.base.width, h: state.base.height };
            state.ratio = null;
        }
        els.overlay.style.cursor = tool === "move" ? "default" : tool === "text" ? "text" : tool === "crop" ? "default" : "crosshair";
        syncPanel();
        render();

    }

    const HINTS = {
        move: "Нажмите на текст, чтобы передвинуть его, изменить размер за белый уголок или цвет и стиль. Двойной клик — править.",
        pen: "Рисуйте по фото. Цвет и толщину выберите ниже.",
        marker: "Полупрозрачный маркер — подчеркнуть или выделить важное.",
        arrow: "Зажмите, потяните и отпустите. Shift — ровно под 45°.",
        blur: "Проведите кистью по лицам, паролям, номерам — область скроется пикселизацией.",
        text: "Нажмите на фото и введите текст. Его можно двигать и масштабировать.",
        emoji: "Нажмите на эмодзи — оно появится на фото. Потом перетащите его и измените размер белым уголком или колесом мыши.",
        crop: "Потяните рамку за края и углы. Пропорции можно зафиксировать."
    };

    function syncPanel() {

        const tool = state.tool;
        const selected = selectedLayer();
        const emojiSelected = !!selected?.emoji;
        const textMode = tool === "text" || (tool === "move" && selected?.type === "text");
        const colorMode = (textMode && !emojiSelected) || tool === "pen" || tool === "marker" || tool === "arrow";
        const sizeMode = textMode || tool === "pen" || tool === "marker" || tool === "arrow" || tool === "blur";

        els.root.querySelectorAll(".pe-tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
        els.hint.textContent = HINTS[tool] || "";
        els.root.querySelector("#pe-sec-color").hidden = !colorMode;
        els.root.querySelector("#pe-sec-size").hidden = !sizeMode;
        els.root.querySelector("#pe-sec-textstyle").hidden = !(textMode && !emojiSelected);
        els.root.querySelector("#pe-sec-emoji").hidden = tool !== "emoji";
        els.root.querySelector("#pe-sec-crop").hidden = tool !== "crop";

        const key = sizeToolKey();
        const [lo, hi] = SIZE_RANGE[key] || SIZE_RANGE.pen;
        els.size.min = lo;
        els.size.max = hi;
        // Для выделенного текста/эмодзи ползунок показывает его настоящий размер.
        els.size.value = (tool === "move" || tool === "text") && selected?.type === "text"
            ? Math.round(selected.size / unit())
            : (state.size[key] ?? lo);
        els.sizeLabel.textContent = emojiSelected ? "Размер эмодзи" : key === "text" ? "Размер текста" : key === "blur" ? "Размер кисти" : "Толщина";
        syncSizeUI();

        els.root.querySelectorAll(".pe-swatch[data-color]").forEach((s) => s.classList.toggle("active", s.dataset.color.toLowerCase() === state.color.toLowerCase()));
        els.root.querySelector(".pe-swatch-custom").classList.toggle("active", !COLORS.some((c) => c.toLowerCase() === state.color.toLowerCase()));
        els.root.querySelectorAll("#pe-textstyle button").forEach((b) => b.classList.toggle("active", b.dataset.style === state.textStyle));
        els.root.querySelectorAll("#pe-ratios button").forEach((b) => b.classList.toggle("active", b.dataset.ratio === (RATIOS.find((r) => r.value === state.ratio)?.id || "free")));
        updateHistButtons();

    }

    function syncSizeUI() {
        els.sizeOut.textContent = els.size.value;
        const pct = (els.size.value - els.size.min) / (els.size.max - els.size.min) * 100;
        els.size.style.setProperty("--p", pct + "%");
    }

    function syncAdjustUI() {
        els.root.querySelectorAll("[data-adj]").forEach((input) => {
            const v = state.adjust[input.dataset.adj];
            input.value = v;
            const pct = (v - input.min) / (input.max - input.min) * 100;
            input.style.setProperty("--p", pct + "%");
            const out = els.root.querySelector(`[data-out="${input.dataset.adj}"]`);
            if (out) out.textContent = (v - 100 > 0 ? "+" : "") + (v - 100);
        });
    }

    function applyColor(color, custom) {
        state.color = color;
        const layer = selectedLayer();
        if (layer && layer.type === "text" && !layer.emoji) { layer.color = color; record(); }
        if (state.editing) positionTextInput();
        syncPanel();
        render();
        void custom;
    }

    function applyTextStyle(style) {
        state.textStyle = style;
        const layer = selectedLayer();
        if (layer?.type === "text" && !layer.emoji) { layer.style = style; record(); }
        if (state.editing) positionTextInput();
        syncPanel();
        render();
    }

    /* ---- кадрирование и поворот ------------------------------------------- */

    function constrainCrop(r, ratio, anchor) {

        const W = state.base.width, H = state.base.height;
        let { x, y, w, h } = r;
        if (ratio) {
            if (w / h > ratio) w = h * ratio; else h = w / ratio;
            const maxScale = Math.min(W / w, H / h, 1);
            w *= maxScale; h *= maxScale;
            if (anchor) { x = anchor.x - (anchor.fx ? w : 0); y = anchor.y - (anchor.fy ? h : 0); }
        }
        w = clamp(w, MIN_CROP, W); h = clamp(h, MIN_CROP, H);
        x = clamp(x, 0, W - w); y = clamp(y, 0, H - h);
        return { x, y, w, h };

    }

    function cropDrag(handle, p0, r0, p) {

        const W = state.base.width, H = state.base.height;
        const dx = p.x - p0.x, dy = p.y - p0.y;
        if (handle === "move") {
            return { x: clamp(r0.x + dx, 0, W - r0.w), y: clamp(r0.y + dy, 0, H - r0.h), w: r0.w, h: r0.h };
        }

        let l = r0.x, t = r0.y, r = r0.x + r0.w, b = r0.y + r0.h;
        if (handle.includes("w")) l = clamp(r0.x + dx, 0, r - MIN_CROP);
        if (handle.includes("e")) r = clamp(r0.x + r0.w + dx, l + MIN_CROP, W);
        if (handle.includes("n")) t = clamp(r0.y + dy, 0, b - MIN_CROP);
        if (handle.includes("s")) b = clamp(r0.y + r0.h + dy, t + MIN_CROP, H);

        const ratio = state.ratio;
        if (!ratio) return { x: l, y: t, w: r - l, h: b - t };

        // С фиксированными пропорциями: ведущая сторона — ширина (для боковых граней — высота).
        let w = r - l, h = b - t;
        if (handle === "n" || handle === "s") w = h * ratio; else h = w / ratio;
        const fx = handle.includes("w"), fy = handle.includes("n");
        const ax = handle === "n" || handle === "s" ? (r0.x + r0.w / 2) : (fx ? r : l);
        const ay = handle === "e" || handle === "w" ? (r0.y + r0.h / 2) : (fy ? b : t);
        let nx = handle === "n" || handle === "s" ? ax - w / 2 : (fx ? ax - w : ax);
        let ny = handle === "e" || handle === "w" ? ay - h / 2 : (fy ? ay - h : ay);
        // не выходить за картинку
        const scale = Math.min(1, W / w, H / h);
        w *= scale; h *= scale;
        nx = clamp(nx, 0, W - w); ny = clamp(ny, 0, H - h);
        return { x: nx, y: ny, w, h };

    }

    function setRatio(id) {
        const ratio = RATIOS.find((r) => r.id === id)?.value ?? null;
        state.ratio = ratio;
        if (state.crop && ratio) {
            const c = state.crop;
            const centre = { x: c.x + c.w / 2, y: c.y + c.h / 2 };
            let w = c.w, h = c.h;
            if (w / h > ratio) w = h * ratio; else h = w / ratio;
            state.crop = constrainCrop({ x: centre.x - w / 2, y: centre.y - h / 2, w, h }, ratio, null);
        }
        syncPanel();
        render();
    }

    function transformLayers(mapPoint, angleDelta) {

        state.layers.forEach((layer) => {
            if (layer.points) layer.points = layer.points.map(([x, y]) => { const q = mapPoint(x, y); return [q.x, q.y]; });
            if (layer.type === "arrow") {
                const a = mapPoint(layer.x1, layer.y1), b = mapPoint(layer.x2, layer.y2);
                layer.x1 = a.x; layer.y1 = a.y; layer.x2 = b.x; layer.y2 = b.y;
            }
            if (layer.type === "text") {
                const q = mapPoint(layer.x, layer.y);
                layer.x = q.x; layer.y = q.y;
                layer.angle = (layer.angle || 0) + angleDelta;
            }
        });

    }

    function rotate90() {

        if (!state.base || state.busy) return;
        finishTextEdit();
        if (state.tool === "crop") state.crop = null;
        const old = state.base;
        const next = makeCanvas(old.height, old.width);
        const ctx = next.getContext("2d");
        ctx.translate(old.height, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(old, 0, 0);
        transformLayers((x, y) => ({ x: old.height - y, y: x }), Math.PI / 2);
        setBase(next);
        if (state.tool === "crop") { state.crop = { x: 0, y: 0, w: next.width, h: next.height }; }
        record();
        syncPanel();

    }

    function applyCrop() {

        const r = state.crop;
        if (!r || !state.base) return;
        const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
        const next = makeCanvas(w, h);
        next.getContext("2d").drawImage(state.base, x, y, w, h, 0, 0, w, h);
        transformLayers((px, py) => ({ x: px - x, y: py - y }), 0);
        state.crop = null;
        state.tool = "move";
        setBase(next);
        record();
        setTool("move");

    }

    /* ---- коррекция -------------------------------------------------------- */

    function autoEnhance() {

        if (!state.base) return;
        const size = 96;
        const scale = size / Math.max(state.base.width, state.base.height);
        const probe = makeCanvas(Math.max(1, state.base.width * scale), Math.max(1, state.base.height * scale));
        const ctx = probe.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(state.base, 0, 0, probe.width, probe.height);
        const { data } = ctx.getImageData(0, 0, probe.width, probe.height);

        let sum = 0, sum2 = 0, sat = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 200) continue;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            sum += lum; sum2 += lum * lum; sat += max ? (max - min) / max : 0; n++;
        }
        if (!n) return;
        const mean = sum / n;
        const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
        const meanSat = sat / n;

        // Среднюю яркость тянем к ~120, контраст — к разбросу ~58, насыщенность подтягиваем мягко.
        const b = clamp(Math.round(120 / Math.max(mean, 25) * 100), 78, 140);
        const c = clamp(Math.round(58 / Math.max(std * b / 100, 18) * 100), 92, 148);
        const s = meanSat < 0.22 ? 118 : meanSat > 0.62 ? 94 : 108;

        state.adjust = { b, c, s };
        syncAdjustUI();
        applyFilter();
        record();
        note("Автоулучшение применено");

    }

    // Запасной путь для браузеров без ctx.filter: те же формулы, что у CSS-фильтров.
    function adjustPixels(ctx, w, h) {

        const { b, c, s } = state.adjust;
        const image = ctx.getImageData(0, 0, w, h);
        const d = image.data;
        const br = b / 100, ct = c / 100, sa = s / 100;
        const m = [
            0.213 + 0.787 * sa, 0.715 - 0.715 * sa, 0.072 - 0.072 * sa,
            0.213 - 0.213 * sa, 0.715 + 0.285 * sa, 0.072 - 0.072 * sa,
            0.213 - 0.213 * sa, 0.715 - 0.715 * sa, 0.072 + 0.928 * sa
        ];
        for (let i = 0; i < d.length; i += 4) {
            let r = d[i] * br, g = d[i + 1] * br, bl = d[i + 2] * br;
            r = (r - 127.5) * ct + 127.5; g = (g - 127.5) * ct + 127.5; bl = (bl - 127.5) * ct + 127.5;
            const nr = m[0] * r + m[1] * g + m[2] * bl;
            const ng = m[3] * r + m[4] * g + m[5] * bl;
            const nb = m[6] * r + m[7] * g + m[8] * bl;
            d[i] = clamp(nr, 0, 255); d[i + 1] = clamp(ng, 0, 255); d[i + 2] = clamp(nb, 0, 255);
        }
        ctx.putImageData(image, 0, 0);

    }

    /* ---- история ----------------------------------------------------------- */

    function snapshot() {
        return { base: state.base, layers: JSON.stringify(state.layers), adjust: { ...state.adjust }, nextId: state.nextId };
    }

    function record() {
        state.history = state.history.slice(0, state.hIdx + 1);
        state.history.push(snapshot());
        if (state.history.length > HISTORY_LIMIT) state.history.shift();
        state.hIdx = state.history.length - 1;
        updateHistButtons();
    }

    function restore(snap) {
        finishTextEdit(true);
        state.layers = JSON.parse(snap.layers);
        state.adjust = { ...snap.adjust };
        state.selectedId = null;
        state.crop = null;
        if (state.tool === "crop") state.tool = "move";
        if (state.base !== snap.base) setBase(snap.base);
        syncAdjustUI();
        applyFilter();
        syncPanel();
        render();
    }

    function undo() {
        if (state.hIdx <= 0) return;
        state.hIdx--;
        restore(state.history[state.hIdx]);
        updateHistButtons();
    }

    function redo() {
        if (state.hIdx >= state.history.length - 1) return;
        state.hIdx++;
        restore(state.history[state.hIdx]);
        updateHistButtons();
    }

    function resetAll() {
        if (state.hIdx <= 0 && !state.layers.length) return;
        finishTextEdit(true);
        state.layers = [];
        state.adjust = { b: 100, c: 100, s: 100 };
        state.selectedId = null;
        state.crop = null;
        if (state.tool === "crop") state.tool = "move";
        if (state.base !== state.orig) setBase(state.orig);
        syncAdjustUI();
        applyFilter();
        record();
        syncPanel();
        render();
        note("Все изменения сброшены");
    }

    function updateHistButtons() {
        if (!els) return;
        els.undoBtn.disabled = state.hIdx <= 0;
        els.redoBtn.disabled = state.hIdx >= state.history.length - 1;
    }

    /* ---- экспорт и отправка ------------------------------------------------ */

    function exportCanvas() {

        const w = state.base.width, h = state.base.height;
        const out = makeCanvas(w, h);
        const ctx = out.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);

        const photo = makeCanvas(w, h);
        drawPhotoInto(photo.getContext("2d"));

        const a = state.adjust;
        const adjusted = a.b !== 100 || a.c !== 100 || a.s !== 100;
        if (adjusted && "filter" in CanvasRenderingContext2D.prototype) {
            ctx.filter = filterCss();
            ctx.drawImage(photo, 0, 0);
            ctx.filter = "none";
        } else {
            ctx.drawImage(photo, 0, 0);
            if (adjusted) adjustPixels(ctx, w, h);
        }

        drawLayers(ctx, false);
        return out;

    }

    async function send(asOriginal) {

        if (state.busy || !state.base) return;
        finishTextEdit();

        const onSend = state.onSend;
        const original = state.file;

        // Ничего не менялось (или выбрано «без изменений») — уходит исходный файл, без пересжатия.
        const caption = els.caption.value.trim();

        if (asOriginal || state.hIdx <= 0) {
            closeEditor(true);
            onSend?.(original, { caption });
            return;
        }

        state.busy = true;
        els.sendBtn.disabled = true;
        els.sendBtn.querySelector("span").textContent = "Готовим…";
        try {
            const canvas = exportCanvas();
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
            if (!blob) throw new Error("не удалось собрать изображение");
            const baseName = (original?.name || "photo").replace(/\.[^.]+$/, "") || "photo";
            const file = new File([blob], `${baseName}-edited.jpg`, { type: "image/jpeg" });
            closeEditor(true);
            onSend?.(file, { caption });
        } catch (error) {
            console.warn("Редактор: экспорт не удался", error);
            note("Не удалось собрать изображение: " + (error?.message || error));
        } finally {
            state.busy = false;
            if (els) {
                els.sendBtn.disabled = false;
                els.sendBtn.querySelector("span").textContent = "Отправить";
            }
        }

    }

    /* ---- подключение к чату ------------------------------------------------- */

    function canEditHere() {
        return typeof currentChatId !== "undefined" && !!currentChatId
            && !(typeof currentChatIsSecret !== "undefined" && currentChatIsSecret)
            && typeof sendRealAttachment === "function"
            && !state.open;
    }

    function openForChat(file) {
        const targetChat = currentChatId;
        openPhotoEditor(file, (final, extra) => {
            // Пока редактировали, могли переключить чат — шлём туда, откуда открывали.
            if (currentChatId !== targetChat && typeof openRealChat === "function") {
                openRealChat(targetChat).then(() => sendRealAttachment(final, "image", extra)).catch(() => sendRealAttachment(final, "image", extra));
            } else sendRealAttachment(final, "image", extra);
        });
    }

    // Выбор через «+ → Фото» и перетаскивание файла в окно (его обработчик зовёт handleAttachFile).
    if (typeof handleAttachFile === "function") {
        const original = handleAttachFile;
        handleAttachFile = function (input, kind) {
            const file = input?.files?.[0];
            if (kind === "media" && isEditableImage(file) && canEditHere()) {
                try { input.value = ""; } catch { /* у перетаскивания input — простой объект */ }
                if (typeof closeAttachMenu === "function") closeAttachMenu();
                openForChat(file);
                return;
            }
            return original.apply(this, arguments);
        };
    }

    // Ctrl+V: картинка из буфера (скриншот, скопированное изображение).
    document.addEventListener("paste", (event) => {

        if (state.open || !document.body.classList.contains("chat-selected") || !canEditHere()) return;
        const data = event.clipboardData;
        if (!data) return;

        const text = data.getData("text/plain");
        const item = [...(data.items || [])].find((i) => i.kind === "file" && /^image\//i.test(i.type));
        if (!item || (text && text.trim())) return;          // обычный текст вставляем как обычно

        const file = item.getAsFile();
        if (!isEditableImage(file)) return;
        event.preventDefault();
        const named = file.name && file.name !== "image.png" ? file
            : new File([file], `screenshot-${Date.now()}.${file.type.split("/")[1] || "png"}`, { type: file.type });
        openForChat(named);

    });

    window.openPhotoEditor = openPhotoEditor;
    window.KabanPhotoEditor = {
        open: openPhotoEditor,
        // Для проверок: состояние и экспорт без отправки.
        _state: state,
        _export: () => exportCanvas(),
        _setTool: (t) => setTool(t),
        _record: record,
        _rotate: rotate90,
        _setRatio: (id) => setRatio(id),
        _applyCrop: applyCrop,
        _auto: autoEnhance,
        _undo: undo,
        _redo: redo,
        _reset: resetAll
    };

})();
