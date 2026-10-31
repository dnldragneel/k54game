#!/usr/bin/env node
// K54 Game race server entry point. Environment:
//   PORT, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (secret - server only), ALLOWED_ORIGINS (comma list),
//   TRUST_PROXY=1 when behind a load balancer, MAX_CONN_PER_IP, LAPS ...
//   (tests only) FORCE_TRACK=classic pins the quick-match track; INTRO_MS, LOAD_MIN_MS, LOAD_MAX_MS shorten the start-up steps
import http from 'node:http';
import { attachWebSocket } from './ws.mjs';
import { createGame } from './game.mjs';
import { makeSupa } from './supa.mjs';

export function createServer(env = process.env, supaOverride = null) {
  const supa = supaOverride || makeSupa({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });
  const log = (ev, o = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), ev, ...o }));
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const game = createGame({
    laps: num('LAPS', 3), maxPlayers: num('MAX_PLAYERS', 10), countdownMs: num('COUNTDOWN_MS', 5600), introMs: num('INTRO_MS', 4200), loadMinMs: num('LOAD_MIN_MS', 4500), loadMaxMs: num('LOAD_MAX_MS', 22000), lootDailyCap: num('LOOT_DAILY_CAP', 5),
    ...(env.FORCE_TRACK ? { forceTrack: String(env.FORCE_TRACK) } : {}), fullStartDelayMs: num('FULL_START_DELAY_MS', 3000), minStartWaitMs: num('MIN_START_WAIT_MS', 15000),
    readyStartDelayMs: num('READY_START_DELAY_MS', 1500), finishTimeoutMs: num('FINISH_TIMEOUT_MS', 25000), graceMs: num('RECONNECT_GRACE_MS', 15000), lobbyGraceMs: num('LOBBY_GRACE_MS', 10000),
    resultsKeepMs: num('RESULTS_KEEP_MS', 60000), botOfferMs: num('BOT_OFFER_MS', 30000), botCount: num('BOT_COUNT', 5),
    duel: Object.fromEntries([['startMs', 'DUEL_START_MS'], ['revealMs', 'DUEL_REVEAL_MS'], ['graceMs', 'DUEL_GRACE_MS'], ['botOfferMs', 'DUEL_BOT_OFFER_MS'], ['waitMaxMs', 'DUEL_WAIT_MAX_MS'], ['tickMs', 'DUEL_TICK_MS'], ['questions', 'DUEL_QUESTIONS'], ['answerMs', 'DUEL_ANSWER_MS']]
      .filter(([, k]) => env[k] !== undefined && env[k] !== '').map(([c, k]) => [c, Number(env[k])])),
    quizAnswerMs: num('QUIZ_ANSWER_MS', 7000), ...(env.QUIZ_GATES ? { quizGates: String(env.QUIZ_GATES).split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0) } : {}),
  }, supa, log);
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const maxPerIp = num('MAX_CONN_PER_IP', 8), perIp = new Map(), trustProxy = env.TRUST_PROXY === '1';
  const started = Date.now();
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, uptime_s: Math.round((Date.now() - started) / 1000), ...game.snapshot() }));
    }
    res.writeHead(404); res.end();
  });
  attachWebSocket(server, {
    maxPayload: 2048, burst: 120, ratePerSec: 80, trustProxy, onError: (e) => log('ws_error', { err: String(e) }),
    accept(req, ip) {
      const origin = req.headers.origin;
      if (origin) { if (!allowed.includes(origin) && env.DEV_ALLOW_ANY_ORIGIN !== '1') return false; }
      else if (env.ALLOW_NO_ORIGIN === '0') return false;                // native clients may omit Origin
      const n = perIp.get(ip) || 0; if (n >= maxPerIp) return false;
      perIp.set(ip, n + 1);
      req.socket.once('close', () => { const k = (perIp.get(ip) || 1) - 1; if (k <= 0) perIp.delete(ip); else perIp.set(ip, k); });
      return true;
    },
  }, game.onConnection);
  return { server, game, close: () => { game.stop(); server.close(); server.closeAllConnections?.(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) if (!process.env[k]) { console.error('missing env ' + k); process.exit(1); }
  const { server } = createServer();
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => console.log(JSON.stringify({ ev: 'listening', port })));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(JSON.stringify({ ev: 'shutdown', sig })); server.close(); setTimeout(() => process.exit(0), 500).unref(); });
}
