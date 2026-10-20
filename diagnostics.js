/* =====================================================================================================
   ЖУРНАЛ ДЛЯ РАЗРАБОТЧИКА (Настройки → Звонки → «Журнал связи»).
   Если у друга не соединяется звонок или пропадает звук, раньше разобраться было не по чему: журнал
   программы лежал только у него на компьютере (а на телефоне и в браузере — нигде). Теперь программа
   сама копит последние события (ошибки, маршрут и пинг звонков, переподключения) — в том числе с
   прошлого запуска, — и одной кнопкой отправляет отчёт файлом в любой чат.
   Из отчёта вырезаются ключи доступа и почта, у внешних IP-адресов скрыта вторая половина.
   Подключается ПЕРВЫМ скриптом страницы — чтобы ловить и ошибки запуска.
   ===================================================================================================== */

(function () {

    const KEY = "kaban-diag-log";
    const MAX = 400;          // событий в памяти
    const KEEP = 250;         // событий, переживающих перезапуск
    const entries = [];

    // Прошлый запуск: его последние события тоже попадут в отчёт («звонок оборвался, я перезапустил»).
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
        if (Array.isArray(saved) && saved.length) {
            entries.push(...saved.slice(-KEEP));
            entries.push({ t: Date.now(), k: "info", m: "———— программа запущена заново ————" });
        }
    } catch { /* нет хранилища — только текущий запуск */ }

    const text = (value) => {
        if (value instanceof Error) return `${value.name}: ${value.message}`;
        if (typeof value === "string") return value;
        try { return JSON.stringify(value); } catch { return String(value); }
    };

    function push(kind, message) {
        entries.push({ t: Date.now(), k: kind, m: String(message).slice(0, 600) });
        if (entries.length > MAX) entries.splice(0, entries.length - MAX);
        scheduleSave();
    }

    let saveTimer = null;
    function scheduleSave() {
        if (saveTimer) return;
        saveTimer = setTimeout(save, 4000);
    }
    function save() {
        clearTimeout(saveTimer);
        saveTimer = null;
        try { localStorage.setItem(KEY, JSON.stringify(entries.slice(-KEEP))); } catch { /* переполнено — не страшно */ }
    }
    window.addEventListener("pagehide", save);

    // Ловим console.error / console.warn — туда программа пишет всё важное о звонках ([call] …, [net] …).
    for (const kind of ["error", "warn"]) {
        const original = console[kind].bind(console);
        console[kind] = (...args) => {
            try { push(kind, args.map(text).join(" ")); } catch { /* журнал не должен ломать программу */ }
            original(...args);
        };
    }
    window.addEventListener("error", (event) => push("error", `${event.message} (${String(event.filename || "").split("/").pop()}:${event.lineno})`));
    window.addEventListener("unhandledrejection", (event) => push("error", "promise: " + text(event.reason)));
    window.addEventListener("online", () => push("net", "сеть появилась (online)"));
    window.addEventListener("offline", () => push("net", "сеть пропала (offline)"));

    /* ---- отчёт ---- */

    // Ключи доступа, почта, токены — вон; внешние IPv4 — только первая половина.
    function scrub(value) {
        return String(value)
            .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "[ключ скрыт]")
            .replace(/(access_token|refresh_token|apikey|password|credential)(["'=:\s]+)[^\s"'&,}]+/gi, "$1$2[скрыто]")
            .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[почта скрыта]")
            .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (ip, a, b) => {
                const n1 = +a, n2 = +b;
                const local = n1 === 10 || n1 === 127 || (n1 === 192 && n2 === 168) || (n1 === 172 && n2 >= 16 && n2 <= 31) || (n1 === 100 && n2 >= 64 && n2 <= 127) || n1 === 0;
                return local ? ip : `${a}.${b}.x.x`;
            });
    }

    const pad = (n, w = 2) => String(n).padStart(w, "0");
    const stamp = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const has = (name) => { try { return typeof window.eval(name) !== "undefined"; } catch { return false; } };
    const val = (expr) => { try { return window.eval(expr); } catch { return undefined; } };

    async function buildReport() {
        const lines = [];
        const add = (s = "") => lines.push(s);
        add("KABAN — журнал для разработчика");
        add(`Создан: ${stamp(Date.now())} (часовой пояс UTC${-new Date().getTimezoneOffset() / 60 >= 0 ? "+" : ""}${-new Date().getTimezoneOffset() / 60})`);

        const web = (document.querySelector('script[src*="script-core.js"]')?.getAttribute("src") || "").split("v=")[1] || "?";
        let platform = "браузер";
        let shell = "";
        if (window.kabanDesktop) {
            platform = "программа для ПК (Windows)";
            try { const info = await window.kabanDesktop.getInfo(); shell = info?.version || info?.shellVersion || ""; } catch { /* старая версия */ }
        } else if (window.Capacitor?.isNativePlatform?.()) platform = "Android";
        add(`Версия: ${web}${shell ? " · программа " + shell : ""} · ${platform}`);
        const chrome = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1];
        add(`Движок: Chrome ${chrome || "?"} · ${navigator.platform || ""} · экран ${screen.width}×${screen.height} · ${navigator.hardwareConcurrency || "?"} ядер · ${navigator.deviceMemory || "?"} ГБ`);
        const me = val("cachedMyProfile");
        if (me) add(`Аккаунт: ${me.display_name || ""}${me.username ? " @" + me.username : ""} (${String(me.id || "").slice(0, 8)})`);

        add();
        add("— Сеть —");
        add(`Интернет: ${navigator.onLine ? "есть" : "НЕТ"}${navigator.connection?.effectiveType ? " · тип " + navigator.connection.effectiveType : ""}`);
        if (has("kabanNet") && has("refreshNetRoutes")) {
            try { await Promise.race([val("refreshNetRoutes")(), new Promise((r) => setTimeout(r, 4000))]); } catch { /* ок */ }
            const net = val("kabanNet");
            add(`Прямой выход в интернет (мимо VPN): ${net.physicalOk ? "да" : "нет / неизвестно"}`);
            add(`VPN и виртуальные адаптеры: ${net.virtual.size ? [...net.virtual].join(", ") : "нет"} (определено: ${net.source === "windows" ? "Windows" : "по браузеру"})`);
        }
        const turnCustom = has("loadTurnConfig") ? val("loadTurnConfig")() : null;
        add(`Свой TURN в настройках: ${turnCustom ? "да" : "нет"}`);

        add();
        add("— Сейчас —");
        const call = val("activeCall");
        if (call) add(`Звонок 1:1: ${call.connectedAt ? "идёт " + Math.round((Date.now() - call.connectedAt) / 1000) + " с" : call.state}${call.reconnecting ? ", ПЕРЕПОДКЛЮЧАЕТСЯ" : ""} · путь ${call.route === "relay" ? "через сервер-посредник" : call.route ? "напрямую" : "?"} · пинг ${call.pingMs ?? "?"} мс`);
        const room = val("voiceCall");
        if (room) add(`Голосовая комната: ${room.peers?.size || 0} соединений · пинг ${room.pingMs ?? "?"} мс${room.relayed ? ` · через посредника: ${room.relayed}` : ""}`);
        const group = val("activeGroupCall");
        if (group) add(`Групповой звонок: ${group.peers?.size || 0} участников`);
        if (!call && !room && !group) add("Звонков нет");
        const vs = val("voiceSettings");
        if (vs) add(`Звук: шумодав ${vs.noiseMode || "?"}/${vs.noiseStrength || "?"}${has("KabanNoise") ? " (" + val("KabanNoise").status() + ")" : ""} · эхо ${vs.echo ? "вкл" : "выкл"} · режим ${vs.mode || "?"}`);
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter((d) => d.kind === "audioinput"), outs = devices.filter((d) => d.kind === "audiooutput");
            add(`Микрофоны (${mics.length}): ${mics.map((d) => d.label || "без названия").join("; ")}`);
            add(`Выходы звука (${outs.length}): ${outs.map((d) => d.label || "без названия").join("; ")}`);
        } catch { /* нет доступа */ }

        if (has("getCallHistory")) {
            const history = (val("getCallHistory")() || []).slice(0, 12);
            if (history.length) {
                add();
                add("— Последние звонки —");
                history.forEach((c) => add(`${stamp(Date.parse(c.startedAt) || 0)} · ${c.direction === "incoming" ? "входящий" : "исходящий"} ${c.kind === "video" ? "видео" : "аудио"} · ${c.result}${c.durationSeconds ? " · " + c.durationSeconds + " с" : ""}${c.route ? " · " + (c.route === "relay" ? "через посредника" : "напрямую") : ""}${c.pingMs != null ? " · пинг " + c.pingMs + " мс" : ""}`));
            }
        }

        add();
        add(`— События (последние ${entries.length}) —`);
        entries.forEach((e) => add(`${stamp(e.t)} [${e.k}] ${e.m}`));
        return scrub(lines.join("\n"));
    }

    /* ---- окно ---- */

    let report = "";

    function ensureModal() {
        let backdrop = document.getElementById("diag-backdrop");
        if (backdrop) return backdrop;
        backdrop = document.createElement("div");
        backdrop.className = "forward-backdrop";
        backdrop.id = "diag-backdrop";
        backdrop.setAttribute("aria-hidden", "true");
        backdrop.innerHTML = `
            <section class="forward-modal group-info-modal diag-modal" role="dialog" aria-modal="true" aria-label="Журнал связи">
                <div class="forward-modal-header">
                    <span>Журнал связи</span>
                    <button type="button" class="settings-close" data-diag="close" aria-label="Закрыть">×</button>
                </div>
                <p class="group-perms-hint">Если звонок не соединился, пропадал звук или что-то сломалось — отправьте этот отчёт разработчику. В нём: версия программы, сеть (напрямую или через VPN), последние звонки с пингом и ошибки. Почта, ключи доступа и внешние IP-адреса скрыты.</p>
                <pre class="diag-preview" id="diag-preview">Собираем отчёт…</pre>
                <div class="group-members-head"><span>Отправить в чат</span></div>
                <div class="diag-chats" id="diag-chats"></div>
                <div class="delete-choice-actions turn-actions">
                    <button type="button" class="delete-choice-btn" data-diag="copy">Скопировать</button>
                    <button type="button" class="delete-choice-btn" data-diag="save">Сохранить файл</button>
                </div>
            </section>`;
        document.body.appendChild(backdrop);
        backdrop.addEventListener("click", (event) => {
            if (event.target === backdrop) { close(); return; }
            const action = event.target.closest("[data-diag]")?.dataset.diag;
            const chatId = event.target.closest("[data-diag-chat]")?.dataset.diagChat;
            if (action === "close") close();
            else if (action === "copy") copy();
            else if (action === "save") saveFile();
            else if (chatId) sendTo(chatId);
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && backdrop.classList.contains("open")) { event.stopImmediatePropagation(); event.kabanConsumed = true; close(); }
        }, true);
        return backdrop;
    }

    function fileName() {
        const d = new Date();
        return `kaban-log-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
    }

    async function open() {
        const backdrop = ensureModal();
        backdrop.classList.add("open");
        backdrop.setAttribute("aria-hidden", "false");
        const preview = document.getElementById("diag-preview");
        preview.textContent = "Собираем отчёт…";
        renderChats();
        report = await buildReport();
        preview.textContent = report;
    }

    function close() {
        const backdrop = document.getElementById("diag-backdrop");
        if (!backdrop) return;
        backdrop.classList.remove("open");
        backdrop.setAttribute("aria-hidden", "true");
    }

    // Недавние чаты (кроме секретных — туда вложения не уходят) — куда отправить отчёт одним нажатием.
    function renderChats() {
        const box = document.getElementById("diag-chats");
        const rows = (val("cachedChatRows") || []).filter((r) => !r.chats?.is_secret).slice(0, 8);
        if (!rows.length) { box.innerHTML = `<div class="group-perms-hint">Войдите в аккаунт, чтобы отправить отчёт в чат, — или сохраните его файлом.</div>`; return; }
        // Название — как в списке чатов (buildChatListItemHTML): группа / «Избранное» / имя или псевдоним.
        const title = (r) => {
            const other = r.otherUser;
            if (r.chats?.type === "group") return r.chats.title || "Группа";
            if (!other) return "Избранное";
            return (typeof loadContactAlias === "function" && loadContactAlias(other.id)) || other.display_name || "Пользователь";
        };
        const escape = typeof escapeHTML === "function" ? escapeHTML : (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
        box.innerHTML = rows.map((r) => `<button type="button" class="diag-chat" data-diag-chat="${escape(r.chat_id)}">${escape(title(r))}</button>`).join("");
    }

    async function sendTo(chatId) {
        if (!report) return;
        if (typeof sendRealAttachment !== "function") { toast("Отправка недоступна — сохраните файлом"); return; }
        const file = new File([report], fileName(), { type: "text/plain" });
        close();
        await sendRealAttachment(file, "document", { chatId });
    }

    async function copy() {
        if (!report) return;
        try { await navigator.clipboard.writeText(report); toast("Отчёт скопирован"); }
        catch { toast("Не удалось скопировать — сохраните файлом"); }
    }

    function saveFile() {
        if (!report) return;
        const url = URL.createObjectURL(new Blob([report], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url; a.download = fileName();
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast("Отчёт сохранён в «Загрузки»");
    }

    window.kabanDiag = { note: (kind, message) => push(String(kind || "info"), message), open, close, buildReport, entries };

})();

function openDiagnostics() { window.kabanDiag?.open(); }
