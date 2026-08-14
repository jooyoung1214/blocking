'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'droptalk.db');

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 스키마 ────────────────────────────────────────────────────────────
// 설계 원칙: "블록"이 진실의 원천(source of truth)이다.
// 2차원 board 배열은 DB에 저장하지 않는다. 부팅 시 blocks 테이블에서
// 재구성하는 파생 캐시일 뿐이다.
function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS seasons (
            season     INTEGER PRIMARY KEY,   -- YYYYMM 형식 (예: 202608)
            started_at INTEGER NOT NULL,
            board_rows INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blocks (
            id         TEXT PRIMARY KEY,
            season     INTEGER NOT NULL,
            user_id    TEXT    NOT NULL,
            nickname   TEXT    NOT NULL,
            color      TEXT    NOT NULL,
            shape      TEXT    NOT NULL,   -- [{dx,dy,text}] JSON
            message    TEXT    NOT NULL,   -- 셀 글자를 이어붙인 것 (검색용)
            x          INTEGER NOT NULL,
            y          INTEGER NOT NULL,   -- 중력으로 갱신됨
            status     TEXT    NOT NULL,   -- 'placed' | 'cleared'
            created_at INTEGER NOT NULL,
            cleared_at INTEGER,
            FOREIGN KEY (season) REFERENCES seasons(season)
        );

        CREATE INDEX IF NOT EXISTS idx_blocks_season_status
            ON blocks(season, status);
        CREATE INDEX IF NOT EXISTS idx_blocks_user
            ON blocks(season, user_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_cleared
            ON blocks(season, cleared_at DESC);

        CREATE TABLE IF NOT EXISTS users (
            user_id       TEXT    NOT NULL,
            season        INTEGER NOT NULL,
            drops_used    INTEGER NOT NULL DEFAULT 0,
            extra_drops   INTEGER NOT NULL DEFAULT 0,
            last_nickname TEXT,
            PRIMARY KEY (user_id, season)
        );
    `);
}

// ── 시즌 ──────────────────────────────────────────────────────────────
// 시즌 번호를 YYYYMM으로 두면 "서버가 꺼져 있는 동안 월이 바뀌면 리셋이
// 영영 스킵된다"는 cron의 구조적 결함이 사라진다. 부팅할 때마다 현재
// 달의 시즌을 보장하면 되기 때문이다. cron은 같은 함수를 호출할 뿐이다.
function currentSeasonId(now = new Date()) {
    // 시즌 경계는 Asia/Seoul 기준
    const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return seoul.getUTCFullYear() * 100 + (seoul.getUTCMonth() + 1);
}

function ensureSeason(seasonId, defaultRows) {
    const row = db.prepare('SELECT * FROM seasons WHERE season = ?').get(seasonId);
    if (row) return { season: row.season, boardRows: row.board_rows, created: false };

    db.prepare('INSERT INTO seasons (season, started_at, board_rows) VALUES (?, ?, ?)')
        .run(seasonId, Date.now(), defaultRows);
    return { season: seasonId, boardRows: defaultRows, created: true };
}

function listSeasons() {
    return db.prepare(`
        SELECT s.season, s.started_at, s.board_rows,
               COUNT(b.id) AS block_count
        FROM seasons s
        LEFT JOIN blocks b ON b.season = s.season
        GROUP BY s.season
        ORDER BY s.season DESC
    `).all();
}

// ── 준비된 구문 ───────────────────────────────────────────────────────
const stmt = {};
function prepareStatements() {
    stmt.setMeta = db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');

    stmt.setBoardRows = db.prepare('UPDATE seasons SET board_rows = ? WHERE season = ?');

    stmt.insertBlock = db.prepare(`
        INSERT INTO blocks
            (id, season, user_id, nickname, color, shape, message, x, y, status, created_at)
        VALUES
            (@id, @season, @userId, @nickname, @color, @shape, @message, @x, @y, 'placed', @createdAt)
    `);
    stmt.updateBlockY = db.prepare('UPDATE blocks SET y = ? WHERE id = ?');
    stmt.clearBlock = db.prepare(
        "UPDATE blocks SET status = 'cleared', cleared_at = ? WHERE id = ?"
    );
    stmt.placedBlocks = db.prepare(
        "SELECT * FROM blocks WHERE season = ? AND status = 'placed'"
    );
    stmt.clearedBlocks = db.prepare(`
        SELECT * FROM blocks WHERE season = ? AND status = 'cleared'
        ORDER BY cleared_at DESC LIMIT ?
    `);
    stmt.blockById = db.prepare('SELECT * FROM blocks WHERE id = ?');
    stmt.blocksByUser = db.prepare(
        'SELECT * FROM blocks WHERE season = ? AND user_id = ? ORDER BY created_at'
    );
    stmt.searchMessages = db.prepare(`
        SELECT * FROM blocks
        WHERE season = ? AND message LIKE ?
        ORDER BY created_at DESC LIMIT ?
    `);

    stmt.getUser = db.prepare('SELECT * FROM users WHERE user_id = ? AND season = ?');
    stmt.upsertUser = db.prepare(`
        INSERT INTO users (user_id, season, drops_used, extra_drops, last_nickname)
        VALUES (@userId, @season, @dropsUsed, @extraDrops, @lastNickname)
        ON CONFLICT(user_id, season) DO UPDATE SET
            drops_used    = excluded.drops_used,
            extra_drops   = excluded.extra_drops,
            last_nickname = excluded.last_nickname
    `);
}

// ── 행 <-> 객체 변환 ──────────────────────────────────────────────────
function rowToBlock(row) {
    return {
        id: row.id,
        season: row.season,
        userId: row.user_id,
        nickname: row.nickname,
        color: row.color,
        shape: JSON.parse(row.shape),
        message: row.message,
        x: row.x,
        y: row.y,
        status: row.status,
        createdAt: row.created_at,
        clearedAt: row.cleared_at
    };
}

// ── 공개 API ──────────────────────────────────────────────────────────
const api = {
    raw: db,

    init(defaultRows) {
        initSchema();
        prepareStatements();
        const seasonId = currentSeasonId();
        const season = ensureSeason(seasonId, defaultRows);
        return season;
    },

    currentSeasonId,
    ensureSeason,
    listSeasons,

    setBoardRows(season, rows) {
        stmt.setBoardRows.run(rows, season);
    },

    loadPlacedBlocks(season) {
        return stmt.placedBlocks.all(season).map(rowToBlock);
    },

    loadClearedBlocks(season, limit = 200) {
        return stmt.clearedBlocks.all(season, limit).map(rowToBlock);
    },

    getBlock(id) {
        const row = stmt.blockById.get(id);
        return row ? rowToBlock(row) : null;
    },

    getUserBlocks(season, userId) {
        return stmt.blocksByUser.all(season, userId).map(rowToBlock);
    },

    searchMessages(season, term, limit = 50) {
        return stmt.searchMessages.all(season, `%${term}%`, limit).map(rowToBlock);
    },

    insertBlock(block) {
        stmt.insertBlock.run({
            id: block.id,
            season: block.season,
            userId: block.userId,
            nickname: block.nickname,
            color: block.color,
            shape: JSON.stringify(block.shape),
            message: block.message,
            x: block.x,
            y: block.y,
            createdAt: block.createdAt
        });
    },

    // 중력으로 이동한 블록들의 y를 한 트랜잭션으로 일괄 반영
    persistPositions: db.transaction((blocks) => {
        for (const b of blocks) stmt.updateBlockY.run(b.y, b.id);
    }),

    clearBlocks: db.transaction((ids, when) => {
        for (const id of ids) stmt.clearBlock.run(when, id);
    }),

    getUserState(season, userId) {
        const row = stmt.getUser.get(userId, season);
        if (row) {
            return {
                dropsUsed: row.drops_used,
                extraDrops: row.extra_drops,
                lastNickname: row.last_nickname
            };
        }
        return { dropsUsed: 0, extraDrops: 0, lastNickname: null };
    },

    saveUserState(season, userId, state) {
        stmt.upsertUser.run({
            userId,
            season,
            dropsUsed: state.dropsUsed,
            extraDrops: state.extraDrops,
            lastNickname: state.lastNickname || null
        });
    },

    setMeta(key, value) { stmt.setMeta.run(key, String(value)); },
    getMeta(key) {
        const row = stmt.getMeta.get(key);
        return row ? row.value : null;
    },

    close() { db.close(); }
};

module.exports = api;
