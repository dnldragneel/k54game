# K54 race server

Hosts the **online 1v1 quiz duels** (the main online mode: 10 questions, 15 seconds each, faster answers score more, scored and paid by this server, plus a practice bot when nobody is waiting) and the just-for-fun online races (2 to 10 players; protocol 7: three traffic lanes, ten racers, three race modes - normal / power-ups / road-sign quiz -, practice races against bots, reversing, and private rooms whose host can allow car crashes and switch traffic on or off). Races pay no coins; duels do. Needs only Node 22 (the Dockerfile does the rest). One instance only: races live in memory.

Environment variables (already filled in `render.yaml` except the secret one):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` - public values for your project
- `SUPABASE_SERVICE_ROLE_KEY` - SECRET. Paste it into the host's secret settings yourself. Never put it in this folder, the game, or a chat.
- `ALLOWED_ORIGINS` - your game's address (comma list)
- `TRUST_PROXY=1` - when behind the host's HTTPS proxy

Check it: open `https://<your-service>.onrender.com/health` - you should see `{"ok":true,...}`.

## Updating
When a new version of the game ships, upload the new files from this folder to the same GitHub repo (Render redeploys by itself) **and** deploy the new game on Netlify. They share the driving rules (`shared/race-sim.cjs`), so an old server with a new game, or the other way round, makes the car snap back on every update. Needs the database update `APPLY-0019-0021.sql` first (the duel results are saved there). The game checks the server's protocol version (now 7) and tells players if the server is older.
