/* K54 race simulation - shared by the authoritative server and the browser (client-side prediction).
   Deterministic fixed-step top-down driving model. No DOM, no Node APIs, no randomness. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.K54Sim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var HZ = 30, DT = 1 / HZ;
  var SCALE = 1.7, HALF = 62;                                   // track half width (world units)
  var CTRL = [[0, -300], [300, -320], [520, -200], [560, 0], [430, 160], [200, 150], [60, 260], [-180, 300], [-420, 180], [-480, -60], [-350, -250]];
  var K = 16;                                                   // checkpoints per lap (classic track; every track has its own tr.K)
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
  var CRASH_E = 0.5, CRASH_MIN = 8;                              // crashes: how bouncy a bump is, and the smallest bump that counts as a crash (units/s of closing speed)
  var CRASH_BIG = 34, GH_T = 14, SO_T = 22;                      // a bump this hard is a TAKEDOWN (the victim spins out for SO_T ticks); after any crash both cars are ghosts for GH_T ticks so nobody gets pinned
  // drifting: hold DRIFT while turning above DR_MIN. The nose swings past the direction of travel (slip angle, at most DR_SLIP rad); a long drift pays out nitro and a mini-turbo when you let go
  var DR_MIN = 110, DR_SLIP = 0.5, DR_RATE = 4.5, DR_T1 = 22, DR_T2 = 55, MT1 = 15, MT2 = 33;
  // ramps: a jump pad in one lane. Fast enough = the car flies (steering mostly off, no traffic or car contact), a straight landing pays nitro
  var RAMP_V = 105, RAMP_KICK = 34, RAMP_HL = 22, RAMP_HW = 24;
  var DRAFT_MIN = 15;                                            // slipstream: ticks right behind another car before it helps

  function crom(p0, p1, p2, p3, t) {
    var t2 = t * t, t3 = t2 * t;
    return [0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
            0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)];
  }
  // def: { ctrl, scale, smooth (moving-average passes), step (resample to this spacing, 0 = keep the spline samples), K (gates per lap), ramps (count) }
  function buildTrack(def) {
    def = def || {}; var ctrl = def.ctrl || CTRL, scale = def.scale || SCALE;
    var n = ctrl.length, pts = [], i, s;
    for (i = 0; i < n; i++) {
      var p0 = ctrl[(i + n - 1) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
      for (s = 0; s < SEG; s++) { var q = crom(p0, p1, p2, p3, s / SEG); pts.push([q[0] * scale, q[1] * scale]); }
    }
    for (var it = 0; it < (def.smooth || 0); it++) {                                   // rounds off any corner that is too sharp to drive
      var sm = [], M = pts.length;
      for (i = 0; i < M; i++) { var pa = pts[(i + M - 1) % M], pb = pts[i], pc = pts[(i + 1) % M]; sm.push([(pa[0] + 2 * pb[0] + pc[0]) / 4, (pa[1] + 2 * pb[1] + pc[1]) / 4]); }
      pts = sm;
    }
    if (def.step) {                                                                   // even spacing along the road (the nearest-point search and the gates rely on it)
      var tot = 0, M2 = pts.length, cl = [0];
      for (i = 0; i < M2; i++) { var u = pts[i], v = pts[(i + 1) % M2]; tot += Math.sqrt((v[0] - u[0]) * (v[0] - u[0]) + (v[1] - u[1]) * (v[1] - u[1])); cl.push(tot); }
      var cnt = Math.max(24, Math.round(tot / def.step)), out = [], j = 0;
      for (i = 0; i < cnt; i++) {
        var tt = tot * i / cnt; while (j < M2 - 1 && cl[j + 1] <= tt) j++;
        var f0 = (tt - cl[j]) / ((cl[j + 1] - cl[j]) || 1), A = pts[j], B = pts[(j + 1) % M2];
        out.push([A[0] + (B[0] - A[0]) * f0, A[1] + (B[1] - A[1]) * f0]);
      }
      pts = out;
    }
    var N = pts.length, cum = [0], len = 0, hd = [];
    for (i = 0; i < N; i++) {
      var a = pts[i], b = pts[(i + 1) % N];
      var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.sqrt(dx * dx + dy * dy);
      len += d; cum.push(len); hd.push(Math.atan2(dy, dx));
    }
    var Kg = def.K || K, cp = []; for (i = 0; i < Kg; i++) cp.push(Math.round(i * N / Kg) % N);
    var tr = { id: def.id || 'classic', pts: pts, N: N, len: len, cum: cum, hd: hd, half: HALF, cp: cp, K: Kg, ramps: [], boxN: def.boxes || BOX_PER_LAP };
    tr.ramps = makeRamps(tr, def.ramps === undefined ? 3 : def.ramps);
    return tr;
  }
  // ramps sit on the straightest stretches (at most a few degrees of bend over 300 units), spread round the lap, never in the first 400 units after the line
  function makeRamps(tr, count) {
    var list = [], i, k, N = tr.N, per = tr.len / N;
    if (!count) return list;
    var win = Math.max(3, Math.round(150 / per));
    function bend(ix) { var tot = 0; for (var q = -win; q < win; q++) tot += Math.abs(wrapA(tr.hd[(ix + q + 1 + N * 4) % N] - tr.hd[(ix + q + N * 4) % N])); return tot; }
    for (i = 0; i < count; i++) {
      var centre = tr.len * (i + 0.55) / count, best = -1, bb = 1e9;
      for (k = 0; k < N; k++) {
        var sd = tr.cum[k]; if (sd < 650 || sd > tr.len - 300) continue;
        var dd = Math.abs(sd - centre); if (dd > tr.len / count * 0.42) continue;
        var b = bend(k) + dd * 0.00002; if (b < bb) { bb = b; best = k; }
      }
      if (best < 0) continue;
      var p = tr.pts[best], h = tr.hd[best], lat = LANES[(i * 2 + 1) % LANES.length];
      list.push({ id: list.length, s: tr.cum[best], lat: lat, x: p[0] - Math.sin(h) * lat, y: p[1] + Math.cos(h) * lat, h: h });
    }
    return list;
  }
  // ---- the track catalogue: the same four tracks on the server and in every browser ----
  var SKINS = ['city', 'beach', 'neon', 'desert', 'snow', 'jungle', 'rain', 'savanna', 'moon', 'harbour'];
  function lobes(n, k, A, B, ap, bp, ph1, ph2, sn) {                                // a smooth twisty loop: an ellipse whose radius wobbles k times round the lap, with a straight start
    var pts = [], i; for (i = 0; i < n; i++) { var th = -Math.PI / 2 + 2 * Math.PI * i / n; pts.push([Math.round((A + ap * Math.sin(k * th + ph1)) * Math.cos(th)), Math.round((B + bp * Math.sin(k * th + ph2)) * Math.sin(th))]); }
    var y0 = pts[0][1]; return pts.map(function (p, ix) { return Math.min(ix, n - ix) <= sn ? [p[0], y0] : p; });
  }
  var TDEF = {
    classic: { id: 'classic', name: 'City Circuit', ctrl: CTRL, scale: SCALE, K: 16, ramps: 2, boxes: 6, laps: 3, night: 0, skins: ['city', 'beach', 'desert', 'snow', 'jungle', 'rain', 'savanna'] },
    curvy: { id: 'curvy', name: 'Serpentine Pass', ctrl: lobes(44, 6, 520, 340, 65, 55, 0.9, 0.2, 2), scale: SCALE, smooth: 6, step: 17, K: 20, ramps: 3, boxes: 7, laps: 3, night: 0, skins: ['jungle', 'snow', 'desert', 'savanna', 'rain', 'city'] },
    long: { id: 'long', name: 'Grand Tour', ctrl: lobes(44, 4, 1400, 830, 150, 115, 0.5, 2.2, 2), scale: SCALE, smooth: 8, step: 17, K: 24, ramps: 5, boxes: 10, laps: 1, night: 0, skins: ['beach', 'desert', 'savanna', 'city', 'rain', 'snow'] },
    night: { id: 'night', name: 'Neon Harbour', ctrl: [[0, -300], [250, -300], [450, -250], [540, -110], [500, 20], [390, 90], [440, 190], [420, 320], [270, 400], [60, 410], [-90, 330], [-250, 400], [-430, 370], [-530, 230], [-490, 60], [-390, -30], [-470, -150], [-420, -260], [-250, -300]], scale: SCALE, smooth: 4, step: 17, K: 18, ramps: 3, boxes: 7, laps: 3, night: 1, skins: ['neon', 'moon', 'harbour'] }
  };
  var TRACK_IDS = ['classic', 'curvy', 'long', 'night'];
  var TCACHE = {};
  function track(id) { if (!TDEF[id]) id = 'classic'; return TCACHE[id] || (TCACHE[id] = buildTrack(TDEF[id])); }
  var TFLAT = {};
  function trackFlat(id) { var t = track(id); return TFLAT[t.id] || (TFLAT[t.id] = Object.assign({}, t, { ramps: [] })); }   // the same road without jump pads (tests; a room may switch them off)
  function trackInfo(id) { var d = TDEF[id] || TDEF.classic, t = track(d.id); return { id: d.id, name: d.name, laps: d.laps, night: d.night, skins: d.skins.slice(), len: Math.round(t.len), ramps: t.ramps.length }; }
  var TRACK = track('classic');

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
    return { st: isFinite(st) ? clamp(st, -1, 1) : 0, th: isFinite(th) ? clamp(th, 0, 1) : 0, br: isFinite(br) ? clamp(br, 0, 1) : 0, ni: i.ni ? 1 : 0, us: i.us ? 1 : 0, dr: i.dr ? 1 : 0 };
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
  function bindTrack(c, tr) { Object.defineProperty(c, 'tr', { value: tr, writable: true, enumerable: false, configurable: true }); return c; }   // the track rides on the car but is never part of its state (JSON, snapshots)
  function newCar(id, seat, meta, tr) {
    tr = tr || TRACK; var g = gridPos(tr, seat);
    return bindTrack({ id: id, seat: seat, st: statsFrom(meta), x: g.x, y: g.y, h: g.h, v: 0, nit: 100, idx: nearest(tr, g.x, g.y, -1).idx, P: 0, fin: 0, hits: 0, lapT: 0, best: 0, off: 0, ev: 0, tch: 0, it: 0, tb: 0, sh: 0, sl: 0, up: 0, got: 0, gl: 0,
      sa: 0, df: 0, dc: 0, mt: 0, ai: 0, at: 0, rc: 0, gh: 0, so: 0, dd: 0, sD: 0, sA: 0, sJ: 0, sT: 0, sC: 0, lh: 0, lp: 0, lc: 0, ll: 0, la: 0, bo: 0 }, tr);
  }
  // one car, one tick. Pure function of (car, input, track).
  // ev (transient, not state): 1 = scraped a rail, 2 = hit a traffic car, 4 = near miss, 8 = car-to-car crash, 16 / 32 = drift boost (small / big), 64 = took off from a ramp, 128 = perfect landing, 256 = rough landing, 512 = spun out by a takedown, 1024 = landed
  function stepCar(c, inp, tr, tf) {
    tr = tr || c.tr || TRACK; inp = clampInput(inp); c.ev = 0; var tch = 0;
    var s = c.st, air = c.ai > 0, spin = c.so !== 0, boost = c.bo = inp.ni && c.nit > 4 ? 1 : 0, tb = c.tb > 0, sh = c.sh > 0, sl = c.sl > 0, mt = c.mt > 0, dft = c.dd >= DRAFT_MIN;
    var vmax = s.vmax * (boost ? s.boostV : 1) * (c.off ? 0.84 : 1) * (tb ? 1.2 : 1) * (sl ? 0.5 : 1) * (mt ? 1.14 : 1) * (dft ? 1.05 : 1);     // power-ups: turbo +20%, a zap halves the top speed; a drift boost +14%, a slipstream +5%
    var acc = s.acc * (boost ? s.boostA : 1) * (tb ? 1.7 : 1) * (sl ? 0.45 : 1) * (mt ? 1.5 : 1) * (dft ? 1.25 : 1);
    if (boost) c.nit = Math.max(0, c.nit - 45 * DT); else c.nit = Math.min(100, c.nit + 9 * DT);
    if (dft) c.nit = Math.min(100, c.nit + 8 * DT);
    if (inp.th > 0 && c.v < vmax) c.v = Math.min(vmax, c.v + (acc + (c.v < 0 ? 220 : 0)) * inp.th * DT);   // (a car that is reversing gets a firm push to come to a stop first)
    if (air) { /* flying: no road friction */ }
    else if (c.v >= 0) c.v = Math.max(0, c.v - ((inp.th > 0 ? 0 : 38) * DT + c.v * 0.18 * DT + (c.off ? 26 * DT : 0)));   // drag, coasting, a little extra on the grass
    else c.v = Math.min(0, c.v + 38 * DT + (-c.v) * 0.18 * DT + (c.off ? 26 * DT : 0));                   // a reversing car rolls to a stop by itself
    if (inp.br > 0 && !air) {
      if (c.v > 0) c.v = Math.max(0, c.v - s.brake * inp.br * DT);                         // braking
      else if (inp.th <= 0) c.v = Math.max(-REV_MAX, c.v - REV_ACC * inp.br * DT);        // stopped and still holding the brake: reverse
    }
    if (c.v > vmax) c.v -= 260 * DT;                                                       // bleed off excess (leaving boost / entering grass)
    if (c.v < -REV_MAX) c.v = -REV_MAX;
    var speedF = clamp(c.v / 45, -1, 1), st = spin ? 0 : inp.st * (air ? 0.35 : 1);
    var turn = st * s.turn * (1 - 0.42 * clamp(Math.abs(c.v) / (s.vmax * 1.1), 0, 1)) * speedF;   // (negative speed: the steering works the other way round, like a real car)
    // ---- drifting: the nose swings round faster than the car travels. Holding DRIFT while turning builds a charge; letting go pays it out ----
    var wantDrift = inp.dr && !air && !spin && !c.off && c.v > (c.df ? DR_MIN * 0.75 : DR_MIN) && Math.abs(inp.st) > (c.df ? 0.12 : 0.3);
    if (wantDrift) {
      if (!c.df) { c.df = 1; c.dc = 0; }
      var tgt = (inp.st > 0 ? 1 : -1) * DR_SLIP * Math.min(1, Math.abs(inp.st) / 0.7);
      c.sa += clamp(tgt - c.sa, -DR_RATE * DT, DR_RATE * DT);
      turn *= 1.3;
      c.v -= c.v * 0.12 * DT * Math.abs(c.sa) / DR_SLIP;                                    // sliding scrubs a little speed
      if (Math.abs(c.sa) > 0.22) { c.dc++; c.sD++; c.nit = Math.min(100, c.nit + 16 * DT); }
    } else {
      if (c.df) {                                                                          // drift over: pay out the charge
        if (c.dc >= DR_T2) { c.mt = MT2; c.nit = Math.min(100, c.nit + 30); c.ev |= 32; }
        else if (c.dc >= DR_T1) { c.mt = MT1; c.nit = Math.min(100, c.nit + 14); c.ev |= 16; }
        c.df = 0; c.dc = 0;
      }
      if (c.sa !== 0) { var dec = (air ? 6 : 5) * DT; c.sa = Math.abs(c.sa) <= dec ? 0 : c.sa - (c.sa > 0 ? dec : -dec); }
    }
    c.h += turn * DT;
    if (spin) { c.h += 9 * DT * (Math.abs(c.so) / SO_T) * (c.so > 0 ? 1 : -1); c.v = Math.max(0, c.v - 140 * DT); }       // a takedown: the car spins out (steering is dead) and bleeds speed
    var vdir = c.h - c.sa;
    c.x += Math.cos(vdir) * c.v * DT; c.y += Math.sin(vdir) * c.v * DT;
    // ---- ramps: fast enough over the pad and the car takes off ----
    if (air) {
      c.ai--; c.sA++;
      if (c.ai <= 0) {                                                                      // landing: nose along the road = perfect
        var rl = Math.abs(wrapA(c.h - c.sa - tr.hd[c.idx]));
        if (rl < 0.4) { c.nit = Math.min(100, c.nit + 32); c.mt = Math.max(c.mt, MT1); c.ev |= 128; }
        else if (rl > 0.9) { c.v *= 0.82; c.ev |= 256; }
        else c.ev |= 1024;
        c.la = c.at; c.at = 0; c.rc = 24;
      }
    } else if (!spin) {
      if (c.rc > 0) c.rc--;
      else if (c.v >= RAMP_V && tr.ramps && tr.ramps.length) {
        for (var ri = 0; ri < tr.ramps.length; ri++) {
          var rp = tr.ramps[ri], rdx = c.x - rp.x, rdy = c.y - rp.y; if (rdx * rdx + rdy * rdy > 2600) continue;
          var rc2 = Math.cos(rp.h), rs2 = Math.sin(rp.h), rl2 = rdx * rc2 + rdy * rs2, rw2 = -rdx * rs2 + rdy * rc2;
          if (Math.abs(rl2) < RAMP_HL && Math.abs(rw2) < RAMP_HW) {
            c.at = c.ai = Math.round(clamp(8 + c.v * 0.07, 10, 28)); c.sJ++; c.sa = 0; c.df = 0; c.dc = 0;
            c.v = Math.min(c.v + RAMP_KICK, Math.max(c.v, vmax * 1.12)); c.ev |= 64; break;
          }
        }
      }
    }
    // traffic: touching a car costs speed and pushes you out of it; skimming past one at speed charges the nitro (a "near miss")
    if (tf && !air) for (var ti = 0; ti < tf.length; ti++) {                            // (a car in the air flies over traffic)
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
      if (c.P > 1 && (c.P - 1) % tr.K === 0) { if (!c.best || c.lapT < c.best) c.best = c.lapT; c.lc = c.hits === c.lh ? 1 : 0; c.sC += c.lc; c.lh = c.hits; c.ll = c.lapT; c.lapT = 0; c.lp = 1; }   // a lap was completed (c.lp: transient flag for the news; a lap with no hits at all is a clean lap)
      else if (c.P === 1) c.lapT = 0;
    }
    if (c.tb > 0) c.tb--; if (c.sh > 0) c.sh--; if (c.sl > 0) c.sl--;                      // power-up timers
    if (c.mt > 0) c.mt--; if (c.gh > 0) c.gh--; if (c.so > 0) c.so--; else if (c.so < 0) c.so++;
    return c;
  }
  // opts.power = true: the road has power-up boxes (see stepWorld).  opts.crash = true: the cars collide with each other (see collideCars).  opts.traffic = false: no traffic on the road.  Everything else is the same race.
  function newRace(players, laps, seed, opts) {
    seed = seed | 0; opts = opts || {};
    var tr = opts.ramps === false ? trackFlat(opts.track) : track(opts.track), cars = players.map(function (p, i) { return newCar(p.id, i, p.meta, tr); });
    var w = { tick: 0, laps: laps || 3, cars: cars, order: [], start: 0, seed: seed, tr: tr, trackId: tr.id, crash: !!opts.crash, traffic: seed && opts.traffic !== false ? makeTraffic(seed, tr) : [], power: !!opts.power, boxes: opts.power ? makeBoxes(seed, tr) : [], ev: [], lead: -1 };
    w.rs = rng((seed ^ 0x2545F491) >>> 0);                                    // the dice for power-ups (only the server rolls them)
    return w;
  }
  // ---- power-up boxes: the same six places on the road every lap, a random lane each (a pure function of the race seed) ----
  function makeBoxes(seed, tr) {
    tr = tr || TRACK; var r = rng((seed ^ 0x5bd1e995) >>> 0), list = [], i, nb = tr.boxN || BOX_PER_LAP, span = (tr.len - 500) / nb;
    for (i = 0; i < nb; i++) list.push({ id: i, s: 350 + (i + 0.15 + r() * 0.7) * span, lat: LANES[(r() * LANES.length) | 0] });
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
    var tr = (w && w.tr) || c.tr || TRACK, nxt = tr.cp[c.P % tr.K], prev = tr.cp[(c.P + tr.K - 1) % tr.K];
    var span = (nxt - prev + tr.N) % tr.N || 1, into = (c.idx - prev + tr.N) % tr.N;
    return c.P * 1000 + clamp(into / span, 0, 0.999) * 1000;
  }
  function lapsDone(c, tr) { tr = tr || c.tr || TRACK; return c.P < 1 ? 0 : Math.floor((c.P - 1) / tr.K); }
  // all cars one tick, input map by car id. Handles finishing, the slipstream and the news (w.ev).
  // Crashes are on by default (w.crash): cars bump, spin and take each other down (collideCars). Finished cars are ghosts so nobody is wrecked after the flag.
  function stepWorld(w, inputs) {
    var i, j, cars = w.cars, tr = w.tr || TRACK;
    w.tick++;
    var tf = w.traffic && w.traffic.length ? trafficAt(w.traffic, w.tick, tr) : null;
    for (i = 0; i < cars.length; i++) {
      var c = cars[i];
      if (c.fin) { c.v = Math.max(0, c.v - 120 * DT); c.x += Math.cos(c.h) * c.v * DT; c.y += Math.sin(c.h) * c.v * DT; continue; }
      c.lp = 0;
      draftCheck(w, c);
      if (w.power) { var ui = inputs[c.id] && inputs[c.id].us ? 1 : 0; if (ui && !c.up && c.it) useItem(w, c); c.up = ui; }
      stepCar(c, inputs[c.id], tr, tf);
      var e = c.ev;
      if (e & 48) w.ev.push({ k: 'drift', seat: c.seat, big: e & 32 ? 1 : 0 });
      if (e & 64) w.ev.push({ k: 'jump', seat: c.seat });
      if (e & (128 | 256 | 1024)) w.ev.push({ k: 'land', seat: c.seat, ok: e & 128 ? 1 : e & 256 ? 0 : 2, ms: Math.round(c.la * DT * 1000) });
      if (c.lp) w.ev.push({ k: 'lap', seat: c.seat, n: lapsDone(c, tr), ms: Math.round(c.ll * 1000), best: c.ll <= c.best ? 1 : 0, clean: c.lc });
      if (w.power) pickBoxes(w, c);
      if (c.P >= w.laps * tr.K + 1 && !c.fin) { c.fin = w.tick; w.order.push(c.id); }
    }
    if (w.crash) collideCars(w);
    if (w.tick % 15 === 0 && cars.length > 1) {                                           // who leads now? (news only when it changes hands after the first few gates)
      var rk = ranking(w), top = rk[0];
      if (top && !top.fin && top.P >= 3 && top.seat !== w.lead) { if (w.lead >= 0) w.ev.push({ k: 'lead', seat: top.seat }); w.lead = top.seat; }
      if (cars.length >= 3) { var last = rk[rk.length - 1]; if (last && !last.fin && last.P >= 2) last.nit = Math.min(100, last.nit + 5 * 15 * DT); }   // the car in last place charges its nitro a little faster
    }
    return w;
  }
  // slipstream: right behind a fast car (the same lane, close) for half a second makes the draft pay: more top speed, more acceleration, nitro
  function draftCheck(w, c) {
    var cars = w.cars, hit = 0, ch = Math.cos(c.h), sh = Math.sin(c.h);
    if (c.v > 120 && c.ai <= 0 && c.so === 0) for (var i = 0; i < cars.length; i++) {
      var o = cars[i]; if (o === c || o.fin || o.ai > 0 || o.v < 120) continue;
      var dx = o.x - c.x, dy = o.y - c.y, al = dx * ch + dy * sh, lt = -dx * sh + dy * ch;
      if (al > 14 && al < 120 && Math.abs(lt) < 20) { hit = 1; break; }
    }
    if (hit) { if (c.dd < 90) c.dd++; if (c.dd === DRAFT_MIN) w.ev.push({ k: 'draft', seat: c.seat }); } else if (c.dd > 0) c.dd = Math.max(0, c.dd - 2);
  }
  // ---- crashes: car against car. Two rectangles (CRASH_HL x CRASH_HW) are tested with the separating-axis rule; an overlap pushes both cars apart and swaps some of their
  //      speed along the line of the hit (equal weights). Whatever speed is left sideways turns the nose, and a hit off centre spins the car. Server-side only: the browser gets the result
  //      with the next snapshot (and an 'fx' news item for the bang). The sums use a fixed order of cars, so they are the same on every run. ----
  function collideCars(w) {
    var cars = w.cars, n = cars.length, i, j;
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      var a = cars[i], b = cars[j];
      if (a.fin || b.fin || a.gh > 0 || b.gh > 0 || a.ai > 0 || b.ai > 0) continue;               // finished, still recovering from a crash, or in the air: no contact
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
      var closeA = -(vax * nx + vay * ny), closeB = vbx * nx + vby * ny;                    // how fast each car was driving INTO the other one (the bigger number is the car that rammed)
      var vn = (vax - vbx) * nx + (vay - vby) * ny, J = 0;
      if (vn < 0) {
        J = -(1 + CRASH_E) * vn / 2;
        vax += J * nx; vay += J * ny; vbx -= J * nx; vby -= J * ny;
      }
      // contact point = half way between the centres; r x (J n) is the turning push on each car
      var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      var ta = (mx - a.x) * (J * ny) - (my - a.y) * (J * nx), tb = (mx - b.x) * (-J * ny) - (my - b.y) * (-J * nx);
      applyBump(a, vax, vay, ta); applyBump(b, vbx, vby, tb);
      if (J > CRASH_MIN) {
        a.hits++; b.hits++; a.ev |= 8; b.ev |= 8; a.gh = b.gh = GH_T; a.df = b.df = 0; a.dc = b.dc = 0;
        w.ev.push({ k: 'crash', a: a.seat, b: b.seat, f: Math.min(99, Math.round(J)) });
        if (J >= CRASH_BIG) {                                                              // a TAKEDOWN: the car that rammed gets nitro, the car that was hit spins out
          var ram = closeA >= closeB ? a : b, vic = ram === a ? b : a, dir = ((nx * ny >= 0 ? 1 : -1) * (vic === a ? 1 : -1));
          vic.so = dir * SO_T; vic.v *= 0.6; vic.nit = Math.max(0, vic.nit - 15); vic.ev |= 512;
          ram.nit = Math.min(100, ram.nit + 22); ram.sT++;
          w.ev.push({ k: 'take', a: ram.seat, b: vic.seat });
        }
      }
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
    var tr = w.tr || TRACK, lap = lapsDone(c, tr); if (c.gl !== lap) { c.gl = lap; c.got = 0; }
    if (c.it || c.P < 1) return;
    var cs = tr.cum[c.idx], lat = null;
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
    tr = tr || car.tr || TRACK;
    car.x = a.x; car.y = a.y; car.h = a.h; car.v = a.v; car.P = a.P; car.nit = a.nit; car.fin = a.fin; car.hits = a.hits; car.it = a.it | 0; car.tb = a.tb | 0; car.sh = a.sh | 0; car.sl = a.sl | 0;
    car.sa = +a.sa || 0; car.df = a.df | 0; car.dc = a.dc | 0; car.mt = a.mt | 0; car.ai = a.ai | 0; car.at = a.at | 0; car.rc = a.rc | 0; car.gh = a.gh | 0; car.so = a.so | 0; car.dd = a.dd | 0;
    var nr = nearest(tr, car.x, car.y, -1); car.idx = nr.idx; car.off = nr.dist > tr.half ? 1 : 0;
    for (var i = 0; i < pending.length; i++) stepCar(car, pending[i], tr, tfo && tfo.list && tfo.list.length ? trafficAt(tfo.list, tfo.k + 1 + i, tr) : null);
    return car;
  }
  // ---- lane helpers: the swipe steering in the browser and the bot drivers on the server use these ----
  function lanePose(c, tr) { tr = tr || c.tr || TRACK; var p = tr.pts[c.idx], th = tr.hd[c.idx]; return { lat: (c.x - p[0]) * -Math.sin(th) + (c.y - p[1]) * Math.cos(th), rel: wrapA(c.h - th) }; }
  function laneNearest(lat) { var b = 0; for (var i = 1; i < LANES.length; i++) if (Math.abs(LANES[i] - lat) < Math.abs(LANES[b] - lat)) b = i; return b; }
  function laneBend(c) {                                   // how fast the road itself is turning under the car (rad/s)
    var T = c.tr || TRACK, j = (c.idx + 2) % T.N, dh = wrapA(T.hd[j] - T.hd[c.idx]), ds = ((T.cum[j] - T.cum[c.idx]) % T.len + T.len) % T.len || 1;
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
    var tr = w.tr || TRACK, cs = tr.cum[c.idx], clear = look, t = w.tick * DT;
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
    var inp = { st: 0, th: 1, br: 0, ni: 0, us: 0, dr: 0 }, t = w.tick, tr = w.tr || TRACK;
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
    var bend = Math.abs(laneBend(c)), turnCap = c.st.turn * (1 - 0.42 * clamp(c.v / (c.st.vmax * 1.1), 0, 1)) * (0.62 + 0.3 * b.skill);   // the sharpest bend this car can take at this speed
    if (bend > turnCap && c.v > 70) { inp.th = 0; inp.br = clamp((bend - turnCap) * 1.4, 0.2, 0.8); }                                          // too fast into a tight corner: brake
    var straight = bend < 0.12;
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
           newRace: newRace, stepWorld: stepWorld, lapsDone: lapsDone, ranking: ranking, progress: progress, nearest: nearest, gridPos: gridPos,
           track: track, trackFlat: trackFlat, trackInfo: trackInfo, TRACK_IDS: TRACK_IDS, SKINS: SKINS, bindTrack: bindTrack,
           DR_MIN: DR_MIN, DR_SLIP: DR_SLIP, DR_T1: DR_T1, DR_T2: DR_T2, MT1: MT1, MT2: MT2, RAMP_V: RAMP_V, RAMP_HL: RAMP_HL, RAMP_HW: RAMP_HW, CRASH_BIG: CRASH_BIG, GH_T: GH_T, SO_T: SO_T, DRAFT_MIN: DRAFT_MIN };
});
