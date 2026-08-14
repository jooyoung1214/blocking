'use strict';
// 완전히 새 DB(파일 없음)에서 부팅 -> 접속 -> 드롭 -> 재부팅 복원까지 확인.
// 기존 코드가 첫 실행에서 크래시하던 시나리오가 이것이다.
const fs = require('fs');
const { io: ioc } = require('socket.io-client');

const DB = '/tmp/e2e-droptalk.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
process.env.DB_FILE = DB;
process.env.PORT = '3999';

const { server, state } = require('./src/server');

function connect(userId) {
    return new Promise((resolve, reject) => {
        const c = ioc('http://localhost:3999', { auth: { userId } });
        c.on('init_state', (s) => resolve({ c, init: s }));
        c.on('connect_error', reject);
        setTimeout(() => reject(new Error('timeout')), 3000);
    });
}

const bar = (n, text) =>
    Array.from({ length: n }, (_, i) => ({ dx: i, dy: 0, text: text[i] || '' }));

server.listen(3999, async () => {
    console.log('server up, season =', state.season);

    const { c, init } = await connect('user-a');
    console.log('init_state: rows=%d cols=%d colors=%d remainingDrops=%d',
        init.boardRows, init.cols, init.colors.length, init.remainingDrops);

    c.on('error_message', m => console.log('  [error_message]', m));

    // 착지 예측
    const preview = await new Promise(r =>
        c.emit('preview_landing', { shape: bar(5, 'HELLO'), x: 10 }, r));
    console.log('preview_landing ->', preview);

    // 드롭
    const landed = new Promise(r => c.once('block_landed', r));
    c.emit('drop_block', { shape: bar(5, 'HELLO'), x: 10, color: '#ff4d4d' });
    const ev = await landed;
    console.log('block_landed: id=%s x=%d y=%d msg=%s',
        ev.block.id.slice(0, 8), ev.block.x, ev.block.y, ev.block.message);
    console.log('  예측 y=%d / 실제 y=%d  %s',
        preview.y, ev.block.y, preview.y === ev.block.y ? '✓ 일치' : '✗ 불일치');

    // 두 번째 드롭은 거부되어야 함 (1인 1회)
    await new Promise(r => {
        c.once('error_message', (m) => { console.log('두번째 드롭 ->', m); r(); });
        c.emit('drop_block', { shape: bar(3, 'ABC'), x: 20, color: '#2d7dff' });
    });

    // 같은 유저가 새 소켓으로 재접속해도 기회는 소진된 상태여야 함
    const again = await connect('user-a');
    console.log('재접속 remainingDrops =', again.init.remainingDrops,
        again.init.remainingDrops === 0 ? '✓' : '✗');
    console.log('내 블록 개수 =', again.init.myBlockIds.length);

    c.close(); again.c.close();
    server.close(() => {
        // 프로세스 재시작 시뮬레이션: 모듈 캐시를 비우고 다시 로드
        for (const k of Object.keys(require.cache)) delete require.cache[k];
        process.env.DB_FILE = DB;
        const fresh = require('./src/server');
        console.log('재부팅 후 복원: blocks=%d rows=%d %s',
            fresh.state.blocks.length, fresh.state.boardRows,
            fresh.state.blocks.length === 1 ? '✓' : '✗');
        console.log('복원된 메시지 =', JSON.stringify(fresh.state.blocks[0].message));
        process.exit(0);
    });
});
