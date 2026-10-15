/* ============================================================================
   ЗАКРЫТЫЕ ФАЙЛЫ ЧАТОВ (подписанные ссылки)
   Раньше бакет «attachments» был публичным: фото, голосовые и документы открывались
   по прямой ссылке кем угодно — даже без входа и даже тем, кто давно вышел из чата.
   Теперь (после private_files.sql) прямая ссылка не работает; приложение само меняет
   её на временную подписанную (на сутки), а выдаёт такие только участникам чата —
   это проверяет сервер.

   Как устроено, чтобы не трогать каждое место, где рисуются вложения:
   • в сообщениях по-прежнему хранится обычная ссылка /object/public/attachments/…;
   • наблюдатель за страницей подменяет её в src / href / poster / background-image
     на подписанную, пачками (до 100 за запрос) и с кэшем;
   • fetch() по такой ссылке (скачать, расшифровать голосовое) тоже идёт по подписанной;
   • если подписанная ссылка протухла (программа открыта больше суток) — подписываем заново.
   Пока бакет ещё публичный, всё работает так же — просто через подписанные ссылки.
   Подключается сразу после supabaseClient.js.
   ========================================================================= */

(function () {
    const MARK = "/storage/v1/object/public/attachments/";
    const TTL_SECONDS = 24 * 3600;
    const cache = new Map();      // path → { url, exp }
    const waiting = new Map();    // path → [callback]
    const queue = new Set();
    let flushTimer = null;

    function parse(url) {
        if (typeof url !== "string") return null;
        const at = url.indexOf(MARK);
        if (at < 0) return null;
        let rest = url.slice(at + MARK.length);
        let frag = "";
        const hash = rest.indexOf("#");
        if (hash >= 0) { frag = rest.slice(hash); rest = rest.slice(0, hash); }
        const query = rest.indexOf("?");
        if (query >= 0) rest = rest.slice(0, query);
        try { return { path: decodeURIComponent(rest), frag }; } catch { return { path: rest, frag }; }
    }

    function cached(url) {
        const parsed = parse(url);
        if (!parsed) return url;
        const hit = cache.get(parsed.path);
        return hit && hit.exp > Date.now() + 60000 ? hit.url + parsed.frag : null;
    }

    function sign(url, force) {
        const parsed = parse(url);
        if (!parsed) return Promise.resolve(url);
        if (force) cache.delete(parsed.path);
        const ready = cached(url);
        if (ready) return Promise.resolve(ready);
        return new Promise((resolve) => {
            if (!waiting.has(parsed.path)) waiting.set(parsed.path, []);
            waiting.get(parsed.path).push((signed) => resolve(signed ? signed + parsed.frag : url));
            queue.add(parsed.path);
            if (!flushTimer) flushTimer = setTimeout(flush, 25);
        });
    }

    function settle(path, signed) {
        const list = waiting.get(path) || [];
        waiting.delete(path);
        list.forEach((cb) => { try { cb(signed); } catch { /* ок */ } });
    }

    async function flush() {
        flushTimer = null;
        const paths = [...queue];
        queue.clear();
        for (let i = 0; i < paths.length; i += 100) {
            const chunk = paths.slice(i, i + 100);
            try {
                const { data, error } = await getSupabaseClient().storage.from("attachments").createSignedUrls(chunk, TTL_SECONDS);
                if (error) throw error;
                const got = new Set();
                (data || []).forEach((item) => {
                    if (!item?.path) return;
                    got.add(item.path);
                    if (item.signedUrl && !item.error) {
                        cache.set(item.path, { url: item.signedUrl, exp: Date.now() + TTL_SECONDS * 1000 });
                        settle(item.path, item.signedUrl);
                    } else {
                        settle(item.path, null);      // не участник чата / файла нет — оставляем как было
                    }
                });
                chunk.forEach((path) => { if (!got.has(path)) settle(path, null); });
            } catch {
                chunk.forEach((path) => settle(path, null));
            }
        }
    }

    /* ---- подмена в разметке ---- */

    const LOADING_TAGS = new Set(["IMG", "VIDEO", "AUDIO", "SOURCE"]);

    function processAttr(el, attr) {
        const value = el.getAttribute(attr);
        if (!value || value.indexOf(MARK) < 0) return;
        const ready = cached(value);
        if (ready) { el.setAttribute(attr, ready); return; }
        el.setAttribute("data-kmedia-" + attr, value);
        // Картинку/видео по закрытой ссылке не грузим (была бы ошибка и «битая» картинка) — ждём подпись.
        if (LOADING_TAGS.has(el.tagName)) el.removeAttribute(attr);
        sign(value).then((signed) => {
            if (el.getAttribute("data-kmedia-" + attr) === value) el.setAttribute(attr, signed);
        });
    }

    function processStyle(el) {
        const style = el.getAttribute("style");
        if (!style || style.indexOf(MARK) < 0) return;
        const urls = [...new Set((style.match(/https?:\/\/[^"')\s]+/g) || []).filter((u) => u.indexOf(MARK) >= 0))];
        Promise.all(urls.map((u) => sign(u).then((s) => [u, s]))).then((pairs) => {
            let next = el.getAttribute("style") || "";
            pairs.forEach(([from, to]) => { next = next.split(from).join(to); });
            if (next !== el.getAttribute("style")) el.setAttribute("style", next);
        });
    }

    function visit(el) {
        processAttr(el, "src");
        processAttr(el, "href");
        processAttr(el, "poster");
        processStyle(el);
    }

    function processTree(root) {
        if (!root || root.nodeType !== 1) return;
        visit(root);
        // Без потомков нечего и искать (большинство вставок — текст, иконки, мелкие узлы).
        if (!root.firstElementChild) return;
        root.querySelectorAll("[src*='/object/public/attachments/'], [href*='/object/public/attachments/'], [poster*='/object/public/attachments/'], [style*='/object/public/attachments/']").forEach(visit);
    }

    new MutationObserver((mutations) => {
        mutations.forEach((m) => {
            if (m.type === "childList") m.addedNodes.forEach(processTree);
            // Смена атрибута касается только самого элемента. Раньше каждый style-апдейт
            // (тема, индикаторы громкости, прогресс, анимации) обходил ещё и всё его
            // поддерево — для body или ленты это поиск по всему документу.
            else if (m.type === "attributes" && m.target.nodeType === 1) visit(m.target);
        });
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href", "poster", "style"] });

    document.addEventListener("DOMContentLoaded", () => processTree(document.body));

    // Подписанная ссылка истекла (программа открыта больше суток) — подписываем заново, один раз.
    document.addEventListener("error", (event) => {
        const el = event.target;
        if (!el || !LOADING_TAGS.has(el.tagName)) return;
        const original = el.getAttribute("data-kmedia-src");
        if (!original || el.dataset.kmediaRetried) return;
        el.dataset.kmediaRetried = "1";
        event.stopImmediatePropagation();
        sign(original, true).then((signed) => { if (signed !== original) el.setAttribute("src", signed); });
    }, true);

    /* ---- fetch по закрытой ссылке ---- */
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : input?.url;
        if (url && url.indexOf(MARK) >= 0) return sign(url).then((signed) => originalFetch.call(this, signed, init));
        return originalFetch.apply(this, arguments);
    };

    window.KabanMedia = {
        sign,
        isAttachmentUrl: (url) => !!parse(url),
        pathOf: (url) => parse(url)?.path || null
    };
})();
