const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const dbFile = path.join(__dirname, 'tetris.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('[DB Error] Failed to connect to SQLite', err);
    } else {
        console.log('[DB Connected] SQLite database ready.');
        initDatabase();
    }
});

function initDatabase() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT
        )`);

        db.get(`SELECT value FROM kv_store WHERE key = 'board_rows'`, (err, row) => {
            if (!row) {
                db.run(`INSERT INTO kv_store (key, value) VALUES ('board_rows', '100')`);
                const initialBoard = JSON.stringify(Array.from({ length: 100 }, () => Array(50).fill(null)));
                db.run(`INSERT INTO kv_store (key, value) VALUES ('board', ?)`, [initialBoard]);
                db.run(`INSERT INTO kv_store (key, value) VALUES ('harvested_messages', '[]')`);
                db.run(`INSERT INTO kv_store (key, value) VALUES ('falling_blocks', '[]')`);
                db.run(`INSERT INTO kv_store (key, value) VALUES ('active_block_meta', '{}')`);
                db.run(`INSERT INTO kv_store (key, value) VALUES ('user_drop_state', '{}')`);
            }
        });

        // 기존 DB에 user_drop_state 키가 없는 경우(마이그레이션) 대비
        db.get(`SELECT value FROM kv_store WHERE key = 'user_drop_state'`, (err, row) => {
            if (!row) {
                db.run(`INSERT INTO kv_store (key, value) VALUES ('user_drop_state', '{}')`);
            }
        });
    });
}

const LEMONSQUEEZY_API_KEY = 'YOUR_LEMON_SQUEEZY_API_KEY';
const STORE_ID = 'YOUR_STORE_ID';
const VARIANT_ID_EXTRA_DROP = 'YOUR_VARIANT_ID_FOR_EXTRA_DROP';
const VARIANT_ID_EXPAND_CELLS = 'YOUR_VARIANT_ID_FOR_CELLS';

// 클라이언트(index.html)의 colorPicker 옵션과 반드시 동일하게 유지
const ALLOWED_COLORS = [
    '#ff4757', '#ff6b81', '#ffa502', '#eccc68', '#66fcf1',
    '#1e90ff', '#3742fa', '#9c88ff', '#e056fd', '#ffffff'
];

const MAX_NICKNAME_LEN = 15;
const MAX_FREE_CELLS = 10;
const MAX_TOTAL_CELLS = 20;

function isConnected(shape) {
    if (!shape || shape.length <= 1) return true;
    const visited = new Set();
    const queue = [shape[0]];
    visited.add(0);
    let connectedCount = 1;

    while (queue.length > 0) {
        const current = queue.shift();
        for (let i = 0; i < shape.length; i++) {
            if (!visited.has(i)) {
                const neighbor = shape[i];
                const dist = Math.abs(current.dx - neighbor.dx) + Math.abs(current.dy - neighbor.dy);
                if (dist === 1) {
                    visited.add(i);
                    queue.push(neighbor);
                    connectedCount++;
                }
            }
        }
    }
    return connectedCount === shape.length;
}

// 셀 텍스트: 영문/숫자 1글자만 허용, 나머지는 제거
function sanitizeCellText(text) {
    if (typeof text !== 'string') return '';
    const match = text.trim().slice(0, 1).match(/[A-Za-z0-9]/);
    return match ? match[0].toUpperCase() : '';
}

// 클라이언트가 보낸 shape를 검증하고, dx/dy를 0 기준으로 재정규화한 안전한 shape를 반환.
// 유효하지 않으면 null을 반환.
function normalizeAndValidateShape(rawShape) {
    if (!Array.isArray(rawShape) || rawShape.length === 0 || rawShape.length > MAX_TOTAL_CELLS) {
        return null;
    }

    const cleaned = [];
    for (const cell of rawShape) {
        if (!cell || typeof cell !== 'object') return null;
        const dx = Number(cell.dx);
        const dy = Number(cell.dy);
        if (!Number.isInteger(dx) || !Number.isInteger(dy)) return null;
        if (Math.abs(dx) > 50 || Math.abs(dy) > 50) return null; // 비정상적으로 큰 좌표 방지
        cleaned.push({ dx, dy, text: sanitizeCellText(cell.text) });
    }

    const minDx = Math.min(...cleaned.map(c => c.dx));
    const minDy = Math.min(...cleaned.map(c => c.dy));

    // 중복 좌표(같은 dx,dy가 두 번 등장) 방지
    const seen = new Set();
    const normalized = [];
    for (const c of cleaned) {
        const nx = c.dx - minDx;
        const ny = c.dy - minDy;
        const key = `${nx},${ny}`;
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({ dx: nx, dy: ny, text: c.text });
    }

    return normalized;
}

function sanitizeNickname(name) {
    if (typeof name !== 'string') return null;
    // 제어문자 제거 후 트림 및 길이 제한
    const clean = name.replace(/[\u0000-\u001F\u007F]/g, '').trim().substring(0, MAX_NICKNAME_LEN);
    return clean.length > 0 ? clean : null;
}

app.post('/webhook', express.json(), (req, res) => {
    const event = req.body;
    if (event && event.meta && event.meta.event_name === 'order_created') {
        const customData = event.data.attributes.custom_data;
        const socketId = customData ? customData.socketId : null;
        const userId = customData ? customData.userId : null;
        const type = customData ? customData.type : null;
        const extraCells = customData ? parseInt(customData.extraCells) : 0;

        // 결제 성공 시, 실제로 드롭 기회를 늘려주는 핵심 상태 변경은
        // socket 연결 여부와 무관하게 userId 기준으로 영구 반영한다.
        if (type === 'extra_drop' && userId) {
            const state = getUserState(userId);
            state.extraDrops += 1;
            saveStateToDB();
        }

        // 접속 중인 소켓이 있다면 즉시 UI 갱신 알림도 함께 보낸다.
        if (socketId) {
            const targetSocket = io.sockets.sockets.get(socketId);
            if (targetSocket) {
                if (type === 'extra_drop') {
                    targetSocket.emit('payment_success', { type: 'extra_drop', message: '결제가 완료되었습니다! 추가 드롭 기회가 충전되었습니다.' });
                } else if (type === 'expand_cells') {
                    targetSocket.emit('payment_success', { type: 'expand_cells', extraCells: extraCells, message: `${extraCells}칸 확장 결제가 완료되었습니다!` });
                }
            }
        }
    }
    res.json({ received: true });
});

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

const BOARD_COLS = 50;

let BOARD_ROWS = 100;
let board = [];
let harvestedMessages = [];
let fallingBlocks = [];
let activeBlockMeta = new Map();

// userId -> { dropsUsed: number, extraDrops: number }
// 소켓 재연결/새로고침과 무관하게 "1인 1회" 규칙을 유지하기 위한 영구 상태.
let userDropState = new Map();

function getUserState(userId) {
    if (!userDropState.has(userId)) {
        userDropState.set(userId, { dropsUsed: 0, extraDrops: 0 });
    }
    return userDropState.get(userId);
}

function hasDroppedAllowance(userId) {
    const state = getUserState(userId);
    return state.dropsUsed >= (1 + state.extraDrops);
}

function loadStateFromDB(callback) {
    db.all(`SELECT key, value FROM kv_store`, (err, rows) => {
        if (err) {
            console.error('[DB Read Error]', err);
            if (callback) callback();
            return;
        }
        rows.forEach(row => {
            if (row.key === 'board_rows') BOARD_ROWS = parseInt(row.value);
            if (row.key === 'board') board = JSON.parse(row.value);
            if (row.key === 'harvested_messages') harvestedMessages = JSON.parse(row.value);
            if (row.key === 'falling_blocks') fallingBlocks = JSON.parse(row.value);
            if (row.key === 'active_block_meta') {
                const obj = JSON.parse(row.value);
                activeBlockMeta = new Map(Object.entries(obj));
            }
            if (row.key === 'user_drop_state') {
                const obj = JSON.parse(row.value);
                userDropState = new Map(Object.entries(obj));
            }
        });
        if (callback) callback();
    });
}

function saveStateToDB() {
    const metaObj = Object.fromEntries(activeBlockMeta);
    const userStateObj = Object.fromEntries(userDropState);
    db.serialize(() => {
        db.run(`UPDATE kv_store SET value = ? WHERE key = 'board_rows'`, [BOARD_ROWS.toString()]);
        db.run(`UPDATE kv_store SET value = ? WHERE key = 'board'`, [JSON.stringify(board)]);
        db.run(`UPDATE kv_store SET value = ? WHERE key = 'harvested_messages'`, [JSON.stringify(harvestedMessages)]);
        db.run(`UPDATE kv_store SET value = ? WHERE key = 'falling_blocks'`, [JSON.stringify(fallingBlocks)]);
        db.run(`UPDATE kv_store SET value = ? WHERE key = 'active_block_meta'`, [JSON.stringify(metaObj)]);
        db.run(`UPDATE kv_store SET value = ? WHERE key = 'user_drop_state'`, [JSON.stringify(userStateObj)]);
    });
}

loadStateFromDB(() => {
    cron.schedule('0 0 1 * *', () => {
        console.log('[🔄 Monthly Reset] New season started!');
        BOARD_ROWS = 100;
        board = Array.from({ length: BOARD_ROWS }, () => Array(BOARD_COLS).fill(null));
        harvestedMessages = [];
        fallingBlocks = [];
        activeBlockMeta.clear();
        userDropState.clear();
        saveStateToDB();

        io.emit('monthly_reset', {
            board,
            fallingBlocks,
            harvestedMessages,
            boardRows: BOARD_ROWS,
            message: '새로운 달이 시작되어 보드와 아카이브가 초기화되었습니다!'
        });
    }, { timezone: "Asia/Seoul" });

    io.on('connection', (socket) => {
        // 유저 식별: 클라이언트가 localStorage에 저장해둔 영구 토큰을 auth로 전달.
        // 이 값이 없으면 "1인 1회" 규칙을 지킬 수 없으므로 연결을 거부한다.
        const rawUserId = socket.handshake.auth && socket.handshake.auth.userId;
        if (typeof rawUserId !== 'string' || rawUserId.length === 0 || rawUserId.length > 100) {
            socket.emit('error_message', '유저 식별에 실패했습니다. 페이지를 새로고침 해주세요.');
            socket.disconnect(true);
            return;
        }

        const userId = rawUserId;
        socket.data.userId = userId;
        socket.data.nickname = 'Anonymous';

        console.log(`[🟢 Connected] Socket: ${socket.id} / User: ${userId}`);

        socket.emit('init_state', {
            board,
            fallingBlocks,
            harvestedMessages,
            boardRows: BOARD_ROWS,
            hasDropped: hasDroppedAllowance(userId)
        });

        socket.on('set_nickname', (name) => {
            const clean = sanitizeNickname(name);
            if (clean) socket.data.nickname = clean;
        });

        socket.on('request_payment', async (paymentData) => {
            try {
                if (!paymentData || typeof paymentData.type !== 'string') {
                    socket.emit('error_message', '유효하지 않은 결제 요청입니다.');
                    return;
                }

                let variantId = '';
                let customPrice = null;
                const extraCells = Number.isInteger(paymentData.extraCells) ? paymentData.extraCells : 0;

                if (paymentData.type === 'extra_drop') {
                    variantId = VARIANT_ID_EXTRA_DROP;
                } else if (paymentData.type === 'expand_cells') {
                    variantId = VARIANT_ID_EXPAND_CELLS;
                    customPrice = extraCells * 100;
                } else {
                    socket.emit('error_message', '알 수 없는 결제 유형입니다.');
                    return;
                }

                if (LEMONSQUEEZY_API_KEY.includes('YOUR_LEMON_SQUEEZY')) {
                    // 실제 키가 설정되지 않은 개발 환경: 모의 결제 처리
                    if (paymentData.type === 'extra_drop') {
                        const state = getUserState(userId);
                        state.extraDrops += 1;
                        saveStateToDB();
                        socket.emit('payment_success', { type: 'extra_drop', message: '모의 결제 완료: 추가 드롭 기회가 충전되었습니다.' });
                    } else {
                        socket.emit('payment_success', { type: 'expand_cells', extraCells, message: `모의 결제 완료: ${extraCells}칸 확장되었습니다!` });
                    }
                    return;
                }

                const response = await fetch('https://api.lemonsqueezy.com/v1/checkouts', {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/vnd.api+json',
                        'Content-Type': 'application/vnd.api+json',
                        'Authorization': `Bearer ${LEMONSQUEEZY_API_KEY}`
                    },
                    body: JSON.stringify({
                        data: {
                            type: 'checkouts',
                            attributes: {
                                checkout_data: {
                                    custom: { socketId: socket.id, userId, type: paymentData.type, extraCells },
                                    ...(customPrice ? { prices: [customPrice] } : {})
                                },
                                product_options: { redirect_url: `${process.env.PUBLIC_URL || 'http://localhost:3000'}/?payment=success` }
                            },
                            relationships: {
                                store: { data: { type: 'stores', id: STORE_ID } },
                                variant: { data: { type: 'variants', id: variantId } }
                            }
                        }
                    })
                });

                const result = await response.json();
                if (result && result.data && result.data.attributes && result.data.attributes.url) {
                    socket.emit('redirect_to_checkout', { url: result.data.attributes.url });
                } else {
                    throw new Error('Invalid response from Lemon Squeezy');
                }
            } catch (error) {
                console.error('[Lemon Squeezy Error]', error);
                socket.emit('error_message', '결제 세션 생성 중 오류가 발생했습니다.');
            }
        });

        socket.on('drop_block', (blockData) => {
            if (!blockData) {
                socket.emit('error_message', '유효하지 않은 블록 데이터입니다.');
                return;
            }

            const normalizedShape = normalizeAndValidateShape(blockData.shape);
            if (!normalizedShape) {
                socket.emit('error_message', '블록 모양이 유효하지 않습니다.');
                return;
            }

            if (!isConnected(normalizedShape)) {
                socket.emit('error_message', '블록이 끊어져 있습니다! 상하좌우로 연결되어야 합니다.');
                return;
            }

            const cellCount = normalizedShape.length;
            if (cellCount > MAX_TOTAL_CELLS) {
                socket.emit('error_message', `블록은 최대 ${MAX_TOTAL_CELLS}칸까지만 생성할 수 있습니다.`);
                return;
            }
            if (cellCount > MAX_FREE_CELLS && !blockData.isPaidExpansion) {
                socket.emit('error_message', `${MAX_FREE_CELLS}칸을 초과하는 블록은 추가 결제($1/칸)가 필요합니다!`);
                return;
            }

            if (typeof blockData.color !== 'string' || !ALLOWED_COLORS.includes(blockData.color)) {
                socket.emit('error_message', '유효하지 않은 색상입니다.');
                return;
            }

            const maxDx = Math.max(...normalizedShape.map(cell => cell.dx));
            const startX = Number.isInteger(blockData.startX) ? blockData.startX : parseInt(blockData.startX, 10);
            if (!Number.isInteger(startX) || startX < 0 || startX + maxDx >= BOARD_COLS) {
                const maxStart = BOARD_COLS - 1 - maxDx;
                socket.emit('error_message', `드롭 위치가 보드를 벗어납니다. (0~${maxStart} 사이로 선택해주세요)`);
                return;
            }

            if (hasDroppedAllowance(userId)) {
                socket.emit('error_message', '기본 드롭 기회를 모두 사용했습니다. $10를 결제하여 추가 기회를 얻으세요!');
                return;
            }

            const blockId = Math.random().toString(36).substring(2, 9);
            const newBlock = {
                id: blockId,
                startX,
                y: 0,
                color: blockData.color,
                shape: normalizedShape
            };

            activeBlockMeta.set(blockId, {
                color: blockData.color,
                shape: normalizedShape,
                nickname: socket.data.nickname
            });

            fallingBlocks.push(newBlock);

            const state = getUserState(userId);
            state.dropsUsed += 1;

            socket.emit('drop_success', { hasDropped: hasDroppedAllowance(userId) });

            io.emit('new_block_spawned', newBlock);
            io.emit('toast_message', { text: `🚀 [${socket.data.nickname}]님이 블록을 드롭했습니다!` });
            saveStateToDB();
        });

        socket.on('disconnect', () => {
            console.log(`[🔴 Disconnected] Socket: ${socket.id} / User: ${userId}`);
        });
    });

    function expandBoardTop() {
        const addRows = 20;
        const newRows = Array.from({ length: addRows }, () => Array(BOARD_COLS).fill(null));
        board = newRows.concat(board);
        BOARD_ROWS += addRows;
        fallingBlocks.forEach(fb => { fb.y += addRows; });
    }

    function checkAndClearLines() {
        let clearedBlockIds = new Set();
        let harvesters = new Set();

        for (let r = 0; r < BOARD_ROWS; r++) {
            let rowCells = board[r];
            if (rowCells.some(cell => cell === null)) continue;

            let firstColor = rowCells[0].color;
            let isAllSameColor = rowCells.every(cell => cell.color === firstColor);

            if (isAllSameColor) {
                for (let c = 0; c < BOARD_COLS; c++) {
                    if (rowCells[c] && rowCells[c].blockId) {
                        clearedBlockIds.add(rowCells[c].blockId);
                    }
                }
            }
        }

        if (clearedBlockIds.size > 0) {
            clearedBlockIds.forEach(bId => {
                const meta = activeBlockMeta.get(bId);
                if (meta) {
                    harvestedMessages.unshift({
                        id: Math.random().toString(36).substring(2, 9),
                        color: meta.color,
                        shape: meta.shape,
                        timestamp: new Date().toLocaleTimeString()
                    });
                    if (meta.nickname) harvesters.add(meta.nickname);
                    activeBlockMeta.delete(bId);
                }

                for (let r = 0; r < BOARD_ROWS; r++) {
                    for (let c = 0; c < BOARD_COLS; c++) {
                        if (board[r][c] && board[r][c].blockId === bId) {
                            board[r][c] = null;
                        }
                    }
                }
            });

            const harvesterNames = Array.from(harvesters).join(', ');
            if (harvesterNames) {
                io.emit('toast_message', { text: `✨ [${harvesterNames}]님의 블록 라인이 완성되어 데이터가 수확되었습니다!` });
            } else {
                io.emit('toast_message', { text: `✨ 블록 라인이 완성되어 데이터가 수확되었습니다!` });
            }

            applyGravity();
        }
    }

    function applyGravity() {
        for (let c = 0; c < BOARD_COLS; c++) {
            let writeRow = BOARD_ROWS - 1;
            for (let r = BOARD_ROWS - 1; r >= 0; r--) {
                if (board[r][c] !== null) {
                    let temp = board[r][c];
                    board[r][c] = null;
                    board[writeRow][c] = temp;
                    writeRow--;
                }
            }
            for (let r = writeRow; r >= 0; r--) {
                board[r][c] = null;
            }
        }
    }

    function serverTickLoop() {
        let needExpand = false;
        for (let c = 0; c < BOARD_COLS; c++) {
            for (let r = 0; r < 10; r++) {
                if (board[r][c] !== null) {
                    needExpand = true;
                    break;
                }
            }
            if (needExpand) break;
        }

        if (needExpand) expandBoardTop();

        let stateChanged = false;
        for (let i = fallingBlocks.length - 1; i >= 0; i--) {
            let fb = fallingBlocks[i];
            let nextY = fb.y + 1;
            let hasCollided = false;

            for (let cell of fb.shape) {
                let cx = fb.startX + cell.dx;
                let targetRow = nextY + cell.dy;

                if (cx < 0 || cx >= BOARD_COLS) {
                    hasCollided = true;
                    break;
                }
                if (targetRow >= BOARD_ROWS || (targetRow >= 0 && board[targetRow] && board[targetRow][cx] !== null)) {
                    hasCollided = true;
                    break;
                }
            }

            if (hasCollided) {
                fb.shape.forEach(cell => {
                    let cx = fb.startX + cell.dx;
                    let cy = fb.y + cell.dy;
                    if (cy >= 0 && cy < BOARD_ROWS && cx >= 0 && cx < BOARD_COLS) {
                        board[cy][cx] = { blockId: fb.id, color: fb.color, text: cell.text };
                    }
                });

                fallingBlocks.splice(i, 1);
                checkAndClearLines();
                stateChanged = true;

                io.emit('board_updated', { board, fallingBlocks, harvestedMessages, boardRows: BOARD_ROWS });
            } else {
                fb.y = nextY;
            }
        }

        if (stateChanged) {
            saveStateToDB();
        }

        if (fallingBlocks.length > 0) {
            io.emit('update_falling_blocks', { fallingBlocks, boardRows: BOARD_ROWS });
        }
    }

    setInterval(serverTickLoop, 100);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`🚀 Global Tetris server is running on port ${PORT}`);
    });
});