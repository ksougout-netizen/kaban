/* ============================================================================
   KABAN ДЛЯ ПК — связь веб-приложения с программой для Windows.
   В программе есть window.kabanDesktop (см. desktop/src/preload.js); в
   браузере его нет — тогда в настройках только строка «KABAN для Windows»
   со ссылкой на скачивание.
   ========================================================================= */

const DESKTOP_DOWNLOAD_URL = "https://github.com/ksougout-netizen/kaban/releases/latest";
const DESKTOP_SFX_SLOTS_KEY = "kaban-desktop-sfx-slots";
const desktopBridge = window.kabanDesktop || null;

let desktopInfoCache = null;
let desktopCapture = null;          // { action, button } — ждём нажатия сочетания
let desktopLastActivity = "";

const DESKTOP_HOTKEY_ROWS = [
    { action: "toggleWindow", label: "Показать / скрыть KABAN", always: true },
    { action: "toggleMute", label: "Микрофон вкл/выкл" },
    { action: "toggleDeafen", label: "Звук вкл/выкл" },
    { action: "toggleOverlay", label: "Показать/скрыть оверлей" }
];

/* ---- сочетания клавиш: из события клавиатуры → в формат Electron ---- */

const DESKTOP_CODE_KEYS = {
    Space: "Space", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", ArrowUp: "Up", ArrowDown: "Down",
    ArrowLeft: "Left", ArrowRight: "Right", Insert: "Insert", Delete: "Delete", Home: "Home", End: "End",
    PageUp: "PageUp", PageDown: "PageDown", Pause: "Pause", NumpadAdd: "numadd", NumpadSubtract: "numsub",
    NumpadMultiply: "nummult", NumpadDivide: "numdiv", NumpadDecimal: "numdec"
};
const DESKTOP_BARE_OK = /^(?:F\d{1,2}|num\w+|Pause|Insert|Home|End|PageUp|PageDown)$/;

function desktopModifiers(event) {
    const mods = [];
    if (event.ctrlKey) mods.push("Ctrl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Super");
    return mods;
}

function desktopKeyFromCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    if (/^Numpad\d$/.test(code)) return "num" + code.slice(6);
    return DESKTOP_CODE_KEYS[code] || null;
}

function desktopPrettyAccel(accel) {
    if (!accel) return "Не назначено";
    const names = { Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "Пробел", Super: "Win", numadd: "Num +", numsub: "Num −", nummult: "Num *", numdiv: "Num /", numdec: "Num ." };
    return accel.split("+").map((part) => names[part] || (/^num\d$/.test(part) ? "Num " + part.slice(3) : part)).join(" + ");
}

/* ---- саундборд: какой звук на какой клавише ---- */

function desktopSfxSlots() {
    let slots = null;
    try { slots = JSON.parse(localStorage.getItem(DESKTOP_SFX_SLOTS_KEY)); } catch { /* по умолчанию */ }
    const defaults = (typeof VOICE_SFX !== "undefined" ? VOICE_SFX : []).slice(0, 9).map((s) => s.id);
    return Array.from({ length: 9 }, (_, i) => (Array.isArray(slots) && typeof slots[i] === "string" ? slots[i] : defaults[i] || ""));
}

function desktopSetSfxSlot(index, id) {
    const slots = desktopSfxSlots();
    slots[index] = id;
    try { localStorage.setItem(DESKTOP_SFX_SLOTS_KEY, JSON.stringify(slots)); } catch { /* не сохранится до перезапуска */ }
}

function desktopSfxOptions() {
    const builtin = typeof VOICE_SFX !== "undefined" ? VOICE_SFX.map((s) => ({ id: s.id, label: `${s.icon} ${s.label}` })) : [];
    const custom = typeof voiceCustomSfx !== "undefined" ? voiceCustomSfx.map((s) => ({ id: s.id, label: `🔊 ${s.name}` })) : [];
    return [{ id: "", label: "— нет —" }, ...builtin, ...custom];
}

async function desktopPlaySfxSlot(index) {
    if (typeof voiceCall === "undefined" || !voiceCall) return;
    const id = desktopSfxSlots()[index];
    if (!id) return;
    if (typeof voiceSfxLoadCustom === "function" && !VOICE_SFX.some((s) => s.id === id)) await voiceSfxLoadCustom();
    voiceSfxSend(id);
}

/* ---- горячие клавиши из программы ---- */

function desktopCallMuteButton() {
    return document.querySelector('#call-controls-incall [data-call-action="mute"]');
}

function desktopOnHotkey(action) {
    const inVoice = typeof voiceCall !== "undefined" && !!voiceCall;
    const inCall = typeof activeCall !== "undefined" && !!activeCall;
    if (action === "toggleMute") {
        if (inVoice) voiceToggleMute();
        else if (inCall) {
            const button = desktopCallMuteButton();
            if (button) {
                toggleCallControl(button);   // сам играет короткий звук вкл/выкл
            }
        }
    } else if (action === "toggleDeafen") {
        if (inVoice) voiceToggleDeafen();
    } else if (/^sfx[1-9]$/.test(action)) {
        desktopPlaySfxSlot(Number(action.slice(3)) - 1);
    }
    desktopSyncActivity();
}

// Что сейчас происходит (голос/звонок/микрофон) — для трея и для того, чтобы
// горячие клавиши голоса включались только во время разговора.
function desktopSyncActivity() {
    const call = typeof voiceCall !== "undefined" ? voiceCall : null;
    const phone = typeof activeCall !== "undefined" ? activeCall : null;
    const activity = {
        inVoice: !!call,
        inCall: !!phone,
        muted: call ? !!call.muted : phone ? desktopCallMuteButton()?.getAttribute("aria-pressed") === "true" : false,
        deafened: !!call?.deafened,
        label: call?.roomName || ""
    };
    const key = JSON.stringify(activity);
    if (key !== desktopLastActivity) {
        desktopLastActivity = key;
        desktopBridge.setActivity(activity);
    }

    // Рация в играх: программа слушает выбранную клавишу/кнопку мыши, пока вы в комнате в режиме «Рация».
    if (desktopHas("global-ptt")) {
        const ptt = { enabled: !!call && typeof voiceSettings !== "undefined" && voiceSettings.mode === "ptt", code: typeof voiceSettings !== "undefined" ? voiceSettings.pttKey : "" };
        const pttKey = JSON.stringify(ptt);
        if (pttKey !== desktopLastPtt) {
            desktopLastPtt = pttKey;
            desktopBridge.setPtt(ptt).then((status) => { desktopPttStatus = status || null; }).catch(() => {});
        }
    }
}

function desktopHas(feature) {
    return !!desktopBridge && Array.isArray(desktopBridge.features) && desktopBridge.features.includes(feature);
}

let desktopLastPtt = "";
let desktopPttStatus = null;
let desktopLastRoster = "";

// Оверлей: кто в комнате и кто говорит — часто (5 раз в секунду), но отправляем только изменения.
function desktopSyncRoster() {
    const call = typeof voiceCall !== "undefined" ? voiceCall : null;
    let roster = null;
    if (call) {
        roster = {
            inVoice: true,
            room: call.roomName || "",
            members: Object.entries(call.members || {})
                .sort(([, a], [, b]) => (a.joinedAt || 0) - (b.joinedAt || 0))
                .map(([id, meta]) => {
                    const me = id === myRealUserId;
                    return {
                        id,
                        me,
                        name: me ? (cachedMyProfile?.display_name || "Вы") : voiceMemberName(id, meta),
                        avatar: meta?.avatar || "",
                        speaking: !!call.speaking?.has(id),
                        muted: me ? !!call.muted : !!meta?.muted,
                        deafened: me ? !!call.deafened : !!meta?.deafened,
                        cam: !!meta?.cam,
                        live: !!meta?.screen
                    };
                })
        };
    }
    const key = JSON.stringify(roster);
    if (key === desktopLastRoster) return;
    desktopLastRoster = key;
    desktopBridge.setVoiceRoster(roster);
}

/* ---- баннер «обновление готово» ---- */

function desktopShowUpdateBanner(kind, version) {
    let banner = document.getElementById("desktop-update-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "desktop-update-banner";
        banner.className = "desktop-update-banner";
        banner.setAttribute("role", "status");
        document.body.appendChild(banner);
    }
    const shell = kind === "shell";
    banner.dataset.kind = kind;
    banner.innerHTML = `
        <span class="desktop-update-icon" aria-hidden="true">↻</span>
        <span class="desktop-update-copy">
            <strong>${shell ? "Обновление программы готово" : "Доступна новая версия KABAN"}</strong>
            <em>${shell ? "Установится за пару секунд, KABAN перезапустится" : "Обновление займёт секунду"}</em>
        </span>
        <button type="button" class="desktop-update-btn">${shell ? "Перезапустить" : "Обновить"}</button>
        <button type="button" class="desktop-update-close" aria-label="Позже" title="Позже">×</button>`;
    banner.querySelector(".desktop-update-btn").onclick = () => {
        const busy = (typeof voiceCall !== "undefined" && voiceCall) || (typeof activeCall !== "undefined" && activeCall);
        if (busy && !confirm("Обновление прервёт текущий разговор. Продолжить?")) return;
        desktopBridge.applyUpdate(shell ? "shell" : "web");
    };
    banner.querySelector(".desktop-update-close").onclick = () => banner.remove();
    requestAnimationFrame(() => banner.classList.add("show"));
}

/* ---- окно настроек «Приложение для ПК» ---- */

async function openDesktopSettings() {
    if (!desktopBridge) { window.open(DESKTOP_DOWNLOAD_URL, "_blank", "noopener"); return; }
    if (typeof voiceSfxLoadCustom === "function") voiceSfxLoadCustom().then(() => desktopRenderSettings()).catch(() => {});
    desktopInfoCache = await desktopBridge.getInfo();
    desktopRenderSettings();
    const backdrop = document.getElementById("desktop-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeDesktopSettings() {
    desktopStopCapture();
    const backdrop = document.getElementById("desktop-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function desktopToggleRow(key, title, hint, checked, disabled) {
    return `
        <label class="settings-option${disabled ? " is-disabled" : ""}">
            <span class="settings-option-copy">
                <span class="settings-option-title">${title}</span>
                <span class="settings-option-hint">${hint}</span>
            </span>
            <span class="settings-toggle">
                <input type="checkbox" class="settings-toggle-input" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} onchange="desktopSetSetting('${key}', this.checked)">
                <span class="settings-toggle-track"><span class="settings-toggle-thumb"></span></span>
            </span>
        </label>`;
}

function desktopHotkeyRow(action, labelHTML) {
    const info = desktopInfoCache;
    const accel = info.settings.hotkeys[action] || "";
    const status = info.hotkeyStatus[action];
    const busy = status === "busy";
    return `
        <div class="desk-hotkey${busy ? " busy" : ""}" data-action="${action}">
            <span class="desk-hotkey-label">${labelHTML}</span>
            <button type="button" class="desk-key${accel ? "" : " empty"}" onclick="desktopStartCapture('${action}', this)" title="Нажмите, чтобы изменить">${escapeHTML(desktopPrettyAccel(accel))}</button>
            ${accel ? `<button type="button" class="desk-key-clear" onclick="desktopAssign('${action}', '')" title="Убрать сочетание" aria-label="Убрать сочетание">×</button>` : `<span class="desk-key-clear-space"></span>`}
            ${busy ? `<span class="desk-hotkey-note">Занято другой программой — выберите другое сочетание</span>` : ""}
            <span class="desk-hotkey-error" hidden></span>
        </div>`;
}

function desktopRenderSettings() {
    const body = document.getElementById("desktop-settings-body");
    const info = desktopInfoCache;
    if (!body || !info) return;
    const s = info.settings;
    const slots = desktopSfxSlots();
    const options = desktopSfxOptions();
    const sfxRows = slots.map((id, i) => {
        const select = `<select class="desk-sfx-select" onchange="desktopSetSfxSlot(${i}, this.value)" aria-label="Звук ${i + 1}">${
            options.map((o) => `<option value="${escapeHTML(o.id)}"${o.id === id ? " selected" : ""}>${escapeHTML(o.label)}</option>`).join("")}</select>`;
        return desktopHotkeyRow("sfx" + (i + 1), select);
    }).join("");
    const webVersion = info.web?.version || "—";

    body.innerHTML = `
        <div class="settings-group-label">Окно</div>
        <div class="settings-section">
            ${desktopToggleRow("launchAtLogin", "Запускать вместе с Windows", "KABAN будет на связи сразу после включения компьютера", s.launchAtLogin)}
            ${desktopToggleRow("startMinimized", "Запускать свёрнутым", "При автозапуске — сразу в трей, без окна", s.startMinimized, !s.launchAtLogin)}
            ${desktopToggleRow("closeToTray", "Закрывать в трей", "Крестик прячет окно, а сообщения и звонки продолжают приходить", s.closeToTray)}
        </div>

        <div class="settings-group-label">Горячие клавиши</div>
        <div class="settings-section">
            ${desktopToggleRow("hotkeysEnabled", "Глобальные горячие клавиши", "Работают поверх игр и других программ", s.hotkeysEnabled)}
        </div>
        <div class="desk-hotkeys${s.hotkeysEnabled ? "" : " is-off"}">
            ${DESKTOP_HOTKEY_ROWS.filter((row) => row.action in (info.defaultHotkeys || {})).map((row) => desktopHotkeyRow(row.action, escapeHTML(row.label))).join("")}
            <div class="desk-subhead">Саундборд <span>в голосовой комнате</span></div>
            ${sfxRows}
            <p class="desk-note">Микрофон, звук и саундборд срабатывают, только пока вы в голосовой комнате или звонке — в остальное время эти сочетания свободны для других программ.</p>
            <button type="button" class="desk-link-btn" onclick="desktopResetHotkeys()">Вернуть сочетания по умолчанию</button>
        </div>

        ${desktopHas("overlay") ? `
        <div class="settings-group-label">Оверлей в играх</div>
        <div class="settings-section">
            ${desktopToggleRow("overlayEnabled", "Показывать оверлей", "Поверх игры — кто в голосовой комнате и кто говорит. Мышь и клавиатуру игре не мешает", s.overlayEnabled)}
            <div class="settings-option settings-option-static${s.overlayEnabled ? "" : " is-disabled"}">
                <span class="settings-option-copy"><span class="settings-option-title">Где на экране</span></span>
                <select class="desk-sfx-select desk-select" onchange="desktopSetSetting('overlayCorner', this.value)" ${s.overlayEnabled ? "" : "disabled"}>
                    ${[["top-left", "Слева сверху"], ["top-right", "Справа сверху"], ["bottom-left", "Слева снизу"], ["bottom-right", "Справа снизу"]].map(([v, l]) => `<option value="${v}"${s.overlayCorner === v ? " selected" : ""}>${l}</option>`).join("")}
                </select>
            </div>
            <div class="settings-option settings-option-static${s.overlayEnabled ? "" : " is-disabled"}">
                <span class="settings-option-copy"><span class="settings-option-title">Кого показывать</span></span>
                <select class="desk-sfx-select desk-select" onchange="desktopSetSetting('overlayMode', this.value)" ${s.overlayEnabled ? "" : "disabled"}>
                    <option value="all"${s.overlayMode !== "speaking" ? " selected" : ""}>Всех в комнате</option>
                    <option value="speaking"${s.overlayMode === "speaking" ? " selected" : ""}>Только говорящих</option>
                </select>
            </div>
        </div>
        <p class="desk-note">Если в игре оверлея не видно — переключите её в режим «Оконный без рамки» (Borderless): в «эксклюзивном полноэкранном» Windows рисует игру поверх всего.</p>` : ""}

        ${desktopHas("global-ptt") ? `
        <div class="settings-group-label">Рация</div>
        <div class="settings-section">
            <button type="button" class="settings-option settings-option-link" onclick="closeDesktopSettings(); openVoiceSettings();">
                <span class="settings-option-copy">
                    <span class="settings-option-title">Рация работает и в играх</span>
                    <span class="settings-option-hint">${typeof voiceSettings !== "undefined" && voiceSettings.mode === "ptt" ? `Клавиша: ${escapeHTML(voiceSettings.pttLabel)}` : "Сейчас режим «по голосу»"} — включить и выбрать клавишу или кнопку мыши можно в настройках голоса</span>
                </span>
                <span class="settings-option-chevron">›</span>
            </button>
        </div>` : ""}

        <div class="settings-group-label">О программе</div>
        <div class="settings-section desk-about">
            <div class="desk-about-row"><span>Программа</span><b>${escapeHTML(info.shellVersion)}</b></div>
            <div class="desk-about-row"><span>Мессенджер</span><b>${escapeHTML(webVersion)}</b></div>
            <div class="desk-about-actions">
                <button type="button" class="delete-choice-btn turn-save" id="desk-check-btn" onclick="desktopCheckUpdates()">Проверить обновления</button>
                <button type="button" class="delete-choice-btn" onclick="desktopBridge.openLogs()">Журнал</button>
            </div>
            <div class="desk-update-status" id="desk-update-status" hidden></div>
        </div>`;
}

async function desktopSetSetting(key, value) {
    desktopInfoCache = await desktopBridge.setSetting(key, value);
    desktopRenderSettings();
}

async function desktopAssign(action, accel) {
    const result = await desktopBridge.setHotkey(action, accel);
    desktopInfoCache = result?.info || desktopInfoCache;
    desktopRenderSettings();
    let message = result?.ok === false ? result.error : result?.warning;
    if (result?.conflict) {
        const other = DESKTOP_HOTKEY_ROWS.find((row) => row.action === result.conflict)?.label
            || (/^sfx\d$/.test(result.conflict) ? `Звук ${result.conflict.slice(3)}` : "");
        if (other) message = `Уже назначено: «${other}»`;
    }
    if (message) {
        const errorEl = document.querySelector(`.desk-hotkey[data-action="${action}"] .desk-hotkey-error`);
        if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
    }
}

async function desktopResetHotkeys() {
    desktopInfoCache = await desktopBridge.resetHotkeys();
    try { localStorage.removeItem(DESKTOP_SFX_SLOTS_KEY); } catch { /* ок */ }
    desktopRenderSettings();
}

async function desktopCheckUpdates() {
    const button = document.getElementById("desk-check-btn");
    const statusEl = document.getElementById("desk-update-status");
    if (button) { button.disabled = true; button.textContent = "Проверяем…"; }
    let text = "";
    try {
        const result = await desktopBridge.checkForUpdates();
        desktopInfoCache = result.info || desktopInfoCache;
        if (result.web?.status === "ready") text = "Новая версия мессенджера скачана — нажмите «Обновить» внизу экрана";
        else if (result.shell?.status === "downloading") text = `Скачиваем новую версию программы ${result.shell.version || ""}…`;
        else if (result.web?.status === "error") text = "Не удалось проверить — нет связи с сервером обновлений";
        else if (result.web?.status === "shell-required") text = "Для новой версии нужно обновить саму программу — скачиваем…";
        else text = "У вас последняя версия";
    } catch {
        text = "Не удалось проверить обновления";
    }
    desktopRenderSettings();
    const fresh = document.getElementById("desk-update-status");
    if (fresh) { fresh.textContent = text; fresh.hidden = false; }
    else if (statusEl) { statusEl.textContent = text; statusEl.hidden = false; }
}

/* ---- запись сочетания клавиш ---- */

function desktopStartCapture(action, button) {
    desktopStopCapture();
    desktopCapture = { action, button };
    button.classList.add("capturing");
    button.textContent = "Нажмите сочетание…";
    desktopBridge.suspendHotkeys(true);
    document.addEventListener("keydown", desktopCaptureKey, true);
    document.addEventListener("keyup", desktopCaptureKeyUp, true);
    document.addEventListener("pointerdown", desktopCaptureOutside, true);
}

function desktopStopCapture() {
    if (!desktopCapture) return;
    document.removeEventListener("keydown", desktopCaptureKey, true);
    document.removeEventListener("keyup", desktopCaptureKeyUp, true);
    document.removeEventListener("pointerdown", desktopCaptureOutside, true);
    desktopBridge.suspendHotkeys(false);
    desktopCapture = null;
}

function desktopCaptureOutside(event) {
    if (desktopCapture && event.target !== desktopCapture.button) { desktopStopCapture(); desktopRenderSettings(); }
}

function desktopCaptureKeyUp(event) {
    if (!desktopCapture) return;
    event.preventDefault();
    event.stopPropagation();
    const mods = desktopModifiers(event);
    desktopCapture.button.textContent = mods.length ? mods.join(" + ") + " + …" : "Нажмите сочетание…";
}

function desktopCaptureKey(event) {
    if (!desktopCapture) return;
    event.preventDefault();
    event.stopPropagation();
    const { action, button } = desktopCapture;
    const mods = desktopModifiers(event);
    if (event.key === "Escape" && !mods.length) { desktopStopCapture(); desktopRenderSettings(); return; }
    if ((event.key === "Backspace" || event.key === "Delete") && !mods.length) { desktopStopCapture(); desktopAssign(action, ""); return; }
    const key = desktopKeyFromCode(event.code);
    if (!key) { button.textContent = mods.length ? mods.join(" + ") + " + …" : "Нажмите сочетание…"; return; }
    if (!mods.length && !DESKTOP_BARE_OK.test(key)) {
        button.textContent = "Добавьте Ctrl, Alt или Shift";
        return;
    }
    desktopStopCapture();
    desktopAssign(action, [...mods, key].join("+"));
}

/* ---- видимость окна ----
   Программа отключает «замедление в фоне» (иначе голос и звонки замирали бы в
   трее), и из-за этого страница всегда считала себя видимой: новые сообщения в
   открытом чате сразу помечались прочитанными, пока окно в трее, «в сети» не
   гасло, анимации и смайлики крутились впустую. Как в Telegram Desktop: окно
   считается скрытым, если оно не в фокусе дольше 3 секунд. */

let desktopHidden = false;
let desktopHideTimer = 0;

function desktopSetHidden(value) {
    if (desktopHidden === value) return;
    desktopHidden = value;
    document.documentElement.classList.toggle("app-inactive", value);
    try { value ? window.lottie?.freeze?.() : window.lottie?.unfreeze?.(); } catch { /* без lottie */ }
    document.dispatchEvent(new Event("visibilitychange"));
}

function desktopInstallVisibility() {
    try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => desktopHidden });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (desktopHidden ? "hidden" : "visible") });
    } catch { return; }
    const scheduleHide = () => {
        clearTimeout(desktopHideTimer);
        desktopHideTimer = setTimeout(() => { if (!document.hasFocus()) desktopSetHidden(true); }, 3000);
    };
    window.addEventListener("blur", scheduleHide);
    window.addEventListener("focus", () => { clearTimeout(desktopHideTimer); desktopSetHidden(false); });
    if (!document.hasFocus()) scheduleHide();
}

/* ---- запуск ---- */

function desktopInit() {
    const row = document.getElementById("desktop-settings-row");

    if (!desktopBridge) {
        // В браузере на компьютере с Windows — предлагаем программу.
        const isWindowsDesktop = /Windows NT/.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);
        if (row && isWindowsDesktop) {
            row.hidden = false;
            document.getElementById("desktop-settings-group").hidden = false;
        }
        return;
    }

    document.documentElement.classList.add("is-desktop");
    desktopInstallVisibility();
    if (row) {
        row.hidden = false;
        document.getElementById("desktop-settings-group").hidden = false;
        document.getElementById("desktop-row-title").textContent = "Приложение для ПК";
        document.getElementById("desktop-row-hint").textContent = "Горячие клавиши, трей, автозапуск";
        document.getElementById("desktop-row-value").textContent = "";
    }

    // Клик по уведомлению вызывает window.focus() — в программе этого мало,
    // окно может быть спрятано в трей. Показываем его.
    const nativeFocus = window.focus.bind(window);
    window.focus = () => { desktopBridge.show(); nativeFocus(); };

    // Входящий звонок, когда окно в трее или под игрой — мигаем значком и показываем окно без перехвата фокуса.
    if (typeof showIncomingCallUI === "function") {
        const originalShowIncoming = showIncomingCallUI;
        showIncomingCallUI = function (offer) {
            originalShowIncoming(offer);
            desktopBridge.attention("call");
        };
    }

    desktopBridge.onHotkey(desktopOnHotkey);
    desktopBridge.onUpdate((update) => desktopShowUpdateBanner(update?.kind, update?.version));
    setInterval(desktopSyncActivity, 700);
    desktopSyncActivity();
    if (desktopHas("overlay")) setInterval(desktopSyncRoster, 200);
    if (desktopHas("global-ptt")) {
        desktopBridge.onPtt((down) => {
            if (typeof voiceCall === "undefined" || !voiceCall || voiceSettings.mode !== "ptt") return;
            voicePttDown = !!down;
            voiceApplyMicState();
        });
    }

    // Сообщаем программе, что эта версия мессенджера запустилась (иначе через 30 с — откат).
    if (typeof openRealChat === "function" && typeof KabanAPI !== "undefined") desktopBridge.ready();
}

desktopInit();
