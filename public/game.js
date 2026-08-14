'use strict';

const Rules = window.DropTalkRules;
const Board = window.DropTalkBoard;

// ── i18n ──────────────────────────────────────────────────────────────
const LOCALE = (navigator.language || 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en';
const STRINGS = {
  ko: {
    NO_USER_ID: '유저 식별에 실패했습니다. 새로고침 해주세요.',
    PAYMENT_DISABLED: '결제 기능은 아직 준비 중입니다.',
    INTERNAL: '처리 중 오류가 발생했습니다.',
    EMPTY: '블록을 최소 한 칸 이상 그려주세요.',
    TOO_MANY_CELLS: p => `블록은 최대 ${p.max}칸까지 만들 수 있습니다.`,
    DISCONNECTED: '칸이 끊어져 있습니다. 상하좌우로 이어주세요.',
    BAD_CELL: '블록 데이터가 올바르지 않습니다.',
    OUT_OF_RANGE: '블록 좌표가 올바르지 않습니다.',
    INVALID_COLOR: '유효하지 않은 색입니다.',
    OUT_OF_BOUNDS: p => `보드를 벗어납니다. 0~${p.max} 사이로 놓아주세요.`,
    NO_DROPS_LEFT: '이번 시즌의 기회를 모두 사용했습니다.',
    CANT_PLACE: '이 자리에는 놓을 수 없습니다.',
    BLOCK_LANDED: p => `${p.nickname} 님이 ${p.row}행에 블록을 남겼습니다`,
    ROWS_CLEARED: p => `${p.rows}개 행 완성 — ${p.people}명의 메시지가 수확되었습니다`,
    SEASON_CHANGED: '새 시즌이 시작되어 보드가 초기화되었습니다',
    connected: '연결됨', connecting: '연결 중', disconnected: '연결 끊김'
  },
  en: {
    NO_USER_ID: 'Could not identify you. Please refresh.',
    PAYMENT_DISABLED: 'Payments are not available yet.',
    INTERNAL: 'Something went wrong.',
    EMPTY: 'Draw at least one cell.',
    TOO_MANY_CELLS: p => `A block can use up to ${p.max} cells.`,
    DISCONNECTED: 'Cells must connect edge to edge.',
    BAD_CELL: 'That block data is not valid.',
    OUT_OF_RANGE: 'Those coordinates are not valid.',
    INVALID_COLOR: 'That color is not available.',
    OUT_OF_BOUNDS: p => `That is off the board. Choose 0–${p.max}.`,
    NO_DROPS_LEFT: 'You have used your turn this season.',
    CANT_PLACE: 'A block cannot land there.',
    BLOCK_LANDED: p => `${p.nickname} left a block on row ${p.row}`,
    ROWS_CLEARED: p => `${p.rows} row(s) completed — ${p.people} message(s) harvested`,
    SEASON_CHANGED: 'A new season started. The board has been cleared.',
    connected: 'live', connecting: 'connecting', disconnected: 'offline'
  }
};
function t(code, params) {
  const v = STRINGS[LOCALE][code];
  if (typeof v === 'function') return v(params || {});
  return v || code;
}

// ── 유저 토큰 ─────────────────────────────────────────────────────────
const USER_ID = (function () {
  const K = 'droptalk_user_id';
  let id = localStorage.getItem(K);
  if (!id) {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
    localStorage.setItem(K, id);
  }
  return id;
})();

const socket = io({ auth: { userId: USER_ID } });

// ── DOM ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const frame = $('frame'), scroller = $('scroller'), spacer = $('spacer');
const canvas = $('board'), ctx = canvas.getContext('2d');
const tip = $('tip'), panel = $('panel'), aimbar = $('aimbar');

// ── 상태 ──────────────────────────────────────────────────────────────
const S = {
  season: null,
  cols: Rules.BOARD_COLS,
  rows: Rules.DEFAULT_BOARD_ROWS,
  maxCells: Rules.MAX_CELLS,
  colors: Rules.COLORS,
  blocks: [],
  blockById: new Map(),
  board: [],
  archive: [],
  myIds: new Set(),
  remaining: 0,
  color: Rules.COLORS[0].hex,
  grid: Array.from({ length: 4 }, () => Array(10).fill(false)),
  message: '',
  mode: 'idle',          // idle | aiming | locked
  aim: null,             // { x, y, shape, rowInfo }
  hover: null,           // 툴팁 대상 blockId
  anim: [],
  cell: 14,
  followBottom: true
};
const GUTTER_BASE = window.innerWidth <= 900 ? 34 : 46;

let dirty = true;
const mark = () => { dirty = true; };

// ── 색 유틸 ───────────────────────────────────────────────────────────
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(n >> 16 & 255) + 0.7152 * f(n >> 8 & 255) + 0.0722 * f(n & 255);
}
// 배경색 위에서 읽히는 글자색을 고른다 (항상 검정이던 기존 문제 해결)
const inkOn = hex => (luminance(hex) > 0.42 ? '#101a20' : '#ffffff');

function setAccent(hex) {
  document.documentElement.style.setProperty('--accent', hex);
  document.documentElement.style.setProperty('--accent-ink', inkOn(hex));
}

// ── 에디터 ────────────────────────────────────────────────────────────
const EDITOR_ROWS = 4, EDITOR_COLS = 10;

function activeCells() {
  const out = [];
  for (let r = 0; r < EDITOR_ROWS; r++)
    for (let c = 0; c < EDITOR_COLS; c++)
      if (S.grid[r][c]) out.push({ r, c });
  return out;   // 읽기 순서 (위→아래, 왼→오른)
}

function buildShape() {
  const cells = activeCells();
  if (!cells.length) return [];
  const minR = Math.min(...cells.map(c => c.r));
  const minC = Math.min(...cells.map(c => c.c));
  return cells.map((cell, i) => ({
    dx: cell.c - minC,
    dy: cell.r - minR,
    text: S.message[i] || ''
  }));
}

function renderEditor() {
  const ed = $('editor');
  if (!ed.children.length) {
    for (let r = 0; r < EDITOR_ROWS; r++) {
      for (let c = 0; c < EDITOR_COLS; c++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ec';
        b.dataset.r = r; b.dataset.c = c;
        b.setAttribute('aria-label', `${r + 1}행 ${c + 1}열`);
        b.addEventListener('click', () => {
          if (S.mode !== 'idle') return;
          S.grid[r][c] = !S.grid[r][c];
          syncEditor();
        });
        ed.appendChild(b);
      }
    }
  }
  const cells = activeCells();
  const idx = new Map(cells.map((c, i) => [c.r + ',' + c.c, i]));
  for (const b of ed.children) {
    const key = b.dataset.r + ',' + b.dataset.c;
    const on = idx.has(key);
    b.classList.toggle('on', on);
    b.textContent = on ? (S.message[idx.get(key)] || '') : '';
  }
}

function syncEditor() {
  const cells = activeCells();
  const n = cells.length;
  const shape = buildShape();
  const connected = n > 0 && Rules.isConnected(shape);

  // 메시지 길이를 칸 수에 맞춤
  S.message = S.message.slice(0, n);
  const msgEl = $('messageInput');
  msgEl.disabled = n === 0;
  msgEl.maxLength = Math.max(n, 1);
  msgEl.value = S.message;
  msgEl.placeholder = n === 0 ? '칸을 먼저 그려주세요' : '_'.repeat(n);

  const hint = $('shapeHint');
  if (n === 0) {
    hint.className = 'hint';
    hint.textContent = `0 / ${S.maxCells} 칸`;
  } else if (!connected) {
    hint.className = 'hint warn';
    hint.textContent = `${n} / ${S.maxCells} 칸 — 칸이 끊어져 있습니다`;
  } else {
    hint.className = 'hint';
    hint.textContent = `${n} / ${S.maxCells} 칸`;
  }

  $('msgHint').textContent = n ? `${S.message.length} / ${n} 글자 · A–Z, 0–9` : '';

  const ok = n > 0 && n <= S.maxCells && connected && S.remaining > 0;
  $('placeBtn').disabled = !ok || S.season === null;
  $('placeBtn').textContent = S.season === null ? '연결 중\u2026'
    : (S.remaining > 0 ? '보드에 올리기' : '이번 시즌 기회 소진');

  renderEditor();
}

$('messageInput').addEventListener('input', e => {
  const n = activeCells().length;
  S.message = Array.from(e.target.value)
    .map(ch => Rules.sanitizeCellText(ch))
    .filter(Boolean).join('').slice(0, n);
  e.target.value = S.message;
  syncEditor();
});

$('nickInput').addEventListener('input', debounce(e => {
  socket.emit('set_nickname', e.target.value);
}, 400));

function debounce(fn, ms) {
  let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

function renderSwatches() {
  const wrap = $('swatches');
  wrap.innerHTML = '';
  S.colors.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw';
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    b.setAttribute('aria-pressed', String(c.hex === S.color));
    b.addEventListener('click', () => {
      if (S.mode !== 'idle') return;
      S.color = c.hex;
      setAccent(c.hex);
      renderSwatches();
      renderEditor();
    });
    wrap.appendChild(b);
  });
}

function renderDrops() {
  const el = $('drops');
  el.innerHTML = '';
  const total = Math.max(1, S.remaining + (S.usedDrops || 0));
  for (let i = 0; i < total; i++) {
    const p = document.createElement('span');
    p.className = 'pip' + (i >= S.remaining ? ' used' : '');
    el.appendChild(p);
  }
  const label = document.createElement('span');
  label.textContent = S.remaining > 0 ? '남은 기회 ' + S.remaining : '사용 완료';
  el.appendChild(label);
}

// ── 보드 지오메트리 ───────────────────────────────────────────────────
function fitCell() {
  const w = frame.clientWidth - GUTTER_BASE - 10;
  S.cell = Math.max(6, Math.min(30, Math.floor(w / S.cols)));
}

function layout() {
  fitCell();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(frame.clientWidth * dpr);
  canvas.height = Math.round(frame.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  spacer.style.height = (S.rows * S.cell) + 'px';
  mark();
}

function rebuild() {
  S.board = Board.buildBoard(S.blocks, S.rows, S.cols);
  S.blockById = new Map(S.blocks.map(b => [b.id, b]));
  $('emptyHint').style.display = S.blocks.length ? 'none' : '';
  $('statBlocks').textContent = S.blocks.length.toLocaleString();
  $('statRows').textContent = S.rows;
  mark();
}

const toBoardX = px => Math.floor((px - GUTTER_BASE) / S.cell);
const toBoardY = py => Math.floor((py + scroller.scrollTop) / S.cell);

function scrollToBottom() { scroller.scrollTop = scroller.scrollHeight; }

function scrollRowIntoView(row) {
  const target = row * S.cell - scroller.clientHeight * 0.55;
  scroller.scrollTop = Math.max(0, target);
}

// ── 렌더링 (뷰포트 가상화 — 캔버스는 항상 화면 크기) ──────────────────
function draw() {
  const W = frame.clientWidth, H = frame.clientHeight;
  const top = scroller.scrollTop;
  const cs = S.cell;
  const r0 = Math.max(0, Math.floor(top / cs));
  const r1 = Math.min(S.rows, Math.ceil((top + H) / cs));
  const now = performance.now();

  ctx.clearRect(0, 0, W, H);

  // 필드
  ctx.fillStyle = '#16222a';
  ctx.fillRect(GUTTER_BASE, 0, S.cols * cs, H);

  // 격자
  if (cs >= 7) {
    ctx.strokeStyle = '#233440';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= S.cols; c++) {
      const x = Math.round(GUTTER_BASE + c * cs) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let r = r0; r <= r1; r++) {
      const y = Math.round(r * cs - top) + 0.5;
      ctx.moveTo(GUTTER_BASE, y); ctx.lineTo(GUTTER_BASE + S.cols * cs, y);
    }
    ctx.stroke();
  }

  // 애니메이션 중인 블록은 별도 좌표로 그린다
  const animMap = new Map();
  for (const a of S.anim) {
    const p = Math.min(1, (now - a.start) / a.dur);
    animMap.set(a.id, { p, a });
  }

  // 착지 블록
  for (const b of S.blocks) {
    const an = animMap.get(b.id);
    let y = b.y, alpha = 1, flash = 0;
    if (an) {
      if (an.a.kind === 'fall') {
        const e = easeInQuad(an.p);
        y = an.a.fromY + (an.a.toY - an.a.fromY) * e;
      } else if (an.a.kind === 'move') {
        const e = easeOutCubic(an.p);
        y = an.a.fromY + (an.a.toY - an.a.fromY) * e;
      } else if (an.a.kind === 'clear') {
        alpha = 1 - an.p;
        flash = 1 - Math.min(1, an.p * 2.2);
      }
    }
    if (y * cs - top > H || (y + 4) * cs - top < -40) continue;
    drawBlock(b, b.x, y, top, alpha, flash);
  }

  // 고스트
  if (S.aim) drawGhost(top);

  // 좌측 눈금 거터
  drawGutter(r0, r1, top, H);

  // 호버 강조
  if (S.hover && S.mode === 'idle') {
    const b = S.blockById.get(S.hover);
    if (b) outlineBlock(b, top, '#ffffff', 2);
  }
}

function easeInQuad(p) { return p * p; }
function easeOutCubic(p) { return 1 - Math.pow(1 - p, 3); }

function drawBlock(b, bx, by, top, alpha, flash) {
  const cs = S.cell;
  const mine = S.myIds.has(b.id);
  ctx.globalAlpha = alpha;
  for (const cell of b.shape) {
    const x = GUTTER_BASE + (bx + cell.dx) * cs;
    const y = (by + cell.dy) * cs - top;
    ctx.fillStyle = b.color;
    ctx.fillRect(x, y, cs, cs);
    // 상단 하이라이트 (입체감)
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(x, y, cs, Math.max(1, cs * 0.28));
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash})`;
      ctx.fillRect(x, y, cs, cs);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.34)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, cs - 1, cs - 1);

    if (cell.text && cs >= 11) {
      ctx.fillStyle = inkOn(b.color);
      ctx.font = `600 ${Math.round(cs * 0.62)}px 'IBM Plex Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cell.text, x + cs / 2, y + cs / 2 + cs * 0.04);
    }
  }
  if (mine) outlineBlock(b, top, 'rgba(255,255,255,.75)', 1, bx, by);
  ctx.globalAlpha = 1;
}

function outlineBlock(b, top, color, width, bx, by) {
  const cs = S.cell;
  const X = bx === undefined ? b.x : bx;
  const Y = by === undefined ? b.y : by;
  const set = new Set(b.shape.map(c => c.dx + ',' + c.dy));
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath();
  for (const c of b.shape) {
    const x = GUTTER_BASE + (X + c.dx) * cs;
    const y = (Y + c.dy) * cs - top;
    if (!set.has(c.dx + ',' + (c.dy - 1))) { ctx.moveTo(x, y); ctx.lineTo(x + cs, y); }
    if (!set.has(c.dx + ',' + (c.dy + 1))) { ctx.moveTo(x, y + cs); ctx.lineTo(x + cs, y + cs); }
    if (!set.has((c.dx - 1) + ',' + c.dy)) { ctx.moveTo(x, y); ctx.lineTo(x, y + cs); }
    if (!set.has((c.dx + 1) + ',' + c.dy)) { ctx.moveTo(x + cs, y); ctx.lineTo(x + cs, y + cs); }
  }
  ctx.stroke();
}

// 시그니처: 낙하 통로 + 고스트 + 접지선 + 치수 기입
function drawGhost(top) {
  const cs = S.cell, a = S.aim;
  const H = frame.clientHeight;
  const cols = new Set(a.shape.map(c => a.x + c.dx));
  const willClear = a.rowInfo.some(r => r.complete);

  // 낙하 통로
  ctx.fillStyle = hexA(S.color, willClear ? 0.16 : 0.09);
  for (const c of cols) {
    ctx.fillRect(GUTTER_BASE + c * cs, 0, cs, (a.y * cs - top));
  }

  // 고스트 블록
  ctx.save();
  ctx.setLineDash([4, 3]);
  for (const cell of a.shape) {
    const x = GUTTER_BASE + (a.x + cell.dx) * cs;
    const y = (a.y + cell.dy) * cs - top;
    ctx.fillStyle = hexA(S.color, 0.38);
    ctx.fillRect(x, y, cs, cs);
    ctx.strokeStyle = hexA(S.color, 0.95);
    ctx.lineWidth = S.mode === 'locked' ? 2 : 1.25;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, cs - 1, cs - 1);
    if (cell.text && cs >= 11) {
      ctx.setLineDash([]);
      ctx.fillStyle = hexA(inkOn(S.color), 0.85);
      ctx.font = `600 ${Math.round(cs * 0.62)}px 'IBM Plex Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cell.text, x + cs / 2, y + cs / 2 + cs * 0.04);
      ctx.setLineDash([4, 3]);
    }
  }
  ctx.restore();

  // 접지선 — 블록 최하단 셀 아래
  const bottom = a.y + Board.blockHeight(a.shape);
  const yb = bottom * cs - top;
  ctx.strokeStyle = S.color; ctx.lineWidth = 2;
  ctx.beginPath();
  let minX = Infinity, maxX = -Infinity;
  for (const c of cols) { minX = Math.min(minX, c); maxX = Math.max(maxX, c + 1); }
  ctx.moveTo(GUTTER_BASE + minX * cs, yb);
  ctx.lineTo(GUTTER_BASE + maxX * cs, yb);
  ctx.stroke();
  // 도면식 눈금
  ctx.lineWidth = 1;
  for (const c of cols) {
    ctx.beginPath();
    ctx.moveTo(GUTTER_BASE + c * cs + cs / 2, yb);
    ctx.lineTo(GUTTER_BASE + c * cs + cs / 2, yb + 5);
    ctx.stroke();
  }

  // 완성되는 행 강조
  for (const info of a.rowInfo) {
    if (!info.complete) continue;
    const y = info.row * cs - top;
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(GUTTER_BASE, y, S.cols * cs, cs);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
    ctx.strokeRect(GUTTER_BASE + 0.5, y + 0.5, S.cols * cs - 1, cs - 1);
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

function drawGutter(r0, r1, top, H) {
  const cs = S.cell;
  ctx.fillStyle = '#e9eae4';
  ctx.fillRect(0, 0, GUTTER_BASE, H);
  ctx.strokeStyle = '#c6c8bb'; ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(GUTTER_BASE - 0.5, 0); ctx.lineTo(GUTTER_BASE - 0.5, H);
  ctx.stroke();

  const step = cs >= 14 ? 5 : cs >= 9 ? 10 : 20;
  ctx.font = `500 ${GUTTER_BASE > 40 ? 10 : 9}px 'IBM Plex Mono', monospace`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let r = r0; r < r1; r++) {
    if (r % step !== 0) continue;
    const y = r * cs - top + cs / 2;
    ctx.fillStyle = '#7b8990';
    ctx.fillText(String(r), GUTTER_BASE - 9, y);
    ctx.strokeStyle = '#c6c8bb';
    ctx.beginPath();
    ctx.moveTo(GUTTER_BASE - 6, Math.round(y) + 0.5);
    ctx.lineTo(GUTTER_BASE - 1, Math.round(y) + 0.5);
    ctx.stroke();
  }

  // 조준 중인 행 표시
  if (S.aim) {
    for (const info of S.aim.rowInfo) {
      const y = info.row * cs - top + cs / 2;
      if (y < -10 || y > H + 10) continue;
      ctx.fillStyle = info.complete ? '#0d7a3f' : S.color;
      ctx.fillRect(GUTTER_BASE - 5, y - cs / 2, 4, cs);
    }
    const lead = S.aim.rowInfo[0];
    if (lead) {
      const y = lead.row * S.cell - top + S.cell / 2;
      ctx.fillStyle = '#182830';
      ctx.font = `600 ${GUTTER_BASE > 40 ? 10 : 9}px 'IBM Plex Mono', monospace`;
      ctx.textAlign = 'right';
      ctx.fillText(String(lead.row), GUTTER_BASE - 9, y);
    }
  }
}

function loop() {
  if (dirty || S.anim.length) {
    dirty = false;
    const now = performance.now();
    S.anim = S.anim.filter(a => {
      if (now - a.start < a.dur) return true;
      if (a.onEnd) a.onEnd();
      return false;
    });
    draw();
  }
  requestAnimationFrame(loop);
}

// ── 조준 ──────────────────────────────────────────────────────────────
function computeAim(pointerX) {
  const shape = buildShape();
  if (!shape.length) return null;
  const w = Board.blockWidth(shape);
  let x = pointerX - Math.floor((w - 1) / 2);
  x = Math.max(0, Math.min(S.cols - w, x));
  const y = Board.computeLandingY(S.board, shape, x, S.rows, S.cols);
  if (y === null) return null;
  const rowInfo = Board.analyzeRows(S.board, shape, x, y, S.color, S.cols);
  return { x, y, shape, rowInfo };
}

function updateAim(pointerX) {
  const aim = computeAim(pointerX);
  if (!aim) return;
  S.aim = aim;
  renderAimBar();
  mark();
}

function renderAimBar() {
  if (!S.aim) return;
  const a = S.aim;
  const w = Board.blockWidth(a.shape);
  const best = a.rowInfo.slice().sort((p, q) => q.matching - p.matching)[0];
  const complete = a.rowInfo.filter(r => r.complete);

  const parts = [
    `<span>열 <b>${a.x}\u2013${a.x + w - 1}</b></span>`,
    `<span>안착 행 <b>${a.y}</b></span>`
  ];
  if (complete.length) {
    parts.push(`<span class="hot">${complete.map(r => r.row).join(', ')}행 완성 \u2014 걸친 블록이 모두 수확됩니다</span>`);
  } else if (best) {
    parts.push(`<span>${best.row}행 같은 색 <b>${best.matching}</b>/${S.cols}</span>`);
  }
  $('aimRead').innerHTML = parts.join('');
  $('aimNote').textContent = S.mode === 'locked'
    ? '되돌릴 수 없습니다'
    : '보드를 클릭해 위치를 고정하세요';
  $('confirmBtn').style.display = S.mode === 'locked' ? '' : 'none';
  $('nudgeL').style.display = $('nudgeR').style.display = S.mode === 'locked' ? '' : 'none';
}

function enterAiming() {
  if (S.remaining <= 0) return;
  S.mode = 'aiming';
  frame.classList.remove('reading');
  frame.classList.add('aiming');
  panel.classList.add('dim');
  aimbar.classList.add('on');
  $('emptyHint').style.display = 'none';
  hideTip();
  updateAim(Math.floor(S.cols / 2));
  if (S.aim) scrollRowIntoView(S.aim.y);
  scroller.focus();
  layout();
}

function exitAiming() {
  S.mode = 'idle';
  S.aim = null;
  frame.classList.remove('aiming');
  frame.classList.add('reading');
  panel.classList.remove('dim');
  aimbar.classList.remove('on');
  $('emptyHint').style.display = S.blocks.length ? 'none' : '';
  layout();
}

function lockAim() {
  if (!S.aim) return;
  S.mode = 'locked';
  renderAimBar();
  mark();
}

function nudge(d) {
  if (!S.aim) return;
  const w = Board.blockWidth(S.aim.shape);
  const cx = S.aim.x + Math.floor((w - 1) / 2) + d;
  updateAim(cx);
}

function confirmDrop() {
  if (!S.aim || S.mode !== 'locked') return;
  socket.emit('drop_block', { shape: S.aim.shape, x: S.aim.x, color: S.color });
  $('confirmBtn').disabled = true;
}

// ── 포인터 ────────────────────────────────────────────────────────────
function pointerCol(clientX) {
  const rect = frame.getBoundingClientRect();
  return toBoardX(clientX - rect.left);
}

scroller.addEventListener('mousemove', e => {
  if (S.mode === 'aiming') { updateAim(pointerCol(e.clientX)); return; }
  if (S.mode === 'idle') hoverBlock(e);
});

scroller.addEventListener('mouseleave', () => { hideTip(); });

scroller.addEventListener('click', e => {
  if (S.mode === 'aiming') { updateAim(pointerCol(e.clientX)); lockAim(); }
  else if (S.mode === 'locked') { updateAim(pointerCol(e.clientX)); }
});

// 터치: 드래그로 조준, 손가락 위쪽으로 고스트를 띄운다
let touchAiming = false;
scroller.addEventListener('touchstart', e => {
  if (S.mode === 'idle') return;
  touchAiming = true;
  updateAim(pointerCol(e.touches[0].clientX));
  e.preventDefault();
}, { passive: false });

scroller.addEventListener('touchmove', e => {
  if (!touchAiming) return;
  updateAim(pointerCol(e.touches[0].clientX));
  e.preventDefault();
}, { passive: false });

scroller.addEventListener('touchend', () => {
  if (!touchAiming) return;
  touchAiming = false;
  lockAim();
});

// 모바일에서는 탭으로 블록을 읽는다 (호버가 없으므로)
scroller.addEventListener('touchend', e => {
  if (S.mode !== 'idle') return;
  const tch = e.changedTouches[0];
  if (!tch) return;
  hoverBlock({ clientX: tch.clientX, clientY: tch.clientY });
  clearTimeout(showTip._h);
  showTip._h = setTimeout(hideTip, 3200);
});

scroller.addEventListener('scroll', () => {
  S.followBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  mark();
});

scroller.addEventListener('keydown', e => {
  if (S.mode === 'idle') return;
  const step = e.shiftKey ? 5 : 1;
  if (e.key === 'ArrowLeft') { nudge(-step); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { nudge(step); e.preventDefault(); }
  else if (e.key === 'Enter') {
    if (S.mode === 'aiming') lockAim(); else confirmDrop();
    e.preventDefault();
  } else if (e.key === 'Escape') { exitAiming(); }
});

$('placeBtn').addEventListener('click', enterAiming);
$('cancelBtn').addEventListener('click', exitAiming);
$('confirmBtn').addEventListener('click', confirmDrop);
$('nudgeL').addEventListener('click', () => nudge(-1));
$('nudgeR').addEventListener('click', () => nudge(1));

// ── 툴팁 (방명록 읽기) ────────────────────────────────────────────────
function hoverBlock(e) {
  const rect = frame.getBoundingClientRect();
  const c = toBoardX(e.clientX - rect.left);
  const r = toBoardY(e.clientY - rect.top);
  const cell = (r >= 0 && r < S.rows && c >= 0 && c < S.cols) ? S.board[r][c] : null;
  if (!cell) { hideTip(); return; }
  if (S.hover !== cell.blockId) { S.hover = cell.blockId; mark(); }
  showTip(S.blockById.get(cell.blockId), e.clientX - rect.left, e.clientY - rect.top);
}

function showTip(b, x, y) {
  if (!b) return;
  const mine = S.myIds.has(b.id);
  const d = new Date(b.createdAt);
  tip.innerHTML =
    `<div class="tip-msg${b.message ? '' : ' none'}">${b.message ? esc(b.message) : '(메시지 없음)'}</div>` +
    `<div class="tip-meta">` +
      `<span><i class="tip-swatch" style="background:${b.color}"></i>${esc(b.nickname)}${mine ? ' · 내 블록' : ''}</span>` +
      `<span>${d.toLocaleDateString()} · ${b.y}행</span>` +
    `</div>`;
  tip.classList.add('on');
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = Math.min(frame.clientWidth - tw - 8, x + 14) + 'px';
  tip.style.top = Math.max(6, y - th - 12) + 'px';
}

function hideTip() {
  tip.classList.remove('on');
  if (S.hover) { S.hover = null; mark(); }
}

const esc = s => String(s).replace(/[&<>"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// ── 아카이브 ──────────────────────────────────────────────────────────
function renderArchive() {
  const el = $('archive');
  $('archCount').textContent = S.archive.length ? S.archive.length : '';
  if (!S.archive.length) {
    el.innerHTML = `<div class="empty">한 행이 빈칸 없이 같은 색으로 채워지면,<br>그 행에 걸친 블록이 모두 여기로 옵니다.<br>아직 아무도 해내지 못했습니다.</div>`;
    return;
  }
  el.innerHTML = '';
  for (const it of S.archive.slice(0, 60)) {
    const d = document.createElement('div');
    d.className = 'arch-item';
    d.innerHTML =
      `<div class="arch-msg" style="color:${it.color}">${it.message ? esc(it.message) : '—'}</div>` +
      `<div class="arch-meta">${esc(it.nickname)} · ${new Date(it.clearedAt).toLocaleDateString()}</div>`;
    el.appendChild(d);
  }
}

// ── 토스트 ────────────────────────────────────────────────────────────
function toast(text, bad) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.setAttribute('role', 'status');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// ── 소켓 ──────────────────────────────────────────────────────────────
function setConn(cls, key) {
  $('conn').className = 'conn ' + cls;
  $('connText').textContent = t(key);
}
socket.on('connect', () => setConn('live', 'connected'));
socket.on('disconnect', () => setConn('dead', 'disconnected'));
socket.on('connect_error', () => setConn('dead', 'disconnected'));

socket.on('init_state', d => {
  S.season = d.season; S.cols = d.cols; S.rows = d.boardRows;
  S.maxCells = d.maxCells; S.colors = d.colors;
  S.blocks = d.blocks; S.archive = d.archive;
  S.myIds = new Set(d.myBlockIds);
  S.remaining = d.remainingDrops;
  S.usedDrops = d.myBlockIds.length;
  if (!S.colors.some(c => c.hex === S.color)) S.color = S.colors[0].hex;

  $('statSeason').textContent = String(d.season).replace(/(\d{4})(\d{2})/, '$1.$2');
  $('nickInput').value = d.nickname === 'Anonymous' ? '' : d.nickname;

  setAccent(S.color);
  renderSwatches(); renderDrops(); renderArchive();
  rebuild(); layout(); syncEditor();
  scrollToBottom();
});

socket.on('block_landed', d => {
  const wasBottom = S.followBottom;
  S.rows = d.boardRows;

  if (d.rowsAdded > 0) for (const b of S.blocks) b.y += d.rowsAdded;

  S.blocks.push(d.block);
  S.anim.push({ id: d.block.id, kind: 'fall', fromY: d.fromY, toY: d.block.y, start: performance.now(), dur: 520 });

  const finish = () => {
    if (d.clearedBlockIds.length) {
      const set = new Set(d.clearedBlockIds);
      for (const id of set) {
        S.anim.push({ id, kind: 'clear', start: performance.now(), dur: 420 });
      }
      setTimeout(() => {
        S.blocks = S.blocks.filter(b => !set.has(b.id));
        for (const m of d.movedBlocks) {
          const b = S.blockById.get(m.id);
          if (b && b.y !== m.y) {
            S.anim.push({ id: m.id, kind: 'move', fromY: b.y, toY: m.y, start: performance.now(), dur: 380 });
            b.y = m.y;
          }
        }
        S.archive = d.archive;
        renderArchive();
        rebuild();
      }, 420);
    } else {
      for (const m of d.movedBlocks) {
        const b = S.blockById.get(m.id);
        if (b) b.y = m.y;
      }
      rebuild();
    }
  };

  setTimeout(finish, 520);
  layout();
  if (wasBottom) scrollToBottom();
  mark();
});

socket.on('drop_success', d => {
  S.remaining = d.remainingDrops;
  S.usedDrops = (S.usedDrops || 0) + 1;
  S.myIds.add(d.blockId);
  exitAiming();
  $('confirmBtn').disabled = false;
  S.grid = Array.from({ length: 4 }, () => Array(10).fill(false));
  S.message = '';
  renderDrops(); syncEditor();
});

socket.on('season_changed', d => {
  S.season = d.season; S.rows = d.boardRows;
  S.blocks = d.blocks; S.archive = d.archive;
  S.myIds = new Set(); S.remaining = 1; S.usedDrops = 0;
  $('statSeason').textContent = String(d.season).replace(/(\d{4})(\d{2})/, '$1.$2');
  exitAiming(); renderDrops(); renderArchive(); rebuild(); layout(); syncEditor();
  scrollToBottom();
  toast(t('SEASON_CHANGED'));
});

socket.on('toast_message', d => toast(t(d.code, d.params)));
socket.on('error_message', d => {
  toast(typeof d === 'string' ? d : t(d.code, d.params), true);
  $('confirmBtn').disabled = false;
});

// ── 초기화 ────────────────────────────────────────────────────────────
window.addEventListener('resize', debounce(() => { layout(); if (S.followBottom) scrollToBottom(); }, 120));
setAccent(S.color);
renderSwatches(); renderDrops(); renderArchive(); syncEditor(); layout();
requestAnimationFrame(loop);
