/* ============================================================================
   МИНИ-ИГРЫ В ЧАТЕ: крестики-нолики, «камень-ножницы-бумага», кубик.
   Игра — обычное сообщение: type "text", text = запасная подпись для старых
   клиентов, attachment_meta.game = { kind, ... }. Ходы игроков лежат в таблице
   reactions (одна строка на игрока и сообщение, emoji = "game:<данные>"), см.
   KabanAPI.setGameState: схема базы не меняется, обновления идут через тот же
   realtime, что и реакции. Правила проверяются на клиенте — игра для друзей,
   а не турнир.
   ========================================================================= */

const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const RPS_ICONS = { r: "✊", p: "✋", s: "✌️" };
const RPS_NAMES = { r: "Камень", p: "Бумага", s: "Ножницы" };
const DICE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

function gamePlayerName(userId) {
    if (userId === myRealUserId) return "Вы";
    return currentChatMembersById.get(userId)?.display_name || currentChatTitle || "Соперник";
}

// Имя соперника: тот, кто уже сходил; в личном чате это просто собеседник
// (или я, если игру начал он); в группе, пока никто не ответил, — пусто.
function gameOpponentName(message, opponentId) {
    if (opponentId) return gamePlayerName(opponentId);
    if (currentChatType === "group") return null;
    return message.sender_id === myRealUserId ? (currentChatTitle || "Собеседник") : "Вы";
}

// Строки-ходы игроков: [{ userId, payload }], для опоры берём только game:-реакции.
function gameRows(message) {
    return (message.reactions || [])
        .filter((r) => String(r.emoji).startsWith("game:"))
        .map((r) => ({ userId: r.user_id, payload: String(r.emoji).slice(5) }));
}

// Соперник — тот из НЕ автора, кто уже сделал ход; из нескольких — детерминированно
// наименьший id, чтобы у всех клиентов был один и тот же результат.
function gameOpponentRow(message, rows) {
    return rows.filter((r) => r.userId !== message.sender_id).sort((a, b) => (a.userId < b.userId ? -1 : 1))[0] || null;
}

/* ---- крестики-нолики ------------------------------------------------------ */

function tttState(message) {

    const rows = gameRows(message);
    const creatorRow = rows.find((r) => r.userId === message.sender_id);
    const opponentRow = gameOpponentRow(message, rows);
    const parse = (row) => (row && row.payload ? [...new Set(row.payload.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 9))] : []);
    // Ходы пишутся напрямую в базу: «три хода сразу» не принимаем — X может опережать O
    // максимум на один ход, O не может опережать X (лишние ходы с конца отбрасываются).
    let xCells = parse(creatorRow);
    let oCells = parse(opponentRow).filter((i) => !xCells.includes(i));
    oCells = oCells.slice(0, xCells.length);
    xCells = xCells.slice(0, oCells.length + 1);

    const board = new Array(9).fill("");
    xCells.forEach((i) => { board[i] = "X"; });
    oCells.forEach((i) => { if (!board[i]) board[i] = "O"; });

    let winner = null;
    let line = null;
    for (const combo of TTT_LINES) {
        const [a, b, c] = combo;
        if (board[a] && board[a] === board[b] && board[a] === board[c]) { winner = board[a]; line = combo; break; }
    }

    const full = board.every(Boolean);
    const turn = xCells.length === oCells.length ? "X" : "O";

    return { board, winner, line, draw: !winner && full, turn, xCells, oCells, opponentId: opponentRow?.userId || null };

}

function tttCanMove(message, state) {
    if (state.winner || state.draw) return false;
    if (state.turn === "X") return myRealUserId === message.sender_id;
    return myRealUserId !== message.sender_id && (!state.opponentId || state.opponentId === myRealUserId);
}

function buildTttHTML(message) {

    const state = tttState(message);
    const canMove = tttCanMove(message, state);
    const creator = gamePlayerName(message.sender_id);
    const opponentName = gameOpponentName(message, state.opponentId);
    const opponent = opponentName || "соперник";

    let status;
    if (state.winner) {
        const winnerId = state.winner === "X" ? message.sender_id : state.opponentId;
        status = winnerId === myRealUserId ? "Вы победили 🎉" : `Победил(а) ${escapeHTML(gamePlayerName(winnerId))} 🎉`;
    } else if (state.draw) {
        status = "Ничья 🤝";
    } else if (canMove) {
        status = "Ваш ход";
    } else {
        status = `Ход: ${escapeHTML(state.turn === "X" ? creator : opponent)}`;
    }

    const cells = state.board.map((mark, index) => {
        const win = state.line?.includes(index) ? " win" : "";
        const playable = !mark && canMove;
        return `<button type="button" class="ttt-cell${mark ? " " + mark.toLowerCase() : ""}${win}${playable ? " playable" : ""}" ${playable ? "" : "disabled"} onclick="tttMove(this.closest('.message-row').dataset.messageId, ${index})" aria-label="Клетка ${index + 1}">${mark === "X" ? "✕" : mark === "O" ? "◯" : ""}</button>`;
    }).join("");

    return `
        <div class="game-title">❌⭕ Крестики-нолики</div>
        <div class="game-sub">${escapeHTML(creator)} ✕ · ${opponentName ? escapeHTML(opponentName) : "ждём соперника"} ◯</div>
        <div class="ttt-board">${cells}</div>
        <div class="game-status">${status}</div>`;

}

async function tttMove(messageId, index) {

    const message = realMessagesById.get(messageId);
    if (!message?.attachment_meta?.game) return;

    const state = tttState(message);
    if (!tttCanMove(message, state) || state.board[index]) return;

    const mine = message.sender_id === myRealUserId ? state.xCells : state.oCells;
    const next = [...mine, index];
    await submitGameState(message, next.join(","));

}

/* ---- камень-ножницы-бумага ------------------------------------------------- */

function rpsState(message) {

    const rows = gameRows(message);
    const creatorRow = rows.find((r) => r.userId === message.sender_id);
    const opponentRow = gameOpponentRow(message, rows);
    // Ход пишется напрямую в базу — мусор вместо r/p/s не должен считаться выбором (и «побеждать»).
    const valid = (value) => (/^[rps]$/.test(value || "") ? value : "");
    const a = valid(creatorRow?.payload);
    const b = valid(opponentRow?.payload);

    let result = null; // "creator" | "opponent" | "draw"
    if (a && b) {
        if (a === b) result = "draw";
        else if ((a === "r" && b === "s") || (a === "s" && b === "p") || (a === "p" && b === "r")) result = "creator";
        else result = "opponent";
    }

    return { a, b, result, opponentId: opponentRow?.userId || null };

}

function rpsCanPick(message, state) {
    if (message.sender_id === myRealUserId) return !state.a;
    return !state.b && (!state.opponentId || state.opponentId === myRealUserId);
}

function buildRpsHTML(message) {

    const state = rpsState(message);
    const isCreator = message.sender_id === myRealUserId;
    const canPick = rpsCanPick(message, state);
    const creator = gamePlayerName(message.sender_id);
    const opponentName = gameOpponentName(message, state.opponentId);
    const opponent = opponentName || "соперник";

    let body;
    if (state.result) {
        const winnerName = state.result === "creator" ? creator : state.result === "opponent" ? opponent : null;
        body = `
            <div class="rps-reveal">
                <div class="rps-hand">${RPS_ICONS[state.a]}<small>${escapeHTML(creator)}</small></div>
                <div class="rps-vs">vs</div>
                <div class="rps-hand">${RPS_ICONS[state.b]}<small>${escapeHTML(opponent)}</small></div>
            </div>
            <div class="game-status">${winnerName ? (winnerName === "Вы" ? "Вы победили 🎉" : `Победил(а) ${escapeHTML(winnerName)} 🎉`) : "Ничья 🤝"}</div>`;
    } else {
        const mineChosen = isCreator ? state.a : (state.opponentId === myRealUserId ? state.b : "");
        const buttons = Object.keys(RPS_ICONS).map((key) =>
            `<button type="button" class="rps-btn" ${canPick ? "" : "disabled"} onclick="rpsPick(this.closest('.message-row').dataset.messageId, '${key}')" title="${RPS_NAMES[key]}">${RPS_ICONS[key]}</button>`).join("");
        body = `
            <div class="rps-choices">${buttons}</div>
            <div class="game-status">${mineChosen ? `Вы выбрали ${RPS_ICONS[mineChosen]} — ждём соперника…` : canPick ? "Сделайте выбор" : "Ждём выбора…"}</div>`;
    }

    return `
        <div class="game-title">✊✋✌️ Камень, ножницы, бумага</div>
        <div class="game-sub">${opponentName ? `${escapeHTML(creator)} против ${escapeHTML(opponentName)}` : `Играет ${escapeHTML(creator)} · ждём соперника`}</div>
        ${body}`;

}

async function rpsPick(messageId, choice) {
    const message = realMessagesById.get(messageId);
    if (!message?.attachment_meta?.game) return;
    if (!rpsCanPick(message, rpsState(message))) return;
    await submitGameState(message, choice);
}

/* ---- кубик ------------------------------------------------------------------ */

function buildDiceHTML(message) {

    const value = Math.min(6, Math.max(1, Number(message.attachment_meta.game.value) || 1));
    const fresh = Date.now() - new Date(message.created_at).getTime() < 6000;
    const pips = DICE_PIPS[value];
    const cells = Array.from({ length: 9 }, (_, i) => `<span class="${pips.includes(i) ? "pip" : ""}"></span>`).join("");

    return `
        <div class="dice-wrap" onclick="rollDiceAgain(this)" title="Нажмите, чтобы посмотреть бросок ещё раз">
            <div class="dice-face${fresh ? " rolling" : ""}" data-value="${value}" aria-label="Выпало ${value}">${cells}</div>
            <div class="dice-value">Выпало ${value}</div>
        </div>`;

}

function rollDiceAgain(wrap) {
    const face = wrap.querySelector(".dice-face");
    face.classList.remove("rolling");
    void face.offsetWidth;
    face.classList.add("rolling");
}

/* ---- общее ------------------------------------------------------------------ */

function buildGameHTML(message) {
    const kind = message.attachment_meta.game.kind;
    const inner = kind === "ttt" ? buildTttHTML(message)
        : kind === "rps" ? buildRpsHTML(message)
        : kind === "dice" ? buildDiceHTML(message)
        : `<div class="game-title">🎮 Игра</div>`;
    return `<div class="game-card game-${kind}">${inner}</div>`;
}

function updateGameRow(messageId) {
    const message = realMessagesById.get(messageId);
    const card = document.querySelector(`.message-row[data-message-id="${messageId}"] .game-card`);
    if (!message?.attachment_meta?.game || !card) return;
    const kind = message.attachment_meta.game.kind;
    if (kind === "dice") return; // у кубика нет состояния
    card.innerHTML = kind === "ttt" ? buildTttHTML(message) : buildRpsHTML(message);
}

// Оптимистично применяем свой ход, затем пишем в базу; при ошибке откатываем.
async function submitGameState(message, payload) {

    const before = message.reactions || [];
    message.reactions = before.filter((r) => r.user_id !== myRealUserId);
    message.reactions.push({ user_id: myRealUserId, emoji: "game:" + payload });
    updateGameRow(message.id);

    try {
        await KabanAPI.setGameState(message.id, payload);
    } catch (error) {
        message.reactions = before;
        updateGameRow(message.id);
        toast("Не удалось сделать ход: " + (error?.message || error));
    }

}

/* ---- запуск игры -------------------------------------------------------------- */

function openGamesModal() {

    closeAttachMenu();

    if (!currentChatId) { toast("Откройте чат, чтобы начать игру"); return; }
    if (currentChatIsSecret) { toast("В секретных чатах игры не поддерживаются"); return; }
    if (currentChatType === "group" && !groupMayAttach()) { toast("В этой группе вам нельзя отправлять такие сообщения"); return; }

    const backdrop = document.getElementById("games-backdrop");
    backdrop.classList.add("open");
    backdrop.setAttribute("aria-hidden", "false");

}

function closeGamesModal() {
    const backdrop = document.getElementById("games-backdrop");
    backdrop.classList.remove("open");
    backdrop.setAttribute("aria-hidden", "true");
}

async function startGame(kind) {

    closeGamesModal();

    const targetChatId = currentChatId;
    let game, text;

    if (kind === "ttt") {
        game = { kind: "ttt" };
        text = "❌⭕ Крестики-нолики — сыграем?";
    } else if (kind === "rps") {
        game = { kind: "rps" };
        text = "✊✋✌️ Камень, ножницы, бумага — сыграем?";
    } else {
        const value = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 6);
        game = { kind: "dice", value };
        text = `🎲 Кубик: выпало ${value}`;
    }

    let message;
    try {
        message = await KabanAPI.sendMessage(targetChatId, { type: "text", text, attachmentMeta: { game } });
    } catch (error) {
        toast("Не удалось начать игру: " + (error?.message || error));
        return;
    }

    realMessagesById.set(message.id, message);
    if (currentChatId === targetChatId) {
        appendRealMessageRow(message, true);
        updateMessageGrouping();
        if (appSettings.sendSound) playSendSound();
        if (appSettings.autoScroll) scrollMessagesToBottom();
    }
    patchCachedChatLastMessage(targetChatId, message);

}
