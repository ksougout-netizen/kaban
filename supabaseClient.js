/* ============================================================================
   KABAN — слой доступа к данным (Supabase)
   ============================================================================
   Этот файл ещё НИКАК не подключён к index.html и ничего не меняет в текущей
   работе приложения — можно спокойно добавлять его в проект, ничего не
   сломается, пока сами не подключите <script> и не пропишете ключи ниже.

   Что нужно сделать, чтобы этот файл заработал:
     1. Накатить schema.sql в SQL Editor вашего проекта на supabase.com.
     2. В Project Settings → API скопировать "Project URL" и "anon public" key,
        вставить их в SUPABASE_URL / SUPABASE_ANON_KEY ниже.
     3. Добавить в <head> index.html ПЕРЕД этим файлом:
          <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
          <script src="supabaseClient.js"></script>
     4. Дальше script.js сможет вызывать методы из глобального объекта KabanAPI
        (см. примеры использования в комментариях к каждому методу).

   Пока ключи не вписаны — любой вызов методов KabanAPI кинет понятную ошибку
   в консоль вместо непонятного "fetch failed", чтобы не тратить время на
   отладку "почему тихо ничего не происходит".
   ========================================================================= */

const SUPABASE_URL = "https://ketvgmietommjqutejuj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHZnbWlldG9tbWpxdXRlanVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2NDk5NjAsImV4cCI6MjEwNjIyNTk2MH0.zDqx6D4JTGp7CE53viuNnjppQTBK5OECvJVa23mtZmk";

// Токен и id для запроса «ухожу» при закрытии страницы (см. updateMyPresenceOnExit).
let presenceExitAuth = null;

// null — ещё не пробовали; true/false — есть ли в базе get_chat_list (performance.sql).
let getChatsViaRpc = null;

const IS_SUPABASE_CONFIGURED =
    SUPABASE_URL.startsWith("http") && SUPABASE_ANON_KEY.length > 20;

let supabaseClient = null;

function getSupabaseClient() {

    if (!IS_SUPABASE_CONFIGURED) {
        throw new Error(
            "Supabase не настроен: впишите SUPABASE_URL и SUPABASE_ANON_KEY " +
            "в supabaseClient.js (см. инструкцию в начале файла)."
        );
    }

    if (!supabaseClient) {
        if (typeof supabase === "undefined") {
            throw new Error(
                "Не найдена библиотека @supabase/supabase-js. " +
                "Добавьте её <script> ПЕРЕД supabaseClient.js в index.html " +
                "(ссылка есть в комментарии в начале этого файла)."
            );
        }
        supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }

    return supabaseClient;

}

// Имя файла идёт прямо в путь объекта Storage — без очистки "/" в имени
// позволяет создавать произвольные вложенные "папки" (или целиться в чужой
// путь), а не класть файл туда, где ожидается плоский список. Оставляем
// только безопасные символы, остальное схлопываем в "_".
function sanitizeStorageFileName(name) {
    return String(name || "file").replace(/[/\\]/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180) || "file";
}

// Промис "канал подписан": раньше везде стояло
//   new Promise((resolve) => channel.subscribe((s) => { if (s === "SUBSCRIBED") resolve(); }))
// — он никогда не завершался, если вместо SUBSCRIBED приходил CHANNEL_ERROR /
// TIMED_OUT / CLOSED (нестабильная сеть, сервер Realtime моргнул): любой
// await на нём (исходящий звонок, ответ на звонок, P2P-передача) зависал
// навсегда без ошибки и без возможности отката. Теперь — reject по ошибке
// статуса или по общему таймауту.
function waitForChannelSubscribed(channel, timeoutMs = 12000) {
    const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Не удалось подключиться к каналу связи (таймаут)")), timeoutMs);
        channel.subscribe((status) => {
            if (status === "SUBSCRIBED") {
                clearTimeout(timer);
                resolve();
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                clearTimeout(timer);
                reject(new Error("Не удалось подключиться к каналу связи (" + status + ")"));
            }
        });
    });
    // Помечаем отклонение как обработанное, чтобы вызовы, которые "ready"
    // вообще не дожидаются, не сыпали Uncaught (in promise) в консоль; тем,
    // кто await-ит promise, отказ по-прежнему приходит как обычно.
    promise.catch(() => {});
    return promise;
}

// RPC ещё не создан в базе (миграция из schema.sql не накатана) — PostgREST
// отвечает PGRST202 / Postgres 42883 "function does not exist". В этом случае
// вызывающий код откатывается на прежний (неатомарный) путь, а не ломается.
// Таблица ещё не создана (SQL-блок не выполнен): PostgREST отвечает PGRST205 / 42P01.
function isMissingRelationError(error) {
    const code = error?.code || "";
    return code === "PGRST205" || code === "42P01" || /could not find the table|does not exist/i.test(error?.message || "");
}
function isMissingRpcError(error) {
    return error?.code === "PGRST202" || error?.code === "42883"
        || /could not find the function|does not exist/i.test(error?.message || "");
}

// Best-effort удаление файла из Storage по его публичной ссылке (вместо
// того, чтобы отдельно хранить путь) — используется везде, где старый файл
// заменяется новым (аватар, вложение удалённого сообщения) и его больше
// незачем хранить. Никогда не бросает исключение: неудачная уборка не
// должна ломать основное действие пользователя (профиль/сообщение уже
// сохранены к моменту вызова).
async function deleteStorageObjectByUrl(bucket, url) {
    if (!url) return;
    const db = getSupabaseClient();
    const marker = `/storage/v1/object/public/${bucket}/`;
    const markerIndex = url.indexOf(marker);
    if (markerIndex === -1) return;
    const path = decodeURIComponent(url.slice(markerIndex + marker.length));
    try {
        await db.storage.from(bucket).remove([path]);
    } catch {
        // см. комментарий выше — молча игнорируем
    }
}


/* ============================================================================
   АВТОРИЗАЦИЯ
   ========================================================================= */

const KabanAuth = {

    // KabanAuth.signUp("user@mail.com", "пароль", "demo_user", "Собеседник")
    async signUp(email, password, username, displayName) {
        const db = getSupabaseClient();
        const { data, error } = await db.auth.signUp({
            email,
            password,
            options: { data: { username, display_name: displayName } }
        });
        if (error) throw error;
        return data.user;
    },

    async signIn(email, password) {
        const db = getSupabaseClient();
        const { data, error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return data.user;
    },

    async signOut() {
        const db = getSupabaseClient();
        const { error } = await db.auth.signOut();
        if (!error) return;
        // Без сети глобальный выход падал, и выйти с устройства было невозможно —
        // в таком случае завершаем хотя бы локальную сессию.
        const { error: localError } = await db.auth.signOut({ scope: "local" });
        if (localError) throw error;
    },

    // getSession() читает сессию из локального хранилища (и сама обновляет
    // токен, если он истёк) — БЕЗ запроса к серверу. Раньше здесь стоял
    // auth.getUser(), который при КАЖДОМ вызове ходит на /auth/v1/user за
    // валидацией токена, а getCurrentUser() вызывается почти первым делом в
    // каждом методе KabanAPI (отправка сообщения, загрузка истории, реакции,
    // presence-пинг раз в 45 сек, markAsRead…): каждое действие приложения
    // получало лишний сетевой round-trip, это и был главный источник общих
    // "лагов". Для клиента нужен только id пользователя; реальную проверку
    // прав всё равно делает сервер (RLS по JWT) на каждом запросе.
    async getCurrentUser() {
        const db = getSupabaseClient();
        const { data, error } = await db.auth.getSession();
        if (error) console.warn("Не удалось прочитать сессию", error);
        return data?.session?.user || null;
    },

    // Письмо со ссылкой "сбросить пароль" — Supabase сам генерирует
    // одноразовый токен и добавляет его в redirectTo при переходе по
    // ссылке. supabase-js подхватывает токен из URL автоматически
    // (detectSessionInUrl по умолчанию включён) и создаёт временную сессию
    // восстановления, о которой сообщает событием PASSWORD_RECOVERY — см.
    // onAuthStateChange ниже и script.js → initAuthGate.
    async resetPasswordForEmail(email) {
        const db = getSupabaseClient();
        // В программе для ПК адрес страницы — kaban://app, ссылка из письма туда не откроется:
        // восстановление пароля проходит на сайте, потом входим в программе с новым паролем.
        const redirectTo = window.kabanDesktop ? "https://ksougout-netizen.github.io/kaban/" : window.location.href.split("#")[0].split("?")[0];
        const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
    },

    // Задать новый пароль — работает и во время сессии восстановления
    // (после перехода по ссылке из письма), и как обычная смена пароля у
    // уже вошедшего пользователя.
    async updatePassword(newPassword) {
        const db = getSupabaseClient();
        const { error } = await db.auth.updateUser({ password: newPassword });
        if (error) throw error;
    },

    // Вызвать один раз при загрузке приложения, чтобы подписаться на
    // логин/логаут/восстановление пароля (event один из SIGNED_IN,
    // SIGNED_OUT, PASSWORD_RECOVERY, TOKEN_REFRESHED и т.п. — см. документацию
    // supabase-js auth.onAuthStateChange).
    onAuthStateChange(callback) {
        const db = getSupabaseClient();
        return db.auth.onAuthStateChange((event, session) => callback(event, session?.user || null));
    }

};


/* ============================================================================
   ПОЛЬЗОВАТЕЛИ И ЧАТЫ
   ========================================================================= */

// Запись «моей» строки в reactions (реакции, голоса опросов, ходы игр). Таблица
// хранит одну строку на (сообщение, пользователь), и ЗАМЕНА значения — это UPDATE,
// на который в старой схеме нет политики RLS (ошибка «new row violates
// row-level security policy»). Блок «reactions_update_own» в schema.sql это чинит;
// пока он не выполнен, заменяем строку через «удалить + вставить».
async function writeMyReactionRow(db, messageId, userId, emoji) {

    const { error } = await db.from("reactions").upsert({ message_id: messageId, user_id: userId, emoji });
    if (!error) return;

    if (error.code !== "42501" && !/row-level security/i.test(error.message || "")) throw error;

    const removed = await db.from("reactions").delete().eq("message_id", messageId).eq("user_id", userId);
    if (removed.error) throw removed.error;

    const inserted = await db.from("reactions").insert({ message_id: messageId, user_id: userId, emoji });
    if (inserted.error) throw inserted.error;

}
const KabanAPI = {

    auth: KabanAuth,

    // Список чатов текущего пользователя вместе с последним сообщением
    // и именем/аватаром собеседника — ровно то, что нужно для отрисовки
    // сайдбара .chat / .chat-preview.
    async getChats() {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        // Быстрый путь — всё одним запросом (get_chat_list из performance.sql).
        // Пока функция не создана — прежний путь ниже.
        if (getChatsViaRpc !== false) {
            const { data, error } = await db.rpc("get_chat_list");
            if (!error && Array.isArray(data)) {
                getChatsViaRpc = true;
                return data.map((row) => ({ ...row, unreadCount: Number(row.unreadCount || 0) }));
            }
            if (error && isMissingRpcError(error)) getChatsViaRpc = false;
            else if (error) console.warn("get_chat_list не ответил, обычный путь", error);
        }

        const { data: rows, error } = await db
            .from("chat_participants")
            .select(`
                chat_id,
                last_read_at,
                is_muted,
                is_pinned,
                is_blocked,
                chats (
                    id, type, title, avatar_url, is_secret, created_at,
                    messages ( id, text, type, created_at, sender_id )
                )
            `)
            // .eq() обязателен: без него RLS отдаёт СТРОКИ ОБОИХ участников
            // каждого чата (я вижу их, раз я тоже состою в чате) — список
            // задвоился бы. Нужна только моя собственная строка членства.
            .eq("user_id", me.id)
            // Без этих двух модификаторов Supabase подтянет ВСЮ историю
            // сообщений в каждом чате вместо одного последнего — дорого и
            // не нужно для отрисовки списка чатов (там достаточно превью).
            .order("created_at", { foreignTable: "chats.messages", ascending: false })
            .limit(1, { foreignTable: "chats.messages" });

        if (error) throw error;
        if (!rows.length) return [];

        // У личных чатов chats.title всегда пустой (он только для групп) —
        // имя и аватар для сайдбара берём у ВТОРОГО участника, отдельным
        // батч-запросом на все чаты сразу, а не по одному на чат.
        const chatIds = rows.map((row) => row.chat_id);

        // Три независимых запроса (собеседники, имена авторов в группах, счётчики
        // непрочитанных) раньше шли СТРОГО по очереди — список чатов ждал сумму трёх
        // сетевых кругов. Теперь они идут одновременно.
        const groupSenderIds = [...new Set(rows
            .filter((row) => row.chats?.type === "group")
            .map((row) => row.chats.messages?.[0]?.sender_id)
            .filter(Boolean))];

        const participantsQuery = db
            .from("chat_participants")
            // avatar_video_url НАРОЧНО не включён сюда — колонка появится в
            // базе только после того, как будет выполнена миграция из
            // schema.sql (alter table ... add column avatar_video_url).
            // Supabase падает на SELECT несуществующей колонки для ВСЕХ
            // строк разом — без этой оговорки список чатов не грузился бы
            // вообще ни у кого, пока миграция не накатана. Как только она
            // накатана — просто дописать ", avatar_video_url" в конец ниже.
            //
            // is_bot — ТРЕБУЕТ миграции из schema.sql (блок "ИИ-БОТ") перед
            // деплоем этого файла, по той же причине.
            .select("chat_id, users!chat_participants_user_id_fkey ( id, username, display_name, avatar_url, is_online, status_emoji, last_seen, bio, is_bot )")
            .in("chat_id", chatIds)
            .neq("user_id", me.id);

        const sendersQuery = groupSenderIds.length
            ? db.from("users").select("id, display_name").in("id", groupSenderIds)
            : Promise.resolve({ data: [], error: null });

        // Счётчики непрочитанных — отдельным RPC (get_unread_counts в schema.sql).
        const unreadQuery = db.rpc("get_unread_counts");

        const [
            { data: participants, error: participantsError },
            { data: senders, error: sendersError },
            { data: unreadRows, error: unreadError }
        ] = await Promise.all([participantsQuery, sendersQuery, unreadQuery]);

        if (participantsError) throw participantsError;
        if (sendersError) console.warn("Не удалось загрузить имена отправителей", sendersError);
        if (unreadError) console.warn("Не удалось загрузить счётчики непрочитанных", unreadError);

        const otherUserByChatId = new Map();
        (participants || []).forEach((participant) => {
            if (!otherUserByChatId.has(participant.chat_id)) {
                otherUserByChatId.set(participant.chat_id, participant.users);
            }
        });
        const senderNameById = new Map((senders || []).map((u) => [u.id, u.display_name]));
        const unreadCountByChatId = new Map((unreadRows || []).map((r) => [r.chat_id, r.unread_count]));
        return rows.map((row) => ({
            ...row,
            otherUser: otherUserByChatId.get(row.chat_id) || null,
            lastMessageSenderName: row.chats?.type === "group"
                ? senderNameById.get(row.chats.messages?.[0]?.sender_id) || null
                : null,
            unreadCount: Number(unreadCountByChatId.get(row.chat_id) || 0)
        }));
    },

    // Найти пользователя по нику — для кнопки "+" (новый чат).
    async searchUsersByUsername(query) {
        const db = getSupabaseClient();
        // % и _ во вводе — спецсимволы ilike: «a_b» находил бы «axb», «%» — всех подряд.
        const safe = String(query || "").trim().replace(/^@/, "").replace(/[\\%_]/g, (m) => "\\" + m);
        if (!safe) return [];
        const { data, error } = await db
            .from("users")
            // is_bot — требует миграции "ИИ-БОТ" из schema.sql.
            .select("id, username, display_name, avatar_url, is_online, status_emoji, is_bot")
            .ilike("username", `%${safe}%`)
            .limit(20);

        if (error) throw error;
        return data;
    },

    // Профиль текущего пользователя — для формы "Профиль" в Настройках.
    async getMyProfile() {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        // avatar_video_url НАРОЧНО не включён — см. комментарий у того же
        // поля в getChats() чуть выше по файлу: колонки ещё нет в реальной
        // базе, SELECT с ней упадёт и весь профиль перестанет загружаться.
        const { data, error } = await db
            .from("users")
            .select("id, username, display_name, bio, status_emoji, avatar_url")
            .eq("id", me.id)
            .single();

        if (error) throw error;
        return data;
    },

    // Сохранить изменения профиля (имя/юзернейм/статус/эмодзи-статус).
    // Передавайте только те поля, которые реально поменялись — остальные
    // можно не указывать.
    async updateProfile({ displayName, username, bio, statusEmoji, avatarUrl, avatarVideoUrl } = {}) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const patch = { updated_at: new Date().toISOString() };
        if (displayName !== undefined) patch.display_name = displayName;
        if (username !== undefined) patch.username = username;
        if (bio !== undefined) patch.bio = bio;
        if (statusEmoji !== undefined) patch.status_emoji = statusEmoji;
        if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;
        if (avatarVideoUrl !== undefined) patch.avatar_video_url = avatarVideoUrl;

        const { data, error } = await db
            .from("users")
            .update(patch)
            .eq("id", me.id)
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    // Загрузить фото профиля в Storage (бакет "avatars", своя папка по
    // user id) и вернуть публичный URL — сохранить его нужно отдельным
    // вызовом updateProfile({ avatarUrl }).
    async uploadAvatar(file) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const path = `${me.id}/${Date.now()}_${sanitizeStorageFileName(file.name)}`;
        const { error } = await db.storage.from("avatars").upload(path, file, { upsert: true });
        if (error) throw error;

        const { data } = db.storage.from("avatars").getPublicUrl(path);
        return data.publicUrl;
    },

    // Удалить файл из Storage по его публичной ссылке — вызывать со СТАРЫМ
    // url ПОСЛЕ того, как новый файл уже сохранён (см. script.js →
    // handleAvatarFileChange/selectGroupInfoAvatarFile): каждая загрузка
    // фото кладёт новый файл, а не перезаписывает старый, поэтому без этого
    // прежние версии аватара копились бы в Storage навсегда.
    async deleteStorageFile(bucket, url) {
        await deleteStorageObjectByUrl(bucket, url);
    },

    // Найти существующий личный чат с пользователем или создать новый.
    async getOrCreateDirectChat(otherUserId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        // Атомарный путь: поиск + создание под одним замком на сервере
        // (get_or_create_direct_chat в schema.sql) — два одновременных вызова
        // не создадут два чата. Если миграция ещё не накатана — прежний путь
        // ниже (с окном гонки между проверкой и вставкой).
        const { data: chatId, error: rpcError } = await db.rpc("get_or_create_direct_chat", { p_other: otherUserId });
        if (!rpcError && chatId) return chatId;
        if (rpcError && !isMissingRpcError(rpcError)) throw rpcError;

        // ищем чат, где участники — ровно я и otherUserId
        const { data: existing } = await db.rpc("find_direct_chat", {
            user_a: me.id,
            user_b: otherUserId
        });

        if (existing?.length) return existing[0].chat_id;

        const { data: chat, error: chatError } = await db
            .from("chats")
            .insert({ type: "direct", created_by: me.id })
            .select()
            .single();
        if (chatError) throw chatError;

        const { error: participantsError } = await db
            .from("chat_participants")
            .insert([
                { chat_id: chat.id, user_id: me.id },
                { chat_id: chat.id, user_id: otherUserId }
            ]);
        if (participantsError) throw participantsError;

        return chat.id;
    },

    // "Избранное" (Saved Messages) — личный чат, где единственный участник
    // я сам. chat_participants.primary key (chat_id, user_id) не даёт
    // вставить себя дважды, поэтому это НЕ обычный getOrCreateDirectChat(me.id)
    // (он вставляет "я + собеседник" парой) — отдельная вставка одной строки.
    // ВАЖНО: find_direct_chat(me.id, me.id) здесь НЕ подходит — его self-join
    // (cp1.user_id = cp2.user_id = me) тривиально совпадает с ЛЮБЫМ моим
    // обычным direct-чатом (cp1 и cp2 там могут оказаться одной и той же
    // строкой моего членства, независимо от того, есть ли второй участник),
    // поэтому он вернул бы случайный существующий чат, а не настоящее
    // "Избранное". Проверку "уже существует" делает вызывающий код
    // (ensureSavedMessagesChatExists в script-chats.js) через cachedChatRows —
    // здесь просто безусловно создаём новый чат с единственным участником.
    async getOrCreateSavedMessagesChat() {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        // Идемпотентный серверный путь (get_or_create_saved_chat в schema.sql):
        // повторный/параллельный вызов вернёт уже существующее "Избранное"
        // вместо создания второго. Откат на прежнюю безусловную вставку ниже —
        // только если миграция ещё не накатана.
        const { data: savedId, error: rpcError } = await db.rpc("get_or_create_saved_chat");
        if (!rpcError && savedId) return savedId;
        if (rpcError && !isMissingRpcError(rpcError)) throw rpcError;

        const { data: chat, error: chatError } = await db
            .from("chats")
            .insert({ type: "direct", created_by: me.id })
            .select()
            .single();
        if (chatError) throw chatError;

        const { error: participantError } = await db
            .from("chat_participants")
            .insert({ chat_id: chat.id, user_id: me.id });
        if (participantError) throw participantError;

        return chat.id;
    },


    /* ------------------------------------------------------------------
       ГРУППОВЫЕ ЧАТЫ
       ------------------------------------------------------------------ */

    // Создать группу: сам создатель сразу становится admin (нужно для
    // chats_update_admin/is_chat_admin — см. schema.sql), остальные —
    // обычные участники. RLS chat_participants_insert_self разрешает
    // создателю чата вставить участников списком целиком (см. комментарий
    // там же про created_by), поэтому размер группы не ограничен "я + один".
    async createGroupChat(title, memberIds) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { data: chat, error: chatError } = await db
            .from("chats")
            .insert({ type: "group", title, created_by: me.id })
            .select()
            .single();
        if (chatError) throw chatError;

        const { error: participantsError } = await db
            .from("chat_participants")
            .insert([
                { chat_id: chat.id, user_id: me.id, role: "admin" },
                ...memberIds.map((userId) => ({ chat_id: chat.id, user_id: userId, role: "member" }))
            ]);
        if (participantsError) throw participantsError;

        return chat.id;
    },

    // Все участники группы вместе с их профилем — для шапки чата (счётчик
    // "N участников"), подписи имени отправителя над чужими сообщениями и
    // экрана "Информация о группе".
    async getChatMembers(chatId) {
        const db = getSupabaseClient();
        // admin_rights/admin_title/promoted_by — права админов (миграция
        // "ГРУППЫ: РОЛИ И ПРАВА" из schema.sql). Пока она не накатана, колонок
        // нет и такой select падает (42703) — откатываемся на прежний набор
        // полей, чтобы список участников не пропал совсем.
        let { data, error } = await db
            .from("chat_participants")
            // is_bot — требует миграции "ИИ-БОТ" из schema.sql.
            .select("user_id, role, joined_at, admin_rights, admin_title, promoted_by, users!chat_participants_user_id_fkey ( id, username, display_name, avatar_url, is_online, last_seen, is_bot )")
            .eq("chat_id", chatId)
            .order("joined_at", { ascending: true });

        if (error && (error.code === "42703" || /admin_rights|admin_title|promoted_by/.test(error.message || ""))) {
            ({ data, error } = await db
                .from("chat_participants")
                .select("user_id, role, joined_at, users!chat_participants_user_id_fkey ( id, username, display_name, avatar_url, is_online, last_seen, is_bot )")
                .eq("chat_id", chatId)
                .order("joined_at", { ascending: true }));
        }

        if (error) throw error;
        return data;
    },

    // Данные группы, которых нет в списке чатов: описание, владелец и
    // разрешения участников. null — если миграция ещё не накатана (тогда
    // интерфейс остаётся в прежнем виде).
    async getGroupDetails(chatId) {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from("chats")
            .select("id, title, avatar_url, description, owner_id, member_permissions")
            .eq("id", chatId)
            .maybeSingle();
        if (error) {
            if (error.code === "42703" || /description|owner_id|member_permissions/.test(error.message || "")) return null;
            throw error;
        }
        return data;
    },

    // Группы, где состоим ОБА — я и otherUserId: сначала мои группы, потом
    // пересечение со строками участия otherUserId в них же (RLS отдаёт все
    // строки чата, где я сам состою, — см. chat_participants_select_member
    // в schema.sql, — поэтому видеть чужую строку участия в ОБЩЕЙ группе
    // можно). Число участников — отдельным батч-запросом по уже найденным
    // chat_id, без похода в базу на каждую группу по отдельности.
    async getSharedGroups(otherUserId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return [];

        const { data: myGroups, error: myGroupsError } = await db
            .from("chat_participants")
            .select("chat_id, chats!inner(id, type, title, avatar_url)")
            .eq("user_id", me.id)
            .eq("chats.type", "group");
        if (myGroupsError) throw myGroupsError;
        if (!myGroups.length) return [];

        const myGroupIds = myGroups.map((row) => row.chat_id);

        const { data: sharedRows, error: sharedError } = await db
            .from("chat_participants")
            .select("chat_id")
            .eq("user_id", otherUserId)
            .in("chat_id", myGroupIds);
        if (sharedError) throw sharedError;

        const sharedIds = new Set(sharedRows.map((row) => row.chat_id));
        if (!sharedIds.size) return [];

        const { data: allMembers } = await db
            .from("chat_participants")
            .select("chat_id")
            .in("chat_id", [...sharedIds]);

        const countByChatId = new Map();
        (allMembers || []).forEach((row) => countByChatId.set(row.chat_id, (countByChatId.get(row.chat_id) || 0) + 1));

        return myGroups
            .filter((row) => sharedIds.has(row.chat_id))
            .map((row) => ({
                chatId: row.chat_id,
                title: row.chats.title,
                avatarUrl: row.chats.avatar_url,
                memberCount: countByChatId.get(row.chat_id) || 0
            }));
    },

    // Переименовать группу и/или сменить её аватар — RLS chats_update_admin
    // пропустит только если вызывающий admin этого чата.
    async updateGroupInfo(chatId, { title, description, avatarUrl, clearAvatar } = {}) {
        const db = getSupabaseClient();

        // Основной путь — функция group_update_info (проверяет право
        // "изменение профиля группы"); откат на прямой UPDATE — только если
        // миграция "ГРУППЫ: РОЛИ И ПРАВА" ещё не накатана.
        const { error: rpcError } = await db.rpc("group_update_info", {
            p_chat: chatId,
            p_title: title ?? null,
            p_description: description ?? null,
            p_avatar_url: avatarUrl ?? null,
            p_clear_avatar: !!clearAvatar
        });
        if (!rpcError) return true;
        if (!isMissingRpcError(rpcError)) throw rpcError;

        const patch = {};
        if (title !== undefined) patch.title = title;
        if (avatarUrl !== undefined) patch.avatar_url = avatarUrl;
        if (!Object.keys(patch).length) return true;

        const { error } = await db.from("chats").update(patch).eq("id", chatId);
        if (error) throw error;
        return true;
    },

    // ---- управление группой (роли, права, баны) — функции group_* из schema.sql ----

    async setGroupAdmin(chatId, userId, rights, title) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_set_admin", { p_chat: chatId, p_user: userId, p_rights: rights || {}, p_title: title || null });
        if (error) throw error;
    },

    async removeGroupAdmin(chatId, userId) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_remove_admin", { p_chat: chatId, p_user: userId });
        if (error) throw error;
    },

    // ban=true — ещё и в чёрный список группы.
    async kickGroupMember(chatId, userId, ban = false) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_remove_member", { p_chat: chatId, p_user: userId, p_ban: !!ban });
        if (!error) return;
        if (!isMissingRpcError(error)) throw error;
        // Миграция не накатана — прежний путь (удаление строки участника).
        const { error: legacyError } = await db.from("chat_participants").delete().eq("chat_id", chatId).eq("user_id", userId);
        if (legacyError) throw legacyError;
    },

    async unbanGroupMember(chatId, userId) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_unban", { p_chat: chatId, p_user: userId });
        if (error) throw error;
    },

    async listGroupBans(chatId) {
        const db = getSupabaseClient();
        const { data, error } = await db.rpc("group_list_bans", { p_chat: chatId });
        if (error) throw error;
        return data || [];
    },

    async setGroupPermissions(chatId, permissions) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_set_permissions", { p_chat: chatId, p_perms: permissions });
        if (error) throw error;
    },

    async transferGroupOwner(chatId, userId) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_transfer_owner", { p_chat: chatId, p_new_owner: userId });
        if (error) throw error;
    },

    async deleteGroup(chatId) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("group_delete", { p_chat: chatId });
        if (error) throw error;
    },

    // Пригласительная ссылка: активный код группы (создаётся при первом запросе);
    // reset=true отзывает старые коды и выдаёт новый.
    async getGroupInviteCode(chatId, reset = false) {
        const db = getSupabaseClient();
        const { data, error } = await db.rpc("group_get_invite", { p_chat: chatId, p_reset: !!reset });
        if (error) throw error;
        return data;
    },

    // null — ссылка недействительна или отозвана.
    async previewGroupInvite(code) {
        const db = getSupabaseClient();
        const { data, error } = await db.rpc("group_invite_preview", { p_code: code });
        if (error) throw error;
        return data?.[0] || null;
    },

    async joinGroupByInvite(code) {
        const db = getSupabaseClient();
        const { data, error } = await db.rpc("group_join_by_invite", { p_code: code });
        if (error) throw error;
        return data;
    },

    // Аватар группы — тот же бакет "attachments", что и обычные вложения:
    // его политика уже разрешает загрузку любому участнику чата в папку
    // с именем chat_id (см. attachments_upload_chat_members в schema.sql),
    // отдельный бакет не нужен.
    async uploadGroupAvatar(chatId, file) {
        const db = getSupabaseClient();
        const path = `${chatId}/avatar_${Date.now()}_${sanitizeStorageFileName(file.name)}`;

        const { error } = await db.storage.from("attachments").upload(path, file);
        if (error) throw error;

        const { data } = db.storage.from("attachments").getPublicUrl(path);
        return data.publicUrl;
    },

    // Добавить участников в уже существующую группу — доступно любому
    // текущему участнику (см. chat_participants_insert_self: is_chat_member).
    async addGroupMembers(chatId, userIds) {
        const db = getSupabaseClient();
        const { error } = await db
            .from("chat_participants")
            .insert(userIds.map((userId) => ({ chat_id: chatId, user_id: userId, role: "member" })));
        if (error) throw error;
    },

    // Удалить участника из группы — свою же строку может удалить кто угодно
    // ("покинуть группу"), чужую только admin ("исключить", см.
    // chat_participants_delete в schema.sql).
    async removeGroupMember(chatId, userId) {
        const db = getSupabaseClient();
        const { error } = await db
            .from("chat_participants")
            .delete()
            .eq("chat_id", chatId)
            .eq("user_id", userId);
        if (error) throw error;
    },

    // Заблокировать/разблокировать собеседника В ЭТОМ чате — пишет в СВОЮ
    // же строку chat_participants (chat_participants_update_own уже
    // разрешает это), проверяет её потом messages_insert_member на стороне
    // собеседника: если я его заблокировал, его INSERT в этот чат больше
    // не проходит RLS (см. schema.sql). Настоящая блокировка, а не только
    // локальный вид интерфейса.
    async setBlocked(chatId, blocked) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { error } = await db
            .from("chat_participants")
            .update({ is_blocked: blocked })
            .eq("chat_id", chatId)
            .eq("user_id", me.id);
        if (error) throw error;
    },

    // Заблокирован ли собеседник МНОЮ в этом чате — вызывать при открытии
    // чата, чтобы кнопка/композер сразу показывали сохранённое состояние.
    async getBlocked(chatId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return false;

        const { data, error } = await db
            .from("chat_participants")
            .select("is_blocked")
            .eq("chat_id", chatId)
            .eq("user_id", me.id)
            .maybeSingle();
        if (error) { console.warn("Не удалось проверить блокировку", error); return false; }
        return !!data?.is_blocked;
    },

    // Список всех собеседников, которых я заблокировал — отдельным экраном
    // в настройках, а не только через кнопку в карточке каждого контакта
    // по отдельности (где легко забыть, кого вообще когда-то заблокировал).
    async getBlockedContacts() {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return [];

        const { data: blockedRows, error } = await db
            .from("chat_participants")
            .select("chat_id")
            .eq("user_id", me.id)
            .eq("is_blocked", true);
        if (error) throw error;
        if (!blockedRows.length) return [];

        const chatIds = blockedRows.map((row) => row.chat_id);
        const { data: participants, error: participantsError } = await db
            .from("chat_participants")
            .select("chat_id, users!chat_participants_user_id_fkey ( id, username, display_name, avatar_url )")
            .in("chat_id", chatIds)
            .neq("user_id", me.id);
        if (participantsError) throw participantsError;

        return participants
            .filter((p) => p.users)
            .map((p) => ({ chatId: p.chat_id, user: p.users }));
    },

    // Закреплённые чаты — личная настройка (своя строка chat_participants),
    // тот же приём, что setBlocked выше.
    async setChatPinned(chatId, pinned) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { error } = await db
            .from("chat_participants")
            .update({ is_pinned: pinned })
            .eq("chat_id", chatId)
            .eq("user_id", me.id);
        if (error) throw error;
    },

    async setChatMuted(chatId, muted) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { error } = await db
            .from("chat_participants")
            .update({ is_muted: muted })
            .eq("chat_id", chatId)
            .eq("user_id", me.id);
        if (error) throw error;
    },

    // Сохранить push-подписку этого браузера/устройства — upsert по
    // endpoint (он уникален на весь мир на одну связку браузер+сайт+профиль,
    // см. unique в schema.sql), чтобы повторная подписка того же браузера
    // не плодила дубликаты строк.
    async savePushSubscription({ endpoint, p256dh, auth }) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { error } = await db
            .from("push_subscriptions")
            .upsert({ user_id: me.id, endpoint, p256dh, auth }, { onConflict: "endpoint" });
        if (!error) return;
        // Без политики UPDATE (до performance.sql) повторная подписка того же браузера
        // падала на RLS — заменяем свою строку «удалить + вставить».
        if (error.code !== "42501" && !/row-level security/i.test(error.message || "")) throw error;
        await db.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", me.id);
        const { error: insertError } = await db.from("push_subscriptions").insert({ user_id: me.id, endpoint, p256dh, auth });
        if (insertError && insertError.code !== "23505") throw insertError;
    },

    // Отписаться (например, при выходе из аккаунта на этом устройстве) —
    // не обязательно, но опрятнее: иначе после signOut подписка осталась бы
    // привязана к уже вышедшему пользователю до следующей замены.
    async deletePushSubscription(endpoint) {
        const db = getSupabaseClient();
        const { error } = await db.from("push_subscriptions").delete().eq("endpoint", endpoint);
        if (error) throw error;
    },


    /* ------------------------------------------------------------------
       СООБЩЕНИЯ
       ------------------------------------------------------------------ */

    async getMessages(chatId, { limit = 50, before = null } = {}) {
        const db = getSupabaseClient();
        let query = db
            .from("messages")
            .select("*, message_status(user_id, status), reactions(user_id, emoji)")
            .eq("chat_id", chatId)
            .order("created_at", { ascending: false })
            .limit(limit);

        if (before) query = query.lt("created_at", before);

        const { data, error } = await query;
        if (error) throw error;
        return data.reverse();
    },

    // Единая точка отправки — текст и любые вложения (для файлов сначала
    // вызвать uploadAttachment, полученный url передать сюда).
    // encryptionIv/keyIndex заполняются только для сообщений в секретных
    // чатах — см. crypto.js → sendSecretMessage(), которая сама шифрует text
    // и вычисляет keyIndex (номер звена цепочки ключей) перед тем, как
    // передать их сюда. Для обычных чатов оба остаются null.
    async sendMessage(chatId, { type = "text", text = null, attachmentUrl = null, attachmentMeta = null, replyToId = null, encryptionIv = null, keyIndex = null, id = null }) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        // id задаёт клиент для очереди неотправленных (resilience.js): повторная
        // отправка того же сообщения после обрыва не создаёт дубль — сервер
        // ответит ошибкой дубликата ключа (23505), и очередь поймёт, что оно уже доставлено.
        const { data, error } = await db
            .from("messages")
            .insert({
                ...(id ? { id } : {}),
                chat_id: chatId,
                sender_id: me.id,
                type,
                text,
                attachment_url: attachmentUrl,
                attachment_meta: attachmentMeta,
                reply_to_id: replyToId,
                encryption_iv: encryptionIv,
                key_index: keyIndex
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    // Изменить текст своего сообщения (RLS: messages_update_own — только автор).
    async editMessage(messageId, text) {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from("messages")
            .update({ text, edited_at: new Date().toISOString() })
            .eq("id", messageId)
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    // "Удалить у меня" — сообщение (даже чужое) пропадает только из МОЕГО
    // чата, у собеседника остаётся как было. Строка физически не удаляется,
    // просто перестаёт попадать в выборку для меня (см. RLS-политику
    // messages_select_member + функцию delete_message_for_me в schema.sql).
    async deleteMessageForMe(messageId) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("delete_message_for_me", { target_message_id: messageId });
        if (error) throw error;
    },

    // "Удалить у нас обоих" — настоящее удаление строки (только своё
    // сообщение, см. RLS-политику messages_delete_own); пропадает у обеих
    // сторон без следа, никакого плейсхолдера "сообщение удалено". Если у
    // сообщения было вложение — заодно стираем и сам файл из Storage (см.
    // attachments_delete_own в schema.sql), иначе файл остался бы висеть
    // там навсегда даже после того, как сообщение пропало из чата.
    async deleteMessageForEveryone(messageId) {
        const db = getSupabaseClient();

        // Удаление сразу возвращает удалённую строку (ссылку на вложение) — один
        // запрос вместо «сначала прочитать, потом удалить».
        const { data: removed, error } = await db.from("messages").delete().eq("id", messageId).select("attachment_url");
        if (error) throw error;
        // RLS молча не дала удалить (чужое сообщение без прав) — честно сообщаем.
        if (!removed?.length) throw new Error("Нет прав удалить это сообщение у всех");

        await deleteStorageObjectByUrl("attachments", removed[0]?.attachment_url);
    },

    // Массовое «удалить у всех» одним запросом (раньше — по запросу на сообщение).
    // Возвращает id реально удалённых (на чужие без прав RLS молча не даст).
    async deleteMessagesForEveryone(ids) {
        const db = getSupabaseClient();
        const { data: removed, error } = await db.from("messages").delete().in("id", ids).select("id, attachment_url");
        if (error) throw error;
        await Promise.all((removed || []).map((row) => deleteStorageObjectByUrl("attachments", row.attachment_url)));
        return (removed || []).map((row) => row.id);
    },

    // "В сети" / "был(а) N минут назад" в шапке и списке чатов — простой
    // heartbeat поверх обычных is_online/last_seen (не realtime-presence,
    // см. subscribeToPresence ниже для "печатает…" и мгновенного статуса
    // в ОТКРЫТОМ чате). Вызывается раз при входе, дальше по таймеру и на
    // сворачивание/закрытие вкладки — см. script.js → startPresenceHeartbeat.
    async updateMyPresence(isOnline) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return;

        // Токен запоминаем для updateMyPresenceOnExit: при закрытии вкладки
        // асинхронно доставать сессию уже некогда.
        db.auth.getSession().then(({ data }) => {
            if (data?.session?.access_token) presenceExitAuth = { userId: me.id, token: data.session.access_token };
        }).catch(() => {});

        const { error } = await db
            .from("users")
            .update({ is_online: isOnline, last_seen: new Date().toISOString() })
            .eq("id", me.id);

        if (error) console.warn("Не удалось обновить статус присутствия", error);
    },

    // Запрос "ухожу" при закрытии/выгрузке страницы. Обычный запрос supabase-js
    // здесь не успевает (await getSession + fetch без keepalive обрываются
    // вместе со страницей), и флаг is_online залипал навсегда. fetch с
    // keepalive доживает после закрытия вкладки.
    updateMyPresenceOnExit() {
        if (!presenceExitAuth || !IS_SUPABASE_CONFIGURED) return;
        try {
            fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(presenceExitAuth.userId)}`, {
                method: "PATCH",
                keepalive: true,
                headers: {
                    apikey: SUPABASE_ANON_KEY,
                    Authorization: `Bearer ${presenceExitAuth.token}`,
                    "Content-Type": "application/json",
                    Prefer: "return=minimal"
                },
                body: JSON.stringify({ is_online: false, last_seen: new Date().toISOString() })
            }).catch(() => {});
        } catch { /* страница закрывается — сделать больше нечего */ }
    },

    // ГЛОБАЛЬНОЕ присутствие: один общий канал на всех. Каждая вкладка/устройство
    // отмечается в нём (visible = вкладка на виду); человек "в сети", если хоть
    // одна его вкладка видима. Сервер сам убирает отключившихся (в том числе при
    // аварийном закрытии, когда "ухожу" не отправляется) — именно поэтому статус
    // берётся отсюда, а не из залипающего users.is_online. onChange получает
    // Set id пользователей в сети; onLeave — id того, кто только что пропал.
    joinGlobalPresence({ onChange, onLeave } = {}) {
        const db = getSupabaseClient();
        let visible = document.visibilityState === "visible";
        let live = null;
        let closed = false;

        const ready = KabanAuth.getCurrentUser().then((me) => {
            if (!me || closed) return null;
            // Ключ присутствия = id пользователя — поэтому канал создаётся
            // только после того, как id известен.
            const channel = db.channel("online:global", { config: { presence: { key: me.id } } });
            const onlineNow = () => {
                const online = new Set();
                Object.entries(channel.presenceState()).forEach(([key, metas]) => {
                    if ((metas || []).some((meta) => meta.visible !== false)) online.add(key);
                });
                return online;
            };
            channel
                .on("presence", { event: "sync" }, () => onChange?.(onlineNow()))
                // leave приходит и когда закрылась одна из нескольких вкладок —
                // ушёл ли человек совсем, решает состояние после события.
                .on("presence", { event: "leave" }, ({ key }) => {
                    setTimeout(() => { if (!onlineNow().has(key)) onLeave?.(key); }, 0);
                })
                .subscribe((status) => {
                    // SUBSCRIBED приходит и после переподключения — отмечаемся заново.
                    if (status === "SUBSCRIBED") channel.track({ visible, at: new Date().toISOString() }).catch(() => {});
                });
            live = channel;
            return channel;
        }).catch(() => null);

        return {
            setVisible(value) {
                visible = !!value;
                if (live) live.track({ visible, at: new Date().toISOString() }).catch(() => {});
            },
            unsubscribe() {
                closed = true;
                ready.then((channel) => { if (channel) db.removeChannel(channel); });
            }
        };
    },
    // Закрепить/открепить — доступно любому участнику чата, не только
    // автору сообщения, поэтому идёт через RPC (см. schema.sql →
    // toggle_message_pin), а не обычный update(). forEveryone имеет
    // значение только при pin=true ("закрепить у меня" / "у нас обоих");
    // открепление всегда снимает только свой собственный id.
    async togglePin(messageId, pin, forEveryone = false) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("toggle_message_pin", {
            target_message_id: messageId,
            pin,
            for_everyone: forEveryone
        });
        if (error) throw error;
    },

    // Загрузить файл (фото/видео/аудио/документ) в Storage, вернуть публичный URL.
    async uploadAttachment(chatId, file) {
        const db = getSupabaseClient();
        const path = `${chatId}/${Date.now()}_${sanitizeStorageFileName(file.name)}`;

        const { error } = await db.storage.from("attachments").upload(path, file);
        if (error) throw error;

        const { data } = db.storage.from("attachments").getPublicUrl(path);
        return data.publicUrl;
    },

    // Настоящие галочки: вызывать, когда сообщение реально попало в
    // видимую область экрана собеседника.
    async markAsRead(messageId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return;

        const { error } = await db
            .from("message_status")
            .upsert({ message_id: messageId, user_id: me.id, status: "read", updated_at: new Date().toISOString() });

        if (error) throw error;
    },

    // Та же отметка, но пачкой — вызывается при открытии чата (все чужие
    // сообщения сразу считаются прочитанными) и на каждое новое входящее,
    // пока чат открыт (см. script.js → openRealChat).
    async markMessagesAsRead(messageIds) {
        if (!messageIds?.length) return;
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return;

        const now = new Date().toISOString();
        const { error } = await db
            .from("message_status")
            .upsert(messageIds.map((messageId) => ({ message_id: messageId, user_id: me.id, status: "read", updated_at: now })));

        if (error) throw error;
    },

    // Отмечает прочитанными ВСЕ непрочитанные сообщения чата одним RPC
    // (mark_chat_read из schema.sql — нужно накатить миграцию), без
    // клиентского лимита в 50 сообщений, который имеет markMessagesAsRead
    // через getMessages(). Используется там, где нет смысла тянуть на
    // клиент список сообщений только чтобы собрать их id (см.
    // markChatReadWithoutOpening в script-chats.js).
    async markChatRead(chatId) {
        const db = getSupabaseClient();
        const { error } = await db.rpc("mark_chat_read", { p_chat_id: chatId });
        if (error) throw error;
    },

    // Голос в опросе хранится в той же таблице reactions (одна строка на
    // пользователя и сообщение): emoji = "poll:<номера через запятую>".
    // Так опросы работают без изменений схемы, а живое обновление уже есть
    // (подписка на reactions). Пустой выбор — голос снимается.
    async setPollVote(messageId, indices) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        if (!indices.length) {
            const { error } = await db.from("reactions").delete().eq("message_id", messageId).eq("user_id", me.id);
            if (error) throw error;
            return;
        }

        await writeMyReactionRow(db, messageId, me.id, "poll:" + [...indices].sort((a, b) => a - b).join(","));
    },

    /* ------------------------------------------------------------------
       ИСТОРИИ (см. schema.sql → «ИСТОРИИ»). Пока блок SQL не выполнен, таблицы
       нет: методы возвращают null, а интерфейс историй просто не показывается.
       ------------------------------------------------------------------ */
    async getStoryFeed() {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return null;

        const { data: stories, error } = await db
            .from("stories")
            .select("id, user_id, kind, media_url, text_content, bg, caption, created_at, expires_at, users!stories_user_id_fkey ( id, display_name, avatar_url, username )")
            .gt("expires_at", new Date().toISOString())
            .order("created_at", { ascending: true });

        if (error) {
            if (isMissingRelationError(error)) return null;
            throw error;
        }

        // Только просмотры ещё живых историй — иначе запрос тянул ВСЮ историю просмотров.
        const liveIds = (stories || []).map((s) => s.id);
        const { data: views } = liveIds.length
            ? await db.from("story_views").select("story_id").eq("viewer_id", me.id).in("story_id", liveIds)
            : { data: [] };
        const seen = new Set((views || []).map((v) => v.story_id));
        return { stories: stories || [], seen };
    },

    async createStory({ kind, file, text, bg, caption }) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        let mediaUrl = null;
        if (kind === "image") {
            const path = `${me.id}/stories/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
            const { error: uploadError } = await db.storage.from("avatars").upload(path, file, { contentType: "image/jpeg" });
            if (uploadError) throw uploadError;
            mediaUrl = db.storage.from("avatars").getPublicUrl(path).data.publicUrl;
        }

        const { data, error } = await db
            .from("stories")
            .insert({ user_id: me.id, kind, media_url: mediaUrl, text_content: text || null, bg: bg || null, caption: caption || null })
            .select()
            .single();
        if (error) throw error;
        return data;
    },

    async deleteStory(storyId, mediaUrl) {
        const db = getSupabaseClient();
        const { error } = await db.from("stories").delete().eq("id", storyId);
        if (error) throw error;
        if (mediaUrl) await deleteStorageObjectByUrl("avatars", mediaUrl);
    },

    async markStoryViewed(storyId) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) return;
        await db.from("story_views").upsert({ story_id: storyId, viewer_id: me.id }, { onConflict: "story_id,viewer_id", ignoreDuplicates: true });
    },

    async getStoryViewers(storyId) {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from("story_views")
            .select("viewer_id, viewed_at, users!story_views_viewer_id_fkey ( id, display_name, avatar_url )")
            .eq("story_id", storyId)
            .order("viewed_at", { ascending: false });
        if (error) throw error;
        return data || [];
    },
    // Поиск текста по ВСЕМ моим чатам (RLS сам отдаёт только доступные).
    // % и _ экранируются, иначе ввод вроде "100%" искал бы что угодно.
    async searchMessages(query, limit = 25) {
        const db = getSupabaseClient();
        const pattern = "%" + String(query).replace(/[\\%_]/g, (m) => "\\" + m) + "%";
        const { data, error } = await db
            .from("messages")
            .select("id, chat_id, sender_id, text, created_at")
            .eq("type", "text")
            .is("deleted_at", null)
            // В секретных чатах текст — шифротекст: искать в нём бессмысленно, а
            // «совпадения» по base64 выдавали мусор в результатах.
            .is("encryption_iv", null)
            .ilike("text", pattern)
            .order("created_at", { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    },
    // Канал «слушать вместе» одного чата: broadcast-события состояния плеера
    // (включая собственные — self) и presence участников сессии. Возвращает
    // управляющий объект после подписки: send / join / leave / close.
    async openListenChannel(chatId, { onEvent, onPresence } = {}) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const channel = db.channel(`listen:${chatId}`, { config: { broadcast: { self: true }, presence: { key: me.id } } });

        channel
            .on("broadcast", { event: "listen" }, ({ payload }) => onEvent?.(payload))
            .on("presence", { event: "sync" }, () => onPresence?.(Object.keys(channel.presenceState())));

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Нет связи с сервером")), 9000);
            channel.subscribe((status) => {
                if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
                else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timer); reject(new Error("Канал недоступен")); }
            });
        });

        return {
            send: (payload) => channel.send({ type: "broadcast", event: "listen", payload }),
            join: () => channel.track({ joined: true, at: Date.now() }),
            leave: () => channel.untrack(),
            close: () => db.removeChannel(channel)
        };
    },
    /* ------------------------------------------------------------------
       ГОЛОСОВЫЕ КОМНАТЫ (см. schema.sql → «ГОЛОСОВЫЕ КОМНАТЫ»). Пока таблицы
       нет, getVoiceRooms() возвращает null — интерфейс покажет одну
       виртуальную «Общую комнату».
       ------------------------------------------------------------------ */
    async getVoiceRooms(chatId) {
        const db = getSupabaseClient();
        const { data, error } = await db
            .from("voice_rooms")
            .select("id, chat_id, name, position, created_at")
            .eq("chat_id", chatId)
            .order("position", { ascending: true })
            .order("created_at", { ascending: true });
        if (error) {
            if (isMissingRelationError(error)) return null;
            throw error;
        }
        return data || [];
    },

    async createVoiceRooms(chatId, names) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");
        const { data: existing } = await db.from("voice_rooms").select("position").eq("chat_id", chatId).order("position", { ascending: false }).limit(1);
        let position = (existing?.[0]?.position ?? -1) + 1;
        const rows = names.map((name) => ({ chat_id: chatId, name, position: position++, created_by: me.id }));
        const { data, error } = await db.from("voice_rooms").insert(rows).select();
        if (error) throw error;
        return data;
    },

    async renameVoiceRoom(roomId, name) {
        const db = getSupabaseClient();
        const { error } = await db.from("voice_rooms").update({ name }).eq("id", roomId);
        if (error) throw error;
    },

    async deleteVoiceRoom(roomId) {
        const db = getSupabaseClient();
        const { error } = await db.from("voice_rooms").delete().eq("id", roomId);
        if (error) throw error;
    },

    // Список комнат группы меняется у кого-то другого — обновляем у себя.
    subscribeToVoiceRooms(chatId, onChange) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`voice-rooms:${chatId}:${Math.random().toString(36).slice(2, 8)}`)
            .on("postgres_changes", { event: "*", schema: "public", table: "voice_rooms", filter: `chat_id=eq.${chatId}` }, () => onChange?.())
            .subscribe();
        return () => db.removeChannel(channel);
    },

    // Канал одной комнаты: broadcast-сигналы WebRTC ("sig", адресные) + presence
    // участников (мета: имя, аватар, mute/deafen, момент входа).
    async openVoiceChannel(chatId, roomId, { onSig, onPresence, onDrop } = {}) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const channel = db.channel(`vroom:${chatId}:${roomId}`, { config: { broadcast: { self: false }, presence: { key: me.id } } });

        channel
            .on("broadcast", { event: "sig" }, ({ payload }) => onSig?.(payload))
            .on("presence", { event: "sync" }, () => {
                const members = {};
                Object.entries(channel.presenceState()).forEach(([key, metas]) => { members[key] = (metas || [])[0] || {}; });
                onPresence?.(members);
            });

        let closing = false;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Нет связи с сервером")), 9000);
            let subscribed = false;
            channel.subscribe((status) => {
                if (status === "SUBSCRIBED") { subscribed = true; clearTimeout(timer); resolve(); }
                else if (!subscribed && (status === "CHANNEL_ERROR" || status === "TIMED_OUT")) { clearTimeout(timer); reject(new Error("Канал недоступен")); }
                // Канал оборвался уже после подключения (сервер закрыл, сеть) — пусть владелец переподключится.
                else if (subscribed && !closing && (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT")) onDrop?.(status);
            });
        });

        return {
            send: (payload) => channel.send({ type: "broadcast", event: "sig", payload }),
            track: (meta) => channel.track(meta),
            untrack: () => channel.untrack(),
            close: () => { closing = true; return db.removeChannel(channel); }
        };
    },
    // Ход/выбор в игре — тоже строка в reactions: emoji = "game:<данные>"
    // (одна строка на игрока и сообщение; пустое значение снимает). Как и голоса
    // опросов — без изменений схемы, обновления идут тем же realtime.
    async setGameState(messageId, payload) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        if (!payload) {
            const { error } = await db.from("reactions").delete().eq("message_id", messageId).eq("user_id", me.id);
            if (error) throw error;
            return;
        }

        await writeMyReactionRow(db, messageId, me.id, "game:" + payload);
    },

    // Несколько реакций одного человека на сообщение: в таблице по-прежнему одна
    // строка на (сообщение, пользователь), поэтому набор хранится в самом поле
    // emoji через "|" ("💥|❤️"). Пустой набор — реакции сняты (строка удаляется).
    async setMyReactions(messageId, emojis) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        if (!emojis.length) {
            const { error } = await db.from("reactions").delete().eq("message_id", messageId).eq("user_id", me.id);
            if (error) throw error;
            return;
        }

        await writeMyReactionRow(db, messageId, me.id, emojis.join("|"));
    },

    async toggleReaction(messageId, emoji) {
        const db = getSupabaseClient();
        const me = await KabanAuth.getCurrentUser();
        if (!me) throw new Error("Нужно войти в аккаунт");

        const { data: existing, error: lookupError } = await db
            .from("reactions")
            .select("emoji")
            .eq("message_id", messageId)
            .eq("user_id", me.id)
            .maybeSingle();
        if (lookupError) throw lookupError;

        if (existing?.emoji === emoji) {
            const { error: deleteError } = await db.from("reactions").delete().eq("message_id", messageId).eq("user_id", me.id);
            if (deleteError) throw deleteError;
            return null;
        }

        await writeMyReactionRow(db, messageId, me.id, emoji);
        return emoji;
    },


    // Один общий канал на ВСЕ свои чаты сразу (а не по одному на открытый
    // чат, как subscribeToChat) — нужен для уведомлений и живого списка
    // чатов, когда сообщение приходит НЕ в тот чат, что сейчас открыт.
    // Фильтр по chat_id тут в принципе не задать (это не один конкретный
    // чат) — вместо этого канал вообще без фильтра, а RLS сам решает,
    // какие строки конкретному пользователю можно увидеть (см.
    // messages_select_member в schema.sql): Postgres Realtime уважает RLS
    // так же, как обычный select().
    //
    // KabanAPI.subscribeToInbox({ onMessage: (msg) => ... })
    subscribeToInbox({ onMessage } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`inbox:${Math.random().toString(36).slice(2)}`)
            .on("postgres_changes",
                { event: "INSERT", schema: "public", table: "messages" },
                (payload) => onMessage?.(payload.new)
            )
            .subscribe();

        return () => db.removeChannel(channel);
    },

    /* ------------------------------------------------------------------
       REALTIME: новые сообщения, реакции, статусы прочтения
       ------------------------------------------------------------------ */

    // KabanAPI.subscribeToChat(chatId, {
    //     onMessage: (msg) => appendMessageToUI(msg),
    //     onMessageUpdate: (msg) => applyEditToUI(msg),
    //     onMessageDelete: (msg) => removeMessageFromUI(msg.id),   // "удалить у нас обоих"
    //     onStatusChange: (status) => updateTicks(status),
    //     onReaction: (reaction) => updateReactionChip(reaction),
    // })
    // onChatUpdate — изменилась строка самого чата (название/описание/аватар/
    // разрешения группы, владелец); onMembersChange — изменился состав или
    // роли участников (вступил, исключён, назначен админом, сменились права).
    // Оба нужны группам; в личных чатах просто не приходят.
    subscribeToChat(chatId, { onMessage, onMessageUpdate, onMessageDelete, onStatusChange, onReaction, onChatUpdate, onMembersChange } = {}) {
        const db = getSupabaseClient();

        const channel = db
            // Случайный суффикс — как в subscribeToInbox: иначе повторный вызов
            // для того же chatId ДО того, как предыдущий unsubscribe успел
            // выполниться (быстрое переоткрытие чата), подписывается на тот же
            // детерминированный topic и Supabase может доставить одно и то же
            // событие в оба обработчика — дублирующиеся сообщения/реакции в UI.
            .channel(`chat:${chatId}:${Math.random().toString(36).slice(2)}`)
            .on("postgres_changes",
                { event: "INSERT", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
                (payload) => onMessage?.(payload.new)
            )
            .on("postgres_changes",
                { event: "UPDATE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
                (payload) => onMessageUpdate?.(payload.new)
            )
            .on("postgres_changes",
                { event: "DELETE", schema: "public", table: "messages", filter: `chat_id=eq.${chatId}` },
                (payload) => onMessageDelete?.(payload.old)
            )
            .on("postgres_changes",
                { event: "*", schema: "public", table: "message_status" },
                (payload) => onStatusChange?.(payload.new)
            )
            .on("postgres_changes",
                { event: "*", schema: "public", table: "reactions" },
                (payload) => onReaction?.({ eventType: payload.eventType, row: payload.new || payload.old })
            )
            .subscribe();

        // Изменения самого чата и состава участников — ОТДЕЛЬНЫМ каналом: если
        // таблица chats ещё не добавлена в публикацию Realtime (миграция
        // "ГРУППЫ: РОЛИ И ПРАВА" не накатана), подписка на неё падает, и в
        // общем канале это оборвало бы доставку самих сообщений.
        let metaChannel = null;
        if (onChatUpdate || onMembersChange) {
            metaChannel = db
                .channel(`chat-meta:${chatId}:${Math.random().toString(36).slice(2)}`)
                .on("postgres_changes",
                    { event: "UPDATE", schema: "public", table: "chats", filter: `id=eq.${chatId}` },
                    (payload) => onChatUpdate?.(payload.new)
                )
                .on("postgres_changes",
                    { event: "*", schema: "public", table: "chat_participants", filter: `chat_id=eq.${chatId}` },
                    (payload) => onMembersChange?.({ eventType: payload.eventType, row: payload.new || payload.old })
                )
                .subscribe();
        }

        return () => {
            db.removeChannel(channel);
            if (metaChannel) db.removeChannel(metaChannel);
        };
    },

    /* ------------------------------------------------------------------
       PRESENCE: настоящий "в сети" / "печатает…" вместо таймеров
       ------------------------------------------------------------------ */

    // const presence = KabanAPI.subscribeToPresence(chatId, {
    //     onSync: (onlineUserIds) => updateDot(onlineUserIds.includes(otherUserId)),
    //     onTyping: (userId) => showTypingIndicator(userId),
    // });
    // ...
    // presence.sendTyping();  // вызывать по input-событию в textarea, с debounce
    //
    // Раньше presence-канал открывался с общим ключом ("" для всех) —
    // join/leave тогда сообщали одно и то же пустое имя ключа независимо
    // от того, КТО зашёл, различить пользователей было нельзя. "sync" +
    // presenceState() надёжнее: при любом изменении отдаёт ПОЛНЫЙ текущий
    // список подключённых, из которого просто берём user_id из track().
    subscribeToPresence(chatId, { onSync, onTyping } = {}) {
        const db = getSupabaseClient();
        const channel = db.channel(`presence:${chatId}`);

        channel
            .on("presence", { event: "sync" }, () => {
                const state = channel.presenceState();
                const onlineUserIds = Object.values(state)
                    .flat()
                    .map((presence) => presence.user_id)
                    .filter(Boolean);
                onSync?.(onlineUserIds);
            })
            .on("broadcast", { event: "typing" }, ({ payload }) => onTyping?.(payload.userId))
            .subscribe(async (status) => {
                if (status !== "SUBSCRIBED") return;
                const me = await KabanAuth.getCurrentUser();
                if (me) await channel.track({ user_id: me.id, online_at: new Date().toISOString() });
            });

        return {
            sendTyping: async () => {
                const me = await KabanAuth.getCurrentUser();
                channel.send({ type: "broadcast", event: "typing", payload: { userId: me?.id } });
            },
            unsubscribe: () => db.removeChannel(channel)
        };
    },

    /* ------------------------------------------------------------------
       ЗВОНКИ: Realtime Broadcast используется только как "почта" для
       обмена SDP/ICE между двумя браузерами (сигнализация WebRTC) — сам
       голос/видео после соединения идёт НАПРЯМУЮ между ними (через STUN,
       а если не выйдет — теряется, TURN сознательно не подключали, см.
       script.js), в базу Supabase вообще не попадает и не проходит через
       её серверы. Шифрование медиа — встроенная обязательная часть
       протокола WebRTC (DTLS-SRTP), а не что-то, что нужно делать самим.
       ------------------------------------------------------------------ */

    // Постоянный канал "мне звонят" — подписываться сразу при входе (см.
    // script.js → applyRealSessionState), доставляет входящий вызов
    // независимо от того, какой чат сейчас открыт в интерфейсе.
    subscribeToCallInbox(myUserId, { onOffer } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`call-inbox:${myUserId}`)
            .on("broadcast", { event: "offer" }, ({ payload }) => onOffer?.(payload))
            .subscribe();
        return () => db.removeChannel(channel);
    },

    // Разовая отправка offer вызываемому — своего "постоянного" канала не
    // требует, дальнейший обмен (answer/ice/end) идёт через canal самого
    // звонка (joinCallChannel), а не через этот.
    async sendCallOffer(calleeId, offerPayload) {
        const db = getSupabaseClient();
        const channel = db.channel(`call-inbox:${calleeId}`);
        try {
            await waitForChannelSubscribed(channel);
            await channel.send({ type: "broadcast", event: "offer", payload: offerPayload });
        } finally {
            db.removeChannel(channel); // и при ошибке тоже — иначе канал оставался подписанным
        }
    },

    // Канал конкретного звонка — им пользуются ОБЕ стороны после того, как
    // offer уже доставлен через call-inbox выше: answer/ice-candidate/end
    // привязаны к конкретному callId, а не к пользователю (иначе стало бы
    // не различить сигналы разных, пусть даже не пересекающихся по времени,
    // звонков одному и тому же собеседнику).
    joinCallChannel(callId, { onAnswer, onIceCandidate, onEnd, onRenegotiate, onRestartRequest } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`call:${callId}`)
            .on("broadcast", { event: "answer" }, ({ payload }) => onAnswer?.(payload))
            .on("broadcast", { event: "ice-candidate" }, ({ payload }) => onIceCandidate?.(payload))
            .on("broadcast", { event: "end" }, ({ payload }) => onEnd?.(payload))
            // Переподключение без обрыва звонка (смена сети): новый обмен SDP с
            // ICE restart и просьба собеседника «переподключи нас».
            .on("broadcast", { event: "renegotiate" }, ({ payload }) => onRenegotiate?.(payload))
            .on("broadcast", { event: "restart-request" }, () => onRestartRequest?.());

        const ready = waitForChannelSubscribed(channel);

        return {
            ready,
            sendRenegotiate: (payload) => channel.send({ type: "broadcast", event: "renegotiate", payload }),
            sendRestartRequest: () => channel.send({ type: "broadcast", event: "restart-request", payload: {} }),
            sendAnswer: (payload) => channel.send({ type: "broadcast", event: "answer", payload }),
            sendIceCandidate: (payload) => channel.send({ type: "broadcast", event: "ice-candidate", payload }),
            sendEnd: (payload) => channel.send({ type: "broadcast", event: "end", payload: payload || {} }),
            leave: () => db.removeChannel(channel)
        };
    },

    /* ------------------------------------------------------------------
       ТРАНСЛЯЦИЯ ЭКРАНА (P2P, 1 стример → 1 зритель) — та же схема
       сигнализации, что у звонков и файлов, но на ОТДЕЛЬНЫХ каналах
       (screen-inbox / screen:<streamId>): сбой или нагрузка трансляции не
       могут задеть звонки и передачу файлов. Видео/звук идут напрямую между
       браузерами (RTCPeerConnection), Supabase передаёт только SDP/ICE.
       См. script-core.js → startScreenShare/acceptScreenShare.
       ------------------------------------------------------------------ */

    subscribeToScreenInbox(myUserId, { onOffer } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`screen-inbox:${myUserId}`)
            .on("broadcast", { event: "offer" }, ({ payload }) => onOffer?.(payload))
            .subscribe();
        return () => db.removeChannel(channel);
    },

    async sendScreenOffer(viewerId, offerPayload) {
        const db = getSupabaseClient();
        const channel = db.channel(`screen-inbox:${viewerId}`);
        try {
            await waitForChannelSubscribed(channel);
            await channel.send({ type: "broadcast", event: "offer", payload: offerPayload });
        } finally {
            db.removeChannel(channel);
        }
    },

    joinScreenChannel(streamId, { onAnswer, onIceCandidate, onEnd } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`screen:${streamId}`)
            .on("broadcast", { event: "answer" }, ({ payload }) => onAnswer?.(payload))
            .on("broadcast", { event: "ice-candidate" }, ({ payload }) => onIceCandidate?.(payload))
            .on("broadcast", { event: "end" }, ({ payload }) => onEnd?.(payload));

        const ready = waitForChannelSubscribed(channel);

        return {
            ready,
            sendAnswer: (payload) => channel.send({ type: "broadcast", event: "answer", payload }),
            sendIceCandidate: (payload) => channel.send({ type: "broadcast", event: "ice-candidate", payload }),
            sendEnd: (payload) => channel.send({ type: "broadcast", event: "end", payload: payload || {} }),
            leave: () => db.removeChannel(channel)
        };
    },

    /* ------------------------------------------------------------------
       ГРУППОВЫЕ ЗВОНКИ (аудио/видео, "каждый с каждым" — mesh): у каждого
       участника своё WebRTC-соединение с каждым другим, медиа идёт напрямую.
       Комната звонка — Realtime-канал gcall:<chatId> (один звонок на чат):
         • presence — кто сейчас в звонке (и для всех остальных участников
           чата, которые просто смотрят на баннер "Идёт звонок");
         • broadcast "signal" — SDP/ICE/состояние между конкретными парами
           (в сообщении есть поле to, остальные его игнорируют).
       Приглашения "звонят" через отдельный gcall-inbox:<userId> — так же, как
       у обычных звонков и трансляции, отдельными каналами.
       ------------------------------------------------------------------ */

    subscribeToGroupCallInbox(myUserId, { onInvite } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`gcall-inbox:${myUserId}`)
            .on("broadcast", { event: "invite" }, ({ payload }) => onInvite?.(payload))
            .subscribe();
        return () => db.removeChannel(channel);
    },

    async sendGroupCallInvite(userId, payload) {
        const db = getSupabaseClient();
        const channel = db.channel(`gcall-inbox:${userId}`);
        try {
            await waitForChannelSubscribed(channel);
            await channel.send({ type: "broadcast", event: "invite", payload });
        } finally {
            db.removeChannel(channel);
        }
    },

    // Войти в комнату звонка: onSignal — адресные сообщения, onParticipants —
    // полный актуальный список присутствующих (map userId → meta) при любом
    // изменении. track(meta) объявляет МЕНЯ присутствующим.
    joinGroupCallRoom(chatId, myUserId, { onSignal, onParticipants } = {}) {
        const db = getSupabaseClient();
        const channel = db.channel(`gcall:${chatId}`, { config: { presence: { key: myUserId }, broadcast: { self: false } } });

        const readParticipants = () => {
            const state = channel.presenceState();
            const participants = new Map();
            Object.entries(state).forEach(([key, metas]) => {
                const meta = metas[metas.length - 1];
                if (meta) participants.set(key, meta);
            });
            return participants;
        };

        channel
            .on("broadcast", { event: "signal" }, ({ payload }) => onSignal?.(payload))
            .on("presence", { event: "sync" }, () => onParticipants?.(readParticipants()));

        const ready = waitForChannelSubscribed(channel);

        return {
            ready,
            track: (meta) => channel.track(meta),
            sendSignal: (payload) => channel.send({ type: "broadcast", event: "signal", payload }),
            getParticipants: readParticipants,
            leave: async () => {
                try { await channel.untrack(); } catch {}
                db.removeChannel(channel);
            }
        };
    },

    // Только наблюдать за комнатой (баннер "Идёт звонок — присоединиться" в
    // открытой группе), сами в неё не входя.
    watchGroupCallRoom(chatId, onChange) {
        const db = getSupabaseClient();
        const channel = db.channel(`gcall:${chatId}`, { config: { presence: { key: `watch-${Math.random().toString(36).slice(2)}` } } });
        channel
            .on("presence", { event: "sync" }, () => {
                const participants = new Map();
                Object.entries(channel.presenceState()).forEach(([key, metas]) => {
                    const meta = metas[metas.length - 1];
                    if (meta && meta.userId) participants.set(meta.userId, meta);
                });
                onChange?.(participants);
            })
            .subscribe();
        return () => db.removeChannel(channel);
    },

    /* ------------------------------------------------------------------
       P2P-ПЕРЕДАЧА БОЛЬШИХ ФАЙЛОВ — та же схема сигнализации, что и у
       звонков чуть выше (Realtime Broadcast, SDP/ICE мимо базы), но на
       НАМЕРЕННО ОТДЕЛЬНЫХ каналах (file-inbox / file-transfer, а не
       call-inbox / call), чтобы сбой или нагрузка в передаче файлов не
       могли задеть звонки, и наоборот. Сами байты файла идут напрямую
       между браузерами через RTCDataChannel, Supabase Storage вообще не
       участвует — см. script-core.js → sendP2PFile/acceptFileTransfer.
       ------------------------------------------------------------------ */

    subscribeToFileInbox(myUserId, { onOffer } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`file-inbox:${myUserId}`)
            .on("broadcast", { event: "offer" }, ({ payload }) => onOffer?.(payload))
            .subscribe();
        return () => db.removeChannel(channel);
    },

    async sendFileOffer(receiverId, offerPayload) {
        const db = getSupabaseClient();
        const channel = db.channel(`file-inbox:${receiverId}`);
        try {
            await waitForChannelSubscribed(channel);
            await channel.send({ type: "broadcast", event: "offer", payload: offerPayload });
        } finally {
            db.removeChannel(channel);
        }
    },

    // onReoffer/sendReoffer — для переподключения после обрыва P2P-связи
    // (см. script-core.js → attemptSenderReconnect/handleFileReoffer):
    // отправитель шлёт НОВЫЙ SDP offer на этом же канале (он не закрывается
    // при обрыве самого WebRTC-соединения, только при завершении/отмене
    // передачи), получатель отвечает новым answer как обычно.
    joinFileTransferChannel(transferId, { onAnswer, onReoffer, onIceCandidate, onEnd } = {}) {
        const db = getSupabaseClient();
        const channel = db
            .channel(`file-transfer:${transferId}`)
            .on("broadcast", { event: "answer" }, ({ payload }) => onAnswer?.(payload))
            .on("broadcast", { event: "reoffer" }, ({ payload }) => onReoffer?.(payload))
            .on("broadcast", { event: "ice-candidate" }, ({ payload }) => onIceCandidate?.(payload))
            .on("broadcast", { event: "end" }, ({ payload }) => onEnd?.(payload));

        const ready = waitForChannelSubscribed(channel);

        return {
            ready,
            sendAnswer: (payload) => channel.send({ type: "broadcast", event: "answer", payload }),
            sendReoffer: (payload) => channel.send({ type: "broadcast", event: "reoffer", payload }),
            sendIceCandidate: (payload) => channel.send({ type: "broadcast", event: "ice-candidate", payload }),
            sendEnd: (payload) => channel.send({ type: "broadcast", event: "end", payload: payload || {} }),
            leave: () => db.removeChannel(channel)
        };
    },

    // Патчит attachment_meta уже отправленного сообщения (слияние, а не
    // перезапись целиком) — нужен для смены статуса P2P-передачи (pending →
    // accepted → completed/failed/declined) без создания нового сообщения.
    async updateMessageAttachmentMeta(messageId, patch) {
        const db = getSupabaseClient();
        const { data: existing, error: fetchError } = await db
            .from("messages")
            .select("attachment_meta")
            .eq("id", messageId)
            .single();
        if (fetchError) throw fetchError;

        const merged = { ...(existing?.attachment_meta || {}), ...patch };
        const { error } = await db
            .from("messages")
            .update({ attachment_meta: merged })
            .eq("id", messageId);
        if (error) throw error;
        return merged;
    }

};

// В классическом <script> (не модуле) достаточно того, что KabanAPI объявлен
// как const в глобальной области — script.js сможет обращаться к нему
// напрямую по имени, как и ко всем остальным функциям в проекте.
