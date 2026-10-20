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

// Прогноз на неделю (attachment_meta.week): строка на день, полоска температуры от минимума до
// максимума недели, осадки, ветер; опасные дни отмечены.
function buildMayakWeekHTML(wk) {
    const days = Array.isArray(wk?.days) ? wk.days : [];
    if (!days.length) return "";
    const lo = Math.min(...days.map((d) => Number(d.min)).filter(Number.isFinite));
    const hi = Math.max(...days.map((d) => Number(d.max)).filter(Number.isFinite));
    const span = Math.max(1, hi - lo);
    const rows = days.map((d) => {
        const left = ((Number(d.min) - lo) / span) * 100, width = Math.max(6, ((Number(d.max) - Number(d.min)) / span) * 100);
        const rain = Number(d.mm) > 0 || Number(d.pp) >= 40
            ? `💧${Number(d.pp) >= 0 && d.pp !== null ? `${Number(d.pp)}%` : ""}${Number(d.mm) ? ` ${Number(d.mm)} мм` : ""}` : "";
        const snow = Number(d.snow) >= 1 ? `❄️ ${Number(d.snow)} см` : "";
        const wind = Number(d.gust) >= 15 ? `💨 ${Number(d.gust)} м/с` : "";
        return `
            <div class="wk-row${d.warn ? " is-warn" : ""}">
                <span class="wk-day">${escapeHTML(d.label || d.date || "")}</span>
                <span class="wk-icon" title="${escapeHTML(d.desc || "")}">${escapeHTML(d.icon || "")}</span>
                <span class="wk-temps">
                    <span class="wk-min">${escapeHTML(mayakSigned(d.min))}</span>
                    <span class="wk-bar"><span style="left:${left.toFixed(1)}%;width:${Math.min(100 - left, width).toFixed(1)}%"></span></span>
                    <span class="wk-max">${escapeHTML(mayakSigned(d.max))}</span>
                </span>
                <span class="wk-extra">${escapeHTML([d.warn ? "⚠️" : "", snow || rain, wind].filter(Boolean).join(" · ")) || "&nbsp;"}</span>
            </div>`;
    }).join("");
    return `<div class="wk-card"><div class="wk-head">📅 ${escapeHTML(wk.city || "")} · на неделю</div>${rows}</div>`;
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

// Отключения по адресам (attachment_meta.outages_summary): по дому — что и когда, или «всё в порядке».
function buildMayakOutagesHTML(list, { inline = false } = {}) {
    const houses = Array.isArray(list) ? list : [];
    if (!houses.length) return "";
    const rows = houses.map((h) => {
        const items = (Array.isArray(h.outages) ? h.outages : []).map((o) => `
            <div class="mk-off-item ${o.planned ? "planned" : "now"}">
                <div class="mk-off-what">${escapeHTML(o.icon || "⚠️")} <b>${escapeHTML(o.status || "")} ${escapeHTML(o.gen || o.label || "")}</b></div>
                <div class="mk-off-when">${escapeHTML([o.when, o.hint].filter(Boolean).join(" "))}</div>
                ${o.reason ? `<div class="mk-off-sub">${escapeHTML(o.reason)}</div>` : ""}
                ${o.org ? `<div class="mk-off-sub">${escapeHTML([o.org, o.phones].filter(Boolean).join(" · "))}</div>` : ""}
            </div>`).join("");
        const url = dealSafeUrl(h.url);
        return `
            <div class="mk-off-house">
                <div class="mk-off-name">${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">🏠 ${escapeHTML(h.name || "")}</a>` : `🏠 ${escapeHTML(h.name || "")}`}</div>
                ${items || `<div class="mk-off-ok">✅ Отключений нет и не запланировано</div>`}
            </div>`;
    }).join("");
    return `<div class="mk-off${inline ? " is-inline" : ""}"><div class="mk-news-head">🏠 ${inline ? "По вашему адресу" : "Отключения по вашим адресам"}</div>${rows}<div class="mk-off-src">Данные: VL.ru · Отключения</div></div>`;
}

/* ---- транспорт: «как добраться» (attachment_meta.trip) и маршрут (attachment_meta.route_info) ---- */

function mayakLegHTML(l) {
    const when = l.next?.length ? `${l.next_day ? "сегодня уже нет · завтра с" : "ближайшие"} ≈ <b>${l.next.map(escapeHTML).join(", ")}</b>` : "";
    const freq = l.frequent ? `ходит часто, каждые ~${Number(l.interval) || 5} мин` : l.interval ? `каждые ~${Number(l.interval)} мин` : l.per_day ? `редко: ${Number(l.per_day)} рейс. в день` : (!l.next?.length ? "расписания нет — уточняйте на остановке" : "");
    return `
        <div class="tr-leg">
            <span class="tr-num t${Number(l.type) || 0}">${escapeHTML(l.icon || "🚌")} ${escapeHTML(l.num || "")}</span>
            <div class="tr-leg-body">
                <div class="tr-stops"><span class="tr-dot"></span>${escapeHTML(l.board || "")}<span class="tr-line"></span><span class="tr-dot end"></span>${escapeHTML(l.alight || "")}</div>
                <div class="tr-meta">${escapeHTML(`${l.stops} ост. · ~${l.minutes} мин`)}${l.to_end ? ` · <span title="Направление">→ ${escapeHTML(l.to_end)}</span>` : ""}</div>
                ${when || freq ? `<div class="tr-when">${[when, escapeHTML(freq)].filter(Boolean).join(" · ")}</div>` : ""}
            </div>
        </div>`;
}

function buildMayakTripHTML(t) {
    if (!t) return "";
    const options = Array.isArray(t.options) ? t.options : [];
    const rail = Array.isArray(t.rail) ? t.rail : [];
    const opts = options.map((o, k) => `
        <div class="tr-option${k === 0 ? " is-best" : ""}">
            <div class="tr-option-head">
                <span>${o.legs.length > 1 ? "С пересадкой" : "Без пересадок"}</span>
                <b>~${Number(o.minutes) || 0} мин в пути</b>
            </div>
            ${o.legs.map(mayakLegHTML).join(`<div class="tr-transfer">↓ пересадка на «${escapeHTML(o.legs[0]?.alight || "")}»</div>`)}
        </div>`).join("");
    const railIcon = { train: "🚆", express: "🚄", bus: "🚌" };
    const railRows = rail.map((r) => {
        const url = dealSafeUrl(r.url);
        return `<a class="tr-rail-row"${url ? ` href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer"` : ""}>
            <span class="tr-rail-time">${escapeHTML(r.dep || "")}<small>→ ${escapeHTML(r.arr || "")}</small></span>
            <span class="tr-rail-copy"><span>${escapeHTML(railIcon[r.kind] || "🚏")} ${escapeHTML(r.name || "")}</span><small>${escapeHTML([r.num && `№${r.num}`, r.travel, r.price, r.day === "завтра" ? "завтра" : ""].filter(Boolean).join(" · "))}</small></span>
        </a>`;
    }).join("");
    const maps = dealSafeUrl(t.maps);
    const empty = !options.length && !rail.length;
    return `
        <div class="tr-card">
            <div class="tr-head">
                <span class="tr-icon">${t.kind === "rail" ? "🚆" : "🧭"}</span>
                <div class="tr-route"><span>${escapeHTML(t.from?.label || "")}</span><span class="tr-arrow">→</span><span>${escapeHTML(t.to?.label || "")}</span></div>
            </div>
            ${t.same ? `<div class="tr-empty">Это одна и та же остановка 🙂</div>` : ""}
            ${opts}
            ${empty && !t.same ? `<div class="tr-empty">Не нашёл прямых вариантов и вариантов с одной пересадкой 😕 Откройте маршрут в 2ГИС — там пешие участки и маршрутки.</div>` : ""}
            ${railRows ? `<div class="tr-rail">${t.kind === "rail" ? "" : `<div class="tr-rail-head">🚆 Электрички и межгород</div>`}${railRows}</div>` : ""}
            ${t.kind === "rail" ? `<div class="tr-note">Данные: VL.ru · Транспорт. Нажмите на рейс — все остановки.</div>` : ""}
            ${maps ? `<a class="tr-maps" href="${escapeHTML(maps)}" target="_blank" rel="noopener noreferrer">🗺 Открыть маршрут в 2ГИС</a>` : ""}
            ${options.length ? `<div class="tr-note">${escapeHTML(t.note || "Время примерное.")}</div>` : ""}
        </div>`;
}

/* ---- аэропорт, аэроэкспресс, паромы ---- */

function mayakFlightStatusClass(s) {
    return /задерж|отмен/i.test(s || "") ? "bad" : /вылетел|прибыл/i.test(s || "") ? "done" : "ok";
}

function buildMayakFlightHTML(f) {
    if (!f) return "";
    const late = f.actual && f.actual !== f.sched;
    return `
        <div class="tr-card fl-card">
            <div class="fl-top">
                <span class="fl-dir">${f.dir === "departure" ? "🛫 Вылет" : "🛬 Прилёт"}</span>
                <span class="fl-status ${mayakFlightStatusClass(f.status)}">${escapeHTML(f.status || "нет статуса")}</span>
            </div>
            <div class="fl-num">${escapeHTML(f.num || "")} <small>${escapeHTML(f.airline || "")}</small></div>
            <div class="fl-route">${f.dir === "departure" ? `Владивосток → ${escapeHTML(f.city || "")}` : `${escapeHTML(f.city || "")} → Владивосток`}</div>
            <div class="fl-times">
                <div><small>${escapeHTML(f.day || "")} по расписанию</small><b class="${late ? "is-old" : ""}">${escapeHTML(f.sched || "—")}</b></div>
                ${late ? `<div><small>фактически</small><b class="${f.delay ? "is-late" : ""}">${escapeHTML(f.actual)}</b>${f.delay ? `<em>+${Number(f.delay)} мин</em>` : ""}</div>` : ""}
                ${f.terminal ? `<div><small>терминал</small><b>${escapeHTML(f.terminal)}</b></div>` : ""}
            </div>
            ${f.aircraft ? `<div class="tr-note">${escapeHTML(f.aircraft)}</div>` : ""}
            ${f.tracking ? `<div class="fl-live">🔔 Слежу: карточка обновляется сама, о задержке и посадке напишу${f.dir === "arrival" ? ", а за ~40 минут до посадки — напомню выезжать" : ""}</div>` : ""}
            <div class="tr-note">Данные: онлайн-табло аэропорта (VL.ru) · ${escapeHTML(mayakTimeText(f.checked_at))}</div>
        </div>`;
}

function buildMayakBoardHTML(b) {
    const items = Array.isArray(b?.items) ? b.items : [];
    const rows = items.map((f) => `
        <div class="fl-row">
            <span class="fl-row-time">${escapeHTML(f.actual && f.actual !== f.sched ? f.actual : f.sched)}${f.actual && f.actual !== f.sched ? `<s>${escapeHTML(f.sched)}</s>` : ""}${f.day !== "сегодня" ? `<small>${escapeHTML(f.day)}</small>` : ""}</span>
            <span class="fl-row-copy"><b>${escapeHTML(f.city || "")}</b><small>${escapeHTML([f.num, f.airline, f.terminal && `терм. ${f.terminal}`].filter(Boolean).join(" · "))}</small></span>
            <span class="fl-status ${mayakFlightStatusClass(f.status)}">${escapeHTML(f.status || "")}</span>
        </div>`).join("");
    return `<div class="tr-card"><div class="tr-head"><span class="tr-icon">${b.dir === "departure" ? "🛫" : "🛬"}</span><div class="tr-route"><span>${b.dir === "departure" ? "Вылет из Владивостока" : "Прилёт во Владивосток"}${b.city ? ` · ${escapeHTML(b.city)}` : ""}</span></div></div>${rows || `<div class="tr-empty">Рейсов не нашёл</div>`}<div class="tr-note">Номер рейса из списка → «/рейс SU-5803» — карточка и слежка</div></div>`;
}

function buildMayakAeroexpressHTML(a) {
    const col = (title, list) => `<div class="ae-col"><div class="tr-rail-head">${title}</div>${(list || []).map((r) => `<div class="tr-rail-row"><span class="tr-rail-time">${escapeHTML(r.dep)}<small>→ ${escapeHTML(r.arr)}</small></span><span class="tr-rail-copy"><span>№${escapeHTML(r.num)}</span><small>${escapeHTML([r.day === "завтра" ? "завтра" : "", r.days].filter(Boolean).join(" · "))}</small></span></div>`).join("") || `<div class="tr-empty">нет рейсов</div>`}</div>`;
    return `<div class="tr-card"><div class="tr-head"><span class="tr-icon">🚄</span><div class="tr-route"><span>Аэроэкспресс · Владивосток ⇄ Кневичи</span></div></div>${col("В аэропорт", a?.to_airport)}${col("Из аэропорта", a?.from_airport)}<div class="tr-note">Данные: VL.ru · Транспорт</div></div>`;
}

function buildMayakFerriesHTML(f) {
    const block = (title, list) => `<div class="tr-rail-head">${title}</div>${(list || []).map((r) => `
        <div class="fe-route">
            <b>${escapeHTML(r.route)}</b>
            ${(r.variants || []).map((v) => `<div class="fe-var"><span class="fe-times">${(v.times || []).map((t) => `<span>${escapeHTML(t)}</span>`).join("")}</span><small>${escapeHTML([v.days, v.travel, v.price].filter(Boolean).join(" · "))}</small></div>`).join("")}
        </div>`).join("")}`;
    return `<div class="tr-card"><div class="tr-head"><span class="tr-icon">⛴</span><div class="tr-route"><span>Паромы и катера</span></div></div>${block("Из Владивостока", f?.out)}${block("Во Владивосток", f?.in)}<div class="tr-empty">☎️ Перед поездкой уточняйте по телефону <b>${escapeHTML(f?.phone || "")}</b> — в шторм рейсы отменяют</div></div>`;
}

function buildMayakRouteInfoHTML(list) {
    return (Array.isArray(list) ? list : []).map((r) => `
        <div class="tr-card">
            <div class="tr-head"><span class="tr-num big t${Number(r.type) || 0}">${escapeHTML(r.icon || "🚌")} ${escapeHTML(r.num || "")}</span><div class="tr-route"><span>${escapeHTML(r.title || "")}</span></div></div>
            ${(r.dirs || []).map((d) => `
                <details class="tr-dir">
                    <summary>
                        <span class="tr-dir-name">${escapeHTML(d.from)} → ${escapeHTML(d.to)}</span>
                        <span class="tr-dir-meta">${escapeHTML([`${(d.stops || []).length} ост.`, d.first && d.last ? `${d.first}–${d.last}` : "", d.frequent ? `ходит часто, каждые ~${d.interval || 5} мин` : d.interval ? `каждые ~${d.interval} мин` : "", !d.first && !d.frequent ? "расписания нет" : ""].filter(Boolean).join(" · "))}${d.next?.length ? ` · ближайшие ≈ <b>${d.next.map(escapeHTML).join(", ")}</b>` : ""}</span>
                    </summary>
                    <ol class="tr-dir-stops">${(d.stops || []).map((s) => `<li>${escapeHTML(s)}</li>`).join("")}</ol>
                </details>`).join("")}
            <div class="tr-note">Время примерное — по расписанию Bustime.</div>
        </div>`).join("");
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
                ${m.outages_summary ? buildMayakOutagesHTML(m.outages_summary, { inline: true }) : ""}
                ${buildMayakNewsHTML(m.news_list)}
            </div>`;
    }
    if (m.flight) return buildMayakFlightHTML(m.flight);
    if (m.flight_board) return buildMayakBoardHTML(m.flight_board);
    if (m.aeroexpress) return buildMayakAeroexpressHTML(m.aeroexpress);
    if (m.ferries) return buildMayakFerriesHTML(m.ferries);
    if (m.trip) return buildMayakTripHTML(m.trip);
    if (m.route_info) return `<div class="mk-wrap">${buildMayakRouteInfoHTML(m.route_info)}</div>`;
    if (m.outages_summary) return `<div class="mk-wrap">${buildMayakOutagesHTML(m.outages_summary)}</div>`;
    if (m.week) return `<div class="mk-wrap">${typeof auroraStaleHTML === "function" ? auroraStaleHTML(m.checked_at || message.created_at, 12 * 3600000, "нажмите «Обновить»") : ""}${buildMayakWeekHTML(m.week)}</div>`;
    if (m.weather) return `<div class="mk-wrap">${stale}${buildMayakWeatherHTML(m.weather)}</div>`;
    if (m.news_list) return `<div class="mk-wrap">${stale}${buildMayakNewsHTML(m.news_list)}</div>`;
    return "";
}

/* ---- Места для Маяка ищет сама программа ----------------------------------------------------------
   С облачного сервера Supabase карты (OpenStreetMap: Nominatim, Photon) отвечают плохо, а с телефона
   и ПК — быстро. Поэтому перед отправкой «как добраться с … до …» в чат с Маяком программа находит оба
   места и кладёт координаты в сообщение (attachment_meta.geo) — Маяку не нужно ходить на карту. */

function mayakParseTrip(text) {
    const t = String(text || "").replace(/@mayak_bot/gi, "").replace(/[?!.]+$/g, "").trim();
    const dash = /^\/?(?:маршрут|доехать|добраться|путь)\s+(.+?)\s*(?:—|–|-|→|->|>)\s*(.+)$/i.exec(t);
    if (dash) return { from: dash[1].trim(), to: dash[2].trim() };
    const body = t.replace(/^\/?маршрут\s+/i, "")
        .replace(/^(?:а\s+)?(?:как|чем|на\s+ч[её]м)\s+(?:мне\s+|нам\s+|можно\s+)?(?:добраться|доехать|проехать|попасть|ехать|уехать)\s*/i, "")
        .replace(/^(?:добраться|доехать|проехать)\s+/i, "");
    const m = /^(?:с|со|от|из)\s+(.+?)\s+(?:до|в|во|на|к)\s+(.+)$/i.exec(body);
    return m ? { from: m[1].trim(), to: m[2].trim() } : null;
}

const MAYAK_BOX = { nominatim: "131.70,43.35,132.25,42.90", photon: "131.70,42.90,132.25,43.35" };
async function mayakGeocode(text) {
    const timeout = (ms) => new Promise((r) => setTimeout(() => r(null), ms));
    const nominatim = fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format: "jsonv2", limit: "1", countrycodes: "ru", "accept-language": "ru", viewbox: MAYAK_BOX.nominatim, bounded: "1", q: text })}`)
        .then((r) => r.ok ? r.json() : []).then((j) => (j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon), name: j[0].name || "" } : null)).catch(() => null);
    const photon = fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&bbox=${MAYAK_BOX.photon}&limit=1`)
        .then((r) => r.ok ? r.json() : null).then((j) => { const f = j?.features?.[0]; return f ? { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: f.properties?.name || "" } : null; }).catch(() => null);
    // Первый найденный ответ, но не дольше 3,5 секунды — без координат Маяк всё равно ответит.
    return new Promise((resolve) => {
        let left = 2;
        const done = (v) => { if (v) resolve(v); else if (!--left) resolve(null); };
        nominatim.then(done); photon.then(done); timeout(3500).then(() => resolve(null));
    });
}

(function mayakGeoAssist() {
    if (typeof KabanAPI === "undefined" || typeof KabanAPI.sendMessage !== "function" || KabanAPI.__mayakGeo) return;
    const original = KabanAPI.sendMessage.bind(KabanAPI);
    KabanAPI.__mayakGeo = true;
    KabanAPI.sendMessage = async function (chatId, opts = {}) {
        try {
            const inMayakChat = typeof currentChatId !== "undefined" && chatId === currentChatId && typeof botsInCurrentChat === "function" && botsInCurrentChat().includes("mayak");
            const q = inMayakChat && opts && (opts.type || "text") === "text" && !opts.encryptionIv && typeof opts.text === "string" ? mayakParseTrip(opts.text) : null;
            if (q) {
                const [a, b] = await Promise.all([mayakGeocode(q.from), mayakGeocode(q.to)]);
                if (a || b) opts = { ...opts, attachmentMeta: { ...(opts.attachmentMeta || {}), geo: { from: a && { ...a, text: q.from }, to: b && { ...b, text: q.to } } } };
            }
        } catch (e) { console.warn("Маяк: не удалось найти места на карте", e); }
        return original(chatId, opts);
    };
})();

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
                <div class="aur-actions">${action("📅 На неделю", "/неделя")}${action("🌦 Погода сейчас", "/погода")}</div>
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

            <section class="aur-sec${(p.addresses || []).length ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">🏠</span>
                    <span class="aur-row-copy"><b>Отключения по адресу</b><span>${escapeHTML((p.addresses || []).length ? "Вода, свет, тепло в ваших домах — предупрежу заранее, о каждом один раз" : "Укажите дом — предупрежу об отключении воды, света и тепла заранее")}</span></span>
                </div>
                ${(p.addresses || []).length ? `<div class="aur-apps">${p.addresses.map((a) => `
                    <div class="aur-app mk-addr">
                        <span class="aur-app-copy">
                            <span class="aur-app-name">${escapeHTML(a.name || "")}</span>
                            <span class="aur-app-sub">${a.outages === null || a.outages === undefined ? "проверяю каждый час" : Number(a.outages) ? `⚠️ отключений: ${Number(a.outages)}` : "✅ отключений нет"}</span>
                        </span>
                        <button type="button" class="aur-icon-btn danger" title="Убрать адрес" aria-label="Убрать ${escapeHTML(a.name || "")}" data-cmd="/адрес убрать #${escapeHTML(a.slug || "")}" onclick="auroraPress(event, this)">✕</button>
                    </div>`).join("")}</div>` : ""}
                <div class="aur-actions">
                    <span class="aur-pill">${(p.addresses || []).length} из ${Number(p.max_addresses) || 3}</span>
                    ${(p.addresses || []).length ? action("Проверить сейчас", "/отключения") : ""}
                    ${(p.addresses || []).length < (Number(p.max_addresses) || 3) ? `<button type="button" class="aur-action" data-cmd="@input:/адрес " onclick="auroraPress(event, this)">＋ Добавить адрес</button>` : ""}
                </div>
            </section>
            <section class="aur-sec is-on">
                <div class="aur-row">
                    <span class="aur-row-icon">🧭</span>
                    <span class="aur-row-copy"><b>Транспорт</b><span>Как добраться по городу: какие автобусы, где сесть и выйти, когда ближайший. Электрички и межгород — с VL.ru</span></span>
                </div>
                <div class="aur-actions">
                    <button type="button" class="aur-action" data-cmd="@input:/маршрут " onclick="auroraPress(event, this)">🧭 Как добраться</button>
                    <button type="button" class="aur-action" data-cmd="@input:/автобус " onclick="auroraPress(event, this)">🚌 Автобус №</button>
                    <button type="button" class="aur-action" data-cmd="/электричка" onclick="auroraPress(event, this)">🚆 Электрички</button>
                    <button type="button" class="aur-action" data-cmd="/рейс" onclick="auroraPress(event, this)">✈️ Аэропорт</button>
                    <button type="button" class="aur-action" data-cmd="/аэроэкспресс" onclick="auroraPress(event, this)">🚄 Аэроэкспресс</button>
                    <button type="button" class="aur-action" data-cmd="/паром" onclick="auroraPress(event, this)">⛴ Паромы</button>
                </div>
            </section>

            <section class="aur-sec${p.quiet_on ? " is-on" : ""}">
                <div class="aur-row">
                    <span class="aur-row-icon">🌙</span>
                    <span class="aur-row-copy"><b>Тихие часы</b><span>${escapeHTML(p.quiet_on ? quietText : "Выключено — предупреждаю в любое время, даже ночью")}</span></span>
                    ${sw(!!p.quiet_on, "/тихие вкл", "/тихие выкл", "Тихие часы")}
                </div>
            </section>
            <div class="aur-foot">Источники: Open-Meteo, VL.ru (новости и «Отключения»), ГУ МЧС по Приморскому краю · меню исчезнет через 15 минут после последнего нажатия</div>
        </div>`;
}
