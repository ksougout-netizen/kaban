/* ============================================================================
   МЕЛОЧИ ДЛЯ УДОБСТВА (всё поверх существующего кода, ничего не заменяя):
     1. ↑ в пустой строке ввода — править своё последнее сообщение;
     2. переход к дате в поиске по чату (календарь);
     3. «В закладки» для выбранных сообщений (панель выбора);
     4. всплывающая подсказка у выделенного текста: «Ответить» (цитатой) и «Копировать»;
     5. предпросмотр документов перед отправкой (список файлов, можно убрать лишние).
   ========================================================================= */

(function () {
    const $ = (id) => document.getElementById(id);

    /* ---------- 1. ↑ — править последнее своё сообщение ---------- */

    function lastEditableRow() {
        const rows = Array.from(document.querySelectorAll("#messages .message-row.sent[data-message-id]")).reverse();
        return rows.find((row) => {
            const msg = realMessagesById.get(row.dataset.messageId);
            return msg && msg.type === "text" && !msg.deleted_at && msg.sender_id === myRealUserId
                && !msg.attachment_meta?.poll && !msg.attachment_meta?.game && !row.querySelector(".message-edit-form");
        });
    }

    $("input")?.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
        const input = event.currentTarget;
        if (input.value !== "" || currentChatIsSecret || !currentChatId) return;
        if (typeof pendingReply !== "undefined" && pendingReply) return;
        const row = lastEditableRow();
        if (!row) return;
        event.preventDefault();
        row.scrollIntoView({ block: "center", behavior: "smooth" });
        startEditMessage(row);
    });

    /* ---------- 2. Переход к дате ---------- */

    function installDateJump() {
        const bar = $("chat-search");
        if (!bar || bar.querySelector(".chat-search-date")) return;

        const wrap = document.createElement("span");
        wrap.className = "chat-search-date";
        wrap.innerHTML = `
            <button class="chat-search-action" type="button" aria-label="Перейти к дате" title="Перейти к дате">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>
            </button>
            <input type="date" class="chat-search-date-input" tabindex="-1" aria-hidden="true">`;
        const beginBtn = Array.from(bar.querySelectorAll(".chat-search-action")).find((b) => /начало чата/i.test(b.title || ""));
        bar.insertBefore(wrap, beginBtn || bar.lastElementChild);

        const btn = wrap.querySelector("button");
        const dateInput = wrap.querySelector("input");
        dateInput.max = new Date().toISOString().slice(0, 10);

        btn.addEventListener("click", () => {
            try { dateInput.showPicker(); } catch { dateInput.focus(); dateInput.click(); }
        });
        dateInput.addEventListener("change", () => jumpToDate(dateInput.value).finally(() => { dateInput.value = ""; }));
    }

    async function jumpToDate(value) {
        if (!value || !currentChatId) return;
        const chatId = currentChatId;
        const start = new Date(`${value}T00:00:00`);      // начало выбранного дня по местному времени
        if (isNaN(start)) return;

        let target = null;
        try {
            const { data, error } = await getSupabaseClient()
                .from("messages")
                .select("id, created_at")
                .eq("chat_id", chatId)
                .is("deleted_at", null)
                .gte("created_at", start.toISOString())
                .order("created_at", { ascending: true })
                .limit(1);
            if (error) throw error;
            target = data?.[0] || null;
        } catch {
            toast("Не удалось найти сообщения за эту дату");
            return;
        }

        if (!target) { toast("С этой даты сообщений нет"); return; }
        if (typeof closeChatSearch === "function") closeChatSearch();
        toast("Переходим к " + start.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) + "…");
        await jumpToMessage(chatId, target.id);
    }
    window.jumpToDate = jumpToDate;

    /* ---------- 3. «В закладки» для выбранных ---------- */

    function installBookmarkButton() {
        const actions = document.querySelector("#selection-bar .selection-bar-actions");
        if (!actions || actions.querySelector(".sel-bookmark")) return;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sel-bookmark";
        btn.title = "В закладки";
        btn.setAttribute("aria-label", "Добавить выбранные в закладки");
        btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z"/></svg><span>В закладки</span>`;
        btn.addEventListener("click", saveSelectedToBookmarks);
        actions.insertBefore(btn, actions.children[1] || null);
    }

    function saveSelectedToBookmarks() {
        const ids = [...selectedMessageIds];
        if (!ids.length) { toast("Выберите хотя бы одно сообщение"); return; }
        if (currentChatIsSecret) { toast("В секретных чатах закладки недоступны"); return; }

        const isSaved = (id) => getSavedMessages().some((item) => item.chatId === currentChatId && item.sourceKey === id);
        const removing = ids.every(isSaved);
        const saveBefore = contextMenuTargetRow;
        let changed = 0;

        ids.forEach((id) => {
            const row = document.querySelector(`.message-row[data-message-id="${id}"]`);
            if (!row || row.classList.contains("deleted")) return;
            if (removing === isSaved(id)) {         // удаляем — только сохранённые; добавляем — только новые
                contextMenuTargetRow = row;
                contextMenuToggleSaved();
                changed++;
            }
        });
        contextMenuTargetRow = saveBefore;

        const word = changed === 1 ? "сообщение" : "сообщений";
        toast(removing ? `Убрано из закладок: ${changed} ${word}` : `Добавлено в закладки: ${changed} ${word}`);
        exitSelectionMode();
    }

    /* ---------- 4. Всплывающая подсказка у выделенного текста ---------- */

    let pop = null;

    function buildPop() {
        if (pop) return pop;
        pop = document.createElement("div");
        pop.className = "sel-pop";
        pop.hidden = true;
        pop.innerHTML = `
            <button type="button" data-act="reply"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5 3.5 11.5 10 18M3.5 11.5H14a6.5 6.5 0 0 1 6.5 6.5v1"/></svg>Ответить</button>
            <button type="button" data-act="copy"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>Копировать</button>`;
        // mousedown не должен снимать выделение — иначе цитировать будет нечего
        pop.addEventListener("mousedown", (e) => e.preventDefault());
        pop.addEventListener("click", (e) => {
            const act = e.target.closest("button")?.dataset.act;
            const sel = window.getSelection();
            const bubble = bubbleOfSelection(sel);
            if (!act || !bubble) { hidePop(); return; }
            const row = bubble.closest(".message-row");
            if (act === "reply") {
                reply(row);                          // reply() сама возьмёт выделенный фрагмент
            } else {
                navigator.clipboard?.writeText(sel.toString().trim())
                    .then(() => toast("Текст скопирован")).catch(() => toast("Не удалось скопировать"));
            }
            sel.removeAllRanges();
            hidePop();
        });
        document.body.appendChild(pop);
        return pop;
    }

    function bubbleOfSelection(sel) {
        if (!sel || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return null;
        const a = (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement)?.closest?.("#messages .message");
        const f = (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement)?.closest?.("#messages .message");
        return a && a === f ? a : null;
    }

    function hidePop() { if (pop) pop.hidden = true; }

    function updatePop() {
        if (typeof selectionMode !== "undefined" && selectionMode) { hidePop(); return; }
        const sel = window.getSelection();
        const bubble = bubbleOfSelection(sel);
        if (!bubble || !sel.toString().trim() || !bubble.closest(".message-row[data-message-id]")) { hidePop(); return; }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (!rect.width && !rect.height) { hidePop(); return; }
        const el = buildPop();
        el.hidden = false;
        const w = el.offsetWidth, h = el.offsetHeight;
        const left = Math.min(innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
        const top = rect.top - h - 8 < 8 ? rect.bottom + 8 : rect.top - h - 8;
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    if (matchMedia("(pointer: fine)").matches) {
        $("messages")?.addEventListener("mouseup", () => setTimeout(updatePop, 0));
        $("messages")?.addEventListener("scroll", hidePop, { passive: true });
        document.addEventListener("mousedown", (e) => { if (pop && !pop.contains(e.target)) hidePop(); });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") hidePop(); });
    }

    /* ---------- 5. Предпросмотр документов перед отправкой ---------- */

    function extOf(name) {
        const ext = String(name || "").includes(".") ? String(name).split(".").pop() : "";
        return /^[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toUpperCase() : "";
    }

    let docDialog = null;
    let docFiles = [];

    function closeDocPreview() {
        if (!docDialog) return;
        docDialog.classList.remove("open");
        docDialog.setAttribute("aria-hidden", "true");
        docFiles = [];
    }

    function renderDocPreview() {
        const list = docDialog.querySelector(".dp-list");
        list.innerHTML = docFiles.map((file, i) => `
            <div class="dp-item">
                <span class="dp-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h6.5L18.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5Z"/><path d="M13.5 3.5v5h5"/></svg></span>
                <span class="dp-copy">
                    <span class="dp-name">${escapeHTML(file.name)}</span>
                    <span class="dp-size">${[formatFileSize(file.size), extOf(file.name)].filter(Boolean).join(" · ")}${file.size > MAX_ATTACHMENT_SIZE ? ' · <b class="dp-warn">слишком большой</b>' : ""}</span>
                </span>
                <button type="button" class="dp-remove" data-i="${i}" aria-label="Убрать файл" title="Убрать">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
            </div>`).join("");
        const total = docFiles.reduce((s, f) => s + f.size, 0);
        docDialog.querySelector(".dp-title").textContent = docFiles.length === 1 ? "Отправить файл" : `Отправить файлы: ${docFiles.length}`;
        docDialog.querySelector(".dp-total").textContent = docFiles.length > 1 ? `Всего ${formatFileSize(total)}` : "";
        docDialog.querySelector(".dp-send").disabled = !docFiles.length;
    }

    function buildDocDialog() {
        if (docDialog) return docDialog;
        docDialog = document.createElement("div");
        docDialog.className = "dp-backdrop";
        docDialog.setAttribute("aria-hidden", "true");
        docDialog.innerHTML = `
            <div class="dp-card" role="dialog" aria-modal="true" aria-label="Отправка файлов">
                <div class="dp-head"><span class="dp-title"></span><span class="dp-total"></span></div>
                <div class="dp-list"></div>
                <div class="dp-actions">
                    <button type="button" class="dp-cancel">Отмена</button>
                    <button type="button" class="dp-send">Отправить</button>
                </div>
            </div>`;
        document.body.appendChild(docDialog);

        docDialog.addEventListener("click", (e) => {
            if (e.target === docDialog) { closeDocPreview(); return; }
            const rm = e.target.closest(".dp-remove");
            if (rm) {
                docFiles.splice(Number(rm.dataset.i), 1);
                if (!docFiles.length) closeDocPreview(); else renderDocPreview();
            }
        });
        docDialog.querySelector(".dp-cancel").addEventListener("click", closeDocPreview);
        docDialog.querySelector(".dp-send").addEventListener("click", async () => {
            const files = docFiles.slice();
            closeDocPreview();
            for (const file of files) {                  // по одному — у каждого свой прогресс и сообщение
                await sendRealAttachment(file, "document");
            }
        });
        document.addEventListener("keydown", (e) => {
            if (!docDialog.classList.contains("open")) return;
            if (e.key === "Escape") closeDocPreview();
            else if (e.key === "Enter" && !e.target.closest("button")) docDialog.querySelector(".dp-send").click();
        });
        return docDialog;
    }

    function openDocPreview(files) {
        buildDocDialog();
        docFiles = files.slice(0, 10);
        if (files.length > 10) toast("Можно отправить не больше 10 файлов за раз");
        renderDocPreview();
        docDialog.classList.add("open");
        docDialog.setAttribute("aria-hidden", "false");
        docDialog.querySelector(".dp-send").focus();
    }

    if (typeof handleAttachFile === "function") {
        const original = handleAttachFile;
        handleAttachFile = function (input, kind) {
            if (kind !== "document" || !currentChatId || currentChatIsSecret) return original.apply(this, arguments);
            const files = [...(input?.files || [])];
            try { input.value = ""; } catch { /* у перетаскивания input — простой объект */ }
            if (!files.length) return;
            if (typeof closeAttachMenu === "function") closeAttachMenu();
            openDocPreview(files);
        };
    }

    installBookmarkButton();
    installDateJump();
})();
