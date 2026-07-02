/* Gemeinsame Setup-Bausteine: Spielerliste, Kategorienauswahl,
   Verwaltung eigener Inhalte (Wörter/Fragen). */

import { el, renderInto, loadLocal, saveLocal } from "./util.js";
import { toast } from "./ui.js";

export const PLAYERS_KEY = "partyspiele.players";

const removeIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 6l12 12M18 6L6 18");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
};

/* ---------- Spielerliste ---------- */

export function createPlayerEditor(container, { minPlayers, maxPlayers = 20, onChange }) {
  let players = loadLocal(PLAYERS_KEY, []).filter((n) => typeof n === "string").slice(0, maxPlayers);

  const persist = () => {
    saveLocal(PLAYERS_KEY, players);
    onChange?.(players);
  };

  const addPlayer = (name) => {
    const clean = name.trim().slice(0, 24);
    if (!clean) return;
    if (players.some((p) => p.toLowerCase() === clean.toLowerCase())) {
      toast("Name ist schon vergeben");
      return;
    }
    if (players.length >= maxPlayers) {
      toast(`Maximal ${maxPlayers} Spieler`);
      return;
    }
    players.push(clean);
    persist();
    render();
  };

  const render = () => {
    const rows = players.map((name, idx) =>
      el("li", { class: "row" },
        el("input", {
          class: "input grow",
          value: name,
          maxlength: "24",
          "aria-label": `Spieler ${idx + 1}`,
          onchange: (ev) => {
            const clean = ev.target.value.trim().slice(0, 24);
            if (!clean) { ev.target.value = name; return; }
            if (players.some((p, i) => i !== idx && p.toLowerCase() === clean.toLowerCase())) {
              toast("Name ist schon vergeben");
              ev.target.value = name;
              return;
            }
            players[idx] = clean;
            persist();
          },
        }),
        el("button", {
          class: "icon-btn", type: "button", "aria-label": `${name} entfernen`,
          onclick: () => { players.splice(idx, 1); persist(); render(); },
        }, removeIcon()),
      )
    );

    const input = el("input", {
      class: "input grow", placeholder: "Name eingeben …", maxlength: "24",
      autocomplete: "off", enterkeyhint: "done", "aria-label": "Neuer Spieler",
    });
    const submit = () => { addPlayer(input.value); input.value = ""; input.focus(); };
    input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); submit(); } });

    renderInto(container,
      el("ul", { class: "list" }, rows),
      el("div", { class: "row" },
        input,
        el("button", { class: "btn btn-ghost btn-inline", type: "button", "aria-label": "Spieler hinzufügen", onclick: submit }, "+"),
      ),
      el("p", { class: "small muted" },
        players.length < minPlayers ? `Mindestens ${minPlayers} Spieler nötig (aktuell ${players.length}).` : `${players.length} Spieler`),
    );
  };

  render();
  onChange?.(players);
  return { get players() { return players.slice(); } };
}

/* ---------- Kategorienauswahl ----------
   categories: [{name, fsk18?, size}] inkl. eigener Kategorien (custom: true) */

export function createCategoryPicker(container, { getCategories, getSpicy, getSelected, setSelected }) {
  const render = () => {
    const spicyOn = getSpicy();
    const visible = getCategories().filter((cat) => !cat.fsk18 || spicyOn);
    const selected = new Set(getSelected());

    const chips = visible.map((cat) => {
      const isOn = selected.has(cat.name);
      return el("button", {
        class: `chip${isOn ? " selected" : ""}`,
        type: "button",
        "aria-pressed": String(isOn),
        onclick: () => {
          if (isOn) selected.delete(cat.name);
          else selected.add(cat.name);
          setSelected([...selected]);
          render();
        },
      },
        cat.name,
        cat.custom ? el("span", { class: "marker", "aria-label": "eigene Kategorie" }, "✎") : null,
        cat.fsk18 ? el("span", { class: "marker" }, "18+") : null,
      );
    });

    renderInto(container,
      el("div", { class: "chips" }, chips),
      el("div", { class: "row" },
        el("button", {
          class: "btn-quiet", type: "button",
          onclick: () => { setSelected(visible.map((c) => c.name)); render(); },
        }, "Alle"),
        el("button", {
          class: "btn-quiet", type: "button",
          onclick: () => { setSelected([]); render(); },
        }, "Keine"),
        el("span", { class: "spacer" }),
        el("span", { class: "small muted" }, `${[...selected].filter((n) => visible.some((c) => c.name === n)).length} gewählt`),
      ),
    );
  };
  render();
  return render;
}

/* ---------- Eigene Inhalte ----------
   config: {
     storageKey, itemNoun ("Wortpaar"/"Fragenpaar"),
     fields: [{key, label, required, maxlength}],
     parseLine(line) -> item | null,
     itemToText(item) -> [colA, colB],
     itemKey(item) -> string (für Duplikate),
     aiPrompt: string, minEntries
   }
   Screens werden vom Spiel gestellt (listScreen/editScreen mit festen Containern). */

export function createCustomManager(config, { listContainer, editContainer, showList, showEdit, onDataChanged }) {
  let categories = loadLocal(config.storageKey, []);
  if (!Array.isArray(categories)) categories = [];
  categories = categories.filter((cat) => cat && typeof cat.name === "string" && Array.isArray(cat.items));
  let editing = null; // Index der bearbeiteten Kategorie

  const persist = () => {
    if (!saveLocal(config.storageKey, categories)) {
      toast("Speichern nicht möglich – Inhalte gelten nur für diese Sitzung");
    }
    onDataChanged?.();
  };

  const nameTaken = (name, exceptIdx = -1) =>
    categories.some((cat, i) => i !== exceptIdx && cat.name.toLowerCase() === name.toLowerCase()) ||
    config.reservedNames().some((n) => n.toLowerCase() === name.toLowerCase());

  const askName = (current = "") => {
    const raw = prompt("Name der Kategorie:", current);
    if (raw == null) return null;
    const clean = raw.trim().slice(0, 30);
    if (!clean) return null;
    if (nameTaken(clean, editing ?? -1) && clean.toLowerCase() !== current.toLowerCase()) {
      alert("Dieser Name ist schon vergeben.");
      return null;
    }
    return clean;
  };

  /* --- Liste der eigenen Kategorien --- */
  const renderList = () => {
    const rows = categories.map((cat, idx) =>
      el("li", { class: "row" },
        el("button", {
          class: "btn-quiet grow text-left", type: "button",
          onclick: () => { editing = idx; renderEdit(); showEdit(); },
        },
          el("strong", {}, cat.name),
          el("span", { class: "muted" }, ` · ${cat.items.length} ${config.itemNoun}${cat.items.length === 1 ? "" : "e"}`),
        ),
        el("button", {
          class: "icon-btn", type: "button", "aria-label": `${cat.name} löschen`,
          onclick: () => {
            if (confirm(`Kategorie „${cat.name}“ löschen?`)) {
              categories.splice(idx, 1);
              persist();
              renderList();
            }
          },
        }, removeIcon()),
      )
    );

    renderInto(listContainer,
      categories.length
        ? el("ul", { class: "list" }, rows)
        : el("p", { class: "muted" }, "Noch keine eigenen Kategorien. Perfekt für Insider aus eurer Gruppe!"),
      el("button", {
        class: "btn btn-ghost", type: "button",
        onclick: () => {
          editing = null;
          const name = askName();
          if (name == null) return;
          categories.push({ name, items: [] });
          editing = categories.length - 1;
          persist();
          renderEdit();
          showEdit();
        },
      }, "+ Neue Kategorie"),
    );
  };

  /* --- Bearbeiten einer Kategorie --- */
  const renderEdit = () => {
    const cat = categories[editing];
    if (!cat) { showList(); return; }

    const itemRows = cat.items.map((item, idx) => {
      const [a, b] = config.itemToText(item);
      return el("li", { class: "row" },
        el("div", { class: "grow" },
          el("div", {}, a),
          b ? el("div", { class: "small muted" }, b) : null,
        ),
        el("button", {
          class: "icon-btn", type: "button", "aria-label": "Eintrag löschen",
          onclick: () => { cat.items.splice(idx, 1); persist(); renderEdit(); },
        }, removeIcon()),
      );
    });

    /* Einzeleingabe */
    const inputs = config.fields.map((f) =>
      el("input", {
        class: "input", placeholder: f.label + (f.required ? "" : " (optional)"),
        maxlength: String(f.maxlength), autocomplete: "off",
      })
    );
    const addSingle = () => {
      const item = {};
      for (let i = 0; i < config.fields.length; i++) {
        const val = inputs[i].value.trim().slice(0, config.fields[i].maxlength);
        if (config.fields[i].required && !val) { toast(`„${config.fields[i].label}“ fehlt`); return; }
        item[config.fields[i].key] = val;
      }
      if (cat.items.some((existing) => config.itemKey(existing) === config.itemKey(item))) {
        toast("Eintrag gibt es schon");
        return;
      }
      cat.items.push(item);
      inputs.forEach((inp) => { inp.value = ""; });
      inputs[0].focus();
      persist();
      renderEdit();
    };

    /* Listen-Import */
    const textarea = el("textarea", {
      class: "textarea", rows: "6",
      placeholder: config.importPlaceholder,
      "aria-label": "Liste importieren",
    });
    const previewBox = el("div", {});
    let parsed = [];

    const runPreview = () => {
      const lines = textarea.value.split("\n").map((l) => l.trim());
      parsed = [];
      const rows = [];
      for (const line of lines) {
        if (!line) continue;
        const item = config.parseLine(line);
        const dup = item && (cat.items.some((x) => config.itemKey(x) === config.itemKey(item)) ||
                             parsed.some((x) => config.itemKey(x) === config.itemKey(item)));
        if (item && !dup) parsed.push(item);
        const [a, b] = item ? config.itemToText(item) : [line, ""];
        rows.push(el("tr", { class: item && !dup ? "" : "bad" },
          el("td", {}, a), el("td", {}, item ? (b || "–") : "nicht erkannt"),
        ));
      }
      renderInto(previewBox,
        rows.length ? el("table", { class: "preview-table" }, el("tbody", {}, rows)) : null,
        el("p", { class: "small muted" }, `${parsed.length} neue Einträge erkannt.`),
        el("button", {
          class: "btn btn-primary", type: "button", disabled: parsed.length === 0,
          onclick: () => {
            cat.items.push(...parsed);
            textarea.value = "";
            renderInto(previewBox);
            persist();
            renderEdit();
            toast(`${parsed.length} Einträge importiert`);
          },
        }, "Importieren"),
      );
    };

    renderInto(editContainer,
      el("div", { class: "row", style: null },
        el("h2", { class: "grow mb0" }, cat.name),
        el("button", {
          class: "btn-quiet", type: "button",
          onclick: () => {
            const name = askName(cat.name);
            if (name != null) { cat.name = name; persist(); renderEdit(); }
          },
        }, "Umbenennen"),
      ),
      cat.items.length < config.minEntries
        ? el("p", { class: "note" }, `Tipp: Mindestens ${config.minEntries} Einträge, sonst wiederholen sich die Runden schnell.`)
        : null,

      el("h3", {}, "Einzeln hinzufügen"),
      el("div", { class: "card" },
        inputs.map((inp) => el("div", { class: "field" }, inp)),
        el("button", { class: "btn btn-ghost", type: "button", onclick: addSingle }, "Hinzufügen"),
      ),

      el("h3", {}, "Als Liste importieren"),
      el("div", { class: "card" },
        el("p", { class: "small muted" }, config.importHelp),
        textarea,
        el("div", { class: "stack" },
          el("button", { class: "btn btn-ghost", type: "button", onclick: runPreview }, "Vorschau"),
          el("button", {
            class: "btn-quiet", type: "button",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(config.aiPrompt);
                toast("Prompt kopiert – bei ChatGPT/Claude einfügen");
              } catch {
                prompt("Prompt zum Kopieren:", config.aiPrompt);
              }
            },
          }, "KI-Prompt kopieren (Liste generieren lassen)"),
        ),
        previewBox,
      ),

      el("h3", {}, `Einträge (${cat.items.length})`),
      itemRows.length ? el("ul", { class: "list" }, itemRows) : el("p", { class: "muted" }, "Noch keine Einträge."),
    );
  };

  renderList();

  return {
    get categories() { return categories; },
    openList() { renderList(); showList(); },
  };
}
