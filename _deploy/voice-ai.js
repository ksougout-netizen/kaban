/* ============================================================================
   РАСШИФРОВКА ГОЛОСОВЫХ: речь → текст прямо в браузере, без отправки звука на
   сервер. Модель Whisper (Xenova/whisper-base, ≈80 МБ в сжатом виде) грузится
   один раз при первой расшифровке и кэшируется браузером; считает в отдельном
   Web Worker, поэтому интерфейс не замирает. Скорость воспроизведения
   (0.75x / 1x / 1.5x / 2x) — отдельная кнопка плеера, см. cycleVoiceMessageSpeed.
   ========================================================================= */

const ASR_LANGUAGE = "russian";
const ASR_MODEL = "Xenova/whisper-base";
const ASR_READY_KEY = "kaban-asr-ready";
const ASR_CACHE_KEY = "kaban-transcripts";
const ASR_CACHE_LIMIT = 150;

const ASR_WORKER_SOURCE = `
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";
env.allowLocalModels = false;
let recognizer = null;
self.onmessage = async (event) => {
    const { id, audio, language, model } = event.data;
    try {
        if (!recognizer) {
            recognizer = await pipeline("automatic-speech-recognition", model, {
                progress_callback: (info) => self.postMessage({ type: "progress", info })
            });
        }
        self.postMessage({ type: "progress", info: { status: "run" } });
        const output = await recognizer(audio, { chunk_length_s: 30, stride_length_s: 5, task: "transcribe", language, return_timestamps: false });
        self.postMessage({ type: "result", id, text: (output.text || "").trim() });
    } catch (error) {
        self.postMessage({ type: "error", id, message: String(error && error.message || error) });
    }
};
`;

let asrWorker = null;
let asrJobId = 0;
const asrPending = new Map();
let asrProgressListener = null;

// Модель Whisper держит в памяти сотни мегабайт — через 3 минуты без работы воркер
// останавливается и освобождает её (следующая расшифровка поднимет его заново,
// файлы модели уже в кэше браузера).
const ASR_IDLE_MS = 3 * 60 * 1000;
let asrIdleTimer = null;

function scheduleAsrIdleShutdown() {
    clearTimeout(asrIdleTimer);
    if (asrPending.size) return;
    asrIdleTimer = setTimeout(() => {
        if (asrPending.size || !asrWorker) return;
        asrWorker.terminate();
        asrWorker = null;
    }, ASR_IDLE_MS);
}

function getAsrWorker() {

    clearTimeout(asrIdleTimer);
    if (asrWorker) return asrWorker;

    const url = URL.createObjectURL(new Blob([ASR_WORKER_SOURCE], { type: "text/javascript" }));
    asrWorker = new Worker(url, { type: "module" });

    asrWorker.onmessage = (event) => {
        const data = event.data;
        if (data.type === "progress") { asrProgressListener?.(data.info); return; }
        const job = asrPending.get(data.id);
        if (!job) return;
        asrPending.delete(data.id);
        if (data.type === "result") job.resolve(data.text);
        else job.reject(new Error(data.message));
        scheduleAsrIdleShutdown();
    };

    asrWorker.onerror = (event) => {
        // Воркер упал целиком (нет сети до CDN, формат не поддержан) — все ждущие получают ошибку.
        asrPending.forEach((job) => job.reject(new Error(event.message || "Не удалось запустить распознавание")));
        asrPending.clear();
        asrWorker = null;
    };

    return asrWorker;

}

// Звук → моно Float32 на 16 кГц (формат, который ждёт Whisper).
async function decodeAudioForAsr(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Не удалось загрузить запись");
    const buffer = await response.arrayBuffer();
    const context = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    try {
        const decoded = await context.decodeAudioData(buffer);
        if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
        const length = decoded.length;
        const mono = new Float32Array(length);
        for (let c = 0; c < decoded.numberOfChannels; c++) {
            const channel = decoded.getChannelData(c);
            for (let i = 0; i < length; i++) mono[i] += channel[i] / decoded.numberOfChannels;
        }
        return mono;
    } finally {
        context.close?.();
    }
}

async function transcribeAudioUrl(url, language = ASR_LANGUAGE) {
    const audio = await decodeAudioForAsr(url);
    const worker = getAsrWorker();
    const id = ++asrJobId;
    return new Promise((resolve, reject) => {
        asrPending.set(id, { resolve, reject });
        worker.postMessage({ id, audio, language, model: ASR_MODEL }, [audio.buffer]);
    });
}

/* ---- кэш готовых расшифровок --------------------------------------------- */

function loadTranscripts() {
    try { return JSON.parse(localStorage.getItem(ASR_CACHE_KEY) || "{}"); } catch { return {}; }
}

function saveTranscript(messageId, text) {
    try {
        const all = loadTranscripts();
        all[messageId] = text;
        const keys = Object.keys(all);
        if (keys.length > ASR_CACHE_LIMIT) keys.slice(0, keys.length - ASR_CACHE_LIMIT).forEach((key) => delete all[key]);
        localStorage.setItem(ASR_CACHE_KEY, JSON.stringify(all));
    } catch { /* хранилище недоступно — расшифровка просто не запомнится */ }
}

/* ---- интерфейс -------------------------------------------------------------- */

function ensureTranscriptBox(voiceEl) {
    let box = voiceEl.parentElement.querySelector(":scope > .voice-transcript");
    if (!box) {
        box = document.createElement("div");
        box.className = "voice-transcript";
        voiceEl.insertAdjacentElement("afterend", box);
    }
    return box;
}

function describeAsrProgress(info) {
    if (!info) return "Распознаём…";
    if (info.status === "run") return "Распознаём речь…";
    if (info.status === "progress" && typeof info.progress === "number") return `Загружаем модель распознавания… ${Math.round(info.progress)}%`;
    if (info.status === "initiate" || info.status === "download") return "Загружаем модель распознавания…";
    return "Готовим распознавание…";
}

async function transcribeVoiceMessage(button) {

    const voiceEl = button.closest(".voice-message");
    const row = button.closest(".message-row");
    if (!voiceEl || !row || button.dataset.busy === "1") return;

    const messageId = row.dataset.messageId;
    const box = ensureTranscriptBox(voiceEl);

    // Повторное нажатие сворачивает/разворачивает готовый текст.
    if (box.dataset.state === "done") {
        box.hidden = !box.hidden;
        button.classList.toggle("active", !box.hidden);
        return;
    }

    const cached = loadTranscripts()[messageId];
    if (cached) {
        box.dataset.state = "done";
        box.textContent = cached;
        box.hidden = false;
        button.classList.add("active");
        return;
    }

    if (!localStorage.getItem(ASR_READY_KEY)) {
        const ok = confirm("Для расшифровки голосовых нужно один раз скачать модель распознавания речи (около 80 МБ). Она работает прямо в вашем браузере — звук никуда не отправляется. Скачать?");
        if (!ok) return;
    }

    const audio = voiceEl.querySelector("audio");
    if (!audio?.src) return;

    button.dataset.busy = "1";
    button.classList.add("loading");
    box.hidden = false;
    box.dataset.state = "loading";
    box.textContent = "Готовим распознавание…";

    asrProgressListener = (info) => { box.textContent = describeAsrProgress(info); };

    try {
        const text = await transcribeAudioUrl(audio.src);
        try { localStorage.setItem(ASR_READY_KEY, "1"); } catch { /* ок */ }
        if (!text) {
            box.dataset.state = "";
            box.textContent = "Речь не распознана";
        } else {
            box.dataset.state = "done";
            box.textContent = text;
            saveTranscript(messageId, text);
            button.classList.add("active");
        }
    } catch (error) {
        box.dataset.state = "";
        box.textContent = "Не удалось расшифровать: " + (error?.message || error);
    } finally {
        asrProgressListener = null;
        button.dataset.busy = "";
        button.classList.remove("loading");
    }

}
