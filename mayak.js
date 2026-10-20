/* =====================================================================================================
   КАРТОЧКИ МАЯКА (@mayak_bot): погода, новости Владивостока, предупреждения, утренняя сводка и меню
   «⚙️ Маяк в этом чате» — см. supabase/functions/mayak-bot. Кнопки и переключатели — общие с Авророй
   (deals.js: buildBotButtonsHTML, auroraPress, auroraSwitchHTML, auroraStaleHTML, auroraWhenText).
   Старые версии программы показывают вместо карточек текст сообщения — он есть всегда.
   ===================================================================================================== */

const mayakSigned = (t) => (t === null || t === undefined || !Number.isFinite(Number(t)) ? "—" : `${Number(t) > 0 ? "+" : ""}${Number(t)}°`);

// Тема карточки по погоде: солнце, облака, дождь, снег, туман, гроза.
function mayakWeatherTheme(code) {
    const c = Number(code);
    if (c >= 95) return "storm";
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
    if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return "rain";
    if (c === 45 || c === 48) return "fog";
    if (c === 2 || c === 3) return "cloud";
    return "sun";
}

function buildMayakWeatherHTML(w, { compact = false } = {}) {
    if (!w) return "";
    const hazards = (Array.isArray(w.hazards) ? w.hazards : []).map((h) =>
        `<div class="wx-hazard ${h.level === "danger" ? "danger" : ""}">${h.level === "danger" ? "🚨" : "⚠️"} ${escapeHTML(h.title || "")}</div>`).join("");
    const hours = (Array.isArray(w.hours) ? w.hours : []).map((h) => `
        <div class="wx-hour">
            <span class="wx-hour-t">${escapeHTML(String(h.t || ""))}</span>
            <span class="wx-hour-i">${escapeHTML(String(h.icon || ""))}</span>
            <b>${escapeHTML(mayakSigned(h.temp))}</b>
            <span class="wx-hour-p">${Number(h.pp) >= 20 ? `💧${Number(h.pp)}%` : "&nbsp;"}</span>
        </div>`).join("");
    const today = w.today ? `Днём ${mayakSigned(w.today.min)}…${mayakSigned(w.today.max)}${Number(w.today.mm) ? ` · осадки ${Number(w.today.mm)} мм` : ""}${Number(w.today.snow) ? ` · снег ${Number(w.today.snow)} см` : ""}` : "";
    const sea = w.sea ? `🌊 Море ${Number(w.sea.temp)}° · волна ${Number(w.sea.wave)} м` : "";
    const sun = w.today?.sunrise ? `🌅 ${escapeHTML(w.today.sunrise)} · 🌇 ${escapeHTML(w.today.sunset || "")}` : "";
    const tomorrow = w.tomorrow ? `Завтра: ${escapeHTML(w.tomorrow.icon || "")} ${mayakSigned(w.tomorrow.min)}…${mayakSigned(w.tomorrow.max)}, ${escapeHTML(String(w.tomorrow.desc || "").toLowerCase())}` : "";
    const advice = (Array.isArray(w.advice) ? w.advice : []).map((a) => `<li>${escapeHTML(a)}</li>`).join("");
    return `
        <div class="wx-card wx-${mayakWeatherTheme(w.code)}${compact ? " is-compact" : ""}">
            <div class="wx-head">
                <span class="wx-city">${escapeHTML(w.city || "")}</span>
                <span class="wx-desc">${escapeHTML(w.desc || "")}</span>
            </div>
            <div class="wx-main">
                <span class="wx-icon">${escapeHTML(w.icon || "")}</span>
                <span class="wx-temp">${escapeHTML(mayakSigned(w.temp))}</span>
                <span class="wx-side">ощущается ${escapeHTML(mayakSigned(w.feels))}<br>💨 ${Number(w.wind) || 0} м/с, порывы до ${Number(w.gust) || 0}</span>
            </div>
            ${hazards}
            ${hours ? `<div class="wx-hours">${hours}</div>` : ""}
            <div class="wx-facts">${[today, sea, sun].filter(Boolean).map((x) => `<span>${x.includes("<") ? x : escapeHTML(x)}</span>`).join("")}</div>
            ${tomorrow ? `<div class="wx-tomorrow">${tomorrow}</div>` : ""}
            ${advice ? `<ul class="wx-advice">${advice}</ul>` : ""}
        </div>`;
}

function mayakTimeText(iso) {
    const t = Date.parse(iso || "");
    if (!Number.isFinite(t)) return "";
    const d = new Date(t), now = new Date();
    const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).replace(".", "")}, ${hm}`;
}

function buildMayakNewsHTML(list) {
    if (!list) return "";
    const items = Array.isArray(list.items) ? list.items : [];
    const rows = items.map((n) => {
        const url = dealSafeUrl(n.url), img = dealSafeUrl(n.image);
        return `
            <a class="mk-news-row" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">
                ${img ? `<img src="${escapeHTML(img)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
                <span class="mk-news-copy">
                    <span class="mk-news-title">${escapeHTML(n.title || "")}</span>
                    <span class="mk-news-sub">${escapeHTML([mayakTimeText(n.date), n.tag, n.source].filter(Boolean).join(" · "))}</span>
                </span>
            </a>`;
    }).join("");
    return `<div class="mk-news"><div class="mk-news-head">${escapeHTML(list.title || "📰 Новости")}</div>${rows || `<div class="mk-news-sub">Свежих новостей нет</div>`}</div>`;
}

function buildMayakAlertHTML(message) {
    const a = message.attachment_meta?.alert || {};
    const url = dealSafeUrl(a.url);
    return `
        <div class="mk-alert ${a.level === "danger" ? "danger" : "warn"}">
            <div class="mk-alert-top"><span class="mk-alert-badge">${a.level === "danger" ? "🚨 Опасно" : "⚠️ Внимание"}</span>${a.source ? `<span class="mk-alert-src">${escapeHTML(a.source)}</span>` : ""}</div>
            <div class="mk-alert-title">${escapeHTML(a.title || "")}</div>
            ${a.text ? `<div class="mk-alert-text">${escapeHTML(a.text)}</div>` : ""}
            ${url ? `<a class="mk-alert-btn" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Подробнее</a>` : ""}
        </div>`;
}

// «Доброе утро / день / вечер» — по времени, когда пришла сводка (её можно запросить и вечером).
function mayakGreeting(iso) {
    const h = new Date(iso).getHours();
    return h >= 5 && h < 12 ? "☀️ Доброе утро" : h >= 12 && h < 18 ? "🌤 Добрый день" : h >= 18 && h < 23 ? "🌆 Добрый вечер" : "🌙 Доброй ночи";
}

// Сообщения Маяка: сводка (погода + МЧС + новости), отдельная погода, отдельные новости.
function buildMayakMessageHTML(message) {
    const m = message.attachment_meta || {};
    if (m.alert) return buildMayakAlertHTML(message);
    const stale = typeof auroraStaleHTML === "function"
        ? auroraStaleHTML(m.checked_at || message.created_at, m.brief ? 20 * 3600000 : 3 * 3600000, m.brief ? "сводка за прошлый день" : "нажмите «Обновить»") : "";
    if (m.brief) {
        const day = new Date(message.created_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
        return `
            <div class="mk-brief">
                <div class="mk-brief-head">${escapeHTML(mayakGreeting(message.created_at))} · ${escapeHTML(day)}</div>
                ${stale}
                ${buildMayakWeatherHTML(m.weather, { compact: true })}
                ${m.mchs ? `<div class="mk-alert warn is-inline"><div class="mk-alert-top"><span class="mk-alert-badge">⚠️ МЧС</span></div><div class="mk-alert-text">${escapeHTML(m.mchs.text || "")}</div>${dealSafeUrl(m.mchs.url) ? `<a class="mk-alert-btn" href="${escapeHTML(dealSafeUrl(m.mchs.url))}" target="_blank" rel="noopener noreferrer">Прогноз МЧС</a>` : ""}</div>` : ""}
                ${buildMayakNewsHTML(m.news_list)}
            </div>`;
    }
    if (m.weather) return `<div class="mk-wrap">${stale}${buildMayakWeatherHTML(m.weather)}</div>`;
    if (m.news_list) return `<div class="mk-wrap">${stale}${buildMayakNewsHTML(m.news_list)}</div>`;
    return "";
}

/* ---- «⚙️ Маяк в этом чате» (attachment_meta.mayak_panel) ---- */

function buildMayakPanelHTML(message) {
    const p = message.attachment_meta?.mayak_panel || {};
    const nextMorning = typeof auroraNextAt === "function" ? auroraNextAt(p.next?.morning, 86400000) : Date.parse(p.next?.morning || "");
    const when = (t) => (typeof auroraWhenText === "function" ? auroraWhenText(t) : "");
    const sw = (on, cmdOn, cmdOff, label) => (typeof auroraSwitchHTML === "function" ? auroraSwitchHTML(on, cmdOn, cmdOff, label) : "");
    const chip = (label, cmd, selected, disabled = false) => `<button type="button" class="aur-chip${selected ? " is-selected mk-chip-sel" : ""}" data-cmd="${escapeHTML(cmd)}" onclick="auroraPress(event, this)" ${disabled ? "disabled" : ""}>${escapeHTML(label)}</button>`;
    const action = (label, cmd) => `<button type="button" class="aur-action" data-cmd="${escapeHTML(cmd)}" onclick="auroraPress(event, this)">${label}</button>`;
    const cities = (Array.isArray(p.cities) ? p.cities : []).map((c) => chip(c.name, `/город ${c.name}`, c.k === p.city)).join("");
    const hours = (Array.isArray(p.morning_hours) ? p.morning_hours : [6, 7, 8, 9]).map((h) => chip(`${String(h).padStart(2, "0")}:00`, `/сводка ${h}`, Number(p.morning_hour) === Number(h), !p.morning_on)).join("");
    const quietText = typeof auroraQuietText === "function" ? auroraQuietText({ ...p, quiet_on: p.quiet_on }).replace("раздачи и новости не присылаю", "присылаю только самое опасное (тайфун, ЧС)").replace(/ — утром в .*$/, "") : "";
    const wn = p.weather_now;

    return `
        <div class="aur-panel mk-panel${p.paused ? " is-paused" : ""}">
            <div class="aur-head">
                <span class="aur-title">⚙️ Маяк в этом чате</span>
                <button type="button" class="aur-refresh" title="Обновить" aria-label="Обновить" data-cmd="/настройки" onclick="auroraPress(event, this)">⟳</button>
            </div>
            ${typeof auroraStaleHTML === "function" ? auroraStaleHTML(p.updated_at || message.created_at, 6 * 3600000, "нажмите ⟳, чтобы обновить") : ""}
            ${p.notice ? `<div class="aur-notice">${escapeHTML(p.notice)}</div>` : ""}
            ${p.paused ? `<div class="aur-paused">⏸ Сейчас я ничего не присылаю сам — включите сводку или предупреждения</div>` : ""}

            <section class="aur-sec is-on">
                <div class="aur-row">
                    <span class="aur-row-icon">🏙</span>
                    <span class="aur-row-copy"><b>${escapeHTML(p.city_name || "Владивосток")}</b><span>${wn ? `Сейчас ${escapeHTML(wn.icon || "")} ${escapeHTML(mayakSigned(wn.temp))}, ${escapeHTML(String(wn.desc || "").toLowerCase())}` : "Город для погоды и предупреждений"}</span></span>
                </div>
                <div class="aur-chips"><span class="aur-chips-label">Город:</span>${cities}</div>
                <div class="aur-actions">${action("🌦 Погода сейчас", "/погода")}</div>
            </section>

            <section class="aur-sec${p.morning_on ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">☀️</span>
                    <span class="aur-row-copy"><b>Утренняя сводка</b><span>${escapeHTML(p.morning_on ? `Погода, что надеть${p.news_on ? ", главные новости" : ""} · ${when(nextMorning)}` : "Выключено — сводку не присылаю")}</span></span>
                    ${sw(!!p.morning_on, "/сводка вкл", "/сводка выкл", "Утренняя сводка")}
                </div>
                <div class="aur-chips${p.morning_on ? "" : " is-disabled"}"><span class="aur-chips-label">Во сколько:</span>${hours}</div>
                <div class="aur-row mk-subrow">
                    <span class="aur-row-copy"><span>📰 Новости в сводке</span></span>
                    ${sw(!!p.news_on, "/новостисводка вкл", "/новостисводка выкл", "Новости в сводке")}
                </div>
                <div class="aur-actions">${action("Сводка сейчас", "/сводка")}</div>
            </section>

            <section class="aur-sec${p.alerts_on ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">⚠️</span>
                    <span class="aur-row-copy"><b>Предупреждения</b><span>${escapeHTML(p.alerts_on ? "Шторм, снегопад, гололёд, отключения, перекрытия, ЧС — сразу, как узнаю (не больше 4 новостей в день)" : "Выключено — не предупреждаю")}</span></span>
                    ${sw(!!p.alerts_on, "/предупреждения вкл", "/предупреждения выкл", "Предупреждения")}
                </div>
                <div class="aur-actions">${action("📰 Новости сейчас", "/новости")}</div>
            </section>

            <section class="aur-sec${p.quiet_on ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">🌙</span>
                    <span class="aur-row-copy"><b>Тихие часы</b><span>${escapeHTML(p.quiet_on ? quietText : "Выключено — предупреждаю в любое время, даже ночью")}</span></span>
                    ${sw(!!p.quiet_on, "/тихие вкл", "/тихие выкл", "Тихие часы")}
                </div>
            </section>
            <div class="aur-foot">Источники: Open-Meteo, VL.ru, ГУ МЧС по Приморскому краю · меню исчезнет через 15 минут после последнего нажатия</div>
        </div>`;
}
