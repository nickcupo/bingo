// Durable Object holding the single shared bingo room: the editable item list
// and every player's card / marks. State is persisted to DO storage and
// broadcast to all connected clients on every change.

const DEFAULT_ITEMS = [
  "You're on mute",
  "\"Can everyone see my screen?\"",
  "\"Let's take this offline\"",
  "\"Sorry, you go ahead\"",
  "\"Can you repeat that?\"",
  "Someone has a hard stop",
  "\"Let's circle back\"",
  "Dog barking / pet on camera",
  "\"Can you hear me?\"",
  "\"I think you're frozen\"",
  "\"Let's park that\"",
  "Awkward silence",
  "Two people talk at once",
  "\"Do we have quorum?\"",
  "\"Let's double-click on that\"",
  "Screen share fails",
  "\"Action item\"",
  "Kid / family member appears",
  "\"Per my last email\"",
  "\"Let's align on this\"",
  "\"Move the needle\"",
  "\"Low-hanging fruit\"",
  "\"Touch base\"",
  "\"Let's put a pin in it\"",
  "\"Synergy\"",
  "Construction / siren noise",
  "Late joiner asks answered question",
  "\"This could've been an email\"",
  "\"Can we go back a slide?\"",
  "\"Quick question\" (it's not quick)",
  "\"I'll send a follow-up\"",
  "\"Bandwidth\"",
];

const COLORS = [
  "#b4503f", "#c08a2e", "#3f7d5c", "#3d6b96",
  "#6a5a93", "#9c5577", "#4a8a86", "#8a6d3b",
];

const TERMS = ["Spring", "Summer", "Fall", "Winter"];

// Which quarter a given date falls in.
function currentSeason(date = new Date()) {
  const m = date.getUTCMonth(); // 0-11
  let term;
  if (m >= 2 && m <= 4) term = "Spring";
  else if (m >= 5 && m <= 7) term = "Summer";
  else if (m >= 8 && m <= 10) term = "Fall";
  else term = "Winter";
  return { term, year: date.getUTCFullYear() };
}

function cleanSeason(s) {
  if (!s || !TERMS.includes(s.term)) return null;
  const year = Number(s.year);
  if (!Number.isInteger(year) || year < 2000 || year > 3000) return null;
  return { term: s.term, year };
}

// Only these names (normalized) may remove other players.
const ADMINS = new Set(["nick", "lauryn"]);
// Approvals required before a winner is officially declared.
const APPROVALS_NEEDED = 2;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Build a 5x5 card (24 items + FREE center) from the item pool.
function makeCard(items) {
  const clean = items.map((s) => String(s).trim()).filter(Boolean);
  let pool = shuffle(clean);
  // If there aren't 24 distinct items, cycle to fill the gaps.
  while (pool.length > 0 && pool.length < 24) {
    pool = pool.concat(shuffle(clean));
  }
  const picks = pool.slice(0, 24);
  while (picks.length < 24) picks.push("(add more items)");

  const cells = [];
  let p = 0;
  for (let i = 0; i < 25; i++) {
    cells.push(i === 12 ? "FREE" : picks[p++]);
  }
  return cells;
}

// Accept a small data-URL image (client resizes before sending) or a
// same-origin asset path like "/stamps/horton.png". Returns the string, or
// null if invalid, so the broadcast payload stays light.
function cleanStampImg(v) {
  if (typeof v !== "string") return null;
  if (v.startsWith("data:image/")) return v.length <= 90000 ? v : null;
  // relative path, no protocol-relative "//" and no parent traversal
  if (/^\/(?!\/)[\w\-./]{1,200}$/.test(v) && !v.includes("..")) return v;
  return null;
}

// Migration: older versions keyed players by a random per-browser id. Identity
// is now the normalized name, so re-key existing records by name on load. This
// keeps every in-progress card and its marks intact across the upgrade.
// Idempotent: once keys already equal the name, it does nothing.
export function rekeyByName(players) {
  const countMarks = (m) => (Array.isArray(m) ? m.reduce((n, x) => n + (x ? 1 : 0), 0) : 0);
  const out = {};
  let changed = false;
  for (const [key, p] of Object.entries(players || {})) {
    const target = String(p?.name || "").trim().toLowerCase() || key;
    if (target !== key) changed = true;
    if (out[target]) {
      // Name collision (rare): keep whichever has more progress.
      changed = true;
      out[target] = countMarks(p.marks) >= countMarks(out[target].marks) ? p : out[target];
    } else {
      out[target] = p;
    }
  }
  return { players: out, changed };
}

// One-time backfill: count squares currently marked in the game into stats, so
// stats reflect an already-in-progress game (not just marks made after upgrade).
// Mutates `stats` and `statNames` in place.
export function seedStatsFromMarks(players, stats, statNames) {
  for (const [key, p] of Object.entries(players || {})) {
    if (!Array.isArray(p?.marks) || !Array.isArray(p?.card)) continue;
    for (let i = 0; i < 25; i++) {
      if (i === 12 || !p.marks[i]) continue;
      const text = String(p.card[i] || "").trim();
      if (!text || text === "FREE" || text === "—" || text === "(add more items)") continue;
      if (!stats[text]) stats[text] = {};
      stats[text][key] = (stats[text][key] || 0) + 1;
      statNames[key] = p.name;
    }
  }
}

function freshMarks() {
  const m = new Array(25).fill(false);
  m[12] = true; // free space
  return m;
}

const LINES = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  return lines;
})();

function hasBingo(marks) {
  return LINES.some((line) => line.every((i) => marks[i]));
}

export class BingoRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      this.items = (await this.ctx.storage.get("items")) || DEFAULT_ITEMS;
      this.players = (await this.ctx.storage.get("players")) || {};
      const migrated = rekeyByName(this.players);
      if (migrated.changed) {
        this.players = migrated.players;
        await this.ctx.storage.put("players", this.players);
      }
      this.season = (await this.ctx.storage.get("season")) || currentSeason();
      this.winners = (await this.ctx.storage.get("winners")) || [];
      // votes: { candidateKey: [approverKey, ...] } for the current game.
      this.votes = (await this.ctx.storage.get("votes")) || {};
      // stats: how often each person has marked each item, across all games.
      // { itemText: { playerKey: count } } plus a key->display-name map.
      this.stats = (await this.ctx.storage.get("stats")) || {};
      this.statNames = (await this.ctx.storage.get("statNames")) || {};
      // One-time backfill: count squares already marked in the current game so
      // stats reflect the in-progress game, not just marks made after upgrade.
      if (!(await this.ctx.storage.get("statsSeededV1"))) {
        seedStatsFromMarks(this.players, this.stats, this.statNames);
        await this.ctx.storage.put("stats", this.stats);
        await this.ctx.storage.put("statNames", this.statNames);
        await this.ctx.storage.put("statsSeededV1", true);
      }
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: connections survive DO eviction.
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const attach = ws.deserializeAttachment() || {};
    const pid = attach.playerId;

    switch (msg.type) {
      case "join": {
        // Identity is the player's name (case-insensitive). Joining with an
        // existing name in the current game attaches to that player's card,
        // so you get your card back on any device just by entering your name.
        const display = String(msg.name || "").trim().slice(0, 40);
        if (!display) return;
        const id = display.toLowerCase();
        ws.serializeAttachment({ playerId: id });
        const existing = this.players[id];
        const idx = Object.keys(this.players).length % COLORS.length;
        this.players[id] = {
          name: display,
          stamp: String(msg.stamp || "✓").slice(0, 8),
          stampImg: "stampImg" in msg ? cleanStampImg(msg.stampImg) : (existing?.stampImg ?? null),
          color: existing?.color || COLORS[idx],
          card: existing?.card || makeCard(this.items),
          marks: existing?.marks || freshMarks(),
          bingo: existing?.bingo || false,
        };
        await this.persistPlayers();
        return this.broadcast();
      }

      case "toggle": {
        const player = this.players[pid];
        if (!player) return;
        const i = Number(msg.index);
        if (!Number.isInteger(i) || i < 0 || i > 24 || i === 12) return;
        player.marks[i] = !player.marks[i];
        const wasBingo = player.bingo;
        player.bingo = hasBingo(player.marks);
        await this.persistPlayers();
        await this.recordStat(player.card[i], pid, player.name, player.marks[i] ? 1 : -1);
        this.broadcast(player.bingo && !wasBingo ? { bingoBy: pid } : null);
        return;
      }

      case "setStamp": {
        const player = this.players[pid];
        if (!player) return;
        player.stamp = String(msg.stamp || "✓").slice(0, 8);
        // explicit null clears the image; undefined leaves it unchanged
        if (msg.stampImg === null) player.stampImg = null;
        else if (typeof msg.stampImg === "string") player.stampImg = cleanStampImg(msg.stampImg);
        await this.persistPlayers();
        return this.broadcast();
      }

      case "rename": {
        const player = this.players[pid];
        if (!player) return;
        player.name = String(msg.name || "Player").slice(0, 40);
        await this.persistPlayers();
        return this.broadcast();
      }

      case "newCard": {
        const player = this.players[pid];
        if (!player) return;
        player.card = makeCard(this.items);
        player.marks = freshMarks();
        player.bingo = false;
        await this.persistPlayers();
        return this.broadcast();
      }

      // Replace your card with one you typed in (e.g. an existing printed card).
      case "setCard": {
        const player = this.players[pid];
        if (!player) return;
        if (!Array.isArray(msg.card) || msg.card.length !== 25) return;
        player.card = msg.card.map((s, i) =>
          i === 12 ? "FREE" : (String(s ?? "").trim().slice(0, 120) || "—"),
        );
        player.marks = freshMarks();
        player.bingo = false;
        await this.persistPlayers();
        return this.broadcast();
      }

      case "clearMarks": {
        const player = this.players[pid];
        if (!player) return;
        player.marks = freshMarks();
        player.bingo = false;
        await this.persistPlayers();
        return this.broadcast();
      }

      case "updateList": {
        if (!Array.isArray(msg.items)) return;
        const items = msg.items
          .map((s) => String(s).trim())
          .filter(Boolean)
          .slice(0, 200);
        if (items.length === 0) return;
        this.items = items;
        await this.ctx.storage.put("items", this.items);
        return this.broadcast();
      }

      case "reshuffleAll": {
        for (const p of Object.values(this.players)) {
          p.card = makeCard(this.items);
          p.marks = freshMarks();
          p.bingo = false;
        }
        await this.persistPlayers();
        return this.broadcast();
      }

      case "resetItems": {
        this.items = [...DEFAULT_ITEMS];
        await this.ctx.storage.put("items", this.items);
        return this.broadcast();
      }

      case "removePlayer": {
        const target = String(msg.playerId || "");
        if (!target) return;
        // You may always remove yourself; only admins may remove others.
        if (target !== pid && !ADMINS.has(pid)) return;
        if (this.players[target]) {
          delete this.players[target];
          if (this.votes[target]) { delete this.votes[target]; await this.ctx.storage.put("votes", this.votes); }
          await this.persistPlayers();
        }
        return this.broadcast();
      }

      // Start a new game for a quarter: set the season and deal fresh cards.
      case "newGame": {
        const season = cleanSeason(msg.season);
        if (!season) return;
        this.season = season;
        this.votes = {};
        for (const p of Object.values(this.players)) {
          p.card = makeCard(this.items);
          p.marks = freshMarks();
          p.bingo = false;
        }
        await this.ctx.storage.put("season", this.season);
        await this.ctx.storage.put("votes", this.votes);
        await this.persistPlayers();
        return this.broadcast();
      }

      // Approve a player as the season's winner. Two distinct approvals (not
      // counting the player themselves) officially declare them the winner.
      case "approveWinner": {
        const targetKey = String(msg.playerId || "");
        const candidate = this.players[targetKey];
        if (!candidate || !candidate.bingo) return;
        if (!pid || pid === targetKey) return; // need an approver who isn't the candidate
        const { term, year } = this.season;
        // Voting is closed once a winner is declared this season.
        if (this.winners.some((w) => w.term === term && w.year === year)) return;
        const list = this.votes[targetKey] || [];
        if (!list.includes(pid)) list.push(pid);
        this.votes[targetKey] = list;
        let declared = false;
        if (list.length >= APPROVALS_NEEDED) {
          const entry = { term, year, name: candidate.name, at: Date.now() };
          const i = this.winners.findIndex((w) => w.term === term && w.year === year);
          if (i >= 0) this.winners[i] = entry; else this.winners.push(entry);
          await this.ctx.storage.put("winners", this.winners);
          declared = true;
        }
        await this.ctx.storage.put("votes", this.votes);
        return this.broadcast(declared ? { winnerDeclared: targetKey } : null);
      }

      case "unapproveWinner": {
        const targetKey = String(msg.playerId || "");
        if (!pid || !Array.isArray(this.votes[targetKey])) return;
        this.votes[targetKey] = this.votes[targetKey].filter((k) => k !== pid);
        await this.ctx.storage.put("votes", this.votes);
        return this.broadcast();
      }

      // Remove a declared winner and reopen voting for that season.
      case "clearWinner": {
        const season = cleanSeason(msg.season);
        if (!season) return;
        this.winners = this.winners.filter(
          (w) => !(w.term === season.term && w.year === season.year),
        );
        await this.ctx.storage.put("winners", this.winners);
        if (season.term === this.season.term && season.year === this.season.year) {
          this.votes = {};
          await this.ctx.storage.put("votes", this.votes);
        }
        return this.broadcast();
      }
    }
  }

  webSocketClose(ws) {
    // Keep the player record (so they can rejoin with the same card); just
    // refresh online presence for everyone.
    this.broadcast();
  }

  webSocketError(ws) {
    this.broadcast();
  }

  async persistPlayers() {
    await this.ctx.storage.put("players", this.players);
  }

  // Adjust the lifetime count of how often `playerKey` has marked `item`.
  // delta is +1 (marked) or -1 (un-marked, e.g. a misclick correction).
  async recordStat(item, playerKey, name, delta) {
    const text = String(item || "").trim();
    if (!text || text === "FREE" || text === "—" || text === "(add more items)") return;
    if (!this.stats[text]) this.stats[text] = {};
    const next = Math.max(0, (this.stats[text][playerKey] || 0) + delta);
    if (next === 0) delete this.stats[text][playerKey];
    else this.stats[text][playerKey] = next;
    if (Object.keys(this.stats[text]).length === 0) delete this.stats[text];
    this.statNames[playerKey] = name;
    await this.ctx.storage.put("stats", this.stats);
    await this.ctx.storage.put("statNames", this.statNames);
  }

  broadcast(extra) {
    const sockets = this.ctx.getWebSockets();
    const online = new Set(
      sockets
        .map((ws) => (ws.deserializeAttachment() || {}).playerId)
        .filter(Boolean),
    );
    const payload = JSON.stringify({
      type: "state",
      items: this.items,
      players: this.players,
      online: [...online],
      season: this.season,
      winners: this.winners,
      votes: this.votes,
      stats: this.stats,
      statNames: this.statNames,
      ...(extra || {}),
    });
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // ignore broken sockets
      }
    }
  }
}
