/* ПОЛНОЭКРАННЫЕ СТРАНИЦЫ НА ТЕЛЕФОНЕ — как в Telegram.
   На ширине телефона окна-«страницы» (настройки, профиль, карточки, группа, медиа, устройства…)
   открываются на весь экран: выезжают справа, слева стрелка «назад», закрываются свайпом вправо.
   Вкладки нижней панели (Профиль, Настройки) — полноэкранные вкладки: панель снизу остаётся видна.
   Мелкие окна-действия (удалить, закрепить, переслать, подтверждения) остаются шторками снизу.
   Разметку окон не меняем: модуль только помечает их классами (m-page, m-page-panel, m-back),
   а вид задаёт style.css (блок «ПОЛНОЭКРАННЫЕ СТРАНИЦЫ»). Свайп «назад» работает и в открытом чате:
   вправо из любого места — к списку чатов. */
(function () {

    const PHONE_MAX = 650;
    // Флаг из script-core.js (matchMedia) — без чтения innerWidth на каждое касание.
    const isPhone = () => (typeof isPhoneWidth !== "undefined" ? isPhoneWidth : window.innerWidth <= PHONE_MAX);

    // Окна-страницы → чем закрываются (кнопка «назад» = их собственная кнопка закрытия).
    const PAGES = [
        "settings-backdrop", "profile-screen-backdrop", "contact-modal-backdrop", "info-modal-backdrop",
        "safety-modal-backdrop", "edit-contact-backdrop", "shared-groups-backdrop", "blocked-contacts-backdrop",
        "profile-qr-backdrop", "new-group-backdrop", "group-info-backdrop", "group-member-backdrop",
        "group-admin-backdrop", "group-admins-backdrop", "group-perms-backdrop", "group-bans-backdrop",
        "group-invite-backdrop", "pinned-list-backdrop", "turn-backdrop", "desktop-backdrop", "devices-backdrop",
        "games-backdrop", "story-create-backdrop", "reminders-backdrop", "folder-backdrop", "voice-rooms-backdrop",
        "voice-settings-backdrop", "poll-backdrop", "theme-color-backdrop", "chat-wallpaper-backdrop",
        "shared-media-backdrop", "saved-messages-backdrop"
    ];
    // Вкладки нижней панели: на весь экран, но без «назад» и с видимой панелью снизу.
    // Профиль — не вкладка, а страница поверх «Настроек» (как в Telegram).
    const TAB_PAGES = { "settings-backdrop": "settings" };
    const BACK_SELECTOR = ".settings-close, .safety-modal-close, .shared-media-close, .contact-modal-close, .info-window-close, .group-hero-close, [onclick^='closeProfileScreen']";

    const pages = [];

    function mark() {
        for (const id of PAGES) {
            const backdrop = document.getElementById(id);
            const panel = backdrop?.firstElementChild;
            if (!backdrop || !panel) continue;
            backdrop.classList.add("m-page");
            if (TAB_PAGES[id]) backdrop.classList.add("m-tab-page");
            panel.classList.add("m-page-panel");
            // Своя кнопка закрытия окна — первая в шапке (не вложенных подокон).
            const back = [...panel.querySelectorAll(BACK_SELECTOR)].find((b) => b.closest(".m-page-panel") === panel);
            back?.classList.add("m-back");
            pages.push(backdrop);
        }
        // Порядок слоёв окон не меняется — считаем один раз, а не на каждое касание.
        pages.forEach((b, i) => { b._mZ = (parseInt(getComputedStyle(b).zIndex, 10) || 0) * 1000 + i; });
        document.querySelectorAll(".shared-media-back, #settings-back").forEach((b) => b.classList.add("m-back"));
    }

    const isOpen = (b) => b.classList.contains("open");

    // Верхняя открытая страница: больший z-index, при равных — позже в разметке.
    function topPage() {
        let best = null, bestZ = -Infinity;
        for (const b of pages) {
            if (isOpen(b) && b._mZ > bestZ) { bestZ = b._mZ; best = b; }
        }
        return best;
    }

    const settingsIsSub = () => !!document.querySelector("#settings-backdrop .settings-dialog.is-subpage");

    // Состояние для CSS: открыта ли страница, вкладка ли сверху (тогда видна нижняя панель).
    let lastTab = "";
    function sync() {
        const top = topPage();
        const tab = top && TAB_PAGES[top.id] && !(top.id === "settings-backdrop" && settingsIsSub()) ? TAB_PAGES[top.id] : "";
        document.body.classList.toggle("m-page-open", !!top && isPhone());
        document.body.classList.toggle("m-tab-on", !!tab && isPhone());
        if (tab !== lastTab) {
            lastTab = tab;
            if (tab) document.querySelectorAll(".bottom-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
            else if (typeof syncBottomNavActive === "function") syncBottomNavActive();
        }
    }

    // Переход между вкладками: открытые вкладки-страницы закрываются сразу, без «уезжания».
    window.mPagesCloseTabs = function (except) {
        if (!isPhone()) return;
        const open = Object.keys(TAB_PAGES).map((id) => document.getElementById(id)).filter((b) => b && isOpen(b) && TAB_PAGES[b.id] !== except);
        if (!open.length) return;
        document.body.classList.add("m-instant");
        for (const b of open) {
            if (b.id === "settings-backdrop" && typeof closeSettings === "function") closeSettings();
            if (b.id === "profile-screen-backdrop" && typeof closeProfileScreen === "function") closeProfileScreen(true);
        }
        requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove("m-instant")));
    };

    /* ---- свайп «назад» ---------------------------------------------------------------------------- */

    const COMMIT_RATIO = 0.33, COMMIT_SPEED = 0.45;   // доля ширины экрана или скорость (px/мс)
    let swipe = null;

    // Можно ли элементу ещё прокрутиться влево (тогда свайп вправо — его, а не «назад»).
    function scrollsLeft(el, stop) {
        for (let n = el; n && n !== stop && n !== document.body; n = n.parentElement) {
            if (n.scrollLeft > 0 && n.scrollWidth > n.clientWidth + 2) {
                const ox = getComputedStyle(n).overflowX;
                if (ox === "auto" || ox === "scroll") return true;
            }
        }
        return false;
    }

    function backAction(page) {
        if (page.id === "settings-backdrop" && settingsIsSub()) return () => showSettingsPage("main");
        const btn = page.querySelector(".m-page-panel .m-back:not(#settings-back)");
        return btn ? () => btn.click() : null;
    }

    function chatOverlayOpen() {
        // В чате свайп «назад» — только когда поверх ничего не открыто (меню, эмодзи, реакции…).
        return typeof anyOverlayOpen === "function" && anyOverlayOpen();
    }

    document.addEventListener("touchstart", (event) => {
        swipe = null;
        if (!isPhone() || event.touches.length !== 1) return;
        const target = event.target;
        if (target.closest?.("input[type=range], textarea, [contenteditable=true], video, canvas, .no-swipe-back")) return;
        const t = event.touches[0];
        const page = topPage();
        let kind, el;
        if (page) {
            if (!page.contains(target)) return;
            if (TAB_PAGES[page.id] && !(page.id === "settings-backdrop" && settingsIsSub())) return;   // вкладки — без «назад»
            kind = "page";
            el = page.id === "settings-backdrop" ? page.querySelector("[data-settings-page].is-active") || page.firstElementChild : page.firstElementChild;
        } else if (document.body.classList.contains("chat-selected")) {
            // Открыто ли что-то поверх чата — дорогая проверка, её делаем, только когда жест стал свайпом.
            if (!target.closest?.(".main")) return;
            if (target.closest(".chat-input-bar, .composer, .input-area, .reply-preview")) return;
            kind = "chat";
        } else return;
        swipe = { kind, page, el, target, x0: t.clientX, y0: t.clientY, t0: performance.now(), dx: 0, locked: false };
    }, { passive: true, capture: true });

    document.addEventListener("touchmove", (event) => {
        if (!swipe) return;
        const t = event.touches[0];
        const dx = t.clientX - swipe.x0, dy = t.clientY - swipe.y0;
        if (!swipe.locked) {
            if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
            if (dx <= 0 || Math.abs(dx) < Math.abs(dy) * 1.3) { swipe = null; return; }
            // Свайп вправо: не наш, если под пальцем лента, которую можно листать влево, или поверх чата что-то открыто.
            if (scrollsLeft(swipe.target, swipe.page || document.querySelector(".main"))
                || (swipe.kind === "chat" && chatOverlayOpen())) { swipe = null; return; }
            swipe.locked = true;
            swipe.x0 = t.clientX - 1;   // без рывка на 10 px порога
            if (swipe.kind === "page") swipe.el.classList.add("m-dragging");
            else { document.querySelector(".main")?.classList.add("edge-back-dragging"); document.querySelector(".sidebar")?.classList.add("edge-back-dragging"); }
        }
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
        swipe.dx = Math.max(0, t.clientX - swipe.x0);
        const x = swipe.dx;
        if (swipe.kind === "page") swipe.el.style.setProperty("transform", `translate3d(${x}px,0,0)`, "important");
        else {
            document.querySelector(".main").style.transform = `translateX(${x}px)`;
            document.querySelector(".sidebar").style.transform = `translateX(calc(-100% + ${x}px))`;
        }
    }, { passive: false, capture: true });

    function finish(cancelled) {
        const s = swipe;
        swipe = null;
        if (!s?.locked) return;
        // Защита от «клика» после свайпа ставится после закрытия: само закрытие — тоже нажатие кнопки.
        setTimeout(() => { window.__mSwipeClickGuard = performance.now(); }, 0);
        const speed = s.dx / Math.max(1, performance.now() - s.t0);
        const commit = !cancelled && (s.dx > window.innerWidth * COMMIT_RATIO || (speed > COMMIT_SPEED && s.dx > 40));
        if (s.kind === "page") {
            s.el.classList.remove("m-dragging");
            if (commit && s.page.id === "settings-backdrop") {
                // Подстраница настроек: дотянута — сразу главная страница (её вход уже анимирован).
                s.el.style.removeProperty("transform");
                showSettingsPage("main");
                return;
            }
            s.el.style.removeProperty("transform");   // CSS-переход вернёт или увезёт страницу
            if (commit) backAction(s.page)?.();
        } else {
            const main = document.querySelector(".main"), sidebar = document.querySelector(".sidebar");
            main.classList.remove("edge-back-dragging"); sidebar.classList.remove("edge-back-dragging");
            main.style.transform = ""; sidebar.style.transform = "";
            if (commit && typeof backToChats === "function") backToChats();
        }
    }
    document.addEventListener("touchend", () => finish(false), { capture: true });
    document.addEventListener("touchcancel", () => finish(true), { capture: true });

    // Тап после свайпа не должен нажать кнопку под пальцем.
    document.addEventListener("click", (event) => {
        if (window.__mSwipeClickGuard && performance.now() - window.__mSwipeClickGuard < 350) { event.stopPropagation(); event.preventDefault(); }
    }, true);

    // Карточка собеседника на телефоне (как в Telegram): ник, «о себе», дата и общие группы —
    // не на цветной шапке, а первой белой карточкой под ней (style.css → «КАРТОЧКА СОБЕСЕДНИКА»).
    function phoneProfileLayout() {
        if (typeof IS_PHONE_DEVICE === "undefined" || !IS_PHONE_DEVICE) return;
        const contact = document.querySelector(".info-window .info-window-contact");
        const right = document.querySelector(".info-window .info-window-right");
        if (contact && right && contact.parentElement !== right) right.prepend(contact);
    }

    // Уехавшая за край панель чата «спит» (style.css → .main.panel-asleep, content-visibility:
    // hidden). В ней остаётся лента последнего открытого чата — тысячи элементов, и любая смена
    // экрана (класс на body) пересчитывала их стили и раскладку: ~40 мс на быстром процессоре,
    // ~0,3 с на слабом телефоне. Раскладка спящей панели сохраняется, пробуждение — ~1 мс.
    function sleepHiddenChat() {
        const main = document.querySelector(".main");
        if (!main) return;
        let timer = 0;
        const asleep = () => isPhone() && !document.body.classList.contains("chat-selected");
        const sync = () => {
            clearTimeout(timer);
            if (!asleep()) { if (main.classList.contains("panel-asleep")) main.classList.remove("panel-asleep"); return; }
            if (main.classList.contains("panel-asleep")) return;
            // После анимации ухода панели (.26s в style.css).
            timer = setTimeout(() => { if (asleep()) main.classList.add("panel-asleep"); }, 400);
        };
        new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["class"] });
        window.addEventListener("resize", sync);
        sync();
    }

    function start() {
        phoneProfileLayout();
        sleepHiddenChat();
        mark();
        const observer = new MutationObserver(sync);
        pages.forEach((b) => observer.observe(b, { attributes: true, attributeFilter: ["class"] }));
        const dialog = document.querySelector("#settings-backdrop .settings-dialog");
        if (dialog) observer.observe(dialog, { attributes: true, attributeFilter: ["class"] });
        window.addEventListener("resize", sync);
        sync();
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();

})();
