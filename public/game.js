// ── 유저 식별: 새로고침/재접속에도 유지되는 영구 토큰 ──────────────────
function getOrCreateUserId() {
    const KEY = 'droptalk_user_id';
    let id = localStorage.getItem(KEY);
    if (!id) {
        id = (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
        localStorage.setItem(KEY, id);
    }
    return id;
}

const USER_ID = getOrCreateUserId();
const socket = io({ auth: { userId: USER_ID } });

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('board-container');

const COLS = 50;
let ROWS = 100;
const CELL_SIZE = 15;
canvas.width = COLS * CELL_SIZE;
canvas.height = ROWS * CELL_SIZE;

let board = [];
let fallingBlocks = [];
let harvestedMessages = [];
let isUserScrolling = false;
let initialScrolled = false;
let isPaidExpansionVerified = false;

// ── 렌더링 최적화: 상태가 실제로 바뀌었을 때만 다시 그림 ──────────────
let renderDirty = true;
function markDirty() { renderDirty = true; }

// 토스트 메시지 생성 함수
function showToast(text) {
    const containerEl = document.getElementById('toast-container');
    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.innerText = text;
    containerEl.appendChild(toastEl);

    setTimeout(() => {
        toastEl.remove();
    }, 3000);
}

socket.on('toast_message', (data) => {
    showToast(data.text);
});

socket.on('connect_error', (err) => {
    console.error('Connection error:', err.message);
});

// 닉네임 입력 이벤트 바인딩
const nicknameInput = document.getElementById('nicknameInput');
nicknameInput.addEventListener('input', (e) => {
    socket.emit('set_nickname', e.target.value);
});

container.addEventListener('scroll', () => {
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    isUserScrolling = !isAtBottom;
    markDirty();
});

window.addEventListener('resize', markDirty);

const editorContainer = document.getElementById('shape-editor');
const EDITOR_COLS = 5;
const EDITOR_ROWS = 4;
let editorGrid = Array.from({ length: EDITOR_ROWS }, () => Array(EDITOR_COLS).fill(false));
let editorTexts = Array.from({ length: EDITOR_ROWS }, () => Array(EDITOR_COLS).fill(''));

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

function getActiveCellCount() {
    let count = 0;
    for (let r = 0; r < EDITOR_ROWS; r++) {
        for (let c = 0; c < EDITOR_COLS; c++) {
            if (editorGrid[r][c]) count++;
        }
    }
    return count;
}

// 서버와 동일한 규칙(영문/숫자 1글자, 대문자화)으로 정제
function sanitizeCellTextInput(raw) {
    const match = String(raw).slice(0, 1).match(/[A-Za-z0-9]/);
    return match ? match[0].toUpperCase() : '';
}

function renderEditor() {
    editorContainer.innerHTML = '';
    for (let r = 0; r < EDITOR_ROWS; r++) {
        for (let c = 0; c < EDITOR_COLS; c++) {
            const cellDiv = document.createElement('div');
            cellDiv.className = `editor-cell ${editorGrid[r][c] ? 'active' : ''}`;

            if (editorGrid[r][c]) {
                const textInput = document.createElement('input');
                textInput.maxLength = 1;
                textInput.value = editorTexts[r][c];
                textInput.addEventListener('input', (e) => {
                    const cleaned = sanitizeCellTextInput(e.target.value);
                    e.target.value = cleaned;
                    editorTexts[r][c] = cleaned;
                });
                cellDiv.appendChild(textInput);
            }

            cellDiv.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                editorGrid[r][c] = !editorGrid[r][c];
                if (!editorGrid[r][c]) editorTexts[r][c] = '';
                isPaidExpansionVerified = false;
                renderEditor();
            });
            editorContainer.appendChild(cellDiv);
        }
    }
    const count = getActiveCellCount();
    const infoEl = document.getElementById('cell-count-info');
    if (count > 10) {
        infoEl.innerHTML = `Selected: <span style="color:#ff4757; font-weight:bold;">${count} cells (Exceeds 10! Requires $${count - 10})</span>`;
    } else {
        infoEl.innerText = `Selected: ${count} cells (Free limit: 10)`;
    }
}
renderEditor();

function renderArchive() {
    const archiveEl = document.getElementById('message-archive');
    if (harvestedMessages.length === 0) {
        archiveEl.innerHTML = `<div style="color: #45a29e; font-size: 13px; text-align: center; padding: 20px; font-weight: 600;">Complete rows with matching colors to extract block data!</div>`;
        return;
    }
    archiveEl.innerHTML = '';
    harvestedMessages.forEach(item => {
        const card = document.createElement('div');
        card.className = 'harvested-card';
        card.style.borderLeftColor = item.color;

        const header = document.createElement('div');
        header.className = 'harvested-header';
        header.innerHTML = `<span>Extracted Data</span><span>${item.timestamp}</span>`;
        card.appendChild(header);

        let maxDx = 0, maxDy = 0;
        item.shape.forEach(cell => {
            if (cell.dx > maxDx) maxDx = cell.dx;
            if (cell.dy > maxDy) maxDy = cell.dy;
        });

        const miniCanvas = document.createElement('canvas');
        const miniSize = 14;
        miniCanvas.width = (maxDx + 1) * miniSize;
        miniCanvas.height = (maxDy + 1) * miniSize;
        miniCanvas.className = 'harvested-canvas';

        const mCtx = miniCanvas.getContext('2d');
        item.shape.forEach(cell => {
            let x = cell.dx * miniSize;
            let y = cell.dy * miniSize;
            mCtx.fillStyle = item.color;
            mCtx.fillRect(x, y, miniSize, miniSize);

            mCtx.fillStyle = 'rgba(255,255,255,0.1)';
            mCtx.fillRect(x, y, miniSize, miniSize / 2);

            if (cell.text) {
                mCtx.fillStyle = '#000000';
                mCtx.font = 'bold 10px Poppins';
                mCtx.textAlign = 'center';
                mCtx.textBaseline = 'middle';
                mCtx.fillText(cell.text, x + miniSize / 2, y + miniSize / 2 + 1);
            }
            mCtx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            mCtx.strokeRect(x, y, miniSize, miniSize);
        });
        card.appendChild(miniCanvas);
        archiveEl.appendChild(card);
    });
}

socket.on('init_state', (data) => {
    board = data.board;
    ROWS = data.boardRows;
    canvas.height = ROWS * CELL_SIZE;
    fallingBlocks = data.fallingBlocks;
    harvestedMessages = data.harvestedMessages || [];
    renderArchive();
    if (data.hasDropped) {
        lockDropButtonForExtraPay();
    } else {
        unlockDropButton();
    }
    if (!initialScrolled) {
        container.scrollTop = container.scrollHeight;
        initialScrolled = true;
    }
    socket.emit('set_nickname', nicknameInput.value);
    markDirty();
});

socket.on('monthly_reset', (data) => {
    alert(data.message);
    board = data.board;
    ROWS = data.boardRows;
    canvas.height = ROWS * CELL_SIZE;
    fallingBlocks = data.fallingBlocks;
    harvestedMessages = data.harvestedMessages || [];
    unlockDropButton();
    isPaidExpansionVerified = false;
    renderArchive();
    container.scrollTop = container.scrollHeight;
    markDirty();
});

socket.on('drop_success', (data) => {
    if (data.hasDropped) {
        lockDropButtonForExtraPay();
    } else {
        unlockDropButton();
    }
    isPaidExpansionVerified = false;
});

socket.on('redirect_to_checkout', (data) => {
    window.location.href = data.url;
});

socket.on('payment_success', (data) => {
    alert(data.message);
    if (data.type === 'extra_drop') {
        unlockDropButton();
    } else if (data.type === 'expand_cells') {
        isPaidExpansionVerified = true;
        triggerDropAction();
    }
});

socket.on('error_message', (msg) => { alert(msg); });

socket.on('new_block_spawned', (block) => {
    fallingBlocks.push(block);
    markDirty();
});

socket.on('update_falling_blocks', (data) => {
    fallingBlocks = data.fallingBlocks;
    if (ROWS !== data.boardRows) {
        ROWS = data.boardRows;
        canvas.height = ROWS * CELL_SIZE;
    }
    if (!isUserScrolling) container.scrollTop = container.scrollHeight;
    markDirty();
});

socket.on('board_updated', (data) => {
    board = data.board;
    ROWS = data.boardRows;
    canvas.height = ROWS * CELL_SIZE;
    fallingBlocks = data.fallingBlocks;
    harvestedMessages = data.harvestedMessages || [];
    renderArchive();
    if (!isUserScrolling) container.scrollTop = container.scrollHeight;
    markDirty();
});

function lockDropButtonForExtraPay() {
    const btn = document.getElementById('dropBtn');
    btn.disabled = true;
    btn.innerText = "Payload Limit Reached";
    document.getElementById('extraDropBtn').style.display = 'block';
}

function unlockDropButton() {
    const btn = document.getElementById('dropBtn');
    btn.disabled = false;
    btn.innerText = "Drop Payload";
    document.getElementById('extraDropBtn').style.display = 'none';
}

function drawCell(ctx, x, y, size, color, text) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, size, size);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(x, y, size, size / 2);

    if (text) {
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 11px Poppins';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + size / 2, y + size / 2 + 1);
    }

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.strokeRect(x, y, size, size);
}

// ── 뷰포트 기반 부분 렌더링 ──────────────────────────────────────────
// 보드가 세로로 무한정 늘어나므로, 매 프레임 전체 보드를 다시 그리지 않고
// 현재 스크롤 위치에서 실제로 보이는 행(+버퍼)만 그린다.
// 또한 상태가 바뀌지 않았으면(renderDirty === false) 아예 다시 그리지 않는다.
function drawFrame() {
    const bufferRows = 4;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    const startRow = Math.max(0, Math.floor(viewTop / CELL_SIZE) - bufferRows);
    const endRow = Math.min(ROWS, Math.ceil(viewBottom / CELL_SIZE) + bufferRows);

    const clearY = startRow * CELL_SIZE;
    const clearHeight = (endRow - startRow) * CELL_SIZE;

    if (clearHeight <= 0) return;

    ctx.fillStyle = '#12141a';
    ctx.fillRect(0, clearY, canvas.width, clearHeight);

    ctx.strokeStyle = '#1f2833';
    ctx.lineWidth = 1;
    for (let c = 0; c <= COLS; c++) {
        ctx.beginPath();
        ctx.moveTo(c * CELL_SIZE, clearY);
        ctx.lineTo(c * CELL_SIZE, clearY + clearHeight);
        ctx.stroke();
    }
    for (let r = startRow; r <= endRow; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * CELL_SIZE);
        ctx.lineTo(canvas.width, r * CELL_SIZE);
        ctx.stroke();
    }

    for (let r = startRow; r < endRow; r++) {
        if (!board[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (board[r][c] !== null) {
                drawCell(ctx, c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, board[r][c].color, board[r][c].text);
            }
        }
    }

    fallingBlocks.forEach(fb => {
        fb.shape.forEach(cell => {
            const cellRow = fb.y + cell.dy;
            if (cellRow < startRow || cellRow >= endRow) return;
            const x = (fb.startX + cell.dx) * CELL_SIZE;
            const y = cellRow * CELL_SIZE;
            drawCell(ctx, x, y, CELL_SIZE, fb.color, cell.text);
        });
    });
}

function render() {
    // 낙하 중인 블록이 있으면 계속 다시 그려야 하고(서버 tick마다 위치가 바뀜),
    // 그 외에는 상태가 실제로 바뀐 프레임에만 그린다.
    if (renderDirty || fallingBlocks.length > 0) {
        renderDirty = false;
        drawFrame();
    }
    requestAnimationFrame(render);
}
render();

function buildShapeFromEditor() {
    let shape = [];
    let minX = EDITOR_COLS, minY = EDITOR_ROWS;

    for (let r = 0; r < EDITOR_ROWS; r++) {
        for (let c = 0; c < EDITOR_COLS; c++) {
            if (editorGrid[r][c]) {
                if (c < minX) minX = c;
                if (r < minY) minY = r;
            }
        }
    }
    for (let r = 0; r < EDITOR_ROWS; r++) {
        for (let c = 0; c < EDITOR_COLS; c++) {
            if (editorGrid[r][c]) {
                shape.push({ dx: c - minX, dy: r - minY, text: editorTexts[r][c] || '' });
            }
        }
    }
    return shape;
}

function triggerDropAction() {
    const color = document.getElementById('colorPicker').value;
    const startX = parseInt(document.getElementById('colInput').value);
    const shape = buildShapeFromEditor();

    isUserScrolling = false;
    container.scrollTop = container.scrollHeight;
    socket.emit('drop_block', { startX, color, shape, isPaidExpansion: isPaidExpansionVerified });
    isPaidExpansionVerified = false;
}

document.getElementById('dropBtn').addEventListener('click', () => {
    const shapeCount = getActiveCellCount();
    if (shapeCount === 0) {
        alert('Please design at least one block cell!');
        return;
    }

    const shape = buildShapeFromEditor();

    if (!isConnected(shape)) {
        alert('블록이 끊어져 있습니다! 상하좌우로 길게 이어지도록 그려주세요.');
        return;
    }

    const startX = parseInt(document.getElementById('colInput').value);
    const maxDx = Math.max(...shape.map(cell => cell.dx));
    if (!Number.isInteger(startX) || startX < 0 || startX + maxDx >= COLS) {
        alert(`드롭 위치가 보드를 벗어납니다. (0~${COLS - 1 - maxDx} 사이로 선택해주세요)`);
        return;
    }

    if (shapeCount > 10 && !isPaidExpansionVerified) {
        const extraCost = shapeCount - 10;
        if (confirm(`You selected ${shapeCount} cells (10 free + ${extraCost} extra).\nWould you like to pay $${extraCost} via Lemon Squeezy to drop this payload?`)) {
            socket.emit('request_payment', { type: 'expand_cells', extraCells: extraCost });
        }
        return;
    }

    triggerDropAction();
});

document.getElementById('extraDropBtn').addEventListener('click', () => {
    if (confirm('Would you like to purchase an extra drop opportunity for $10 via Lemon Squeezy?')) {
        socket.emit('request_payment', { type: 'extra_drop' });
    }
});