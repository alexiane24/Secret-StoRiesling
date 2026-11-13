// Secret StoRiesling Small party game server. No deps, just Node 18+.
// Answers never leave the server, so players cannot cheat with devtools.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "game.json");
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 60);

// ---------- state ----------

function freshState() {
  return {
    phase: "inscription", // inscription -> jeu -> revelation
    settings: { mode: "direct", retryMin: 60, cooldownSec: 15 },
    players: {}, // token -> player
    order: [], // secret ids, shuffled at start
  };
}

let state = freshState();
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
} catch {
  /* first run */
}
// upgrade data saved by an older version
state.settings.retryMin ??= 60;
for (const p of Object.values(state.players))
  for (const [sid, g] of Object.entries(p.guesses))
    if (!g.tries) p.guesses[sid] = { tries: [{ name: g.name, correct: g.correct, at: g.at }] };

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state), () => {});
  }, 300);
}

const rid = (n) => crypto.randomBytes(n).toString("hex");
const norm = (s) => s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const players = () => Object.values(state.players);
const byName = (name) => players().find((p) => norm(p.name) === norm(name));
const bySecret = (sid) => players().find((p) => p.secretId === sid);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// direct mode: every wrong try costs 1 point
// blind mode: only the last answer per secret counts
const isBlind = () => state.settings.mode === "aveugle";
const solved = (g) => !!g && g.tries.length > 0 && (isBlind() ? g.tries.at(-1).correct : g.tries.some((t) => t.correct));
const wrongNames = (g) => (isBlind() ? g.tries.slice(-1) : g.tries).filter((t) => !t.correct).map((t) => t.name);

function stats(p) {
  let found = 0, errors = 0, answered = 0;
  for (const g of Object.values(p.guesses)) {
    if (!g.tries.length) continue;
    answered++;
    if (solved(g)) found++;
    errors += wrongNames(g).length;
  }
  return { points: found - errors, found, errors, answered };
}

const fmtWait = (ms) => {
  const m = Math.ceil(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? String(m % 60).padStart(2, "0") : ""}` : `${m} min`;
};

function board(full) {
  return players()
    .map((p) => {
      const s = stats(p);
      const lastOk = Object.values(p.guesses)
        .flatMap((g) => g.tries.filter((t) => t.correct))
        .reduce((m, t) => Math.max(m, t.at), 0);
      return { name: p.name, ...s, lastOk, full };
    })
    .sort((a, b) =>
      full
        ? b.points - a.points || b.found - a.found || a.lastOk - b.lastOk
        : b.answered - a.answered || a.name.localeCompare(b.name)
    )
    .map(({ lastOk, full: f, ...r }) => (f ? r : { name: r.name, answered: r.answered }));
}

// ---------- public view for one player ----------

function viewFor(p) {
  const st = state.settings;
  const showResults = st.mode === "direct" || state.phase === "revelation";
  const out = {
    phase: state.phase,
    settings: st,
    count: players().length,
    names: players().map((x) => x.name).sort((a, b) => a.localeCompare(b, "fr")),
  };

  if (p) {
    const s = stats(p);
    const wait = Math.max(0, p.lastGuessAt + st.cooldownSec * 1000 - Date.now());
    out.me = {
      name: p.name,
      secret: p.secret,
      code: p.code,
      secretId: p.secretId,
      ...(showResults ? s : { answered: s.answered }),
      cooldownMs: wait,
      guesses: Object.fromEntries(
        Object.entries(p.guesses).map(([sid, g]) => {
          const last = g.tries.at(-1);
          if (!showResults) return [sid, { last: last.name }];
          const ok = solved(g);
          const retryMs = ok || isBlind() ? 0 : Math.max(0, last.at + st.retryMin * 60000 - Date.now());
          return [sid, { solved: ok, wrong: wrongNames(g), last: last.name, lastCorrect: last.correct, retryMs }];
        })
      ),
    };
  }

  if (state.phase !== "inscription") {
    out.secrets = state.order.map((sid, i) => {
      const owner = bySecret(sid);
      const item = { id: sid, n: i + 1, text: owner ? owner.secret : "(secret retiré)" };
      if (state.phase === "revelation" && owner) {
        item.owner = owner.name;
        item.foundBy = players().filter((x) => solved(x.guesses[sid])).length;
      }
      return item;
    });
    out.board = board(showResults);
  }
  return out;
}

// ---------- tiny helpers ----------

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
const fail = (res, msg, code = 400) => send(res, code, { error: msg });

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// basic brute force guard on login and admin password
const attempts = new Map();
function tooMany(key, max = 8, windowMs = 60000) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(key, list);
  return list.length > max;
}

function clean(s, max) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------- routes ----------

async function api(req, res, url) {
  const token = req.headers["x-token"];
  const me = token ? state.players[token] : null;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;

  if (req.method === "GET" && url === "/api/state") return send(res, 200, viewFor(me));

  if (req.method !== "POST") return fail(res, "Méthode non gérée", 405);
  const body = await readBody(req);

  // join: name + secret, only before the game starts
  if (url === "/api/join") {
    if (state.phase !== "inscription") return fail(res, "La partie a déjà commencé, les inscriptions sont fermées.");
    if (players().length >= MAX_PLAYERS) return fail(res, "La partie est complète.");
    const name = clean(body.name, 30);
    const secret = clean(body.secret, 280);
    if (name.length < 2) return fail(res, "Écris ton prénom (2 lettres minimum).");
    if (secret.length < 5) return fail(res, "Ton secret est un peu court.");
    if (byName(name)) return fail(res, "Ce prénom est déjà pris. Ajoute l'initiale de ton nom (ex. Léa M.).");
    const t = rid(24);
    state.players[t] = {
      id: rid(6),
      name,
      secret,
      secretId: rid(6),
      code: crypto.randomInt(100000, 999999).toString(),
      guesses: {},
      lastGuessAt: 0,
    };
    save();
    return send(res, 200, { token: t });
  }

  // login back on a new phone with name + 6 digit code
  if (url === "/api/login") {
    if (tooMany("login:" + ip)) return fail(res, "Trop d'essais. Réessaie dans une minute.", 429);
    const p = byName(clean(body.name, 30));
    if (!p || p.code !== clean(body.code, 6)) return fail(res, "Prénom ou code incorrect.");
    const t = Object.keys(state.players).find((k) => state.players[k] === p);
    return send(res, 200, { token: t });
  }

  if (url === "/api/secret") {
    if (!me) return fail(res, "Session inconnue.", 401);
    if (state.phase !== "inscription") return fail(res, "Les secrets sont verrouillés.");
    const secret = clean(body.secret, 280);
    if (secret.length < 5) return fail(res, "Ton secret est un peu court.");
    me.secret = secret;
    save();
    return send(res, 200, viewFor(me));
  }

  if (url === "/api/guess") {
    if (!me) return fail(res, "Session inconnue.", 401);
    if (state.phase !== "jeu") return fail(res, "Ce n'est pas le moment de deviner.");
    const st = state.settings;
    const sid = String(body.secretId || "");
    const owner = bySecret(sid);
    if (!owner || !state.order.includes(sid)) return fail(res, "Secret introuvable.");
    if (owner === me) return fail(res, "C'est ton propre secret.");
    const guessed = byName(clean(body.name, 30));
    if (!guessed) return fail(res, "Choisis un prénom dans la liste.");
    if (guessed === me) return fail(res, "Tu ne peux pas te choisir toi même.");
    const g = me.guesses[sid] || { tries: [] };
    const last = g.tries.at(-1);
    if (isBlind()) {
      if (last && last.name === guessed.name) return fail(res, "C'est déjà ta réponse.");
    } else {
      if (solved(g)) return fail(res, "Tu as déjà trouvé ce secret.");
      const retry = last ? last.at + st.retryMin * 60000 - Date.now() : 0;
      if (retry > 0) return fail(res, `Nouvel essai possible pour ce secret dans ${fmtWait(retry)}.`, 429);
      if (g.tries.some((t) => t.name === guessed.name)) return fail(res, "Tu as déjà essayé ce prénom pour ce secret.");
    }
    const wait = me.lastGuessAt + st.cooldownSec * 1000 - Date.now();
    if (wait > 0) return fail(res, `Attends encore ${Math.ceil(wait / 1000)} s avant ta prochaine réponse.`, 429);

    const attempt = { name: guessed.name, correct: guessed === owner, at: Date.now() };
    // blind mode keeps only the current answer
    g.tries = isBlind() ? [attempt] : [...g.tries, attempt];
    me.guesses[sid] = g;
    me.lastGuessAt = Date.now();
    save();
    return send(res, 200, viewFor(me));
  }

  // ---------- admin ----------
  if (url.startsWith("/api/admin/")) {
    if (tooMany("admin:" + ip, 120)) return fail(res, "Trop de requêtes.", 429);
    if (body.password !== ADMIN_PASSWORD) {
      tooMany("adminbad:" + ip, 5) && (await new Promise((r) => setTimeout(r, 2000)));
      return fail(res, "Mot de passe incorrect.", 403);
    }
    const action = url.slice("/api/admin/".length);

    if (action === "start") {
      if (state.phase !== "inscription") return fail(res, "La partie est déjà lancée.");
      if (players().length < 3) return fail(res, "Il faut au moins 3 joueurs.");
      const mode = body.mode === "aveugle" ? "aveugle" : "direct";
      const num = (v, d, max) => (Number.isFinite(Number(v)) && v !== "" ? Math.max(0, Math.min(max, Number(v))) : d);
      const retryMin = num(body.retryMin, 60, 1440);
      const cooldownSec = num(body.cooldownSec, 15, 600);
      state.settings = { mode, retryMin, cooldownSec };
      state.order = shuffle(players().map((p) => p.secretId));
      state.phase = "jeu";
    } else if (action === "reveal") {
      if (state.phase !== "jeu") return fail(res, "Lance la partie d'abord.");
      state.phase = "revelation";
    } else if (action === "kick") {
      const t = Object.keys(state.players).find((k) => state.players[k].id === body.id);
      if (!t) return fail(res, "Joueur introuvable.");
      if (state.phase !== "inscription") return fail(res, "On ne retire personne pendant la partie.");
      delete state.players[t];
    } else if (action === "reset") {
      state = freshState();
    } else if (action !== "state") {
      return fail(res, "Action inconnue.", 404);
    }
    save();
    // admin sees who joined, never who wrote which secret before the reveal
    return send(res, 200, {
      phase: state.phase,
      settings: state.settings,
      players: players().map((p) => ({ id: p.id, name: p.name, ...stats(p) })),
    });
  }

  return fail(res, "Route inconnue.", 404);
}

// ---------- static files ----------

// index.html can sit in public/ or next to server.js (easier from a phone)
const INDEX = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public", "index.html")
  : path.join(__dirname, "index.html");

http
  .createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    try {
      if (url.startsWith("/api/")) return await api(req, res, url);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(INDEX).pipe(res);
    } catch (e) {
      console.error(e);
      fail(res, "Erreur serveur.", 500);
    }
  })
  .listen(PORT, () => {
    console.log(`Secret StoRiesling sur http://localhost:${PORT}`);
    if (ADMIN_PASSWORD === "changeme") console.log("Pense à définir ADMIN_PASSWORD !");
  });
