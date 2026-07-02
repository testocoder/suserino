/* Querfrage – Spiellogik (Pass-and-Play, Zustandsmaschine).
   Phasen: setup → answer → answersReveal → discussion → vote → resolution → score */

import FRAGENLISTE from "../data/fragenliste.js";
import { $, el, renderInto, randInt, pick, shuffle, pickIndices, loadLocal, saveLocal, loadSession, saveSession, clearSession } from "./util.js";
import { showScreen, toast, CountdownTimer, keepScreenAwake, armBackGuard, disarmBackGuard, renderSettingsForm } from "./ui.js";
import { createPlayerEditor, createCategoryPicker, createCustomManager } from "./setup.js";
import { renderVerbalVote, createAppVote, renderScoreTable, playReveal } from "./game-shared.js";

const SETTINGS_KEY = "querfrage.settings";
const STATE_KEY = "querfrage.state";
const MAX_ANSWER = 40;

/* ---------------- Einstellungen ---------------- */

const DEFAULT_SETTINGS = {
  imposterCount: 1,
  imposterKnows: false,
  showQuestion: false,     // an = Casual-Modus ohne letzte Chance
  discussionTimer: 120,
  voteMode: "verbal",
  scoring: true,
  rounds: 5,
  spicy: false,
  categories: null,
};

const settings = { ...DEFAULT_SETTINGS, ...loadLocal(SETTINGS_KEY, {}) };
const saveSettings = () => saveLocal(SETTINGS_KEY, settings);

const SETTINGS_SCHEMA = [
  { key: "imposterCount", label: "Anzahl Imposter", type: "select",
    options: [[1, "1"], [2, "2"], [3, "3"], ["random", "Zufällig 🎲"]] },
  { key: "imposterKnows", label: "Imposter weiß Bescheid", type: "toggle",
    desc: "Aus = er beantwortet seine Frage völlig ahnungslos" },
  { key: "showQuestion", label: "Frage nach Antwortrunde zeigen", type: "toggle",
    desc: "An = lockerer Modus, dafür ohne letzte Chance" },
  { key: "discussionTimer", label: "Diskussions-Timer", type: "select",
    options: [[0, "aus"], [60, "1 min"], [120, "2 min"], [180, "3 min"]] },
  { key: "voteMode", label: "Abstimmung", type: "select",
    options: [["verbal", "Mündlich"], ["app", "In der App"]] },
  { key: "scoring", label: "Punktesystem", type: "toggle" },
  { key: "rounds", label: "Rundenzahl", type: "select",
    options: [[3, "3"], [5, "5"], [10, "10"], [0, "Endlos"]] },
  { key: "spicy", label: "Spicy-Modus (18+)", type: "toggle", desc: "Schaltet die Kategorie „Spicy“ frei" },
];

/* ---------------- Eigene Fragen ---------------- */

let customManager = null;

const CUSTOM_CONFIG = {
  storageKey: "querfrage.customCategories",
  itemNoun: "Fragenpaar",
  minEntries: 5,
  fields: [
    { key: "frageA", label: "Frage A (Crew)", required: true, maxlength: 120 },
    { key: "frageB", label: "Frage B (Imposter)", required: true, maxlength: 120 },
  ],
  parseLine(line) {
    const i = line.indexOf(";");
    if (i < 1) return null;
    const a = line.slice(0, i).trim().slice(0, 120);
    const b = line.slice(i + 1).trim().slice(0, 120);
    return a && b ? { frageA: a, frageB: b } : null;
  },
  itemToText: (item) => [item.frageA, item.frageB],
  itemKey: (item) => `${item.frageA.toLowerCase()}|${item.frageB.toLowerCase()}`,
  reservedNames: () => FRAGENLISTE.kategorien.map((k) => k.name),
  importPlaceholder: "Wie viele Tassen Kaffee trinkst du am Tag?; Wie oft warst du letzte Woche beim Sport?",
  importHelp: "Ein Paar pro Zeile: „Frage A; Frage B“ – beide Fragen sind Pflicht, Trenner ist das Semikolon.",
  aiPrompt: `Erstelle mir 30 Fragenpaare für das Partyspiel „Querfrage“ zum Thema [THEMA].
Jedes Paar besteht aus zwei unterschiedlichen Fragen, die aber zum gleichen Antworttyp führen (z. B. beide eine kleine Zahl, beide ein Gericht, beide ein Name).
Die Antworten auf beide Fragen sollen sich ähneln können, damit die abweichende Frage nicht sofort auffällt.
Format: ein Paar pro Zeile, getrennt durch Semikolon, keine Nummerierung, keine Erklärungen.`,
};

/* ---------------- Kategorien & Fragen-Pool ---------------- */

function allCategories() {
  const standard = FRAGENLISTE.kategorien.map((k) => ({ name: k.name, fsk18: !!k.fsk18, custom: false }));
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

function buildPool() {
  const chosen = new Set(selectedCategoryNames());
  const pool = [];
  for (const cat of FRAGENLISTE.kategorien) {
    if (!chosen.has(cat.name)) continue;
    for (const p of cat.paare) {
      pool.push({ frageA: p.frageA, frageB: p.frageB, kategorie: cat.name, antwortTyp: cat.antwortTyp || "text" });
    }
  }
  for (const cat of customManager?.categories || []) {
    if (!chosen.has(cat.name)) continue;
    for (const item of cat.items) {
      pool.push({ frageA: item.frageA, frageB: item.frageB, kategorie: cat.name, antwortTyp: "text" });
    }
  }
  return pool;
}

const pairKey = (entry) => `${entry.frageA}|${entry.frageB}`;

/* ---------------- Spielzustand ---------------- */

let G = null;
let appVote = null;
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

/* ---------------- Setup ---------------- */

let rerenderCategories = null;

function initSetup() {
  playerEditor = createPlayerEditor($("#player-editor"), { minPlayers: 4 });

  renderSettingsForm($("#settings-form"), SETTINGS_SCHEMA, settings, () => {
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
  if (players.length < 4) { toast("Mindestens 4 Spieler eintragen"); return; }
  if (selectedCategoryNames().length === 0) { toast("Mindestens eine Kategorie wählen"); return; }
  if (buildPool().length === 0) { alert("Die gewählten Kategorien enthalten keine Fragen."); return; }

  for (const cat of customManager.categories) {
    if (selectedCategoryNames().includes(cat.name) && cat.items.length < 5) {
      toast(`„${cat.name}“ hat nur ${cat.items.length} Fragenpaare – Wiederholungen möglich`);
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

  const pool = buildPool();
  let fresh = pool.filter((entry) => !G.usedKeys.includes(pairKey(entry)));
  if (fresh.length === 0) {
    G.usedKeys = [];
    fresh = pool;
    toast("Alle Fragen gespielt – Liste wurde zurückgesetzt");
  }
  const entry = pick(fresh);
  G.usedKeys.push(pairKey(entry));

  // Zufällig tauschen, welche Frage die Crew-Frage ist
  const swap = randInt(2) === 1;
  const crewFrage = swap ? entry.frageB : entry.frageA;
  const impFrage = swap ? entry.frageA : entry.frageB;

  G.round = {
    crewFrage,
    impFrage,
    kategorie: entry.kategorie,
    antwortTyp: entry.antwortTyp,
    imposters: pickIndices(n, count),
    alive: [...Array(n).keys()],
    found: [],
    answerIdx: 0,
    answers: G.players.map(() => ""),
    answerOrder: shuffle([...Array(n).keys()]),
    noElim: 0,
    lastVoted: null,
    deltas: G.players.map(() => 0),
    outcome: null,
    questionGuessed: false,
  };
  G.appVote = null;
  setPhase("answer");
  showPass();
}

/* ---------------- Phase 1: Frage & Antwort (ein Screen) ---------------- */

function showPass() {
  const idx = G.round.answerIdx;
  $("#pass-eyebrow").textContent = "Gib das Handy an";
  $("#pass-name").textContent = G.players[idx];
  renderInto($("#answer-area"),
    el("p", { class: "hint-text" }, "Nur du darfst gleich auf den Bildschirm schauen. Tippe unten, wenn du dran bist."),
  );
  $("#pass-show").classList.remove("hidden");
  const doneBtn = $("#answer-done");
  doneBtn.classList.add("hidden");
  doneBtn.disabled = true;
  showScreen("s-pass");
}

function showAnswerInput() {
  const idx = G.round.answerIdx;
  const imp = isImposter(idx);
  const frage = imp ? G.round.impFrage : G.round.crewFrage;
  const doneBtn = $("#answer-done");
  $("#pass-show").classList.add("hidden");
  doneBtn.classList.remove("hidden");
  doneBtn.disabled = true;
  let currentAnswer = "";

  $("#pass-eyebrow").textContent = G.players[idx];

  const area = $("#answer-area");
  const question = el("h2", { class: "question" }, frage);
  const extra = el("p", { class: "hint-text" },
    imp && G.settings.imposterKnows ? "Psst: Du hast eine andere Frage als die anderen!" : "Antworte ehrlich – niemand außer dir sieht diesen Screen.");
  const inputWrap = el("div", {});
  $("#pass-name").textContent = "";
  renderInto(area, question, extra, inputWrap);

  if (G.round.antwortTyp === "spieler") {
    let buttons = [];
    renderInto(inputWrap,
      el("p", { class: "small muted" }, "Wähle eine Person aus der Runde:"),
      el("div", { class: "choice-list" },
        buttons = G.players.map((name, pIdx) =>
          el("button", {
            class: "choice", type: "button",
            onclick: (ev) => {
              currentAnswer = name;
              doneBtn.disabled = false;
              buttons.forEach((b) => b.classList.remove("selected"));
              ev.currentTarget.classList.add("selected");
            },
          }, name)
        )
      ),
    );
  } else {
    const input = el("input", {
      class: "input",
      maxlength: String(MAX_ANSWER),
      autocomplete: "off",
      autocapitalize: "sentences",
      spellcheck: "false",
      inputmode: G.round.antwortTyp === "zahl" ? "decimal" : "text",
      placeholder: "Deine Antwort …",
      "aria-label": "Deine Antwort",
      oninput: (ev) => {
        currentAnswer = ev.target.value.trim().slice(0, MAX_ANSWER);
        doneBtn.disabled = currentAnswer.length === 0;
      },
    });
    input.setAttribute("autocorrect", "off");
    renderInto(inputWrap,
      el("div", { class: "field" }, input),
      el("p", { class: "small muted" }, `Max. ${MAX_ANSWER} Zeichen. Emojis erlaubt.`),
    );
    setTimeout(() => input.focus(), 100);
  }

  doneBtn.onclick = () => {
    if (!currentAnswer || doneBtn.disabled) return;
    doneBtn.disabled = true;          // Doppel-Tipp: nicht zwei Spieler weiterspringen
    G.round.answers[idx] = currentAnswer;
    G.round.answerIdx += 1;
    persist();
    if (G.round.answerIdx < G.players.length) {
      showPass();
    } else {
      setPhase("discussion");
      showDiscussion();
    }
  };
}

/* ---------------- Phase 2: Antworten aufdecken ---------------- */

function answerCards() {
  return el("div", { class: "list" },
    G.round.answerOrder.map((idx) =>
      el("div", { class: "answer-card" },
        el("div", { class: "who" }, G.players[idx]),
        el("div", { class: "what" }, G.round.answers[idx]),
      )
    )
  );
}

function answersFold() {
  return el("details", { class: "answers-fold" },
    el("summary", {}, "Alle Antworten ansehen"),
    answerCards(),
  );
}

/* ---------------- Phase 2: Antworten + Diskussion (ein Screen) ---------------- */

let discussionTimer = null;

function showDiscussion() {
  renderInto($("#answers-list"),
    G.settings.showQuestion
      ? el("p", { class: "note" }, `Die Frage der Crew war: „${G.round.crewFrage}“`)
      : el("p", { class: "muted small" }, "Die Frage bleibt geheim. Lasst euch die Antworten erklären – wer kennt die Frage offenbar nicht?"),
    answerCards(),
  );

  const secs = G.settings.discussionTimer;
  const display = $("#discussion-timer");
  discussionTimer?.stop();
  if (secs > 0) {
    display.classList.remove("hidden");
    discussionTimer = new CountdownTimer(display, () => toast("Zeit um – stimmt ab!"));
    discussionTimer.start(secs);
    $("#discussion-pause").classList.remove("hidden");
    $("#discussion-pause").textContent = "Pause";
  } else {
    display.classList.add("hidden");
    $("#discussion-pause").classList.add("hidden");
  }
  showScreen("s-discussion");
}

function startVote() {
  discussionTimer?.stop();
  setPhase("vote");
  if (G.settings.voteMode === "app") {
    appVote = createAppVote(alivePlayers(), alivePlayers());
    G.appVote = snapshotVote();
    persist();
    showVotePass();
  } else {
    G.appVote = null;
    persist();
    renderInto($("#vote-answers"), answersFold());
    renderVerbalVote($("#vote-verbal-list"), {
      players: G.players,
      candidates: alivePlayers(),
      onResult: handleVoteOutcome,
      onBack: () => { setPhase("discussion"); showDiscussion(); },
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
  $("#vote-cast-title").textContent = "Wer hat die andere Frage?";
  $("#vote-cast-label").textContent = `Stimme von ${G.players[voter]}`;
  renderInto($("#vote-cast-answers"), answersFold());
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
    toast("Niemand fliegt raus – diskutiert nochmal!");
    setPhase("discussion");
    showDiscussion();
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
        if (G.settings.showQuestion) endRound("crew");
        else showLastChance();
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
          onclick: () => { setPhase("discussion"); showDiscussion(); },
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
    el("p", { class: "muted" }, "Jetzt darf er raten, wie die Frage der Crew lautete – sinngemäß reicht. Die Gruppe entscheidet."),
  );
  renderInto($("#resolution-actions"),
    el("p", { class: "eyebrow" }, "Hat er die Crew-Frage erraten?"),
    el("button", { class: "btn btn-primary", type: "button", onclick: () => { G.round.questionGuessed = true; endRound("crew"); } }, "Ja, erraten"),
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
        r.deltas[i] = isImposter(i) ? (r.questionGuessed ? 2 : 0) : 2;
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
  const isLast = G.settings.rounds > 0 && G.roundNo >= G.settings.rounds;

  $("#score-label").textContent = `Runde ${G.roundNo}${G.settings.rounds ? ` von ${G.settings.rounds}` : ""}`;
  $("#score-title").textContent = r.outcome === "crew" ? "Die Crew gewinnt!" : "Die Imposter gewinnen!";

  renderInto($("#score-summary"),
    reason ? el("p", { class: "note" }, reason) : null,
    el("div", { class: "card" },
      el("p", { class: "mb0" }, el("span", { class: "muted" }, "Crew-Frage: "), el("strong", {}, r.crewFrage)),
      el("p", { class: "mb0" }, el("span", { class: "muted" }, "Imposter-Frage: "), el("strong", {}, r.impFrage)),
      el("p", { class: "mb0" },
        el("span", { class: "muted" }, r.imposters.length > 1 ? "Imposter waren: " : "Imposter war: "),
        el("strong", {}, r.imposters.map((i) => G.players[i]).join(", ")),
        r.questionGuessed ? el("span", { class: "muted" }, " · Frage erraten (+2)") : null,
      ),
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
    case "answer":
      showPass();
      break;
    case "answersReveal":    // alte Speicherstände
    case "discussion":
      G.phase = "discussion";
      showDiscussion();
      break;
    case "vote":
      if (G.appVote) {
        appVote = Object.assign(createAppVote([], []), G.appVote);
        if (appVote.done) finishAppVote();
        else showVotePass();
      } else {
        renderInto($("#vote-answers"), answersFold());
        renderVerbalVote($("#vote-verbal-list"), {
          players: G.players, candidates: alivePlayers(), onResult: handleVoteOutcome,
          onBack: () => { setPhase("discussion"); showDiscussion(); },
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

  $("#pass-show").addEventListener("click", showAnswerInput);
  $("#discussion-pause").addEventListener("click", (ev) => {
    if (discussionTimer) ev.target.textContent = discussionTimer.toggle() ? "Pause" : "Weiter";
  });
  $("#discussion-vote").addEventListener("click", startVote);
  $("#vote-pass-go").addEventListener("click", showVoteCast);
  $("#score-next").addEventListener("click", nextRound);
  $("#score-end").addEventListener("click", showFinal);
  $("#final-again").addEventListener("click", () => showScreen("s-setup"));

  // Laufende Runde automatisch fortsetzen (neutraler Screen, nie eine fremde Frage)
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
