# Contributing to Meeting Bingo

Thanks for pitching in! This doc is the developer's map: how the app is put together,
the realtime protocol, the data model, and how to add things without breaking a live game.

- [Architecture](#architecture)
- [Auth](#auth)
- [Data model](#data-model)
- [WebSocket protocol](#websocket-protocol)
- [Conventions](#conventions)
- [Front-end notes](#front-end-notes)
- [Recipes](#recipes)
- [Deployment & data safety](#deployment--data-safety)
- [Testing](#testing)
- [Dev workflow](#dev-workflow)
- [Gotchas](#gotchas)

---

## Architecture

```
Browser (public/app.js)
   │  POST /api/login  ──────────────►  Worker (src/index.js)         validates password,
   │  ◄── { token }                                                   returns an HMAC token
   │
   │  WebSocket  /ws?token=…  ───────►  Worker  ── forwards ──►  Durable Object
   │  ◄── { type:"state", … } broadcasts                        BingoRoom (src/bingo-room.js)
   │                                                            • holds ALL game state
   └──  everything else (HTML/CSS/JS) ─►  Worker ── ASSETS binding    • broadcasts on change
```

- **One Worker** ([`src/index.js`](src/index.js)) serves the static front end (via the
  `ASSETS` binding), handles `POST /api/login`, and upgrades `/ws` connections — but only
  after validating the token. It then forwards the socket to the Durable Object.
- **One Durable Object** ([`src/bingo-room.js`](src/bingo-room.js)), `BingoRoom`, is the
  single shared room for the whole site (`idFromName("global")`). It owns every piece of
  game state, handles all realtime messages, and is the only place state is mutated.
- **Realtime model:** dead simple. On *any* change, the DO calls `broadcast()`, which
  serializes the **entire** game state to one JSON message and sends it to every connected
  socket. Clients re-render from the full snapshot. State is small, so this is fine.
- **Connections** use the Durable Object **WebSocket Hibernation API**
  (`acceptWebSocket` + `webSocketMessage` / `webSocketClose`), so the room survives
  eviction without dropping players.
- **No build step.** The front end is hand-written HTML/CSS/JS in `public/`, served as-is.

## Auth

1. Client `POST`s `{ password }` to `/api/login`.
2. Worker compares it (constant-time) to `env.SITE_PASSWORD`. On success it returns
   `{ ok: true, token }`, where `token` is `HMAC-SHA256("meeting-bingo-authed-v1")` keyed
   by the password (Web Crypto).
3. Client stores the token and opens `wss://…/ws?token=…`. The Worker recomputes the
   expected token and rejects mismatches before reaching the DO.

The token is derived from the password, so **changing the password invalidates all tokens**.

## Data model

State is kept in Durable Object storage under these keys (loaded into memory in the
constructor, written back on change):

| Storage key | Shape | Notes |
|-------------|-------|-------|
| `items` | `string[]` | The shared bingo list. Falls back to `DEFAULT_ITEMS`. |
| `players` | `{ [key]: Player }` | `key` is the player's normalized name (see [Conventions](#conventions)). |
| `season` | `{ term, year }` | `term ∈ {Spring, Summer, Fall, Winter}`. |
| `winners` | `{ term, year, name, at }[]` | One declared winner per season. |
| `votes` | `{ [candidateKey]: approverKey[] }` | Current game's winner approvals; reset on new game. |
| `stats` | `{ [itemKey]: { [playerKey]: count } }` | Lifetime per-person mark counts. `itemKey` is the normalized item (see `displayItem`). |
| `statLabels` | `{ [itemKey]: prettyText }` | Display label for each stats row. |
| `statNames` | `{ [playerKey]: name }` | Display name for stats columns (kept even after removal). |
| `contests` | `{ [targetKey]: { [index]: contesterKey[] } }` | Disputed marked squares on each board; reset on new game / re-deal. |
| `statsMergeV1` | `true` | One-shot flag; marks the stats duplicate-row merge as done. |

```js
Player = {
  name,            // display name as entered
  stamp,           // emoji/character (≤ 8 chars)
  stampImg,        // data: URL of an uploaded marker image, or null
  color,           // assigned from COLORS
  card,            // string[25], index 12 is always "FREE"
  marks,           // boolean[25], index 12 starts true (free square)
  bingo,           // boolean — has a completed line right now
}
```

## WebSocket protocol

### Client → server

Each is a JSON message with a `type`. The sender is identified by the socket's attachment
(set on `join`), **not** by anything in the message — so `toggle` etc. always act on the
sender. Validation lives in the DO; invalid messages are ignored.

| `type` | Payload | Effect |
|--------|---------|--------|
| `join` | `{ name, stamp, stampImg }` | Joins/attaches by normalized name. Keeps an existing player's card/marks; updates name/stamp. |
| `toggle` | `{ index }` | Toggles one of the sender's squares (not the free center). Updates bingo + stats. |
| `setStamp` | `{ stamp, stampImg }` | Change the sender's stamp. `stampImg: null` clears the image. |
| `rename` | `{ name }` | Rename (rarely used; the client re-`join`s instead). |
| `newCard` | — | Deal the sender a fresh card; clears their marks. |
| `setCard` | `{ card: string[25] }` | Replace the sender's card with a typed-in one (the "Enter my card" import). |
| `clearMarks` | — | Clear the sender's marks. |
| `updateList` | `{ items: string[] }` | Replace the shared list (≤ 200 items). |
| `reshuffleAll` | — | Re-deal everyone (keeps the season). |
| `resetItems` | — | Reset the list to `DEFAULT_ITEMS`. |
| `removePlayer` | `{ playerId }` | Remove a player. Allowed only for self, or if the sender is an admin. |
| `newGame` | `{ season: { term, year } }` | Set the season, deal fresh cards, clear marks + votes. |
| `startReview` | — | Ask for this player's `REVIEW_BATCH` slice of the list (assigned once per round). |
| `submitReview` | `{ votes: {item: "keep"\|"cut"}, add: string[] }` | Record votes on assigned items, append de-duplicated suggestions, apply cuts. |
| `skipReview` | — | Bow out of the round without voting (still marks the player answered). |
| `approveWinner` | `{ playerId }` | Approve a (bingo'd) candidate. `APPROVALS_NEEDED` distinct approvers declares them. |
| `unapproveWinner` | `{ playerId }` | Withdraw the sender's approval. |
| `clearWinner` | `{ season }` | Remove a declared winner; reopens voting for the current season. |
| `contest` | `{ playerId, index }` | Toggle the sender's contest on a marked square of another player's board. |
| `resolveContest` | `{ playerId, index, uphold }` | Owner/admin resolves a contest. `uphold:true` un-marks the square; either way the contest clears. |

### Server → client

A single message type:

```js
{
  type: "state",
  items, players, online,        // online: array of currently-connected player keys
  season, gameActive,            // gameActive: false = "no game in progress"
  winners, votes,
  adminNames,                    // from ADMIN_NAMES; clients use it to show admin controls
  review,                        // { open, round, done, assign } — list-review round

  stats, statLabels, statNames, contests, nudges,
  bingoBy?,                      // present once when a player just reached bingo (for the banner)
  winnerDeclared?,               // present once when approvals just declared a winner
}
```

There is no partial/delta update — clients always render from the full snapshot.

## Conventions

- **Identity = normalized name.** A player's key is `name.trim().toLowerCase()`. The same
  function exists on both sides: `myKey()` in `app.js`, inline in the DO's `join`. This is
  why re-entering the same name on any device restores your card. Keep the two in sync.
- **Admins** come from the `ADMIN_NAMES` env var, parsed once in the DO constructor
  (`this.admins`) and enforced there. The DO broadcasts them as `adminNames`, and the
  client rebuilds its `ADMINS` set from each state update — so there is one source of
  truth, and no names live in the source.
- **Instance config** that must stay out of the public repo (admin names, a default
  stamp image) goes in Worker secrets / `.dev.vars` and git-ignored `public/stamps/`.
  `GET /api/config` exposes only the non-sensitive default-stamp path to the client.
- **Broadcast on every change.** After mutating state and persisting, call `broadcast()`.
- **Persist before broadcasting.** Write to `ctx.storage` so a later eviction can't lose it.
- **Additive, backward-compatible state.** New state keys must default sensibly when absent
  (e.g. `(await storage.get("votes")) || {}`) so a live game upgrades cleanly. See
  [Deployment & data safety](#deployment--data-safety).
- **Pure helpers for anything testable.** Migrations and derived logic are written as
  exported pure functions (`rekeyByName`, `mergeStats`) so they can be unit-tested
  with Node. Follow that pattern.

## Front-end notes

`public/app.js` is plain JS, top-to-bottom: helpers → state → screens (login → name →
game) → WebSocket → renderers → modals. A few things to know:

- **Safe storage.** `localStorage` can throw (Safari private mode / blocked cookies). Use
  the `store` wrapper, which falls back to an in-memory map and never throws.
- **`[hidden]` is forced off.** `styles.css` has a global `[hidden] { display: none !important }`
  because a class like `display:flex` otherwise *overrides* the browser's default
  `[hidden]` rule. If you toggle visibility with the `hidden` attribute, this keeps it real.
- **Tabs.** `Game` / `Stats` is a simple show/hide via `setTab()` (`activeTab` state).
- **Odds are client-side.** `computeOdds()` derives each player's implied win % from their
  marks — no server involvement. (Stats, the future basis for smarter odds, *are* server-side.)
- **Render is idempotent.** `render(state)` rebuilds from a full snapshot; don't keep
  derived UI state that the snapshot can't reproduce.

## Recipes

### Add a new realtime action

1. **Server** (`bingo-room.js`): add a `case "yourAction":` in `webSocketMessage`. Read
   the sender via the socket attachment (`pid`), validate input, mutate state, persist with
   `ctx.storage.put(...)`, then `return this.broadcast()`.
2. **Client** (`app.js`): send it with `send({ type: "yourAction", ... })` from a handler,
   and use the new state in `render()`.

### Add a new piece of persisted state (safe for a live game)

1. Load it with a default in the constructor: `this.foo = (await ctx.storage.get("foo")) || {}`.
2. Add it to the `broadcast()` payload.
3. Mutate + persist it in the relevant message handlers.
4. If you need to **backfill or correct** existing data on upgrade, write a pure function
   (like `mergeStats`) and run it once behind a flag (like `statsMergeV1`) so it can't
   double-apply on the next restart. Unit-test the function.

## Deployment & data safety

`main` auto-deploys via Cloudflare Workers Builds (`wrangler deploy`). Game state lives in
Durable Object storage and is **not** affected by code deploys.

**Safe across deploys:** editing code, adding additive state, runtime secrets
(`SITE_PASSWORD` persists; deploys never clear it).

**Destroys game data — avoid unless you mean it:**

- Renaming the DO class `BingoRoom`, or its binding, without a rename migration.
- Changing `idFromName("global")` to a different room name.
- Adding a destructive migration in `wrangler.jsonc` (`deleted_classes` / `renamed_classes`).
- Deleting the Worker in the dashboard.

**Rules for changes that ship to a live game:**

- Never reset `players` / `winners` / `votes` / `stats` on load.
- New state must default when absent.
- Migrations and backfills must be idempotent (guard with a flag).
- After a deploy, players with the game open should refresh once to load new code.

There are already two such migrations to model yours on: `rekeyByName` (re-keys players by
name, idempotent) and `mergeStats` (one-time stats duplicate-row merge, gated by `statsMergeV1`).

## Testing

There's no test framework; testing is lightweight and deliberate.

- **Manual:** `npm run dev`, open two browser windows, and exercise the flow (join, mark,
  bingo, approve, new game, stats). The change-verification habit is to actually run it.
- **Pure-function unit checks:** logic that's hard to click through is extracted into
  exported pure functions and checked with Node's ES module runner, e.g.:
  ```bash
  node --input-type=module -e "
    import { rekeyByName } from './src/bingo-room.js';
    console.log(rekeyByName({ 'rand-id': { name:'Alice', marks:[], card:[] } }));
  "
  ```
  Currently exported for testing: `rekeyByName`, `mergeStats`. Add more as needed.

When you add non-trivial logic, prefer the pure-function-plus-Node-check pattern.

## Dev workflow

1. Branch off `main`.
2. Make the change; run it locally (`npm run dev`) and verify in the browser.
3. Keep changes **additive** if they touch persisted state (the production game may be
   live). See [Deployment & data safety](#deployment--data-safety).
4. Match the surrounding style: 2-space indent, double quotes, semicolons, small focused
   functions, comments that explain *why*.
5. Don't commit `node_modules/`, `.dev.vars`, or `.wrangler/` (all git-ignored).
6. Open a PR against `main`. Merging to `main` auto-deploys, so make sure it runs.

## Gotchas

- **`[hidden]` vs `display:` classes** — see [Front-end notes](#front-end-notes).
- **`localStorage` can throw** — always go through the `store` wrapper.
- **Identity normalization must match** on client and server, or players won't find their
  own card.
- **Two people, same name = shared card.** Intentional (name is identity), but worth knowing.
- **Image stamps** are size-capped (`cleanStampImg`); the client resizes before sending,
  preserving PNG transparency.
- **`.dev.vars` only matters locally**; production uses the Cloudflare secret.
