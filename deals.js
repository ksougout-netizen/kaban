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
    return `<div class="deal-list"><div class="deal-list-head">🎁 Сейчас бесплатно</div>${rows || `<div class="deal-row-sub">Ничего не раздают</div>`}</div>`;
}

// «Скидки дня» — подборка Авроры одним сообщением (attachment_meta.deal_digest).
function buildDealDigestHTML(message) {
    const items = Array.isArray(message.attachment_meta?.deal_digest) ? message.attachment_meta.deal_digest : [];
    const rows = items.map((x) => {
        const url = dealSafeUrl(x.url), img = dealSafeUrl(x.image);
        const rating = x.rating ? ` · ★ ${Number(x.rating)}%` : "";
        return `
            <a class="deal-row" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">
                ${img ? `<img src="${escapeHTML(img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="deal-row-ph">🔥</span>`}
                <span class="deal-row-copy">
                    <span class="deal-row-title">${escapeHTML(x.title || "")}</span>
                    <span class="deal-row-sub"><span class="deal-row-badge">−${Number(x.discount) || 0}%</span> <b>${escapeHTML(x.priceNew || "")}</b>${x.priceOld ? ` <s>${escapeHTML(x.priceOld)}</s>` : ""}${escapeHTML(rating)}</span>
                </span>
            </a>`;
    }).join("");
    return `<div class="deal-list deal-digest"><div class="deal-list-head">🔥 Скидки дня в Steam</div>${rows}</div>`;
}
