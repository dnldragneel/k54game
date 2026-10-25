# K54 race server

Hosts the live 3-player races. Needs only Node 22 (the Dockerfile does the rest). One instance only: races live in memory.

Environment variables (already filled in `render.yaml` except the secret one):
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` - public values for your project
- `SUPABASE_SERVICE_ROLE_KEY` - SECRET. Paste it into the host's secret settings yourself. Never put it in this folder, the game, or a chat.
- `ALLOWED_ORIGINS` - your game's address (comma list)
- `TRUST_PROXY=1` - when behind the host's HTTPS proxy

Check it: open `https://<your-service>.onrender.com/health` - you should see `{"ok":true,...}`.
