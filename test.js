'use strict';
const assert = require('assert');
const B = require('./public/shared/board');
const rules = require('./public/shared/rules');

let pass = 0;
function t(name, fn) {
    try { fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); process.exitCode = 1; }
}

const line = (n, y = 0, x = 0, color = '#ff4d4d', id = 'b') => ({
    id, color, x, y,
    shape: Array.from({ length: n }, (_, i) => ({ dx: i, dy: 0, text: '' }))
});

console.log('\n[rules]');
t('연결된 모양 통과', () => {
    const r = rules.normalizeShape([{dx:0,dy:0},{dx:1,dy:0},{dx:1,dy:1}]);
    assert(r.ok);
});
t('끊어진 모양 거부', () => {
    const r = rules.normalizeShape([{dx:0,dy:0},{dx:3,dy:0}]);
    assert(!r.ok && r.reason === 'DISCONNECTED');
});
t('10칸 초과 거부', () => {
    const shape = Array.from({length:11},(_,i)=>({dx:i,dy:0}));
    assert(!rules.normalizeShape(shape).ok);
});
t('좌표 재정규화', () => {
    const r = rules.normalizeShape([{dx:5,dy:7},{dx:6,dy:7}]);
    assert.deepStrictEqual(r.shape.map(c=>[c.dx,c.dy]), [[0,0],[1,0]]);
});
t('중복 좌표 제거', () => {
    const r = rules.normalizeShape([{dx:0,dy:0},{dx:0,dy:0},{dx:1,dy:0}]);
    assert.strictEqual(r.shape.length, 2);
});
t('셀 텍스트 정제', () => {
    assert.strictEqual(rules.sanitizeCellText('한'), '');
    assert.strictEqual(rules.sanitizeCellText('ab'), 'A');
});

console.log('\n[computeLandingY]');
t('빈 보드에서 바닥까지 낙하', () => {
    const grid = B.buildOccupancy([], 20, 50);
    const shape = [{dx:0,dy:0},{dx:0,dy:1}];
    assert.strictEqual(B.computeLandingY(grid, shape, 3, 20, 50), 18);
});
t('기존 블록 위에 안착', () => {
    const blocks = [line(3, 19, 0)];
    const grid = B.buildOccupancy(blocks, 20, 50);
    assert.strictEqual(B.computeLandingY(grid, [{dx:0,dy:0}], 1, 20, 50), 18);
});

console.log('\n[강체 중력]');
t('블록이 조각나지 않고 통째로 낙하', () => {
    const b = { id:'a', color:'#ff4d4d', x:0, y:0,
        shape:[{dx:0,dy:0},{dx:1,dy:0},{dx:2,dy:0}] };
    B.resolveGravity([b], 10, 50);
    assert.strictEqual(b.y, 9);
});
t('오버행(다리) 구조가 유지됨', () => {
    // 기둥 두 개 위에 가로 막대를 걸침 -> 막대가 공중에 떠 있어야 정상
    const left  = { id:'L', color:'#ff4d4d', x:0, y:8, shape:[{dx:0,dy:0},{dx:0,dy:1}] };
    const right = { id:'R', color:'#ff4d4d', x:4, y:8, shape:[{dx:0,dy:0},{dx:0,dy:1}] };
    const bar   = { id:'B', color:'#2d7dff', x:0, y:0,
        shape:[{dx:0,dy:0},{dx:1,dy:0},{dx:2,dy:0},{dx:3,dy:0},{dx:4,dy:0}] };
    B.resolveGravity([left, right, bar], 10, 50);
    assert.strictEqual(left.y, 8);
    assert.strictEqual(right.y, 8);
    assert.strictEqual(bar.y, 7, '막대는 기둥 위 7행에 걸쳐야 함');
});

console.log('\n[제거 규칙]');
t('같은 색 한 줄 완성 -> 걸친 블록 전체 제거', () => {
    // 폭 10짜리 보드에서 5칸 블록 두 개로 한 줄 완성
    const cols = 10;
    const a = line(5, 5, 0, '#ff4d4d', 'A');
    const b = line(5, 5, 5, '#ff4d4d', 'B');
    // A에 세로로 꼬리를 달아 "일부만 걸쳐도 전체 제거" 확인
    a.shape.push({dx:0,dy:-1,text:''}, {dx:0,dy:-2,text:''});
    const blocks = [a, b];
    const r = B.settle(blocks, 10, cols);
    assert.strictEqual(r.clearedBlocks.length, 2);
    assert.strictEqual(blocks.length, 0, '꼬리까지 통째로 사라져야 함');
});
t('색이 다르면 제거되지 않음', () => {
    const cols = 10;
    const blocks = [line(5, 9, 0, '#ff4d4d', 'A'), line(5, 9, 5, '#2d7dff', 'B')];
    const r = B.settle(blocks, 10, cols);
    assert.strictEqual(r.clearedBlocks.length, 0);
    assert.strictEqual(blocks.length, 2);
});
t('빈칸이 있으면 제거되지 않음', () => {
    const cols = 10;
    const blocks = [line(9, 9, 0, '#ff4d4d', 'A')];
    const r = B.settle(blocks, 10, cols);
    assert.strictEqual(r.clearedBlocks.length, 0);
});
t('연쇄(cascade) 제거', () => {
    const cols = 4;
    // 아래: 빨강 한 줄 (제거됨) / 위: 빨강 한 줄 (내려와서 또 제거됨)
    const blocks = [
        line(4, 9, 0, '#ff4d4d', 'bottom'),
        line(4, 5, 0, '#ff4d4d', 'top')
    ];
    const r = B.settle(blocks, 10, cols);
    assert.strictEqual(r.clearedBlocks.length, 2, '두 줄 모두 제거되어야 함');
    assert.strictEqual(blocks.length, 0);
});

console.log('\n[보드 확장]');
t('상단 여유 부족 시 확장 + 좌표 보정', () => {
    const b = { id:'a', color:'#ff4d4d', x:0, y:2, shape:[{dx:0,dy:0}] };
    const r = B.expandIfNeeded([b], 100, 50, { headroom: 12, addRows: 20, maxRows: 2000 });
    assert.strictEqual(r.added, 20);
    assert.strictEqual(b.y, 22, '기존 블록 y도 함께 밀려야 함');
});
t('상한 도달 시 확장 중단', () => {
    const b = { id:'a', color:'#ff4d4d', x:0, y:0, shape:[{dx:0,dy:0}] };
    const r = B.expandIfNeeded([b], 2000, 50, { headroom: 12, addRows: 20, maxRows: 2000 });
    assert.strictEqual(r.added, 0);
});

console.log('\n[DB]');
process.env.DB_FILE = '/tmp/test-droptalk.db';
require('fs').rmSync('/tmp/test-droptalk.db', { force: true });
const db = require('./src/db');
t('스키마 생성 + 시즌 확보', () => {
    const s = db.init(100);
    assert(s.season > 202000);
    assert.strictEqual(s.boardRows, 100);
});
t('블록 저장/조회 왕복', () => {
    const season = db.currentSeasonId();
    db.insertBlock({
        id:'blk1', season, userId:'u1', nickname:'지언', color:'#ff4d4d',
        shape:[{dx:0,dy:0,text:'H'},{dx:1,dy:0,text:'I'}],
        message:'HI', x:5, y:90, createdAt: Date.now()
    });
    const loaded = db.loadPlacedBlocks(season);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].nickname, '지언');
    assert.strictEqual(loaded[0].shape.length, 2);
});
t('메시지 검색', () => {
    const found = db.searchMessages(db.currentSeasonId(), 'HI', 10);
    assert.strictEqual(found.length, 1);
});
t('유저 상태 upsert (행이 없어도 생성)', () => {
    const season = db.currentSeasonId();
    db.saveUserState(season, 'u1', { dropsUsed:1, extraDrops:0, lastNickname:'지언' });
    assert.strictEqual(db.getUserState(season, 'u1').dropsUsed, 1);
    db.saveUserState(season, 'u1', { dropsUsed:2, extraDrops:0, lastNickname:'지언' });
    assert.strictEqual(db.getUserState(season, 'u1').dropsUsed, 2);
});
t('제거 처리 후 placed에서 빠지고 archive로 이동', () => {
    const season = db.currentSeasonId();
    db.clearBlocks(['blk1'], Date.now());
    assert.strictEqual(db.loadPlacedBlocks(season).length, 0);
    assert.strictEqual(db.loadClearedBlocks(season, 10).length, 1);
});

console.log(`\n${pass} passed\n`);
