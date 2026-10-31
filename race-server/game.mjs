// Authoritative race server logic (2 to 10 players, two race modes, four tracks, practice races against bots): lobbies, matchmaking, private rooms, loading barrier, intro + countdown, simulation, results, reconnect.
// Transport-agnostic: it works on "conn" objects with send(text) / close(code, reason) / onmessage / onclose (see ws.mjs).
import { createRequire } from 'node:module';
import { randomUUID, randomInt } from 'node:crypto';
import { createDuels, DUEL_MSGS } from './duel.mjs';
const req = createRequire(import.meta.url);
const Sim = req('../shared/race-sim.cjs');
const QUIZ = req('../shared/quiz-bank.json');                        // { id: index of the right answer } for the road-sign questions of the quiz race

export const DEFAULTS = {
  laps: 3, minPlayers: 2, maxPlayers: 10, countdownMs: 5600, introMs: 4200, loadMinMs: 4500, loadMaxMs: 22000, fullStartDelayMs: 3000, minStartWaitMs: 15000, readyStartDelayMs: 1500,
  finishTimeoutMs: 25000, lootDailyCap: 5, graceMs: 15000, lobbyGraceMs: 10000, soloWaitMs: 90000, resultsKeepMs: 60000, helloTimeoutMs: 5000, maxRooms: 300, commitRetries: 3,
  traffic: true, reactGapMs: 600,
  botOfferMs: 30000, botCount: 5, practiceEndMs: 6000,                // alone in the queue for this long -> offer a practice race against bots; how many bots; how long after the human finishes the practice race closes
  quizAnswerMs: 7000, quizGates: [4, 9, 14],                          // quiz race: time to answer, and the checkpoints (of 16) where a question pops up each lap
};
export const VARIANTS = ['normal', 'power'];                         // the two race modes: a normal race and a race with power-ups (the sign-quiz race was removed; an old app that asks for it gets a normal race)
// the only reactions a player can send (no free text, so nothing to moderate): the app maps each to its emoji
// 8 = four tracks + skins (lobby / load / start carry track, skin, laps), crashes on by default, drifting (input 'dr'), ramps, a LOADING step before the countdown (server 'load' -> every driver answers 'loaded'; the race starts when all have), an intro before the countdown, richer news and results (awards, loot box). Clients must say hello with pv >= 8.
export const PROTOCOL = 8;                                          // 7 = 1v1 duels (dqueue / dask / dend ...; see duel.mjs) and races pay no coins; 6 = private rooms can switch crashes and traffic on/off (lobby / countdown / start carry crash + traffic, 'opts' message, 'c' crash news); 5 = up to ten racers, three race modes, bot practice, brake reverses
export const REACTIONS = ['laugh', 'smile', 'cool', 'thumbs', 'cry'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const r1 = (n) => Math.round(n * 10) / 10;

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const BOT_NAMES = ['Sipho', 'Thandi', 'Lerato', 'Kagiso', 'Naledi', 'Themba', 'Zinhle', 'Pieter', 'Aisha', 'Bongani', 'Refilwe', 'Johan', 'Ayanda', 'Tumi'];
const BOT_CARS = { polo: 'City Hatch', hilux: 'Bakkie 4x4', quantum: 'Minibus Taxi', golf: 'Hot Hatch', bmw: 'Executive Sedan', audi: 'Sport Coupe', fortuner: 'Safari SUV', tesla: 'Electric Sedan', rally: 'Rally Hatch', super: 'Supercar' };
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));
// the race news the browsers get (short arrays): z zap, c crash, g got a power-up, u used one, d drift boost, j jump, l landing, t takedown, L lap done, w new leader, f slipstream
const fxOf = (x) => (x.k === 'zap' ? ['z', x.seat, x.to, x.blocked] : x.k === 'crash' ? ['c', x.a, x.b, x.f] : x.k === 'get' ? ['g', x.seat, x.it] : x.k === 'use' ? ['u', x.seat, x.it] : x.k === 'drift' ? ['d', x.seat, x.big]
  : x.k === 'jump' ? ['j', x.seat] : x.k === 'land' ? ['l', x.seat, x.ok, x.ms] : x.k === 'take' ? ['t', x.a, x.b] : x.k === 'lap' ? ['L', x.seat, x.n, x.ms, x.best, x.clean] : x.k === 'lead' ? ['w', x.seat] : x.k === 'draft' ? ['f', x.seat] : ['?']);
const flagsOf = (c) => (c.df ? 1 : 0) | (c.ai > 0 ? 2 : 0) | (c.so ? 4 : 0) | (c.mt > 0 ? 8 : 0) | (c.gh > 0 ? 16 : 0) | (c.dd >= Sim.DRAFT_MIN ? 32 : 0) | (c.bo ? 64 : 0);
// the little prizes after a race: one racer each for the fastest lap, the longest drifting, the most air time, the most takedowns and the cleanest driving
function awardsOf(rows) {
  const list = [], best = (k, val, min, cmp = (a, b) => a > b) => { let w = null; for (const r of rows) { const v = val(r); if (v === null || v === undefined || v < min) continue; if (!w || cmp(v, w.v)) w = { k, seat: r.seat, v }; } if (w) list.push(w); };
  best('fast', (r) => r.best_lap_ms, 1, (a, b) => a < b); best('drift', (r) => r.st.drift, 2); best('air', (r) => r.st.air, 1); best('ram', (r) => r.st.takedowns, 1); best('clean', (r) => (r.st.clean > 0 ? r.st.clean * 100 - r.collisions : null), 1);
  return list;
}
// a bot: a random car model, with the speed of the human's own car dialled down a little (the better bots are close to it), so a practice race is fair for any car
function mkBot(i, n, name, carKey, human) {
  const skill = n > 1 ? 0.97 - i * (0.17 / (n - 1)) : 0.9, f = 0.9 + (skill - 0.8) * 0.5, m = human.car.meta || {};
  const meta = { sp: clampN((+m.sp || 1) * f, 0.8, 1.7), hd: clampN((+m.hd || 1) * (0.94 + (skill - 0.8) * 0.3), 0.7, 1.8), br: +m.br || 0, nb: +m.nb || 1 };
  return { userId: 'bot' + i, name: name + ' 🤖', level: human.level, premium: false, car: { id: 'car_' + carKey, name: BOT_CARS[carKey], meta }, deco: {}, ready: true, connected: true, conn: null, left: false, seat: 0, q: [], nextIn: 0, ack: -1,
    lastIn: Sim.clampInput({}), dcAt: 0, lastQ: Sim.clampInput({}), bot: Sim.newBot(skill, randomInt(1, 2147483647)) };
}

export function createGame(userCfg, supa, log = () => {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const sessions = new Map(), userRoom = new Map(), rooms = new Map(), codes = new Map();
  const timers = new Set();
  const openPublic = new Map();                                       // race mode -> the public room of that mode that is still filling up
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const stats = { started: 0, finished: 0, commitFailures: 0, reactions: 0, practice: 0 };

  const out = (conn, obj) => conn && !conn.closed && conn.send(JSON.stringify(obj));
  const duels = createDuels(cfg.duel || {}, supa, log, { later, out, inRace: (id) => userRoom.has(id) });

  class Room {
    constructor(mode, variant, rules) {
      this.id = randomUUID(); this.mode = mode; this.variant = VARIANTS.includes(variant) ? variant : 'normal'; this.setRules(rules); this.status = 'lobby'; this.players = []; this.code = null; this.host = null;
      this.createdAt = Date.now(); this.minSince = 0; this.startTimer = null; this.startAt = 0; this.world = null; this.loop = null; this.loadStart = 0; this.loadMinTimer = null; this.loadMaxTimer = null;
      this.firstFinishAt = 0; this.committed = false; this.practice = false; this.offer = false; this.soloOn = false; this.humanDoneAt = 0;
    }
    // house rules: only a private room (its host) can change them. Quick matches always have crashes + traffic + 3 laps on a random track and skin (picked when the race loads).
    // A private room: track, skin ('auto' = a random one of that track's skins every race), laps 1-10 (default = the track's own), crashes, traffic.
    setRules(r) {
      r = r || {}; const priv = this.mode === 'private';
      this.crash = priv ? !(r.crash === 0 || r.crash === false) : true;
      this.traffic = priv ? !(r.traffic === 0 || r.traffic === false) : true;
      if (!priv) { this.track = null; this.skin = null; this.laps = cfg.laps; return; }
      const tid = Sim.TRACK_IDS.includes(r.track) ? r.track : (this.track || 'classic'), info = Sim.trackInfo(tid);
      this.track = tid;
      this.skin = typeof r.skin === 'string' && info.skins.includes(r.skin) ? r.skin : 'auto';
      const n = Math.round(+r.laps);
      this.laps = Number.isFinite(n) && r.laps !== undefined && r.laps !== null ? Math.max(1, Math.min(10, n)) : info.laps;
    }
    get connected() { return this.players.filter((p) => p.connected && !p.left); }
    get humans() { return this.players.filter((p) => !p.bot); }
    broadcast(obj) { const s = JSON.stringify(obj); for (const p of this.players) if (p.connected && p.conn && !p.left) p.conn.send(s); }
    lobbyMsg() {
      return { t: 'lobby', room: { id: this.id, code: this.code, mode: this.mode, variant: this.variant, crash: this.crash ? 1 : 0, traffic: this.traffic ? 1 : 0, practice: this.practice, offer: this.offer, status: this.status, min: cfg.minPlayers, max: cfg.maxPlayers, laps: this.laps, track: this.track, skin: this.skin,
        startsIn: this.startAt ? Math.max(0, this.startAt - Date.now()) : null, host: this.host,
        players: this.players.filter((p) => !p.left).map((p) => ({ id: p.userId, name: p.name, level: p.level, car: p.car.id, carName: p.car.name, ready: p.ready, connected: p.connected, seat: p.seat, bot: p.bot ? 1 : 0, deco: p.deco || {} })) } };
    }
    sendLobby() { this.broadcast(this.lobbyMsg()); }
    add(p) { p.seat = this.players.length; this.players.push(p); if (!this.host) this.host = p.userId; if (this.connected.length >= cfg.minPlayers && !this.minSince) this.minSince = Date.now(); this.armSolo(); }
    armSolo() {                                    // nobody joined for a while: offer a practice race against bots, and after a long time tell the player instead of waiting forever
      const alone = this.mode === 'public' && this.status === 'lobby' && !this.practice && this.connected.length < cfg.minPlayers;
      if (!alone) { clearTimeout(this.soloTimer); clearTimeout(this.offerTimer); this.soloOn = false; if (this.offer) { this.offer = false; } return; }
      if (this.soloOn) return;                     // already counting
      this.soloOn = true;
      this.offerTimer = later(cfg.botOfferMs, () => {
        if (this.status !== 'lobby' || this.practice || this.connected.length >= cfg.minPlayers) return;
        this.offer = true; this.sendLobby();
      });
      this.soloTimer = later(cfg.soloWaitMs, () => {
        if (this.status !== 'lobby' || this.practice || this.connected.length >= cfg.minPlayers) return;
        this.broadcast({ t: 'err', code: 'no_opponents' }); this.destroy();
      });
    }
    /* a practice race: the player is alone in the queue, so the room is closed to others and filled with bots (no coins or XP are paid for it) */
    goPractice() {
      if (this.status !== 'lobby' || this.mode !== 'public' || this.practice || this.connected.length >= cfg.minPlayers || this.players.length !== 1) return false;
      const human = this.players[0];
      this.practice = true; this.offer = false; this.soloOn = false;
      clearTimeout(this.soloTimer); clearTimeout(this.offerTimer); clearTimeout(this.startTimer);
      if (openPublic.get(this.variant) === this) openPublic.delete(this.variant);
      const n = Math.max(1, Math.min(cfg.maxPlayers - 1, cfg.botCount | 0)), names = shuffle(BOT_NAMES.slice()), cars = shuffle(Object.keys(BOT_CARS));
      const bots = [];
      for (let i = 0; i < n; i++) bots.push(mkBot(i, n, names[i % names.length], cars[i % cars.length], human));
      const at = Math.min(2, bots.length);                                                // the human starts a couple of rows back, so there is somebody to overtake
      this.players = [...bots.slice(0, at), human, ...bots.slice(at)];
      this.players.forEach((p, i) => (p.seat = i));
      human.ready = true;
      this.startAt = Date.now() + 2500; this.startTimer = later(2500, () => this.startLoad());
      this.sendLobby(); stats.practice++; return true;
    }
    evaluate() {                                   // decides if/when the countdown begins
      if (this.status !== 'lobby') return;
      if (this.practice) { this.sendLobby(); return; }
      clearTimeout(this.startTimer); this.startTimer = null; this.startAt = 0;
      const live = this.connected, n = live.length, allReady = n >= cfg.minPlayers && live.every((p) => p.ready);
      if (n < cfg.minPlayers) { this.minSince = 0; this.armSolo(); this.sendLobby(); return; }
      this.armSolo();
      if (!this.minSince) this.minSince = Date.now();
      let at = Infinity;
      if (this.mode === 'public') {
        at = n >= cfg.maxPlayers ? Date.now() + cfg.fullStartDelayMs : this.minSince + cfg.minStartWaitMs;
        if (allReady) at = Math.min(at, Date.now() + cfg.readyStartDelayMs);
      } else if (allReady) at = Date.now() + cfg.readyStartDelayMs;
      if (at !== Infinity) { this.startAt = at; this.startTimer = later(Math.max(0, at - Date.now()), () => this.startLoad()); }
      this.sendLobby();
    }
    // step 1: everybody is told to LOAD (a splash with their car and tips). The server picks the track, skin and traffic seed now, so every racer builds the very same scene.
    startLoad() {
      if (this.status !== 'lobby') return;
      if (this.connected.length < cfg.minPlayers) return this.evaluate();
      this.status = 'loading'; this.startAt = 0; this.offer = false;
      if (this.mode !== 'private') { this.track = Sim.TRACK_IDS.includes(cfg.forceTrack) ? cfg.forceTrack : Sim.TRACK_IDS[randomInt(Sim.TRACK_IDS.length)]; this.skin = null; this.laps = cfg.laps; }
      const info = Sim.trackInfo(this.track);
      this.runSkin = this.skin && this.skin !== 'auto' && info.skins.includes(this.skin) ? this.skin : info.skins[randomInt(info.skins.length)];
      this.seed = cfg.traffic ? randomInt(1, 2147483647) : 0;                          // one traffic pattern per race, the same for every driver
      for (const p of this.players) p.loaded = !!p.bot;
      this.loadStart = Date.now();
      this.sendLobby(); this.broadcast(this.loadMsg());
      clearTimeout(this.loadMinTimer); clearTimeout(this.loadMaxTimer);
      this.loadMinTimer = later(cfg.loadMinMs, () => this.loadCheck());
      this.loadMaxTimer = later(cfg.loadMaxMs, () => this.loadTimeout());
    }
    loadMsg() {
      return { t: 'load', room: this.id, track: this.track, skin: this.runSkin, laps: this.laps, seed: this.seed || 0, variant: this.variant, crash: this.crash ? 1 : 0, traffic: this.traffic ? 1 : 0, practice: this.practice ? 1 : 0, minMs: cfg.loadMinMs, maxMs: cfg.loadMaxMs,
        seats: this.players.map((p) => ({ seat: p.seat, id: p.userId, name: p.name, car: p.car.id, carName: p.car.name, deco: p.deco || {}, bot: p.bot ? 1 : 0 })) };
    }
    loadStatus() { const hum = this.connected.filter((p) => !p.bot); this.broadcast({ t: 'loadst', n: hum.filter((p) => p.loaded).length, of: hum.length }); }
    onLoaded(p) { if (this.status !== 'loading' || p.loaded) return; p.loaded = true; this.loadStatus(); this.loadCheck(); }
    // step 2: the race starts when every connected human has loaded AND the splash has been up long enough to read the tips
    loadCheck() {
      if (this.status !== 'loading') return;
      if (this.connected.length < cfg.minPlayers) return;
      if (Date.now() - this.loadStart < cfg.loadMinMs) return;
      if (this.connected.some((p) => !p.bot && !p.loaded)) return;
      this.beginCountdown();
    }
    loadTimeout() {                                                                       // somebody never finished loading: they miss this race, everybody else goes
      if (this.status !== 'loading') return;
      for (const p of this.players.slice()) if (!p.bot && p.connected && !p.loaded) { out(p.conn, { t: 'err', code: 'load_timeout' }); this.removePlayer(p.userId); }
      if (this.status === 'loading') { if (this.connected.length >= cfg.minPlayers) this.beginCountdown(); else this.backToLobby(); }
    }
    backToLobby() { clearTimeout(this.loadMinTimer); clearTimeout(this.loadMaxTimer); clearTimeout(this.startTimer); this.status = 'lobby'; this.players.forEach((p) => { p.ready = !!p.bot; p.loaded = false; }); this.evaluate(); }
    beginCountdown() {
      if (this.status !== 'loading') return;
      clearTimeout(this.loadMinTimer); clearTimeout(this.loadMaxTimer);
      this.status = 'countdown'; this.countAt = Date.now(); this.sendLobby();
      this.broadcast(this.countdownMsg());
      this.startTimer = later(cfg.introMs + cfg.countdownMs, () => this.go());
    }
    countdownMsg() { const left = Math.max(0, cfg.introMs + cfg.countdownMs - (Date.now() - (this.countAt || Date.now()))); return { t: 'countdown', ms: left, intro: Math.min(cfg.introMs, left > cfg.countdownMs ? left - cfg.countdownMs : 0), seed: this.seed || 0, variant: this.variant, crash: this.crash ? 1 : 0, traffic: this.traffic ? 1 : 0, track: this.track, skin: this.runSkin, laps: this.laps }; }
    go() {
      if (this.status !== 'countdown') return;
      if (this.connected.length < cfg.minPlayers) { this.status = 'lobby'; this.players.forEach((p) => { p.ready = !!p.bot; p.loaded = false; }); return this.evaluate(); }
      for (const p of this.players) if (!p.connected) p.left = true;                      // someone vanished during the countdown
      this.players = this.players.filter((p) => !p.left); this.players.forEach((p, i) => (p.seat = i));
      this.status = 'racing'; stats.started++;
      if (this.seed == null) this.seed = cfg.traffic ? randomInt(1, 2147483647) : 0;
      this.world = Sim.newRace(this.players.map((p) => ({ id: p.userId, meta: p.car.meta })), this.laps, this.seed, { power: this.variant === 'power', crash: this.crash, traffic: this.traffic, track: this.track });
      this.startedAt = Date.now();
      for (const p of this.players) { p.q = []; p.nextIn = 0; p.ack = -1; p.lastIn = Sim.clampInput({}); p.qn = 0; p.qa = null; p.qs = new Set(); }
      this.broadcast(this.startMsg()); this.broadcast({ t: 'go' });
      this.t0 = performance.now(); this.n = 0; this.loop = setTimeout(() => this.tickLoop(), 0);
      log('race_start', { room: this.id, mode: this.mode, variant: this.variant, practice: this.practice, players: this.players.length });
    }
    startMsg() {
      return { t: 'start', room: this.id, laps: this.laps, track: this.track, skin: this.runSkin, hz: Sim.HZ, seed: this.seed || 0, variant: this.variant, crash: this.crash ? 1 : 0, traffic: this.traffic ? 1 : 0, practice: this.practice ? 1 : 0,
        seats: this.players.map((p) => ({ seat: p.seat, id: p.userId, name: p.name, level: p.level, car: p.car.id, carName: p.car.name, stats: p.car.meta, deco: p.deco, bot: p.bot ? 1 : 0 })) };
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
        if (p.bot) inp = Sim.botInput(w, w.cars[p.seat], p.bot);
        else if (p.left || (!p.connected && now - p.dcAt > 1000)) inp = Sim.clampInput({});                       // abandoned: coast
        else if (p.q.length) { const e = p.q.shift(); p.ack = e.idx; p.lastIn = e.inp; inp = e.inp; }
        else inp = p.lastIn;                                                                                // starved: repeat last input
        inputs[p.userId] = inp;
      }
      Sim.stepWorld(w, inputs);
      if (this.variant === 'quiz') this.quizTick(now);
      if (w.ev.length) {                                                                                    // power-up news: who picked what up, who zapped whom
        this.broadcast({ t: 'fx', e: w.ev.map(fxOf) }); w.ev.length = 0;
      }
      {
        // every car: [seat, x, y, heading, speed, gates, nitro, finished, hits, item, turbo, shield, zapped, slip angle, flags, air ticks left, air ticks total]  (flags: 1 drifting, 2 airborne, 4 spinning out, 8 drift/landing boost, 16 recovering, 32 slipstream, 64 nitro on)
        const cars = JSON.stringify(w.cars.map((c, i) => [i, r1(c.x), r1(c.y), Math.round(c.h * 1000) / 1000, r1(c.v), c.P, Math.round(c.nit), c.fin ? 1 : 0, c.hits, c.it, c.tb, c.sh, c.sl, Math.round(c.sa * 100) / 100, flagsOf(c), c.ai, c.at]));
        for (const p of this.players) if (!p.bot && p.connected && p.conn && !p.left) { const c = w.cars[p.seat]; p.conn.send('{"t":"s","k":' + w.tick + ',"a":' + p.ack + ',"g":' + (c.got | 0) + ',"o":[' + [c.df, c.dc, c.mt, c.ai, c.at, c.rc, c.gh, c.so, c.dd].join(',') + '],"c":' + cars + '}'); }
      }
      const finished = w.cars.filter((c) => c.fin).length;
      if (finished && !this.firstFinishAt) this.firstFinishAt = now;
      const hum = this.humans, stillRacing = hum.filter((p) => !w.cars[p.seat].fin);
      const nobodyHere = stillRacing.every((p) => p.left || (!p.connected && now - p.dcAt > cfg.graceMs));
      if (this.practice && !stillRacing.length && !this.humanDoneAt) this.humanDoneAt = now;               // practice: the race closes a few seconds after the human has finished
      if (finished === w.cars.length || nobodyHere || (this.practice ? (this.humanDoneAt && now - this.humanDoneAt > cfg.practiceEndMs) : (this.firstFinishAt && now - this.firstFinishAt > cfg.finishTimeoutMs)) || w.tick > Sim.HZ * 60 * 10) this.finish();
    }
    /* ---- quiz race: passing a gate pops up a road-sign question; the right answer is a short turbo, a wrong one a short slow-down ---- */
    quizTick(now) {
      const w = this.world, K = w.tr.K, gates = cfg.quizGates, total = this.laps * gates.length;
      for (const p of this.players) {
        const c = w.cars[p.seat];
        if (p.qa) {
          if (p.bot) { if (w.tick >= p.qa.botAt) this.quizAnswer(p, p.qa.botOk ? QUIZ[p.qa.q] : (QUIZ[p.qa.q] + 1 + p.bot.rnd() * 2 | 0) % 3); }
          else if (now - p.qa.at > cfg.quizAnswerMs) { out(p.conn, { t: 'qr', g: p.qa.g, ok: 0, late: 1, a: QUIZ[p.qa.q] }); p.qa = null; }
        }
        if (c.fin || c.P < 1 || p.qn >= total) continue;
        const lap = Math.floor(p.qn / gates.length), need = 1 + lap * K + gates[p.qn % gates.length];
        if (c.P < need) continue;
        const g = p.qn++;
        if (p.qa) continue;                                                                                 // still answering the last one: skip this gate
        const ids = Object.keys(QUIZ); let q = ids[randomInt(ids.length)];
        for (let k = 0; k < 8 && p.qs.has(q); k++) q = ids[randomInt(ids.length)];
        p.qs.add(q);
        if (p.bot) p.qa = { g, q, at: now, botAt: w.tick + 40 + ((p.bot.rnd() * 80) | 0), botOk: p.bot.rnd() < 0.4 + 0.5 * p.bot.skill };
        else { p.qa = { g, q, at: now }; out(p.conn, { t: 'qz', g, q, ms: cfg.quizAnswerMs }); }
      }
    }
    quizAnswer(p, a) {
      const qa = p.qa; if (!qa) return;
      p.qa = null;
      const c = this.world.cars[p.seat], right = QUIZ[qa.q], ok = a === right;
      if (ok) { c.tb = Math.max(c.tb, 60); c.nit = Math.min(100, c.nit + 25); }
      else { c.sl = Math.max(c.sl, 45); }
      if (!p.bot) out(p.conn, { t: 'qr', g: qa.g, ok: ok ? 1 : 0, a: right });
    }
    // The winner of a QUICK MATCH with at least one other real person gets a loot box. Private rooms and bot practice never do (nothing to farm). The database refuses more than a few a day.
    async lootFor(rows) {
      const got = new Map();
      if (this.practice || this.mode !== 'public') return got;
      const humans = rows.filter((r) => !r.bot), win = rows[0];
      if (humans.length < 2 || !win || win.bot || win.dnf) return got;
      for (let a = 0; a < 2; a++) {
        try { const r = await supa.rpc('k54_svc_race_loot', { p_room: this.id, p_user: win.user, p_tier: 'winner', p_humans: humans.length, p_cap: cfg.lootDailyCap }); if (r?.ok && r.box) got.set(win.user, { id: r.box.id, tier: r.box.tier }); break; }
        catch (e) { log('loot_error', { room: this.id, err: String(e.message || e) }); await new Promise((res) => setTimeout(res, 300)); }
      }
      return got;
    }
    async finish() {
      if (this.status !== 'racing') return;
      this.status = 'finished'; clearTimeout(this.loop);
      const w = this.world, ranked = Sim.ranking(w);
      const rows = ranked.map((c, i) => { const p = this.players.find((x) => x.userId === c.id); return {
        user: c.id, seat: p.seat, car: p.car.id, position: i + 1, finish_ms: c.fin ? Math.round(c.fin * Sim.DT * 1000) : null, dnf: !c.fin, collisions: c.hits,
        best_lap_ms: c.best ? Math.round(c.best * 1000) : null, forfeit: !c.fin && (p.left || !p.connected), name: p.name, bot: p.bot ? 1 : 0,
        st: { drift: Math.round(c.sD * Sim.DT * 10) / 10, air: Math.round(c.sA * Sim.DT * 10) / 10, jumps: c.sJ, takedowns: c.sT, clean: c.sC } }; });
      const awards = awardsOf(rows);
      let rewards = null;
      if (this.practice) rewards = [];                                                                       // practice races pay nothing and are not saved
      for (let a = 0; a < cfg.commitRetries && !rewards; a++) {
        try {
          const r = await supa.rpc('k54_svc_race_commit', { p_room: this.id, p_meta: { mode: this.mode, code: this.code, track_id: this.track + (this.variant === 'normal' ? '' : '-' + this.variant) + (this.crash ? '' : '-nocrash') + (this.traffic ? '' : '-notraffic'), laps: this.laps, started_at: new Date(this.startedAt).toISOString(), finished_at: new Date().toISOString() },
                                                         p_results: rows.map(({ name, bot, st, ...r }) => r) });
          if (r?.ok) rewards = r.duplicate ? [] : r.rewards; else throw new Error(r?.error || 'commit_failed');
        } catch (e) { stats.commitFailures++; log('commit_error', { room: this.id, err: String(e.message || e) }); await new Promise((res) => setTimeout(res, 400 * (a + 1))); }
      }
      stats.finished++;
      const byUser = new Map((rewards || []).map((x) => [x.user, x]));
      const loot = await this.lootFor(rows);                                                                 // the winner of a quick match with other people in it gets a loot box (see lootFor)
      const msg = { t: 'results', room: this.id, rewards_pending: rewards === null, practice: this.practice ? 1 : 0, variant: this.variant, track: this.track, skin: this.runSkin, laps: this.laps, awards,
        rows: rows.map((r) => ({ id: r.user, seat: r.seat, name: r.name, bot: r.bot, pos: r.position, ms: r.finish_ms, dnf: r.dnf, best: r.best_lap_ms, hits: r.collisions, coins: byUser.get(r.user)?.coins ?? 0, xp: byUser.get(r.user)?.xp ?? 0, st: r.st, loot: loot.get(r.user) || null })) };
      this.broadcast(msg); this.resultMsg = msg;
      for (const p of this.players) { if (userRoom.get(p.userId) === this) userRoom.delete(p.userId); }
      log('race_end', { room: this.id, practice: this.practice, rewards: rewards === null ? 'pending' : 'ok' });
      later(cfg.resultsKeepMs, () => this.destroy());
    }
    removePlayer(userId, why) {
      const p = this.players.find((x) => x.userId === userId); if (!p) return;
      if (userRoom.get(userId) === this) userRoom.delete(userId);
      if (this.status === 'racing' || this.status === 'finished') { p.left = true; p.ready = false; return; }
      this.players = this.players.filter((x) => x !== p); this.players.forEach((x, i) => (x.seat = i));
      if (this.host === userId) this.host = this.humans[0]?.userId || null;
      if (!this.humans.length) return this.destroy();                                   // (a practice room dies with its human)
      if (this.status === 'countdown' || this.status === 'loading') {                  // somebody left while the race was loading / counting down
        if (this.connected.length < cfg.minPlayers) { this.players.forEach((x) => { if (!x.bot) x.ready = false; }); return this.backToLobby(); }
        if (this.status === 'loading') this.loadCheck();
        return this.sendLobby();
      }
      this.evaluate();
    }
    destroy() {
      clearTimeout(this.startTimer); clearTimeout(this.loop); clearTimeout(this.soloTimer); clearTimeout(this.offerTimer); clearTimeout(this.loadMinTimer); clearTimeout(this.loadMaxTimer); rooms.delete(this.id); if (this.code) codes.delete(this.code);
      if (openPublic.get(this.variant) === this) openPublic.delete(this.variant);
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
    ready: false, connected: true, conn: s.conn, left: false, seat: 0, q: [], nextIn: 0, ack: -1, lastIn: Sim.clampInput({}), dcAt: 0, lastQ: Sim.clampInput({}), bot: null });

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
    if (m.t === 'qa') return onQuizAnswer(s, m);
    if (m.t === 'hello') return onHello(s, m);
    if (!s.authed) return;
    if (m.t === 'loaded') { const r = s.room, p = s.player; if (r && p) r.onLoaded(p); return; }
    if (DUEL_MSGS.has(m.t)) return duels.handle(s, m).catch((e) => { log('duel_error', { t: m.t, err: String(e.message || e) }); s.dbusy = false; s.err('server_error'); });
    if (s.busy) return s.err('busy');                                   // one lobby action at a time per connection
    s.busy = true;
    try { await lobbyAction(s, m); } catch (e) { log('action_error', { t: m.t, err: String(e.message || e) }); s.err('server_error'); } finally { s.busy = false; }
  }

  async function onHello(s, m) {
    if (s.authed || s.helloing) return;
    if (!(+m.pv >= PROTOCOL)) { s.err('old_client', { need: PROTOCOL }); return s.conn.close(4004, 'old_client'); }      // a client from before the loading step cannot take part (it would wait for a countdown that never comes)
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
        else {
          s.send(room.lobbyMsg());
          if (room.status === 'loading' || room.status === 'countdown') { p.loaded = false; s.send(room.loadMsg()); if (room.status === 'countdown') s.send(room.countdownMsg()); }
        }
        if (room.status === 'lobby') room.evaluate();
      }
    }
    duels.resume(s);                                                      // an interrupted duel (or a place in the duel queue) continues too
  }

  async function lobbyAction(s, m) {
    const room = s.room, p = s.player;
    switch (m.t) {
      case 'queue': {
        if (room || duels.busy(s.user.id)) return s.err('already_in_room');
        if (rooms.size >= cfg.maxRooms) return s.err('server_busy');
        const e = await enter(s, m.car); if (!e) return;
        if (s.room) return s.err('already_in_room');
        const variant = pickVariant(m.mode);                                // quick match: everybody who chose the same race mode meets in the same rooms
        let r = openPublic.get(variant); if (!(r && r.status === 'lobby' && !r.practice && r.players.length < cfg.maxPlayers)) r = null;
        if (!r) { r = new Room('public', variant); rooms.set(r.id, r); openPublic.set(variant, r); }
        const pl = mkPlayer(s, e); r.add(pl); userRoom.set(s.user.id, r);
        if (r.players.length >= cfg.maxPlayers) openPublic.delete(variant);
        r.evaluate(); return;
      }
      case 'create': {
        if (room || duels.busy(s.user.id)) return s.err('already_in_room');
        if (rooms.size >= cfg.maxRooms) return s.err('server_busy');
        const e = await enter(s, m.car); if (!e) return;
        const code = newCode(); if (!code) return s.err('server_busy');
        const r = new Room('private', pickVariant(m.mode), { crash: m.crash, traffic: m.traffic, track: m.track, skin: m.skin, laps: m.laps }); r.code = code; codes.set(code, r); rooms.set(r.id, r);
        r.add(mkPlayer(s, e)); userRoom.set(s.user.id, r); r.evaluate(); return;
      }
      case 'join': {
        if (room || duels.busy(s.user.id)) return s.err('already_in_room');
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
      case 'opts': {                                                          // the host of a private room changes the house rules (crashes, traffic) while everybody is still in the lobby
        if (!room || !p || room.mode !== 'private' || room.status !== 'lobby' || room.host !== s.user.id) return s.err('not_in_lobby');
        const newTrack = m.track !== undefined && m.track !== room.track;                 // a new track brings its own skins and its own lap count unless the host says otherwise
        room.setRules({ crash: m.crash === undefined ? room.crash : m.crash, traffic: m.traffic === undefined ? room.traffic : m.traffic, track: m.track === undefined ? room.track : m.track,
          skin: m.skin !== undefined ? m.skin : (newTrack ? 'auto' : room.skin), laps: m.laps !== undefined ? m.laps : (newTrack ? undefined : room.laps) });
        for (const q of room.players) if (!q.bot) q.ready = false;            // new rules: everybody confirms again
        room.sendLobby(); room.evaluate(); return;
      }
      case 'bots': {                                                          // "no opponents yet - practice against bots?" -> yes
        if (!room || !p) return s.err('not_in_lobby');
        if (!room.goPractice()) return s.err('bots_unavailable');
        return;
      }
      case 'leave': {
        if (!room) return;
        room.removePlayer(s.user.id); s.send({ t: 'left' }); return;
      }
      default: return;
    }
  }

  const pickVariant = (v) => (VARIANTS.includes(v) ? v : 'normal');
  // an answer to a road-sign question of the quiz race
  function onQuizAnswer(s, m) {
    const room = s.room, p = s.player;
    if (!room || !p || room.status !== 'racing' || room.variant !== 'quiz' || !p.qa || p.left) return;
    if (m.g !== p.qa.g || !Number.isInteger(m.a) || m.a < 0 || m.a > 2) return;
    if (Date.now() - p.qa.at > cfg.quizAnswerMs + 800) return;           // a little slack for the network
    room.quizAnswer(p, m.a);
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
      duels.onClose(s);
      const room = userRoom.get(s.user.id); const p = room?.players.find((x) => x.userId === s.user.id);
      if (!room || !p) return;
      p.connected = false; p.dcAt = Date.now();
      if (room.status === 'lobby' || room.status === 'countdown' || room.status === 'loading') {
        p.dcTimer = later(cfg.lobbyGraceMs, () => { if (!p.connected) room.removePlayer(p.userId); });
        if (room.status === 'loading') room.loadCheck(); else room.evaluate();
      }
    };
  }

  return {
    onConnection, cfg, stats, duels, debug: { rooms },
    snapshot() { let lobby = 0, racing = 0; for (const r of rooms.values()) { if (r.status === 'racing') racing++; else if (r.status === 'lobby' || r.status === 'countdown') lobby++; } return { sessions: sessions.size, rooms: rooms.size, lobby, racing, ...stats, ...duels.snapshot() }; },
    stop() { duels.stop(); for (const t of timers) clearTimeout(t); for (const r of rooms.values()) { clearTimeout(r.startTimer); clearTimeout(r.loop); clearTimeout(r.soloTimer); clearTimeout(r.offerTimer); } },
  };
}
