/* ============================================================================
   ИСТОРИИ (24 часа). Лента кружков над списком чатов, полноэкранный просмотр с
   полосками прогресса (тап справа/слева — дальше/назад, удержание — пауза,
   ←/→/Esc с клавиатуры), создание: фото с подписью или текстовая открытка на
   цветном фоне. Данные — таблицы stories/story_views (schema.sql → «ИСТОРИИ»);
   пока SQL не выполнен, getStoryFeed() возвращает null и лента не показывается.
   ========================================================================= */

const STORY_DURATION_MS = 5500;
const STORY_BGS = [
    "linear-gradient(160deg,#7c5cff,#22d3ee)",
    "linear-gradient(160deg,#ff7a59,#ff3d8b)",
    "linear-gradient(160deg,#0ea5e9,#1d4ed8)",
    "linear-gradient(160deg,#22c55e,#0f766e)",
    "linear-gradient(160deg,#f472b6,#a78bfa)",
    "linear-gradient(160deg,#f59e0b,#dc2626)",
    "linear-gradient(160deg,#6366f1,#0f172a)",
    "linear-gradient(160deg,#334155,#0f172a)"
];

let storyFeed = null;          // { stories, seen:Set } либо null, если историй нет в этой базе
let storyGroups = [];          // [{ user, stories, unseen }]
let storyRefreshTimer = null;
let storyViewer = null;        // { queue, index, userId, paused }
let storyCreateBg = STORY_BGS[0];
let storyCreateFile = null;
let storyCreateKind = "image";

let storiesUnavailable = false; // в базе нет таблицы историй (SQL-блок не выполнен)

function startStories() {
    stopStories();
    storiesUnavailable = false;
    // Кнопка в нижнем баре — сразу после входа, не дожидаясь ответа сервера
    // (раньше она появлялась только после успешной загрузки ленты, а при любой
    // ошибке запроса не появлялась вовсе).
    renderStoryNavButton();
    refreshStories();
    storyRefreshTimer = setInterval(() => { if (!document.hidden) refreshStories(); }, 60000);
}

function stopStories() {
    clearInterval(storyRefreshTimer);
    storyRefreshTimer = null;
    storyFeed = null;
    storyGroups = [];
    const bar = document.getElementById("stories-bar");
    if (bar) { bar.hidden = true; bar.innerHTML = ""; bar._html = null; }
    renderStoryNavButton();
}

async function refreshStories() {

    if (!myRealUserId) return;

    let feed;
    try {
        feed = await KabanAPI.getStoryFeed();
    } catch (error) {
        console.warn("Не удалось загрузить истории", error);
        renderStoryNavButton();
        return;
    }

    storyFeed = feed;
    // Таблицы историй в базе нет (SQL-блок не выполнен) — перестаём спрашивать её
    // каждую минуту (раньше это были бесконечные ошибки 404 в фоне).
    if (!feed) { storiesUnavailable = true; clearInterval(storyRefreshTimer); storyRefreshTimer = null; renderStoriesBar(); return; }

    const byUser = new Map();
    feed.stories.forEach((story) => {
        if (!byUser.has(story.user_id)) byUser.set(story.user_id, { user: story.users || { id: story.user_id }, stories: [] });
        byUser.get(story.user_id).stories.push(story);
    });

    storyGroups = [...byUser.values()].map((group) => ({ ...group, unseen: group.stories.some((s) => !feed.seen.has(s.id)) }));
    // Свои — первыми, потом непросмотренные, потом остальные; внутри — по свежести.
    storyGroups.sort((a, b) => {
        const mineA = a.user.id === myRealUserId, mineB = b.user.id === myRealUserId;
        if (mineA !== mineB) return mineA ? -1 : 1;
        if (a.unseen !== b.unseen) return a.unseen ? -1 : 1;
        return new Date(b.stories[b.stories.length - 1].created_at) - new Date(a.stories[a.stories.length - 1].created_at);
    });

    renderStoriesBar();

}

function storyAvatarHTML(user, size = "") {
    const style = user?.avatar_url ? ` style="background-image:${escapeHTML(cssUrlValue(user.avatar_url))}"` : "";
    const letter = user?.avatar_url ? "" : escapeHTML((user?.display_name || "?").trim().charAt(0).toUpperCase());
    return `<span class="story-avatar${size}"${style}>${letter}</span>`;
}

function renderStoriesBar() {

    const bar = document.getElementById("stories-bar");
    renderStoryNavButton();
    if (!bar) return;

    if (!storyFeed) { bar.hidden = true; bar.innerHTML = ""; bar._html = null; return; }

    // Своя история (добавить / посмотреть) живёт в нижнем баре — здесь только
    // истории собеседников. Нет ни одной — полосу не показываем вовсе.
    const others = storyGroups.filter((g) => g.user.id !== myRealUserId);
    if (!others.length) { bar.hidden = true; bar.innerHTML = ""; bar._html = null; return; }

    const html = others.map((group) => `
        <button type="button" class="story-item${group.unseen ? " unseen" : " seen"}" data-user-id="${escapeHTML(group.user.id)}" onclick="openStoryViewer(this.dataset.userId)">
            <span class="story-ring">${storyAvatarHTML(group.user)}</span>
            <span class="story-name">${escapeHTML((group.user.display_name || "Контакт").split(" ")[0])}</span>
        </button>`).join("");

    // Обновление раз в минуту без изменений не должно пересобирать ленту (мигание аватаров).
    if (bar._html !== html) { bar.innerHTML = html; bar._html = html; }
    bar.hidden = false;

}

// Кнопка «История» в нижнем баре: видна, когда истории доступны в базе; кольцо —
// если у меня сейчас есть активная история.
function renderStoryNavButton() {
    const button = document.getElementById("bottom-nav-story");
    if (!button) return;
    button.hidden = storiesUnavailable;
    const mine = storyGroups.find((g) => g.user.id === myRealUserId);
    button.classList.toggle("has-story", !!mine);
    button.setAttribute("aria-label", mine ? "История: добавить или посмотреть свою" : "Добавить историю");
}

function storyNavTap(element) {
    if (typeof isTapSuppressed === "function" && isTapSuppressed(element)) return;
    if (!myRealUserId) { toast("Войдите в аккаунт, чтобы публиковать истории"); return; }
    const mine = storyGroups.find((g) => g.user.id === myRealUserId);
    if (!mine) { openStoryCreate(); return; }

    // Своя история уже есть — выбор: посмотреть её или добавить ещё одну.
    document.getElementById("tab-quick-menu").innerHTML = `
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); openStoryCreate()">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/></svg></span>
            <span>Новая история</span>
        </button>
        <button type="button" class="tab-quick-menu-item" onclick="closeTabQuickMenu(); openStoryViewer(myRealUserId)">
            <span class="tqm-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/></svg></span>
            <span>Моя история</span>
        </button>`;
    document.getElementById("tab-quick-menu-backdrop").hidden = false;
}
/* ---- просмотр ---------------------------------------------------------------- */

function openStoryViewer(userId) {

    const group = storyGroups.find((g) => g.user.id === userId);
    if (!group) return;

    const firstUnseen = group.stories.findIndex((s) => !storyFeed.seen.has(s.id));
    storyViewer = { queue: group.stories, index: Math.max(0, firstUnseen), userId, paused: false, user: group.user };

    const viewer = document.getElementById("story-viewer");
    viewer.classList.add("open");
    viewer.setAttribute("aria-hidden", "false");
    showStory();

}

function closeStoryViewer() {
    const viewer = document.getElementById("story-viewer");
    viewer.classList.remove("open");
    viewer.setAttribute("aria-hidden", "true");
    document.getElementById("story-viewers-panel").hidden = true;
    storyViewer = null;
    document.getElementById("story-stage").innerHTML = "";
    renderStoriesBar();
}

function showStory() {

    if (!storyViewer) return;
    const story = storyViewer.queue[storyViewer.index];
    if (!story) { closeStoryViewer(); return; }

    const user = storyViewer.user;
    const isMine = story.user_id === myRealUserId;

    document.getElementById("story-viewers-panel").hidden = true;

    document.getElementById("story-progress").innerHTML = storyViewer.queue
        .map((_, i) => `<span class="story-seg${i < storyViewer.index ? " done" : ""}"><i></i></span>`).join("");

    document.getElementById("story-head-avatar-slot").innerHTML = storyAvatarHTML(user, " small");
    document.getElementById("story-head-name").textContent = isMine ? "Моя история" : (user.display_name || "Контакт");
    document.getElementById("story-head-time").textContent = formatStoryAge(story.created_at);
    document.getElementById("story-delete-btn").hidden = !isMine;
    document.getElementById("story-views-btn").hidden = !isMine;

    const stage = document.getElementById("story-stage");
    let waitForImage = null;
    if (story.kind === "image") {
        stage.style.background = "#000";
        // Ссылку на картинку пишет автор истории — принимаем только файлы из нашего
        // хранилища (чужой адрес мог бы следить за тем, кто и когда смотрит историю).
        const safeUrl = isOwnStorageUrl(story.media_url) ? story.media_url : "";
        stage.innerHTML = safeUrl ? `<img class="story-image" src="${escapeHTML(safeUrl)}" alt="">` : `<div class="story-text">Не удалось показать фото</div>`;
        waitForImage = stage.querySelector("img");
    } else {
        // Фон — только из своего набора: строка из базы в style.background позволяла
        // подставить url(...) на сторонний сервер.
        stage.style.background = STORY_BGS.includes(story.bg) ? story.bg : STORY_BGS[0];
        stage.innerHTML = `<div class="story-text">${escapeHTML(story.text_content || "")}</div>`;
    }
    if (story.caption) stage.insertAdjacentHTML("beforeend", `<div class="story-caption">${escapeHTML(story.caption)}</div>`);

    // Отметка «просмотрено» — только для чужих.
    if (!isMine && !storyFeed.seen.has(story.id)) {
        storyFeed.seen.add(story.id);
        KabanAPI.markStoryViewed(story.id).catch(() => {});
    }

    // Фото ещё грузится — отсчёт не идёт (на медленной сети история «пролетала»
    // раньше, чем картинка успевала появиться).
    if (waitForImage && !waitForImage.complete) {
        const shownIndex = storyViewer.index;
        const begin = () => { if (storyViewer && storyViewer.index === shownIndex) startStoryTimer(); };
        waitForImage.addEventListener("load", begin, { once: true });
        waitForImage.addEventListener("error", begin, { once: true });
        return;
    }
    startStoryTimer();

}

function isOwnStorageUrl(url) {
    return typeof url === "string" && typeof SUPABASE_URL === "string" && url.startsWith(SUPABASE_URL + "/storage/v1/object/public/");
}

function startStoryTimer() {

    const bar = document.querySelectorAll("#story-progress .story-seg")[storyViewer.index]?.querySelector("i");
    if (!bar) return;
    bar.style.animation = "none";
    void bar.offsetWidth;
    bar.style.animation = `story-progress ${STORY_DURATION_MS}ms linear forwards`;
    bar.style.animationPlayState = storyViewer.paused ? "paused" : "running";
    bar.onanimationend = () => nextStory();

}

function setStoryPaused(paused) {
    if (!storyViewer) return;
    storyViewer.paused = paused;
    const bar = document.querySelectorAll("#story-progress .story-seg")[storyViewer.index]?.querySelector("i");
    if (bar) bar.style.animationPlayState = paused ? "paused" : "running";
}

function nextStory() {
    if (!storyViewer) return;
    if (storyViewer.index + 1 >= storyViewer.queue.length) {
        // Следующий человек с историями — иначе закрываем.
        const currentIndex = storyGroups.findIndex((g) => g.user.id === storyViewer.userId);
        const nextGroup = storyGroups.slice(currentIndex + 1).find((g) => g.user.id !== myRealUserId);
        closeStoryViewer();
        if (nextGroup) openStoryViewer(nextGroup.user.id);
        return;
    }
    storyViewer.index++;
    showStory();
}

function prevStory() {
    if (!storyViewer) return;
    if (storyViewer.index > 0) storyViewer.index--;
    showStory();
}

function formatStoryAge(iso) {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (minutes < 1) return "только что";
    if (minutes < 60) return `${minutes} мин. назад`;
    return `${Math.floor(minutes / 60)} ч. назад`;
}

async function deleteCurrentStory() {

    if (!storyViewer) return;
    const story = storyViewer.queue[storyViewer.index];
    if (!story || story.user_id !== myRealUserId) return;
    if (!confirm("Удалить эту историю?")) return;

    try {
        await KabanAPI.deleteStory(story.id, story.media_url);
    } catch (error) {
        toast("Не удалось удалить: " + (error?.message || error));
        return;
    }

    const rest = storyViewer.queue.filter((s) => s.id !== story.id);
    closeStoryViewer();
    await refreshStories();
    if (rest.length) openStoryViewer(myRealUserId);

}

async function toggleStoryViewers() {

    const panel = document.getElementById("story-viewers-panel");
    if (!panel.hidden) { panel.hidden = true; setStoryPaused(false); return; }

    const story = storyViewer?.queue[storyViewer.index];
    if (!story) return;

    setStoryPaused(true);
    panel.hidden = false;
    panel.innerHTML = '<div class="story-viewers-title">Просмотры</div><div class="story-viewers-empty">Загрузка…</div>';

    try {
        const viewers = await KabanAPI.getStoryViewers(story.id);
        panel.innerHTML = `<div class="story-viewers-title">Просмотры · ${viewers.length}</div>` + (viewers.length
            ? viewers.map((v) => `<div class="story-viewer-row">${storyAvatarHTML(v.users, " small")}<span>${escapeHTML(v.users?.display_name || "Пользователь")}</span></div>`).join("")
            : '<div class="story-viewers-empty">Пока никто не смотрел</div>');
    } catch (error) {
        panel.innerHTML = '<div class="story-viewers-empty">Не удалось загрузить</div>';
    }

}

(function initStoryViewerEvents() {

    const stage = document.getElementById("story-stage");
    if (!stage) return;

    // Левая треть — назад, остальное — вперёд; удержание — пауза.
    let holdTimer = null;
    let held = false;

    stage.addEventListener("pointerdown", () => {
        held = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { held = true; setStoryPaused(true); }, 220);
    });

    const release = () => {
        clearTimeout(holdTimer);
        if (held) setStoryPaused(false);
    };
    stage.addEventListener("pointerup", release);
    stage.addEventListener("pointerleave", release);
    stage.addEventListener("pointercancel", release);

    stage.addEventListener("click", (event) => {
        if (held) { held = false; return; }
        const rect = stage.getBoundingClientRect();
        if (event.clientX - rect.left < rect.width / 3) prevStory(); else nextStory();
    });

    document.addEventListener("keydown", (event) => {
        if (!storyViewer) return;
        if (event.key === "ArrowRight") nextStory();
        else if (event.key === "ArrowLeft") prevStory();
        else if (event.key === "Escape") { event.stopImmediatePropagation(); closeStoryViewer(); }
    }, true);

})();

/* ---- создание ------------------------------------------------------------------ */

function openStoryCreate() {

    storyCreateFile = null;
    storyCreateBg = STORY_BGS[0];
    document.getElementById("story-text-input").value = "";
    document.getElementById("story-caption-input").value = "";
    document.getElementById("story-photo-preview").style.backgroundImage = "";
    document.getElementById("story-photo-preview").classList.remove("has-image");
    selectStoryKind("image");

    document.getElementById("story-bg-grid").innerHTML = STORY_BGS.map((bg, i) =>
        `<button type="button" class="story-bg-swatch${i === 0 ? " active" : ""}" style="background:${bg}" data-index="${i}" onclick="selectStoryBg(${i})" aria-label="Фон ${i + 1}"></button>`).join("");
    selectStoryBg(0);

    const backdrop = document.getElementById("story-create-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeStoryCreate() {
    const backdrop = document.getElementById("story-create-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function selectStoryKind(kind) {
    storyCreateKind = kind;
    document.querySelectorAll(".story-kind-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.kind === kind));
    document.getElementById("story-photo-pane").hidden = kind !== "image";
    document.getElementById("story-text-pane").hidden = kind !== "text";
}

function selectStoryBg(index) {
    storyCreateBg = STORY_BGS[index];
    document.querySelectorAll(".story-bg-swatch").forEach((btn) => btn.classList.toggle("active", Number(btn.dataset.index) === index));
    document.getElementById("story-text-input").style.background = storyCreateBg;
}

// Фото → JPEG не больше 1080 по длинной стороне (экономит место и трафик).
function resizeImageForStory(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const scale = Math.min(1, 1080 / Math.max(img.width, img.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(url);
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas"))), "image/jpeg", 0.86);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Не удалось прочитать изображение")); };
        img.src = url;
    });
}

async function pickStoryPhoto(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
        storyCreateFile = await resizeImageForStory(file);
        const preview = document.getElementById("story-photo-preview");
        preview.style.backgroundImage = `url(${URL.createObjectURL(storyCreateFile)})`;
        preview.classList.add("has-image");
    } catch (error) {
        toast("Не удалось открыть фото: " + (error?.message || error));
    }
}

async function publishStory() {

    const button = document.getElementById("story-publish-btn");
    if (button.disabled) return;

    let payload;
    if (storyCreateKind === "image") {
        if (!storyCreateFile) { toast("Выберите фото"); return; }
        payload = { kind: "image", file: storyCreateFile, caption: document.getElementById("story-caption-input").value.trim() };
    } else {
        const text = document.getElementById("story-text-input").value.trim();
        if (!text) { toast("Напишите текст истории"); return; }
        payload = { kind: "text", text, bg: storyCreateBg };
    }

    button.disabled = true;
    button.textContent = "Публикуем…";
    try {
        await KabanAPI.createStory(payload);
        closeStoryCreate();
        toast("История опубликована на 24 часа");
        await refreshStories();
    } catch (error) {
        toast("Не удалось опубликовать: " + (error?.message || error));
    } finally {
        button.disabled = false;
        button.textContent = "Опубликовать";
    }

}
