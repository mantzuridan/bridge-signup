// Admin page: shared code, full control over the current session.

const app = document.getElementById("app");
const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const SESSION_DOW = 3;
let state = null;
let known = [];
let code = null;
let namesFilter = "";
let pastSessions = [];
let history = null; // { session_date, groups } of the past session being viewed

try { code = localStorage.getItem("bridge.adminCode"); } catch { /* private mode */ }

function saveCode(c) {
  code = c;
  try { c ? localStorage.setItem("bridge.adminCode", c) : localStorage.removeItem("bridge.adminCode"); } catch { /* ignore */ }
}

async function adm(name, args) {
  try {
    return await rpc(name, { p_code: code, ...args });
  } catch (e) {
    if (e.message === "bad_code") { saveCode(null); showLogin("הקוד השתנה או שגוי. צריך להיכנס מחדש."); }
    throw e;
  }
}

async function act(fn, okMsg) {
  try {
    await fn();
    if (okMsg) toast(okMsg);
  } catch (e) {
    if (e.message !== "bad_code") toast(errorText(e), true);
  }
  await refresh(true);
}

const dialogOpts = () => ({ names: () => known, registered: () => registeredMap(state) });

// ---------- login ----------

function showLogin(message) {
  const input = h("input", { type: "password", placeholder: "קוד מנהלים", "aria-label": "קוד מנהלים" });
  const err = h("p", { class: "ferr", role: "alert" }, message || "");
  const btn = h("button", { class: "btn primary", type: "submit" }, "כניסה");
  const form = h("form", { class: "card", novalidate: true },
    h("h2", { class: "section-title", style: "margin-top:0" }, "כניסת מנהלים"),
    input, err, btn,
    h("p", { style: "text-align:center;margin:12px 0 0" }, h("a", { href: "index.html", class: "linkbtn" }, "חזרה לדף ההרשמה")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = input.value.trim();
    if (!c) { err.textContent = "צריך להקליד את הקוד."; return; }
    btn.disabled = true;
    try {
      await rpc("admin_check", { p_code: c });
      saveCode(c);
      await start();
    } catch (ex) {
      err.textContent = errorText(ex);
    } finally {
      btn.disabled = false;
    }
  });
  app.replaceChildren(form);
  input.focus();
}

// ---------- data ----------

// Live updates must not wipe a field the admin is typing in; render once they leave it.
let renderPending = false;
function typing() {
  const a = document.activeElement;
  return a && app.contains(a) && (a.tagName === "INPUT" || a.tagName === "SELECT");
}
app.addEventListener("focusout", () => setTimeout(() => {
  if (renderPending && !typing()) { renderPending = false; render(); }
}, 200));

async function refresh(force) {
  try {
    [state, known, pastSessions] = await Promise.all([rpc("get_state"), loadKnownNames(), adm("admin_sessions")]);
    if (!force && typing()) renderPending = true;
    else render();
  } catch (e) {
    if (e.message !== "bad_code") toast(errorText(e), true);
  }
}

// ---------- summary ----------

function summaryText(snapshot = state) {
  const { tables, waiting } = splitGroups(snapshot);
  const seated = tables.reduce((n, t) => n + t.players.length, 0);
  const lines = [
    `מפגש מודרך ${sessionDateText(snapshot.session_date)}`,
    `${tables.length} שולחנות · ${seated} שחקנים`,
    "",
  ];
  tables.forEach((t) => {
    const missing = SEATS - t.players.length;
    lines.push(`שולחן ${t.number}: ${t.players.map((p) => p.name).join(", ")}${missing ? ` (${missing === 1 ? "חסר 1" : `חסרים ${missing}`})` : ""}`);
  });
  const w = waiting.flatMap((g) => g.players.map((p) => p.name));
  if (w.length) lines.push("", `מעוניינים להצטרף: ${w.join(", ")}`);
  return lines.join("\n");
}

async function copySummary(snapshot) {
  const text = summaryText(snapshot);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: "position:absolute;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast("הסיכום הועתק. אפשר להדביק בוואטסאפ.");
}

// ---------- actions ----------

function removePlayer(p) {
  confirmDialog({ title: `להסיר את ${p.name}?`, lead: `דיברת עם ${p.name} לפני ההסרה?`, confirmText: "כן, להסיר", danger: true })
    .then((ok) => ok && act(() => adm("admin_remove_player", { p_player: p.id }), `${p.name} הוסר/ה.`));
}

function moveSelect(p, tables, currentId, placeholder) {
  const options = tables.filter((t) => t.id !== currentId && t.players.length < SEATS);
  if (!options.length) return null;
  const sel = h("select", { "aria-label": `${placeholder} ${p.name}` },
    h("option", { value: "" }, placeholder),
    options.map((t) => h("option", { value: t.id }, `שולחן ${t.number} (${SEATS - t.players.length === 1 ? "מקום 1" : SEATS - t.players.length + " מקומות"})`)));
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    const t = options.find((o) => o.id === sel.value);
    act(() => adm("admin_move_player", { p_player: p.id, p_target: t.id }), `${p.name} עבר/ה לשולחן ${t.number}.`);
  });
  return sel;
}

function adminPlayerRow(p, tables, currentId, placeholder) {
  return h("li", {}, h("div", { class: "arow", style: "width:100%" },
    h("span", { class: "pname" }, p.name),
    moveSelect(p, tables, currentId, placeholder),
    h("button", { class: "xbtn", onclick: () => removePlayer(p) }, "הסרה")));
}

// ---------- render ----------

function render() {
  const { tables, waiting } = splitGroups(state);
  const seated = tables.reduce((n, t) => n + t.players.length, 0);
  const waitingCount = waiting.reduce((n, g) => n + g.players.length, 0);
  const free = tables.reduce((n, t) => n + SEATS - t.players.length, 0);

  const metrics = h("div", { class: "metrics" },
    [[`${tables.length}/${state.max_tables}`, "שולחנות"], [seated, "שחקנים"], [free, "מקומות פנויים"], [waitingCount, "מעוניינים"]]
      .map(([v, l]) => h("div", { class: "metric" }, h("b", {}, v), h("span", {}, l))));

  const head = h("section", { class: "card status" },
    h("h2", {}, `מפגש ${sessionDateText(state.session_date)}`),
    h("p", { class: "deadline" }, state.is_open
      ? `ההרשמה פתוחה עד ${deadlineText(state.deadline)}`
      : "ההרשמה למשתתפים סגורה. מנהלים יכולים עדיין לשנות הכול."));

  const actions = h("div", {},
    h("button", { class: "btn primary", onclick: () => copySummary() }, "העתקת סיכום לוואטסאפ"),
    h("a", { class: "btn", href: "https://wa.me/?text=" + encodeURIComponent(summaryText()), target: "_blank", rel: "noopener", style: "text-decoration:none" }, "שליחת הסיכום בוואטסאפ"),
    h("button", { class: "btn", onclick: () => openTableDialog({
      ...dialogOpts(), title: "פתיחת שולחן (מנהל)", firstLabel: "שחקן 1",
      onSubmit: async (names) => { await adm("admin_open_table", { p_names: names }); toast("השולחן נפתח."); await refresh(); },
    }) }, "פתיחת שולחן"),
    h("button", { class: "btn", onclick: () => waitingDialog({
      ...dialogOpts(), title: "הוספה לרשימת המעוניינים", lead: "השחקן יופיע ברשימה וניתן יהיה לשבץ אותו לשולחן.", firstLabel: "שם השחקן",
      onSubmit: async (names) => { await adm("admin_add_waiting", { p_names: names }); toast("נוסף לרשימת המעוניינים."); await refresh(); },
    }) }, "הוספה לרשימת המעוניינים"));

  const tableCards = tables.map((t) => {
    const missing = SEATS - t.players.length;
    return h("div", { class: "card tcard" },
      h("div", { class: "thead" },
        h("span", { class: "tname" }, `שולחן ${t.number}`),
        missing ? h("span", { class: "pill missing" }, missing === 1 ? "חסר 1" : `חסרים ${missing}`) : h("span", { class: "pill full" }, "מלא")),
      h("ul", { class: "plist" },
        t.players.map((p) => adminPlayerRow(p, tables, t.id, "העברה ל...")),
        Array.from({ length: missing }, () => h("li", { class: "empty" }, "מקום פנוי"))),
      missing ? h("button", { class: "btn small", onclick: () => joinDialog({
        ...dialogOpts(), table: t, firstLabel: "שם השחקן",
        onSubmit: async (names) => { await adm("admin_join_table", { p_group: t.id, p_names: names }); toast(`נוסף לשולחן ${t.number}.`); await refresh(); },
      }) }, "הוספת שחקן לשולחן") : null);
  });

  const waitingCard = waiting.length
    ? h("div", { class: "card tcard" }, h("ul", { class: "plist" },
        waiting.flatMap((g) => g.players.map((p) => adminPlayerRow(p, tables, null, "שיבוץ לשולחן...")))))
    : h("div", { class: "card empty-state" }, "אין כרגע מעוניינים.");

  app.replaceChildren(...[
    head, metrics, actions,
    h("h2", { class: "section-title" }, "שולחנות"),
    tableCards.length ? tableCards : h("div", { class: "card empty-state" }, "עוד לא נפתחו שולחנות."),
    h("h2", { class: "section-title" }, "מעוניינים להצטרף לשולחן"),
    waitingCard,
    historyCard(),
    settingsCard(),
    namesCard(),
    codeCard(),
    h("footer", { class: "foot" },
      h("a", { href: "index.html", class: "linkbtn" }, "לדף ההרשמה"), " · ",
      h("button", { class: "linkbtn", onclick: () => { saveCode(null); showLogin(); } }, "יציאה")),
  ].flat());
}

function historyCard() {
  const sel = h("select", { "aria-label": "בחירת מפגש קודם" },
    h("option", { value: "" }, pastSessions.length ? "בחירת מפגש..." : "אין עדיין מפגשים קודמים"),
    pastSessions.map((s) => h("option", { value: s.session_date, selected: history && history.session_date === s.session_date },
      `רביעי ${shortDate(s.session_date)} · ${s.players} שחקנים`)));
  sel.addEventListener("change", async () => {
    if (!sel.value) { history = null; render(); return; }
    try {
      history = { session_date: sel.value, groups: await adm("admin_session_groups", { p_session: sel.value }) };
    } catch (e) {
      if (e.message !== "bad_code") toast(errorText(e), true);
      history = null;
    }
    render();
  });

  let details = null;
  if (history) {
    const { tables, waiting } = splitGroups(history);
    const w = waiting.flatMap((g) => g.players.map((p) => p.name));
    details = h("div", {},
      tables.map((t) => h("div", { style: "margin-top:12px" },
        h("b", { style: "font-weight:600" }, `שולחן ${t.number}: `), t.players.map((p) => p.name).join(", "))),
      w.length ? h("p", { style: "margin:12px 0 0" }, h("b", { style: "font-weight:600" }, "מעוניינים: "), w.join(", ")) : null,
      h("button", { class: "btn small", onclick: () => copySummary(history) }, "העתקת הסיכום של המפגש הזה"));
  }

  return h("div", {},
    h("h2", { class: "section-title" }, "מפגשים קודמים"),
    h("div", { class: "card" }, sel, details));
}

function settingsCard() {
  const day = h("select", { "aria-label": "יום סגירת ההרשמה" },
    Array.from({ length: 7 }, (_, k) => {
      const name = DAY_NAMES[(SESSION_DOW - k + 7) % 7];
      const label = k === 0 ? `${name} (יום המפגש)` : `${name} (${k === 1 ? "יום" : k + " ימים"} לפני)`;
      return h("option", { value: k, selected: k === state.deadline_days_before }, label);
    }));
  const time = h("input", { type: "time", value: state.deadline_time, "aria-label": "שעת סגירת ההרשמה" });
  return h("div", {},
    h("h2", { class: "section-title" }, "סגירת ההרשמה"),
    h("div", { class: "card" },
      h("label", { class: "flabel", style: "margin-top:0" }, "יום"), day,
      h("label", { class: "flabel" }, "שעה"), time,
      h("button", { class: "btn small primary", onclick: () => {
        if (!time.value) { toast("צריך לבחור שעה.", true); return; }
        act(() => adm("admin_update_settings", { p_days_before: Number(day.value), p_deadline_time: time.value }), "מועד הסגירה עודכן.");
      } }, "שמירה")));
}

function namesCard() {
  const input = h("input", { type: "text", placeholder: "שם פרטי ומשפחה", "aria-label": "שם חדש" });
  const search = h("input", { type: "text", placeholder: "חיפוש ברשימה", "aria-label": "חיפוש ברשימה", value: namesFilter });
  const listBox = h("ul", { class: "plist names-list" });

  function drawList() {
    const key = searchKey(search.value);
    const shown = known.filter((n) => !key || searchKey(n.name).includes(key))
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
    listBox.replaceChildren(...shown.map((n) => h("li", {}, h("span", {}, n.name),
      h("button", { class: "xbtn", onclick: () => confirmDialog({ title: `להסיר את ${n.name} מרשימת השמות?`, lead: "זה לא מבטל רישום קיים, רק מוריד את השם מההצעות.", confirmText: "כן, להסיר", danger: true })
        .then((ok) => ok && act(() => adm("admin_remove_known", { p_name: n.name }), "השם הוסר מהרשימה.")) }, "הסרה"))));
  }
  search.addEventListener("input", () => { namesFilter = search.value; drawList(); });
  drawList();

  const form = h("form", { class: "inline-form", novalidate: true }, input, h("button", { class: "btn primary", type: "submit" }, "הוספה"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = normName(input.value);
    if (!n) { toast("צריך לכתוב שם.", true); return; }
    act(() => adm("admin_add_known", { p_name: n }), `${n} נוסף/ה לרשימה.`);
  });

  return h("div", {},
    h("h2", { class: "section-title" }, `רשימת שמות להשלמה (${known.length})`),
    h("div", { class: "card" }, form, h("div", { style: "height:10px" }), search, listBox));
}

function codeCard() {
  const input = h("input", { type: "text", placeholder: "קוד חדש", "aria-label": "קוד חדש" });
  const form = h("form", { class: "inline-form", novalidate: true }, input, h("button", { class: "btn", type: "submit" }, "שינוי"));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = input.value.trim();
    if (c.length < 4) { toast("הקוד החדש צריך להיות באורך 4 תווים לפחות.", true); return; }
    const ok = await confirmDialog({ title: "לשנות את קוד המנהלים?", lead: `הקוד החדש: ${c}. צריך לעדכן גם את שאר המנהלים.`, confirmText: "כן, לשנות" });
    if (!ok) return;
    try {
      await adm("admin_set_code", { p_new_code: c });
      saveCode(c);
      toast("הקוד שונה.");
      input.value = "";
    } catch (ex) {
      if (ex.message !== "bad_code") toast(errorText(ex), true);
    }
  });
  return h("div", {},
    h("h2", { class: "section-title" }, "קוד מנהלים"),
    h("div", { class: "card" }, form));
}

// ---------- start ----------

let subscribed = false;
async function start() {
  app.replaceChildren(h("p", { class: "loading" }, "טוען..."));
  await refresh();
  if (!subscribed) { subscribed = true; subscribeChanges(() => refresh()); }
}

if (code) {
  rpc("admin_check", { p_code: code }).then(start).catch((e) => {
    if (e.message === "bad_code") { saveCode(null); showLogin(); } else showLogin(errorText(e));
  });
} else {
  showLogin();
}
