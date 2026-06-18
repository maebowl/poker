# ♠ Poker — Texas Hold'em with voice chat

A self-hosted Texas Hold'em table for `poker.mabelwallin.com`. Friends open the
page, type a **table code**, and play **play-money** hands together with **voice
chat**. No accounts, no database — tables are ephemeral and disappear when empty.

```
  🧑 player ─┐
  🧑 player ─┤   poker actions over WebSocket (server is authoritative)
  🧑 player ─┼──────────────►  🖥️  Node server (owns the deck + game state)
  🧑 player ─┘                       └── relays WebRTC voice signaling only ──┘
        └──────── voice audio is peer-to-peer (WebRTC mesh), never via the server ──┘
```

The **server is fully authoritative**: it owns the shuffled deck (via the
[`poker-ts`](https://www.npmjs.com/package/poker-ts) rules engine), runs the
betting state machine, and sends each player a *personalized* view that contains
**only their own hole cards**. You cannot see anyone else's cards until showdown
because they are never sent to your browser.

## Quick start (local)

```bash
npm install
npm start
```

Open <http://localhost:3000>. To play with yourself for testing, open a second
browser window (or an incognito window) and join the same table code.

- **Camera/mic note:** voice needs `https://` or `localhost`. On `localhost` it
  works immediately. Over a plain LAN IP browsers block the mic — use a tunnel
  or deploy (below).

## How to play

1. Enter a name and a **table code** (e.g. `FRIDAY`). Anyone who types the same
   code lands at the same table. Use **Copy invite** to share a link that
   pre-fills the code (`/?table=FRIDAY`).
2. Click an empty seat to **sit down** and buy in for play chips.
3. With ≥2 players seated, a hand starts automatically. On your turn the action
   bar shows **Fold / Check / Call / Bet-Raise** (with a slider and
   Min / ½ Pot / Pot / All-in shortcuts). You have ~30s per decision.
4. **Voice:** click **🎙️ Voice off** to enable your mic and join the table's
   voice mesh. Click again to **mute/unmute**; **right-click** the button to
   leave voice. Each seated/spectating player connects directly to every other.
5. Bust out? Just click an open seat to buy back in.

Tuning (blinds, buy-in, seats, timers) lives at the top of [`game.js`](game.js).

## Deploying to `poker.mabelwallin.com` (Cloudflare)

Your DNS is on Cloudflare, so the cleanest path is a **Cloudflare Tunnel** — it
exposes the local Node server at the subdomain with automatic TLS and full
WebSocket support, no open ports or firewall changes. (Same `cloudflared` tool
you already use in the cameraFeed project.)

### Option A — Cloudflare Tunnel (recommended)

Run these once on whatever machine will host the app (your PC, a mini server, a
VPS — it just needs to stay on):

```bash
# 1. Run the app (keep it running; see "Keeping it alive" below)
npm install && npm start            # serves on http://localhost:3000

# 2. Authorize cloudflared for the mabelwallin.com zone (opens a browser)
cloudflared tunnel login

# 3. Create a named tunnel + its credentials file
cloudflared tunnel create poker

# 4. Point the subdomain at the tunnel (creates the DNS record in Cloudflare)
cloudflared tunnel route dns poker poker.mabelwallin.com
```

Then create `~/.cloudflared/config.yml` (on Windows: `C:\Users\<you>\.cloudflared\config.yml`):

```yaml
tunnel: poker
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json
ingress:
  - hostname: poker.mabelwallin.com
    service: http://localhost:3000
  - service: http_404
```

Start it:

```bash
cloudflared tunnel run poker
```

Visit **https://poker.mabelwallin.com** — done. WebSockets and WebRTC signaling
work through the tunnel unchanged.

**Keeping it alive (24/7):** run both the app and the tunnel under a process
manager so they restart on reboot/crash:

- Tunnel as a service: `cloudflared service install` (then it runs the config above).
- App: use `pm2` (`npm i -g pm2 && pm2 start server.js --name poker && pm2 save`)
  or, on Windows, [`nssm`](https://nssm.cc/) to run `npm start` as a service.

> Quick throwaway test (no DNS setup): `cloudflared tunnel --url http://localhost:3000`
> prints a temporary `https://….trycloudflare.com` link you can share immediately.

### Option B — Host on Render/Railway/Fly + Cloudflare CNAME

If you'd rather not keep a machine on, deploy to a Node host and point Cloudflare
at it:

1. Push this folder to a Git repo and create a **Web Service** (Node) with start
   command `npm start`. The host hands you e.g. `poker-xyz.onrender.com`.
2. Add the custom domain `poker.mabelwallin.com` in the host's dashboard.
3. In **Cloudflare → DNS**, add a `CNAME` record: name `poker`, target
   `poker-xyz.onrender.com`. Cloudflare's proxy (orange cloud) supports
   WebSockets, so you can leave it proxied for Cloudflare TLS.

> ⚠️ This app needs a **always-on Node process with WebSockets**. Pure
> static/serverless hosts (Cloudflare Pages, Vercel/Netlify functions) can't run
> the game server — use a Node host or the tunnel above.

## Voice reliability (TURN, optional)

Audio connects directly via the free Google STUN server most of the time. On
some restrictive networks (certain cellular/corporate NATs) a direct path isn't
possible and you need a **TURN relay**. Provide one via env vars and it's served
to clients automatically:

```bash
TURN_URL=turn:your.turn.host:3478 TURN_USERNAME=user TURN_CREDENTIAL=pass npm start
```

You can self-host [coturn](https://github.com/coturn/coturn) or use a hosted
provider (metered.ca, Twilio). On a typical home/Wi-Fi network you won't need it.

## Configuration

| Env var | Purpose |
| --- | --- |
| `PORT` | HTTP port (default `3000`) |
| `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` | Optional TURN relay for hard NATs |
| `TLS_KEY` / `TLS_CERT` | Serve HTTPS directly (optional; the tunnel/host usually handles TLS) |

## Project layout

- [`server.js`](server.js) — Express static server + `ws` endpoint. Adapts
  WebSockets to the game and relays WebRTC voice signaling. Carries no audio.
- [`game.js`](game.js) — `PokerTable`: the authoritative game state machine
  (sit/stand, betting rounds, showdown, side pots, turn timers, per-player
  hole-card secrecy). Wraps the `poker-ts` rules engine.
- [`public/`](public/) — the table UI:
  - `app.js` — renders server state, betting controls, chat, the seat layout.
  - `voice.js` — the WebRTC voice mesh (one RTCPeerConnection per peer).
  - `index.html` / `style.css` — join screen and felt table.
- [`test/`](test/) — local checks. `play.js` and `edge.js` drive bots over the
  real protocol (need only the installed `ws`); `shot.js` / `voice.js`
  screenshot and verify voice via a headless browser (need
  `npm i --no-save puppeteer-core` and a local Chrome/Edge).

## Notes & limits

- **Play money only.** This is for fun among friends; there's no real-money
  handling and none should be added.
- Tables are in-memory and ephemeral — a server restart clears all tables.
- Voice is a full mesh, which is ideal for a poker table (≤9 seats). It is not
  meant for large rooms.
