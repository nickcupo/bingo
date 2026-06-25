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

// Canonical keys that never count toward stats.
const STAT_SKIP = new Set(["", "free", "add more items"]);

// Pretty display label: fold whitespace, curly quotes, and the many Unicode
// hyphen/dash variants; trim; strip a single pair of surrounding quotes. Keeps
// the original casing for display.
function displayItem(s) {
  return String(s || "")
    .normalize("NFC")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"(.+)"$/, "$1")
    .replace(/^'(.+)'$/, "$1")
    .trim();
}

// Canonical grouping key for a stats row. Aggressively folds case and ALL
// punctuation/symbols so calls that differ only by quotes, hyphen style, spacing,
// or stray punctuation collapse into one row — e.g. these all key the same:
//   'Low-hanging fruit" or "Quick win', 'Low‑hanging fruit…', 'Low hanging fruit…'
function canonicalKey(s) {
  return displayItem(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Pick the nicer display label for a merged row: prefer one that has a capital
// letter (e.g. "Synergy" over "synergy"); otherwise keep what we have.
function preferLabel(current, candidate) {
  if (!current) return candidate;
  if (/[A-Z]/.test(candidate) && !/[A-Z]/.test(current)) return candidate;
  return current;
}

// One-time migration: regroup existing stats by the canonical key so duplicate
// rows (quote / hyphen / spacing / punctuation / case variants of the same call)
// merge into one. `labels` carries the existing pretty display text so the merged
// row keeps a nice label. For this first game a person can have marked a box at
// most once, so each present person counts as 1. Returns { stats, labels }.
export function mergeStats(stats, labels = {}) {
  const out = {}, outLabels = {};
  for (const [oldKey, byPlayer] of Object.entries(stats || {})) {
    const key = canonicalKey(oldKey);
    if (STAT_SKIP.has(key)) continue;
    if (!out[key]) out[key] = {};
    outLabels[key] = preferLabel(outLabels[key], displayItem(labels[oldKey] || oldKey));
    for (const [pk, n] of Object.entries(byPlayer)) {
      if (n > 0) out[key][pk] = 1;
    }
  }
  return { stats: out, labels: outLabels };
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
      // statLabels: { normalizedKey: prettyDisplayText } for the stats table.
      this.statLabels = (await this.ctx.storage.get("statLabels")) || {};
      // contests: { targetKey: { index: [contesterKey, ...] } } for the current game.
      this.contests = (await this.ctx.storage.get("contests")) || {};
      // nudges: { targetKey: { index: [nudgerKey, ...] } } — unmarked squares others
      // think the owner should mark.
      this.nudges = (await this.ctx.storage.get("nudges")) || {};
      // One-time fix: merge duplicate stat rows (quote / hyphen / spacing /
      // punctuation / case variants of the same call) into one canonical row.
      if (!(await this.ctx.storage.get("statsMergeV2"))) {
        const merged = mergeStats(this.stats, this.statLabels);
        this.stats = merged.stats;
        this.statLabels = merged.labels;
        await this.ctx.storage.put("stats", this.stats);
        await this.ctx.storage.put("statLabels", this.statLabels);
        await this.ctx.storage.put("statsMergeV2", true);
      }
    });
  }

  async fetch(request) {
    // Roster: the list of current player names, for the returning-player picker.
    if (new URL(request.url).pathname === "/api/roster") {
      const names = [...new Set(Object.values(this.players).map((p) => p.name))]
        .sort((a, b) => a.localeCompare(b));
      return new Response(JSON.stringify({ names }), {
        headers: { "content-type": "application/json" },
      });
    }
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
        // An unmarked square can't be contested; drop any contests on it.
        if (!player.marks[i] && this.clearContest(pid, i)) {
          await this.ctx.storage.put("contests", this.contests);
        }
        // Marking clears any nudge on that square.
        if (player.marks[i] && this.clearNudge(pid, i)) {
          await this.ctx.storage.put("nudges", this.nudges);
        }
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
        await this.dropContests(pid);
        await this.dropNudges(pid);
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
        await this.dropContests(pid);
        await this.dropNudges(pid);
        return this.broadcast();
      }

      case "clearMarks": {
        const player = this.players[pid];
        if (!player) return;
        player.marks = freshMarks();
        player.bingo = false;
        await this.persistPlayers();
        await this.dropContests(pid);
        await this.dropNudges(pid);
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
          if (this.contests[target]) { delete this.contests[target]; await this.ctx.storage.put("contests", this.contests); }
          if (this.nudges[target]) { delete this.nudges[target]; await this.ctx.storage.put("nudges", this.nudges); }
          await this.persistPlayers();
        }
        return this.broadcast();
      }

      // Start a new game for a quarter: set the season and deal fresh cards.
      // Admin-only — this clears everyone's cards and marks.
      case "newGame": {
        const season = cleanSeason(msg.season);
        if (!season || !ADMINS.has(pid)) return;
        this.season = season;
        this.votes = {};
        this.contests = {};
        this.nudges = {};
        for (const p of Object.values(this.players)) {
          p.card = makeCard(this.items);
          p.marks = freshMarks();
          p.bingo = false;
        }
        await this.ctx.storage.put("season", this.season);
        await this.ctx.storage.put("votes", this.votes);
        await this.ctx.storage.put("contests", this.contests);
        await this.ctx.storage.put("nudges", this.nudges);
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

      // Remove a declared winner and reopen voting for that season. Admin-only.
      case "clearWinner": {
        const season = cleanSeason(msg.season);
        if (!season || !ADMINS.has(pid)) return;
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

      // Contest a specific marked square on someone else's board (dispute that
      // it was really called). Toggles the sender's contest on that square.
      case "contest": {
        const target = String(msg.playerId || "");
        const i = Number(msg.index);
        const tp = this.players[target];
        if (!tp || !pid || target === pid) return;        // can't contest your own board
        if (!Number.isInteger(i) || i < 0 || i > 24 || i === 12) return;
        if (!tp.marks[i]) return;                          // only a marked square can be contested
        const key = String(i);
        if (!this.contests[target]) this.contests[target] = {};
        const list = this.contests[target][key] || [];
        const at = list.indexOf(pid);
        if (at >= 0) list.splice(at, 1); else list.push(pid);
        if (list.length) this.contests[target][key] = list;
        else this.clearContest(target, i);
        if (this.contests[target] && Object.keys(this.contests[target]).length === 0) delete this.contests[target];
        await this.ctx.storage.put("contests", this.contests);
        return this.broadcast();
      }

      // Nudge an unmarked square on someone else's board (suggest they missed
      // a call). Toggles the sender's nudge on that square.
      case "nudge": {
        const target = String(msg.playerId || "");
        const i = Number(msg.index);
        const tp = this.players[target];
        if (!tp || !pid || target === pid) return;
        if (!Number.isInteger(i) || i < 0 || i > 24 || i === 12) return;
        if (tp.marks[i]) return;
        const key = String(i);
        if (!this.nudges[target]) this.nudges[target] = {};
        const list = this.nudges[target][key] || [];
        const at = list.indexOf(pid);
        if (at >= 0) list.splice(at, 1);
        else list.push(pid);
        if (list.length) this.nudges[target][key] = list;
        else this.clearNudge(target, i);
        if (this.nudges[target] && Object.keys(this.nudges[target]).length === 0) delete this.nudges[target];
        await this.ctx.storage.put("nudges", this.nudges);
        return this.broadcast(at >= 0 ? null : { nudgeBy: pid, nudgeTarget: target, nudgeIndex: i });
      }

      // Dismiss a nudge on your own card without marking it.
      case "dismissNudge": {
        const i = Number(msg.index);
        if (!pid || !Number.isInteger(i) || i < 0 || i > 24 || i === 12) return;
        if (this.clearNudge(pid, i)) await this.ctx.storage.put("nudges", this.nudges);
        return this.broadcast();
      }

      // Resolve a contest. Only the card's owner or an admin may decide.
      // uphold=true un-marks the disputed square; either way the contest clears.
      case "resolveContest": {
        const target = String(msg.playerId || "");
        const i = Number(msg.index);
        const tp = this.players[target];
        if (!tp || !pid) return;
        if (pid !== target && !ADMINS.has(pid)) return;
        if (!Number.isInteger(i) || i < 0 || i > 24 || i === 12) return;
        if (msg.uphold && tp.marks[i]) {
          tp.marks[i] = false;
          tp.bingo = hasBingo(tp.marks);
          await this.persistPlayers();
          await this.recordStat(tp.card[i], target, tp.name, -1);
        }
        if (this.clearContest(target, i)) await this.ctx.storage.put("contests", this.contests);
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

  // Remove contests on a single square. Returns true if something was removed.
  clearContest(targetKey, index) {
    const bucket = this.contests[targetKey];
    if (!bucket || !(String(index) in bucket)) return false;
    delete bucket[String(index)];
    if (Object.keys(bucket).length === 0) delete this.contests[targetKey];
    return true;
  }

  // Drop all contests on a player's board (their card/marks reset).
  async dropContests(targetKey) {
    if (this.contests[targetKey]) {
      delete this.contests[targetKey];
      await this.ctx.storage.put("contests", this.contests);
    }
  }

  clearNudge(targetKey, index) {
    const bucket = this.nudges[targetKey];
    if (!bucket || !(String(index) in bucket)) return false;
    delete bucket[String(index)];
    if (Object.keys(bucket).length === 0) delete this.nudges[targetKey];
    return true;
  }

  async dropNudges(targetKey) {
    if (this.nudges[targetKey]) {
      delete this.nudges[targetKey];
      await this.ctx.storage.put("nudges", this.nudges);
    }
  }

  // Adjust the lifetime count of how often `playerKey` has marked `item`.
  // delta is +1 (marked) or -1 (un-marked, e.g. a misclick correction).
  async recordStat(item, playerKey, name, delta) {
    const key = canonicalKey(item);
    if (STAT_SKIP.has(key)) return;
    const label = displayItem(item);
    if (!this.stats[key]) this.stats[key] = {};
    const next = Math.max(0, (this.stats[key][playerKey] || 0) + delta);
    if (next === 0) delete this.stats[key][playerKey];
    else this.stats[key][playerKey] = next;
    if (Object.keys(this.stats[key]).length === 0) { delete this.stats[key]; delete this.statLabels[key]; }
    else this.statLabels[key] = preferLabel(this.statLabels[key], label);
    this.statNames[playerKey] = name;
    await this.ctx.storage.put("stats", this.stats);
    await this.ctx.storage.put("statLabels", this.statLabels);
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
      statLabels: this.statLabels,
      contests: this.contests,
      nudges: this.nudges,
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
