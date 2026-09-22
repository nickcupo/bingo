# Meeting Bingo

A small, self-hostable multiplayer bingo game for meetings — no numbers, just the
things people say and do on calls. One shared password, everyone gets their own card
from a shared list, and you can watch everyone's progress live.

The writeup, with how it is built and why: [nickcupo.com/projects/meeting-bingo](https://nickcupo.com/projects/meeting-bingo).

**Stack:** Cloudflare Workers + Durable Objects (SQLite) + native WebSockets, with a
plain vanilla HTML/CSS/JS front end. No build step, no framework. Runs on Cloudflare's
free plan.

> New contributor? Read [CONTRIBUTING.md](CONTRIBUTING.md) for the architecture,
> the WebSocket message protocol, the data model, and step-by-step recipes.

---

## Features

- Shared password to get in.
- Everyone picks a name and a stamp: a character, an emoji, or an image they upload.
- Each player gets their own random 5×5 card (free center square) — or imports an
  existing card via **Enter my card**.
- A shared item list **anyone can edit**; cards are generated from it.
- **Identity is your name** — re-enter the same name on any device to get your card back.
- Live **Players** panel with each player's progress, a mini-card, and live **win odds**
  (ranked by the [win rules](#how-winning-works): most Bingos, then most marked squares).
- **Remote verification + voting**: open any player's card to verify a line; a winner is
  officially declared once **two other people approve** it.
- **Contest squares**: dispute a specific marked square on someone else's board; the card
  owner or an admin can uphold it (un-marking the square) or dismiss it.
- **Seasonal winners**: one game per quarter (Spring / Summer / Fall / Winter), with a
  recorded winner per quarter and a running history.
- **Stats tab**: how often each person has marked each item, across all games (the
  foundation for smarter, per-person odds later).
- Removing other players, starting a new game, and undoing a winner are admin-only
  (see [Configuration](#configuration)).

---

## Quick start (local)

Prereqs: **Node 18+** and npm. (Wrangler, the Cloudflare CLI, comes in via `npm install`.)

```bash
git clone https://github.com/nickcupo/bingo.git
cd bingo
npm install
cp .dev.vars.example .dev.vars   # sets the local password
npm run dev
```

Open the URL Wrangler prints (usually http://localhost:8787). The local password is
whatever you put in `.dev.vars` (`meeting-bingo` by default). Open two browser windows
(or one normal + one private) to see the multiplayer sync.

> `.dev.vars` is git-ignored on purpose — it's local-only. Production reads the password
> from a Cloudflare **secret** instead (see below).

## Repository layout

```
bingo/
├─ wrangler.jsonc        # Cloudflare config: Worker name, assets, Durable Object, migrations
├─ package.json          # scripts (dev / deploy) + wrangler dev-dependency
├─ .dev.vars.example     # template for the local SITE_PASSWORD (copy to .dev.vars)
├─ src/
│  ├─ index.js           # Worker entry: serves assets, /api/login, gates /ws
│  └─ bingo-room.js      # Durable Object: all game state + the WebSocket protocol
└─ public/               # static front end (served by the Worker, no build step)
   ├─ index.html
   ├─ app.js             # all client logic
   ├─ styles.css

```

| File | Role |
|------|------|
| [`src/index.js`](src/index.js) | Worker: serves the site, handles `POST /api/login` (password → token), gates the `/ws` WebSocket, forwards it to the Durable Object. |
| [`src/bingo-room.js`](src/bingo-room.js) | The `BingoRoom` Durable Object — one shared room holding items, players, cards, season, winners, votes, and stats. All real-time messages live here. |
| [`public/`](public/) | Front end. `app.js` is the whole client; `styles.css` the whole stylesheet. |

A deeper tour — architecture, the full message protocol, the persisted data model, and
how to add a feature — is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run locally with Wrangler (reads `.dev.vars`). |
| `npm run deploy` | Deploy to Cloudflare (`wrangler deploy`). Usually you don't run this by hand — see [Deployment](#deployment). |

## Configuration

- **Password** — `SITE_PASSWORD`. Local: `.dev.vars`. Production: a Wrangler secret
  (`npx wrangler secret put SITE_PASSWORD`). A secret overrides any value in config.
- **Admins** (who may remove players, start/end games, set the season, undo winners) —
  `ADMIN_NAMES`, a comma-separated list of player names (case-insensitive), e.g.
  `alex,sam`. Local: `.dev.vars`. Production: `npx wrangler secret put ADMIN_NAMES`.
  Enforced server-side; the list is sent to clients so they show the admin controls.
  Unset → a single `admin` account.
- **Default stamp image** (optional) — `DEFAULT_STAMP_IMG`, a same-origin path such as
  `/stamps/marker.png` (or a `data:image/…` URL). New players start with it selected.
  Unset → players start with a text stamp. Anything under `public/stamps/` is
  git-ignored, so a private image can ship with `npm run deploy` without being committed.
- **Approvals needed to declare a winner** — `APPROVALS_NEEDED` in `src/bingo-room.js`
  (default `2`).
- **Default bingo items** — `DEFAULT_ITEMS` in `src/bingo-room.js` (also editable live
  in the app under **Game settings**).

## Deployment

The repo is wired for **continuous deployment**: pushing to `main` on GitHub triggers a
Cloudflare **Workers Build** that runs `wrangler deploy`. So the normal flow is just:

```bash
git push        # → Cloudflare builds & deploys main automatically
```

First-time setup (one time, in the Cloudflare dashboard): open the **meeting-bingo**
Worker → **Settings → Builds → Connect**, pick this repo, branch `main`, deploy command
`npx wrangler deploy`. Make sure the `SITE_PASSWORD` secret is set on the Worker
(**Settings → Variables and Secrets**). See
[CONTRIBUTING.md → Deployment & data safety](CONTRIBUTING.md#deployment--data-safety)
for the details and the rules that keep deploys from disrupting a live game.

To deploy by hand instead: `npx wrangler login && npm run deploy`.

### Deploys never wipe game data

Game state (players, cards, marks, winners, votes, stats) lives in **Durable Object
storage**, which is independent of the code you deploy and of the Cloudflare **secret**.
Pushing new code keeps all of it. The things that *would* destroy data are listed in
[CONTRIBUTING.md](CONTRIBUTING.md#deployment--data-safety) — read that before touching
`wrangler.jsonc` migrations or the Durable Object class name.

---

## How winning works

These rules are also shown in-app under the **Rules** link, and they drive the live odds
and the Players ordering.

1. Play continues until all planning meetings are completed.
2. If only one player gets Bingo, they win.
3. If several players get Bingo, the winner has the **most Bingos** (completed rows,
   columns, or diagonals).
4. If still tied, the winner has the **most marked squares** overall.
5. If still tied, it goes to an **offline tiebreaker**.

## How a meeting works

1. At the start of a quarterly meeting, open **Winners → Start new game** to set the
   quarter and deal everyone fresh cards (or **Game settings → Re-deal everyone's cards**
   to redeal without changing the season).
2. People mark squares as things happen. Returning players just re-enter their name to
   get their card back.
3. When someone calls bingo, anyone can select that player in the **Players** list to open
   their card and confirm the line is real.
4. Two people click **Approve … as winner**; on the second approval the winner is recorded
   for the quarter and shown in **Winners**.

## Security note

The password is checked server-side and converted into an HMAC token that the WebSocket
requires, so people without it can't connect or see game state. Because identity is just a
name, "admin" means *whoever is using that name* — fine for a trusted team, not a hard
security boundary. It's a lightweight gate for an internal game, not bank-grade auth.
