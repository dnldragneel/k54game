// Authoritative race server logic (2 to 5 players): lobbies, matchmaking, private rooms, countdown, simulation, results, reconnect.
// Transport-agnostic: it works on "conn" objects with send(text) / close(code, reason) / onmessage / onclose (see ws.mjs).
import { createRequire } from 'node:module';
import { randomUUID, randomInt } from 'node:crypto';
const Sim = createRequire(import.meta.url)('../shared/race-sim.cjs');

export const DEFAULTS = {
  laps: 3, minPlayers: 2, maxPlayers: 5, countdownMs: 5600, fullStartDelayMs: 3000, minStartWaitMs: 15000, readyStartDelayMs: 1500,
  finishTimeoutMs: 20000, graceMs: 15000, lobbyGraceMs: 10000, soloWaitMs: 90000, resultsKeepMs: 60000, helloTimeoutMs: 5000, maxRooms: 300, commitRetries: 3,
  traffic: true, reactGapMs: 600,
};
// the only reactions a player can send (no free text, so nothing to moderate): the app maps each to its emoji
export const PROTOCOL = 3;                                          // 3 = up to five racers + a 5-4-3-2-1 start (countdown message carries the grid); 2 = guard rails + shared traffic seed + reactions; the app refuses an older race server (its rules would not match)
export const REACTIONS = ['laugh', 'smile', 'cool', 'thumbs', 'cry'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const r1 = (n) => Math.round(n * 10) / 10;

export function createGame(userCfg, supa, log = () => {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const sessions = new Map(), userRoom = new Map(), rooms = new Map(), codes = new Map();
  const timers = new Set();
  let openPublic = null;                                              // the public room that is still filling up
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const stats = { started: 0, finished: 0, commitFailures: 0, reactions: 0 };

  const out = (conn, obj) => conn && !conn.closed && conn.send(JSON.stringify(obj));

  class Room {
    constructor(mode) {
      this.id = randomUUID(); this.mode = mode; this.status = 'lobby'; this.players = []; this.code = null; this.host = null;
      this.createdAt = Date.now(); this.minSince = 0; this.startTimer = null; this.startAt = 0; this.world = null; this.loop = null;
      this.firstFinishAt = 0; this.committed = false;
    }
    get connected() { return this.players.filter((p) => p.connected && !p.left); }
    broadcast(obj) { const s = JSON.stringify(obj); for (const p of this.players) if (p.connected && p.conn && !p.left) p.conn.send(s); }
    lobbyMsg() {
      return { t: 'lobby', room: { id: this.id, code: this.code, mode: this.mode, status: this.status, min: cfg.minPlayers, max: cfg.maxPlayers, laps: cfg.laps,
        startsIn: this.startAt ? Math.max(0, this.startAt - Date.now()) : null, host: this.host,
        players: this.players.filter((p) => !p.left).map((p) => ({ id: p.userId, name: p.name, level: p.level, car: p.car.id, carName: p.car.name, ready: p.ready, connected: p.connected, seat: p.seat })) } };
    }
    sendLobby() { this.broadcast(this.lobbyMsg()); }
    add(p) { p.seat = this.players.length; this.players.push(p); if (!this.host) this.host = p.userId; if (this.connected.length >= cfg.minPlayers && !this.minSince) this.minSince = Date.now(); this.armSolo(); }
    armSolo() {                                    // nobody joined for a long time: tell the player instead of waiting forever
      clearTimeout(this.soloTimer);
      if (this.mode !== 'public' || this.status !== 'lobby' || this.connected.length >= cfg.minPlayers) return;
      this.soloTimer = later(cfg.soloWaitMs, () => {
        if (this.status !== 'lobby' || this.connected.length >= cfg.minPlayers) return;
        this.broadcast({ t: 'err', code: 'no_opponents' }); this.destroy();
      });
    }
    evaluate() {                                   // decides if/when the countdown begins
      if (this.status !== 'lobby') return;
      clearTimeout(this.startTimer); this.startTimer = null; this.startAt = 0;
      const live = this.connected, n = live.length, allReady = n >= cfg.minPlayers && live.every((p) => p.ready);
      if (n < cfg.minPlayers) { this.minSince = 0; this.armSolo(); this.sendLobby(); return; }
      if (!this.minSince) this.minSince = Date.now();
      let at = Infinity;
      if (this.mode === 'public') {
        at = n >= cfg.maxPlayers ? Date.now() + cfg.fullStartDelayMs : this.minSince + cfg.minStartWaitMs;
        if (allReady) at = Math.min(at, Date.now() + cfg.readyStartDelayMs);
      } else if (allReady) at = Date.now() + cfg.readyStartDelayMs;
      if (at !== Infinity) { this.startAt = at; this.startTimer = later(Math.max(0, at - Date.now()), () => this.countdown()); }
      this.sendLobby();
    }
    countdown() {
      if (this.status !== 'lobby') return;
      if (this.connected.length < cfg.minPlayers) return this.evaluate();
      this.status = 'countdown'; this.startAt = 0; this.sendLobby();
      this.seed = cfg.traffic ? randomInt(1, 2147483647) : 0;                          // one traffic pattern per race, the same for every driver
      this.broadcast({ t: 'countdown', ms: cfg.countdownMs, seed: this.seed });
      this.startTimer = later(cfg.countdownMs, () => this.go());
    }
    go() {
      if (this.status !== 'countdown') return;
      if (this.connected.length < cfg.minPlayers) { this.status = 'lobby'; this.players.forEach((p) => (p.ready = false)); return this.evaluate(); }
      for (const p of this.players) if (!p.connected) p.left = true;                      // someone vanished during the countdown
      this.players = this.players.filter((p) => !p.left); this.players.forEach((p, i) => (p.seat = i));
      this.status = 'racing'; stats.started++;
      if (this.seed == null) this.seed = cfg.traffic ? randomInt(1, 2147483647) : 0;
      this.world = Sim.newRace(this.players.map((p) => ({ id: p.userId, meta: p.car.meta })), cfg.laps, this.seed);
      this.startedAt = Date.now();
      for (const p of this.players) { p.q = []; p.nextIn = 0; p.ack = -1; p.lastIn = Sim.clampInput({}); }
      this.broadcast(this.startMsg()); this.broadcast({ t: 'go' });
      this.t0 = performance.now(); this.n = 0; this.loop = setTimeout(() => this.tickLoop(), 0);
      log('race_start', { room: this.id, mode: this.mode, players: this.players.length });
    }
    startMsg() {
      return { t: 'start', room: this.id, laps: cfg.laps, hz: Sim.HZ, seed: this.seed || 0, seats: this.players.map((p) => ({ seat: p.seat, id: p.userId, name: p.name, level: p.level, car: p.car.id, carName: p.car.name, stats: p.car.meta, deco: p.deco })) };
    }
    tickLoop() {
      if (this.status !== 'racing') return;
      const dtMs = Sim.DT * 1000;
      let guard = 0;
      while (guard++ < 4 && performance.now() - this.t0 >= this.n * dtMs) { this.n++; this.step(); if (this.status !== 'racing') return; }
      const next = this.t0 + this.n * dtMs - performance.now();
      this.loop = setTimeout(() => this.tickLoop(), Math.max(1, next));
    }
    step() {
      const w = this.world, inputs = {}, now = Date.now();
      for (const p of this.players) {
        let inp;
        if (p.left || (!p.connected && now - p.dcAt > 1000)) inp = Sim.clampInput({});                       // abandoned: coast
        else if (p.q.length) { const e = p.q.shift(); p.ack = e.idx; p.lastIn = e.inp; inp = e.inp; }
        else inp = p.lastIn;                                                                                // starved: repeat last input
        inputs[p.userId] = inp;
      }
      Sim.stepWorld(w, inputs);
      {
        const cars = w.cars.map((c, i) => [i, r1(c.x), r1(c.y), Math.round(c.h * 1000) / 1000, r1(c.v), c.P, Math.round(c.nit), c.fin ? 1 : 0, c.hits]);
        for (const p of this.players) if (p.connected && p.conn && !p.left) p.conn.send(JSON.stringify({ t: 's', k: w.tick, a: p.ack, c: cars }));
      }
      const finished = w.cars.filter((c) => c.fin).length;
      if (finished && !this.firstFinishAt) this.firstFinishAt = now;
      const stillRacing = this.players.filter((p) => !w.cars[p.seat].fin);
      const nobodyHere = stillRacing.every((p) => p.left || (!p.connected && now - p.dcAt > cfg.graceMs));
      if (finished === w.cars.length || nobodyHere || (this.firstFinishAt && now - this.firstFinishAt > cfg.finishTimeoutMs) || w.tick > Sim.HZ * 60 * 10) this.finish();
    }
    async finish() {
      if (this.status !== 'racing') return;
      this.status = 'finished'; clearTimeout(this.loop);
      const w = this.world, ranked = Sim.ranking(w);
      const rows = ranked.map((c, i) => { const p = this.players.find((x) => x.userId === c.id); return {
        user: c.id, seat: p.seat, car: p.car.id, position: i + 1, finish_ms: c.fin ? Math.round(c.fin * Sim.DT * 1000) : null, dnf: !c.fin, collisions: c.hits,
        best_lap_ms: c.best ? Math.round(c.best * 1000) : null, forfeit: !c.fin && (p.left || !p.connected), name: p.name }; });
      let rewards = null;
      for (let a = 0; a < cfg.commitRetries && !rewards; a++) {
        try {
          const r = await supa.rpc('k54_svc_race_commit', { p_room: this.id, p_meta: { mode: this.mode, code: this.code, track_id: 'loop-1', laps: cfg.laps, started_at: new Date(this.startedAt).toISOString(), finished_at: new Date().toISOString() },
                                                         p_results: rows.map(({ name, ...r }) => r) });
          if (r?.ok) rewards = r.duplicate ? [] : r.rewards; else throw new Error(r?.error || 'commit_failed');
        } catch (e) { stats.commitFailures++; log('commit_error', { room: this.id, err: String(e.message || e) }); await new Promise((res) => setTimeout(res, 400 * (a + 1))); }
      }
      stats.finished++;
      const byUser = new Map((rewards || []).map((x) => [x.user, x]));
      const msg = { t: 'results', room: this.id, rewards_pending: rewards === null,
        rows: rows.map((r) => ({ id: r.user, seat: r.seat, name: r.name, pos: r.position, ms: r.finish_ms, dnf: r.dnf, best: r.best_lap_ms, hits: r.collisions, coins: byUser.get(r.user)?.coins ?? 0, xp: byUser.get(r.user)?.xp ?? 0 })) };
      this.broadcast(msg); this.resultMsg = msg;
      for (const p of this.players) { if (userRoom.get(p.userId) === this) userRoom.delete(p.userId); }
      log('race_end', { room: this.id, rewards: rewards === null ? 'pending' : 'ok' });
      later(cfg.resultsKeepMs, () => this.destroy());
    }
    removePlayer(userId, why) {
      const p = this.players.find((x) => x.userId === userId); if (!p) return;
      if (userRoom.get(userId) === this) userRoom.delete(userId);
      if (this.status === 'racing' || this.status === 'finished') { p.left = true; p.ready = false; return; }
      this.players = this.players.filter((x) => x !== p); this.players.forEach((x, i) => (x.seat = i));
      if (this.host === userId) this.host = this.players[0]?.userId || null;
      if (this.status === 'countdown' && this.connected.length < cfg.minPlayers) { clearTimeout(this.startTimer); this.status = 'lobby'; this.players.forEach((x) => (x.ready = false)); }
      if (!this.players.length) return this.destroy();
      this.evaluate();
    }
    destroy() {
      clearTimeout(this.startTimer); clearTimeout(this.loop); clearTimeout(this.soloTimer); rooms.delete(this.id); if (this.code) codes.delete(this.code);
      if (openPublic === this) openPublic = null;
      for (const p of this.players) if (userRoom.get(p.userId) === this) userRoom.delete(p.userId);
    }
  }

  const newCode = () => { for (let i = 0; i < 50; i++) { let c = ''; for (let k = 0; k < 5; k++) c += CODE_CHARS[randomInt(CODE_CHARS.length)]; if (!codes.has(c)) return c; } return null; };

  async function enter(s, carId) {                                     // asks the database if this account may race with this car
    const e = await supa.rpc('k54_svc_race_entry', { p_user: s.user.id, p_car: typeof carId === 'string' ? carId.slice(0, 40) : '' });
    if (!e?.ok) { s.err(e?.error || 'not_allowed', { feature: e?.feature, limit: e?.limit }); return null; }
    return e;
  }
  const mkPlayer = (s, e) => ({ userId: s.user.id, name: e.name, level: e.level, premium: e.premium, car: { id: e.car.id, name: e.car.name, meta: e.car.meta }, deco: e.deco || {},
    ready: false, connected: true, conn: s.conn, left: false, seat: 0, q: [], nextIn: 0, ack: -1, lastIn: Sim.clampInput({}), dcAt: 0, lastQ: Sim.clampInput({}) });

  class Session {
    constructor(conn) { this.conn = conn; this.user = null; this.authed = false; this.busy = false; this.bad = 0; this.replaced = false; }
    send(o) { out(this.conn, o); }
    err(code, extra) { this.send({ t: 'err', code, ...(extra || {}) }); }
    fail(code) { this.err(code); this.conn.close(4003, code); }
    get room() { return this.user ? userRoom.get(this.user.id) : null; }
    get player() { const r = this.room; return r ? r.players.find((p) => p.userId === this.user.id) : null; }
  }

  async function onMessage(s, text) {
    let m; try { m = JSON.parse(text); } catch { return s.bad++ > 5 ? s.conn.close(1007, 'bad json') : null; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    if (m.t === 'in') return onInput(s, m);
    if (m.t === 'ping') return s.send({ t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'react') return onReact(s, m);
    if (m.t === 'hello') return onHello(s, m);
    if (!s.authed) return;
    if (s.busy) return s.err('busy');                                   // one lobby action at a time per connection
    s.busy = true;
    try { await lobbyAction(s, m); } catch (e) { log('action_error', { t: m.t, err: String(e.message || e) }); s.err('server_error'); } finally { s.busy = false; }
  }

  async function onHello(s, m) {
    if (s.authed || s.helloing) return;
    s.helloing = true;
    let user;
    try { user = await supa.getUser(m.token); } catch { return s.fail('auth_unavailable'); }
    if (!user) return s.fail('bad_token');
    if (user.anonymous) return s.fail('account_required');
    const old = sessions.get(user.id);
    if (old && old !== s) { old.replaced = true; old.conn.close(4001, 'replaced'); }
    s.user = user; s.authed = true; sessions.set(user.id, s);
    s.send({ t: 'welcome', id: user.id, hz: Sim.HZ, v: PROTOCOL });
    const room = userRoom.get(user.id);                                  // reconnect: pick up where we left off
    if (room) {
      const p = room.players.find((x) => x.userId === user.id);
      if (p && !p.left) {
        p.connected = true; p.conn = s.conn; clearTimeout(p.dcTimer);
        s.send({ t: 'resume', status: room.status });
        if (room.status === 'racing') { s.send(room.startMsg()); p.q = []; p.nextIn = 0; p.ack = -1; s.send({ t: 'go' }); }
        else s.send(room.lobbyMsg());
        if (room.status === 'lobby') room.evaluate();
      }
    }
  }

  async function lobbyAction(s, m) {
    const room = s.room, p = s.player;
    switch (m.t) {
      case 'queue': {
        if (room) return s.err('already_in_room');
        if (rooms.size >= cfg.maxRooms) return s.err('server_busy');
        const e = await enter(s, m.car); if (!e) return;
        if (s.room) return s.err('already_in_room');
        let r = openPublic && openPublic.status === 'lobby' && openPublic.players.length < cfg.maxPlayers ? openPublic : null;
        if (!r) { r = new Room('public'); rooms.set(r.id, r); openPublic = r; }
        const pl = mkPlayer(s, e); r.add(pl); userRoom.set(s.user.id, r);
        if (r.players.length >= cfg.maxPlayers) openPublic = null;
        r.evaluate(); return;
      }
      case 'create': {
        if (room) return s.err('already_in_room');
        if (rooms.size >= cfg.maxRooms) return s.err('server_busy');
        const e = await enter(s, m.car); if (!e) return;
        const code = newCode(); if (!code) return s.err('server_busy');
        const r = new Room('private'); r.code = code; codes.set(code, r); rooms.set(r.id, r);
        r.add(mkPlayer(s, e)); userRoom.set(s.user.id, r); r.evaluate(); return;
      }
      case 'join': {
        if (room) return s.err('already_in_room');
        const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        const r = codes.get(code);
        if (!r || r.status !== 'lobby') return s.err('room_not_found');
        if (r.players.length >= cfg.maxPlayers) return s.err('room_full');
        const e = await enter(s, m.car); if (!e) return;
        if (r.status !== 'lobby' || r.players.length >= cfg.maxPlayers) return s.err('room_full');
        r.add(mkPlayer(s, e)); userRoom.set(s.user.id, r); r.evaluate(); return;
      }
      case 'car': {
        if (!room || room.status !== 'lobby' || !p) return s.err('not_in_lobby');
        const e = await enter(s, m.car); if (!e) return;
        p.car = { id: e.car.id, name: e.car.name, meta: e.car.meta }; p.deco = e.deco || {}; p.ready = false; room.sendLobby(); return;
      }
      case 'ready': {
        if (!room || room.status !== 'lobby' || !p) return s.err('not_in_lobby');
        p.ready = !!m.on; room.evaluate(); return;
      }
      case 'leave': {
        if (!room) return;
        room.removePlayer(s.user.id); s.send({ t: 'left' }); return;
      }
      default: return;
    }
  }

  function onInput(s, m) {
    const room = s.room; if (!room || room.status !== 'racing') return;
    const p = s.player; if (!p || p.left) return;
    const n = m.n; if (!Number.isInteger(n) || n < 0) return;
    if (n < p.nextIn) return;                                            // duplicate / old
    if (n - p.nextIn > 12) p.nextIn = n;                                 // big gap: resynchronise
    while (p.nextIn < n) { p.q.push({ idx: p.nextIn++, inp: p.lastQ }); }   // short gap: repeat the last input
    const inp = Sim.clampInput(m); p.lastQ = inp; p.q.push({ idx: n, inp }); p.nextIn = n + 1;
    if (p.q.length > 6) { const drop = p.q.splice(0, p.q.length - 6); p.ack = drop[drop.length - 1].idx; }   // client running ahead: skip old inputs
  }

  // a quick emoji from a driver, shown to everyone in the race above that car and in the live feed (whitelisted, rate limited)
  function onReact(s, m) {
    const room = s.room, p = s.player;
    if (!room || !p || p.left || (room.status !== 'racing' && room.status !== 'countdown')) return;
    if (typeof m.e !== 'string' || !REACTIONS.includes(m.e)) return;
    const now = Date.now(); if (now - (p.reactAt || 0) < cfg.reactGapMs) return;
    p.reactAt = now; stats.reactions++;
    room.broadcast({ t: 'react', seat: p.seat, e: m.e });
  }

  function onConnection(conn) {
    const s = new Session(conn);
    const hello = later(cfg.helloTimeoutMs, () => { if (!s.authed) conn.close(4002, 'hello timeout'); });
    conn.onmessage = (t) => onMessage(s, t);
    conn.onclose = () => {
      clearTimeout(hello);
      if (!s.user || s.replaced) return;
      if (sessions.get(s.user.id) === s) sessions.delete(s.user.id);
      const room = userRoom.get(s.user.id); const p = room?.players.find((x) => x.userId === s.user.id);
      if (!room || !p) return;
      p.connected = false; p.dcAt = Date.now();
      if (room.status === 'lobby' || room.status === 'countdown') {
        p.dcTimer = later(cfg.lobbyGraceMs, () => { if (!p.connected) room.removePlayer(p.userId); });
        room.evaluate();
      }
    };
  }

  return {
    onConnection, cfg, stats,
    snapshot() { let lobby = 0, racing = 0; for (const r of rooms.values()) { if (r.status === 'racing') racing++; else if (r.status === 'lobby' || r.status === 'countdown') lobby++; } return { sessions: sessions.size, rooms: rooms.size, lobby, racing, ...stats }; },
    stop() { for (const t of timers) clearTimeout(t); for (const r of rooms.values()) { clearTimeout(r.startTimer); clearTimeout(r.loop); } },
  };
}
