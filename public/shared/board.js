(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.DropTalkBoard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// 보드는 blocks 배열로부터 파생되는 캐시다. 여기 있는 함수들은 전부
// "블록 목록 + 크기" 를 받아서 동작한다. DB를 직접 건드리지 않는다.

/**
 * 블록 목록으로 2차원 보드를 재구성한다.
 * 각 칸은 null 또는 { blockId, color, text }.
 */
function buildBoard(blocks, rows, cols) {
    const board = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (const b of blocks) {
        for (const cell of b.shape) {
            const y = b.y + cell.dy;
            const x = b.x + cell.dx;
            if (y >= 0 && y < rows && x >= 0 && x < cols) {
                board[y][x] = { blockId: b.id, color: b.color, text: cell.text };
            }
        }
    }
    return board;
}

/** blockId만 담는 점유 격자. 중력 계산용. */
function buildOccupancy(blocks, rows, cols) {
    const grid = Array.from({ length: rows }, () => Array(cols).fill(null));
    for (const b of blocks) {
        for (const cell of b.shape) {
            const y = b.y + cell.dy;
            const x = b.x + cell.dx;
            if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = b.id;
        }
    }
    return grid;
}

function blockBottom(b) {
    let max = 0;
    for (const cell of b.shape) if (cell.dy > max) max = cell.dy;
    return b.y + max;
}

function blockWidth(shape) {
    let max = 0;
    for (const cell of shape) if (cell.dx > max) max = cell.dx;
    return max + 1;
}

function blockHeight(shape) {
    let max = 0;
    for (const cell of shape) if (cell.dy > max) max = cell.dy;
    return max + 1;
}

/** 격자 위 특정 위치에 블록을 놓을 수 있는지 (자기 자신은 이미 지워진 상태 가정) */
function canPlace(grid, shape, x, y, rows, cols) {
    for (const cell of shape) {
        const cy = y + cell.dy;
        const cx = x + cell.dx;
        if (cx < 0 || cx >= cols) return false;
        if (cy >= rows) return false;
        if (cy >= 0 && grid[cy][cx] !== null) return false;
    }
    return true;
}

/**
 * 특정 x에 블록을 떨어뜨렸을 때 안착하는 y를 계산한다.
 * 고스트 프리뷰와 실제 드롭이 완전히 동일한 함수를 쓰도록 하기 위해
 * 이 계산은 서버/클라이언트가 공유해야 한다.
 */
function computeLandingY(grid, shape, x, rows, cols) {
    // 블록의 최상단이 보드 밖(음수)에서 시작해도 되도록 y를 위에서부터 내린다
    let y = -blockHeight(shape);
    if (!canPlace(grid, shape, x, y, rows, cols)) return null; // 폭이 안 맞는 등
    while (canPlace(grid, shape, x, y + 1, rows, cols)) y++;
    return y;
}

/**
 * 강체(rigid body) 중력.
 * 블록을 조각내지 않고 통째로 낙하시킨다. 아래쪽 블록부터 처리하고,
 * 한 번의 패스에서 아무도 움직이지 않을 때까지 반복한다.
 * 이동한 블록의 y를 직접 수정하고, 이동한 블록 목록을 반환한다.
 */
function resolveGravity(blocks, rows, cols) {
    const grid = buildOccupancy(blocks, rows, cols);
    const moved = new Map();
    let changed = true;
    let guard = 0;

    while (changed) {
        changed = false;
        if (++guard > 1000) break; // 무한루프 방지

        const order = blocks.slice().sort((a, b) => blockBottom(b) - blockBottom(a));

        for (const b of order) {
            // 자기 자신을 격자에서 잠시 제거
            for (const cell of b.shape) {
                const y = b.y + cell.dy, x = b.x + cell.dx;
                if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = null;
            }

            let d = 0;
            while (canPlace(grid, b.shape, b.x, b.y + d + 1, rows, cols)) d++;

            if (d > 0) {
                b.y += d;
                changed = true;
                moved.set(b.id, b);
            }

            // 새 위치에 다시 기록
            for (const cell of b.shape) {
                const y = b.y + cell.dy, x = b.x + cell.dx;
                if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y][x] = b.id;
            }
        }
    }

    return Array.from(moved.values());
}

/**
 * 제거 규칙:
 * 한 행이 빈칸 없이 전부 같은 색이면, 그 행에 한 칸이라도 걸쳐 있는
 * 블록을 "통째로" 제거한다.
 * 제거 대상 blockId 집합과 완성된 행 번호를 반환한다.
 */
function findClears(blocks, rows, cols) {
    const board = buildBoard(blocks, rows, cols);
    const clearedIds = new Set();
    const fullRows = [];

    for (let r = 0; r < rows; r++) {
        const row = board[r];
        let color = null;
        let ok = true;
        for (let c = 0; c < cols; c++) {
            const cell = row[c];
            if (cell === null) { ok = false; break; }
            if (color === null) color = cell.color;
            else if (cell.color !== color) { ok = false; break; }
        }
        if (!ok) continue;

        fullRows.push(r);
        for (let c = 0; c < cols; c++) clearedIds.add(row[c].blockId);
    }

    return { clearedIds, fullRows };
}

/**
 * 제거 -> 중력 -> 재검사 를 안정될 때까지 반복(cascade).
 * blocks 배열을 제자리에서 수정하고 결과 요약을 반환한다.
 */
function settle(blocks, rows, cols) {
    const allCleared = [];
    const allFullRows = [];
    const movedIds = new Set();
    let pass = 0;

    // 최초 1회는 무조건 중력을 적용 (새로 놓인 블록이 뜬 상태일 수 있음)
    for (const b of resolveGravity(blocks, rows, cols)) movedIds.add(b.id);

    while (pass++ < 100) {
        const { clearedIds, fullRows } = findClears(blocks, rows, cols);
        if (clearedIds.size === 0) break;

        allFullRows.push(...fullRows);
        for (const id of clearedIds) {
            const idx = blocks.findIndex(b => b.id === id);
            if (idx !== -1) {
                allCleared.push(blocks[idx]);
                blocks.splice(idx, 1);
            }
        }

        for (const b of resolveGravity(blocks, rows, cols)) movedIds.add(b.id);
    }

    // 제거된 블록은 이동 목록에서 뺀다
    for (const b of allCleared) movedIds.delete(b.id);

    return {
        clearedBlocks: allCleared,
        fullRows: allFullRows,
        movedBlocks: blocks.filter(b => movedIds.has(b.id))
    };
}

/**
 * 상단 여유가 부족하면 보드를 위로 확장한다.
 * 모든 블록의 y를 함께 밀어내려야 좌표계가 유지된다.
 */
function expandIfNeeded(blocks, rows, cols, opts = {}) {
    const headroom = opts.headroom ?? 10;
    const addRows = opts.addRows ?? 20;
    const maxRows = opts.maxRows ?? 2000;

    let highest = rows;
    for (const b of blocks) if (b.y < highest) highest = b.y;

    if (highest >= headroom) return { rows, added: 0 };
    if (rows >= maxRows) return { rows, added: 0 };

    const need = headroom - highest;
    const add = Math.min(Math.ceil(need / addRows) * addRows, maxRows - rows);
    if (add <= 0) return { rows, added: 0 };

    for (const b of blocks) b.y += add;
    return { rows: rows + add, added: add };
}

/**
 * 고스트 프리뷰용: 이 위치에 블록을 놓으면 각 행이 어떻게 되는지 분석한다.
 * 블록이 걸치는 행마다 { row, filled, matching, cols, complete } 반환.
 *  - filled   : 그 행의 채워진 칸 수 (고스트 포함)
 *  - matching : 그 행에서 내 색과 같은 칸 수
 *  - complete : 빈칸 없이 전부 같은 색이 되는가 (= 제거 발생)
 */
function analyzeRows(board, shape, x, y, color, cols) {
    const ghost = new Map();
    const rowSet = new Set();
    for (const cell of shape) {
        const r = y + cell.dy;
        rowSet.add(r);
        ghost.set(r + ',' + (x + cell.dx), color);
    }

    const out = [];
    const rows = board.length;
    for (const r of rowSet) {
        if (r < 0 || r >= rows) continue;
        let filled = 0;
        let matching = 0;
        let uniformColor = null;
        let uniform = true;

        for (let c = 0; c < cols; c++) {
            const g = ghost.get(r + ',' + c);
            const cellColor = g || (board[r][c] ? board[r][c].color : null);
            if (cellColor === null) continue;
            filled++;
            if (cellColor === color) matching++;
            if (uniformColor === null) uniformColor = cellColor;
            else if (cellColor !== uniformColor) uniform = false;
        }

        out.push({
            row: r,
            filled,
            matching,
            cols,
            complete: filled === cols && uniform
        });
    }
    return out.sort((a, b) => a.row - b.row);
}

return {
    buildBoard,
    buildOccupancy,
    analyzeRows,
    computeLandingY,
    canPlace,
    resolveGravity,
    findClears,
    settle,
    expandIfNeeded,
    blockWidth,
    blockHeight,
    blockBottom
};
});
