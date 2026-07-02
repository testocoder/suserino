/* Spielübergreifende Bausteine: Abstimmung, Punktetabelle, Auflösung. */

import { el, renderInto, shuffle } from "./util.js";

/* ---------- Abstimmung ----------
   Mündlich: Gruppe zeigt auf jemanden, Ergebnis wird angetippt.
   In der App: Handy geht reihum, jeder stimmt geheim ab (inkl. Stichwahl). */

export function renderVerbalVote(container, { players, candidates, onResult, onBack }) {
  let locked = false;
  const choose = (idx) => {
    if (locked) return;               // Doppel-Tipp abfangen
    locked = true;
    container.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    onResult(idx);
  };
  renderInto(container,
    el("p", { class: "muted" }, "Zählt gemeinsam auf 3 und zeigt gleichzeitig auf euren Verdächtigen. Wer hat die meisten Finger auf sich?"),
    el("div", { class: "choice-list" },
      candidates.map((idx) =>
        el("button", { class: "choice", type: "button", onclick: () => choose(idx) }, players[idx])
      ),
      el("button", { class: "choice", type: "button", onclick: () => choose(null) },
        el("span", {}, "Unentschieden / niemand"),
      ),
    ),
    onBack ? el("button", { class: "btn-quiet", type: "button", onclick: () => { if (!locked) onBack(); } }, "← Zurück") : null,
  );
}

/**
 * App-Abstimmung als Zustandsobjekt. Das Spiel rendert die Screens
 * (Weitergeben + geheime Wahl), die Logik inkl. Stichwahl steckt hier.
 * voters/candidates: Spieler-Indizes.
 */
export function createAppVote(voters, candidates) {
  return {
    voters: shuffle(voters),
    candidates,
    votes: {},            // voterIdx -> candidateIdx
    step: 0,
    runoff: false,

    get currentVoter() { return this.voters[this.step]; },
    get done() { return this.step >= this.voters.length; },

    cast(candidateIdx) {
      this.votes[this.currentVoter] = candidateIdx;
      this.step += 1;
    },

    /** Ergebnis: { chosen } oder { tie: [indizes] } */
    evaluate() {
      const counts = new Map(this.candidates.map((c) => [c, 0]));
      for (const v of Object.values(this.votes)) counts.set(v, (counts.get(v) || 0) + 1);
      const max = Math.max(...counts.values());
      const leaders = [...counts.entries()].filter(([, n]) => n === max).map(([c]) => c);
      if (leaders.length === 1) return { chosen: leaders[0] };
      return { tie: leaders };
    },

    /** Stichwahl zwischen den Führenden starten. Rückgabe false = schon Stichwahl gewesen. */
    startRunoff(leaders) {
      if (this.runoff) return false;
      this.runoff = true;
      this.candidates = leaders;
      this.votes = {};
      this.step = 0;
      this.voters = shuffle(this.voters);
      return true;
    },
  };
}

/* ---------- Punktetabelle ---------- */

export function renderScoreTable(container, { players, scores, deltas, highlightTop }) {
  const order = players
    .map((name, idx) => ({ name, idx, score: scores[idx] || 0 }))
    .sort((a, b) => b.score - a.score);
  const top = order.length ? order[0].score : 0;

  renderInto(container,
    el("table", { class: "score-table" },
      el("tbody", {},
        order.map((entry, rank) =>
          el("tr", { class: highlightTop && entry.score === top && top > 0 ? "winner" : "" },
            el("td", { class: "muted" }, `${rank + 1}.`),
            el("td", {},
              entry.name,
              deltas && deltas[entry.idx] ? el("span", { class: "delta" }, ` +${deltas[entry.idx]}`) : null,
            ),
            el("td", {}, String(entry.score)),
          )
        )
      )
    )
  );
}

/* ---------- Dramaturgische Auflösung ----------
   „{Name} war …“ → Pause → „… der IMPOSTER!“ / „… unschuldig!“
   afterReveal wird nach der Enthüllung gerufen (z. B. Buttons zeigen). */

export function playReveal(container, { name, isImpostor, afterReveal }) {
  const verdict = el("div", {
    class: `verdict ${isImpostor ? "impostor" : "innocent"}`,
    "aria-live": "polite",
  }, isImpostor ? "… der IMPOSTER!" : "… unschuldig!");

  renderInto(container,
    el("p", { class: "eyebrow" }, "Auflösung"),
    el("div", { class: "big-name" }, `${name} war …`),
    el("div", { class: "reveal-result" }, verdict),
  );

  setTimeout(() => {
    verdict.classList.add("show");
    setTimeout(() => afterReveal?.(), 600);
  }, 1400);
}
