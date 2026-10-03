// Participant page: only two actions. Registrations are visible to admins only.

const app = document.getElementById("app");
let session = null;
let known = [];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("bridge." + k)); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem("bridge." + k) : localStorage.setItem("bridge." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const dialogOpts = () => ({ names: () => known, registered: () => new Map() });

function padSeats(names) {
  const seats = names.slice(0, SEATS);
  while (seats.length < SEATS) seats.push(null);
  return seats;
}

// Saved only when the player ticked "save as my usual table" while opening a table.
function usualTable() {
  const usual = store.get("savedTable");
  return Array.isArray(usual) && usual.some(Boolean) ? padSeats(usual) : null;
}

async function load() {
  try {
    session = await rpc("get_session");
    render();
  } catch (e) {
    app.replaceChildren(
      h("div", { class: "card empty-state" },
        h("p", {}, errorText(e)),
        h("button", { class: "btn primary", onclick: () => { app.replaceChildren(h("p", { class: "loading" }, "טוען...")); load(); } }, "לנסות שוב")));
  }
}

function doneDialog(seats, note) {
  let close;
  close = openModal([
    h("h3", {}, "ההרשמה התקבלה"),
    h("ul", { class: "done-list" }, seats.map((n) => n ? h("li", {}, n) : h("li", { class: "empty" }, "מקום פנוי"))),
    h("p", { class: "lead", style: "margin-top:12px" }, note),
    h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => close() }, "סגירה")),
  ]);
}

// ---------- actions ----------

function openTable(prefill) {
  openTableDialog({
    ...dialogOpts(),
    title: prefill ? "השולחן הקבוע שלי" : "פתיחת שולחן",
    firstLabel: "שחקן 1 (את/ה)",
    prefill,
    saveOption: true,
    onSubmit: async (names, save) => {
      await rpc("open_table", { p_names: names });
      if (save) store.set("savedTable", padSeats(names));
      const missing = SEATS - names.length;
      const notes = [missing ? "המנהלים ישלימו את השולחן." : "נתראה ביום רביעי."];
      if (save) notes.push("השולחן נשמר כשולחן הקבוע שלך.");
      render();
      setTimeout(() => doneDialog(padSeats(names), notes.join(" ")), 0);
    },
  });
}

function addWaiting() {
  waitingDialog({
    ...dialogOpts(),
    title: "מעוניין להצטרף לשולחן",
    lead: "המנהלים ישבצו אותך לשולחן. אם יש לך בן/בת זוג למשחק, אפשר לרשום גם אותו/ה.",
    firstLabel: "השם שלך",
    onSubmit: async (names) => {
      await rpc("add_waiting", { p_names: names });
      setTimeout(() => doneDialog(names, "המנהלים ישבצו אתכם לשולחן."), 0);
    },
  });
}

async function forgetUsual() {
  const ok = await confirmDialog({ title: "להסיר את השולחן הקבוע?", lead: "אפשר לשמור שולחן קבוע חדש בפעם הבאה שפותחים שולחן.", confirmText: "כן, להסיר" });
  if (!ok) return;
  store.set("savedTable", null);
  render();
}

// ---------- rendering ----------

function render() {
  const head = h("section", { class: "card status" },
    h("h2", {}, `מפגש ${sessionDateText(session.session_date)}`),
    h("p", { class: "deadline" }, "אפשר לפתוח שולחן או להירשם כמעוניינים, והמנהלים ישלימו את השולחנות."));

  let body;
  if (!session.is_open) {
    body = h("div", { class: "banner closed" }, "ההרשמה למפגש הזה נסגרה. לשינויים אפשר לפנות למנהלי המועדון.");
  } else {
    const usual = usualTable();
    body = h("div", {},
      usual ? h("button", { class: "btn", onclick: () => openTable(usual) },
        h("span", {}, "להירשם עם השולחן הקבוע שלי", h("span", { class: "sub" }, usual.filter(Boolean).join(", ")))) : null,
      h("button", { class: "btn primary", onclick: () => openTable(null) }, "פתיחת שולחן"),
      h("button", { class: "btn", onclick: addWaiting }, "מעוניין להצטרף לשולחן"),
      usual ? h("p", { style: "text-align:center;margin:6px 0 0" }, h("button", { class: "linkbtn", onclick: forgetUsual }, "הסרת השולחן הקבוע")) : null);
  }

  app.replaceChildren(head, body,
    h("footer", { class: "foot" }, h("a", { href: "admin.html", class: "linkbtn" }, "כניסת מנהלים")));
}

// ---------- start ----------

loadKnownNames().then((list) => { known = list; });
load();
document.addEventListener("visibilitychange", () => { if (!document.hidden && session) load(); });
