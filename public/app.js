"use strict";

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);

// Storage that never throws (Safari Private Browsing can block localStorage).
const mem = {};
const store = {
  get(k) { try { const v = localStorage.getItem("mb_" + k); return v === null ? (k in mem ? mem[k] : null) : v; } catch { return k in mem ? mem[k] : null; } },
  set(k, v) { mem[k] = v; try { localStorage.setItem("mb_" + k, v); } catch {} },
  del(k) { delete mem[k]; try { localStorage.removeItem("mb_" + k); } catch {} },
};

function fatal(msg) {
  let bar = document.getElementById("fatal-error");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "fatal-error";
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:9999;background:#9a3b2f;color:#fff;padding:.6rem 1rem;font:14px/1.4 sans-serif;text-align:center";
    document.body.appendChild(bar);
  }
  bar.textContent = msg + " — open the browser console for details.";
}
window.addEventListener("error", (e) => { console.error(e.error || e.message); fatal("Something went wrong: " + e.message); });
window.addEventListener("unhandledrejection", (e) => { console.error(e.reason); fatal("Something went wrong."); });

function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = true;
  $("#" + id).hidden = false;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function seasonText(s) { return s ? `${s.term} ${s.year}` : ""; }
function countMarks(marks) { return marks.reduce((n, m) => n + (m ? 1 : 0), 0); }

const STAMPS = ["✓", "●", "★", "◆", "▲", "✕"];

// ---------- state ----------
// Identity is your name (normalized), so the same name gets the same card on
// any device. Must match the server's normalization: trim + lowercase.
function myKey() { return myName.trim().toLowerCase(); }
// Only these names may remove other players.
const ADMINS = new Set(["nick", "lauryn"]);
let token = store.get("token");
const DEFAULT_STAMP_IMG = "/stamps/horton.png";
let myName = store.get("name") || "";
let myStamp = store.get("stamp") || "✓";
// New players default to the image marker. "none" means the player explicitly
// chose a text/emoji stamp instead, so we don't force the image back on them.
const _storedImg = store.get("stampImg");
let myStampImg = _storedImg === null ? DEFAULT_STAMP_IMG : (_storedImg === "none" ? null : _storedImg);
let ws = null;
let lastState = null;
let listDirty = false;
let verifyPid = null;

// =====================================================================
// Password
// =====================================================================
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#login-error");
  errEl.hidden = true;
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: $("#login-password").value }),
    });
    const data = await res.json();
    if (data.ok) { token = data.token; store.set("token", token); gotoNameOrGame(); }
    else { errEl.textContent = "That password didn't work."; errEl.hidden = false; }
  } catch {
    errEl.textContent = "Couldn't reach the server. Try again.";
    errEl.hidden = false;
  }
});

// =====================================================================
// Name + stamp
// =====================================================================
function buildStampPicker() {
  const wrap = $("#stamp-picker");
  wrap.innerHTML = "";

  // The default image marker as the first option.
  const imgBtn = document.createElement("button");
  imgBtn.type = "button";
  imgBtn.className = "stamp-opt-img";
  imgBtn.title = "Default marker";
  const thumb = document.createElement("img");
  thumb.src = DEFAULT_STAMP_IMG; thumb.alt = "default marker";
  imgBtn.appendChild(thumb);
  if (myStampImg === DEFAULT_STAMP_IMG) imgBtn.classList.add("selected");
  imgBtn.addEventListener("click", () => {
    myStampImg = DEFAULT_STAMP_IMG;
    store.set("stampImg", DEFAULT_STAMP_IMG);
    $("#stamp-custom").value = "";
    showStampPreview(DEFAULT_STAMP_IMG);
    for (const el of wrap.children) el.classList.toggle("selected", el === imgBtn);
  });
  wrap.appendChild(imgBtn);

  for (const s of STAMPS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s;
    if (s === myStamp && !myStampImg) b.classList.add("selected");
    b.addEventListener("click", () => {
      myStamp = s; clearStampImg(); $("#stamp-custom").value = "";
      for (const el of wrap.children) el.classList.toggle("selected", el === b);
    });
    wrap.appendChild(b);
  }
  if (myStampImg) showStampPreview(myStampImg); else $("#stamp-img-preview").hidden = true;
}
$("#stamp-custom").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  if (v) { myStamp = v; clearStampImg(); for (const el of $("#stamp-picker").children) el.classList.remove("selected"); }
});
$("#stamp-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const url = await fileToStamp(file);
    myStampImg = url; store.set("stampImg", url); showStampPreview(url);
    for (const el of $("#stamp-picker").children) el.classList.remove("selected");
  } catch (err) { alert("Couldn't use that image: " + err.message); }
  finally { e.target.value = ""; }
});
$("#stamp-img-clear").addEventListener("click", clearStampImg);
function clearStampImg() { myStampImg = null; store.set("stampImg", "none"); $("#stamp-img-preview").hidden = true; }
function showStampPreview(url) { $("#stamp-img-thumb").src = url; $("#stamp-img-preview").hidden = false; }
// Resize to a small data URL. Always exports PNG so transparency (e.g. a
// cut-out subject) is preserved — shrinking the dimensions to fit the size
// budget rather than falling back to JPEG, which would fill transparent
// pixels with black.
function fileToStamp(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("could not read file"));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("not a valid image"));
      img.onload = () => {
        let out = null;
        for (const max of [120, 100, 84, 68, 52]) {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          out = c.toDataURL("image/png");
          if (out.length <= 80000) break;
        }
        if (!out || out.length > 88000) {
          reject(new Error("image is too detailed — try a simpler one"));
          return;
        }
        resolve(out);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
$("#name-form").addEventListener("submit", (e) => {
  e.preventDefault();
  myName = $("#name-input").value.trim() || "Player";
  store.set("name", myName); store.set("stamp", myStamp);
  if (myStampImg) store.set("stampImg", myStampImg); else store.set("stampImg", "none");
  startGame();
});
$("#btn-edit-name").addEventListener("click", () => {
  $("#name-input").value = myName; $("#stamp-custom").value = "";
  buildStampPicker(); showScreen("screen-name");
});

// ---------- routing on load ----------
function gotoNameOrGame() {
  if (myName) startGame();
  else { buildStampPicker(); $("#name-input").value = myName; showScreen("screen-name"); }
}
if (token) gotoNameOrGame();
else showScreen("screen-login");

// =====================================================================
// Connection
// =====================================================================
function startGame() {
  showScreen("screen-game");
  $("#me-label").textContent = myName;
  connect();
}
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) { sendJoin(); return; }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.addEventListener("open", () => { setConn("ok", "connected"); sendJoin(); });
  ws.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "state") { lastState = msg; render(msg); if (msg.bingoBy) announceBingo(msg.bingoBy); }
  });
  ws.addEventListener("close", (ev) => {
    setConn("bad", "reconnecting");
    if (ev.code === 1008 || ev.code === 1011) { store.del("token"); token = null; showScreen("screen-login"); return; }
    setTimeout(connect, 1500);
  });
  ws.addEventListener("error", () => setConn("bad", "offline"));
}
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function sendJoin() { send({ type: "join", name: myName, stamp: myStamp, stampImg: myStampImg }); }
function setConn(cls, text) {
  const el = $("#conn"); el.className = "conn " + cls;
  el.querySelector("span").textContent = text;
}

// ---------- game controls ----------
$("#btn-new-card").addEventListener("click", () => { if (confirm("Deal yourself a fresh card? Your marks will be cleared.")) send({ type: "newCard" }); });
$("#btn-clear").addEventListener("click", () => { if (confirm("Clear all your marks?")) send({ type: "clearMarks" }); });
$("#settings-toggle").addEventListener("click", () => {
  const open = $("#settings").hidden;
  $("#settings").hidden = !open;
  $("#settings-toggle").setAttribute("aria-expanded", String(open));
  if (open && lastState) fillListEditor(lastState.items);
});
$("#btn-save-list").addEventListener("click", () => {
  const items = $("#list-text").value.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!items.length) { alert("Add at least one item."); return; }
  listDirty = false; send({ type: "updateList", items });
});
$("#btn-reset-list").addEventListener("click", () => { if (confirm("Reset the list to the default phrases?")) send({ type: "resetItems" }); });
$("#btn-reshuffle").addEventListener("click", () => { if (confirm("Deal new cards to everyone? All marks are cleared for all players.")) send({ type: "reshuffleAll" }); });
$("#list-text").addEventListener("input", () => { listDirty = true; });
function fillListEditor(items) { const ta = $("#list-text"); if (document.activeElement === ta || listDirty) return; ta.value = items.join("\n"); }

// =====================================================================
// Render
// =====================================================================
function makeStampEl(player) {
  if (player.stampImg) { const i = document.createElement("img"); i.className = "stamp-img"; i.src = player.stampImg; i.alt = ""; return i; }
  const s = document.createElement("span"); s.className = "stamp-emoji"; s.textContent = player.stamp || "✓"; s.style.color = player.color; return s;
}
function buildCardInto(container, player, interactive) {
  container.innerHTML = "";
  for (let i = 0; i < 25; i++) {
    const isFree = i === 12, marked = player.marks[i];
    const cell = document.createElement("div");
    cell.className = "cell" + (isFree ? " free" : "") + (marked && !isFree ? " marked" : "");
    if (marked && !isFree) cell.appendChild(makeStampEl(player));
    const t = document.createElement("span"); t.className = "cell-text"; t.textContent = player.card[i] || "";
    cell.appendChild(t);
    if (interactive && !isFree) cell.addEventListener("click", () => send({ type: "toggle", index: i }));
    container.appendChild(cell);
  }
}

function render(state) {
  $("#season-label").textContent = seasonText(state.season) + " game";
  const me = state.players[myKey()];
  const grid = $("#card");
  if (me) { $("#my-bingo").hidden = !me.bingo; buildCardInto(grid, me, true); }
  else grid.innerHTML = "<p class='muted'>Joining…</p>";

  renderPlayers(state);
  renderOdds(state);
  renderWinners(state);
  if (verifyPid) renderVerify();
  if (!$("#settings").hidden) fillListEditor(state.items);
}

// ---------- live odds ----------
// The 12 winning lines (rows, columns, diagonals).
const ODDS_LINES = (() => {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => r * 5 + c));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => r * 5 + c));
  lines.push([0, 6, 12, 18, 24]);
  lines.push([4, 8, 12, 16, 20]);
  return lines;
})();

// Implied win odds from board state: a line needing fewer squares is weighted
// exponentially higher, and having several near-complete lines adds up. Scores
// are normalized across players so they read like market prices.
function computeOdds(state) {
  const scored = Object.entries(state.players).map(([key, p]) => {
    let best = 5, score = 0;
    for (const line of ODDS_LINES) {
      let marked = 0;
      for (const i of line) if (p.marks[i]) marked++;
      const remaining = 5 - marked;
      if (remaining < best) best = remaining;
      score += Math.pow(4, -remaining);
    }
    return { key, p, best, score };
  });
  const total = scored.reduce((s, x) => s + x.score, 0) || 1;
  for (const x of scored) x.pct = x.score / total;
  scored.sort((a, b) => b.pct - a.pct);
  return scored;
}

function renderOdds(state) {
  const box = $("#odds");
  const scored = computeOdds(state);
  if (!scored.length) { box.innerHTML = "<p class='wempty'>No players yet.</p>"; return; }
  box.innerHTML = "";
  for (const x of scored) {
    const pct = Math.round(x.pct * 100);
    const sub = x.best === 0 ? "has bingo" : `${x.best} square${x.best === 1 ? "" : "s"} from a line`;
    const row = document.createElement("div");
    row.className = "odds-row";
    row.innerHTML =
      `<div class="odds-top"><span class="odds-name"><span class="swatch" style="background:${x.p.color}"></span>${escapeHtml(x.p.name)}</span><span class="odds-pct">${pct}%</span></div>` +
      `<div class="odds-bar"><i style="width:${Math.max(2, pct)}%"></i></div>` +
      `<div class="odds-sub">${sub}</div>`;
    row.addEventListener("click", () => openVerify(x.key));
    box.appendChild(row);
  }
}

function renderPlayers(state) {
  const online = new Set(state.online || []);
  const winnerName = winnerFor(state, state.season);
  const entries = Object.entries(state.players);
  $("#player-count").textContent = entries.length ? `${entries.length} in` : "";
  entries.sort((a, b) => {
    const oa = online.has(a[0]) ? 0 : 1, ob = online.has(b[0]) ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return countMarks(b[1].marks) - countMarks(a[1].marks);
  });
  const box = $("#players"); box.innerHTML = "";
  for (const [pid, p] of entries) {
    const isOnline = online.has(pid), isMe = pid === myKey();
    const row = document.createElement("div");
    row.className = "player" + (isOnline ? "" : " offline");

    const left = document.createElement("div");
    left.innerHTML =
      `<div class="pname"><span class="swatch" style="background:${p.color}"></span>${escapeHtml(p.name)}` +
      (isMe ? '<span class="tag">you</span>' : "") +
      (p.bingo ? '<span class="winflag">bingo</span>' : "") +
      (p.name === winnerName ? '<span class="winflag">winner</span>' : "") +
      `</div><div class="pmeta">${countMarks(p.marks) - 1}/24 marked${isOnline ? "" : " · offline"}</div>`;

    const mini = document.createElement("div"); mini.className = "mini";
    for (let i = 0; i < 25; i++) { const c = document.createElement("i"); if (p.marks[i]) c.style.background = i === 12 ? "#c9c3b6" : p.color; mini.appendChild(c); }

    row.appendChild(left); row.appendChild(mini);
    row.addEventListener("click", () => openVerify(pid));
    box.appendChild(row);
  }
  if (!entries.length) box.innerHTML = "<p class='wempty'>No one has joined yet.</p>";
}

function winnerFor(state, season) {
  const w = (state.winners || []).find((x) => x.term === season.term && x.year === season.year);
  return w ? w.name : null;
}

function renderWinners(state) {
  const box = $("#winners");
  const cur = state.season;
  const curWinner = winnerFor(state, cur);
  const past = (state.winners || [])
    .filter((w) => !(w.term === cur.term && w.year === cur.year))
    .sort((a, b) => b.year - a.year || (b.at || 0) - (a.at || 0));

  let html = `<div class="season-now"><span class="s-name">${seasonText(cur)}</span>`;
  html += curWinner ? `<span class="s-win">${escapeHtml(curWinner)}</span>` : `<span class="s-open">in progress</span>`;
  html += `</div>`;
  if (past.length) {
    html += "<ul class='wlist'>";
    for (const w of past) html += `<li><span>${escapeHtml(w.name)}</span><span class="w-season">${seasonText(w)}</span></li>`;
    html += "</ul>";
  } else {
    html += "<p class='wempty'>No past winners recorded yet.</p>";
  }
  box.innerHTML = html;
}

// =====================================================================
// Verify modal
// =====================================================================
function openVerify(pid) { verifyPid = pid; $("#verify-modal").hidden = false; renderVerify(); }
function closeVerify() { verifyPid = null; $("#verify-modal").hidden = true; }
function renderVerify() {
  if (!lastState || !verifyPid) return;
  const p = lastState.players[verifyPid];
  if (!p) { closeVerify(); return; }
  const season = lastState.season;
  $("#verify-title").textContent = p.name + " — card";
  const st = $("#verify-status");
  const count = countMarks(p.marks) - 1;
  if (p.bingo) { st.className = "verify-status ok"; st.textContent = `Has called bingo (${count}/24 marked). Confirm the line below is genuine.`; }
  else { st.className = "verify-status"; st.textContent = `${count}/24 marked — no bingo yet.`; }
  buildCardInto($("#verify-card"), p, false);

  const actions = $("#verify-actions"); actions.innerHTML = "";
  const me = myKey();
  const isSelf = verifyPid === me;
  const declaredWinner = winnerFor(lastState, season);
  const votes = (lastState.votes && lastState.votes[verifyPid]) || [];
  const approverNames = votes.map((k) => (lastState.players[k] && lastState.players[k].name) || k);

  if (p.name === declaredWinner) {
    const tag = document.createElement("p"); tag.className = "verify-status ok"; tag.style.margin = "0";
    tag.textContent = `Declared ${seasonText(season)} winner.`;
    actions.appendChild(tag);
    const undo = document.createElement("button"); undo.className = "link"; undo.textContent = "Undo / reopen voting";
    undo.addEventListener("click", () => { if (confirm("Remove this win and reopen voting for the season?")) send({ type: "clearWinner", season }); });
    actions.appendChild(undo);
  } else if (declaredWinner) {
    const tag = document.createElement("p"); tag.className = "verify-status"; tag.style.margin = "0";
    tag.textContent = `${declaredWinner} is already the declared winner for ${seasonText(season)}.`;
    actions.appendChild(tag);
  } else if (p.bingo) {
    const status = document.createElement("p"); status.className = "vote-status";
    status.textContent = `${votes.length} of 2 approvals` + (approverNames.length ? ` — approved by ${approverNames.join(", ")}` : "");
    actions.appendChild(status);
    if (isSelf) {
      const note = document.createElement("p"); note.className = "hint"; note.style.margin = "0";
      note.textContent = "You can't approve your own win — two others must approve it.";
      actions.appendChild(note);
    } else if (votes.includes(me)) {
      const un = document.createElement("button"); un.className = "btn-outline btn-sm"; un.textContent = "Undo my approval";
      un.addEventListener("click", () => send({ type: "unapproveWinner", playerId: verifyPid }));
      actions.appendChild(un);
    } else {
      const ap = document.createElement("button"); ap.className = "btn btn-sm"; ap.textContent = `Approve ${p.name} as winner`;
      ap.addEventListener("click", () => send({ type: "approveWinner", playerId: verifyPid }));
      actions.appendChild(ap);
    }
  } else {
    const note = document.createElement("p"); note.className = "hint"; note.style.margin = "0";
    note.textContent = "No bingo yet — nothing to approve.";
    actions.appendChild(note);
  }

  // Remove / leave. Only Nick and Lauryn can remove other players.
  if (isSelf) {
    const rm = document.createElement("button"); rm.className = "link link-danger"; rm.textContent = "Leave the game";
    rm.addEventListener("click", () => {
      if (!confirm("Leave the game? Your card and marks will be deleted.")) return;
      send({ type: "removePlayer", playerId: verifyPid }); closeVerify();
      myName = ""; store.del("name"); buildStampPicker(); $("#name-input").value = ""; showScreen("screen-name");
    });
    actions.appendChild(rm);
  } else if (ADMINS.has(me)) {
    const rm = document.createElement("button"); rm.className = "link link-danger"; rm.textContent = "Remove this player";
    rm.addEventListener("click", () => {
      if (!confirm(`Remove ${p.name} from the game? Their card and marks will be deleted.`)) return;
      send({ type: "removePlayer", playerId: verifyPid }); closeVerify();
    });
    actions.appendChild(rm);
  }
}
$("#verify-close").addEventListener("click", closeVerify);
$("#verify-modal").addEventListener("click", (e) => { if (e.target.id === "verify-modal") closeVerify(); });

// =====================================================================
// New game modal
// =====================================================================
$("#btn-new-game").addEventListener("click", () => {
  const s = (lastState && lastState.season) || {};
  if (s.term) $("#newgame-term").value = s.term;
  $("#newgame-year").value = s.year || new Date().getFullYear();
  $("#newgame-modal").hidden = false;
});
$("#newgame-close").addEventListener("click", () => { $("#newgame-modal").hidden = true; });
$("#newgame-modal").addEventListener("click", (e) => { if (e.target.id === "newgame-modal") $("#newgame-modal").hidden = true; });
$("#newgame-confirm").addEventListener("click", () => {
  const season = { term: $("#newgame-term").value, year: Number($("#newgame-year").value) };
  if (!confirm(`Start the ${seasonText(season)} game? Everyone gets a new card and all marks are cleared.`)) return;
  send({ type: "newGame", season });
  $("#newgame-modal").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeVerify(); $("#newgame-modal").hidden = true; $("#import-modal").hidden = true; }
});

// =====================================================================
// Enter / import your own card
// =====================================================================
const FREE_INDEX = 12;
$("#btn-import-card").addEventListener("click", openImport);
$("#import-close").addEventListener("click", () => { $("#import-modal").hidden = true; });
$("#import-modal").addEventListener("click", (e) => { if (e.target.id === "import-modal") $("#import-modal").hidden = true; });
$("#import-fill").addEventListener("click", () => {
  const lines = $("#import-paste-text").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const inputs = [...$("#import-grid").querySelectorAll("textarea")];
  let li = 0;
  for (let i = 0; i < 25; i++) { if (i === FREE_INDEX) continue; inputs[i].value = lines[li++] || ""; }
});
$("#import-save").addEventListener("click", () => {
  const inputs = [...$("#import-grid").querySelectorAll("textarea")];
  const card = inputs.map((t, i) => (i === FREE_INDEX ? "FREE" : t.value.trim()));
  const filled = card.filter((s, i) => i !== FREE_INDEX && s).length;
  if (filled < 24 && !confirm(`Only ${filled} of 24 squares are filled. Save anyway? Blank squares will show a dash.`)) return;
  send({ type: "setCard", card });
  $("#import-modal").hidden = true;
});
function openImport() {
  const me = lastState && lastState.players[myKey()];
  const grid = $("#import-grid");
  grid.innerHTML = "";
  for (let i = 0; i < 25; i++) {
    const ta = document.createElement("textarea");
    ta.rows = 2;
    if (i === FREE_INDEX) { ta.value = "FREE"; ta.disabled = true; }
    else ta.value = me && me.card[i] && me.card[i] !== "FREE" ? me.card[i] : "";
    grid.appendChild(ta);
  }
  $("#import-paste-text").value = "";
  $("#import-modal").hidden = false;
}

// =====================================================================
// Bingo announcement (no confetti, just a quiet notice)
// =====================================================================
let announceTimer = null;
function announceBingo(pid) {
  if (!lastState) return;
  const p = lastState.players[pid]; if (!p) return;
  const el = $("#announce");
  el.textContent = `${p.name} called bingo. Select their name to verify the card.`;
  el.hidden = false;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { el.hidden = true; }, 12000);
}
