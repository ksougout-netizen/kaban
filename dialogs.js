/* ============================================================================
   ОКНА ВОПРОСОВ В СТИЛЕ KABAN вместо системных confirm() / prompt().
   Системные окна выглядели чужеродно (в приложении для Android — белое окно WebView
   с английскими «OK / Cancel», в браузере — «Сайт localhost пишет…»), а prompt() в
   программе для ПК не работает вовсе. Здесь — та же шторка/карточка, что у остальных
   подтверждений (forward-modal), с затемнением, «Назад»/Esc = «Отмена».

     if (!(await kabanConfirm("Удалить историю?", { ok: "Удалить", danger: true }))) return;
     const url = await kabanPrompt("Ссылка:", "https://");   // null — отмена
   ========================================================================= */

(function () {
    "use strict";

    let current = null;   // { backdrop, finish }

    function build({ title, text, ok, cancel, danger, input }) {
        const backdrop = document.createElement("div");
        backdrop.className = "forward-backdrop kaban-dialog-backdrop";
        backdrop.id = "kaban-dialog-backdrop";
        backdrop.setAttribute("aria-hidden", "false");
        const section = document.createElement("section");
        section.className = "forward-modal kaban-dialog";
        section.setAttribute("role", "alertdialog");
        section.setAttribute("aria-modal", "true");
        section.innerHTML = `
            ${title ? `<div class="forward-modal-header"><span class="kaban-dialog-title"></span></div>` : ""}
            <p class="kaban-dialog-text"></p>
            ${input ? `<input class="kaban-dialog-input" type="text" autocomplete="off">` : ""}
            <div class="delete-choice-actions">
                <button type="button" class="delete-choice-btn${danger ? " danger" : " primary"}" data-kd="ok"></button>
                <button type="button" class="delete-choice-btn" data-kd="cancel"></button>
            </div>`;
        if (title) section.querySelector(".kaban-dialog-title").textContent = title;
        section.querySelector(".kaban-dialog-text").textContent = text || "";
        section.querySelector('[data-kd="ok"]').textContent = ok;
        section.querySelector('[data-kd="cancel"]').textContent = cancel;
        backdrop.appendChild(section);
        return backdrop;
    }

    function show(options) {
        // Новый вопрос поверх старого — старый считается отменённым.
        current?.finish(null);
        return new Promise((resolve) => {
            const backdrop = build(options);
            document.body.appendChild(backdrop);
            const field = backdrop.querySelector(".kaban-dialog-input");
            if (field) field.value = options.value || "";

            const cancelValue = field ? null : false;
            // Esc на компьютере, «Назад» на Android — отмена; окна под вопросом не трогаем.
            const onKey = (event) => {
                if (event.key !== "Escape") return;
                event.stopImmediatePropagation();
                event.preventDefault();
                finish(cancelValue);
            };
            let done = false;
            function finish(result) {
                if (done) return;
                done = true;
                window.removeEventListener("keydown", onKey, true);
                if (current?.backdrop === backdrop) current = null;
                backdrop.classList.remove("open");
                setTimeout(() => backdrop.remove(), 250);
                resolve(result);
            }
            window.addEventListener("keydown", onKey, true);
            current = { backdrop, finish };

            backdrop.addEventListener("click", (event) => {
                const kd = event.target.closest("[data-kd]")?.dataset.kd;
                if (kd === "ok") finish(field ? field.value : true);
                else if (kd === "cancel" || event.target === backdrop) finish(cancelValue);
            });
            backdrop.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && field) { event.preventDefault(); finish(field.value); }
            });

            requestAnimationFrame(() => {
                backdrop.classList.add("open");
                // Поле — сразу в фокус (клавиатура). Кнопку — только при работе с клавиатуры/мыши:
                // на сенсорном экране это лишь рамка фокуса вокруг «Удалить».
                if (field) { field.focus({ preventScroll: true }); field.select(); }
                else if (!window.matchMedia("(pointer: coarse)").matches) backdrop.querySelector('[data-kd="ok"]').focus({ preventScroll: true });
            });
        });
    }

    window.kabanConfirm = (text, { title = "", ok = "Да", cancel = "Отмена", danger = false } = {}) =>
        show({ title, text, ok, cancel, danger });

    window.kabanPrompt = (text, value = "", { title = "", ok = "Готово", cancel = "Отмена" } = {}) =>
        show({ title, text, ok, cancel, input: true, value });
})();
