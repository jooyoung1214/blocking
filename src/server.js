'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const cron = require('node-cron');

const db = require('./db');
const boardLib = require('../public/shared/board');
const rules = require('../public/shared/rules');

const {
    BOARD_COLS,
    DEFAULT_BOARD_ROWS,
    MAX_BOARD_ROWS,
    MAX_CELLS
} = rules;

// ── 인메모리 상태 (DB에서 파생) ───────────────────────────────────────
const state = {
    season: null,
    boardRows: DEFAULT_BOARD_ROWS,
    blocks: [],          // status='placed' 인 블록들. 진실의 원천은 DB.
    board: [],           // blocks에서 재구성한 캐시
    archive: []          // 최근 제거된 블록들 (클라이언트 표시용)
};

function rebuildBoard() {
    state.board = boardLib.buildBoard(state.blocks, state.boardRows, BOARD_COLS);
}

function loadSeason(seasonId, boardRows) {
    state.season = seasonId;
    state.boardRows = boardRows;
    state.blocks = db.loadPlacedBlocks(seasonId);
    state.archive = db.loadClearedBlocks(seasonId, 200).map(toArchiveItem);
    rebuildBoard();
    console.log(
        `[Season ${seasonId}] blocks=${state.blocks.length} rows=${state.boardRows} archived=${state.archive.length}`
    );
}

function toArchiveItem(b) {
    return {
        id: b.id,
        color: b.color,
        shape: b.shape,
        nickname: b.nickname,
        message: b.message,
        clearedAt: b.clearedAt,
        createdAt: b.createdAt
    };
}

// 부팅 시점에도, cron 시점에도 같은 함수를 부른다.
// 시즌 번호가 YYYYMM이라 서버가 꺼져 있는 동안 달이 바뀌어도 복구된다.
function ensureCurrentSeason({ announce = false } = {}) {
    const seasonId = db.currentSeasonId();
    if (state.season === seasonId) return false;

    const season = db.ensureSeason(seasonId, DEFAULT_BOARD_ROWS);
    loadSeason(season.season, season.boardRows);

    if (announce) {
        io.emit('season_changed', {
            season: state.season,
            blocks: state.blocks.map(publicBlock),
            boardRows: state.boardRows,
            archive: state.archive,
            message: '새로운 시즌이 시작되어 보드가 초기화되었습니다!'
        });
    }
    return true;
}

// ── 부팅 순서 (기존의 크래시 원인이었던 지점) ─────────────────────────
// 스키마 생성 -> 시즌 확보 -> 상태 로드 -> 그 다음에야 listen.
const boot = db.init(DEFAULT_BOARD_ROWS);
loadSeason(boot.season, boot.boardRows);

// ── 앱 ────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        season: state.season,
        blocks: state.blocks.length,
        rows: state.boardRows
    });
});

app.get('/api/block/:id', (req, res) => {
    const block = db.getBlock(req.params.id);
    if (!block) return res.status(404).json({ error: 'not_found' });
    res.json(toArchiveItem(block));
});

app.get('/api/seasons', (req, res) => res.json(db.listSeasons()));

// ── 유저 상태 헬퍼 ────────────────────────────────────────────────────
function getUser(userId) {
    return db.getUserState(state.season, userId);
}

function remainingDrops(userId) {
    const u = getUser(userId);
    return (1 + u.extraDrops) - u.dropsUsed;
}

// ── 소켓 ──────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    const rawUserId = socket.handshake.auth && socket.handshake.auth.userId;
    if (typeof rawUserId !== 'string' || rawUserId.length === 0 || rawUserId.length > 100) {
        socket.emit('error_message', { code: 'NO_USER_ID' });
        socket.disconnect(true);
        return;
    }

    const userId = rawUserId;
    socket.data.userId = userId;

    const user = getUser(userId);
    socket.data.nickname = user.lastNickname || 'Anonymous';

    socket.emit('init_state', {
        season: state.season,
        blocks: state.blocks.map(publicBlock),
        boardRows: state.boardRows,
        cols: BOARD_COLS,
        maxCells: MAX_CELLS,
        colors: rules.COLORS,
        archive: state.archive,
        nickname: socket.data.nickname,
        remainingDrops: remainingDrops(userId),
        myBlockIds: db.getUserBlocks(state.season, userId).map(b => b.id)
    });

    socket.on('set_nickname', (name) => {
        const clean = rules.sanitizeNickname(name);
        if (!clean) return;
        socket.data.nickname = clean;
        const u = getUser(userId);
        u.lastNickname = clean;
        db.saveUserState(state.season, userId, u);
    });

    // 고스트 프리뷰는 클라이언트가 자체 계산하지만, 확정 직전에 서버 값과
    // 대조할 수 있도록 검증용 엔드포인트를 열어둔다. (Task 2에서 사용)
    socket.on('preview_landing', (payload, ack) => {
        if (typeof ack !== 'function') return;
        const norm = rules.normalizeShape(payload && payload.shape);
        if (!norm.ok) return ack({ ok: false, reason: norm.reason });

        const x = Number(payload.x);
        const width = boardLib.blockWidth(norm.shape);
        if (!Number.isInteger(x) || x < 0 || x + width > BOARD_COLS) {
            return ack({ ok: false, reason: 'OUT_OF_BOUNDS' });
        }

        const grid = boardLib.buildOccupancy(state.blocks, state.boardRows, BOARD_COLS);
        const y = boardLib.computeLandingY(grid, norm.shape, x, state.boardRows, BOARD_COLS);
        ack({ ok: true, x, y });
    });

    socket.on('drop_block', (payload) => {
        try {
            handleDrop(socket, userId, payload);
        } catch (err) {
            console.error('[drop_block]', err);
            socket.emit('error_message', { code: 'INTERNAL' });
        }
    });

    // 결제 기능은 아직 미완성이다. 구멍이 뚫린 채로 남겨두지 않기 위해
    // 경로 자체를 막아둔다. (Task: 결제 시스템에서 다시 구현)
    socket.on('request_payment', () => {
        socket.emit('error_message', { code: 'PAYMENT_DISABLED' });
    });

    socket.on('disconnect', () => {});
});

// ── 드롭 처리 (원자적) ────────────────────────────────────────────────
function handleDrop(socket, userId, payload) {
    ensureCurrentSeason({ announce: true });

    if (!payload || typeof payload !== 'object') {
        return socket.emit('error_message', { code: 'BAD_CELL' });
    }

    const norm = rules.normalizeShape(payload.shape);
    if (!norm.ok) {
        return socket.emit('error_message', { code: norm.reason, params: { max: MAX_CELLS } });
    }
    const shape = norm.shape;

    if (!rules.isValidColor(payload.color)) {
        return socket.emit('error_message', { code: 'INVALID_COLOR' });
    }

    const width = boardLib.blockWidth(shape);
    const x = Number(payload.x);
    if (!Number.isInteger(x) || x < 0 || x + width > BOARD_COLS) {
        return socket.emit('error_message', {
            code: 'OUT_OF_BOUNDS',
            params: { max: BOARD_COLS - width }
        });
    }

    if (remainingDrops(userId) <= 0) {
        return socket.emit('error_message', { code: 'NO_DROPS_LEFT' });
    }

    // 착지 위치를 서버가 확정한다. 경쟁 상태가 여기서 소멸한다.
    const grid = boardLib.buildOccupancy(state.blocks, state.boardRows, BOARD_COLS);
    const landingY = boardLib.computeLandingY(grid, shape, x, state.boardRows, BOARD_COLS);
    if (landingY === null) {
        return socket.emit('error_message', { code: 'CANT_PLACE' });
    }

    const now = Date.now();
    const block = {
        id: crypto.randomUUID(),
        season: state.season,
        userId,
        nickname: socket.data.nickname || 'Anonymous',
        color: payload.color,
        shape,
        message: rules.shapeToMessage(shape),
        x,
        y: landingY,
        status: 'placed',
        createdAt: now
    };

    db.insertBlock(block);
    state.blocks.push(block);

    const user = getUser(userId);
    user.dropsUsed += 1;
    user.lastNickname = block.nickname;
    db.saveUserState(state.season, userId, user);

    // 제거 -> 강체 중력 -> 재검사 (cascade)
    const result = boardLib.settle(state.blocks, state.boardRows, BOARD_COLS);

    if (result.clearedBlocks.length > 0) {
        db.clearBlocks(result.clearedBlocks.map(b => b.id), now);
        const items = result.clearedBlocks.map(b =>
            toArchiveItem(Object.assign({}, b, { clearedAt: now }))
        );
        state.archive = items.concat(state.archive).slice(0, 200);
    }
    if (result.movedBlocks.length > 0) {
        db.persistPositions(result.movedBlocks);
    }

    // 상단 여유 확보
    const expand = boardLib.expandIfNeeded(state.blocks, state.boardRows, BOARD_COLS, {
        headroom: 12,
        addRows: 20,
        maxRows: MAX_BOARD_ROWS
    });
    if (expand.added > 0) {
        state.boardRows = expand.rows;
        db.setBoardRows(state.season, state.boardRows);
        db.persistPositions(state.blocks);
    }

    rebuildBoard();

    socket.emit('drop_success', {
        blockId: block.id,
        remainingDrops: remainingDrops(userId)
    });

    io.emit('block_landed', {
        block: publicBlock(block),
        fromY: -boardLib.blockHeight(shape),
        clearedBlockIds: result.clearedBlocks.map(b => b.id),
        fullRows: result.fullRows,
        movedBlocks: result.movedBlocks.map(b => ({ id: b.id, y: b.y })),
        archive: state.archive,
        boardRows: state.boardRows,
        rowsAdded: expand.added
    });

    io.emit('toast_message', {
        code: 'BLOCK_LANDED',
        params: { nickname: block.nickname, row: block.y }
    });

    if (result.clearedBlocks.length > 0) {
        const names = Array.from(new Set(result.clearedBlocks.map(b => b.nickname)));
        io.emit('toast_message', {
            code: 'ROWS_CLEARED',
            params: { rows: result.fullRows.length, people: names.length }
        });
    }
}

function publicBlock(b) {
    return {
        id: b.id,
        nickname: b.nickname,
        color: b.color,
        shape: b.shape,
        message: b.message,
        x: b.x,
        y: b.y,
        createdAt: b.createdAt
    };
}

// ── 시즌 롤오버 ───────────────────────────────────────────────────────
cron.schedule('0 0 1 * *', () => ensureCurrentSeason({ announce: true }), {
    timezone: 'Asia/Seoul'
});
// cron이 발동하지 않는 경우(프로세스 재시작 등)를 대비한 보정
setInterval(() => ensureCurrentSeason({ announce: true }), 60 * 1000);

// ── 종료 처리 ─────────────────────────────────────────────────────────
function shutdown(signal) {
    console.log(`[${signal}] shutting down...`);
    io.close();
    server.close(() => {
        db.close();
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── 기동 ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    server.listen(PORT, () => {
        console.log(`🚀 droptalk on :${PORT} (season ${state.season})`);
    });
}

module.exports = { app, server, io, state, handleDrop };
