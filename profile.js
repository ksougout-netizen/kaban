/* ============================================================================
   ПРОФИЛЬ КАК В TELEGRAM: телефон и день рождения (с выбором «кто видит»),
   цвет профиля, разделы (Избранное, Мои истории, Звонки, Устройства) и
   телефон/день рождения собеседника в его карточке.
   Данные — в таблице user_private (profile_extras.sql). Пока SQL не запущен,
   новые поля просто скрыты, остальной профиль работает как раньше.
   ========================================================================= */

// null — «по имени» (цвет считается из имени, как раньше).
const PROFILE_COLOR_HUES = [null, 210, 255, 290, 330, 0, 24, 45, 140, 175];

let myProfileExtras = null;      // то, что сейчас лежит в базе
let profileColorDraft = null;    // выбранный, но ещё не сохранённый цвет

const profileBirthdayFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });

/* ---- телефон ---- */

function normalizePhone(raw) {
    let digits = String(raw || "").replace(/\D/g, "");
    if (!digits) return "";
    // «8 900…» и «900…» по-русски — это +7
    if (digits.length === 11 && digits[0] === "8") digits = "7" + digits.slice(1);
    if (digits.length === 10 && digits[0] === "9") digits = "7" + digits;
    return "+" + digits;
}

function formatPhonePretty(phone) {
    const d = String(phone || "").replace(/\D/g, "");
    if (d.length === 11 && d[0] === "7") return `+7 ${d.slice(1, 4)} ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
    if (!d) return "";
    return "+" + d.replace(/(\d{1,3})(?=(\d{3})+$)/g, "$1 ");
}

function formatProfilePhoneInput(input) {
    const caretAtEnd = input.selectionStart === input.value.length;
    let value = input.value.replace(/[^\d+\s()-]/g, "");
    if (value && !value.startsWith("+") && /^\d/.test(value)) value = "+" + value;
    input.value = value;
    if (caretAtEnd) input.setSelectionRange(value.length, value.length);
}

/* ---- день рождения ---- */

function formatBirthday(iso) {
    if (!iso) return "";
    const [y, m, d] = iso.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const now = new Date();
    let age = now.getFullYear() - y - ((now.getMonth() < m - 1 || (now.getMonth() === m - 1 && now.getDate() < d)) ? 1 : 0);
    const today = now.getMonth() === m - 1 && now.getDate() === d;
    const ageWord = (n) => (n % 10 === 1 && n % 100 !== 11) ? "год" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? "года" : "лет";
    return `${today ? "🎂 Сегодня! " : ""}${profileBirthdayFormatter.format(date)} ${y} · ${age} ${ageWord(age)}`;
}

/* ---- мой профиль ---- */

async function loadProfileExtras() {
    if (typeof KabanAPI === "undefined" || !KabanAPI.getMyExtras) return;
    try {
        myProfileExtras = await KabanAPI.getMyExtras();
    } catch (error) {
        console.warn("Не удалось загрузить телефон/день рождения", error);
        myProfileExtras = null;
    }
    const available = !!myProfileExtras;
    document.querySelectorAll(".profile-extra").forEach((el) => { el.hidden = !available; });
    if (!available) return;
    document.getElementById("profile-phone-input").value = formatPhonePretty(myProfileExtras.phone);
    document.getElementById("profile-phone-visibility").value = myProfileExtras.phone_visibility || "contacts";
    document.getElementById("profile-birthday-input").value = myProfileExtras.birthday || "";
    document.getElementById("profile-birthday-input").max = new Date().toISOString().slice(0, 10);
    document.getElementById("profile-birthday-visibility").value = myProfileExtras.birthday_visibility || "contacts";
    profileColorDraft = myProfileExtras.profile_color ?? null;
    renderProfileColorRow();
    applyMyProfileColor();
}

function renderProfileColorRow() {
    const row = document.getElementById("profile-color-row");
    if (!row) return;
    row.innerHTML = PROFILE_COLOR_HUES.map((hue) => {
        const selected = hue === profileColorDraft;
        const style = hue === null
            ? "background:conic-gradient(from 90deg,#ff7a59,#ffd36a,#54cb68,#2a9ef1,#a855f7,#ff7a59)"
            : `background:linear-gradient(160deg,hsl(${hue} 70% 60%),hsl(${(hue + 40) % 360} 68% 44%))`;
        return `<button type="button" class="profile-color-swatch${selected ? " selected" : ""}" role="radio" aria-checked="${selected}" title="${hue === null ? "По имени" : "Цвет"}" style="${style}" onclick="pickProfileColor(${hue === null ? "null" : hue})">${hue === null ? "" : ""}</button>`;
    }).join("");
}

function pickProfileColor(hue) {
    profileColorDraft = hue;
    renderProfileColorRow();
    applyMyProfileColor();
}

// Шапка «Моего профиля»: выбранный цвет поверх «цвета из имени».
function applyMyProfileColor() {
    const screen = document.getElementById("profile-screen");
    if (!screen) return;
    if (profileColorDraft !== null && profileColorDraft !== undefined) screen.style.setProperty("--gh", String(profileColorDraft));
    else if (typeof cachedMyProfile !== "undefined" && cachedMyProfile) {
        let hue = 0;
        for (const ch of cachedMyProfile.display_name || "") hue = (hue * 31 + ch.charCodeAt(0)) % 360;
        screen.style.setProperty("--gh", String(hue));
    }
}

function profileExtrasDirty() {
    if (!myProfileExtras) return false;
    const phone = normalizePhone(document.getElementById("profile-phone-input").value) || null;
    const birthday = document.getElementById("profile-birthday-input").value || null;
    return phone !== (myProfileExtras.phone || null)
        || birthday !== (myProfileExtras.birthday || null)
        || document.getElementById("profile-phone-visibility").value !== (myProfileExtras.phone_visibility || "contacts")
        || document.getElementById("profile-birthday-visibility").value !== (myProfileExtras.birthday_visibility || "contacts")
        || (profileColorDraft ?? null) !== (myProfileExtras.profile_color ?? null);
}

async function saveProfileExtras() {
    if (!myProfileExtras || !profileExtrasDirty()) return true;
    const phone = normalizePhone(document.getElementById("profile-phone-input").value) || null;
    const birthday = document.getElementById("profile-birthday-input").value || null;
    try {
        myProfileExtras = await KabanAPI.saveMyExtras({
            phone,
            phone_visibility: document.getElementById("profile-phone-visibility").value,
            birthday,
            birthday_visibility: document.getElementById("profile-birthday-visibility").value,
            profile_color: profileColorDraft ?? null
        });
        document.getElementById("profile-phone-input").value = formatPhonePretty(myProfileExtras.phone);
        return true;
    } catch (error) {
        toast("Не удалось сохранить телефон/день рождения: " + (error?.message || error));
        return false;
    }
}

// Проверка номера ДО сохранения остального профиля, чтобы не сохранить половину.
if (typeof saveProfileChanges === "function") {
    const originalSaveProfileChanges = saveProfileChanges;
    saveProfileChanges = async function () {
        if (myProfileExtras) {
            const raw = document.getElementById("profile-phone-input").value.trim();
            const phone = normalizePhone(raw);
            if (raw && !/^\+\d{8,15}$/.test(phone)) { toast("Номер телефона: от 8 до 15 цифр, например +7 900 000-00-00"); return; }
            const birthday = document.getElementById("profile-birthday-input").value;
            if (birthday && (birthday > new Date().toISOString().slice(0, 10) || birthday < "1900-01-02")) { toast("Проверьте дату рождения"); return; }
        }
        const ok = await originalSaveProfileChanges();
        if (ok === false) return false;
        return saveProfileExtras();
    };
}

// Несохранённые телефон/день рождения/цвет тоже считаются несохранёнными правками.
if (typeof hasUnsavedProfileChanges === "function") {
    const originalHasUnsaved = hasUnsavedProfileChanges;
    hasUnsavedProfileChanges = function () { return originalHasUnsaved() || profileExtrasDirty(); };
}

if (typeof openProfileScreen === "function") {
    const originalOpenProfileScreen = openProfileScreen;
    openProfileScreen = function (...args) {
        const result = originalOpenProfileScreen.apply(this, args);
        loadProfileExtras();
        return result;
    };
}

/* ---- разделы ---- */

// Закрыть профиль перед переходом. false — человек отказался терять несохранённые правки.
function leaveProfileScreen() {
    closeProfileScreen();
    return !document.getElementById("profile-screen-backdrop")?.classList.contains("open");
}
function profileOpenSaved() {
    if (!leaveProfileScreen()) return;
    const saved = cachedChatRows.find((row) => row.chats?.type === "direct" && !row.chats?.is_secret && !row.otherUser);
    if (saved) openRealChat(saved.chat_id);
    else toast("Избранное ещё создаётся — попробуйте через секунду");
}

function profileOpenStories() {
    if (!leaveProfileScreen()) return;
    if (typeof storyNavTap === "function") storyNavTap(document.getElementById("bottom-nav-story") || document.body);
}

function profileOpenCalls() {
    if (!leaveProfileScreen()) return;
    if (typeof switchMobileTab === "function") switchMobileTab("calls");
}

/* ---- устройства ---- */

function describeThisDevice() {
    const ua = navigator.userAgent;
    const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "Устройство";
    if (window.kabanDesktop) return { title: "KABAN для Windows", sub: "Программа для компьютера", icon: "💻" };
    const browser = /YaBrowser/.test(ua) ? "Яндекс Браузер" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Браузер";
    const mobile = /Android|iPhone|iPad|iPod|Mobile/.test(ua);
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
    return { title: `${browser} · ${os}`, sub: standalone ? "Приложение на главном экране" : "Веб-версия", icon: mobile ? "📱" : "🖥️" };
}

function openDevicesModal() {
    const d = describeThisDevice();
    document.getElementById("devices-current").innerHTML = `
        <div class="device-row">
            <span class="device-icon" aria-hidden="true">${d.icon}</span>
            <span class="device-copy"><b>${escapeHTML(d.title)}</b><em>${escapeHTML(d.sub)} · <span class="device-online">в сети</span></em></span>
        </div>`;
    const backdrop = document.getElementById("devices-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");
}

function closeDevicesModal() {
    const backdrop = document.getElementById("devices-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

async function terminateOtherSessions() {
    if (!confirm("Выйти из KABAN на всех других устройствах?")) return;
    const button = document.getElementById("devices-terminate-btn");
    button.disabled = true;
    try {
        await KabanAPI.signOutOtherSessions();
        toast("Готово: другие сеансы завершены");
        closeDevicesModal();
    } catch (error) {
        toast("Не удалось завершить сеансы: " + (error?.message || error));
    } finally {
        button.disabled = false;
    }
}

/* ---- телефон и день рождения в карточке собеседника ---- */

let contactExtrasRequest = 0;

async function fillContactExtras(userId) {
    const rows = document.querySelectorAll(".contact-extra-row");
    rows.forEach((row) => { row.hidden = true; });
    if (!userId || typeof KabanAPI === "undefined" || !KabanAPI.getUserExtras) return;
    const token = ++contactExtrasRequest;
    const extras = await KabanAPI.getUserExtras(userId);
    if (token !== contactExtrasRequest || !extras) return;
    const values = { phone: formatPhonePretty(extras.phone), birthday: formatBirthday(extras.birthday) };
    document.querySelectorAll('[data-contact-field="phone"]').forEach((el) => { el.textContent = values.phone; });
    document.querySelectorAll('[data-contact-field="birthday"]').forEach((el) => { el.textContent = values.birthday; });
    rows.forEach((row) => { row.hidden = !values[row.dataset.extra]; });
    // Цвет профиля собеседника — в шапке его карточки.
    if (extras.profile_color !== null && extras.profile_color !== undefined) {
        document.querySelectorAll(".contact-modal, .info.info-window").forEach((card) => card.style.setProperty("--gh", String(extras.profile_color)));
    }
}

if (typeof applyContactProfile === "function") {
    const originalApplyContactProfile = applyContactProfile;
    applyContactProfile = function (profile) {
        originalApplyContactProfile(profile);
        fillContactExtras(typeof currentChatType !== "undefined" && currentChatType === "direct" ? currentOtherUserId : null);
    };
}
