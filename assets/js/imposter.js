/* Imposter – Spiellogik (Pass-and-Play, Zustandsmaschine).
   Phasen: setup → reveal → hints → discussion → vote → resolution → score */

import WORTLISTE from "../data/wortliste.js";
import { $, el, renderInto, randInt, pick, shuffle, pickIndices, loadLocal, saveLocal, loadSession, saveSession, clearSession } from "./util.js";
import { showScreen, toast, bindHold, CountdownTimer, keepScreenAwake, armBackGuard, disarmBackGuard, renderSettingsForm } from "./ui.js";
import { createPlayerEditor, createCategoryPicker, createCustomManager } from "./setup.js";
import { renderVerbalVote, createAppVote, renderScoreTable, playReveal } from "./game-shared.js";

const SETTINGS_KEY = "imposter.settings";
const STATE_KEY = "imposter.state";

/* ---------------- Einstellungen ---------------- */

const DEFAULT_SETTINGS = {
  variante: "B",
  imposterKnows: false,
  showCategory: true,
  imposterCount: 1,        // Zahl oder "random"
  hintRounds: 2,
  discussionTimer: 120,    // Sekunden, 0 = aus
  voteMode: "verbal",
  scoring: true,
  rounds: 5,               // 0 = endlos
  spicy: false,
  categories: null,        // null = Standard (alle außer 18+)
};

const settings = { ...DEFAULT_SETTINGS, ...loadLocal(SETTINGS_KEY, {}) };
const saveSettings = () => saveLocal(SETTINGS_KEY, settings);

const SETTINGS_SCHEMA = [
  { key: "variante", label: "Variante", type: "select", desc: "B: Imposter bekommt ein ähnliches Wort",
    options: [["A", "A: Kein Hinweis"], ["B", "B: Hinweiswort"]] },
  { key: "imposterKnows", label: "Imposter weiß Bescheid", type: "toggle",
    desc: "Aus = er ahnt nichts und kann sich selbst verraten", visible: (s) => s.variante === "B" },
  { key: "showCategory", label: "Kategorie zeigen", type: "toggle",
    desc: "Der Imposter sieht die Kategorie als Hinweis", visible: (s) => s.variante === "A" },
  { key: "imposterCount", label: "Anzahl Imposter", type: "select",
    options: [[1, "1"], [2, "2"], [3, "3"], ["random", "Zufällig 🎲"]] },
  { key: "hintRounds", label: "Hinweisrunden", type: "select", options: [[1, "1"], [2, "2"], [3, "3"]] },
  { key: "discussionTimer", label: "Runden-Timer", type: "select",
    options: [[0, "aus"], [60, "1 min"], [120, "2 min"], [180, "3 min"]] },
  { key: "voteMode", label: "Abstimmung", type: "select",
    options: [["verbal", "Mündlich"], ["app", "In der App"]] },
  { key: "scoring", label: "Punktesystem", type: "toggle" },
  { key: "rounds", label: "Rundenzahl", type: "select",
    options: [[3, "3"], [5, "5"], [10, "10"], [0, "Endlos"]] },
  { key: "spicy", label: "Spicy-Modus (18+)", type: "toggle", desc: "Schaltet die Kategorie „Spicy“ frei" },
];

/* ---------------- Eigene Wörter ---------------- */

let customManager = null;

const CUSTOM_CONFIG = {
  storageKey: "imposter.customCategories",
  itemNoun: "Wortpaar",
  minEntries: 5,
  fields: [
    { key: "wort", label: "Wort", required: true, maxlength: 40 },
    { key: "hinweis", label: "Hinweiswort", required: false, maxlength: 40 },
  ],
  parseLine(line) {
    let a = line, b = "";
    for (const sep of [";", ",", " - "]) {
      const i = line.indexOf(sep);
      if (i > -1) { a = line.slice(0, i); b = line.slice(i + sep.length); break; }
    }
    a = a.trim().slice(0, 40);
    b = b.trim().slice(0, 40);
    return a ? { wort: a, hinweis: b } : null;
  },
  itemToText: (item) => [item.wort, item.hinweis || ""],
  itemKey: (item) => `${item.wort.toLowerCase()}|${(item.hinweis || "").toLowerCase()}`,
  reservedNames: () => WORTLISTE.kategorien.map((k) => k.name),
  importPlaceholder: "Kaffee; Tee\nPizza; Flammkuchen\nHandtuch",
  importHelp: "Ein Eintrag pro Zeile: „Wort“ oder „Wort; Hinweiswort“ (auch Komma oder „ - “ als Trenner).",
  aiPrompt: `Erstelle mir 50 Wortpaare für das Partyspiel „Imposter“ zum Thema [THEMA].
Jedes Paar besteht aus einem geheimen Wort und einem ähnlichen, aber klar unterscheidbaren Hinweiswort (z. B. „Kaffee; Tee“).
Die Wörter sollen allgemein bekannt sein und sich gut mündlich umschreiben lassen.
Format: ein Paar pro Zeile, getrennt durch Semikolon, keine Nummerierung, keine weiteren Erklärungen.`,
};

/* ---------------- Kategorien & Wort-Pool ---------------- */

function allCategories() {
  const standard = WORTLISTE.kategorien.map((k) => ({ name: k.name, fsk18: !!k.fsk18, custom: false }));
  const custom = (customManager?.categories || []).map((c) => ({ name: c.name, fsk18: false, custom: true }));
  return [...standard, ...custom];
}

function defaultSelection() {
  return allCategories().filter((c) => !c.fsk18).map((c) => c.name);
}

function selectedCategoryNames() {
  const names = settings.categories ?? defaultSelection();
  const visible = new Set(allCategories().filter((c) => !c.fsk18 || settings.spicy).map((c) => c.name));
  return names.filter((n) => visible.has(n));
}

/** Alle spielbaren Paare der gewählten Kategorien. Variante B braucht ein Hinweiswort. */
function buildPool() {
  const chosen = new Set(selectedCategoryNames());
  const pool = [];
  let skippedNoHint = 0;

  for (const cat of WORTLISTE.kategorien) {
    if (!chosen.has(cat.name)) continue;
    for (const p of cat.paare) pool.push({ wort: p.wort, hinweis: p.hinweis, kategorie: cat.name });
  }
  for (const cat of customManager?.categories || []) {
    if (!chosen.has(cat.name)) continue;
    for (const item of cat.items) {
      if (settings.variante === "B" && !item.hinweis) { skippedNoHint++; continue; }
      pool.push({ wort: item.wort, hinweis: item.hinweis || "", kategorie: cat.name });
    }
  }
  return { pool, skippedNoHint };
}

const pairKey = (entry) => `${entry.wort}|${entry.hinweis}`;

/* ---------------- Spielzustand ---------------- */

let G = null;          // laufendes Spiel (wird in sessionStorage gespiegelt)
let appVote = null;    // aktive App-Abstimmung (aus G.appVote rehydriert)
let playerEditor = null;

const persist = () => {
  if (G) saveSession(STATE_KEY, G);
  else clearSession(STATE_KEY);
};

function setPhase(phase) {
  G.phase = phase;
  persist();
}

function alivePlayers() { return G.round.alive; }
const isImposter = (idx) => G.round.imposters.includes(idx);

/* ---------------- Setup-Screen ---------------- */

let rerenderSettings = null;
let rerenderCategories = null;

function initSetup() {
  playerEditor = createPlayerEditor($("#player-editor"), { minPlayers: 3 });

  rerenderSettings = renderSettingsForm($("#settings-form"), SETTINGS_SCHEMA, settings, () => {
    saveSettings();
    rerenderCategories?.();
  });

  rerenderCategories = createCategoryPicker($("#category-picker"), {
    getCategories: allCategories,
    getSpicy: () => settings.spicy,
    getSelected: selectedCategoryNames,
    setSelected: (names) => { settings.categories = names; saveSettings(); },
  });

  customManager = createCustomManager(CUSTOM_CONFIG, {
    listContainer: $("#custom-list"),
    editContainer: $("#custom-edit"),
    showList: () => showScreen("s-custom-list"),
    showEdit: () => showScreen("s-custom-edit"),
    onDataChanged: () => rerenderCategories?.(),
  });

  $("#open-custom").addEventListener("click", () => customManager.openList());
  $("#custom-back").addEventListener("click", () => showScreen("s-setup"));
  $("#custom-edit-back").addEventListener("click", () => customManager.openList());
  $("#setup-start").addEventListener("click", startGame);
}

function startGame() {
  const players = playerEditor.players;
  if (players.length < 3) { toast("Mindestens 3 Spieler eintragen"); return; }
  if (selectedCategoryNames().length === 0) { toast("Mindestens eine Kategorie wählen"); return; }

  const { pool, skippedNoHint } = buildPool();
  if (pool.length === 0) {
    alert(skippedNoHint > 0
      ? `${skippedNoHint} Wörter haben kein Hinweiswort – für Variante B ergänzen oder Variante A spielen.`
      : "Die gewählten Kategorien enthalten keine Wörter.");
    return;
  }
  if (skippedNoHint > 0) toast(`${skippedNoHint} Wörter ohne Hinweiswort übersprungen`);

  for (const cat of customManager.categories) {
    if (selectedCategoryNames().includes(cat.name) && cat.items.length < 5) {
      toast(`„${cat.name}“ hat nur ${cat.items.length} Wörter – Wiederholungen möglich`);
      break;
    }
  }

  G = {
    phase: "setup",
    players,
    settings: { ...settings, categories: selectedCategoryNames() },
    scores: players.map(() => 0),
    roundNo: 1,
    usedKeys: [],
    round: null,
    appVote: null,
  };
  keepScreenAwake(true);
  armBackGuard(abortToSetup);
  startRound();
}

function abortToSetup() {
  G = null;
  appVote = null;
  persist();
  keepScreenAwake(false);
  disarmBackGuard();
  showScreen("s-setup");
}

/* ---------------- Rundenstart ---------------- */

function startRound() {
  const n = G.players.length;
  const maxImposters = Math.max(1, Math.floor((n - 1) / 2));
  const wanted = G.settings.imposterCount;
  const count = wanted === "random" ? 1 + randInt(maxImposters) : Math.min(Number(wanted) || 1, maxImposters);

  const { pool } = buildPool();
  let fresh = pool.filter((entry) => !G.usedKeys.includes(pairKey(entry)));
  if (fresh.length === 0) {
    G.usedKeys = [];
    fresh = pool;
    toast("Alle Wörter gespielt – Liste wurde zurückgesetzt");
  }
  const entry = pick(fresh);
  G.usedKeys.push(pairKey(entry));

  // Variante B: zufällig tauschen, welches Wort Crew bzw. Imposter bekommt
  let wort = entry.wort;
  let hinweis = entry.hinweis;
  if (G.settings.variante === "B" && hinweis && randInt(2) === 1) [wort, hinweis] = [hinweis, wort];

  G.round = {
    wort,
    hinweis,
    kategorie: entry.kategorie,
    imposters: pickIndices(n, count),
    alive: [...Array(n).keys()],
    found: [],
    revealIdx: 0,
    hintRound: 1,
    extraHint: false,
    starter: randInt(n),
    noElim: 0,
    lastVoted: null,
    deltas: G.players.map(() => 0),
    outcome: null,
    wordGuessed: false,
  };
  G.appVote = null;
  setPhase("reveal");
  showPass();
}

/* ---------------- Phase 1: Rollen verteilen ----------------
   Ein Screen pro Spieler: Name + Halten-zum-Aufdecken + Weitergeben. */

function showPass() {
  const idx = G.round.revealIdx;
  const imp = isImposter(idx);
  const s = G.settings;
  const stage = $("#reveal-stage");
  const nextBtn = $("#reveal-next");
  nextBtn.disabled = true;

  $("#pass-name").textContent = G.players[idx];

  const hidden = () => renderInto(stage,
    el("p", { class: "hint-text" }, "Halte unten „Aufdecken“ gedrückt – nur du schaust hin. Beim Loslassen verschwindet alles sofort."),
  );

  const shown = () => {
    let main, sub, extra = null;
    if (s.variante === "A") {
      if (imp) {
        main = "Du bist der IMPOSTER!";
        sub = s.showCategory ? `Kategorie: ${G.round.kategorie}` : "Hör gut zu und bluffe dich durch!";
      } else {
        main = G.round.wort;
        sub = `Kategorie: ${G.round.kategorie}`;
      }
    } else {
      main = imp ? G.round.hinweis : G.round.wort;
      sub = `Kategorie: ${G.round.kategorie}`;
      if (imp && s.imposterKnows) extra = "Du bist der Imposter!";
    }
    renderInto(stage,
      el("div", { class: "big-word" }, main),
      el("p", { class: "hint-text" }, sub),
      el("p", { class: "hint-text" }, extra ?? " "),
    );
  };

  hidden();

  const holdBtn = $("#reveal-hold");
  const freshBtn = holdBtn.cloneNode(true);   // alte Pointer-Listener entsorgen
  holdBtn.replaceWith(freshBtn);
  bindHold(freshBtn, {
    onShow: shown,
    onHide: hidden,
    onFirstReveal: () => { nextBtn.disabled = false; },
  });

  showScreen("s-pass");
}

function afterReveal() {
  G.round.revealIdx += 1;
  persist();
  if (G.round.revealIdx < G.players.length) {
    showPass();
  } else {
    setPhase("round");
    showRound();
  }
}

/* ---------------- Phase 2: Hinweise + Diskussion (ein Screen) ---------------- */

let roundTimer = null;

function showRound() {
  const r = G.round;
  const hr = G.settings.hintRounds;
  const starterIdx = r.alive[r.starter % r.alive.length];

  $("#round-label").textContent = r.extraHint
    ? "Weiter geht's"
    : `Runde ${G.roundNo}${G.settings.rounds ? ` von ${G.settings.rounds}` : ""}`;
  $("#round-starter").textContent = `${G.players[starterIdx]} beginnt`;
  $("#round-info").textContent = r.extraHint
    ? "Noch eine Hinweisrunde reihum, dann wird erneut abgestimmt."
    : `Reihum sagt jeder einen Begriff zum geheimen Wort – ${hr === 1 ? "eine Runde" : `${hr} Runden`}. Danach frei diskutieren.`;

  const secs = G.settings.discussionTimer;
  const display = $("#round-timer");
  roundTimer?.stop();
  if (secs > 0) {
    display.classList.remove("hidden");
    roundTimer = new CountdownTimer(display, () => toast("Zeit um – stimmt ab!"));
    roundTimer.start(secs);
    $("#round-pause").classList.remove("hidden");
    $("#round-pause").textContent = "Timer pausieren";
  } else {
    display.classList.add("hidden");
    $("#round-pause").classList.add("hidden");
  }
  $("#reshuffle").classList.toggle("hidden", r.extraHint || r.found.length > 0);
  showScreen("s-round");
}


function startVote() {
  roundTimer?.stop();
  if (G.settings.voteMode === "app") {
    appVote = createAppVote(alivePlayers(), alivePlayers());
    G.appVote = snapshotVote();
    setPhase("vote");
    showVotePass();
  } else {
    setPhase("vote");
    G.appVote = null;
    persist();
    renderVerbalVote($("#vote-verbal-list"), {
      players: G.players,
      candidates: alivePlayers(),
      onResult: handleVoteOutcome,
      onBack: () => { setPhase("round"); showRound(); },
    });
    showScreen("s-vote-verbal");
  }
}

const snapshotVote = () => ({
  voters: appVote.voters, candidates: appVote.candidates,
  votes: appVote.votes, step: appVote.step, runoff: appVote.runoff,
});

function showVotePass() {
  $("#vote-pass-label").textContent = appVote.runoff ? "Stichwahl · geheim" : "Geheime Abstimmung";
  $("#vote-pass-name").textContent = G.players[appVote.currentVoter];
  showScreen("s-vote-pass");
}

function showVoteCast() {
  const voter = appVote.currentVoter;
  const options = appVote.candidates.filter((c) => c !== voter);
  $("#vote-cast-title").textContent = "Wer ist der Imposter?";
  $("#vote-cast-label").textContent = `Stimme von ${G.players[voter]}`;
  renderInto($("#vote-cast-list"),
    el("div", { class: "choice-list" },
      options.map((idx) =>
        el("button", {
          class: "choice", type: "button",
          onclick: () => {
            appVote.cast(idx);
            G.appVote = snapshotVote();
            persist();
            if (appVote.done) finishAppVote();
            else showVotePass();
          },
        }, G.players[idx])
      )
    )
  );
  showScreen("s-vote-cast");
}

function finishAppVote() {
  const result = appVote.evaluate();
  if (result.chosen != null) {
    handleVoteOutcome(result.chosen);
  } else if (appVote.startRunoff(result.tie)) {
    toast("Gleichstand – Stichwahl!");
    G.appVote = snapshotVote();
    persist();
    showVotePass();
  } else {
    handleVoteOutcome(null);
  }
}

/* ---------------- Phase 4: Auflösung ---------------- */

function handleVoteOutcome(votedIdx) {
  appVote = null;
  G.appVote = null;

  if (votedIdx == null) {
    G.round.noElim += 1;
    if (G.round.noElim >= 2) {
      endRound("imposter", "Keine Einigung – die Imposter bleiben unentdeckt.");
      return;
    }
    toast("Niemand fliegt raus – eine Zusatzrunde!");
    G.round.extraHint = true;
    setPhase("round");
    showRound();
    return;
  }

  G.round.lastVoted = votedIdx;
  setPhase("resolution");
  showResolution();
}

function showResolution() {
  const votedIdx = G.round.lastVoted;
  const imp = isImposter(votedIdx);
  renderInto($("#resolution-actions"));
  showScreen("s-resolution");

  playReveal($("#resolution-stage"), {
    name: G.players[votedIdx],
    isImpostor: imp,
    afterReveal: () => {
      if (!imp) {
        endRound("imposter", `${G.players[votedIdx]} war unschuldig – die Imposter gewinnen sofort!`);
        return;
      }
      if (!G.round.found.includes(votedIdx)) G.round.found.push(votedIdx);
      G.round.alive = G.round.alive.filter((i) => i !== votedIdx);
      persist();

      const remaining = G.round.imposters.filter((i) => !G.round.found.includes(i));
      if (remaining.length === 0) {
        showLastChance();
        return;
      }
      const crewAlive = G.round.alive.filter((i) => !isImposter(i)).length;
      if (remaining.length >= crewAlive) {
        endRound("imposter", "Die Imposter sind in der Überzahl!");
        return;
      }
      renderInto($("#resolution-actions"),
        el("p", { class: "note" }, "Aber Achtung: Es ist noch mindestens ein Imposter im Spiel!"),
        el("button", {
          class: "btn btn-primary", type: "button",
          onclick: () => {
            G.round.extraHint = true;
            setPhase("round");
            showRound();
          },
        }, "Weiter jagen"),
      );
    },
  });
}

function showLastChance() {
  setPhase("lastChance");
  const impNames = G.round.imposters.map((i) => G.players[i]).join(" & ");
  renderInto($("#resolution-stage"),
    el("p", { class: "eyebrow accent" }, "Letzte Chance"),
    el("div", { class: "big-name" }, impNames),
    el("p", {}, G.round.imposters.length > 1 ? "Alle Imposter wurden gefunden!" : "Der Imposter wurde gefunden!"),
    el("p", { class: "muted" }, "Jetzt darf er das geheime Wort raten – ein Versuch, mündlich. Errät er es, holt er Teilpunkte."),
  );
  renderInto($("#resolution-actions"),
    el("p", { class: "eyebrow" }, "Hat er das Wort erraten?"),
    el("button", { class: "btn btn-primary", type: "button", onclick: () => { G.round.wordGuessed = true; endRound("crew"); } }, "Ja, erraten"),
    el("button", { class: "btn btn-ghost", type: "button", onclick: () => endRound("crew") }, "Nein"),
  );
  showScreen("s-resolution");
}

/* ---------------- Phase 5: Rundenende & Punkte ---------------- */

function endRound(winner, reason = "") {
  const r = G.round;
  r.outcome = winner;

  if (G.settings.scoring) {
    for (let i = 0; i < G.players.length; i++) {
      if (winner === "crew") {
        r.deltas[i] = isImposter(i) ? (r.wordGuessed ? 2 : 0) : 2;
      } else {
        r.deltas[i] = isImposter(i) ? 4 : 0;
      }
      G.scores[i] += r.deltas[i];
    }
  }
  setPhase("score");
  showRoundEnd(reason);
}

function showRoundEnd(reason) {
  const r = G.round;
  const impNames = r.imposters.map((i) => G.players[i]).join(", ");
  const isLast = G.settings.rounds > 0 && G.roundNo >= G.settings.rounds;

  $("#score-label").textContent = `Runde ${G.roundNo}${G.settings.rounds ? ` von ${G.settings.rounds}` : ""}`;
  $("#score-title").textContent = r.outcome === "crew" ? "Die Crew gewinnt!" : "Die Imposter gewinnen!";

  renderInto($("#score-summary"),
    reason ? el("p", { class: "note" }, reason) : null,
    el("div", { class: "card" },
      el("p", { class: "mb0" },
        el("span", { class: "muted" }, "Geheimes Wort: "), el("strong", {}, r.wort),
        G.settings.variante === "B" ? el("span", { class: "muted" }, ` · Imposter-Wort: ${r.hinweis}`) : null,
      ),
      el("p", { class: "mb0" },
        el("span", { class: "muted" }, r.imposters.length > 1 ? "Imposter waren: " : "Imposter war: "),
        el("strong", {}, impNames),
        r.wordGuessed ? el("span", { class: "muted" }, " · Wort erraten (+2)") : null,
      ),
      el("p", { class: "mb0 muted small" }, `Kategorie: ${r.kategorie}`),
    ),
  );

  if (G.settings.scoring) {
    renderScoreTable($("#score-table"), { players: G.players, scores: G.scores, deltas: r.deltas });
  } else {
    renderInto($("#score-table"));
  }

  $("#score-next").textContent = isLast ? "Endstand anzeigen" : "Nächste Runde";
  showScreen("s-score");
}

function nextRound() {
  const isLast = G.settings.rounds > 0 && G.roundNo >= G.settings.rounds;
  if (isLast) { showFinal(); return; }
  G.roundNo += 1;
  startRound();
}

function showFinal() {
  setPhase("final");
  if (G.settings.scoring) {
    const best = Math.max(...G.scores);
    const winners = G.players.filter((_, i) => G.scores[i] === best);
    $("#final-title").textContent = best > 0 ? `${winners.join(" & ")} ${winners.length > 1 ? "gewinnen" : "gewinnt"}!` : "Unentschieden!";
    renderScoreTable($("#final-table"), { players: G.players, scores: G.scores, highlightTop: true });
  } else {
    $("#final-title").textContent = "Danke fürs Spielen!";
    renderInto($("#final-table"));
  }
  keepScreenAwake(false);
  disarmBackGuard();
  showScreen("s-final");
  G = null;
  persist();
}

/* ---------------- Fortsetzen nach Reload ---------------- */

function resumeGame(saved) {
  G = saved;
  keepScreenAwake(true);
  armBackGuard(abortToSetup);

  switch (G.phase) {
    case "reveal":
      showPass();
      break;
    case "hints":        // alte Speicherstände
    case "discussion":
    case "round":
      G.phase = "round";
      showRound();
      break;
    case "vote":
      if (G.appVote) {
        appVote = Object.assign(createAppVote([], []), G.appVote);
        if (appVote.done) finishAppVote();
        else showVotePass();
      } else {
        renderVerbalVote($("#vote-verbal-list"), {
          players: G.players, candidates: alivePlayers(), onResult: handleVoteOutcome,
          onBack: () => { setPhase("round"); showRound(); },
        });
        showScreen("s-vote-verbal");
      }
      break;
    case "resolution":
      showResolution();
      break;
    case "lastChance":
      showLastChance();
      break;
    case "score":
      showRoundEnd("");
      break;
    default:
      abortToSetup();
  }
}

/* ---------------- Init ---------------- */

function init() {
  document.getElementById("boot-note")?.remove();   // JS läuft – Ladehinweis weg
  initSetup();

  $("#reveal-next").addEventListener("click", afterReveal);
  $("#round-vote").addEventListener("click", startVote);
  $("#round-pause").addEventListener("click", (ev) => {
    if (roundTimer) ev.target.textContent = roundTimer.toggle() ? "Timer pausieren" : "Timer fortsetzen";
  });
  $("#reshuffle").addEventListener("click", () => {
    startRound();
    toast("Neu gemischt – Handy wieder rumgeben!");
  });
  $("#vote-pass-go").addEventListener("click", showVoteCast);
  $("#score-next").addEventListener("click", nextRound);
  $("#score-end").addEventListener("click", showFinal);
  $("#final-again").addEventListener("click", () => showScreen("s-setup"));

  // Laufende Runde automatisch fortsetzen (neutraler Screen, nie ein Wort)
  const saved = loadSession(STATE_KEY, null);
  if (saved && saved.players && saved.round && saved.phase !== "setup") {
    resumeGame(saved);
    toast("Laufende Runde fortgesetzt");
  } else {
    clearSession(STATE_KEY);
    showScreen("s-setup");
  }
}

init();
