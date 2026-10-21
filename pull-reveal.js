/* ИСТОРИИ И АРХИВ ПРЯЧУТСЯ, КАК В TELEGRAM.
   Истории по умолчанию свёрнуты в стопку мини-аватаров в шапке (рядом с «KABAN»); архив
   спрятан над списком чатов. Потянуть список вниз (он у самого верха) — сначала разворачивается
   полоса историй (прямо за пальцем), потянуть ещё раз — выезжает строка «Архив». Прокрутили
   список вниз — истории снова сворачиваются в шапку, архив уезжает обратно. На компьютере
   то же колёсиком вверх у начала списка; стопка в шапке — тоже кнопка «показать истории».
   Полоса историй — #stories-bar (stories.js), строка архива — .archive-shortcut
   (script-chats.js, класс is-collapsed ставится при отрисовке по kabanArchiveRevealed). */
let kabanStoriesExpanded = false;
let kabanArchiveRevealed = false;

(function () {

    const list = document.getElementById("real-chat-list");
    const bar = document.getElementById("stories-bar");
    if (!list || !bar) return;

    const archiveRow = () => list.querySelector(".archive-shortcut:not(.archive-back)");
    const hasStories = () => !bar.hidden && !!bar.querySelector(".story-item");
    const vibrate = () => { if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* нет API */ } } };

    function syncStack() {
        const stack = document.getElementById("stories-stack");
        if (!stack) return;
        const items = [...bar.querySelectorAll(".story-item:not(.story-mine.empty)")].slice(0, 3);
        const show = !kabanStoriesExpanded && hasStories() && items.length > 0;
        stack.hidden = !show;
        if (!show) return;
        const html = items.map((item) => {
            const avatar = item.querySelector(".story-avatar");
            const unseen = item.classList.contains("unseen");
            return `<span class="stories-stack-item${unseen ? " unseen" : ""}">${avatar ? avatar.outerHTML : ""}</span>`;
        }).join("");
        if (stack._html !== html) { stack.innerHTML = html; stack._html = html; }
    }

    window.expandStoriesBar = function () {
        if (!hasStories()) return;
        kabanStoriesExpanded = true;
        bar.classList.remove("is-collapsed");
        bar.style.removeProperty("max-height");
        bar.style.removeProperty("opacity");
        syncStack();
    };
    window.collapseStoriesBar = function () {
        kabanStoriesExpanded = false;
        bar.classList.add("is-collapsed");
        bar.style.removeProperty("max-height");
        bar.style.removeProperty("opacity");
        syncStack();
    };
    window.revealArchive = function () {
        const row = archiveRow();
        if (!row) return;
        kabanArchiveRevealed = true;
        row.classList.remove("is-collapsed");
        row.style.removeProperty("height");
        row.style.removeProperty("opacity");
    };
    window.hideArchive = function ({ keepPosition = false } = {}) {
        const row = archiveRow();
        kabanArchiveRevealed = false;
        if (!row) return;
        const height = row.offsetHeight;
        if (keepPosition) row.classList.add("no-anim");
        row.classList.add("is-collapsed");
        row.style.removeProperty("height");
        row.style.removeProperty("opacity");
        // Строка уехала за верх списка — без прыжка ленты.
        if (keepPosition) { list.scrollTop = Math.max(0, list.scrollTop - height); requestAnimationFrame(() => row.classList.remove("no-anim")); }
    };

    // Что откроет следующий «потянуть вниз»: свёрнутые истории, потом спрятанный архив.
    function nextStage() {
        if (typeof isShowingArchivedChats !== "undefined" && isShowingArchivedChats) return null;
        if (!kabanStoriesExpanded && hasStories()) return { kind: "stories", el: bar, full: bar.scrollHeight || 95 };
        const row = archiveRow();
        if (row && row.classList.contains("is-collapsed")) return { kind: "archive", el: row, full: row.scrollHeight || 56 };
        return null;
    }

    /* ---- «потянуть вниз» пальцем ---- */
    let pull = null;
    list.addEventListener("touchstart", (event) => {
        pull = null;
        if (event.touches.length !== 1 || list.scrollTop > 0) return;
        const t = event.touches[0];
        pull = { x0: t.clientX, y0: t.clientY, stage: null, h: 0 };
    }, { passive: true });

    list.addEventListener("touchmove", (event) => {
        if (!pull) return;
        const t = event.touches[0];
        const dy = t.clientY - pull.y0, dx = t.clientX - pull.x0;
        if (!pull.stage) {
            if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
            if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || list.scrollTop > 0) { pull = null; return; }
            pull.stage = nextStage();
            if (!pull.stage) { pull = null; return; }
            pull.stage.el.classList.add("pull-dragging");
            pull.stage.el.classList.remove("is-collapsed");
        }
        if (event.cancelable) event.preventDefault();   // без системной «резинки» и подсветки края
        const full = pull.stage.full;
        const h = Math.max(0, Math.min(full, (dy - 8) * 0.55));
        if ((h >= full * 0.5) !== (pull.h >= full * 0.5)) vibrate();
        pull.h = h;
        const el = pull.stage.el;
        el.style.setProperty(pull.stage.kind === "stories" ? "max-height" : "height", h + "px", "important");
        el.style.opacity = String(Math.min(1, h / full * 1.3));
    }, { passive: false });

    function finishPull() {
        const p = pull;
        pull = null;
        if (!p?.stage) return;
        p.stage.el.classList.remove("pull-dragging");
        const open = p.h >= p.stage.full * 0.5;
        if (p.stage.kind === "stories") { if (open) expandStoriesBar(); else collapseStoriesBar(); }
        else if (open) revealArchive(); else hideArchive();
    }
    list.addEventListener("touchend", finishPull);
    list.addEventListener("touchcancel", finishPull);

    /* ---- колёсико у начала списка (компьютер) ---- */
    let wheelSum = 0, wheelTimer = 0;
    list.addEventListener("wheel", (event) => {
        if (list.scrollTop > 0 || event.deltaY >= 0) { wheelSum = 0; return; }
        wheelSum += event.deltaY;
        clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => { wheelSum = 0; }, 400);
        if (wheelSum > -80) return;
        wheelSum = 0;
        const stage = nextStage();
        if (stage?.kind === "stories") expandStoriesBar();
        else if (stage?.kind === "archive") revealArchive();
    }, { passive: true });

    /* ---- прокрутили вниз — свернуть обратно ---- */
    list.addEventListener("scroll", () => {
        if (pull?.stage) return;
        if (kabanStoriesExpanded && list.scrollTop > 24) collapseStoriesBar();
        if (kabanArchiveRevealed) {
            const row = archiveRow();
            if (row && list.scrollTop > row.offsetHeight + 8) hideArchive({ keepPosition: true });
        }
    }, { passive: true });

    // Полоса историй перерисовывается раз в минуту и при новых историях — стопка в шапке следом.
    new MutationObserver(syncStack).observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    bar.classList.add("is-collapsed");
    syncStack();

})();
