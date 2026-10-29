'use strict';
// 디그더그 스타일 규칙. 화면 없이 Node 에서 시험한다 (DOM 을 쓰지 않는다).
// 판은 14x15칸(한 칸 16픽셀 크기로 그린다). 0번 줄은 땅 위(하늘), 1~14번 줄이 흙. 위치는 칸 단위의 실수이고 칸 중심이 정수 좌표다.
// 방향: 0 위 · 1 오른쪽 · 2 아래 · 3 왼쪽
const LOGIC_DIGDUG = (() => {
const COLS = 14, ROWS = 15;
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const START_LIVES = 3;
const PLAYER_SPEED = 4.2, PLAYER_START = { x: 7, y: 2 };
const PUMP_REACH = 3.5, PUMP_SPEED = 16, PUMP_HOLD = 0.75, PUMP_EVERY = 0.2, POP_AT = 4, DEFLATE_EVERY = 0.7;
const GHOST_SPEED = 0.62;                                  // 유령(눈) 모습일 때 속도 배율
const FIRE_LEN = 3, FIRE_CHARGE = 0.55, FIRE_TIME = 0.7;
const ROCK_WOBBLE = 0.6, ROCK_G = 14;
const LAYER_POINTS = [200, 300, 400, 500];                  // 흙 층(위에서부터 1~4)에서 터뜨린 적의 점수 (용 옆에서 터뜨리면 두 배)
const CRUSH_POINTS = [1000, 2500, 4000, 6000, 8000, 10000, 12000, 15000];
const VEG = [['carrot', 400], ['turnip', 600], ['mushroom', 800], ['cucumber', 1000], ['eggplant', 2000], ['pepper', 3000], ['tomato', 4000], ['garlic', 5000], ['pineapple', 8000]];
const EXTRA_LIFE_AT = 20000, EXTRA_LIFE_EVERY = 60000;
const POCKETS = [
  [[2, 4], [11, 3], [3, 9], [10, 12]],
  [[3, 3], [10, 5], [2, 10], [11, 9]],
  [[2, 6], [11, 6], [7, 10], [6, 13]],
  [[4, 5], [10, 4], [2, 12], [11, 11]],
];

const rng = (seed) => {                                      // mulberry32 (시험용 고정 난수)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const emit = (st, e) => { st.events.push(e); };
const layerOf = (row) => (row <= 4 ? 0 : row <= 8 ? 1 : row <= 11 ? 2 : 3);
const vegFor = (round) => VEG[Math.min(VEG.length - 1, Math.floor((round - 1) / 2) >= 8 ? 8 : Math.floor((round - 1) / 2))];
const enemyCounts = (round) => ({ pooka: Math.min(5, 3 + Math.floor((round - 1) / 4)), fygar: Math.min(4, 1 + Math.floor((round - 1) / 2)) });
// 유령으로 변하기까지 걸리는 시간: 첫 판은 길고, 판이 올라갈수록 짧아진다
const ghostDelay = (st, k) => k * (Math.max(16, 38 - 2 * st.round) + st.rand() * 14);
const speedMul = (round) => Math.min(1.55, 1 + 0.055 * (round - 1));

// ---------- 판 ----------
function makeRound(st, round) {
  st.round = round;
  st.dirt = Array.from({ length: ROWS }, (_, r) => new Array(COLS).fill(r > 0));
  const open = (c, r) => { if (c >= 0 && c < COLS && r >= 0 && r < ROWS) st.dirt[r][c] = false; };
  open(PLAYER_START.x, 1); open(PLAYER_START.x, 2);
  st.pockets = POCKETS[(round - 1) % POCKETS.length];
  for (const [c, r] of st.pockets) { open(c - 1, r); open(c, r); open(c + 1, r); }
  st.enemies = []; st.rocks = []; st.items = []; st.flames = [];
  const cnt = enemyCounts(round);
  const kinds = [];
  for (let i = 0; i < Math.max(cnt.pooka, cnt.fygar); i++) { if (i < cnt.pooka) kinds.push('pooka'); if (i < cnt.fygar) kinds.push('fygar'); }
  kinds.forEach((kind, i) => {
    const pk = st.pockets[i % 4], slot = Math.floor(i / 4) % 3;
    const e = newEnemy(st, kind, pk[0] - 1 + slot, pk[1]);
    st.enemies.push(e);
  });
  st.enemies0 = st.enemies.length;
  // 바위: 아래가 흙으로 막혀 있고, 터널·주머니 가까이가 아닌 곳에
  const nRocks = Math.min(5, 3 + Math.floor(round / 4));
  const used = new Set();
  for (let tries = 0; st.rocks.length < nRocks && tries < 500; tries++) {
    const c = 1 + Math.floor(st.rand() * (COLS - 2)), r = 2 + Math.floor(st.rand() * 10);
    if (!st.dirt[r][c] || !st.dirt[r + 1][c] || Math.abs(c - PLAYER_START.x) < 2 && r < 5) continue;
    if ([[0, 0], [0, 1], [1, 0], [-1, 0], [0, -1]].some(([dc, dr]) => !st.dirt[r + dr] || st.dirt[r + dr][c + dc] === false)) continue;
    if (used.has(`${c}`)) continue;
    used.add(`${c}`);
    st.rocks.push({ id: ++st.seq, x: c, y: r, state: 'still', t: 0, vy: 0, crushed: 0, fell: false });
  }
  const p = st.player;
  p.x = PLAYER_START.x; p.y = PLAYER_START.y; p.dir = -1; p.face = 1; p.alive = true; p.invuln = 1.5; p.pump = null; p.pumpT = 0;
  st.t = 0; st.dropped = 0; st.vegSpawned = false; st.phase = 'play'; st.phaseT = 0; st.lastEscapes = false;
  st.dist = null; st.distT = 0;
  emit(st, { t: 'round', round });
}
function newEnemy(st, kind, x, y) {
  return { id: ++st.seq, kind, x, y, dir: -1, state: 'walk', ghostT: 0, ghostNext: ghostDelay(st, 1), inflate: 0, held: false, deflateT: 0, charge: 0, fireT: 0, fireCd: 3 + st.rand() * 3, face: st.rand() < 0.5 ? 1 : -1, stuck: 0, alive: true, anim: 0, sx: x, sy: y };
}

function newGame(rand = Math.random) {
  const st = { rand, score: 0, lives: START_LIVES, extra: 0, round: 1, time: 0, events: [], seq: 0, player: { x: 7, y: 2 }, stats: { pops: 0, crushes: 0 } };
  makeRound(st, 1);
  st.events = [];
  return st;
}

// ---------- 칸과 길 ----------
const inside = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
const isOpen = (st, c, r) => inside(c, r) && !st.dirt[r][c];
const rock = (st, c, r) => st.rocks.find((k) => k.state !== 'gone' && Math.round(k.x) === c && Math.round(k.y) === r);
const isInt = (v) => Math.abs(v - Math.round(v)) < 1e-6;
const atCenter = (e) => isInt(e.x) && isInt(e.y);
const nearCell = (e) => [Math.round(e.x), Math.round(e.y)];

function distField(st, fx, fy) {
  const dist = new Int16Array(COLS * ROWS).fill(-1);
  if (!isOpen(st, fx, fy)) return dist;
  const q = [fy * COLS + fx]; dist[q[0]] = 0;
  for (let i = 0; i < q.length; i++) {
    const cur = q[i], x = cur % COLS, y = (cur - x) / COLS;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (!isOpen(st, nx, ny) || rock(st, nx, ny) || dist[ny * COLS + nx] >= 0) continue;
      dist[ny * COLS + nx] = dist[cur] + 1; q.push(ny * COLS + nx);
    }
  }
  return dist;
}

// 칸 중심에서 칸 중심으로 간다. chooser 가 갈 방향을 정하고, canGo 가 막힌 곳을 거른다
function glide(e, dist, chooser, canGo) {
  if (e.dir < 0 && !atCenter(e)) { e.x = Math.round(e.x); e.y = Math.round(e.y); }        // 서 있던 곳이 칸 중간이면 가까운 칸 중심에서 다시 출발
  let guard = 0;
  while (dist > 1e-9 && guard++ < 10) {
    if (atCenter(e)) {
      e.x = Math.round(e.x); e.y = Math.round(e.y);
      chooser(e);
      if (e.dir < 0) return;
      if (!canGo(e, e.dir)) { e.dir = -1; return; }
    }
    let d;
    if (e.dir === 1) d = Math.floor(e.x + 1e-6) + 1 - e.x;
    else if (e.dir === 3) d = e.x - (Math.ceil(e.x - 1e-6) - 1);
    else if (e.dir === 2) d = Math.floor(e.y + 1e-6) + 1 - e.y;
    else d = e.y - (Math.ceil(e.y - 1e-6) - 1);
    const s = Math.min(d, dist);
    e.x += DX[e.dir] * s; e.y += DY[e.dir] * s; dist -= s;
    if (isInt(e.x)) e.x = Math.round(e.x);
    if (isInt(e.y)) e.y = Math.round(e.y);
  }
}

// ---------- 점수 · 목숨 ----------
function addScore(st, n) {
  st.score += n;
  const need = () => (st.extra === 0 ? EXTRA_LIFE_AT : EXTRA_LIFE_AT + st.extra * EXTRA_LIFE_EVERY);
  while (st.score >= need()) { st.extra++; st.lives++; emit(st, { t: 'extraLife' }); }
}

function killPlayer(st, why) {
  const p = st.player;
  if (!p.alive || p.invuln > 0) return;
  p.alive = false; p.pump = null;
  st.lives--;
  emit(st, { t: 'dead', why, x: p.x, y: p.y });
  st.phase = 'dying'; st.phaseT = 1.8;
}

function popEnemy(st, e, horizontal) {
  e.alive = false;
  const layer = layerOf(Math.round(e.y));
  const base = LAYER_POINTS[layer];
  const pts = e.kind === 'fygar' && horizontal ? base * 2 : base;
  addScore(st, pts);
  st.stats.pops++;
  emit(st, { t: 'pop', x: e.x, y: e.y, pts, kind: e.kind, layer });
}

// ---------- 한 걸음 ----------
// input: { dx, dy: 누르고 있는 방향 (-1, 0, 1), pump: 펌프 버튼을 누르고 있는가 }
function step(st, dt, input) {
  st.events = [];
  let left = dt;
  while (left > 1e-9 && st.phase !== 'over') { const h = Math.min(left, 1 / 60); sub(st, h, input || {}); left -= h; }
}

function playerDirFrom(input) {
  const dx = input.dx || 0, dy = input.dy || 0;
  if (!dx && !dy) return null;
  if (dx && dy) return null;                                   // 대각선은 무시 (UI 가 한쪽만 보낸다)
  return dx > 0 ? 1 : dx < 0 ? 3 : dy > 0 ? 2 : 0;
}

function sub(st, h, input) {
  st.time += h;
  const p = st.player;
  if (st.phase === 'dying') {
    st.phaseT -= h;
    if (st.phaseT <= 0) {
      if (st.lives <= 0) { st.phase = 'over'; emit(st, { t: 'over' }); return; }
      p.x = PLAYER_START.x; p.y = PLAYER_START.y; p.dir = -1; p.alive = true; p.invuln = 2; p.pump = null;
      st.dirt[1][PLAYER_START.x] = false; st.dirt[2][PLAYER_START.x] = false;
      for (const e of st.enemies) { e.x = e.sx; e.y = e.sy; e.state = 'walk'; e.dir = -1; e.inflate = 0; e.held = false; e.charge = 0; e.fireT = 0; }
      st.flames = [];
      st.phase = 'play';
    }
    return;
  }
  if (st.phase === 'clear') {
    st.phaseT -= h;
    if (st.phaseT <= 0) makeRound(st, st.round + 1);
    return;
  }
  st.t += h;
  if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - h);

  // ---- 내 캐릭터 ----
  const want = playerDirFrom(input);
  p.pumpT += h;
  if (p.pump) {
    updatePump(st, h, input, want);
  } else {
    // 펌프를 쏘기 시작
    if (input.pump && p.pumpT > 0.12) startPump(st);
  }
  if (!p.pump) movePlayer(st, h, want);
  // 파낸 칸: 중심이 닿은 칸은 터널이 된다
  const [pc, pr] = nearCell(p);
  if (inside(pc, pr) && st.dirt[pr][pc] && !rock(st, pc, pr)) { st.dirt[pr][pc] = false; emit(st, { t: 'dig', c: pc, r: pr }); }

  // ---- 바위 ----
  updateRocks(st, h);

  // ---- 적 ----
  st.distT -= h;
  if (st.distT <= 0) { st.dist = distField(st, pc, pr); st.distT = 0.25; }
  const left = st.enemies.filter((e) => e.alive).length;
  const speedUp = 1 + 0.05 * (st.enemies0 - left);
  for (const e of st.enemies) if (e.alive) updateEnemy(st, e, h, speedUp, left);
  st.enemies = st.enemies.filter((e) => e.alive);
  updateFlames(st, h);

  // ---- 보너스 채소 ----
  for (const it of st.items) it.age += h;
  st.items = st.items.filter((it) => it.age < it.life && !it.taken);
  if (p.alive) for (const it of st.items) if (Math.abs(p.x - it.x) < 0.7 && Math.abs(p.y - it.y) < 0.7) { it.taken = true; addScore(st, it.pts); emit(st, { t: 'veg', pts: it.pts, type: it.type, x: it.x, y: it.y }); }
  st.items = st.items.filter((it) => !it.taken);

  // ---- 판 깨기 ----
  if (st.phase === 'play' && st.enemies.length === 0) {
    st.phase = 'clear'; st.phaseT = 2.6;
    emit(st, { t: 'clear', round: st.round });
  }
}

// ---- 이동 ----
function movePlayer(st, h, want) {
  const p = st.player;
  if (!p.alive) return;
  // 길 한가운데서 반대쪽으로는 바로 돌아선다
  if (want !== null && p.dir >= 0 && !atCenter(p) && want === (p.dir + 2) % 4) p.dir = want;
  // 가까운 칸 중심이면(0.3 이내) 옆으로 꺾을 수 있다
  if (want !== null && p.dir >= 0 && !atCenter(p) && (want % 2) !== (p.dir % 2)) {
    const along = p.dir % 2 === 0 ? p.y : p.x;
    const off = Math.abs(along - Math.round(along));
    if (off < 0.3) { if (p.dir % 2 === 0) p.y = Math.round(p.y); else p.x = Math.round(p.x); p.dir = want; }
  }
  if (want === null && !atCenter(p)) { /* 멈춘다: 칸 중간에 서 있어도 된다 */ p.dir = -1; return; }
  const can = (e, d) => { const nx = Math.round(e.x) + DX[d], ny = Math.round(e.y) + DY[d]; return inside(nx, ny) && !rock(st, nx, ny); };
  if (p.dir < 0 && !atCenter(p) && want !== null) {                           // 칸 중간에 서 있다가 다시 출발: 같은 줄이면 그대로, 아니면 가까운 칸 중심으로 맞춘다
    const offX = !isInt(p.x);
    if ((offX && want % 2 === 1) || (!offX && want % 2 === 0)) p.dir = want;
    else { p.x = Math.round(p.x); p.y = Math.round(p.y); }
  }
  glide(p, PLAYER_SPEED * h * (want === null && p.dir < 0 ? 0 : 1), (e) => {
    if (want !== null && can(e, want)) e.dir = want; else if (want === null) e.dir = -1;
    else if (!can(e, e.dir >= 0 ? e.dir : want)) e.dir = -1;
  }, can);
  if (p.dir >= 0) p.face = DX[p.dir] !== 0 ? DX[p.dir] : p.face;
  if (p.dir >= 0) p.faceDir = p.dir;
}

// ---- 펌프 ----
function startPump(st) {
  const p = st.player;
  if (!p.alive) return;
  const dir = p.faceDir !== undefined ? p.faceDir : (p.face > 0 ? 1 : 3);
  p.pump = { dir, len: 0, state: 'shoot', target: null, idle: 0 };
  p.dir = -1;
  emit(st, { t: 'pump' });
}
function updatePump(st, h, input, want) {
  const p = st.player, pu = p.pump;
  if (want !== null && pu.state !== 'retract') { pu.state = 'retract'; if (pu.target) { pu.target.held = false; pu.target.deflateT = DEFLATE_EVERY; } pu.target = null; }
  if (pu.state === 'shoot') {
    pu.len += PUMP_SPEED * h;
    const px = p.x + DX[pu.dir] * pu.len, py = p.y + DY[pu.dir] * pu.len;
    // 흙을 만나면 거기서 멈춘다
    const bc = Math.round(p.x + DX[pu.dir] * (pu.len + 0.5)), br = Math.round(p.y + DY[pu.dir] * (pu.len + 0.5));
    if (!inside(bc, br) || st.dirt[br][bc] || rock(st, bc, br)) { pu.state = 'retract'; return; }
    for (const e of st.enemies) {
      if (!e.alive || e.state === 'ghost') continue;
      const along = (e.x - p.x) * DX[pu.dir] + (e.y - p.y) * DY[pu.dir], across = Math.abs((e.x - p.x) * DY[pu.dir]) + Math.abs((e.y - p.y) * DX[pu.dir]);
      if (along > 0.2 && along <= pu.len + 0.4 && across < 0.55) {
        pu.state = 'hold'; pu.target = e; pu.len = Math.min(pu.len, along); pu.idle = 0;
        e.held = true; e.dir = -1; e.deflateT = 0;
        emit(st, { t: 'hook', x: e.x, y: e.y });
        pumpEnemy(st, e, 1);                                                  // 맞은 순간 한 번 부푼다
        return;
      }
    }
    void px; void py;
    if (pu.len >= PUMP_REACH) pu.state = 'retract';
  } else if (pu.state === 'hold') {
    const e = pu.target;
    if (!e || !e.alive) { pu.state = 'retract'; return; }
    pu.idle += h;
    if (input.pump) {
      p.pumpAcc = (p.pumpAcc || 0) + h;
      if (p.pumpAcc >= PUMP_EVERY) { p.pumpAcc = 0; pu.idle = 0; pumpEnemy(st, e, 1); }
    } else p.pumpAcc = PUMP_EVERY * 0.7;
    if (pu.idle > PUMP_HOLD) { pu.state = 'retract'; e.held = false; e.deflateT = DEFLATE_EVERY; pu.target = null; }
    if (pu.state === 'hold' && e.alive && e.inflate >= POP_AT) pu.state = 'retract';
  } else {                                                                    // retract
    pu.len -= PUMP_SPEED * 1.4 * h;
    if (pu.len <= 0) { p.pump = null; p.pumpT = 0; p.pumpAcc = 0; }
  }
}
function pumpEnemy(st, e, n) {
  e.inflate += n;
  emit(st, { t: 'inflate', x: e.x, y: e.y, n: e.inflate });
  if (e.inflate >= POP_AT) {
    const p = st.player, pu = p.pump;
    const horizontal = pu ? DX[pu.dir] !== 0 : false;
    popEnemy(st, e, horizontal);
  }
}

// ---- 바위 ----
function updateRocks(st, h) {
  for (const k of st.rocks) {
    if (k.state === 'gone') continue;
    const bc = Math.round(k.x), br = Math.round(k.y);
    if (k.state === 'still') {
      // 아래 칸이 비고 내 캐릭터가 거기 없으면 흔들리기 시작한다
      const belowOpen = br + 1 < ROWS && !st.dirt[br + 1][bc];
      const pOnBelow = st.player.alive && Math.abs(st.player.x - bc) < 0.6 && Math.abs(st.player.y - (br + 1)) < 0.6;
      if (belowOpen && !pOnBelow) { k.state = 'wobble'; k.t = 0; }
    } else if (k.state === 'wobble') {
      k.t += h;
      if (k.t >= ROCK_WOBBLE) { k.state = 'fall'; k.vy = 1; k.t = 0; k.fell = true; st.dirt[br][bc] = false; }
    } else if (k.state === 'fall') {
      k.vy = Math.min(9, k.vy + ROCK_G * h);
      let rem = k.vy * h;
      while (rem > 1e-9 && k.state === 'fall') {                               // 칸 중심에서 아래가 흙이면 멈춘다
        if (isInt(k.y)) {
          const r = Math.round(k.y);
          if (r + 1 >= ROWS || st.dirt[r + 1][bc]) { k.y = r; k.state = 'broken'; k.t = 0; break; }
          const s = Math.min(rem, 1); k.y += s; rem -= s;
        } else {
          const s = Math.min(rem, Math.ceil(k.y) - k.y); k.y += s; rem -= s;
        }
        if (isInt(k.y)) k.y = Math.round(k.y);
      }
      // 깔린다
      for (const e of st.enemies) {
        if (e.alive && !e.crushedBy && Math.abs(e.x - bc) < 0.7 && Math.abs(e.y - k.y) < 0.75) { e.alive = false; e.crushedBy = k.id; k.crushed++; }
      }
      const p = st.player;
      if (p.alive && Math.abs(p.x - bc) < 0.6 && Math.abs(p.y - k.y) < 0.7) killPlayer(st, 'rock');
      if (k.state === 'broken') finishRock(st, k);
    } else if (k.state === 'broken') {
      k.t += h;
      if (k.t > 0.6) k.state = 'gone';
    }
  }
}
function finishRock(st, k) {
  if (k.crushed) {
    const pts = CRUSH_POINTS[Math.min(CRUSH_POINTS.length, k.crushed) - 1];
    addScore(st, pts);
    st.stats.crushes += k.crushed;
    emit(st, { t: 'crush', x: k.x, y: k.y, n: k.crushed, pts });
  }
  emit(st, { t: 'rockLanded', x: k.x, y: k.y });
  st.dropped++;
  const c = Math.round(k.x), r = Math.round(k.y);
  st.dirt[r][c] = false;
  if (st.dropped >= 2 && !st.vegSpawned) spawnVeg(st);
}
function spawnVeg(st) {
  st.vegSpawned = true;
  const [type, pts] = vegFor(st.round);
  const x = 7, y = 8;
  st.dirt[y][x] = false;
  st.items.push({ x, y, type, pts, age: 0, life: 9 });
  emit(st, { t: 'vegAppear', type });
}

// ---- 적 ----
function enemySpeed(e, st, speedUp) {
  const base = e.kind === 'fygar' ? 2.3 : 2.5;
  return base * speedMul(st.round) * speedUp;
}
function updateEnemy(st, e, h, speedUp, left) {
  const p = st.player;
  e.anim += h;
  // 부푼 채로 붙들려 있거나 풀리는 중
  if (e.held) return;
  if (e.inflate > 0) {
    e.deflateT -= h;
    if (e.deflateT <= 0) { e.inflate--; e.deflateT = DEFLATE_EVERY; }
    return;
  }
  // 마지막 한 마리는 땅 위로 도망친다
  if (left === 1 && e.state !== 'flee' && st.phase === 'play') { e.state = 'flee'; emit(st, { t: 'flee' }); }
  if (e.state === 'flee') {
    const tx = e.x < COLS / 2 ? -0.5 : COLS - 0.5;
    if (e.y > 0.01) { e.y = Math.max(0, e.y - 2.4 * speedUp * h); e.x += Math.sign(isInt(e.x) ? 0 : 0) * h; }
    else { e.y = 0; e.x += Math.sign(tx - e.x) * 3.5 * h; if (e.x < -0.4 || e.x > COLS - 0.6) { e.alive = false; emit(st, { t: 'escaped' }); } }
    return;
  }
  if (e.state === 'ghost') {
    e.ghostT += h;
    const tx = p.x - e.x, ty = p.y - e.y, d = Math.hypot(tx, ty) || 1;
    const sp = enemySpeed(e, st, speedUp) * GHOST_SPEED;
    e.x += tx / d * sp * h; e.y += ty / d * sp * h;
    e.y = Math.max(0, Math.min(ROWS - 1, e.y)); e.x = Math.max(0, Math.min(COLS - 1, e.x));
    const [c, r] = nearCell(e);
    const inTunnel = isOpen(st, c, r) && Math.abs(e.x - c) < 0.15 && Math.abs(e.y - r) < 0.15;
    if (e.ghostT > 1.2 && inTunnel) { e.state = 'walk'; e.x = c; e.y = r; e.dir = -1; e.ghostNext = ghostDelay(st, 0.8); e.stuck = 0; e.ghostT = 0; }
    else if (d < 0.4 && e.ghostT > 0.6) { e.state = 'walk'; e.x = Math.round(e.x); e.y = Math.round(e.y); e.dir = -1; st.dirt[Math.round(e.y)][Math.round(e.x)] = false; e.ghostT = 0; }
    if (e.state === 'ghost' && !p.alive) return;
    return;
  }
  // 걷기: 터널을 따라 내 캐릭터 쪽으로
  e.ghostNext -= h;
  const [pc, pr] = nearCell(p);
  const reach = st.dist && st.dist[Math.round(e.y) * COLS + Math.round(e.x)] >= 0;
  if (!reach) e.stuck += h; else e.stuck = 0;
  if (e.stuck > Math.max(3.5, 6 - 0.25 * st.round) || e.ghostNext <= 0) { e.state = 'ghost'; e.ghostT = 0; e.ghostNext = 99; return; }
  // 파이가(용)는 일직선으로 마주 보면 불을 뿜는다
  if (e.kind === 'fygar') {
    e.fireCd -= h;
    if (e.charge > 0) { e.charge -= h; if (e.charge <= 0) { startFlame(st, e); } return; }
    if (e.fireCd <= 0 && p.alive && Math.abs(p.y - e.y) < 0.4 && Math.abs(p.x - e.x) <= FIRE_LEN + 0.5 && e.state === 'walk') {
      const dir = p.x > e.x ? 1 : 3;
      let clear = true;
      for (let c = Math.round(e.x) + DX[dir]; c !== Math.round(p.x) + DX[dir] && c >= 0 && c < COLS; c += DX[dir]) if (st.dirt[Math.round(e.y)][c]) { clear = false; break; }
      if (clear) { e.face = DX[dir]; e.charge = FIRE_CHARGE; e.fireCd = 3.5 + st.rand() * 2.5; e.dir = -1; emit(st, { t: 'fireCharge', x: e.x, y: e.y }); return; }
    }
  }
  const dist = enemySpeed(e, st, speedUp) * h;
  glide(e, dist, (m) => {
    const opts = [0, 1, 2, 3].filter((d) => isOpen(st, Math.round(m.x) + DX[d], Math.round(m.y) + DY[d]) && !rock(st, Math.round(m.x) + DX[d], Math.round(m.y) + DY[d]));
    const back = (m.dir + 2) % 4;
    let ways = opts.filter((d) => d !== back || m.dir < 0);
    if (!ways.length) ways = opts;
    if (!ways.length) { m.dir = -1; return; }
    let best = ways[0], bd = 1e9;
    for (const d of ways) {
      const k = (Math.round(m.y) + DY[d]) * COLS + (Math.round(m.x) + DX[d]);
      const v = st.dist && st.dist[k] >= 0 ? st.dist[k] : 1e8;
      if (v < bd || (v === bd && st.rand() < 0.5)) { bd = v; best = d; }
    }
    m.dir = st.rand() < 0.1 ? ways[Math.floor(st.rand() * ways.length)] : best;
  }, (m, d) => isOpen(st, Math.round(m.x) + DX[d], Math.round(m.y) + DY[d]) && !rock(st, Math.round(m.x) + DX[d], Math.round(m.y) + DY[d]));
  if (e.dir >= 0 && DX[e.dir] !== 0) e.face = DX[e.dir];
  // 닿으면 잡힌다
  if (p.alive && Math.abs(p.x - e.x) < 0.7 && Math.abs(p.y - e.y) < 0.7) killPlayer(st, 'enemy');
}
function startFlame(st, e) {
  const dir = e.face > 0 ? 1 : 3;
  const r = Math.round(e.y), c0 = Math.round(e.x);
  let len = 0;
  for (let i = 1; i <= FIRE_LEN; i++) { const c = c0 + DX[dir] * i; if (!inside(c, r) || st.dirt[r][c]) break; len = i; }
  st.flames.push({ owner: e.id, x: c0, y: r, dir, len, t: 0, life: FIRE_TIME });
  emit(st, { t: 'fire', x: e.x, y: e.y });
}
function updateFlames(st, h) {
  const p = st.player;
  for (const f of st.flames) {
    f.t += h;
    if (!p.alive) continue;
    for (let i = 1; i <= f.len; i++) if (Math.abs(p.x - (f.x + DX[f.dir] * i)) < 0.65 && Math.abs(p.y - f.y) < 0.6) { killPlayer(st, 'fire'); break; }
  }
  st.flames = st.flames.filter((f) => f.t < f.life);
}

return {
  __enemySpeed: enemySpeed, __ghostDelay: ghostDelay,
  COLS, ROWS, DX, DY, START_LIVES, PLAYER_SPEED, PLAYER_START, PUMP_REACH, POP_AT, LAYER_POINTS, CRUSH_POINTS, VEG, FIRE_LEN, POCKETS,
  rng, newGame, makeRound, step, layerOf, vegFor, enemyCounts, distField, isOpen, popEnemy, spawnVeg, newEnemy, finishRock, killPlayer,
};
})();
if (typeof module !== 'undefined') module.exports = LOGIC_DIGDUG;
