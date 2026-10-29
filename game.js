'use strict';
// 오락실 튜토리얼이 '진짜로 일어난 일'을 알아채는 신호 (arcade/public/tutorial.js 가 듣는다. 튜토리얼이 아니면 아무도 안 듣는다)
const tutorialSignal = (type) => window.dispatchEvent(new CustomEvent('arcade:tutorial', { detail: { type } }));

// 디그더그: 화면·입력·소리. 규칙(땅 파기·펌프·적·바위·채소)은 logic.js (LOGIC_DIGDUG) 에 있고,
// 여기서는 규칙이 남긴 st.events 를 보고 소리·효과·안내를 만든다.
const L = LOGIC_DIGDUG;
const { COLS, ROWS, DX, DY } = L;
const CELL = 16, HUD = 16;
const W = COLS * CELL, FH = ROWS * CELL, CH = FH + HUD;     // 224 x 256

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

function fit() {
  const controls = $('controls');
  const ctrlH = getComputedStyle(controls).display === 'none' ? 0 : controls.offsetHeight + 10;
  const scale = Math.min((innerWidth - 16) / W, (innerHeight - 16 - ctrlH) / CH);
  const cssW = Math.max(160, Math.floor(W * scale)), cssH = Math.floor(cssW * CH / W);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(canvas.width / W, 0, 0, canvas.height / CH, 0, 0);
  ctx.imageSmoothingEnabled = false;
}
addEventListener('resize', fit);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
};

// ---------- 소리 ----------
let audio = null;
let muted = store.get('digdugMuted') === '1';
function tone(freq, dur, type = 'square', vol = 0.045, slide = 0) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur);
  } catch (_) {}
}
function noise(dur, vol = 0.08, lowpass = 1500) {
  if (muted) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const n = Math.floor(audio.sampleRate * dur), buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = audio.createBufferSource(), g = audio.createGain(), f = audio.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = lowpass; g.gain.value = vol;
    s.buffer = buf; s.connect(f).connect(g).connect(audio.destination); s.start();
  } catch (_) {}
}
const melody = (notes, step, type = 'square', vol = 0.05) => notes.forEach((f, i) => { if (f) setTimeout(() => tone(f, step * 0.9 / 1000, type, vol), i * step); });
let walkTick = 0;
const sfx = {
  step: () => { if ((walkTick++ & 3) === 0) tone(220 + (walkTick & 4 ? 40 : 0), 0.05, 'triangle', 0.03); },
  pump: () => tone(500, 0.07, 'sine', 0.05, -200),
  inflate: (n) => tone(260 + n * 90, 0.12, 'sawtooth', 0.05, 200),
  pop: () => { noise(0.25, 0.1, 1400); tone(500, 0.18, 'square', 0.05, -380); },
  crush: () => { noise(0.4, 0.12, 700); tone(130, 0.35, 'sawtooth', 0.06, -60); },
  dead: () => melody([523, 392, 330, 262, 196, 165], 120, 'sawtooth', 0.06),
  fire: () => noise(0.5, 0.07, 2500),
  veg: () => melody([880, 1175, 1568, 2093], 70, 'sine', 0.07),
  life: () => melody([1047, 1319, 1568, 2093], 90, 'square', 0.05),
  start: () => melody([392, 523, 659, 784], 110),
  clear: () => melody([523, 659, 784, 1047, 1319], 100),
  over: () => melody([392, 330, 262, 196], 220, 'sawtooth', 0.06),
  thud: () => { noise(0.18, 0.09, 600); tone(110, 0.2, 'sine', 0.06, -40); },
};

// ---------- 상태 ----------
let G = L.newGame();
let state = 'title';                           // title · play · paused · over
let pausedFrom = null;
let best = Number(store.get('digdugBest')) || 0;
let fxs = [];
let banner = { text: '', sub: '', t: 0, color: '#ffe14a' };
let clock = 0, lastPos = null, moved = 0;

/* @test-hooks:start */
window.__dd = { get G() { return G; }, get state() { return state; }, L, setG(g) { G = g; }, step: (dt) => update(dt) };
/* @test-hooks:end */

// ---------- 입력 ----------
const held = [];                               // 누르고 있는 방향 키 (나중에 누른 것이 우선)
const KEY_DIR = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 };
const PUMP_KEYS = [' ', 'z', 'Z', 'x', 'X', 'j', 'J'];
let pumpKey = false, pumpTouch = false, padDir = null;
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key in KEY_DIR) { e.preventDefault(); const d = KEY_DIR[e.key]; const i = held.indexOf(d); if (i >= 0) held.splice(i, 1); held.push(d); return; }
  if (PUMP_KEYS.includes(e.key)) {
    e.preventDefault();
    if (state === 'title' || state === 'over') { if (!e.repeat && e.key === ' ') onOverlayButton(); return; }
    if (state === 'paused') { if (!e.repeat) resume(); return; }
    pumpKey = true;
    return;
  }
  if (e.key === 'Enter') { if (state === 'title' || state === 'over') onOverlayButton(); else if (state === 'paused') resume(); return; }
  if (e.key === 'p' || e.key === 'P') { if (state === 'paused') resume(); else pause(); }
  else if (e.key === 'm' || e.key === 'M') toggleMute();
});
addEventListener('keyup', (e) => {
  if (e.key in KEY_DIR) { const i = held.indexOf(KEY_DIR[e.key]); if (i >= 0) held.splice(i, 1); }
  if (PUMP_KEYS.includes(e.key)) pumpKey = false;
});

const pad = $('pad');
const PAD_DIRS = [0, 2, 3, 1];                  // 화면의 ▲ ▼ ◀ ▶ 가 가리키는 방향
function padFrom(e) {
  const r = pad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const knob = pad.querySelector('b'), lim = r.width * 0.2;
  knob.style.transform = `translate(${Math.max(-lim, Math.min(lim, dx))}px, ${Math.max(-lim, Math.min(lim, dy))}px)`;
  padDir = Math.max(Math.abs(dx), Math.abs(dy)) < r.width * 0.12 ? null : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
  pad.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', padDir !== null && PAD_DIRS[i] === padDir));
}
const padEnd = () => { padDir = null; pad.querySelector('b').style.transform = ''; pad.querySelectorAll('i').forEach((el) => el.classList.remove('on')); };
pad.addEventListener('pointerdown', (e) => { e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch (_) {} padFrom(e); });
pad.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') padFrom(e); });
pad.addEventListener('pointerup', padEnd);
pad.addEventListener('pointercancel', padEnd);
const pumpBtn = $('pumpBtn');
pumpBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); try { pumpBtn.setPointerCapture(e.pointerId); } catch (_) {} pumpTouch = true; pumpBtn.classList.add('on'); });
const pumpOff = () => { pumpTouch = false; pumpBtn.classList.remove('on'); };
pumpBtn.addEventListener('pointerup', pumpOff);
pumpBtn.addEventListener('pointercancel', pumpOff);

function readInput() {
  const d = padDir !== null ? padDir : held.length ? held[held.length - 1] : null;
  return { dx: d === 1 ? 1 : d === 3 ? -1 : 0, dy: d === 2 ? 1 : d === 0 ? -1 : 0, pump: pumpKey || pumpTouch };
}

// ---------- 흐름 ----------
function showOverlay(html) { const o = $('overlay'); o.innerHTML = html; o.classList.remove('hidden'); o.querySelector('button').onclick = onOverlayButton; }
function hideOverlay() { $('overlay').classList.add('hidden'); }
function setBanner(text, sub = '', color = '#ffe14a', t = 2.2) { banner = { text, sub, t, color }; }
function startGame() {
  G = L.newGame();
  fxs = []; held.length = 0; lastPos = null; moved = 0;
  state = 'play';
  setBanner('ROUND 1', 'GET READY');
  hideOverlay();
  sfx.start();
}
function onOverlayButton() { if (state === 'paused') resume(); else startGame(); }
function pause() {
  if (state !== 'play') return;
  pausedFrom = state; state = 'paused';
  showOverlay('<h2>일시정지</h2><p>P 키나 아래 버튼으로 계속해요</p><button id="startBtn">계속하기</button>');
}
function resume() { if (state !== 'paused') return; state = pausedFrom; hideOverlay(); }
function gameOver() {
  state = 'over';
  const rec = G.score > best;
  if (rec) { best = G.score; store.set('digdugBest', String(best)); }
  sfx.over();
  showOverlay(`<h2>GAME OVER</h2><p class="big">${G.score.toLocaleString()}점</p><p>${G.round}라운드 · 터뜨린 적 ${G.stats.pops}마리 · 바위로 ${G.stats.crushes}마리${rec ? '<br>🏆 최고 기록!' : ''}</p><button id="startBtn">다시 하기</button>`);
}

function handleEvents() {
  for (const e of G.events) {
    if (e.t === 'dig') sfx.step();
    else if (e.t === 'pump') { sfx.pump(); tutorialSignal('pump'); }
    else if (e.t === 'hook') tutorialSignal('hook');
    else if (e.t === 'inflate') sfx.inflate(e.n);
    else if (e.t === 'pop') {
      sfx.pop(); tutorialSignal('pop');
      fxs.push({ kind: 'burst', x: e.x, y: e.y, t: 0, life: 0.4 }, { kind: 'text', x: e.x, y: e.y, t: 0, life: 1, text: String(e.pts) });
    }
    else if (e.t === 'crush') { sfx.crush(); tutorialSignal('crush'); fxs.push({ kind: 'text', x: e.x, y: e.y, t: 0, life: 1.2, text: String(e.pts), color: '#ffe14a' }); }
    else if (e.t === 'rockLanded') { sfx.thud(); fxs.push({ kind: 'dust', x: e.x, y: e.y, t: 0, life: 0.5 }); }
    else if (e.t === 'dead') { sfx.dead(); fxs.push({ kind: 'burst', x: e.x, y: e.y, t: 0, life: 0.6 }); }
    else if (e.t === 'fireCharge') { /* 불 뿜기 전에 깜빡인다 (그림에서 처리) */ }
    else if (e.t === 'fire') sfx.fire();
    else if (e.t === 'vegAppear') { setBanner('보너스!', '채소를 먹어요', '#7fe08a', 1.6); sfx.veg(); }
    else if (e.t === 'veg') { sfx.veg(); tutorialSignal('pickup'); fxs.push({ kind: 'text', x: e.x, y: e.y, t: 0, life: 1.2, text: String(e.pts), color: '#7fe0ff' }); }
    else if (e.t === 'flee') setBanner('마지막 한 마리가 도망쳐요!', '', '#ffb04a', 1.8);
    else if (e.t === 'extraLife') sfx.life();
    else if (e.t === 'clear') { sfx.clear(); setBanner('ROUND CLEAR', '', '#7fe08a', 2.4); }
    else if (e.t === 'round') { if (e.round > 1) { setBanner(`ROUND ${e.round}`, 'GET READY'); sfx.start(); } }
    else if (e.t === 'over') gameOver();
  }
}

function update(dt) {
  clock += dt;
  if (state !== 'play') return;
  L.step(G, dt, readInput());
  handleEvents();
  const p = G.player;
  if (lastPos) moved += Math.abs(p.x - lastPos[0]) + Math.abs(p.y - lastPos[1]);
  lastPos = [p.x, p.y];
  if (moved >= 1.5) { moved = 0; tutorialSignal('move'); }
  banner.t = Math.max(0, banner.t - dt);
  for (const f of fxs) f.t += dt;
  fxs = fxs.filter((f) => f.t < f.life);
}

// ---------- 그리기 ----------
const LAYER_COLORS = [['#e8c43a', '#c8a020'], ['#e88a2a', '#c0681a'], ['#c8502a', '#9a3418'], ['#962828', '#701818']];
const cx = (c) => c * CELL, cy = (r) => HUD + r * CELL;
function drawField() {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, CH);
  // 하늘
  ctx.fillStyle = '#58b8f0'; ctx.fillRect(0, HUD, W, CELL);
  ctx.fillStyle = '#fff'; ctx.fillRect(20, HUD + 3, 22, 5); ctx.fillRect(26, HUD + 1, 12, 4); ctx.fillRect(150, HUD + 5, 24, 5); ctx.fillRect(158, HUD + 2, 12, 4);
  ctx.fillStyle = '#3aa43a'; ctx.fillRect(0, HUD + CELL - 3, W, 3);
  // 흙
  for (let r = 1; r < ROWS; r++) {
    const [a, b] = LAYER_COLORS[L.layerOf(r)];
    for (let c = 0; c < COLS; c++) {
      if (!G.dirt[r][c]) { ctx.fillStyle = '#000'; ctx.fillRect(cx(c), cy(r), CELL, CELL); continue; }
      ctx.fillStyle = a; ctx.fillRect(cx(c), cy(r), CELL, CELL);
      ctx.fillStyle = b; ctx.fillRect(cx(c) + 3 + ((r * 7 + c * 3) % 5), cy(r) + 3, 2, 2); ctx.fillRect(cx(c) + 9, cy(r) + 8 + ((c + r) % 3), 2, 2); ctx.fillRect(cx(c) + 2, cy(r) + 11, 3, 2);
      // 터널과 닿는 쪽은 얇은 가장자리
      ctx.fillStyle = b;
      if (r > 0 && !G.dirt[r - 1][c] && r - 1 > 0) ctx.fillRect(cx(c), cy(r), CELL, 1);
      if (c > 0 && !G.dirt[r][c - 1]) ctx.fillRect(cx(c), cy(r), 1, CELL);
    }
  }
}
function drawRock(k) {
  if (k.state === 'gone') return;
  const x = cx(k.x) + CELL / 2 + (k.state === 'wobble' ? Math.sin(clock * 50) * 1.2 : 0), y = cy(k.y) + CELL / 2 + 1;
  ctx.globalAlpha = k.state === 'broken' ? Math.max(0, 1 - k.t / 0.6) : 1;
  ctx.fillStyle = '#8a8a96'; ctx.beginPath(); ctx.ellipse(x, y, 7.5, 7, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#b4b4c0'; ctx.beginPath(); ctx.ellipse(x - 2, y - 3, 3.5, 2.5, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#5a5a66'; ctx.fillRect(x + 1, y + 1, 4, 2); ctx.fillRect(x - 5, y + 3, 3, 2);
  ctx.globalAlpha = 1;
}
function drawPlayer() {
  const p = G.player;
  if (!p.alive) return;
  if (p.invuln > 0 && Math.floor(clock * 14) % 2 === 0) return;
  const x = cx(p.x) + CELL / 2, y = cy(p.y) + CELL / 2;
  const fd = p.pump ? p.pump.dir : p.faceDir !== undefined ? p.faceDir : 1;
  ctx.save();
  ctx.translate(x, y);
  if (fd === 3) ctx.scale(-1, 1);
  if (fd === 0) ctx.rotate(-Math.PI / 2);
  if (fd === 2) ctx.rotate(Math.PI / 2);
  const step = Math.floor(clock * 12) % 2;
  ctx.fillStyle = '#2a55c8'; ctx.fillRect(-6, -2, 10, 8);                    // 몸
  ctx.fillStyle = '#f2f2f2'; ctx.fillRect(-4, -8, 9, 8);                     // 머리(헬멧)
  ctx.fillStyle = '#e8453a'; ctx.fillRect(-4, -8, 9, 3);
  ctx.fillStyle = '#ffd0a0'; ctx.fillRect(1, -5, 4, 4);                      // 얼굴
  ctx.fillStyle = '#111'; ctx.fillRect(3, -4, 1, 1);
  ctx.fillStyle = '#ddd'; ctx.fillRect(5, 0, 4, 2);                          // 펌프 노즐
  ctx.fillStyle = '#e8c83a'; ctx.fillRect(-5 + step, 6, 4, 2); ctx.fillRect(0 - step, 6, 4, 2);
  ctx.restore();
  // 펌프 호스와 화살촉
  const pu = p.pump;
  if (pu && pu.len > 0) {
    const ex = x + DX[pu.dir] * pu.len * CELL, ey = y + DY[pu.dir] * pu.len * CELL;
    ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + DX[pu.dir] * 8, y + DY[pu.dir] * 8); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.fillStyle = '#e8453a'; ctx.fillRect(ex - 2, ey - 2, 5, 5);
  }
}
function drawEnemy(e) {
  const x = cx(e.x) + CELL / 2, y = cy(e.y) + CELL / 2;
  if (e.state === 'ghost') {                                                   // 눈만 보인다
    ctx.fillStyle = '#fff'; ctx.fillRect(x - 6, y - 3, 5, 6); ctx.fillRect(x + 1, y - 3, 5, 6);
    ctx.fillStyle = '#111'; ctx.fillRect(x - 4, y - 1, 2, 3); ctx.fillRect(x + 3, y - 1, 2, 3);
    return;
  }
  const s = 1 + 0.3 * e.inflate;
  ctx.save();
  ctx.translate(x, y); ctx.scale(s * (e.face < 0 ? -1 : 1), s);
  const blink = e.charge > 0 && Math.floor(clock * 16) % 2 === 0;
  if (e.kind === 'pooka') {
    ctx.fillStyle = '#e8453a'; ctx.beginPath(); ctx.ellipse(0, 0, 7, 6.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffe14a'; ctx.fillRect(-7, -1, 3, 3); ctx.fillRect(4, -1, 3, 3);                       // 발
    ctx.fillStyle = '#fff'; ctx.fillRect(-1, -4, 7, 5);                                                     // 고글
    ctx.fillStyle = '#3a8aff'; ctx.fillRect(0, -3, 5, 3);
    ctx.fillStyle = '#111'; ctx.fillRect(3, -3, 2, 2);
  } else {
    ctx.fillStyle = blink ? '#ffb04a' : '#3ab43a'; ctx.beginPath(); ctx.ellipse(-1, 0, 7, 6, 0, 0, 7); ctx.fill();
    ctx.fillStyle = blink ? '#ffe14a' : '#58d458'; ctx.fillRect(2, -5, 6, 6);                                // 머리
    ctx.fillStyle = '#e8453a'; ctx.fillRect(-6, -7, 3, 3); ctx.fillRect(-2, -8, 3, 3);                       // 등 가시
    ctx.fillStyle = '#fff'; ctx.fillRect(4, -4, 3, 3); ctx.fillStyle = '#111'; ctx.fillRect(5, -3, 1, 2);
    ctx.fillStyle = '#e8c83a'; ctx.fillRect(-5, 5, 3, 2); ctx.fillRect(1, 5, 3, 2);
  }
  ctx.restore();
}
function drawFlames() {
  for (const f of G.flames) {
    const k = Math.min(1, f.t / 0.18);
    for (let i = 1; i <= f.len; i++) {
      const x = cx(f.x + DX[f.dir] * i) + (f.dir === 1 ? 0 : CELL), y = cy(f.y) + CELL / 2;
      const len = CELL * Math.min(1, k * f.len - (i - 1));
      if (len <= 0) continue;
      ctx.fillStyle = Math.floor(clock * 16) % 2 ? '#ff6a2a' : '#ffc02a';
      ctx.beginPath();
      ctx.moveTo(x, y - 6 + (i * 1)); ctx.lineTo(x + DX[f.dir] * len, y); ctx.lineTo(x, y + 6 - (i * 1)); ctx.closePath(); ctx.fill();
    }
  }
}
const VEG_EMOJI = { carrot: '🥕', turnip: '🧅', mushroom: '🍄', cucumber: '🥒', eggplant: '🍆', pepper: '🫑', tomato: '🍅', garlic: '🧄', pineapple: '🍍' };
function drawItems() {
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px sans-serif';
  for (const it of G.items) { if (it.life - it.age < 2 && Math.floor(clock * 8) % 2 === 0) continue; ctx.fillText(VEG_EMOJI[it.type] || '⭐', cx(it.x) + CELL / 2, cy(it.y) + CELL / 2 + 1); }
}
function drawFx() {
  for (const f of fxs) {
    const k = f.t / f.life, x = cx(f.x) + CELL / 2, y = cy(f.y) + CELL / 2;
    if (f.kind === 'burst') { ctx.fillStyle = `rgba(255,${200 - 120 * k | 0},60,${1 - k})`; ctx.beginPath(); ctx.arc(x, y, 5 + k * 12, 0, 7); ctx.fill(); }
    else if (f.kind === 'dust') { ctx.fillStyle = `rgba(230,210,170,${0.8 - 0.8 * k})`; for (let i = 0; i < 5; i++) ctx.fillRect(x + (i - 2) * 6 * (0.5 + k) - 1, y + 6 - k * 6 - (i % 2) * 3, 3, 3); }
    else if (f.kind === 'text') { ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = f.color || '#fff'; ctx.fillText(f.text, x, y - 6 - k * 12); }
  }
}
function drawHud() {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, HUD);
  ctx.textBaseline = 'middle'; ctx.font = 'bold 9px sans-serif';
  ctx.textAlign = 'left'; ctx.fillStyle = '#ff6a6a'; ctx.fillText('1UP', 4, 8); ctx.fillStyle = '#fff'; ctx.fillText(String(G.score), 24, 8);
  ctx.textAlign = 'center'; ctx.fillStyle = '#ff6a6a'; ctx.fillText('HI', 98, 8); ctx.fillStyle = '#fff'; ctx.fillText(String(Math.max(best, G.score)), 118, 8);
  ctx.textAlign = 'right'; ctx.fillStyle = '#7fe0ff'; ctx.fillText(`R${G.round}`, W - 52, 8);
  for (let i = 0; i < Math.max(0, G.lives - (G.player.alive ? 1 : 0)); i++) {
    ctx.fillStyle = '#f2f2f2'; ctx.fillRect(4 + i * 12, HUD + FH - 11, 7, 6); ctx.fillStyle = '#2a55c8'; ctx.fillRect(4 + i * 12, HUD + FH - 6, 7, 4);
  }
  for (let i = 0; i < Math.min(G.round, 9); i++) {                                       // 라운드 꽃
    ctx.fillStyle = '#ff6aa0'; ctx.fillRect(W - 8 - i * 7, HUD + 3, 4, 4); ctx.fillStyle = '#3aa43a'; ctx.fillRect(W - 7 - i * 7, HUD + 7, 2, 5);
  }
}
function draw() {
  drawField();
  for (const k of G.rocks) drawRock(k);
  drawItems();
  drawFlames();
  for (const e of G.enemies) drawEnemy(e);
  drawPlayer();
  drawFx();
  drawHud();
  if (banner.t > 0) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, HUD + FH / 2 - 26, W, banner.sub ? 38 : 24);
    ctx.fillStyle = banner.color; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(banner.text, W / 2, HUD + FH / 2 - 15);
    if (banner.sub) { ctx.font = 'bold 9px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(banner.sub, W / 2, HUD + FH / 2 + 1); }
  }
}

let last = 0;
function frame(ts) {
  const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
  last = ts;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });

function toggleMute() {
  muted = !muted;
  store.set('digdugMuted', muted ? '1' : '0');
  $('muteBtn').textContent = muted ? '🔇' : '🔊';
}
$('muteBtn').onclick = (e) => { e.currentTarget.blur(); toggleMute(); };
$('pauseBtn').onclick = (e) => { e.currentTarget.blur(); state === 'paused' ? resume() : pause(); };
$('startBtn').onclick = onOverlayButton;
$('muteBtn').textContent = muted ? '🔇' : '🔊';

fit();
requestAnimationFrame(frame);
