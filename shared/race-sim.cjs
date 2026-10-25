/* K54 race simulation - shared by the authoritative server and the browser (client-side prediction).
   Deterministic fixed-step top-down driving model. No DOM, no Node APIs, no randomness. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.K54Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var HZ = 30, DT = 1 / HZ;
  var SCALE = 1.7, HALF = 62;                                   // track half width (world units)
  var CTRL = [[0, -300], [300, -320], [520, -200], [560, 0], [430, 160], [200, 150], [60, 260], [-180, 300], [-420, 180], [-480, -60], [-350, -250]];
  var K = 16;                                                   // checkpoints per lap
  var SEG = 24;                                                 // samples per spline segment
  var CAR_R = 11;

  function crom(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return [0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
            0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)];
  }
  function buildTrack() {
    var n = CTRL.length, pts = [], i, s;
    for (i = 0; i < n; i++) {
      var p0 = CTRL[(i + n - 1) % n], p1 = CTRL[i], p2 = CTRL[(i + 1) % n], p3 = CTRL[(i + 2) % n];
      for (s = 0; s < SEG; s++) { var q = crom(p0, p1, p2, p3, s / SEG); pts.push([q[0] * SCALE, q[1] * SCALE]); }
    }
    var N = pts.length, cum = [0], len = 0, hd = [];
    for (i = 0; i < N; i++) {
      var a = pts[i], b = pts[(i + 1) % N];
      var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.sqrt(dx * dx + dy * dy);
      len += d; cum.push(len); hd.push(Math.atan2(dy, dx));
    }
    var cp = []; for (i = 0; i < K; i++) cp.push(Math.round(i * N / K) % N);
    return { pts: pts, N: N, len: len, cum: cum, hd: hd, half: HALF, cp: cp, K: K };
  }
  var TRACK = buildTrack();

  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  function clampInput(i) {
    i = i || {};
    var st = +i.st, th = +i.th, br = +i.br;
    return { st: isFinite(st) ? clamp(st, -1, 1) : 0, th: isFinite(th) ? clamp(th, 0, 1) : 0, br: isFinite(br) ? clamp(br, 0, 1) : 0, ni: i.ni ? 1 : 0 };
  }
  // catalogue stats (shop_items.meta) -> bounded physics numbers. Players can never send these; the server reads them from the database.
  function statsFrom(meta) {
    meta = meta || {};
    var sp = clamp(+meta.sp || 1, 0.8, 1.7), hd = clamp(+meta.hd || 1, 0.7, 1.8), br = clamp(+meta.br || 0, -0.5, 3.2), nb = clamp(+meta.nb || 1, 0.6, 2.5);
    return { vmax: 235 * sp, acc: 150 * Math.sqrt(sp), turn: 2.7 * hd, brake: 300 + 90 * br, boostV: 1 + 0.16 * nb, boostA: 1 + 0.5 * nb };
  }
  function nearest(tr, x, y, hint) {
    var N = tr.N, best = -1, bd = 1e18, i, k, W = 10;
    function test(ix) { var p = tr.pts[ix], dx = p[0] - x, dy = p[1] - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = ix; } }
    if (hint >= 0) { for (k = -W; k <= W; k++) test((hint + k + N * 4) % N); }
    if (best < 0 || bd > 160 * 160) { bd = 1e18; for (i = 0; i < N; i++) test(i); }
    return { idx: best, dist: Math.sqrt(bd) };
  }
  function gridPos(tr, seat) {
    var back = [26, 64, 102][seat] || 26, lat = [-20, 20, -20][seat] || 0;
    var i0 = 0, h = tr.hd[i0], p = tr.pts[i0], cx = Math.cos(h), sy = Math.sin(h);
    return { x: p[0] - cx * back - sy * lat, y: p[1] - sy * back + cx * lat, h: h };
  }
  function newCar(id, seat, meta) {
    var g = gridPos(TRACK, seat);
    return { id: id, seat: seat, st: statsFrom(meta), x: g.x, y: g.y, h: g.h, v: 0, nit: 100, idx: nearest(TRACK, g.x, g.y, -1).idx, P: 0, fin: 0, hits: 0, lapT: 0, best: 0, off: 0 };
  }
  // one car, one tick. Pure function of (car, input, track).
  function stepCar(c, inp, tr) {
    tr = tr || TRACK; inp = clampInput(inp);
    var s = c.st, boost = inp.ni && c.nit > 4 ? 1 : 0;
    var vmax = s.vmax * (boost ? s.boostV : 1) * (c.off ? 0.55 : 1);
    var acc = s.acc * (boost ? s.boostA : 1);
    if (boost) c.nit = Math.max(0, c.nit - 45 * DT); else c.nit = Math.min(100, c.nit + 9 * DT);
    if (inp.th > 0 && c.v < vmax) c.v = Math.min(vmax, c.v + acc * inp.th * DT);
    c.v -= (inp.th > 0 ? 0 : 38) * DT + c.v * 0.18 * DT + (c.off ? 140 * DT : 0);       // drag, coasting, grass
    if (inp.br > 0) c.v -= s.brake * inp.br * DT;
    if (c.v > vmax) c.v -= 260 * DT;                                                       // bleed off excess (leaving boost / entering grass)
    if (c.v < 0) c.v = 0;
    var speedF = clamp(c.v / 45, 0, 1), turn = inp.st * s.turn * (1 - 0.42 * clamp(c.v / (s.vmax * 1.1), 0, 1)) * speedF;
    c.h += turn * DT;
    c.x += Math.cos(c.h) * c.v * DT; c.y += Math.sin(c.h) * c.v * DT;
    // track relation
    var nr = nearest(tr, c.x, c.y, c.idx);
    var p = tr.pts[nr.idx];
    if (nr.dist > tr.half + 38) {                                                          // hard barrier outside the grass margin
      var k = (tr.half + 38) / nr.dist; c.x = p[0] + (c.x - p[0]) * k; c.y = p[1] + (c.y - p[1]) * k; c.v *= 0.55; c.hits++;
    }
    c.off = nr.dist > tr.half ? 1 : 0;
    var prev = c.idx; c.idx = nr.idx;
    c.lapT += DT;
    // checkpoint gating: gates must be passed in order, only moving forward. P = gates passed so far (the start line is gate 0).
    var target = tr.cp[c.P % tr.K], dprev = (prev - target + tr.N) % tr.N, dnow = (c.idx - target + tr.N) % tr.N;
    if (dnow < tr.N / 8 && dprev > tr.N - tr.N / 6) {            // crossed the gate FORWARDS (was just before it, is now just past it)
      c.P++;
      if (c.P > 1 && (c.P - 1) % tr.K === 0) { if (!c.best || c.lapT < c.best) c.best = c.lapT; c.lapT = 0; }   // a lap was completed
      else if (c.P === 1) c.lapT = 0;
    }
    return c;
  }
  function newRace(players, laps) {
    var cars = players.map(function (p, i) { return newCar(p.id, i, p.meta); });
    return { tick: 0, laps: laps || 3, cars: cars, order: [], start: 0 };
  }
  // monotone progress number: gates passed * 1000 + how far to the next gate (0..999)
  function progress(w, c) {
    var tr = TRACK, nxt = tr.cp[c.P % tr.K], prev = tr.cp[(c.P + tr.K - 1) % tr.K];
    var span = (nxt - prev + tr.N) % tr.N || 1, into = (c.idx - prev + tr.N) % tr.N;
    return c.P * 1000 + clamp(into / span, 0, 0.999) * 1000;
  }
  function lapsDone(c) { return c.P < 1 ? 0 : Math.floor((c.P - 1) / TRACK.K); }
  // all cars one tick, input map by car id. Handles finishing (cars pass through each other - no car-to-car collisions).
  function stepWorld(w, inputs) {
    var i, j, cars = w.cars;
    w.tick++;
    for (i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (c.fin) { c.v = Math.max(0, c.v - 120 * DT); c.x += Math.cos(c.h) * c.v * DT; c.y += Math.sin(c.h) * c.v * DT; continue; }
      stepCar(c, inputs[c.id], TRACK);
      if (c.P >= w.laps * TRACK.K + 1 && !c.fin) { c.fin = w.tick; w.order.push(c.id); }
    }
    // Cars do NOT collide: racers drive straight through each other ("ghost" overtaking), so nobody can block or wreck another player.
    return w;
  }
  // ranking: finished cars by finish tick, then unfinished by progress
  function ranking(w) {
    var fin = w.cars.filter(function (c) { return c.fin; }).sort(function (a, b) { return a.fin - b.fin || a.seat - b.seat; });
    var rest = w.cars.filter(function (c) { return !c.fin; }).sort(function (a, b) { return progress(w, b) - progress(w, a); });
    return fin.concat(rest);
  }
  // client side: adopt the server's state for my car, then replay the inputs the server has not applied yet
  function applyAuth(car, a, pending, tr) {
    tr = tr || TRACK;
    car.x = a.x; car.y = a.y; car.h = a.h; car.v = a.v; car.P = a.P; car.nit = a.nit; car.fin = a.fin; car.hits = a.hits;
    var nr = nearest(tr, car.x, car.y, -1); car.idx = nr.idx; car.off = nr.dist > tr.half ? 1 : 0;
    for (var i = 0; i < pending.length; i++) stepCar(car, pending[i], tr);
    return car;
  }
  return { applyAuth: applyAuth, HZ: HZ, DT: DT, TRACK: TRACK, K: K, CAR_R: CAR_R, clampInput: clampInput, statsFrom: statsFrom, newCar: newCar, stepCar: stepCar,
           newRace: newRace, stepWorld: stepWorld, lapsDone: lapsDone, ranking: ranking, progress: progress, nearest: nearest, gridPos: gridPos };
});
