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

// The table opened from this device: { group, token, session } in storage, its players in `mine`.
let mine = null;

async function loadMine() {
  const t = store.get("myTable");
  mine = null;
  if (!t || t.session !== session.session_date) { if (t) store.set("myTable", null); return; }
  const res = await rpc("my_table", { p_group: t.group, p_token: t.token });
  if (res && res.players.length) mine = res.players;
  else store.set("myTable", null);
}

async function load() {
  try {
    session = await rpc("get_session");
    await loadMine();
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
      const res = await rpc("open_table", { p_names: names });
      store.set("myTable", { group: res.group_id, token: res.token, session: session.session_date });
      await loadMine();
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

// Cancel players of the table opened from this device, or the whole table.
function manageDialog() {
  const t = store.get("myTable");
  const listBox = h("ul", { class: "plist" });
  const errBox = h("p", { class: "ferr", role: "alert" });

  async function run(fn, msg) {
    errBox.textContent = "";
    try {
      await fn();
      toast(msg);
    } catch (e) {
      errBox.textContent = errorText(e);
    }
    await loadMine();
    render();
    if (!mine) { close(); return; }
    draw();
  }

  function draw() {
    listBox.replaceChildren(...mine.map((p) => h("li", {}, h("span", {}, p.name),
      h("button", { class: "xbtn", onclick: () => run(() => rpc("owner_remove_player", { p_group: t.group, p_token: t.token, p_player: p.id }), `הרישום של ${p.name} בוטל.`) }, "ביטול"))));
  }
  draw();

  const close = openModal([
    h("h3", {}, "הרישום שלי"),
    h("p", { class: "lead" }, "אפשר לבטל שחקן מסוים או את כל השולחן."),
    listBox, errBox,
    h("div", { class: "actions" },
      h("button", { class: "btn danger", onclick: async () => {
        const ok = await confirmDialog({ title: "לבטל את כל השולחן?", lead: mine.map((p) => p.name).join(", "), confirmText: "כן, לבטל את השולחן", danger: true });
        if (ok) run(() => rpc("owner_remove_table", { p_group: t.group, p_token: t.token }), "השולחן בוטל.");
      } }, "ביטול השולחן כולו"),
      h("button", { class: "btn plain", onclick: () => close() }, "סגירה")),
  ]);
}

// ---------- rendering ----------

function render() {
  const head = h("section", { class: "card status" },
    h("h2", {}, `מפגש ${sessionDateText(session.session_date)}`),
    h("p", { class: "deadline" }, "אפשר לפתוח שולחן או להירשם כמעוניינים, והמנהלים ישלימו את השולחנות."));

  const manage = mine ? h("button", { class: "btn plain", onclick: manageDialog }, "ביטול הרישום שלי") : null;

  let body;
  if (!session.is_open) {
    body = h("div", {}, h("div", { class: "banner closed" }, "ההרשמה למפגש הזה נסגרה. לשינויים אפשר לפנות למנהלי המועדון."), manage);
  } else {
    const usual = mine ? null : usualTable();
    body = h("div", {}, manage,
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
