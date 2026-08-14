/**
 * 서버와 클라이언트가 공유하는 규칙.
 * Node에서는 require, 브라우저에서는 <script>로 로드된다.
 * 이 파일을 단일 출처로 삼아 색상표/제한값 하드코딩 중복을 제거한다.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.DropTalkRules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const BOARD_COLS = 50;
    const DEFAULT_BOARD_ROWS = 100;
    const MAX_BOARD_ROWS = 2000;      // 캔버스 높이 한계(32767px) 대비 여유
    const MAX_CELLS = 10;             // 무료 한도. 결제 기능 완성 전까지 절대 상한
    const MAX_NICKNAME_LEN = 15;

    // 10색 팔레트. index.html의 색 선택 UI도 이 배열로 생성한다.
    const COLORS = [
        { id: 'red',    hex: '#ff4d4d', name: 'Red' },
        { id: 'orange', hex: '#ff9f1c', name: 'Orange' },
        { id: 'yellow', hex: '#ffe14d', name: 'Yellow' },
        { id: 'lime',   hex: '#8ce600', name: 'Lime' },
        { id: 'green',  hex: '#00c853', name: 'Green' },
        { id: 'cyan',   hex: '#00e5ff', name: 'Cyan' },
        { id: 'blue',   hex: '#2d7dff', name: 'Blue' },
        { id: 'purple', hex: '#9b5cff', name: 'Purple' },
        { id: 'pink',   hex: '#ff5cc8', name: 'Pink' },
        { id: 'white',  hex: '#f0f0f0', name: 'White' }
    ];

    const COLOR_HEXES = COLORS.map(c => c.hex);

    /** 셀 텍스트: 영문/숫자 1글자만. 서버/클라 동일 규칙. */
    function sanitizeCellText(text) {
        if (typeof text !== 'string') return '';
        const m = text.trim().slice(0, 1).match(/[A-Za-z0-9]/);
        return m ? m[0].toUpperCase() : '';
    }

    function sanitizeNickname(name) {
        if (typeof name !== 'string') return null;
        const clean = name
            .replace(/[\u0000-\u001F\u007F]/g, '')
            .trim()
            .slice(0, MAX_NICKNAME_LEN);
        return clean.length > 0 ? clean : null;
    }

    /** 상하좌우로 전부 이어져 있는지 (BFS) */
    function isConnected(shape) {
        if (!Array.isArray(shape) || shape.length <= 1) return true;
        const key = c => `${c.dx},${c.dy}`;
        const pool = new Set(shape.map(key));
        const seen = new Set([key(shape[0])]);
        const queue = [shape[0]];
        let head = 0;

        while (head < queue.length) {
            const cur = queue[head++];
            const neighbors = [
                { dx: cur.dx + 1, dy: cur.dy },
                { dx: cur.dx - 1, dy: cur.dy },
                { dx: cur.dx, dy: cur.dy + 1 },
                { dx: cur.dx, dy: cur.dy - 1 }
            ];
            for (const n of neighbors) {
                const k = key(n);
                if (pool.has(k) && !seen.has(k)) {
                    seen.add(k);
                    queue.push(n);
                }
            }
        }
        return seen.size === pool.size;
    }

    /**
     * 클라이언트가 보낸 shape를 검증하고 (0,0) 기준으로 재정규화한다.
     * 유효하지 않으면 { ok:false, reason } 반환.
     */
    function normalizeShape(rawShape) {
        if (!Array.isArray(rawShape) || rawShape.length === 0) {
            return { ok: false, reason: 'EMPTY' };
        }
        if (rawShape.length > MAX_CELLS) {
            return { ok: false, reason: 'TOO_MANY_CELLS' };
        }

        const cleaned = [];
        for (const cell of rawShape) {
            if (!cell || typeof cell !== 'object') return { ok: false, reason: 'BAD_CELL' };
            const dx = Number(cell.dx);
            const dy = Number(cell.dy);
            if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
                return { ok: false, reason: 'BAD_CELL' };
            }
            if (Math.abs(dx) > MAX_CELLS || Math.abs(dy) > MAX_CELLS) {
                return { ok: false, reason: 'OUT_OF_RANGE' };
            }
            cleaned.push({ dx, dy, text: sanitizeCellText(cell.text) });
        }

        const minDx = Math.min(...cleaned.map(c => c.dx));
        const minDy = Math.min(...cleaned.map(c => c.dy));

        const seen = new Set();
        const shape = [];
        for (const c of cleaned) {
            const dx = c.dx - minDx;
            const dy = c.dy - minDy;
            const k = `${dx},${dy}`;
            if (seen.has(k)) continue;   // 중복 좌표 제거
            seen.add(k);
            shape.push({ dx, dy, text: c.text });
        }

        if (!isConnected(shape)) return { ok: false, reason: 'DISCONNECTED' };
        return { ok: true, shape };
    }

    /** 셀 글자를 읽기 순서(위->아래, 왼->오른)로 이어붙인 검색용 문자열 */
    function shapeToMessage(shape) {
        return shape
            .slice()
            .sort((a, b) => (a.dy - b.dy) || (a.dx - b.dx))
            .map(c => c.text || ' ')
            .join('')
            .trim();
    }

    function isValidColor(hex) {
        return COLOR_HEXES.indexOf(hex) !== -1;
    }

    return {
        BOARD_COLS,
        DEFAULT_BOARD_ROWS,
        MAX_BOARD_ROWS,
        MAX_CELLS,
        MAX_NICKNAME_LEN,
        COLORS,
        COLOR_HEXES,
        sanitizeCellText,
        sanitizeNickname,
        isConnected,
        normalizeShape,
        shapeToMessage,
        isValidColor
    };
});
