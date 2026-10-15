/* ============================================================================
   KABAN — сквозное шифрование (E2E) для секретных чатов
   ============================================================================
   Подключать ПОСЛЕ supabaseClient.js — использует его getSupabaseClient()
   и KabanAuth напрямую (обычный классический <script>, без модулей, как и
   весь остальной проект):

     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
     <script src="supabaseClient.js"></script>
     <script src="crypto.js"></script>
     <script src="script.js"></script>

   Схема ровно как в "Секретных чатах" Телеграма:
     1. Оба устройства один раз генерируют себе пару ключей ECDH (P-256).
        Приватный ключ НИКОГДА никуда не отправляется — живёт только в
        IndexedDB этого браузера. Публичный ключ публикуется в device_keys.
     2. При старте секретного чата инициатор кладёт свой публичный ключ в
        secret_chat_handshake, получатель — отвечает своим.
     3. Каждая сторона считает общий секрет локально через ECDH
        (deriveKey) — сам секрет по сети не передаётся, это и есть математика
        Диффи-Хеллмана: из "моего приватного + твоего публичного" и
        "твоего приватного + моего публичного" получается ОДИН и тот же ключ.
     4. Текст шифруется AES-GCM этим общим ключом прямо в браузере перед
        отправкой. В базе лежит только шифротекст — Supabase физически не
        может его прочитать.

   Forward secrecy (симметричный ratchet):
     Ключ НЕ статический на весь чат — на каждое сообщение выводится СВОЙ
     одноразовый AES-ключ через цепочку HMAC-шагов (chain key → message key +
     next chain key, как "sending chain"/"receiving chain" в Signal), а
     использованное звено цепочки сразу отбрасывается. HMAC необратим, поэтому
     из ключа сообщения №10 нельзя вычислить ключ сообщения №9 — компрометация
     текущего состояния НЕ раскрывает прошлую переписку этого чата.

   Честно про ограничения этой версии (чтобы не создавать ложных ожиданий):
     - Это НЕ полный Double Ratchet: здесь только симметричная (KDF-цепочка)
       половина протокола, без DH-ratchet — то есть нет post-compromise
       security ("самоисцеления"). Если состояние цепочки утечёт один раз,
       под угрозой ВСЕ последующие сообщения этого направления вплоть до
       начала нового секретного чата, а не только следующее одно сообщение,
       как было бы с полным Double Ratchet. Прошлые сообщения при этом
       по-прежнему в безопасности (см. forward secrecy выше) — это разные
       свойства, и второе (самоисцеление) в этой версии не реализовано.
     - Ключ живёт на ОДНОМ устройстве (как и должно быть для секретного
       чата в Телеграме) — на другом устройстве этот же секретный чат
       просто не откроется, это ожидаемое поведение, а не баг.
     - Обмен публичными ключами (handshake) идёт ЧЕРЕЗ сервер — а значит,
       скомпрометированный сервер теоретически может подменить чужой
       публичный ключ на свой и читать переписку как посредник (MITM).
       Единственная защита от этого — ручная сверка кода безопасности
       (см. KabanCrypto.computeSafetyNumber ниже): она проверяет ключ по
       каналу, который атакующий-сервер не контролирует. Без неё "секретность"
       чата держится на честности сервера в момент рукопожатия.
   ========================================================================= */


const CRYPTO_DB_NAME = "kaban-crypto";
const CRYPTO_DB_VERSION = 3;
const DEVICE_ID_STORAGE_KEY = "kaban-device-id";


/* ----------------------------------------------------------------------
   IndexedDB: приватный ключ устройства ("keys"), состояние цепочки ключей
   секретных чатов ("ratchet-state") и кэш уже расшифрованного текста
   ("decrypted-cache") — всё это никогда не покидает браузер.

   Кэш расшифровки обязателен, а не просто оптимизация: ratchet forward
   secrecy устроен так, что ключ каждого сообщения ОДНОРАЗОВЫЙ и удаляется
   сразу после использования (см. decryptMessage ниже) — при повторном
   открытии чата (например, после перезагрузки страницы) попытка заново
   расшифровать уже прочитанные сообщения провалится с "ключ уже продвинут
   и удалён", это ожидаемая часть forward secrecy, а не баг. Поэтому текст
   расшифровывается ИЗ ШИФРОТЕКСТА только один раз, а дальше при каждом
   открытии чата отдаётся уже готовый расшифрованный текст из этого кэша.
   ------------------------------------------------------------------- */

// Одно открытое соединение на всё приложение. Раньше каждый idbGet/idbSet
// открывал НОВОЕ соединение (indexedDB.open + проверка версии): открытие
// секретного чата с историей давало по несколько таких открытий на каждое
// сообщение (кэш расшифровки, состояние ratchet — чтение и запись) подряд.
let cryptoDbPromise = null;

function openCryptoDB() {
    if (cryptoDbPromise) return cryptoDbPromise;
    cryptoDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(CRYPTO_DB_NAME, CRYPTO_DB_VERSION);

        // contains()-проверки нужны, чтобы апгрейд с версии 1 (где уже есть
        // "keys" у тех, кто открывал приложение раньше) не пытался создать
        // существующий стор повторно — createObjectStore на уже существующем
        // имени кидает исключение и ломает всю миграцию.
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("keys")) {
                db.createObjectStore("keys");
            }
            if (!db.objectStoreNames.contains("ratchet-state")) {
                db.createObjectStore("ratchet-state");
            }
            if (!db.objectStoreNames.contains("decrypted-cache")) {
                db.createObjectStore("decrypted-cache");
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            // Соединение могли закрыть снаружи (апгрейд версии из другой
            // вкладки, очистка данных сайта) — следующий вызов откроет новое.
            db.onclose = () => { cryptoDbPromise = null; };
            db.onversionchange = () => { db.close(); cryptoDbPromise = null; };
            resolve(db);
        };
        request.onerror = () => {
            cryptoDbPromise = null; // не кешируем неудачу — следующий вызов попробует заново
            reject(request.error);
        };
    });
    return cryptoDbPromise;
}

// Очередь задач по chatId: каждая следующая стартует только после того, как
// предыдущая для ТОГО ЖЕ чата завершилась (успешно или с ошибкой — упавшая
// задача не должна навсегда заблокировать чат). Разные чаты друг друга не
// ждут. Возвращает результат/ошибку самой задачи.
const ratchetLockTails = new Map();

function withRatchetLock(chatId, task) {
    const previous = ratchetLockTails.get(chatId) || Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    ratchetLockTails.set(chatId, tail);
    tail.then(() => {
        if (ratchetLockTails.get(chatId) === tail) ratchetLockTails.delete(chatId);
    });
    return run;
}

async function idbGet(storeName, key) {
    const db = await openCryptoDB();
    return new Promise((resolve, reject) => {
        const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function idbSet(storeName, key, value) {
    const db = await openCryptoDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}


/* ----------------------------------------------------------------------
   Идентификатор устройства и base64-хелперы
   ------------------------------------------------------------------- */

function getDeviceId() {
    let id = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(DEVICE_ID_STORAGE_KEY, id);
    }
    return id;
}

function bufferToBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(base64) {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
}

function bytesToHex(bytes) {
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}


/* ----------------------------------------------------------------------
   Отпечаток общего ключа (safety number) — см. KabanCrypto.computeSafetyNumber
   ------------------------------------------------------------------- */

// 40 визуально несхожих эмодзи — важно, чтобы соседние варианты не путались
// друг с другом при сравнении на глаз.
const SAFETY_NUMBER_EMOJI = [
    "🐘", "🐳", "🦊", "🐝", "🦉", "🐢", "🐙", "🦋", "🐺", "🦁",
    "🐧", "🦄", "🐸", "🦖", "🐬", "🦅", "🦦", "🐞", "🦀", "🐿️",
    "🌵", "🌻", "🍄", "🌴", "🍀", "🌊", "🔥", "❄️", "⭐", "🌙",
    "🔑", "⚙️", "🧭", "🎯", "🎲", "🧩", "⚡", "🔮", "🎈", "🪁"
];

const VERIFIED_CHATS_STORAGE_KEY = "kaban-verified-chats";

function getVerifiedChatsMap() {
    try {
        return JSON.parse(localStorage.getItem(VERIFIED_CHATS_STORAGE_KEY) || "{}");
    } catch {
        return {};
    }
}

// Считает отпечаток пары публичных ключей — одинаковый результат у обеих
// сторон рукопожатия независимо от того, кто инициатор, а кто получатель
// (ключи сортируются перед хешированием), и разный результат, если хотя бы
// один байт хотя бы одного ключа отличается — то есть если сервер подменил
// ключ при рукопожатии, отпечаток у сторон разойдётся, и это будет видно.
async function computeSafetyNumber(publicKeyBase64A, publicKeyBase64B) {
    const [first, second] = [publicKeyBase64A, publicKeyBase64B].sort();

    const combined = new Uint8Array([
        ...new Uint8Array(base64ToBuffer(first)),
        ...new Uint8Array(base64ToBuffer(second))
    ]);

    const digest = new Uint8Array(await window.crypto.subtle.digest("SHA-256", combined));

    const emoji = Array.from(digest.slice(0, 5))
        .map((byte) => SAFETY_NUMBER_EMOJI[byte % SAFETY_NUMBER_EMOJI.length]);

    // Цифровой вариант того же отпечатка — на случай, если удобнее прочитать
    // код вслух по телефону, а не сравнивать картинки на экране.
    const digits = Array.from(digest.slice(5, 15))
        .map((byte) => byte % 10)
        .join("")
        .match(/.{1,5}/g)
        .join("  ");

    return { emoji, digits, fingerprint: bytesToHex(digest) };
}


/* ----------------------------------------------------------------------
   СИММЕТРИЧНЫЙ RATCHET (forward secrecy): цепочка ключей на каждое
   направление секретного чата — см. честное объяснение в шапке файла.
   ------------------------------------------------------------------- */

const ratchetStateCache = new Map(); // chatId -> {sendChainKey, sendIndex, recvChainKey, recvIndex, skipped}
const MAX_SKIPPED_KEYS = 50; // на чат: ограничивает рост кэша "ключей для сообщений не по порядку"

async function hmacSha256(keyBytes, label) {
    const key = await window.crypto.subtle.importKey(
        "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const signature = await window.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(label));
    return new Uint8Array(signature);
}

// Один шаг цепочки: из chainKey получаем messageKey (шифрует ОДНО сообщение)
// и nextChainKey (заменяет chainKey). HMAC необратим — значит, имея
// messageKey/nextChainKey, прошлые звенья цепочки восстановить нельзя.
async function advanceChain(chainKeyBytes) {
    const [messageKeyBytes, nextChainKeyBytes] = await Promise.all([
        hmacSha256(chainKeyBytes, "message"),
        hmacSha256(chainKeyBytes, "chain")
    ]);
    return { messageKeyBytes, nextChainKeyBytes };
}

async function importAesKey(rawBytes) {
    return window.crypto.subtle.importKey(
        "raw", rawBytes, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}

// ECDH-секрет в виде сырых байт (не CryptoKey) — он не шифрует ничего сам
// по себе, а служит только сырьём для HMAC-цепочек ниже, поэтому здесь
// нужны именно биты, а не готовый AES-ключ (в отличие от safety number,
// которому сырые биты не нужны — тот работает с публичными ключами напрямую).
async function deriveRootSecretBits(theirPublicKeyBase64) {
    const { privateKey } = await KabanCrypto.ensureDeviceKeyPair();

    const theirPublicKey = await window.crypto.subtle.importKey(
        "raw",
        base64ToBuffer(theirPublicKeyBase64),
        { name: "ECDH", namedCurve: "P-256" },
        false,
        []
    );

    const bits = await window.crypto.subtle.deriveBits(
        { name: "ECDH", public: theirPublicKey },
        privateKey,
        256
    );

    return new Uint8Array(bits);
}

function serializeRatchetState(state) {
    return {
        sendChainKey: bufferToBase64(state.sendChainKey),
        sendIndex: state.sendIndex,
        recvChainKey: bufferToBase64(state.recvChainKey),
        recvIndex: state.recvIndex,
        skipped: Object.fromEntries(
            Object.entries(state.skipped).map(([index, bytes]) => [index, bufferToBase64(bytes)])
        )
    };
}

function deserializeRatchetState(raw) {
    return {
        sendChainKey: new Uint8Array(base64ToBuffer(raw.sendChainKey)),
        sendIndex: raw.sendIndex,
        recvChainKey: new Uint8Array(base64ToBuffer(raw.recvChainKey)),
        recvIndex: raw.recvIndex,
        skipped: Object.fromEntries(
            Object.entries(raw.skipped || {}).map(([index, base64]) => [index, new Uint8Array(base64ToBuffer(base64))])
        )
    };
}

async function saveRatchetState(chatId, state) {
    ratchetStateCache.set(chatId, state);
    await idbSet("ratchet-state", chatId, serializeRatchetState(state));
}

async function loadRatchetState(chatId) {
    if (ratchetStateCache.has(chatId)) return ratchetStateCache.get(chatId);

    const raw = await idbGet("ratchet-state", chatId);
    if (!raw) return null;

    const state = deserializeRatchetState(raw);
    ratchetStateCache.set(chatId, state);
    return state;
}

function trimSkippedKeys(state) {
    const indexes = Object.keys(state.skipped).map(Number).sort((a, b) => a - b);
    while (indexes.length > MAX_SKIPPED_KEYS) {
        delete state.skipped[indexes.shift()];
    }
}

// Первичный вывод обеих цепочек из общего ECDH-секрета: фиксированные метки
// "initiator->responder" / "responder->initiator" гарантируют, что цепочка
// ОТПРАВКИ инициатора совпадает с цепочкой ПРИЁМА получателя (и наоборот) —
// независимо от того, кто есть "я", а кто "собеседник" локально.
async function initRatchetState(chatId, handshake, meIsInitiator) {
    const theirPublicKey = meIsInitiator ? handshake.responder_public_key : handshake.initiator_public_key;
    const rootSecret = await deriveRootSecretBits(theirPublicKey);

    const initiatorToResponder = await hmacSha256(rootSecret, `${chatId}:initiator->responder`);
    const responderToInitiator = await hmacSha256(rootSecret, `${chatId}:responder->initiator`);

    const state = meIsInitiator
        ? { sendChainKey: initiatorToResponder, sendIndex: 0, recvChainKey: responderToInitiator, recvIndex: 0, skipped: {} }
        : { sendChainKey: responderToInitiator, sendIndex: 0, recvChainKey: initiatorToResponder, recvIndex: 0, skipped: {} };

    await saveRatchetState(chatId, state);
    return state;
}

// Достаёт состояние цепочки секретного чата, при первом обращении выводя
// его из рукопожатия — вызывать перед отправкой/расшифровкой сообщений.
async function getOrInitRatchetState(chatId) {
    const existing = await loadRatchetState(chatId);
    if (existing) return existing;

    const db = getSupabaseClient();
    const me = await KabanAuth.getCurrentUser();
    if (!me) throw new Error("Нужно войти в аккаунт");

    const { data: handshake, error } = await db
        .from("secret_chat_handshake")
        .select("*")
        .eq("chat_id", chatId)
        .single();
    if (error) throw error;

    if (!handshake.responder_public_key) {
        throw new Error("Собеседник ещё не принял секретный чат — ключ пока не готов");
    }

    return initRatchetState(chatId, handshake, handshake.initiator_id === me.id);
}


/* ----------------------------------------------------------------------
   KabanCrypto — публичный API модуля
   ------------------------------------------------------------------- */

const KabanCrypto = {

    getDeviceId,

    // Один раз при первом обращении создаёт пару ключей ECDH и сохраняет её
    // в IndexedDB; при повторных вызовах отдаёт уже сохранённую.
    async ensureDeviceKeyPair() {
        const existing = await idbGet("keys", "device-key-pair");
        if (existing) return existing;

        const keyPair = await window.crypto.subtle.generateKey(
            { name: "ECDH", namedCurve: "P-256" },
            // false: по спецификации WebCrypto флаг extractable управляет
            // только ПРИВАТНЫМ ключом пары — публичный ключ при генерации
            // ВСЕГДА экспортируем, независимо от этого флага (а экспортируем
            // мы только его, см. getPublicKeyBase64). Прежнее true делало
            // экспортируемым и приватный ключ: любой код, выполнившийся на
            // странице (например, через XSS), мог бы вызвать exportKey на
            // нём и украсть его — вопреки заявленной гарантии "приватный
            // ключ никогда не покидает устройство".
            false,
            ["deriveKey", "deriveBits"] // deriveBits нужен для ratchet — см. deriveRootSecretBits
        );

        await idbSet("keys", "device-key-pair", keyPair);
        return keyPair;
    },

    async getPublicKeyBase64() {
        const { publicKey } = await this.ensureDeviceKeyPair();
        const raw = await window.crypto.subtle.exportKey("raw", publicKey);
        return bufferToBase64(raw);
    },

    // Вызвать один раз сразу после входа в аккаунт — публикует публичный
    // ключ этого устройства, чтобы с ним могли начать секретный чат.
    async publishDeviceKey() {
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const db = getSupabaseClient();
        const { error } = await db
            .from("device_keys")
            .upsert({
                user_id: me.id,
                device_id: getDeviceId(),
                public_key: await this.getPublicKeyBase64()
            });

        if (error) throw error;
    },

    // IV одноразовый на КАЖДОЕ сообщение: повторное использование одного IV
    // с одним AES-GCM-ключом ломает всю защиту шифра, поэтому генерируем
    // заново при каждом вызове.
    async encryptText(aesKey, plaintext) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(plaintext);
        const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encoded);

        return {
            ciphertext: bufferToBase64(ciphertext),
            iv: bufferToBase64(iv)
        };
    },

    async decryptText(aesKey, ciphertextBase64, ivBase64) {
        const plaintextBuffer = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64ToBuffer(ivBase64) },
            aesKey,
            base64ToBuffer(ciphertextBase64)
        );

        return new TextDecoder().decode(plaintextBuffer);
    },


    /* --------------------------------------------------------------
       Оркестрация: создание секретного чата, обмен ключами, отправка
       и получение зашифрованных сообщений — то, что реально вызывает
       интерфейс (кнопка "Секретный чат" уже есть, сейчас это toast-заглушка).
       -------------------------------------------------------------- */

    // Найти уже существующий секретный чат с этим человеком (чтобы кнопка
    // "Секретный чат" не плодила дубликаты при повторном нажатии) или
    // начать новый через startSecretChat ниже. RLS chat_participants_select_member
    // отдаёт только строки чатов, где Я САМ тоже состою — поэтому фильтр
    // "участник = otherUserId" по факту уже означает "и я тоже там есть".
    async getOrStartSecretChat(otherUserId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        // Атомарный путь (get_or_create_secret_chat в schema.sql): два
        // одновременных нажатия "Секретный чат" не создадут два чата с разными
        // ключами. created=true — только у вызова, который реально создал чат:
        // именно он выкладывает свой публичный ключ рукопожатия.
        const { data: rpcRows, error: rpcError } = await db.rpc("get_or_create_secret_chat", { p_other: otherUserId });
        if (!rpcError && rpcRows?.length) {
            const { secret_chat_id: chatId, was_created: created } = rpcRows[0];
            if (created) {
                await this.publishHandshake(chatId, me.id);
            } else {
                // Чат уже был, но если прошлая попытка создания оборвалась между
                // созданием чата и выкладкой ключа — рукопожатия нет и секретный
                // чат навсегда остался бы неработающим. Дописываем его сами
                // (если параллельно успел собеседник — конфликт ключа игнорируем).
                const { data: handshakeRow } = await db
                    .from("secret_chat_handshake").select("chat_id").eq("chat_id", chatId).maybeSingle();
                if (!handshakeRow) {
                    try { await this.publishHandshake(chatId, me.id); } catch (error) {
                        console.warn("Не удалось дописать рукопожатие секретного чата", error);
                    }
                }
            }
            return chatId;
        }
        if (rpcError && !isMissingRpcError(rpcError)) throw rpcError;

        const { data: existing, error } = await db
            .from("chat_participants")
            .select("chat_id, chats!inner(is_secret, type)")
            .eq("user_id", otherUserId)
            .eq("chats.is_secret", true)
            .eq("chats.type", "direct")
            .limit(1);
        if (error) throw error;
        if (existing?.length) return existing[0].chat_id;

        return this.startSecretChat(otherUserId);
    },

    // Шаг 1 (у инициатора): создать секретный чат и выложить свой публичный
    // ключ, ждём, пока вторая сторона ответит своим.
    async startSecretChat(otherUserId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { data: chat, error: chatError } = await db
            .from("chats")
            .insert({ type: "direct", is_secret: true, created_by: me.id })
            .select()
            .single();
        if (chatError) throw chatError;

        // Ошибку нужно проверять: раньше она терялась (результат insert даже не
        // читался), и функция возвращала id чата с неполным списком участников
        // как будто всё создалось успешно — вторая сторона просто никогда бы
        // не увидела этот секретный чат.
        const { error: participantsError } = await db.from("chat_participants").insert([
            { chat_id: chat.id, user_id: me.id },
            { chat_id: chat.id, user_id: otherUserId }
        ]);
        if (participantsError) throw participantsError;

        await this.publishHandshake(chat.id, me.id);

        return chat.id;
    },

    // Публикация публичного ключа инициатора — отдельным шагом, потому что
    // серверный get_or_create_secret_chat создаёт чат и участников атомарно,
    // а рукопожатие выкладывает уже клиент (приватный ключ с устройства не
    // выходит, публичный берётся из ensureDeviceKeyPair).
    async publishHandshake(chatId, initiatorId) {
        const db = getSupabaseClient();
        const { error: handshakeError } = await db
            .from("secret_chat_handshake")
            .insert({
                chat_id: chatId,
                initiator_id: initiatorId,
                initiator_public_key: await this.getPublicKeyBase64()
            });
        if (handshakeError) throw handshakeError;
    },

    // Шаг 2 (у получателя): увидев новый secret_chat_handshake без своего
    // ответа, публикуем свой публичный ключ — после этого у обеих сторон
    // можно вывести общий ключ и писать.
    async acceptSecretChat(chatId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { error } = await db
            .from("secret_chat_handshake")
            .update({
                responder_id: me.id,
                responder_public_key: await this.getPublicKeyBase64(),
                confirmed_at: new Date().toISOString()
            })
            .eq("chat_id", chatId);

        if (error) throw error;
    },

    // Зашифровать и отправить текстовое сообщение в секретный чат — на КАЖДОЕ
    // сообщение выводится свой одноразовый ключ (см. секцию ratchet выше).
    async sendSecretMessage(chatId, plaintext, extra = {}) {

        // Чтение состояния → продвижение цепочки → сохранение — критическая
        // секция: у двух сообщений, отправленных почти одновременно, оба
        // прочитали бы ОДНО И ТО ЖЕ sendChainKey ещё до того, как первое
        // успело его продвинуть (мутация идёт только после await), то есть
        // получили бы одинаковый ключ шифрования и при этом разные
        // key_index — получатель вывел бы для одного из них неверный ключ,
        // и сообщение стало бы НАВСЕГДА нечитаемым (GCM tag mismatch).
        // withRatchetLock выстраивает такие операции по одной на чат.
        const { messageKeyBytes, usedIndex } = await withRatchetLock(chatId, async () => {
            const state = await getOrInitRatchetState(chatId);

            const { messageKeyBytes, nextChainKeyBytes } = await advanceChain(state.sendChainKey);
            const usedIndex = state.sendIndex;

            // Продвигаем и СОХРАНЯЕМ цепочку ДО отправки: лучше потерять
            // недоставленное (например, из-за обрыва сети) сообщение, чем
            // случайно переиспользовать тот же ключ отправки при повторной
            // попытке — повторное использование ключа сообщения в AES-GCM
            // ломает защиту шифра, а не просто "менее безопасно".
            state.sendChainKey = nextChainKeyBytes;
            state.sendIndex += 1;
            await saveRatchetState(chatId, state);

            return { messageKeyBytes, usedIndex };
        });

        const aesKey = await importAesKey(messageKeyBytes);
        const { ciphertext, iv } = await this.encryptText(aesKey, plaintext);

        const saved = await KabanAPI.sendMessage(chatId, {
            ...extra,
            text: ciphertext,
            encryptionIv: iv,
            keyIndex: usedIndex
        });

        // Своё же СОБСТВЕННОЕ отправленное сообщение расшифровать через
        // decryptMessage ниже потом будет НЕЛЬЗЯ — у него индекс из цепочки
        // ОТПРАВКИ, а decryptMessage всегда идёт по цепочке ПРИЁМА (это разные,
        // независимо считающие индексы). Поэтому кэшируем открытый текст сразу
        // здесь, пока он и так уже есть в руках, а не пытаемся его потом
        // "восстановить" неподходящей цепочкой.
        await idbSet("decrypted-cache", saved.id, plaintext);

        return saved;
    },

    // Расшифровать входящее/своё сообщение для отображения в интерфейсе.
    // message.key_index указывает, какое звено цепочки ПРИЁМА его шифровало.
    //
    // Кэш обязателен (см. комментарий у "decrypted-cache" выше про forward
    // secrecy) — без него верно расшифровать сообщение можно только один
    // раз за всё время жизни чата, а не при каждом открытии.
    async decryptMessage(chatId, message) {
        if (!message.encryption_iv) return message.text; // не зашифровано

        const cached = await idbGet("decrypted-cache", message.id);
        if (cached !== undefined) return cached;

        if (message.key_index === null || message.key_index === undefined) {
            throw new Error("У сообщения нет key_index — расшифровка невозможна");
        }

        // Пачка realtime-сообщений (собеседник "догнал" накопившийся список)
        // запускает несколько decryptMessage параллельно — без замка они
        // перемешивали чтение/запись recvChainKey/recvIndex/skipped до
        // saveRatchetState и давали ложное "ключ уже продвинут и удалён" на
        // сообщениях, которые на самом деле можно было расшифровать. Вся
        // работа с цепочкой приёма — по одному на чат.
        return withRatchetLock(chatId, async () => {

            // Пока ждали своей очереди, это же сообщение мог уже расшифровать
            // предыдущий вызов (и положить результат в кэш) — повторно идти по
            // цепочке нельзя: её ключ для него уже продвинут и удалён.
            const cachedInLock = await idbGet("decrypted-cache", message.id);
            if (cachedInLock !== undefined) return cachedInLock;

            const state = await getOrInitRatchetState(chatId);
            const targetIndex = message.key_index;
            let messageKeyBytes;

            if (targetIndex < state.recvIndex) {

                // Сообщение пришло не по порядку (позже своих соседей) — ключ
                // мог остаться в кэше "пропущенных" на такой случай, либо уже
                // был использован и удалён: тогда расшифровать НЕЛЬЗЯ, и это
                // ожидаемое поведение forward secrecy, а не баг.
                const skippedKey = state.skipped[targetIndex];
                if (!skippedKey) {
                    throw new Error("Ключ этого сообщения уже продвинут дальше и удалён — расшифровать больше нельзя");
                }
                messageKeyBytes = skippedKey;
                delete state.skipped[targetIndex];
                await saveRatchetState(chatId, state);

            } else {

                // Догоняем цепочку до нужного индекса, откладывая по пути ключи
                // сообщений, которые ещё не пришли (см. кэш skipped выше).
                let chainKey = state.recvChainKey;
                for (let i = state.recvIndex; i < targetIndex; i++) {
                    const step = await advanceChain(chainKey);
                    state.skipped[i] = step.messageKeyBytes;
                    chainKey = step.nextChainKeyBytes;
                }
                const finalStep = await advanceChain(chainKey);
                messageKeyBytes = finalStep.messageKeyBytes;

                state.recvChainKey = finalStep.nextChainKeyBytes;
                state.recvIndex = targetIndex + 1;
                trimSkippedKeys(state);
                await saveRatchetState(chatId, state);

            }

            const aesKey = await importAesKey(messageKeyBytes);
            const plaintext = await this.decryptText(aesKey, message.text, message.encryption_iv);
            await idbSet("decrypted-cache", message.id, plaintext);
            return plaintext;

        });
    },


    /* --------------------------------------------------------------
       СВЕРКА КЛЮЧА (safety number) — единственная защита от подмены
       публичного ключа сервером в момент рукопожатия (см. секцию
       "handshake" выше). Раз обмен ключами идёт через сервер, ему
       технически ничего не мешает подсунуть СВОЙ ключ вместо ключа
       собеседника — а дальше тихо читать "секретную" переписку как
       посредник. Единственный способ это исключить — сверить у обоих
       участников ОДИНАКОВЫЙ отпечаток общего ключа по каналу, который
       атакующий не контролирует (лично или голосом), — ровно как
       "проверка кода безопасности" в Telegram/Signal/WhatsApp.
       -------------------------------------------------------------- */

    computeSafetyNumber,

    // Достаёт оба публичных ключа рукопожатия секретного чата и считает
    // их общий отпечаток — вызывать перед показом экрана сверки.
    async getSafetyNumberForChat(chatId) {
        const db = getSupabaseClient();

        const { data: handshake, error } = await db
            .from("secret_chat_handshake")
            .select("initiator_public_key, responder_public_key")
            .eq("chat_id", chatId)
            .single();
        if (error) throw error;

        if (!handshake.responder_public_key) {
            throw new Error("Собеседник ещё не принял секретный чат — сверка появится после этого");
        }

        return computeSafetyNumber(handshake.initiator_public_key, handshake.responder_public_key);
    },

    // Отметить, что человек сверил код лично/голосом и подтвердил совпадение.
    // Храним не просто "true", а сам отпечаток: если ключи чата когда-нибудь
    // пересчитаются (например, пересоздали рукопожатие), сохранённый
    // отпечаток перестанет совпадать с новым — и подтверждение автоматически
    // "слетит", ровно как предупреждение "код безопасности изменился" у
    // Signal, а не тихо продолжит показывать чат как проверенный.
    confirmSafetyNumber(chatId, fingerprint) {
        const map = getVerifiedChatsMap();
        map[chatId] = fingerprint;
        localStorage.setItem(VERIFIED_CHATS_STORAGE_KEY, JSON.stringify(map));
    },

    isSafetyNumberVerified(chatId, fingerprint) {
        return getVerifiedChatsMap()[chatId] === fingerprint;
    },

    forgetSafetyNumberVerification(chatId) {
        const map = getVerifiedChatsMap();
        delete map[chatId];
        localStorage.setItem(VERIFIED_CHATS_STORAGE_KEY, JSON.stringify(map));
    }

};
