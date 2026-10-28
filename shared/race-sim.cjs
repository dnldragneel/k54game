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
  var BAR = 10;                                                 // the guard rail keeps the middle of the car at most this far outside the road edge (the picture draws the rail one half car-width further out)
  var CAR_HL = 12, CAR_HW = 9.5, TR_HL = 12, TR_HW = 9.5;       // half length / half width of a car and of a traffic car
  var LANES = [-45, -15, 15, 45], LANE_V = [78, 92, 106, 86];   // traffic lanes (lateral offset) and the steady speed of each lane
  var TR_PER_LANE = 4, NEAR_GAP = 7;                            // traffic cars per lane; a pass closer than this (units) is a "near miss"

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
  function wrapA(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  function rng(seed) { var a = seed >>> 0; return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  // ---- random traffic: every car is a pure function of (seed, tick), so the server and every browser see exactly the same cars ----
  function makeTraffic(seed, tr) {
    tr = tr || TRACK; var r = rng(seed), list = [], lane, k, span = tr.len - 900, gap = 300;
    for (lane = 0; lane < LANES.length; lane++) {
      var placed = [], tries = 0;
      while (placed.length < TR_PER_LANE && tries++ < 600) {
        var s = 380 + r() * span, ok = true;
        for (k = 0; k < placed.length; k++) { var d = Math.abs(placed[k] - s); if (d < gap || tr.len - d < gap) ok = false; }
        if (ok) placed.push(s);
      }
      while (placed.length < TR_PER_LANE) placed.push(380 + (placed.length + 0.5) * span / TR_PER_LANE);
      for (k = 0; k < placed.length; k++) list.push({ id: list.length, s0: placed[k], v: LANE_V[lane], lat: LANES[lane] });
    }
    return list;
  }
  function trafficAt(list, tick, tr) {
    tr = tr || TRACK; var out = [], t = tick * DT, i, q;
    for (i = 0; i < list.length; i++) {
      q = list[i];
      var s = (q.s0 + q.v * t) % tr.len, lo = 0, hi = tr.N - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tr.cum[mid] <= s) lo = mid; else hi = mid - 1; }
      var j = (lo + 1) % tr.N, seg = tr.cum[lo + 1] - tr.cum[lo] || 1, f = (s - tr.cum[lo]) / seg, a = tr.pts[lo], b = tr.pts[j];
      var h = tr.hd[lo] + wrapA(tr.hd[j] - tr.hd[lo]) * f, x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      out.push({ id: q.id, x: x - Math.sin(h) * q.lat, y: y + Math.cos(h) * q.lat, h: h, v: q.v, lane: q.lat });
    }
    return out;
  }
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
    var back = 26 + (seat | 0) * 32, lat = (seat & 1) ? 20 : -20;                         // five staggered slots (two abreast), 32 units apart behind the line
    var i0 = 0, h = tr.hd[i0], p = tr.pts[i0], cx = Math.cos(h), sy = Math.sin(h);
    return { x: p[0] - cx * back - sy * lat, y: p[1] - sy * back + cx * lat, h: h };
  }
  function newCar(id, seat, meta) {
    var g = gridPos(TRACK, seat);
    return { id: id, seat: seat, st: statsFrom(meta), x: g.x, y: g.y, h: g.h, v: 0, nit: 100, idx: nearest(TRACK, g.x, g.y, -1).idx, P: 0, fin: 0, hits: 0, lapT: 0, best: 0, off: 0, ev: 0, tch: 0 };
  }
  // one car, one tick. Pure function of (car, input, track).
  // ev (transient, not state): 1 = scraped a rail, 2 = hit a traffic car, 4 = near miss this tick (the browser uses it for sound / pop-ups)
  function stepCar(c, inp, tr, tf) {
    tr = tr || TRACK; inp = clampInput(inp); c.ev = 0; var tch = 0;
    var s = c.st, boost = inp.ni && c.nit > 4 ? 1 : 0;
    var vmax = s.vmax * (boost ? s.boostV : 1) * (c.off ? 0.84 : 1);
    var acc = s.acc * (boost ? s.boostA : 1);
    if (boost) c.nit = Math.max(0, c.nit - 45 * DT); else c.nit = Math.min(100, c.nit + 9 * DT);
    if (inp.th > 0 && c.v < vmax) c.v = Math.min(vmax, c.v + acc * inp.th * DT);
    c.v -= (inp.th > 0 ? 0 : 38) * DT + c.v * 0.18 * DT + (c.off ? 26 * DT : 0);         // drag, coasting, a little extra on the grass
    if (inp.br > 0) c.v -= s.brake * inp.br * DT;
    if (c.v > vmax) c.v -= 260 * DT;                                                       // bleed off excess (leaving boost / entering grass)
    if (c.v < 0) c.v = 0;
    var speedF = clamp(c.v / 45, 0, 1), turn = inp.st * s.turn * (1 - 0.42 * clamp(c.v / (s.vmax * 1.1), 0, 1)) * speedF;
    c.h += turn * DT;
    c.x += Math.cos(c.h) * c.v * DT; c.y += Math.sin(c.h) * c.v * DT;
    // traffic: touching a car costs speed and pushes you out of it; skimming past one at speed charges the nitro (a "near miss")
    if (tf) for (var ti = 0; ti < tf.length; ti++) {
      var q = tf[ti], tdx = c.x - q.x, tdy = c.y - q.y;
      if (tdx * tdx + tdy * tdy > 3600) continue;
      var qc = Math.cos(q.h), qs = Math.sin(q.h), dl = tdx * qc + tdy * qs, dw = -tdx * qs + tdy * qc, adl = Math.abs(dl), adw = Math.abs(dw);
      var penL = CAR_HL + TR_HL - adl, penW = CAR_HW + TR_HW - adw;
      if (penL > 0 && penW > 0) {
        if (penW < penL) { var sg = dw >= 0 ? 1 : -1; c.x += -qs * sg * (penW + 0.3); c.y += qc * sg * (penW + 0.3); c.v *= 0.9; }   // side swipe
        else if (dl < 0) { c.x -= qc * (penL + 0.3); c.y -= qs * (penL + 0.3); if (c.v > q.v * 0.7) c.v = q.v * 0.7; }               // rear-ended it
        else { c.x += qc * (penL + 0.3); c.y += qs * (penL + 0.3); }
        tch |= 2; c.ev |= 2; if (!(c.tch & 2)) c.hits++;
      } else if (adl < CAR_HL + TR_HL + 6 && adw < CAR_HW + TR_HW + NEAR_GAP && c.v - q.v > 40) {
        var gp = adw - (CAR_HW + TR_HW); c.nit = Math.min(100, c.nit + 70 * (1 - gp / NEAR_GAP) * DT); c.ev |= 4;
      }
    }
    // track relation
    var nr = nearest(tr, c.x, c.y, c.idx);
    var p = tr.pts[nr.idx];
    var bar = tr.half + BAR;
    if (nr.dist > bar) {                                                                   // guard rail: it slides you along the wall, it never glues you to it
      var kk = bar / nr.dist; c.x = p[0] + (c.x - p[0]) * kk; c.y = p[1] + (c.y - p[1]) * kk;
      var th = tr.hd[nr.idx], rel = wrapA(c.h - th), side = ((c.x - p[0]) * -Math.sin(th) + (c.y - p[1]) * Math.cos(th)) >= 0 ? 1 : -1;
      var out = side * Math.sin(rel);                                                      // > 0: the nose points into the rail
      var fwd = Math.abs(rel) <= Math.PI / 2, tgt = (fwd ? th : th + Math.PI) + (fwd ? -side : side) * 0.2;   // along the rail, nose a touch back toward the road
      if (out > 0) { c.h = tgt + wrapA(c.h - tgt) * 0.5; c.v *= 1 - 0.5 * out; if (out > 0.25) { tch |= 1; c.ev |= 1; if (!(c.tch & 1)) c.hits++; } }
      c.v = Math.max(0, c.v - 25 * DT);                                                    // paint scraping the rail
    }
    c.off = nr.dist > tr.half ? 1 : 0; c.tch = tch;
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
  function newRace(players, laps, seed) {
    var cars = players.map(function (p, i) { return newCar(p.id, i, p.meta); });
    seed = seed | 0;
    return { tick: 0, laps: laps || 3, cars: cars, order: [], start: 0, seed: seed, traffic: seed ? makeTraffic(seed) : [] };
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
    var tf = w.traffic && w.traffic.length ? trafficAt(w.traffic, w.tick) : null;
    for (i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (c.fin) { c.v = Math.max(0, c.v - 120 * DT); c.x += Math.cos(c.h) * c.v * DT; c.y += Math.sin(c.h) * c.v * DT; continue; }
      stepCar(c, inputs[c.id], TRACK, tf);
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
  function applyAuth(car, a, pending, tr, tfo) {          // tfo = { list: w.traffic, k: tick of the snapshot } - needed to replay traffic contacts
    tr = tr || TRACK;
    car.x = a.x; car.y = a.y; car.h = a.h; car.v = a.v; car.P = a.P; car.nit = a.nit; car.fin = a.fin; car.hits = a.hits;
    var nr = nearest(tr, car.x, car.y, -1); car.idx = nr.idx; car.off = nr.dist > tr.half ? 1 : 0;
    for (var i = 0; i < pending.length; i++) stepCar(car, pending[i], tr, tfo && tfo.list && tfo.list.length ? trafficAt(tfo.list, tfo.k + 1 + i, tr) : null);
    return car;
  }
  return { applyAuth: applyAuth, makeTraffic: makeTraffic, trafficAt: trafficAt, BAR: BAR, LANES: LANES, HZ: HZ, DT: DT, TRACK: TRACK, K: K, CAR_R: CAR_R, clampInput: clampInput, statsFrom: statsFrom, newCar: newCar, stepCar: stepCar,
           newRace: newRace, stepWorld: stepWorld, lapsDone: lapsDone, ranking: ranking, progress: progress, nearest: nearest, gridPos: gridPos };
});
