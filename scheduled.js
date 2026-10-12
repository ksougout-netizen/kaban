/* ============================================================================
   ОТЛОЖЕННАЯ ОТПРАВКА. Удержание кнопки отправки → «Отправить позже» → время.
   Сообщения хранятся на этом устройстве (localStorage, отдельно для каждого
   аккаунта) и уходят, когда наступает время и KABAN открыт (вкладка может быть в
   фоне). Если время пришло, пока приложение было закрыто, сообщение уйдёт при
   следующем запуске. Сама отправка идёт через очередь KabanOutbox (resilience.js):
   без сети сообщение дождётся её и не задвоится.
   Подключается после resilience.js.
   ============================================================================ */

const SCHEDULED_MAX_PER_CHAT = 20;
let scheduledTimer = null;

function scheduledKey() { return "kaban-scheduled:" + (typeof myRealUserId !== "undefined" && myRealUserId ? myRealUserId : "guest"); }

function loadScheduled() {
    try {
        const list = JSON.parse(localStorage.getItem(scheduledKey()) || "[]");
        return Array.isArray(list) ? list : [];
    } catch { return []; }
}

function saveScheduled(list) {
    try { localStorage.setItem(scheduledKey(), JSON.stringify(list)); return true; }
    catch { toast("Не удалось сохранить: нет места в браузере"); return false; }
}

function scheduledPad(n) { return String(n).padStart(2, "0"); }

function scheduledInputValue(date) {
    return `${date.getFullYear()}-${scheduledPad(date.getMonth() + 1)}-${scheduledPad(date.getDate())}T${scheduledPad(date.getHours())}:${scheduledPad(date.getMinutes())}`;
}

function buildScheduleModal() {

    if (document.getElementById("schedule-backdrop")) return;

    const backdrop = document.createElement("div");
    backdrop.className = "forward-backdrop";
    backdrop.id = "schedule-backdrop";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.innerHTML = `
        <section class="forward-modal group-info-modal" role="dialog" aria-modal="true" aria-label="Отправить позже">
            <div class="forward-modal-header">
                <span>Отправить позже</span>
                <button type="button" class="settings-close" data-schedule-act="close" aria-label="Закрыть">×</button>
            </div>
            <div id="schedule-new">
                <div class="reminder-preview" id="schedule-preview"></div>
                <div class="reminder-options" id="schedule-options"></div>
                <div class="group-members-head poll-head"><span>Своё время</span></div>
                <div class="reminder-custom">
                    <input type="datetime-local" id="schedule-custom-input" class="poll-field">
                    <button type="button" class="delete-choice-btn reminder-custom-btn" data-schedule-act="custom">Запланировать</button>
                </div>
            </div>
            <div id="schedule-existing"></div>
            <p class="group-perms-hint">Сообщение хранится на этом устройстве и уйдёт, когда KABAN открыт в назначенное время. Если он был закрыт — отправится при следующем запуске.</p>
        </section>`;
    document.body.appendChild(backdrop);

    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) { closeScheduleModal(); return; }
        const button = event.target.closest("[data-schedule-act], .reminder-option[data-ts]");
        if (!button) return;
        if (button.dataset.ts) { createScheduled(Number(button.dataset.ts)); return; }
        const act = button.dataset.scheduleAct;
        if (act === "close") closeScheduleModal();
        else if (act === "custom") createScheduledFromCustom();
        else if (act === "delete") deleteScheduled(button.dataset.id);
        else if (act === "now") sendScheduledNow(button.dataset.id);
    });

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && backdrop.classList.contains("open")) {
            event.stopImmediatePropagation();
            closeScheduleModal();
        }
    }, true);

}

function openSchedulePicker() {

    if (!currentChatId) { toast("Откройте чат, чтобы запланировать сообщение"); return; }
    if (currentChatIsSecret) { toast("В секретных чатах отложенная отправка недоступна"); return; }

    buildScheduleModal();

    const text = (document.getElementById("input")?.value || "").trim();
    const hasText = !!text;
    document.getElementById("schedule-new").hidden = !hasText;

    if (hasText) {

        document.getElementById("schedule-preview").textContent = text.length > 160 ? text.slice(0, 157) + "…" : text;

        const now = new Date();
        const evening = new Date(now); evening.setHours(19, 0, 0, 0);
        const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
        const monday = new Date(now); monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7)); monday.setHours(9, 0, 0, 0);

        const options = [
            { label: "Через 15 минут", ts: now.getTime() + 15 * 60000 },
            { label: "Через час", ts: now.getTime() + 60 * 60000 },
            ...(evening > now ? [{ label: "Сегодня вечером · 19:00", ts: evening.getTime() }] : []),
            { label: "Завтра утром · 9:00", ts: tomorrow.getTime() },
            { label: "В понедельник · 9:00", ts: monday.getTime() }
        ];
        document.getElementById("schedule-options").innerHTML = options.map((o) =>
            `<button type="button" class="reminder-option" data-ts="${o.ts}">${o.label}</button>`).join("");

        const custom = document.getElementById("schedule-custom-input");
        custom.value = scheduledInputValue(new Date(now.getTime() + 3600000));
        custom.min = scheduledInputValue(now);

    }

    renderScheduledForChat();

    const backdrop = document.getElementById("schedule-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeScheduleModal() {
    const backdrop = document.getElementById("schedule-backdrop");
    if (!backdrop) return;
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

function renderScheduledForChat() {

    const box = document.getElementById("schedule-existing");
    if (!box) return;
    const list = loadScheduled().filter((x) => x.chatId === currentChatId).sort((a, b) => a.due - b.due);

    if (!list.length) { box.innerHTML = ""; return; }

    box.innerHTML = `<div class="group-members-head poll-head"><span>Запланировано в этом чате</span></div>` + list.map((x) => `
        <div class="reminder-row">
            <div class="reminder-row-main">
                <span class="reminder-row-time">${escapeHTML(formatReminderTime(x.due))}</span>
                <span class="reminder-row-text">${escapeHTML(x.text.length > 120 ? x.text.slice(0, 117) + "…" : x.text)}</span>
            </div>
            <button type="button" class="reminder-row-delete" data-schedule-act="now" data-id="${escapeHTML(x.id)}" aria-label="Отправить сейчас" title="Отправить сейчас">➤</button>
            <button type="button" class="reminder-row-delete" data-schedule-act="delete" data-id="${escapeHTML(x.id)}" aria-label="Удалить" title="Удалить">✕</button>
        </div>`).join("");

}

function createScheduledFromCustom() {
    const value = document.getElementById("schedule-custom-input").value;
    const ts = value ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(ts) || ts <= Date.now() + 5000) { toast("Выберите время в будущем"); return; }
    createScheduled(ts);
}

function createScheduled(dueTs) {

    const input = document.getElementById("input");
    const text = (input?.value || "").trim();
    if (!text || !currentChatId) return;
    if (text.length > MAX_MESSAGE_LENGTH) { toast(`Сообщение длиннее ${MAX_MESSAGE_LENGTH} символов — сократите текст`); return; }

    const list = loadScheduled();
    if (list.filter((x) => x.chatId === currentChatId).length >= SCHEDULED_MAX_PER_CHAT) {
        toast(`В одном чате можно запланировать не больше ${SCHEDULED_MAX_PER_CHAT} сообщений`);
        return;
    }

    list.push({
        id: KabanOutbox.newId(),
        chatId: currentChatId,
        chatTitle: currentChatTitle || "Чат",
        text,
        due: dueTs
    });
    if (!saveScheduled(list)) return;

    input.value = "";
    if (typeof resizeComposer === "function") resizeComposer();
    if (typeof updateComposerAction === "function") updateComposerAction();
    if (appSettings.saveDraft) { try { localStorage.removeItem(draftStorageKey(currentChatId)); } catch { /* не критично */ } }

    closeScheduleModal();
    toast("Отправлю " + formatReminderTime(dueTs));
    syncScheduledBadge();

}

function deleteScheduled(id) {
    saveScheduled(loadScheduled().filter((x) => x.id !== id));
    renderScheduledForChat();
    syncScheduledBadge();
}

function sendScheduledNow(id) {
    const item = loadScheduled().find((x) => x.id === id);
    if (!item) return;
    dispatchScheduled(item);
    saveScheduled(loadScheduled().filter((x) => x.id !== id));
    renderScheduledForChat();
    syncScheduledBadge();
}

// Передаём сообщение в очередь отправки — она сама дождётся сети и не задвоит.
function dispatchScheduled(item) {
    KabanOutbox.enqueue({ clientId: item.id, chatId: item.chatId, text: item.text, replyToId: null, attachmentMeta: null });
    KabanOutbox.resetAttempts();
}

function checkDueScheduled() {

    if (typeof myRealUserId === "undefined" || !myRealUserId || typeof KabanOutbox === "undefined") return;
    const list = loadScheduled();
    if (!list.length) return;

    const now = Date.now();
    const due = list.filter((x) => x.due <= now);
    if (!due.length) return;

    // Сначала убираем из списка, потом отправляем: при сбое между шагами лучше
    // потерять напоминание о плане, чем отправить дважды (id у очереди всё равно один).
    if (!saveScheduled(list.filter((x) => x.due > now))) return;
    due.sort((a, b) => a.due - b.due).forEach(dispatchScheduled);
    syncScheduledBadge();
    toast(due.length === 1 ? "Отправлено отложенное сообщение" : `Отправлено отложенных сообщений: ${due.length}`);

}

// Подсказка на кнопке отправки: сколько сообщений ждут в этом чате.
function syncScheduledBadge() {
    const button = document.getElementById("composer-send-button");
    if (!button) return;
    const count = currentChatId ? loadScheduled().filter((x) => x.chatId === currentChatId).length : 0;
    button.classList.toggle("has-scheduled", count > 0);
    const base = "Нажмите — отправить, удерживайте — эффект или «Отправить позже»";
    button.title = count ? `${base} (запланировано: ${count})` : base;
}

function startScheduledTimer() {
    clearInterval(scheduledTimer);
    scheduledTimer = setInterval(checkDueScheduled, 15000);
    setTimeout(checkDueScheduled, 3000);
}

startScheduledTimer();
window.addEventListener("online", () => setTimeout(checkDueScheduled, 1500));
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDueScheduled(); });

// Открыли другой чат — обновляем отметку на кнопке отправки.
if (typeof openRealChat === "function") {
    const originalOpenRealChat = openRealChat;
    openRealChat = async function (...args) {
        const result = await originalOpenRealChat.apply(this, args);
        syncScheduledBadge();
        return result;
    };
}
