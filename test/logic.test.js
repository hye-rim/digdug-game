'use strict';
// 디그더그 규칙 시험. 실행: node --test
const test = require('node:test');
const assert = require('node:assert');
const L = require('../logic.js');

const DT = 1 / 60;
const NONE = { dx: 0, dy: 0, pump: false };
const run = (st, sec, inp = NONE) => { for (let t = 0; t < sec - 1e-9; t += DT) L.step(st, DT, inp); };
// 적과 바위가 없는 판 (한 마리를 따로 놓아 두어 저절로 끝나지 않게 한다)
function bare(seed = 1) {
  const st = L.newGame(L.rng(seed));
  st.enemies = []; st.rocks = []; st.items = [];
  st.player.invuln = 0;
  return st;
}
const parked = (st) => { const e = L.newEnemy(st, 'pooka', 0, 14); e.held = true; st.enemies.push(e); st.enemies0 = 4; return e; };   // 끝이 안 나게 붙들려 있는 적
const hole = (st, c0, c1, r) => { for (let c = c0; c <= c1; c++) st.dirt[r][c] = false; };
const addEnemy = (st, kind, x, y) => { const e = L.newEnemy(st, kind, x, y); st.enemies.push(e); st.enemies0 = Math.max(st.enemies0, st.enemies.length + 1); return e; };

test('a round: 14x15 field, open sky row, a short shaft, four pockets with enemies, 3 to 5 rocks over dirt', () => {
  for (let r = 1; r <= 8; r++) {
    const st = L.newGame(L.rng(r)); L.makeRound(st, r);
    assert.strictEqual(st.dirt.length, L.ROWS);
    assert.ok(st.dirt[0].every((x) => x === false), 'sky row is open');
    assert.ok(st.dirt[3].filter(Boolean).length > 8);
    assert.strictEqual(st.dirt[1][7], false); assert.strictEqual(st.dirt[2][7], false);
    for (const [c, rr] of st.pockets) { assert.strictEqual(st.dirt[rr][c], false); assert.strictEqual(st.dirt[rr][c - 1], false); }
    const cnt = L.enemyCounts(r);
    assert.strictEqual(st.enemies.length, cnt.pooka + cnt.fygar);
    assert.ok(st.rocks.length >= 3 && st.rocks.length <= 5);
    for (const k of st.rocks) { assert.strictEqual(st.dirt[k.y][k.x], true); assert.strictEqual(st.dirt[k.y + 1][k.x], true, 'dirt below'); }
  }
  assert.deepStrictEqual(L.enemyCounts(1), { pooka: 3, fygar: 1 });
  assert.ok(L.enemyCounts(20).pooka <= 5 && L.enemyCounts(20).fygar <= 4);
});

test('the dirt has four layers worth 200 300 400 500', () => {
  assert.deepStrictEqual([1, 4, 5, 8, 9, 11, 12, 14].map(L.layerOf), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.deepStrictEqual(L.LAYER_POINTS, [200, 300, 400, 500]);
});

test('walking digs a tunnel, and the character stops when nothing is pressed', () => {
  const st = bare(); parked(st);
  run(st, 0.8, { dx: 1, dy: 0, pump: false });
  assert.ok(st.player.x > 8 && st.player.x < 12);
  assert.strictEqual(st.dirt[2][8], false, 'dug through');
  const x1 = st.player.x;
  run(st, 0.5);
  assert.strictEqual(st.player.x, x1, 'stops');
  run(st, 10, { dx: 0, dy: 1, pump: false });
  assert.ok(st.player.y <= L.ROWS - 1 + 1e-9);
});

test('you can turn back anywhere and turn sideways near a cell center', () => {
  const st = bare(); parked(st);
  run(st, 0.3, { dx: 1, dy: 0, pump: false });
  const a = st.player.x;
  run(st, 0.15, { dx: -1, dy: 0, pump: false });
  assert.ok(st.player.x < a, 'turned around mid-cell');
  run(st, 1, { dx: 0, dy: 1, pump: false });
  assert.ok(st.player.y > 2.5, 'went down');
  assert.ok(Math.abs(st.player.x - Math.round(st.player.x)) < 1e-6, 'on a column');
});

test('the pump goes about 2.8 cells in the facing direction through tunnels and stops at dirt', () => {
  const st = bare(); parked(st);
  hole(st, 0, 13, 2);
  st.player.x = 2; st.player.y = 2; st.player.faceDir = 1;
  run(st, 0.2);
  L.step(st, DT, { dx: 0, dy: 0, pump: true });
  assert.ok(st.player.pump && st.player.pump.dir === 1);
  run(st, 0.1, { dx: 0, dy: 0, pump: true });
  assert.ok(st.player.pump.len > 0.5);
  run(st, 0.5, NONE);
  assert.strictEqual(st.player.pump, null, 'pulled back');
  const s2 = bare(); parked(s2);
  s2.player.x = 7; s2.player.y = 2; s2.player.faceDir = 1;
  run(s2, 0.2);
  L.step(s2, DT, { dx: 0, dy: 0, pump: true });
  run(s2, 0.1, NONE);
  assert.ok(!s2.player.pump || s2.player.pump.state === 'retract', 'dirt right next to it stops the pump');
});

test('four pumps pop an enemy and the points depend on the layer; a dragon popped from the side is worth double', () => {
  const mk = (kind, row, faceDir, pumpDir) => {
    const st = bare(); parked(st);
    hole(st, 0, 13, row);
    const e = addEnemy(st, kind, 7, row);
    e.dir = -1; e.ghostNext = 999;
    st.player.x = 5; st.player.y = row; st.player.faceDir = faceDir;
    run(st, 0.2);
    if (pumpDir) { st.player.x = 7; st.player.y = row - 2; hole(st, 7, 7, row - 1); hole(st, 7, 7, row - 2); run(st, 0.2); }
    // 펌프 버튼을 꾹 눌러 터뜨린다
    for (let i = 0; i < 120 && e.alive; i++) { e.held = e.held; L.step(st, DT, { dx: 0, dy: 0, pump: true }); if (!e.alive) break; e.x = 7; e.y = row; }
    return { st, e };
  };
  const a = mk('pooka', 3, 1);
  assert.ok(!a.e.alive && a.st.score === 200, `layer 1 pooka ${a.st.score}`);
  const b = mk('pooka', 13, 1);
  assert.strictEqual(b.st.score, 500);
  const c = mk('fygar', 6, 1);
  assert.strictEqual(c.st.score, 600, 'layer 2 fygar from the side = 300 x 2');
  const d = mk('fygar', 6, 2, true);
  assert.strictEqual(d.st.score, 300, 'from above, no bonus');
});

test('an enemy that is pumped but not finished deflates again and walks off, and walking away breaks the hose', () => {
  const st = bare(); parked(st);
  hole(st, 0, 13, 4);
  const e = addEnemy(st, 'pooka', 7, 4); e.ghostNext = 999;
  st.player.x = 5; st.player.y = 4; st.player.faceDir = 1;
  run(st, 0.2);
  L.step(st, DT, { dx: 0, dy: 0, pump: true });
  run(st, 0.5, { dx: 0, dy: 0, pump: true });
  assert.ok(e.held && e.inflate >= 1, 'hooked and pumping');
  assert.strictEqual(e.alive, true);
  const inflated = e.inflate;
  run(st, 1.0, NONE);
  assert.ok(!e.held, 'the hose let go');
  run(st, 1.5, NONE);
  assert.ok(e.inflate < inflated || e.inflate === 0, 'deflating');
  run(st, 5, NONE);
  assert.strictEqual(e.inflate, 0);
  // 걸어서 호스를 끊는다
  const s2 = bare(); parked(s2);
  hole(s2, 0, 13, 4);
  const f = addEnemy(s2, 'pooka', 7, 4); f.ghostNext = 999;
  s2.player.x = 5; s2.player.y = 4; s2.player.faceDir = 1;
  run(s2, 0.2);
  L.step(s2, DT, { dx: 0, dy: 0, pump: true });
  run(s2, 0.4, { dx: 0, dy: 0, pump: true });
  assert.ok(f.held);
  run(s2, 0.2, { dx: -1, dy: 0, pump: false });
  assert.ok(!f.held);
});

test('enemies follow the tunnels toward the player, and touching one costs a life', () => {
  const st = bare(); parked(st);
  hole(st, 0, 13, 4); hole(st, 3, 3, 3); hole(st, 3, 3, 2); hole(st, 3, 3, 1);
  st.player.x = 3; st.player.y = 1;
  const e = addEnemy(st, 'pooka', 12, 4); e.ghostNext = 999;
  const d0 = Math.abs(e.x - st.player.x) + Math.abs(e.y - st.player.y);
  run(st, 2, NONE);
  const d1 = Math.abs(e.x - st.player.x) + Math.abs(e.y - st.player.y);
  assert.ok(d1 < d0, `${d0} -> ${d1}`);
  const s2 = bare(); parked(s2);
  const g = addEnemy(s2, 'pooka', s2.player.x, s2.player.y); g.ghostNext = 999;
  run(s2, 0.1);
  assert.strictEqual(s2.lives, L.START_LIVES - 1);
  assert.strictEqual(s2.phase, 'dying');
  run(s2, 2);
  assert.strictEqual(s2.phase, 'play');
  assert.ok(s2.player.invuln > 0);
});

test('an enemy with no tunnel to the player turns into a ghost and goes through the dirt, and ghosts are harmless', () => {
  const st = bare(); parked(st);
  const e = addEnemy(st, 'pooka', 12, 12); hole(st, 11, 13, 12);
  st.player.x = 7; st.player.y = 2;
  run(st, 6);
  assert.strictEqual(e.state, 'ghost');
  const y0 = e.y; run(st, 1.5);
  assert.ok(e.y < y0, 'moving through the dirt toward the player');
  const s2 = bare(); parked(s2);
  const g = addEnemy(s2, 'pooka', s2.player.x, s2.player.y); g.state = 'ghost'; g.ghostT = 0;
  run(s2, 0.1);
  assert.strictEqual(s2.lives, L.START_LIVES, 'a ghost cannot hurt');
});

test('a dragon breathes fire along the tunnel when it faces you, and dirt stops the flames', () => {
  const st = bare(); parked(st);
  hole(st, 0, 13, 4);
  st.player.x = 8; st.player.y = 4; st.player.invuln = 0;
  const e = addEnemy(st, 'fygar', 5, 4); e.ghostNext = 999; e.fireCd = 0;
  run(st, 1.6);
  assert.ok(st.events.length >= 0);
  assert.strictEqual(st.lives, L.START_LIVES - 1, 'burned');
  const s2 = bare(); parked(s2);
  hole(s2, 0, 13, 4); s2.dirt[4][6] = true;
  s2.player.x = 8; s2.player.y = 4;
  const f = addEnemy(s2, 'fygar', 5, 4); f.ghostNext = 999; f.fireCd = 0;
  run(s2, 1.6);
  assert.strictEqual(s2.lives, L.START_LIVES, 'dirt blocks the fire');
});

test('a rock waits, then wobbles and falls when the dirt below is dug away, and crushing scores 1000 / 2500', () => {
  const st = bare(); parked(st);
  const k = { id: ++st.seq, x: 3, y: 4, state: 'still', t: 0, vy: 0, crushed: 0, fell: false };
  st.rocks.push(k);
  hole(st, 3, 3, 6);
  run(st, 0.3);
  assert.strictEqual(k.state, 'still', 'a dirt cell below holds it up');
  st.dirt[5][3] = false;                                               // 아래를 판다
  st.player.x = 8;
  run(st, 0.2);
  assert.strictEqual(k.state, 'wobble');
  const e = addEnemy(st, 'pooka', 3, 6); e.ghostNext = 999; e.held = true;
  run(st, 1.2);
  assert.ok(k.state === 'broken' || k.state === 'gone');
  assert.ok(!e.alive, 'crushed');
  assert.strictEqual(st.score, 1000);
  assert.strictEqual(st.dropped, 1);
  const s2 = bare(); parked(s2);
  const k2 = { id: ++s2.seq, x: 3, y: 4, state: 'still', t: 0, vy: 0, crushed: 0, fell: false };
  s2.rocks.push(k2); hole(s2, 3, 3, 5); hole(s2, 3, 3, 6);
  const a = addEnemy(s2, 'pooka', 3, 5); const b = addEnemy(s2, 'pooka', 3, 6);
  for (const x of [a, b]) { x.held = true; x.ghostNext = 999; }
  s2.player.x = 8;
  run(s2, 1.6);
  assert.strictEqual(s2.score, 2500, 'two at once');
});

test('a falling rock crushes the player too, and stops when it reaches dirt', () => {
  const st = bare(); parked(st);
  const k = { id: ++st.seq, x: 3, y: 4, state: 'still', t: 0, vy: 0, crushed: 0, fell: false };
  st.rocks.push(k); hole(st, 3, 3, 5); hole(st, 3, 3, 6);
  st.player.x = 3; st.player.y = 6; st.player.invuln = 0;
  run(st, 0.4, { dx: 0, dy: 0, pump: false });
  run(st, 1.5);
  assert.strictEqual(st.lives, L.START_LIVES - 1, 'crushed');
  const s2 = bare(); parked(s2);
  const k2 = { id: ++s2.seq, x: 3, y: 4, state: 'still', t: 0, vy: 0, crushed: 0, fell: false };
  s2.rocks.push(k2); hole(s2, 3, 3, 5); hole(s2, 3, 3, 6);
  s2.player.x = 9;
  run(s2, 2);
  assert.strictEqual(Math.round(k2.y), 6, 'landed on the dirt at row 7');
  assert.ok(s2.dirt[6][3] === false);
});

test('after two rocks have dropped a bonus vegetable appears in the middle, and eating it scores by round', () => {
  assert.deepStrictEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 40].map((r) => L.vegFor(r)[1]), [400, 600, 800, 1000, 2000, 3000, 4000, 5000, 8000, 8000]);
  const st = bare(); parked(st);
  const mk = (x) => ({ id: ++st.seq, x, y: 4, state: 'broken', t: 0, vy: 0, crushed: 0, fell: true });
  L.finishRock(st, mk(3));
  assert.strictEqual(st.items.length, 0);
  L.finishRock(st, mk(10));
  assert.strictEqual(st.items.length, 1);
  assert.strictEqual(st.items[0].type, 'carrot');
  L.finishRock(st, mk(5));
  assert.strictEqual(st.items.length, 1, 'only one a round');
  st.player.x = st.items[0].x; st.player.y = st.items[0].y;
  run(st, 0.05);
  assert.strictEqual(st.score, 400);
  const s2 = bare(); parked(s2);
  L.spawnVeg(s2);
  run(s2, 9.5);
  assert.strictEqual(s2.items.length, 0, 'it goes away');
});

test('clearing all enemies starts the next round, the last one runs to the surface, and escaping also ends the round', () => {
  const st = bare();
  const e = addEnemy(st, 'pooka', 7, 4); hole(st, 7, 7, 3); hole(st, 7, 7, 4);
  e.held = true; e.inflate = 3;
  L.popEnemy(st, e, false); e.alive = false;
  run(st, 0.1);
  assert.strictEqual(st.phase, 'clear');
  run(st, 2.8);
  assert.strictEqual(st.round, 2);
  // 마지막 한 마리: 땅 위로 도망친다
  const s2 = bare();
  const f = addEnemy(s2, 'pooka', 3, 8); s2.enemies0 = 2; hole(s2, 3, 3, 8);
  s2.player.x = 12; s2.player.y = 2;
  run(s2, 0.2);
  assert.strictEqual(f.state, 'flee');
  run(s2, 8);
  assert.ok(s2.phase === 'clear' || s2.round === 2, 'escaped and the round ended');
});

test('the remaining enemies get faster as their friends are popped', () => {
  const st = bare(); parked(st);
  hole(st, 0, 13, 4);
  const mk = (total) => { const s = bare(); parked(s); hole(s, 0, 13, 4); const e = addEnemy(s, 'pooka', 12, 4); e.ghostNext = 999; s.enemies0 = total; s.player.x = 0; s.player.y = 4; s.player.invuln = 99; hole(s, 0, 0, 4); const x0 = e.x; run(s, 0.5); return x0 - e.x; };
  assert.ok(mk(6) > mk(2) * 1.3, 'faster with fewer left');
});

test('extra life at 20000 points and game over after the last life', () => {
  const st = bare(); parked(st);
  st.score = 19900;
  const e = addEnemy(st, 'pooka', 5, 12); L.popEnemy(st, e, false);
  assert.strictEqual(st.lives, L.START_LIVES + 1);
  const s2 = bare(); parked(s2); s2.lives = 1;
  L.killPlayer(s2, 'enemy');
  run(s2, 2.2);
  assert.strictEqual(s2.phase, 'over');
});

test('random play for several minutes keeps everything inside the field', () => {
  const rand = L.rng(42);
  for (let g = 0; g < 5; g++) {
    const st = L.newGame(L.rng(500 + g));
    const inp = { dx: 0, dy: 0, pump: false };
    for (let i = 0; i < 60 * 120 && st.phase !== 'over'; i++) {
      if (i % 20 === 0) { const d = Math.floor(rand() * 5); inp.dx = d === 1 ? 1 : d === 2 ? -1 : 0; inp.dy = d === 3 ? 1 : d === 4 ? -1 : 0; inp.pump = rand() < 0.5; }
      L.step(st, DT, inp);
      const p = st.player;
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'finite');
      assert.ok(p.x >= -1e-6 && p.x <= L.COLS - 1 + 1e-6 && p.y >= -1e-6 && p.y <= L.ROWS - 1 + 1e-6, 'inside');
      for (const e of st.enemies) assert.ok(Number.isFinite(e.x) && Number.isFinite(e.y));
      assert.ok(st.lives >= 0);
    }
  }
});

test('a fleeing last enemy can still be hooked by the pump', () => {
  const st = bare();
  hole(st, 0, 13, 4);
  const e = addEnemy(st, 'pooka', 7, 4); e.ghostNext = 999; st.enemies0 = 3;
  st.player.x = 5; st.player.y = 4; st.player.faceDir = 1;
  run(st, 0.2);
  e.state = 'flee';
  L.step(st, DT, { dx: 0, dy: 0, pump: true });
  for (let i = 0; i < 12; i++) { e.x = 7; e.y = 4; L.step(st, DT, { dx: 0, dy: 0, pump: true }); }
  assert.ok(e.held && e.inflate >= 1);
});
