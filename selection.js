/* ============================================================================
   ВЫБОР НЕСКОЛЬКИХ СООБЩЕНИЙ — как в Telegram.
   Базовый режим (enterSelectionMode, toggleMessageSelection, …) живёт в
   script-messages.js; здесь он дорабатывается:
     • панель «Выбрано: N» с кнопками «Копировать», «Переслать», «Удалить»
       (недоступны, пока ничего не выбрано);
     • Ctrl/⌘ + клик по сообщению — войти в режим выбора;
     • Shift + клик — выбрать диапазон; зажать и провести мышью — выбрать несколько подряд;
     • Ctrl+A — выбрать всё, Ctrl+C — копировать, Delete — удалить, Esc — выйти;
     • пересылка и копирование идут в порядке сообщений в чате, а не в порядке кликов.
   ========================================================================= */

(function () {
    const box = () => document.getElementById("messages");
    const rows = () => Array.from(box().querySelectorAll(".message-row[data-message-id]"));

    let anchorId = null;           // от какого сообщения тянется диапазон
    let drag = null;               // {anchorRow, want, moved}

    function setSelected(row, on) {
        const id = row.dataset.messageId;
        if (!id) return;
        if (on) { selectedMessageIds.add(id); row.classList.add("selected"); }
        else { selectedMessageIds.delete(id); row.classList.remove("selected"); }
    }

    function selectRange(fromRow, toRow, on) {
        const list = rows();
        let a = list.indexOf(fromRow), b = list.indexOf(toRow);
        if (a < 0 || b < 0) return;
        if (a > b) [a, b] = [b, a];
        for (let i = a; i <= b; i++) setSelected(list[i], on);
        updateSelectionBar();
    }

    function orderedSelectedIds() {
        return rows().map((r) => r.dataset.messageId).filter((id) => selectedMessageIds.has(id));
    }

    /* ---------- панель ---------- */

    window.updateSelectionBar = function () {
        const n = selectedMessageIds.size;
        const count = document.getElementById("selection-bar-count");
        if (count) count.textContent = n === 0 ? "Выберите сообщения" : `Выбрано: ${n}`;
        document.querySelectorAll("#selection-bar .selection-bar-actions button").forEach((b) => { b.disabled = n === 0; });
    };

    window.forwardSelectedMessages = function () {
        const ids = orderedSelectedIds();
        if (!ids.length) { toast("Выберите хотя бы одно сообщение"); return; }
        openForwardPopover(ids);
    };

    window.deleteSelectedMessages = function () {
        const ids = orderedSelectedIds();
        if (!ids.length) { toast("Выберите хотя бы одно сообщение"); return; }
        openDeleteChoiceModal(ids);
    };

    function senderNameOf(msg, row) {
        if (row.classList.contains("sent")) {
            return (typeof cachedMyProfile !== "undefined" && (cachedMyProfile?.display_name || cachedMyProfile?.username)) || "Вы";
        }
        const member = (typeof currentChatMembersById !== "undefined" && msg?.sender_id) ? currentChatMembersById.get(msg.sender_id) : null;
        return member?.display_name || member?.username
            || row.querySelector(".message-sender-name")?.textContent?.trim()
            || document.getElementById("chat-title")?.textContent?.trim() || "";
    }

    function textOf(msg, row) {
        if (msg?.type === "text" && typeof msg.text === "string" && !msg.attachment_meta?.poll && !msg.attachment_meta?.game) return msg.text;
        if (msg && typeof messagePreviewText === "function") {
            const preview = messagePreviewText(msg);
            if (preview) return msg.text && msg.type !== "text" ? `${preview}\n${msg.text}` : preview;
        }
        const clone = row.querySelector(".message")?.cloneNode(true);
        if (!clone) return "";
        clone.querySelectorAll(".message-time, .message-reply-quote, .message-sender-name, .link-preview, .effect-replay, .message-edited-tag").forEach((el) => el.remove());
        return clone.textContent.trim();
    }

    window.copySelectedMessages = function () {
        const ids = orderedSelectedIds();
        if (!ids.length) { toast("Выберите хотя бы одно сообщение"); return; }
        const byId = new Map(rows().map((r) => [r.dataset.messageId, r]));
        const parts = ids.map((id) => {
            const row = byId.get(id);
            const msg = realMessagesById.get(id);
            const text = textOf(msg, row);
            if (ids.length === 1) return text;
            const when = msg?.created_at ? new Date(msg.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
            return `${senderNameOf(msg, row)}, [${when}]\n${text}`;
        });
        navigator.clipboard?.writeText(parts.join("\n\n"))
            .then(() => { toast(ids.length === 1 ? "Текст скопирован" : `Скопировано сообщений: ${ids.length}`); exitSelectionMode(); })
            .catch(() => toast("Не удалось скопировать"));
    };

    window.selectAllMessages = function () {
        if (!selectionMode) enterSelectionMode();
        rows().forEach((r) => setSelected(r, true));
        updateSelectionBar();
    };

    /* ---------- мышь и клавиатура ---------- */

    // capture: срабатывает раньше обычного обработчика клика из script-messages.js
    box().addEventListener("click", (event) => {
        const row = event.target.closest(".message-row[data-message-id]");
        if (!row) return;

        if (drag?.moved) {                       // клик после протягивания — уже учтён
            drag = null;
            event.preventDefault(); event.stopPropagation();
            return;
        }

        const modifier = event.ctrlKey || event.metaKey;
        if (!selectionMode && modifier && !event.target.closest("a, button, input, textarea, video, audio")) {
            event.preventDefault(); event.stopPropagation();
            enterSelectionMode();
            toggleMessageSelection(row.dataset.messageId);
            anchorId = row.dataset.messageId;
            return;
        }

        if (!selectionMode) return;

        if (event.shiftKey && anchorId) {
            const anchor = box().querySelector(`.message-row[data-message-id="${anchorId}"]`);
            if (anchor) {
                event.preventDefault(); event.stopPropagation();
                selectRange(anchor, row, true);
                return;
            }
        }
        anchorId = row.dataset.messageId;       // обычный клик — дальше сработает переключатель
    }, true);

    box().addEventListener("pointerdown", (event) => {
        if (!selectionMode || event.pointerType !== "mouse" || event.button !== 0) return;
        const row = event.target.closest(".message-row[data-message-id]");
        if (!row) return;
        drag = { anchorRow: row, want: !row.classList.contains("selected"), moved: false };
    });

    box().addEventListener("pointermove", (event) => {
        if (!drag || !selectionMode || !(event.buttons & 1)) return;
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".message-row[data-message-id]");
        if (!row || !box().contains(row)) return;
        if (row === drag.anchorRow && !drag.moved) return;
        drag.moved = true;
        selectRange(drag.anchorRow, row, drag.want);
        anchorId = row.dataset.messageId;
    });

    document.addEventListener("pointerup", () => { if (drag && !drag.moved) drag = null; setTimeout(() => { drag = null; }, 0); });

    document.addEventListener("keydown", (event) => {
        if (!selectionMode) return;
        if (event.target.closest?.("input, textarea, [contenteditable=true]")) return;
        const key = event.key.toLowerCase();
        if (event.key === "Escape") { exitSelectionMode(); }
        else if ((event.ctrlKey || event.metaKey) && key === "a") { event.preventDefault(); selectAllMessages(); }
        else if ((event.ctrlKey || event.metaKey) && key === "c") { event.preventDefault(); copySelectedMessages(); }
        else if (event.key === "Delete") { event.preventDefault(); deleteSelectedMessages(); }
    });
})();
