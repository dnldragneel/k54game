# K54 race server

Hosts the **online 1v1 quiz duels** (the main online mode: 10 questions, 15 seconds each, faster answers score more, scored and paid by this server, plus a practice bot when nobody is waiting) and the online races (2 to 10 players; protocol 9: four tracks with skins, drifting, ramps, crashes, a loading wait so nobody starts early, spectating, practice races against bots, and private rooms that stay open after a race (everyone is kept for the next one, the host can hand the room to someone else), plus private duel rooms with a code). Races pay no coins; duels do, and the winner of a quick match earns a loot box. Needs only Node 22 (the Dockerfile does the rest). One instance only: races live in memory.

Environment variables (already filled in `render.yaml` except the secret one):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` - public values for your project
- `SUPABASE_SERVICE_ROLE_KEY` - SECRET. Paste it into the host's secret settings yourself. Never put it in this folder, the game, or a chat.
- `ALLOWED_ORIGINS` - your game's address (comma list)
- `TRUST_PROXY=1` - when behind the host's HTTPS proxy

Check it: open `https://<your-service>.onrender.com/health` - you should see `{"ok":true,...}`.

## Updating
When a new version of the game ships, upload the new files from this folder to the same GitHub repo (Render redeploys by itself) **and** deploy the new game on Netlify. They share the driving rules (`shared/race-sim.cjs`), so an old server with a new game, or the other way round, makes the car snap back on every update. Needs the database updates `APPLY-0025.sql` (loot boxes) and `APPLY-0026.sql` (mistake notebook is K54 Pass only) first; the earlier `APPLY-0019-0021.sql` holds the duel results. The game checks the server's protocol version (now 9) and tells players if the server is older; an older game on this server is asked to update.

## Where it runs matters (lag)
A race feels as good as the round trip between each phone and this server. Render has no African region; **Frankfurt** is the closest there (`render.yaml` says `region: frankfurt`) and a South African phone is roughly 150-200 ms away from it. **Johannesburg (Fly.io, `fly.toml` in this folder) is the single biggest lag cut: about 10-40 ms.** A service's region cannot be changed after it is created: to move, make a new service in the right region from this folder, then change the server address in the game's config and redeploy the website. The free Render plan also has very little CPU: open `/health` right after a race and read `tick`: `lateMaxMs` regularly above `budgetMs` (33) or a growing `ticksBehind` means the server itself cannot keep 30 ticks a second and needs a bigger plan. In the game, the little **📶 ms** chip at the top of a race shows each player's own ping.

Built-in smoothing (nothing to set): the server sends 30 snapshots a second but, for a phone that stops acknowledging them (a stalled or very slow connection), thins them to every third tick (`snapLagTicks`, shown as `snapThinned` in `/health` and `thinned` in the race log) so the queue cannot grow into a long delay; the game adapts its playback delay to each connection and lowers its drawing resolution on slow phones instead of dropping frames.

## Johannesburg on Fly.io
Cost: about **US$2-4 a month** for one small machine (shared-cpu-1x) plus a little traffic (Africa traffic is billed per GB; a race is only a few hundred bytes per tick). Fly has no free plan for new accounts, so you add a card. Check the current price on fly.io/docs/about/pricing.

1. Install the Fly CLI (`flyctl`, see fly.io/docs/flyctl/install) and run `fly auth signup` (or `fly auth login`).
2. In this folder (the one with `fly.toml` and the `Dockerfile`): open `fly.toml` and change `app = "k54-race"` to a name nobody has taken (e.g. `k54-race-yourname`). Then:
   `fly launch --no-deploy --copy-config --region jnb`
   (say **No** to a database/Redis, **No** to deploying now).
3. Paste the secret yourself, in your own terminal (never in a chat, the game or a file):
   `fly secrets set SUPABASE_SERVICE_ROLE_KEY=<your service-role key from Supabase > Project Settings > API>`
4. Deploy **exactly one** machine (rooms live in memory, a second copy would split the players):
   `fly deploy --ha=false`
   then `fly scale count 1` if `fly status` ever shows two machines.
5. Check it: open `https://<app>.fly.dev/health`. You should see `{"ok":true,...}`.
6. Point the game at it: set `raceUrl` to `wss://<app>.fly.dev` in `config/k54.config.json` and `config/k54.android.json`, run `node build.js` (or `tools/package.sh`), deploy the website on Netlify and ship the new Android build. Players on the old address keep working until you stop Render, so there is no rush-hour switch.
7. When a race on the new address works, delete or suspend the Render service.

Updating later: `fly deploy --ha=false` from this folder, together with the website deploy.
Logs: `fly logs`. Region check: `fly status` should say `jnb`.
