/* ============================================================================
   ИИ-ШУМОДАВ KABAN — нейросеть DeepFilterNet3 (открытая, MIT/Apache, vendor/dfn3*).
   Уровень коммерческих шумодавов (Krisp и т.п.): убирает клавиатуру, вентилятор, гул
   и фон, голос почти не трогает. Замеры (речь + шум при SNR 5 дБ, 48 кГц):
     вентилятор −55 дБ, клавиатура −43 дБ, всё вместе −28 дБ; качество речи (SI-SDR)
     +5…+9 дБ; громкость голоса −0,6 дБ; ~4% одного ядра ПК; задержка ~41 мс.
   Работает узлом AudioWorklet сразу за микрофоном — и в голосовых комнатах (voice.js),
   и в звонках 1:1 / групповых (openCallMic в script-core.js).

   Режимы (voiceSettings.noiseMode): "ai" — эта нейросеть; "browser" — встроенный шумодав
   браузера (слабее, зато почти без нагрузки — по умолчанию на слабых телефонах);
   "off" — без обработки. Сила ИИ (noiseStrength): "max" — фон исчезает полностью;
   "soft" — фон тише ~на 20 дБ, но голос не «подрагивает», даже если печатать во
   время фразы (на «max» щелчок, попавший на слово, вырезается вместе с ним на 10–20 мс).

   Файлы (24 МБ: движок 16 + модель 8) грузятся только когда нужен голос — не при
   запуске. На ПК и в Android они локальные (доли секунды); на сайте — один раз, потом
   из кэша браузера. Не успели к открытию микрофона — пока работает браузерный
   шумодав, а как догрузятся, микрофон тихо переоткрывается уже с ИИ.
   ========================================================================= */

const KabanNoise = (() => {
    "use strict";

    // Метка версии ФАЙЛОВ модели, а не приложения: иначе каждый выпуск KABAN заставлял бы
    // заново качать 24 МБ. Менять только вместе с самими vendor/dfn3*.
    const ASSET_VER = "dfn3-1.3.0";
    const FILES = { script: "vendor/dfn3.js", wasm: "vendor/dfn3_bg.wasm", model: "vendor/dfn3_model.bin" };
    // Предел подавления в дБ (параметр модели). 22 — граница, до которой голос не режется
    // при печати во время речи (0,7% «провалов» против 4% у полного подавления).
    const STRENGTH = { max: 100, soft: 22 };
    const SAMPLE_RATE = 48000;   // модель работает только на 48 кГц

    let assets = null;           // { wasmModule, modelBytes, workletCode }
    let loading = null;
    let broken = null;           // необратимо: нет AudioWorklet / WebAssembly SIMD
    const ctxModules = new WeakMap();   // AudioContext → Promise подключения модуля воркета
    const pools = new WeakMap();        // AudioContext → узлы (переиспользуются между звонками)
    const inUse = new Set();
    const listeners = new Set();

    const settings = () => (typeof voiceSettings !== "undefined" ? voiceSettings : {});
    const mode = () => settings().noiseMode || "ai";
    const level = () => STRENGTH[settings().noiseStrength] ?? STRENGTH.max;
    const emit = () => listeners.forEach((fn) => { try { fn(status()); } catch { /* ок */ } });

    // "ai" → idle | loading | ready | active | unavailable;  иначе "browser" | "off".
    function status() {
        if (mode() !== "ai") return mode();
        if (broken) return "unavailable";   // работает браузерный (см. browserSuppression)
        if (assets) return inUse.size ? "active" : "ready";
        return loading ? "loading" : "idle";
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src; s.async = true;
            s.onload = resolve;
            s.onerror = () => reject(new Error("не загрузился " + src));
            document.head.appendChild(s);
        });
    }
    async function fetchBytes(url) {
        const r = await fetch(`${url}?a=${ASSET_VER}`);
        if (!r.ok) throw new Error(`${url}: ${r.status}`);
        return r.arrayBuffer();
    }

    function prepare() {
        if (assets) return Promise.resolve(assets);
        if (broken) return Promise.reject(broken);
        if (!loading) {
            loading = (async () => {
                if (typeof AudioWorkletNode !== "function" || typeof WebAssembly !== "object") {
                    throw Object.assign(new Error("нет AudioWorklet или WebAssembly"), { permanent: true });
                }
                if (!window.DeepFilterNet3?.workletCode) await loadScript(`${FILES.script}?a=${ASSET_VER}`);
                const [wasm, modelBytes] = await Promise.all([fetchBytes(FILES.wasm), fetchBytes(FILES.model)]);
                let wasmModule;
                // Не скомпилировался — браузер без WebAssembly SIMD: повторять бессмысленно.
                try { wasmModule = await WebAssembly.compile(wasm); }
                catch (error) { throw Object.assign(error, { permanent: true }); }
                assets = { wasmModule, modelBytes, workletCode: window.DeepFilterNet3.workletCode };
                return assets;
            })();
            // Сетевая ошибка — попробуем при следующем звонке; несовместимость — нет.
            loading.then(emit, (error) => { if (error?.permanent) broken = error; loading = null; console.warn("ИИ-шумодав недоступен", error); emit(); });
            emit();
        }
        return loading;
    }

    // Заранее (открыли комнаты, звонят, начинаем звонок) — чтобы к микрофону уже было готово.
    function warm() {
        if (mode() === "ai" && !assets && !broken) prepare().catch(() => { /* причина — в status() */ });
    }

    // Готов ли ИИ за отведённое время: на ПК/Android файлы локальные и успевают с запасом.
    async function readyWithin(ms) {
        if (mode() !== "ai" || broken) return false;
        if (assets) return true;
        try {
            return await Promise.race([prepare().then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
        } catch { return false; }
    }

    // Включать ли шумодав БРАУЗЕРА при открытии микрофона: в режиме «Обычное», а в режиме
    // «ИИ» — пока нейросеть не готова (два шумодава подряд портили бы голос).
    const browserSuppression = () => mode() === "browser" || (mode() === "ai" && (!assets || !!broken));
    // Ставить ли узел нейросети прямо сейчас.
    const useNode = () => mode() === "ai" && !!assets && !broken;

    // Узел шумодава для контекста (подключать: микрофон → узел → дальше по цепочке).
    async function acquire(ctx) {
        if (!useNode() || !ctx || ctx.sampleRate !== SAMPLE_RATE) return null;
        try {
            // Модуль воркета — один раз на контекст: повторная регистрация того же
            // процессора падает, а контекст у комнат и звонков общий на всю сессию.
            if (!ctxModules.has(ctx)) {
                const url = URL.createObjectURL(new Blob([assets.workletCode], { type: "application/javascript" }));
                ctxModules.set(ctx, ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)));
            }
            await ctxModules.get(ctx);
            let pool = pools.get(ctx);
            if (!pool) pools.set(ctx, pool = []);
            // Свободный узел с прошлого звонка: загрузка модели в узел тяжёлая (идёт в
            // звуковом потоке) — делаем её один раз за сессию, а не на каждый звонок.
            let node = pool.find((n) => !inUse.has(n));
            if (!node) {
                node = new AudioWorkletNode(ctx, "deepfilter-audio-processor", {
                    processorOptions: { wasmModule: assets.wasmModule, modelBytes: assets.modelBytes, suppressionLevel: level() }
                });
                pool.push(node);
            }
            node.port.postMessage({ type: "SET_SUPPRESSION_LEVEL", value: level() });
            node.port.postMessage({ type: "SET_BYPASS", value: false });
            inUse.add(node);
            emit();
            return node;
        } catch (error) {
            // Узел не создаётся — дальше браузерный шумодав (иначе микрофон остался бы вовсе без него).
            console.warn("ИИ-шумодав: не удалось подключить к звуку", error);
            broken = error;
            emit();
            return null;
        }
    }

    // Вернуть узел (вход от микрофона отключает тот, кто его подключал).
    function release(node) {
        if (!node) return;
        try { node.disconnect(); } catch { /* уже отключён */ }
        inUse.delete(node);
        emit();
    }

    // Сила подавления меняется на лету — без переоткрытия микрофона.
    function applyStrength() {
        inUse.forEach((node) => node.port.postMessage({ type: "SET_SUPPRESSION_LEVEL", value: level() }));
    }

    // ПК и Android — файлы локальные: греем заранее, чтобы первый звонок сразу шёл с ИИ.
    if (window.kabanDesktop || window.Capacitor?.isNativePlatform?.()) setTimeout(warm, 8000);

    return { prepare, warm, readyWithin, browserSuppression, useNode, acquire, release, applyStrength, status, onChange: (fn) => listeners.add(fn), SAMPLE_RATE };
})();
