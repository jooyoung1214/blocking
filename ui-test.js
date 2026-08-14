'use strict';
// jsdom으로 실제 index.html + game.js를 띄우고 실제 서버에 붙여서
// 조준 -> 고정 -> 확정 흐름이 끝까지 동작하는지 확인한다.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DB = '/tmp/ui-droptalk.db';
for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
process.env.DB_FILE = DB;

const { server } = require('./src/server');

// 캔버스 2D 컨텍스트 스텁 (jsdom은 canvas 미지원)
const ctxStub = new Proxy({}, {
    get: (t, k) => {
        if (k === 'canvas') return { width: 0, height: 0 };
        if (k === 'measureText') return () => ({ width: 10 });
        return typeof k === 'string' ? (() => {}) : undefined;
    },
    set: () => true
});

function check(label, cond, extra) {
    console.log((cond ? '  ok  ' : '  FAIL ') + label + (extra ? '  ' + extra : ''));
    if (!cond) process.exitCode = 1;
}

server.listen(3998, async () => {
    const html = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'http://localhost:3998/',
        runScripts: 'dangerously',
        resources: 'usable',
        pretendToBeVisual: true
    });
    const w = dom.window;
    w.HTMLCanvasElement.prototype.getContext = () => ctxStub;
    Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return 900; } });
    Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return 600; } });
    w.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600 });

    // 스크립트 로드 대기
    await new Promise(r => w.addEventListener('load', r));
    await new Promise(r => setTimeout(r, 900));

    const d = w.document;
    const $ = id => d.getElementById(id);

    console.log('\n[초기 렌더]');
    check('색 스와치 10개', $('swatches').children.length === 10);
    check('에디터 40칸 (10x4)', $('editor').children.length === 40);
    check('시즌 표시', /\d{4}\.\d{2}/.test($('statSeason').textContent), $('statSeason').textContent);
    check('연결 상태 live', $('conn').className.includes('live'));
    check('올리기 버튼 비활성 (모양 없음)', $('placeBtn').disabled === true);
    check('메시지 입력 비활성', $('messageInput').disabled === true);
    check('아카이브 빈 상태 안내', $('archive').textContent.includes('아직 아무도'));

    console.log('\n[모양 그리기]');
    const cells = Array.from($('editor').children);
    const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    // 첫 행에 5칸 연속
    for (let i = 0; i < 5; i++) click(cells[i]);
    check('5칸 선택됨', $('shapeHint').textContent.startsWith('5 / 10'), $('shapeHint').textContent);
    check('메시지 입력 활성화', $('messageInput').disabled === false);
    check('올리기 버튼 활성화', $('placeBtn').disabled === false);

    // 끊어진 모양 감지
    click(cells[8]);
    check('끊어진 모양 경고', $('shapeHint').className.includes('warn'), $('shapeHint').textContent);
    check('끊어지면 버튼 잠김', $('placeBtn').disabled === true);
    click(cells[8]);
    check('되돌리면 다시 활성', $('placeBtn').disabled === false);

    console.log('\n[메시지 입력]');
    const msg = $('messageInput');
    msg.value = 'hello world';
    msg.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('5글자로 잘림 + 대문자', msg.value === 'HELLO', msg.value);
    check('에디터 칸에 글자 표시', cells[0].textContent === 'H' && cells[4].textContent === 'O');

    console.log('\n[조준]');
    click($('placeBtn'));
    check('조준 모드 진입', $('frame').className.includes('aiming'));
    check('패널 흐려짐', $('panel').className.includes('dim'));
    check('조준 바 노출', $('aimbar').className.includes('on'));
    check('안착 행 표시', /안착 행/.test($('aimRead').textContent), $('aimRead').textContent.trim());
    check('확정 버튼은 아직 숨김', $('confirmBtn').style.display === 'none');

    // 보드 위 이동 후 클릭으로 고정
    const scr = $('scroller');
    scr.dispatchEvent(new w.MouseEvent('mousemove', { bubbles: true, clientX: 400, clientY: 300 }));
    const beforeLock = $('aimRead').textContent;
    scr.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }));
    check('고정 후 확정 버튼 노출', $('confirmBtn').style.display !== 'none');
    check('되돌릴 수 없음 안내', $('aimNote').textContent.includes('되돌릴 수 없'), $('aimNote').textContent);

    // 미세 조정
    const readBefore = $('aimRead').textContent;
    click($('nudgeR'));
    check('한 칸 이동 반영', $('aimRead').textContent !== readBefore, $('aimRead').textContent.trim());

    console.log('\n[확정]');
    click($('confirmBtn'));
    await new Promise(r => setTimeout(r, 1400));
    check('조준 모드 해제', !$('frame').className.includes('aiming'));
    check('블록 수 1', $('statBlocks').textContent === '1', $('statBlocks').textContent);
    check('기회 소진 표시', $('drops').textContent.includes('사용 완료'), $('drops').textContent);
    check('버튼 잠김', $('placeBtn').disabled === true);
    check('에디터 초기화', $('shapeHint').textContent.startsWith('0 / 10'));
    check('토스트 출력', /블록을 남겼습니다|left a block/.test($('toasts').textContent), $('toasts').textContent.trim());
    check('빈 보드 안내 사라짐', $('emptyHint').style.display === 'none');

    console.log('\n[재드롭 거부]');
    for (let i = 0; i < 3; i++) click(cells[i]);
    check('기회 없으면 버튼 잠김 유지', $('placeBtn').disabled === true);

    dom.window.close();
    server.close(() => process.exit());
});
