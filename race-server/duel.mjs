// K54 Game - 1v1 duels (the main online mode): two players get the same 10 questions, 15 seconds each; a right answer scores 100 + up to 100 for speed.
// The server owns everything that counts: which questions are asked, the order of the answer options, the clock, the scoring, the result, and the call that pays coins / XP / rating.
// The app only shows the question (from its own bank, by id) and sends back "I tapped option k". Transport-agnostic, same session objects as game.mjs.
//
//   client -> server   dqueue {}  | dcancel {}  | dbot {} (practice against a bot, unrated, no coins)  | dseen {i} (the question is on screen - used to estimate the network delay)
//                      dans {i,k} (answer question i by tapping option k as displayed)  | dleave {} (give up = forfeit)
//   server -> client   dl {st:'queue'|'offer'|'idle', waited, size}          queue status (offer = nobody found for a while, practice available)
//                      dm {m, n, ms, startIn, practice, you:{..}, opp:{..}}   match found (countdown to the first question)
//                      dask {m, i, id, perm, ms}                             question i: show question `id`, displayed option k = original option perm[k]
//                      dres {i, ok, pts, right}                              your own result for question i, straight after you answered (right = displayed index of the right answer)
//                      dopp {i}                                              your opponent has answered question i (not whether it was right)
//                      dreveal {i, you:{..}, opp:{..}, total:{you,opp}}      both results of question i, when it closes
//                      dconn {on}                                            your opponent lost / regained the connection
//                      dend {m, you:{..}, opp:{..}, result, status, practice, rated, rewards_pending}   the final result with what was paid
//                      dresume {..}                                          after a reconnect: everything needed to redraw the current question
import { createRequire } from 'node:module';
import { randomUUID, randomInt } from 'node:crypto';
const req = createRequire(import.meta.url);
const BANK = req('../shared/duel-bank.json');                        // { id: [index of the right answer, number of options, category] }

export const DUEL_DEFAULTS = {
  questions: 10, answerMs: 15000, minAnswerMs: 5000, maxAnswerMs: 30000, revealMs: 2400, startMs: 3200, graceMs: 15000, botOfferMs: 25000, waitMaxMs: 180000, tickMs: 1000,
  minEffMs: 350,              // a human cannot read and answer faster than this: faster answers count as this (stops scripts from always getting the full speed bonus)
  slackMs: 400,               // an answer that arrives this much after the timer is still accepted (network delay); the points use the corrected time
  defaultLatMs: 60, maxLatMs: 250, maxMatches: 400, maxQueue: 2000, rematchBlockMs: 120000, lastEndKeepMs: 15 * 60 * 1000,   // a result is kept this long for a player who was offline when the duel ended
  mix: { rules: 4, signs: 4, controls: 2 },                           // how many of every 10 questions come from each category
};
export const DUEL_MSGS = new Set(['dqueue', 'dcancel', 'dbot', 'dseen', 'dans', 'dleave']);
const BOT_NAMES = ['Sipho', 'Thandi', 'Lerato', 'Kagiso', 'Naledi', 'Themba', 'Zinhle', 'Pieter', 'Aisha', 'Bongani', 'Refilwe', 'Johan', 'Ayanda', 'Tumi'];
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const IDS_BY_CAT = (() => { const m = {}; for (const [id, v] of Object.entries(BANK)) (m[v[2]] ||= []).push(id); return m; })();

/* n questions, mixed by category (rules / signs / controls as 4:4:2), never the same one twice, and - while there are enough - none that either player had recently */
export function pickQuestions(n, avoid = new Set(), mix = DUEL_DEFAULTS.mix) {
  const cats = Object.keys(mix).filter((c) => IDS_BY_CAT[c]?.length), tot = cats.reduce((a, c) => a + mix[c], 0) || 1;
  const want = {}; let given = 0;
  for (const c of cats) { want[c] = Math.floor((n * mix[c]) / tot); given += want[c]; }
  for (let i = 0; given < n; i++, given++) want[cats[i % cats.length]]++;
  const out = [];
  for (const c of cats) {
    const pool = shuffle(IDS_BY_CAT[c].slice()), fresh = pool.filter((id) => !avoid.has(id)), rest = pool.filter((id) => avoid.has(id));
    out.push(...[...fresh, ...rest].slice(0, want[c]));
  }
  return shuffle(out).slice(0, n);
}
/* points for one answer: nothing for a wrong one; 100 for a right one, plus up to 100 for speed (all of it the instant the question appears, none when the timer runs out) */
export function scoreAnswer(ok, effMs, limitMs) { return ok ? 100 + Math.round(100 * clampN(1 - effMs / limitMs, 0, 1)) : 0; }
/* the Elo-style window of ratings that may be paired, wider the longer somebody has waited */
export const ratingWindow = (waitedMs) => 150 + 40 * Math.floor(waitedMs / 1000);

export function createDuels(userCfg, supa, log = () => {}, ctx = {}) {
  const cfg = { ...DUEL_DEFAULTS, ...userCfg };
  const later = ctx.later || ((ms, fn) => setTimeout(fn, ms));
  const out = ctx.out || ((conn, o) => conn && !conn.closed && conn.send(JSON.stringify(o)));
  const queue = new Map();                                            // userId -> { s, e, since, offered }
  const matches = new Map(), userMatch = new Map();
  const recentOpp = new Map(), recentQ = new Map();                   // userId -> Map(opp -> ts) / array of recent question ids
  const lastEnd = new Map();                                          // userId -> { at, msg, sent }: the last result, kept for a while for a player who was away when the duel ended
  const timers = new Set();
  const tm = (ms, fn) => { const t = later(ms, () => { timers.delete(t); fn(); }); timers.add(t); return t; };
  const stats = { matches: 0, finished: 0, forfeits: 0, practice: 0, voided: 0, commitFailures: 0, queued: 0 };
  let tick = null;

  const sendTo = (p, o) => { if (!p.bot && p.connected && p.conn) out(p.conn, o); };
  const pub = (p) => ({ id: p.bot ? 'bot' : p.userId, name: p.name, level: p.level, rating: p.rating, bot: p.bot ? 1 : 0 });

  class Match {
    constructor(a, b, qn, ms, practice) {
      this.id = randomUUID(); this.practice = !!practice; this.n = qn; this.ms = ms; this.players = [a, b]; this.status = 'starting'; this.i = -1; this.qAt = 0; this.timer = null; this.done = false;
      const avoid = new Set([...(recentQ.get(a.userId) || []), ...(b.bot ? [] : recentQ.get(b.userId) || [])]);
      this.qs = pickQuestions(qn, avoid, cfg.mix); this.startedAt = Date.now();
      for (const p of this.players) { Object.assign(p, { seat: this.players.indexOf(p), score: 0, correct: 0, answered: 0, effSum: 0, res: [], perm: [], cur: null, sentAt: 0, minRtt: Infinity, connected: !p.bot, dcAt: 0, dcTimer: null, forfeit: false }); }
    }
    opp(p) { return this.players[1 - p.seat]; }
    right(i) { return BANK[this.qs[i]][0]; }
    nopt(i) { return BANK[this.qs[i]][1]; }
    lat(p) { return Number.isFinite(p.minRtt) ? clampN(p.minRtt / 2, 0, cfg.maxLatMs) : cfg.defaultLatMs; }
    start() {
      stats.matches++; if (this.practice) stats.practice++;
      for (const p of this.players) { sendTo(p, { t: 'dm', m: this.id, n: this.n, ms: this.ms, startIn: cfg.startMs, practice: this.practice ? 1 : 0, you: pub(p), opp: pub(this.opp(p)) }); }
      this.timer = tm(cfg.startMs, () => this.ask(0));
      log('duel_start', { match: this.id, practice: this.practice, a: this.players[0].userId, b: this.players[1].userId });
    }
    ask(i) {
      if (this.done) return;
      this.i = i; this.status = 'asking'; this.qAt = Date.now();
      const nopt = this.nopt(i), id = this.qs[i];
      for (const p of this.players) {
        p.cur = null; p.sentAt = this.qAt;
        p.perm[i] = shuffle(Array.from({ length: nopt }, (_, k) => k));
        sendTo(p, { t: 'dask', m: this.id, i, id, perm: p.perm[i], ms: this.ms });
        if (p.bot) this.botPlan(p, i);
      }
      this.timer = tm(this.ms + cfg.slackMs + 100, () => this.close(i));
    }
    botPlan(p, i) {                                                    // a practice opponent: right about 6 times in 10, in 3 to 10 seconds
      const ok = Math.random() < p.skill, t = clampN(3000 + randomInt(7000) - (ok ? 0 : 1000), 1500, this.ms - 1500);
      tm(t, () => { if (this.i === i && this.status === 'asking' && !p.cur) this.record(p, i, null, ok, t); });
    }
    /* a human tapped option k of question i */
    answer(p, i, k) {
      if (this.done || this.status !== 'asking' || i !== this.i || p.cur || !Number.isInteger(k) || k < 0 || k >= this.nopt(i)) return;
      const now = Date.now(), el = now - this.qAt;
      if (el > this.ms + cfg.slackMs) return;                           // too late: it counts as no answer when the question closes
      const orig = p.perm[i][k], ok = orig === this.right(i);
      this.record(p, i, k, ok, el - this.lat(p));
    }
    record(p, i, k, ok, rawMs) {
      const eff = clampN(rawMs, cfg.minEffMs, this.ms), pts = scoreAnswer(ok, eff, this.ms);
      p.cur = { i, ok, pts, ms: Math.round(eff), k }; p.res[i] = p.cur;
      p.answered++; p.effSum += eff; if (ok) p.correct++; p.score += pts;
      if (!p.bot) {
        const disp = p.perm[i].indexOf(this.right(i));
        sendTo(p, { t: 'dres', m: this.id, i, ok: ok ? 1 : 0, pts, right: disp, ms: p.cur.ms });
      }
      sendTo(this.opp(p), { t: 'dopp', m: this.id, i });
      if (this.players.every((x) => x.cur)) { clearTimeout(this.timer); this.timer = tm(250, () => this.close(i)); }
    }
    close(i) {
      if (this.done || i !== this.i || this.status !== 'asking') return;
      this.status = 'reveal'; clearTimeout(this.timer);
      const row = (p) => { const c = p.res[i]; return c ? { ans: 1, ok: c.ok ? 1 : 0, pts: c.pts, ms: c.ms, right: p.perm[i].indexOf(this.right(i)) } : { ans: 0, ok: 0, pts: 0, ms: null, right: p.perm[i].indexOf(this.right(i)) }; };
      for (const p of this.players) sendTo(p, { t: 'dreveal', m: this.id, i, you: row(p), opp: row(this.opp(p)), total: { you: p.score, opp: this.opp(p).score } });
      this.timer = tm(cfg.revealMs, () => (i + 1 < this.n ? this.ask(i + 1) : this.finish()));
    }
    disconnected(p) {
      if (this.done || p.bot) return;
      p.connected = false; p.conn = null; p.dcAt = Date.now();
      sendTo(this.opp(p), { t: 'dconn', m: this.id, on: 0 });
      clearTimeout(p.dcTimer);
      p.dcTimer = tm(cfg.graceMs, () => { if (!p.connected && !this.done) this.forfeitBy(p); });
    }
    reconnected(p, conn) {
      p.connected = true; p.conn = conn; clearTimeout(p.dcTimer);
      sendTo(this.opp(p), { t: 'dconn', m: this.id, on: 1 });
      const i = this.i, asking = this.status === 'asking' && i >= 0;
      const o = this.opp(p);
      sendTo(p, { t: 'dresume', m: this.id, n: this.n, ms: this.ms, practice: this.practice ? 1 : 0, status: this.status, i, you: pub(p), opp: pub(o), total: { you: p.score, opp: o.score },
        q: i >= 0 && (asking || this.status === 'reveal') ? { id: this.qs[i], perm: p.perm[i], left: asking ? Math.max(0, this.ms - (Date.now() - this.qAt)) : 0, done: p.cur ? { ok: p.cur.ok ? 1 : 0, pts: p.cur.pts, right: p.perm[i].indexOf(this.right(i)) } : null, oppDone: o.cur ? 1 : 0 } : null,
        opp_on: o.bot || o.connected ? 1 : 0 });
    }
    forfeitBy(p) {                                                     // gave up, or has been gone for too long
      if (this.done) return;
      p.forfeit = true; stats.forfeits++;
      for (const x of this.players) if (!x.bot && !x.connected) x.forfeit = true;     // anybody else who is gone has forfeited too
      this.finish();
    }
    async finish() {
      if (this.done) return;
      this.done = true; this.status = 'done'; clearTimeout(this.timer);
      for (const p of this.players) { clearTimeout(p.dcTimer); if (userMatch.get(p.userId) === this) userMatch.delete(p.userId); }
      matches.delete(this.id); stats.finished++;
      const [a, b] = this.players, humans = this.players.filter((p) => !p.bot);
      const row = (p) => ({ user: p.userId, seat: p.seat, score: p.score, correct: p.correct, answered: p.answered, avg_ms: p.answered ? Math.round(p.effSum / p.answered) : null, forfeit: !!p.forfeit });
      let r = null;
      if (this.practice) r = { ok: true, practice: true, rewards: [], rated: false, status: 'practice' };
      for (let t = 0; t < 3 && !r; t++) {
        try {
          const c = await supa.rpc('k54_svc_duel_commit', { p_match: this.id, p_meta: { questions: this.qs, started_at: new Date(this.startedAt).toISOString(), finished_at: new Date().toISOString(),
            suspect: humans.filter((p) => p.answered >= 5 && p.correct >= 9 && p.effSum / p.answered < 1200).map((p) => p.userId) }, p_results: [row(a), row(b)] });
          if (c?.ok) r = c; else throw new Error(c?.error || 'commit_failed');
        } catch (e) { stats.commitFailures++; log('duel_commit_error', { match: this.id, err: String(e.message || e) }); await new Promise((res) => setTimeout(res, 400 * (t + 1))); }
      }
      if (r?.status === 'void') stats.voided++;
      const pend = r === null, rew = new Map((r?.rewards || []).map((x) => [x.user, x]));
      for (const p of humans) {
        const o = this.opp(p), mine = rew.get(p.userId);
        const byScore = p.score > o.score ? 'win' : p.score < o.score ? 'loss' : 'draw';
        const result = this.practice ? byScore : r?.status === 'void' ? 'void' : p.forfeit ? 'loss' : o.forfeit ? 'win' : mine?.result || byScore;
        const sum = (q) => ({ score: q.score, correct: q.correct, answered: q.answered, avg_ms: q.answered ? Math.round(q.effSum / q.answered) : null, name: q.name });
        const endMsg = { t: 'dend', m: this.id, practice: this.practice ? 1 : 0, status: r?.status || 'pending', rated: r?.rated ? 1 : 0, rewards_pending: pend ? 1 : 0, result, forfeit: p.forfeit ? 1 : 0, opp_forfeit: o.forfeit ? 1 : 0,
          you: { ...sum(p), coins: mine?.coins ?? 0, xp: mine?.xp ?? 0, rating_before: mine?.rating_before ?? p.rating, rating_after: mine?.rating_after ?? p.rating }, opp: sum(o), n: this.n };
        sendTo(p, endMsg);
        lastEnd.set(p.userId, { at: Date.now(), msg: endMsg, sent: !!(p.connected && p.conn && !p.conn.closed) });
        if (lastEnd.size > 500) for (const [u, v] of lastEnd) if (Date.now() - v.at > cfg.lastEndKeepMs) lastEnd.delete(u);
        const rq = recentQ.get(p.userId) || []; rq.push(...this.qs); recentQ.set(p.userId, rq.slice(-40));
        if (!o.bot) { const m = recentOpp.get(p.userId) || new Map(); m.set(o.userId, Date.now()); recentOpp.set(p.userId, m); }
      }
      log('duel_end', { match: this.id, practice: this.practice, status: r?.status || 'pending', scores: [a.score, b.score] });
    }
  }

  /* ---------------- queue and matchmaking ---------------- */
  const busy = (userId) => queue.has(userId) || userMatch.has(userId);
  const mkPlayer = (s, e) => ({ userId: s.user.id, name: e.name, level: e.level, rating: e.rating, conn: s.conn, bot: false, s });

  function qStatus(uid) {
    const w = queue.get(uid); if (!w) return;
    const waited = Date.now() - w.since;
    out(w.s.conn, { t: 'dl', st: waited >= cfg.botOfferMs ? 'offer' : 'queue', waited, size: queue.size });
  }
  function pairNow() {
    const now = Date.now(), list = [...queue.values()].sort((x, y) => x.since - y.since);
    const used = new Set();
    for (const a of list) {
      if (used.has(a.s.user.id)) continue;
      let best = null, bestD = Infinity;
      for (const b of list) {
        if (b === a || used.has(b.s.user.id)) continue;
        const waited = Math.max(now - a.since, now - b.since), d = Math.abs(a.e.rating - b.e.rating);
        if (d > ratingWindow(waited)) continue;
        const ro = recentOpp.get(a.s.user.id)?.get(b.s.user.id) || 0;
        if (now - ro < cfg.rematchBlockMs && waited < 30000) continue;       // not the same opponent again straight away, unless nobody else turns up
        if (d < bestD) { best = b; bestD = d; }
      }
      if (best) { used.add(a.s.user.id); used.add(best.s.user.id); launch(a, best); }
    }
  }
  function launch(a, b) {
    queue.delete(a.s.user.id); queue.delete(b.s.user.id);
    const qn = clampN(a.e.questions | 0 || cfg.questions, 3, 20), ms = clampN(a.e.answer_ms | 0 || cfg.answerMs, cfg.minAnswerMs, cfg.maxAnswerMs);
    const pa = mkPlayer(a.s, a.e), pb = mkPlayer(b.s, b.e), m = new Match(pa, pb, qn, ms, false);
    matches.set(m.id, m); userMatch.set(pa.userId, m); userMatch.set(pb.userId, m); m.start();
  }
  function ensureTick() {
    if (tick || !queue.size) return;
    tick = tm(cfg.tickMs, () => {
      tick = null;
      pairNow();
      const now = Date.now();
      for (const [uid, w] of queue) {
        if (now - w.since > cfg.waitMaxMs) { out(w.s.conn, { t: 'err', code: 'no_opponents' }); queue.delete(uid); out(w.s.conn, { t: 'dl', st: 'idle', waited: 0, size: queue.size }); continue; }
        if ((now - w.since) % 5000 < cfg.tickMs || (!w.offered && now - w.since >= cfg.botOfferMs)) { if (now - w.since >= cfg.botOfferMs) w.offered = true; qStatus(uid); }
      }
      ensureTick();
    });
  }

  async function handle(s, m) {
    const uid = s.user?.id; if (!uid) return;
    switch (m.t) {
      case 'dqueue': {
        if (s.dbusy) return s.err('busy');
        if (userMatch.has(uid)) return s.err('already_in_room');
        if (ctx.inRace?.(uid)) return s.err('already_in_room');
        if (queue.has(uid)) return qStatus(uid);
        if (queue.size >= cfg.maxQueue || matches.size >= cfg.maxMatches) return s.err('server_busy');
        s.dbusy = true;
        try {
          const e = await supa.rpc('k54_svc_duel_entry', { p_user: uid });
          if (!e?.ok) return s.err(e?.error || 'not_allowed');
          if (userMatch.has(uid) || queue.has(uid) || ctx.inRace?.(uid)) return s.err('already_in_room');
          queue.set(uid, { s, e, since: Date.now(), offered: false }); stats.queued++;
          qStatus(uid); pairNow(); ensureTick();
        } finally { s.dbusy = false; }
        return;
      }
      case 'dcancel': {
        if (queue.delete(uid)) out(s.conn, { t: 'dl', st: 'idle', waited: 0, size: queue.size });
        return;
      }
      case 'dbot': {                                                  // "nobody is online - practise against a bot": unrated, no coins
        const w = queue.get(uid); if (!w) return s.err('not_in_lobby');
        if (Date.now() - w.since < cfg.botOfferMs * 0.9) return s.err('bots_unavailable');
        queue.delete(uid);
        const me = mkPlayer(s, w.e), names = shuffle(BOT_NAMES.slice());
        const skill = clampN(0.5 + (w.e.rating - 1000) / 2000 + Math.random() * 0.15, 0.45, 0.85);
        const bot = { userId: 'bot', name: names[0] + ' 🤖', level: me.level, rating: clampN(w.e.rating + randomInt(-60, 61), 100, 3000), conn: null, bot: true, skill };
        const mt = new Match(me, bot, clampN(w.e.questions | 0 || cfg.questions, 3, 20), clampN(w.e.answer_ms | 0 || cfg.answerMs, cfg.minAnswerMs, cfg.maxAnswerMs), true);
        matches.set(mt.id, mt); userMatch.set(uid, mt); mt.start(); return;
      }
      case 'dseen': {
        const mt = userMatch.get(uid); if (!mt || mt.status !== 'asking' || m.i !== mt.i) return;
        const p = mt.players.find((x) => x.userId === uid); if (!p || p.seenFor === mt.i) return;
        p.seenFor = mt.i; const rtt = Date.now() - p.sentAt; if (rtt >= 0 && rtt < 5000) p.minRtt = Math.min(p.minRtt, rtt);
        return;
      }
      case 'dans': {
        const mt = userMatch.get(uid); if (!mt) return;
        const p = mt.players.find((x) => x.userId === uid); if (!p) return;
        return mt.answer(p, m.i, m.k);
      }
      case 'dleave': {
        if (queue.delete(uid)) { out(s.conn, { t: 'dl', st: 'idle', waited: 0, size: queue.size }); return; }
        const mt = userMatch.get(uid); if (!mt) return;
        const p = mt.players.find((x) => x.userId === uid); if (p) mt.forfeitBy(p);
        return;
      }
      default: return;
    }
  }

  /* a player's connection came back (new tab, network change, app returned from the background) */
  function resume(s) {
    const uid = s.user.id, mt = userMatch.get(uid);
    if (mt && !mt.done) { const p = mt.players.find((x) => x.userId === uid); if (p) { mt.reconnected(p, s.conn); return true; } }
    const w = queue.get(uid); if (w) { w.s = s; qStatus(uid); return true; }
    const le = lastEnd.get(uid);                                      // the duel ended while this player was away: tell them how it went (once)
    if (le && !le.sent && Date.now() - le.at < cfg.lastEndKeepMs) { le.sent = true; out(s.conn, le.msg); return true; }
    return false;
  }
  function onClose(s) {
    const uid = s.user?.id; if (!uid) return;
    const w = queue.get(uid); if (w && w.s === s) { queue.delete(uid); return; }
    const mt = userMatch.get(uid); if (!mt) return;
    const p = mt.players.find((x) => x.userId === uid); if (p && p.conn === s.conn) mt.disconnected(p);
  }

  return {
    handle, resume, onClose, busy, stats, cfg, debug: { matches, queue, userMatch },
    snapshot() { return { duel_queue: queue.size, duel_matches: matches.size, duels: stats.matches, duels_finished: stats.finished, duel_forfeits: stats.forfeits, duel_practice: stats.practice }; },
    stop() { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}
