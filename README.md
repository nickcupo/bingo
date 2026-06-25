# Meeting Bingo

A small, self-hostable multiplayer bingo game for meetings — no numbers, just the
things people say and do on calls. One shared password, everyone gets their own
card from a shared list, and you can watch everyone's progress live.

- Shared password to get in
- Everyone picks a name and a stamp (a character, an emoji, or an uploaded image)
- Each player gets their own random 5×5 card (free center square)
- A shared item list **anyone can edit** — cards are generated from it
- Live players panel: who's in, how far along they are, and a thumbnail of each card
- **Remote verification**: select any player to see their full card and confirm a win
- **Seasonal winners**: one game per quarter (Spring / Summer / Fall / Winter), with a
  recorded winner per quarter and a running history

Runs on **Cloudflare Workers + Durable Objects** (works on the free plan).

---

## Run locally

```bash
cd bingo
npm install
npm run dev
```

Open the URL wrangler prints (usually http://localhost:8787).

The password for **local** development is read from a `.dev.vars` file (already present,
set to `meeting-bingo` — change it if you like). In **production** the password comes from
the `SITE_PASSWORD` secret (see Deploy). Open two browser windows to see the live sync.

## Deploy (free)

1. Create a free [Cloudflare account](https://dash.cloudflare.com/sign-up).
2. `npx wrangler login`
3. **Set your password.** Edit `SITE_PASSWORD` in `wrangler.jsonc`, or — better — keep
   it out of the file with a secret (a secret overrides the file value):
   ```bash
   npx wrangler secret put SITE_PASSWORD
   ```
4. `npm run deploy`

Wrangler gives you a `https://meeting-bingo.<subdomain>.workers.dev` URL. Share it and
the password. You can attach a custom domain from the Cloudflare dashboard.

---

## How a meeting works

1. At the start of a quarterly meeting, open **Game settings → Re-deal everyone's cards**,
   or **Winners → Start new game** to set the quarter and deal fresh cards.
2. People mark squares as things happen.
3. When someone calls bingo, anyone can select that player in the **Players** list to open
   their full card and confirm the line is real.
4. Once verified, click **Record as &lt;quarter&gt; winner** in that card view. The winner is
   saved under the current quarter and shown in **Winners**.

## Files

| File | Role |
|------|------|
| `src/index.js` | Worker: serves the site, handles `/api/login`, gates the `/ws` WebSocket. |
| `src/bingo-room.js` | Durable Object: the shared room — items, players, cards, season, winners. |
| `public/` | Frontend (plain HTML/CSS/JS, no build step). |

## Notes

- One shared room for the whole site (matches the single shared password). Everyone edits
  the same list and sees the same players and winners.
- **Your name is your identity.** Cards are matched by name (case-insensitive), so closing
  the page, switching browsers, or moving to another device and entering the same name gives
  you back the same card and marks in the current game. (One consequence: two people must use
  different names, or they'll share a card.)
- **Removing a player:** select anyone in the Players list and choose *Remove this player*
  in their card view (or *Leave the game* on your own).
- Player records and winner history persist in Durable Object storage. A new deployment
  starts empty.
- The password is verified server-side and converted into a token the WebSocket requires,
  so people without it can't connect or see game state. It's a lightweight gate for an
  internal game, not bank-grade auth.
