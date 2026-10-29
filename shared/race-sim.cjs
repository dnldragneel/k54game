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
  var LANES = [-41, 0, 41], LANE_V = [80, 100, 90];             // the three traffic lanes (lateral offset; the road picture has two dashed lines at +-20.7) and the steady speed of each lane
  var TR_PER_LANE = 4, NEAR_GAP = 7;                            // traffic cars per lane; a pass closer than this (units) is a "near miss"
  var REV_MAX = 48, REV_ACC = 75;                               // the brake pedal at a standstill puts the car in reverse: top reversing speed and how quickly it gets there (units/s)
  var MAXP = 10;                                                // most racers in one race
  var TURBO_T = 75, SHIELD_T = 210, ZAP_T = 66;                 // power-up lengths in ticks (2.5 s, 7 s, 2.2 s)
  var IT_TURBO = 1, IT_SHIELD = 2, IT_ZAP = 3;                  // what a car can be holding (c.it)
  var BOX_PER_LAP = 6;
  var CRASH_HL = 12, CRASH_HW = 6.5;                               // crashes use a slimmer box than the traffic test (the 3D car is about 2 m wide): half length / half width in sim units (1 unit = 0.2 m in the 3D view)
  var CRASH_E = 0.5, CRASH_MIN = 8;                              // crashes (private-room option): how bouncy a bump is, and the smallest bump that counts as a crash (units/s of closing speed)

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
    return { st: isFinite(st) ? clamp(st, -1, 1) : 0, th: isFinite(th) ? clamp(th, 0, 1) : 0, br: isFinite(br) ? clamp(br, 0, 1) : 0, ni: i.ni ? 1 : 0, us: i.us ? 1 : 0 };
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
  // the starting grid: rows of two (left car first, the right-hand car a little further back), 36 units between rows - room for ten cars. seat -> distance behind the line and sideways offset
  function gridSlot(seat) { seat = seat | 0; var col = seat & 1; return { back: 26 + (seat >> 1) * 36 + col * 16, lat: col ? 20 : -20 }; }
  function gridPos(tr, seat) {
    var g = gridSlot(seat), back = g.back, lat = g.lat;
    var i0 = 0, h = tr.hd[i0], p = tr.pts[i0], cx = Math.cos(h), sy = Math.sin(h);
    return { x: p[0] - cx * back - sy * lat, y: p[1] - sy * back + cx * lat, h: h };
  }
  function newCar(id, seat, meta) {
    var g = gridPos(TRACK, seat);
    return { id: id, seat: seat, st: statsFrom(meta), x: g.x, y: g.y, h: g.h, v: 0, nit: 100, idx: nearest(TRACK, g.x, g.y, -1).idx, P: 0, fin: 0, hits: 0, lapT: 0, best: 0, off: 0, ev: 0, tch: 0, it: 0, tb: 0, sh: 0, sl: 0, up: 0, got: 0, gl: 0 };
  }
  // one car, one tick. Pure function of (car, input, track).
  // ev (transient, not state): 1 = scraped a rail, 2 = hit a traffic car, 4 = near miss this tick (the browser uses it for sound / pop-ups)
  function stepCar(c, inp, tr, tf) {
    tr = tr || TRACK; inp = clampInput(inp); c.ev = 0; var tch = 0;
    var s = c.st, boost = inp.ni && c.nit > 4 ? 1 : 0, tb = c.tb > 0, sh = c.sh > 0, sl = c.sl > 0;
    var vmax = s.vmax * (boost ? s.boostV : 1) * (c.off ? 0.84 : 1) * (tb ? 1.2 : 1) * (sl ? 0.5 : 1);     // power-ups: turbo +20%, a zap halves the top speed
    var acc = s.acc * (boost ? s.boostA : 1) * (tb ? 1.7 : 1) * (sl ? 0.45 : 1);
    if (boost) c.nit = Math.max(0, c.nit - 45 * DT); else c.nit = Math.min(100, c.nit + 9 * DT);
    if (inp.th > 0 && c.v < vmax) c.v = Math.min(vmax, c.v + (acc + (c.v < 0 ? 220 : 0)) * inp.th * DT);   // (a car that is reversing gets a firm push to come to a stop first)
    if (c.v >= 0) c.v = Math.max(0, c.v - ((inp.th > 0 ? 0 : 38) * DT + c.v * 0.18 * DT + (c.off ? 26 * DT : 0)));   // drag, coasting, a little extra on the grass
    else c.v = Math.min(0, c.v + 38 * DT + (-c.v) * 0.18 * DT + (c.off ? 26 * DT : 0));                   // a reversing car rolls to a stop by itself
    if (inp.br > 0) {
      if (c.v > 0) c.v = Math.max(0, c.v - s.brake * inp.br * DT);                         // braking
      else if (inp.th <= 0) c.v = Math.max(-REV_MAX, c.v - REV_ACC * inp.br * DT);        // stopped and still holding the brake: reverse
    }
    if (c.v > vmax) c.v -= 260 * DT;                                                       // bleed off excess (leaving boost / entering grass)
    if (c.v < -REV_MAX) c.v = -REV_MAX;
    var speedF = clamp(c.v / 45, -1, 1), turn = inp.st * s.turn * (1 - 0.42 * clamp(Math.abs(c.v) / (s.vmax * 1.1), 0, 1)) * speedF;   // (negative speed: the steering works the other way round, like a real car)
    c.h += turn * DT;
    c.x += Math.cos(c.h) * c.v * DT; c.y += Math.sin(c.h) * c.v * DT;
    // traffic: touching a car costs speed and pushes you out of it; skimming past one at speed charges the nitro (a "near miss")
    if (tf) for (var ti = 0; ti < tf.length; ti++) {
      var q = tf[ti], tdx = c.x - q.x, tdy = c.y - q.y;
      if (tdx * tdx + tdy * tdy > 3600) continue;
      var qc = Math.cos(q.h), qs = Math.sin(q.h), dl = tdx * qc + tdy * qs, dw = -tdx * qs + tdy * qc, adl = Math.abs(dl), adw = Math.abs(dw);
      var penL = CAR_HL + TR_HL - adl, penW = CAR_HW + TR_HW - adw;
      if (penL > 0 && penW > 0) {
        if (penW < penL) { var sg = dw >= 0 ? 1 : -1; c.x += -qs * sg * (penW + 0.3); c.y += qc * sg * (penW + 0.3); if (!sh) c.v *= 0.9; }   // side swipe
        else if (dl < 0) { c.x -= qc * (penL + 0.3); c.y -= qs * (penL + 0.3); if (!sh && c.v > q.v * 0.7) c.v = q.v * 0.7; }               // rear-ended it
        else { c.x += qc * (penL + 0.3); c.y += qs * (penL + 0.3); }
        tch |= 2; c.ev |= 2; if (!(c.tch & 2) && !sh) c.hits++;                           // a shield makes the car shrug traffic off: no slow-down and no hit counted
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
      if (out > 0) { c.h = tgt + wrapA(c.h - tgt) * 0.5; if (!sh) c.v *= 1 - 0.5 * out; if (out > 0.25) { tch |= 1; c.ev |= 1; if (!(c.tch & 1) && !sh) c.hits++; } }
      if (!sh && c.v > 0) c.v = Math.max(0, c.v - 25 * DT);                                // paint scraping the rail
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
    if (c.tb > 0) c.tb--; if (c.sh > 0) c.sh--; if (c.sl > 0) c.sl--;                      // power-up timers
    return c;
  }
  // opts.power = true: the road has power-up boxes (see stepWorld).  opts.crash = true: the cars collide with each other (see collideCars).  opts.traffic = false: no traffic on the road.  Everything else is the same race.
  function newRace(players, laps, seed, opts) {
    var cars = players.map(function (p, i) { return newCar(p.id, i, p.meta); });
    seed = seed | 0; opts = opts || {};
    var w = { tick: 0, laps: laps || 3, cars: cars, order: [], start: 0, seed: seed, crash: !!opts.crash, traffic: seed && opts.traffic !== false ? makeTraffic(seed) : [], power: !!opts.power, boxes: opts.power ? makeBoxes(seed) : [], ev: [] };
    w.rs = rng((seed ^ 0x2545F491) >>> 0);                                    // the dice for power-ups (only the server rolls them)
    return w;
  }
  // ---- power-up boxes: the same six places on the road every lap, a random lane each (a pure function of the race seed) ----
  function makeBoxes(seed, tr) {
    tr = tr || TRACK; var r = rng((seed ^ 0x5bd1e995) >>> 0), list = [], i, span = (tr.len - 500) / BOX_PER_LAP;
    for (i = 0; i < BOX_PER_LAP; i++) list.push({ id: i, s: 350 + (i + 0.15 + r() * 0.7) * span, lat: LANES[(r() * LANES.length) | 0] });
    return list;
  }
  function boxPos(b, tr) {
    tr = tr || TRACK; var lo = 0, hi = tr.N - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tr.cum[mid] <= b.s) lo = mid; else hi = mid - 1; }
    var j = (lo + 1) % tr.N, seg = tr.cum[lo + 1] - tr.cum[lo] || 1, f = (b.s - tr.cum[lo]) / seg, a = tr.pts[lo], c = tr.pts[j];
    var h = tr.hd[lo] + wrapA(tr.hd[j] - tr.hd[lo]) * f, x = a[0] + (c[0] - a[0]) * f, y = a[1] + (c[1] - a[1]) * f;
    return { x: x - Math.sin(h) * b.lat, y: y + Math.cos(h) * b.lat, h: h };
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
      if (w.power) { var ui = inputs[c.id] && inputs[c.id].us ? 1 : 0; if (ui && !c.up && c.it) useItem(w, c); c.up = ui; }
      stepCar(c, inputs[c.id], TRACK, tf);
      if (w.power) pickBoxes(w, c);
      if (c.P >= w.laps * TRACK.K + 1 && !c.fin) { c.fin = w.tick; w.order.push(c.id); }
    }
    // Normally cars do NOT collide: racers drive straight through each other ("ghost" overtaking), so nobody can block or wreck another player.
    // A private room can switch crashes on (w.crash): then cars bump and spin each other (collideCars). Finished cars are ghosts again so nobody is wrecked after the flag.
    if (w.crash) collideCars(w);
    return w;
  }
  // ---- crashes: car against car. Two rectangles (CRASH_HL x CRASH_HW) are tested with the separating-axis rule; an overlap pushes both cars apart and swaps some of their
  //      speed along the line of the hit (equal weights). Whatever speed is left sideways turns the nose, and a hit off centre spins the car. Server-side only: the browser gets the result
  //      with the next snapshot (and an 'fx' news item for the bang). The sums use a fixed order of cars, so they are the same on every run. ----
  function collideCars(w) {
    var cars = w.cars, n = cars.length, i, j;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var a = cars[i], b = cars[j];
      if (a.fin || b.fin) continue;
      var dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy > 1000) continue;                                             // further apart than the two cars' diagonals
      var ca = Math.cos(a.h), sa = Math.sin(a.h), cb = Math.cos(b.h), sb = Math.sin(b.h);
      var ax = [ca, sa, -sa, ca, cb, sb, -sb, cb], bestD = 1e9, nx = 0, ny = 0, k, ok = true;
      for (k = 0; k < 4; k++) {
        var ux = ax[k * 2], uy = ax[k * 2 + 1];
        var ra = CRASH_HL * Math.abs(ux * ca + uy * sa) + CRASH_HW * Math.abs(-ux * sa + uy * ca);
        var rb = CRASH_HL * Math.abs(ux * cb + uy * sb) + CRASH_HW * Math.abs(-ux * sb + uy * cb);
        var dd = dx * ux + dy * uy, pen = ra + rb - Math.abs(dd);
        if (pen <= 0) { ok = false; break; }
        if (pen < bestD) { bestD = pen; nx = dd >= 0 ? ux : -ux; ny = dd >= 0 ? uy : -uy; }
      }
      if (!ok) continue;
      // 1. push apart (the normal points from b to a)
      var push = bestD / 2 + 0.1;
      a.x += nx * push; a.y += ny * push; b.x -= nx * push; b.y -= ny * push;
      // 2. swap speed along the normal
      var vax = ca * a.v, vay = sa * a.v, vbx = cb * b.v, vby = sb * b.v;
      var vn = (vax - vbx) * nx + (vay - vby) * ny, J = 0;
      if (vn < 0) {
        J = -(1 + CRASH_E) * vn / 2;
        vax += J * nx; vay += J * ny; vbx -= J * nx; vby -= J * ny;
      }
      // contact point = half way between the centres; r x (J n) is the turning push on each car
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var ta = (mx - a.x) * (J * ny) - (my - a.y) * (J * nx), tb = (mx - b.x) * (-J * ny) - (my - b.y) * (-J * nx);
      applyBump(a, vax, vay, ta); applyBump(b, vbx, vby, tb);
      if (J > CRASH_MIN) { a.hits++; b.hits++; a.ev |= 8; b.ev |= 8; w.ev.push({ k: 'crash', a: a.seat, b: b.seat, f: Math.min(99, Math.round(J)) }); }
    }
  }
  function applyBump(c, vx, vy, torque) {                // turn the new velocity back into "speed along the nose" + a change of heading
    var cf = Math.cos(c.h), sf = Math.sin(c.h), vf = vx * cf + vy * sf, vl = -vx * sf + vy * cf;
    var dh = Math.atan2(vl, Math.max(45, Math.abs(vf))) * 0.8 + clamp(torque * 0.00022, -0.3, 0.3);
    c.h += clamp(dh, -0.5, 0.5);
    c.v = clamp(vf * 0.98, -REV_MAX, 400);
  }
  // ---- power-ups (server only: the effects ride in the car's state, so the browser's prediction picks them up from the snapshots) ----
  function pickBoxes(w, c) {
    var lap = lapsDone(c); if (c.gl !== lap) { c.gl = lap; c.got = 0; }
    if (c.it || c.P < 1) return;
    var tr = TRACK, cs = tr.cum[c.idx], lat = null;
    for (var i = 0; i < w.boxes.length; i++) {
      var b = w.boxes[i]; if (c.got & (1 << b.id)) continue;
      var d = cs - b.s; d -= Math.round(d / tr.len) * tr.len;
      if (Math.abs(d) > 20) continue;
      if (lat === null) lat = lanePose(c).lat;
      if (Math.abs(lat - b.lat) > 19) continue;
      c.got |= 1 << b.id; c.it = rollItem(w, c); w.ev.push({ k: 'get', seat: c.seat, it: c.it }); return;
    }
  }
  function rollItem(w, c) {                                // trailing cars get better odds of the attack, the leader never gets one (it has nobody to hit)
    var live = ranking(w).filter(function (x) { return !x.fin; }), rk = live.indexOf(c), n = Math.max(1, live.length - 1), f = rk < 0 ? 0.5 : rk / n;
    var wt = [0, 1.2, 1, rk > 0 ? 0.7 + 1.3 * f : 0], tot = wt[1] + wt[2] + wt[3], x = w.rs() * tot;
    return x < wt[1] ? IT_TURBO : x < wt[1] + wt[2] ? IT_SHIELD : IT_ZAP;
  }
  function useItem(w, c) {
    var it = c.it;
    if (it === IT_TURBO) { c.tb = TURBO_T; c.nit = Math.min(100, c.nit + 25); c.it = 0; w.ev.push({ k: 'use', seat: c.seat, it: it }); }
    else if (it === IT_SHIELD) { c.sh = SHIELD_T; c.it = 0; w.ev.push({ k: 'use', seat: c.seat, it: it }); }
    else if (it === IT_ZAP) {
      var live = ranking(w).filter(function (x) { return !x.fin; }), at = live.indexOf(c), t = at > 0 ? live[at - 1] : null;
      if (!t) return;                                      // nobody in front: keep it for later
      var blocked = t.sh > 0; if (blocked) t.sh = 0; else t.sl = ZAP_T;
      c.it = 0; w.ev.push({ k: 'zap', seat: c.seat, to: t.seat, blocked: blocked ? 1 : 0 });
    }
  }
  function zapTarget(w, c) { var live = ranking(w).filter(function (x) { return !x.fin; }), at = live.indexOf(c); return at > 0 ? live[at - 1] : null; }
  // ranking: finished cars by finish tick, then unfinished by progress
  function ranking(w) {
    var fin = w.cars.filter(function (c) { return c.fin; }).sort(function (a, b) { return a.fin - b.fin || a.seat - b.seat; });
    var rest = w.cars.filter(function (c) { return !c.fin; }).sort(function (a, b) { return progress(w, b) - progress(w, a); });
    return fin.concat(rest);
  }
  // client side: adopt the server's state for my car, then replay the inputs the server has not applied yet
  function applyAuth(car, a, pending, tr, tfo) {          // tfo = { list: w.traffic, k: tick of the snapshot } - needed to replay traffic contacts
    tr = tr || TRACK;
    car.x = a.x; car.y = a.y; car.h = a.h; car.v = a.v; car.P = a.P; car.nit = a.nit; car.fin = a.fin; car.hits = a.hits; car.it = a.it | 0; car.tb = a.tb | 0; car.sh = a.sh | 0; car.sl = a.sl | 0;
    var nr = nearest(tr, car.x, car.y, -1); car.idx = nr.idx; car.off = nr.dist > tr.half ? 1 : 0;
    for (var i = 0; i < pending.length; i++) stepCar(car, pending[i], tr, tfo && tfo.list && tfo.list.length ? trafficAt(tfo.list, tfo.k + 1 + i, tr) : null);
    return car;
  }
  // ---- lane helpers: the swipe steering in the browser and the bot drivers on the server use these ----
  function lanePose(c) { var p = TRACK.pts[c.idx], th = TRACK.hd[c.idx]; return { lat: (c.x - p[0]) * -Math.sin(th) + (c.y - p[1]) * Math.cos(th), rel: wrapA(c.h - th) }; }
  function laneNearest(lat) { var b = 0; for (var i = 1; i < LANES.length; i++) if (Math.abs(LANES[i] - lat) < Math.abs(LANES[b] - lat)) b = i; return b; }
  function laneBend(c) {                                   // how fast the road itself is turning under the car (rad/s)
    var T = TRACK, j = (c.idx + 2) % T.N, dh = wrapA(T.hd[j] - T.hd[c.idx]), ds = ((T.cum[j] - T.cum[c.idx]) % T.len + T.len) % T.len || 1;
    return dh / ds * c.v;
  }
  function laneSteer(c, li) {                              // the steering value (-1..1) that takes the car to lane li and holds it there
    var L = LANES[li]; if (L === undefined || c.v < 8) return 0;
    var p = lanePose(c), want = clamp(7 * (L - p.lat) / Math.max(c.v, 35), -0.2, 0.2);
    var omega = laneBend(c) + 18 * (want - p.rel), s = c.st, gain = s.turn * (1 - 0.42 * clamp(c.v / (s.vmax * 1.1), 0, 1)) * clamp(c.v / 45, 0, 1);
    return gain > 0.05 ? clamp(omega / gain, -1, 1) : 0;
  }
  // ---- bot drivers (practice races): they look down the three lanes for traffic, pick the clearest, hold it with the same lane steering a swipe-driver uses, use nitro and power-ups ----
  function newBot(skill, seed) { return { skill: clamp(skill, 0.5, 1), lane: -1, next: 0, st: 0, nitOn: 0, itAt: 0, mis: 0, still: 0, back: 0, rnd: rng(seed >>> 0) }; }
  function laneClear(w, c, li, look) {
    var tr = TRACK, cs = tr.cum[c.idx], clear = look, t = w.tick * DT;
    if (w.crash) {                                                                          // crashes on: the other cars are obstacles too
      for (var oi = 0; oi < w.cars.length; oi++) {
        var o = w.cars[oi]; if (o === c || o.fin) continue;
        if (Math.abs(lanePose(o).lat - LANES[li]) > 24) continue;
        var od = ((tr.cum[o.idx] - cs) % tr.len + tr.len) % tr.len;
        if (od > tr.len - 30) od = 0;
        if (od < clear) clear = od;
      }
    }
    for (var k = 0; k < w.traffic.length; k++) {
      var q = w.traffic[k]; if (q.lat !== LANES[li]) continue;
      var qs = (q.s0 + q.v * t) % tr.len, d = ((qs - cs) % tr.len + tr.len) % tr.len;
      if (d > tr.len - 30) d = 0;                                                         // just alongside / behind me: it blocks the lane change
      if (d < clear) clear = d;
    }
    return clear;
  }
  function botInput(w, c, b) {
    var inp = { st: 0, th: 1, br: 0, ni: 0, us: 0 }, t = w.tick, tr = TRACK;
    if (c.fin) return inp;
    if (c.P < 1 && t < 24) return inp;                                                  // wait for the lights a moment like everybody else
    var pose = lanePose(c); if (b.lane < 0) b.lane = laneNearest(pose.lat);
    if (c.v < 8) { b.still++; } else b.still = 0;
    if (b.still > 45 && b.back <= 0) { b.back = 28; b.still = 0; }                                       // stuck: back up for a second, then try again
    if (b.back > 0) { b.back--; inp.th = 0; inp.br = 1; inp.st = clamp(-pose.rel * 1.5, -1, 1); b.st = inp.st; return inp; }
    var look = 110 + 190 * b.skill;
    if (t >= b.next) {
      b.next = t + 9 + ((b.rnd() * 9) | 0);
      var cur = laneClear(w, c, b.lane, look);
      if (b.mis > 0) b.mis--;
      else if (cur < look * 0.8) {                                                      // something in my lane: look for a better one (one step at a time)
        var best = b.lane, bs = cur;
        for (var li = Math.max(0, b.lane - 1); li <= Math.min(LANES.length - 1, b.lane + 1); li++) { if (li === b.lane) continue; var cl = laneClear(w, c, li, look); if (cl > bs + 25) { bs = cl; best = li; } }
        if (best !== b.lane) { if (b.rnd() > b.skill + 0.05) b.mis = 5; else b.lane = best; }
      } else if (b.rnd() < 0.02 * (1.2 - b.skill)) b.lane = clamp(b.lane + (b.rnd() < 0.5 ? -1 : 1), 0, LANES.length - 1);   // a bit of wandering
    }
    var raw = laneSteer(c, b.lane); b.st += clamp(raw - b.st, -0.26, 0.26); inp.st = Math.round(b.st * 100) / 100;
    var ahead = laneClear(w, c, laneNearest(pose.lat), 90);
    if (ahead < 55 && c.v > 110) { inp.th = 0; inp.br = 0.5; }                           // too close to the car in front: ease off
    var straight = Math.abs(laneBend(c)) < 0.12;
    if (b.nitOn) { if (c.nit < 8 || !straight) b.nitOn = 0; } else if (c.nit > 72 && straight && ahead > 140 && b.rnd() < 0.05 * b.skill) b.nitOn = 1;
    inp.ni = b.nitOn ? 1 : 0;
    if (c.it) {                                                                          // use whatever it picked up after a short think
      if (!b.itAt) b.itAt = t + 18 + ((b.rnd() * 70) | 0);
      else if (t >= b.itAt && (c.it !== IT_ZAP || zapTarget(w, c))) { inp.us = 1; b.itAt = 0; }
    } else b.itAt = 0;
    return inp;
  }
  return { gridSlot: gridSlot, MAXP: MAXP, makeBoxes: makeBoxes, boxPos: boxPos, zapTarget: zapTarget, TURBO_T: TURBO_T, SHIELD_T: SHIELD_T, ZAP_T: ZAP_T, IT_TURBO: IT_TURBO, IT_SHIELD: IT_SHIELD, IT_ZAP: IT_ZAP, REV_MAX: REV_MAX,
           lanePose: lanePose, laneNearest: laneNearest, laneBend: laneBend, laneSteer: laneSteer, newBot: newBot, botInput: botInput, applyAuth: applyAuth, makeTraffic: makeTraffic, trafficAt: trafficAt, collideCars: collideCars, BAR: BAR, LANES: LANES, HZ: HZ, DT: DT, TRACK: TRACK, K: K, CAR_R: CAR_R, clampInput: clampInput, statsFrom: statsFrom, newCar: newCar, stepCar: stepCar,
           newRace: newRace, stepWorld: stepWorld, lapsDone: lapsDone, ranking: ranking, progress: progress, nearest: nearest, gridPos: gridPos };
});
