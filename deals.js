/* =====================================================================================================
   КАРТОЧКИ АВРОРЫ: раздачи, скидки и новости игр (сообщения бота @aurora_bot, attachment_meta.deal и
   attachment_meta.deal_list — см. supabase/functions/aurora-bot). Старые версии программы показывают
   вместо карточки текст сообщения со ссылкой — он тоже есть всегда.
   ===================================================================================================== */

const DEAL_STORE_NAMES = { epic: "Epic Games", steam: "Steam", gog: "GOG", ubisoft: "Ubisoft", ea: "EA", battlenet: "Battle.net", microsoft: "Microsoft Store" };

function dealSafeUrl(url) {
    try { const u = new URL(String(url || "")); return u.protocol === "https:" ? u.href : ""; } catch { return ""; }
}

// «до 22 окт · осталось 2 дня» / «последний день» / «раздача закончилась».
function dealUntilText(iso) {
    const end = Date.parse(iso || "");
    if (!Number.isFinite(end)) return "";
    const left = end - Date.now();
    if (left <= 0) return "раздача закончилась";
    const date = new Date(end).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
    const days = Math.floor(left / 86400000);
    const tail = days >= 2 ? `осталось ${days} ${pluralRuSafe(days, "день", "дня", "дней")}` : days === 1 ? "остался 1 день" : "последний день";
    return `до ${date} · ${tail}`;
}

function pluralRuSafe(n, one, few, many) {
    if (typeof pluralRu === "function") return pluralRu(n, one, few, many);
    const m10 = n % 10, m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many;
}

function dealVotesText(votes) {
    if (!votes) return "";
    return votes >= 1000 ? `${Math.round(votes / 100) / 10} тыс. отзывов`.replace(".", ",") : `${votes} отзывов`;
}

function buildDealHTML(message) {
    const d = message.attachment_meta?.deal || {};
    const url = dealSafeUrl(d.url);
    const img = dealSafeUrl(d.image);
    const store = DEAL_STORE_NAMES[d.store] || d.store || "";
    const kind = d.kind === "discount" ? "discount" : d.kind === "news" ? "news" : "free";
    const badge = kind === "free" ? "Бесплатно" : kind === "discount" ? `−${Number(d.discount) || 0}%` : "Новости";
    const until = kind === "free" ? dealUntilText(d.until) : "";
    const ended = until === "раздача закончилась";
    const price = kind === "free"
        ? `<div class="deal-price">${d.priceOld ? `<s>${escapeHTML(d.priceOld)}</s> ` : ""}<b>${ended ? "закончилась" : "0 ₽"}</b></div>`
        : kind === "discount"
        ? `<div class="deal-price">${d.priceOld ? `<s>${escapeHTML(d.priceOld)}</s> ` : ""}<b>${escapeHTML(d.priceNew || "")}</b></div>`
        : "";
    const meta = [
        d.rating ? `★ ${Number(d.rating)}% положительных${d.votes ? ` · ${dealVotesText(Number(d.votes))}` : ""}` : "",
        until && !ended ? `⏳ ${until}` : ""
    ].filter(Boolean).join("<br>");
    const button = kind === "free" ? "Забрать" : kind === "discount" ? `Открыть в ${escapeHTML(store)}` : "Читать полностью";
    return `
        <div class="deal-card deal-${kind}${ended ? " is-ended" : ""}">
            ${img ? `<a class="deal-media" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHTML(img)}" alt="" loading="lazy" onerror="this.parentNode.remove()"></a>` : ""}
            <div class="deal-body">
                <div class="deal-top"><span class="deal-badge">${escapeHTML(badge)}</span><span class="deal-store">${escapeHTML(kind === "news" && d.game ? d.game : store)}</span></div>
                <div class="deal-title">${escapeHTML(d.title || "")}</div>
                ${price}
                ${meta ? `<div class="deal-meta">${meta}</div>` : ""}
                ${kind === "news" && d.summary ? `<div class="deal-summary">${escapeHTML(d.summary)}</div>` : ""}
                ${url && !ended ? `<a class="deal-btn" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${button}</a>` : ""}
            </div>
        </div>`;
}

function buildDealListHTML(message) {
    const items = Array.isArray(message.attachment_meta?.deal_list) ? message.attachment_meta.deal_list : [];
    const rows = items.map((x) => {
        const url = dealSafeUrl(x.url), img = dealSafeUrl(x.image);
        const until = dealUntilText(x.until);
        return `
            <a class="deal-row" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">
                ${img ? `<img src="${escapeHTML(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="deal-row-ph">🎁</span>`}
                <span class="deal-row-copy">
                    <span class="deal-row-title">${escapeHTML(x.title || "")}</span>
                    <span class="deal-row-sub">${escapeHTML(DEAL_STORE_NAMES[x.store] || x.store || "")}${x.priceOld ? ` · <s>${escapeHTML(x.priceOld)}</s>` : ""}${until ? ` · ${escapeHTML(until)}` : ""}</span>
                </span>
            </a>`;
    }).join("");
    const stale = auroraStaleHTML(message.attachment_meta?.checked_at || message.created_at, 12 * 3600000, message.attachment_meta?.buttons ? "нажмите «Обновить»" : "список мог устареть");
    return `<div class="deal-list"><div class="deal-list-head">🎁 Сейчас бесплатно</div>${stale}${rows || `<div class="deal-row-sub">Ничего не раздают</div>`}</div>`;
}

/* ---- Кнопки под сообщениями Авроры (как inline-кнопки Telegram) ----------------------------------
   attachment_meta.buttons = [[{ t: подпись, c: команда }]]. Нажатие не пишет сообщение в чат: команда
   уходит Авроре через RPC aurora_button (aurora_buttons.sql), а ответ приходит правкой этого же
   сообщения или новым сообщением. Команда «@input:…» — только вставить текст в строку ввода. */

function buildBotButtonsHTML(message) {
    const rows = Array.isArray(message.attachment_meta?.buttons) ? message.attachment_meta.buttons : [];
    if (!rows.length || message.deleted_at) return "";
    return `<div class="bot-buttons">${rows.slice(0, 8).map((row) => `<div class="bot-buttons-row">${(Array.isArray(row) ? row : []).slice(0, 4).map((b) =>
        `<button type="button" class="bot-btn" data-cmd="${escapeHTML(String(b?.c || ""))}" onclick="auroraPress(event, this)">${escapeHTML(String(b?.t || ""))}</button>`).join("")}</div>`).join("")}</div>`;
}

const auroraPressedAt = new WeakMap();

async function auroraPress(event, el) {
    event.preventDefault();
    event.stopPropagation();
    const cmd = el.dataset.cmd || "";
    if (cmd.startsWith("@input:")) {
        const input = document.getElementById("input");
        if (input) {
            input.value = cmd.slice(7);
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            if (typeof resizeComposer === "function") resizeComposer();
            if (typeof updateComposerAction === "function") updateComposerAction();
        }
        return;
    }
    if (!cmd.startsWith("/") || el.classList.contains("is-busy")) return;
    const messageId = el.closest(".message-row")?.dataset.messageId || null;
    // Какому боту: сообщения Маяка помечены attachment_meta.bot = "mayak"; меню «/» передаёт data-bot.
    const bot = el.dataset.bot || (messageId && typeof realMessagesById !== "undefined" ? realMessagesById.get(messageId)?.attachment_meta?.bot : null) || "aurora";
    const botName = bot === "mayak" ? "Маяка" : "Авроры";
    // Сразу видно, что нажалось: переключатель перещёлкивается, кнопка «думает».
    el.classList.add("is-busy");
    if (el.classList.contains("aur-switch")) {
        el.classList.toggle("is-on");
        el.setAttribute("aria-checked", String(el.classList.contains("is-on")));
        const state = el.parentElement?.querySelector(".aur-state");
        if (state) state.textContent = el.classList.contains("is-on") ? "Вкл" : "Выкл";
    }
    auroraPressedAt.set(el, Date.now());
    try {
        const { error } = await getSupabaseClient().rpc(bot === "mayak" ? "mayak_button" : "aurora_button", { p_chat: currentChatId, p_message: messageId, p_cmd: cmd });
        if (error) throw error;
    } catch (error) {
        console.warn(`Кнопка ${botName}:`, error);
        el.classList.remove("is-busy");
        const why = String(error?.message || "");
        if (typeof toast === "function") toast(
            /not in this chat/i.test(why) ? `${bot === "mayak" ? "Маяка" : "Авроры"} больше нет в этом чате — добавьте снова`
            : /not a participant/i.test(why) ? "Вы больше не участник этого чата"
            : /_button|function/i.test(why) ? `Кнопки ${botName} ещё не включены на сервере`
            : "Не получилось — попробуйте ещё раз");
        if (messageId && typeof updateRealMessageRow === "function") updateRealMessageRow(messageId, { force: true });
        return;
    }
    // Ответ обычно за 1–3 с (сообщение перерисуется само); если нет — снимаем «думает».
    setTimeout(() => { if (el.isConnected) el.classList.remove("is-busy"); }, 12000);
}

/* ---- «⚙️ Аврора в этом чате» (attachment_meta.aurora_panel) ---- */

// Ближайший момент по расписанию: сервер присылает «следующий раз», а карточку могут открыть
// и через день — тогда шагаем вперёд на период (час для проверки, сутки для подборки скидок).
function auroraNextAt(iso, periodMs) {
    let t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return null;
    const now = Date.now();
    if (t <= now) t += Math.ceil((now - t + 1) / periodMs) * periodMs;
    return t;
}

function auroraWhenText(t) {
    if (!t) return "";
    const d = new Date(t), now = new Date();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const mins = Math.max(1, Math.round((t - Date.now()) / 60000));
    const rel = mins < 60 ? `через ${mins} мин` : `через ${Math.round(mins / 60)} ч`;
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const day = d.toDateString() === now.toDateString() ? "сегодня" : d.toDateString() === tomorrow.toDateString() ? "завтра" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
    return `${day} в ${hm} · ${rel}`;
}

function auroraDateText(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return "сегодня";
    if (days === 1) return "вчера";
    return new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "");
}

// Сообщение давно не обновлялось (карточку открыли через неделю) — честно пишем, на когда данные.
function auroraStaleHTML(iso, maxAgeMs, hint) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t) || Date.now() - t < maxAgeMs) return "";
    const when = new Date(t).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(".", "");
    return `<div class="aur-stale">🕓 Данные на ${escapeHTML(when)} — ${escapeHTML(hint)}</div>`;
}

// «С 23:00 до 07:00 …» — в часовом поясе того, кто смотрит (окно задано в UTC на сервере).
function auroraQuietText(p) {
    const from = Number(p.quiet?.from_utc ?? 13), to = Number(p.quiet?.to_utc ?? 21), min = Number(p.check_minute ?? 0);
    const at = (h) => { const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    const at7 = (h) => { const d = new Date(); d.setUTCHours(h, min, 0, 0); return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };
    return p.quiet_on
        ? `С ${at(from)} до ${at(to)} раздачи и новости не присылаю — утром в ${at7(to)} пришлю всё накопившееся одним заходом`
        : "Выключено — пишу в любое время, даже ночью";
}

function auroraSwitchHTML(on, cmdOn, cmdOff, label) {
    return `<span class="aur-toggle">
        <span class="aur-state ${on ? "on" : ""}">${on ? "Вкл" : "Выкл"}</span>
        <button type="button" class="aur-switch${on ? " is-on" : ""}" role="switch" aria-checked="${on}" aria-label="${escapeHTML(label)}"
            data-cmd="${escapeHTML(on ? cmdOff : cmdOn)}" onclick="auroraPress(event, this)"><span class="aur-knob"></span></button>
    </span>`;
}

function buildAuroraPanelHTML(message) {
    const p = message.attachment_meta?.aurora_panel || {};
    let nextCheck = auroraNextAt(p.next?.check, 3600000);
    // В тихие часы ближайшая проверка, которая что-то пришлёт, — утренняя.
    if (p.quiet_on && nextCheck) {
        const from = Number(p.quiet?.from_utc ?? 13), to = Number(p.quiet?.to_utc ?? 21);
        const h = new Date(nextCheck).getUTCHours();
        if (h >= from && h < to) { const d = new Date(nextCheck); d.setUTCHours(to, Number(p.check_minute ?? 0), 0, 0); nextCheck = d.getTime(); }
    }
    const nextDeals = auroraNextAt(p.next?.deals, 86400000);
    const apps = Array.isArray(p.apps) ? p.apps : [];
    const max = Number(p.max_apps) || 10;
    const chip = (pct) => `<button type="button" class="aur-chip${Number(p.min_discount) === pct ? " is-selected" : ""}" data-cmd="/скидки ${pct}" onclick="auroraPress(event, this)" ${p.discounts ? "" : "disabled"}>−${pct}%</button>`;
    const action = (label, cmd, disabled = false) => `<button type="button" class="aur-action" data-cmd="${escapeHTML(cmd)}" onclick="auroraPress(event, this)" ${disabled ? "disabled" : ""}>${label}</button>`;

    const freeSub = p.giveaways
        ? `Пришлю сразу, как начнётся раздача. Проверяю каждый час — следующая проверка ${auroraWhenText(nextCheck)}`
        : "Выключено — новые раздачи не присылаю";
    const freeNow = Number.isFinite(Number(p.free_now)) && p.free_now !== null ? `<span class="aur-pill">Сейчас раздают: ${Number(p.free_now)}</span>` : "";
    const dealsSub = p.discounts
        ? `Подборка до ${Number(p.deals_per_day) || 10} игр от −${Number(p.min_discount) || 70}% · ${auroraWhenText(nextDeals)}`
        : "Выключено — подборку не присылаю";
    const newsSub = !p.news_on ? "Выключено — новости не присылаю (список игр сохранён)"
        : apps.length ? `Новые официальные новости приходят в течение часа · следующая проверка ${auroraWhenText(nextCheck)}`
        : "Добавьте игру — буду присылать её патчи и новости с пересказом";

    const appRows = apps.map((a) => `
        <div class="aur-app">
            <img src="https://cdn.akamai.steamstatic.com/steam/apps/${Number(a.appid)}/capsule_184x69.jpg" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            <span class="aur-app-copy">
                <span class="aur-app-name">${escapeHTML(a.name || "")}</span>
                <span class="aur-app-sub">${a.last ? `последняя новость: ${escapeHTML(auroraDateText(a.last))}` : "новостей пока нет"}</span>
            </span>
            <button type="button" class="aur-icon-btn" title="Последняя новость" aria-label="Последняя новость ${escapeHTML(a.name || "")}" data-cmd="/новости последняя #${Number(a.appid)}" onclick="auroraPress(event, this)">📰</button>
            <button type="button" class="aur-icon-btn danger" title="Не следить" aria-label="Не следить за ${escapeHTML(a.name || "")}" data-cmd="/новости убрать #${Number(a.appid)}" onclick="auroraPress(event, this)">✕</button>
        </div>`).join("");

    return `
        <div class="aur-panel${p.paused ? " is-paused" : ""}">
            <div class="aur-head">
                <span class="aur-title">⚙️ Аврора в этом чате</span>
                <button type="button" class="aur-refresh" title="Обновить" aria-label="Обновить" data-cmd="/настройки" onclick="auroraPress(event, this)">⟳</button>
            </div>
            ${auroraStaleHTML(p.updated_at || message.created_at, 6 * 3600000, "нажмите ⟳, чтобы обновить")}
            ${p.notice ? `<div class="aur-notice">${escapeHTML(p.notice)}</div>` : ""}
            ${p.paused ? `<div class="aur-paused">⏸ Сейчас я ничего не присылаю в этот чат — включите нужное ниже</div>` : ""}

            <section class="aur-sec${p.giveaways ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">🎁</span>
                    <span class="aur-row-copy"><b>Бесплатные игры</b><span>${escapeHTML(freeSub)}</span></span>
                    ${auroraSwitchHTML(!!p.giveaways, "/раздачи вкл", "/раздачи выкл", "Бесплатные игры")}
                </div>
                <div class="aur-actions">${freeNow}${action("Показать сейчас", "/сейчас")}</div>
            </section>

            <section class="aur-sec${p.discounts ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">🔥</span>
                    <span class="aur-row-copy"><b>Скидки Steam</b><span>${escapeHTML(dealsSub)}</span></span>
                    ${auroraSwitchHTML(!!p.discounts, "/скидки вкл", "/скидки выкл", "Скидки Steam")}
                </div>
                <div class="aur-chips${p.discounts ? "" : " is-disabled"}"><span class="aur-chips-label">Присылать скидки от:</span>${[50, 60, 70, 80, 90].map(chip).join("")}</div>
                <div class="aur-chips${p.discounts ? "" : " is-disabled"}"><span class="aur-chips-label">Игр в подборке:</span>${(Array.isArray(p.deals_sizes) ? p.deals_sizes : [5, 10, 20]).map((n) =>
                    `<button type="button" class="aur-chip${Number(p.deals_per_day) === Number(n) ? " is-selected" : ""}" data-cmd="/скидки игр ${Number(n)}" onclick="auroraPress(event, this)" ${p.discounts ? "" : "disabled"}>${Number(n)}</button>`).join("")}</div>
                <div class="aur-actions">${action("Показать сейчас", "/скидки сейчас")}</div>
            </section>

            <section class="aur-sec${p.news_on ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">📰</span>
                    <span class="aur-row-copy"><b>Новости игр</b><span>${escapeHTML(newsSub)}</span></span>
                    ${auroraSwitchHTML(!!p.news_on, "/новости вкл", "/новости выкл", "Новости игр")}
                </div>
                ${apps.length ? `<div class="aur-apps${p.news_on ? "" : " is-disabled"}">${appRows}</div>` : ""}
                <div class="aur-actions">
                    <span class="aur-pill">${apps.length} из ${max}</span>
                    ${apps.length < max ? `<button type="button" class="aur-action" data-cmd="@input:/новости " onclick="auroraPress(event, this)">＋ Добавить игру</button>` : ""}
                </div>
            </section>

            ${"quiet_on" in p ? `<section class="aur-sec${p.quiet_on ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">🌙</span>
                    <span class="aur-row-copy"><b>Тихие часы</b><span>${escapeHTML(auroraQuietText(p))}</span></span>
                    ${auroraSwitchHTML(!!p.quiet_on, "/тихие вкл", "/тихие выкл", "Тихие часы")}
                </div>
            </section>` : ""}
            <div class="aur-foot">Эта карточка исчезнет через 15 минут после последнего нажатия · снова открыть: /настройки</div>
        </div>`;
}

/* ---- Подсказка команд при вводе «/» в чате с ботами (как меню команд бота в Telegram) ---- */

const BOT_COMMANDS = {
    aurora: { title: "Аврора · игры", items: [
        { c: "/настройки", d: "Что включено и когда я напишу" },
        { c: "/сейчас", d: "Бесплатные игры прямо сейчас" },
        { c: "/скидки", d: "Лучшие скидки прямо сейчас" },
        { c: "/новости ", d: "Следить за игрой: /новости Название", arg: true },
        { c: "/помощь", d: "Что я умею" },
        { c: "/стоп", d: "Пауза — ничего не присылать" }
    ] },
    mayak: { title: "Маяк · Приморье", items: [
        { c: "/маршрут ", d: "Как добраться: /маршрут Калина Молл - Седанка", arg: true },
        { c: "/автобус ", d: "Маршрут и расписание: /автобус 31", arg: true },
        { c: "/погода", d: "Погода сейчас и на день" },
        { c: "/неделя", d: "Прогноз на 7 дней" },
        { c: "/новости", d: "Главное во Владивостоке" },
        { c: "/сводка", d: "Утренняя сводка прямо сейчас" },
        { c: "/город ", d: "Другой город края: /город Находка", arg: true },
        { c: "/адрес ", d: "Отключения в вашем доме: /адрес Светланская 10", arg: true },
        { c: "/отключения", d: "Что отключат по вашим адресам" },
        { c: "/настройки", d: "Что включено и когда я напишу" },
        { c: "/помощь", d: "Что я умею" }
    ] }
};
const BOT_USERNAMES = { aurora_bot: "aurora", mayak_bot: "mayak" };

// Какие боты есть в открытом чате: ["aurora", "mayak"].
function botsInCurrentChat() {
    if (typeof currentChatId === "undefined" || !currentChatId || (typeof currentChatIsSecret !== "undefined" && currentChatIsSecret)) return [];
    if (typeof currentChatType !== "undefined" && currentChatType === "group") {
        return [...new Set([...(currentChatMembersById?.values?.() || [])].map((u) => BOT_USERNAMES[u?.username]).filter(Boolean))];
    }
    const row = typeof cachedChatRows !== "undefined" ? cachedChatRows.find((r) => r.chat_id === currentChatId) : null;
    const b = BOT_USERNAMES[row?.otherUser?.username];
    return b ? [b] : [];
}
const auroraInCurrentChat = () => botsInCurrentChat().includes("aurora");

(function auroraSlashMenu() {
    const input = document.getElementById("input");
    const host = input?.closest(".input");
    if (!input || !host) return;
    const menu = document.createElement("div");
    menu.className = "aur-slash";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", "Команды ботов");
    host.appendChild(menu);

    let shown = [];
    const hide = () => { menu.hidden = true; };
    const run = (item) => {
        hide();
        if (item.arg) {
            // В группе с двумя ботами набранная команда Маяку — с обращением, иначе её возьмёт Аврора.
            input.value = item.bot === "mayak" && botsInCurrentChat().length > 1 ? `${item.c.trim()} @mayak_bot ` : item.c;
            input.focus();
            if (typeof resizeComposer === "function") resizeComposer();
            if (typeof updateComposerAction === "function") updateComposerAction();
            return;
        }
        input.value = "";
        if (typeof resizeComposer === "function") resizeComposer();
        if (typeof updateComposerAction === "function") updateComposerAction();
        // Как кнопка: команда уходит нужному боту без сообщения в чате.
        const fake = document.createElement("button");
        fake.dataset.cmd = item.c;
        fake.dataset.bot = item.bot;
        auroraPress({ preventDefault() {}, stopPropagation() {} }, fake);
    };

    input.addEventListener("input", () => {
        const v = input.value;
        const bots = /^\/[\p{L}]*$/u.test(v) ? botsInCurrentChat() : [];
        if (!bots.length) return hide();
        const q = v.slice(1).toLocaleLowerCase();
        shown = [];
        const html = bots.map((bot) => {
            const items = BOT_COMMANDS[bot].items.filter((x) => x.c.slice(1).startsWith(q)).map((x) => ({ ...x, bot }));
            if (!items.length) return "";
            const head = `<div class="aur-slash-head">${escapeHTML(bots.length > 1 ? BOT_COMMANDS[bot].title : `Команды: ${BOT_COMMANDS[bot].title}`)}</div>`;
            return head + items.map((x) => { shown.push(x); return `<button type="button" class="aur-slash-item" data-i="${shown.length - 1}" role="option"><b>${escapeHTML(x.c.trim())}</b><span>${escapeHTML(x.d)}</span></button>`; }).join("");
        }).join("");
        if (!shown.length) return hide();
        menu.innerHTML = html;
        menu.hidden = false;
    });
    menu.addEventListener("mousedown", (e) => e.preventDefault());   // фокус остаётся в строке ввода
    menu.addEventListener("click", (e) => {
        const b = e.target.closest(".aur-slash-item");
        if (b && shown[Number(b.dataset.i)]) run(shown[Number(b.dataset.i)]);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { e.stopPropagation(); hide(); } });
    input.addEventListener("blur", () => setTimeout(hide, 150));
})();

// «Скидки дня» — подборка Авроры одним сообщением (attachment_meta.deal_digest).
function buildDealDigestHTML(message) {
    const items = Array.isArray(message.attachment_meta?.deal_digest) ? message.attachment_meta.deal_digest : [];
    // Длинная подборка (20 игр) — сначала 10 строк, остальное по кнопке «Показать ещё», чтобы
    // карточка не растягивала чат на два экрана.
    const SHOW = 10;
    const rows = items.map((x, i) => {
        const url = dealSafeUrl(x.url), img = dealSafeUrl(x.image);
        const rating = x.rating ? ` · ★ ${Number(x.rating)}%` : "";
        return `
            <a class="deal-row${i >= SHOW ? " deal-row-more" : ""}" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">
                ${img ? `<img src="${escapeHTML(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="deal-row-ph">🔥</span>`}
                <span class="deal-row-copy">
                    <span class="deal-row-title">${escapeHTML(x.title || "")}</span>
                    <span class="deal-row-sub"><span class="deal-row-badge">−${Number(x.discount) || 0}%</span> <b>${escapeHTML(x.priceNew || "")}</b>${x.priceOld ? ` <s>${escapeHTML(x.priceOld)}</s>` : ""}${escapeHTML(rating)}</span>
                </span>
            </a>`;
    }).join("");
    const stale = auroraStaleHTML(message.attachment_meta?.checked_at || message.created_at, 24 * 3600000, "цены могли измениться, в Steam всегда актуальные");
    const more = items.length > SHOW
        ? `<button type="button" class="deal-more-btn" onclick="event.stopPropagation(); this.closest('.deal-digest').classList.add('is-expanded'); this.remove()">Показать ещё ${items.length - SHOW}</button>`
        : "";
    return `<div class="deal-list deal-digest"><div class="deal-list-head">🔥 Скидки дня в Steam · ${items.length}</div>${stale}${rows}${more}</div>`;
}
