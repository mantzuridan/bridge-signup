// Shared helpers for the signup page and the admin page.

const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
const TZ = "Asia/Jerusalem";
const SEATS = 4;

// ---------- server calls ----------

async function rpc(name, args) {
  let res;
  try {
    res = await sb.rpc(name, args || {});
  } catch (e) {
    throw new Error("network");
  }
  if (res.error) {
    const msg = res.error.message || "";
    throw new Error(/fetch|network/i.test(msg) ? "network" : msg);
  }
  return res.data;
}

async function loadKnownNames() {
  const { data, error } = await sb
    .from("known_players")
    .select("name,games")
    .order("games", { ascending: false })
    .order("name");
  if (error) return [];
  return data;
}

function errorText(err) {
  const msg = (err && err.message) || String(err);
  const [code, arg] = msg.split(":");
  switch (code) {
    case "registration_closed": return "ההרשמה למפגש הזה נסגרה. לשינויים אפשר לפנות למנהלי המועדון.";
    case "already_registered": return `${arg} כבר רשום/ה למפגש הזה.`;
    case "duplicate_name": return `השם ${arg} מופיע פעמיים.`;
    case "table_full": return "אין מספיק מקומות פנויים בשולחן הזה. ייתכן שמישהו הצטרף לפניכם.";
    case "table_not_found": return "השולחן לא נמצא, אולי הוא בוטל. הדף התעדכן.";
    case "player_not_found": return "השחקן לא נמצא, אולי הרישום כבר בוטל.";
    case "no_names": return "צריך לכתוב לפחות שם אחד.";
    case "too_many": return "יש יותר מדי שמות.";
    case "name_too_long": return "השם ארוך מדי.";
    case "bad_code": return "הקוד שגוי.";
    case "code_too_short": return "הקוד החדש צריך להיות באורך 4 תווים לפחות.";
    case "network": return "אין חיבור לאינטרנט. כדאי לבדוק את החיבור ולנסות שוב.";
    default: return "משהו השתבש. נסו שוב בעוד רגע.";
  }
}

// ---------- formatting ----------

function sessionDateText(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z");
  const weekday = new Intl.DateTimeFormat("he-IL", { weekday: "long", timeZone: TZ }).format(d);
  const day = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "long", timeZone: TZ }).format(d);
  return `${weekday}, ${day}`;
}

function deadlineText(iso) {
  const d = new Date(iso);
  const weekday = new Intl.DateTimeFormat("he-IL", { weekday: "long", timeZone: TZ }).format(d);
  const dm = new Intl.DateTimeFormat("he-IL", { day: "numeric", month: "numeric", timeZone: TZ }).format(d);
  const time = new Intl.DateTimeFormat("he-IL", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: TZ }).format(d);
  return `${weekday} ${dm} בשעה ${time}`;
}

function shortDate(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(d)}.${Number(m)}`;
}

function normName(s) {
  return (s || "").replace(/[‎‏‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim();
}

function searchKey(s) {
  return normName(s).replace(/["'`׳״]/g, "").toLowerCase();
}

// ---------- state helpers ----------

function splitGroups(state) {
  const tables = state.groups.filter((g) => g.kind === "table");
  const waiting = state.groups.filter((g) => g.kind === "waiting");
  tables.forEach((t, i) => { t.number = i + 1; });
  return { tables, waiting };
}

// name -> "table" | "waiting"
function registeredMap(state) {
  const map = new Map();
  state.groups.forEach((g) => g.players.forEach((p) => map.set(p.name, g.kind)));
  return map;
}

// ---------- tiny DOM helper ----------

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// ---------- toast ----------

let toastTimer;
function toast(msg, isError) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: "toast" + (isError ? " error" : ""), role: "status" }, msg);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), isError ? 6000 : 3500);
}

// ---------- modal ----------

function openModal(content) {
  const overlay = h("div", { class: "overlay" }, h("div", { class: "modal", role: "dialog", "aria-modal": "true" }, content));
  const onKey = (e) => { if (e.key === "Escape" && e.target.tagName !== "INPUT") close(); };
  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = "";
  }
  document.addEventListener("keydown", onKey);
  document.body.style.overflow = "hidden";
  document.body.append(overlay);
  return close;
}

function confirmDialog({ title, lead, confirmText, danger }) {
  return new Promise((resolve) => {
    let close;
    const done = (v) => { close(); resolve(v); };
    close = openModal([
      h("h3", {}, title),
      lead ? h("p", { class: "lead" }, lead) : null,
      h("div", { class: "actions" },
        h("button", { class: "btn " + (danger ? "danger" : "primary"), onclick: () => done(true) }, confirmText),
        h("button", { class: "btn plain", onclick: () => done(false) }, "חזרה")),
    ]);
  });
}

// ---------- autocomplete ----------

// Wraps an input with a suggestion list drawn from the known-names list.
// opts.names(): [{name, games}], opts.registered(): Map name -> kind
function autocomplete(input, opts) {
  const box = h("div", { class: "ac" });
  const hint = h("p", { class: "ac-hint", hidden: true });
  let list = null;
  let items = [];
  let active = -1;

  function matches(q) {
    const key = searchKey(q);
    if (!key) return [];
    const scored = [];
    for (const n of opts.names()) {
      const k = searchKey(n.name);
      let score = -1;
      if (k.startsWith(key)) score = 0;
      else if (k.split(" ").some((w) => w.startsWith(key))) score = 1;
      else if (k.includes(key)) score = 2;
      if (score >= 0) scored.push({ ...n, score });
    }
    scored.sort((a, b) => a.score - b.score || b.games - a.games || a.name.localeCompare(b.name, "he"));
    return scored.slice(0, 6);
  }

  function closeList() {
    if (list) list.remove();
    list = null;
    active = -1;
  }

  function pick(name) {
    input.value = name;
    closeList();
    hint.hidden = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function render() {
    closeList();
    if (input.disabled) return;
    items = matches(input.value);
    if (!items.length) return;
    if (items.length === 1 && items[0].name === normName(input.value)) return;
    const reg = opts.registered();
    list = h("ul", { class: "ac-list", role: "listbox" },
      items.map((it, i) => {
        const kind = reg.get(it.name);
        const taken = kind === "table";
        return h("li", {
          class: taken ? "taken" : "",
          role: "option",
          onmousedown: (e) => { e.preventDefault(); if (!taken) pick(it.name); },
        }, it.name,
        kind === "table" ? h("small", {}, "(כבר רשום/ה)") : null,
        kind === "waiting" ? h("small", {}, "(ברשימת המעוניינים)") : null);
      }));
    box.append(list);
  }

  function setActive(i) {
    if (!list) return;
    const lis = [...list.children];
    lis.forEach((li) => li.classList.remove("active"));
    active = (i + lis.length) % lis.length;
    lis[active].classList.add("active");
  }

  function updateHint() {
    const v = normName(input.value);
    const known = !v || opts.names().some((n) => n.name === v);
    hint.textContent = "שם שלא מופיע ברשימה. כדאי לוודא שהאיות נכון (שם פרטי ומשפחה).";
    hint.hidden = known || input.disabled;
  }

  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", () => { hint.hidden = true; render(); });
  input.addEventListener("focus", render);
  input.addEventListener("blur", () => setTimeout(() => { closeList(); updateHint(); }, 120));
  input.addEventListener("keydown", (e) => {
    if (!list) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      const it = items[active];
      if (opts.registered().get(it.name) !== "table") pick(it.name);
    } else if (e.key === "Escape") { e.stopPropagation(); closeList(); }
  });

  box.append(input);
  return h("div", {}, box, hint);
}

// ---------- dialogs: open table / join / waiting ----------

function submitButton(label) {
  return h("button", { class: "btn primary", type: "submit" }, label);
}

async function runSubmit(btn, errBox, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "שולח...";
  errBox.textContent = "";
  try {
    await fn();
    return true;
  } catch (e) {
    errBox.textContent = errorText(e);
    return false;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// opts: { title, firstLabel, prefill: [name|null x4], names, registered, onSubmit(names[]) }
function openTableDialog(opts) {
  const seats = [];
  const note = h("div", { class: "fnote" });
  const errBox = h("p", { class: "ferr", role: "alert" });
  const btn = submitButton("אישור הרשמה");

  function updateNote() {
    const missing = seats.filter((s) => s.missing.checked).length;
    note.className = "fnote " + (missing ? "missing" : "full");
    note.textContent = missing
      ? `${missing === 1 ? "חסר שחקן אחד" : `חסרים ${missing} שחקנים`}. המנהלים ישלימו את השולחן.`
      : "שולחן מלא, 4 שחקנים.";
  }

  for (let i = 0; i < SEATS; i++) {
    const input = h("input", { type: "text", placeholder: "שם מלא", "aria-label": `שחקן ${i + 1}` });
    const missing = h("input", { type: "checkbox" });
    const checkLabel = h("label", { class: "check" }, missing, "חסר שחקן");
    const err = h("p", { class: "ferr" });
    const pre = opts.prefill && opts.prefill[i];
    if (pre) input.value = pre;

    const setMissing = (on) => {
      missing.checked = on;
      checkLabel.classList.toggle("on", on);
      input.disabled = on;
      if (on) { input.value = ""; input.placeholder = "מקום פנוי"; input.classList.remove("invalid"); err.textContent = ""; }
      else input.placeholder = "שם מלא";
      updateNote();
    };
    missing.addEventListener("change", () => setMissing(missing.checked));
    input.addEventListener("input", () => { input.classList.remove("invalid"); err.textContent = ""; });

    const label = i === 0 ? opts.firstLabel : `שחקן ${i + 1}`;
    const seatEl = h("div", { class: "seat" },
      h("label", { class: "flabel" }, label),
      h("div", { class: "row" }, autocomplete(input, opts), i === 0 ? null : checkLabel),
      err);
    seats.push({ input, missing, err, el: seatEl, setMissing });
    if (i > 0 && opts.prefill && opts.prefill.length && !pre) setMissing(true);
  }

  const save = h("input", { type: "checkbox" });
  const saveLabel = opts.saveOption
    ? h("label", { class: "check save" }, save, "לשמור כשולחן קבוע (בפעם הבאה אפשר יהיה להירשם בלחיצה)")
    : null;
  save.addEventListener("change", () => saveLabel.classList.toggle("on", save.checked));

  const form = h("form", { novalidate: true }, h("h3", {}, opts.title), seats.map((s) => s.el), note, saveLabel, errBox, btn,
    h("button", { class: "btn plain", type: "button", onclick: () => close() }, "ביטול"));
  form.addEventListener("input", () => { errBox.textContent = ""; });
  form.addEventListener("change", () => { errBox.textContent = ""; });
  updateNote();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const names = [];
    let ok = true;
    const reg = opts.registered();
    seats.forEach((s) => {
      if (s.missing.checked) return;
      const v = normName(s.input.value);
      s.err.textContent = "";
      if (!v) {
        s.err.textContent = s.missing === seats[0].missing ? "צריך לכתוב שם." : "צריך לכתוב שם או לסמן 'חסר שחקן'.";
      } else if (names.includes(v)) {
        s.err.textContent = "השם הזה כבר מופיע בשולחן.";
      } else if (reg.get(v) === "table") {
        s.err.textContent = "כבר רשום/ה בשולחן אחר.";
      }
      if (s.err.textContent) { ok = false; s.input.classList.add("invalid"); }
      else names.push(v);
    });
    if (!ok) { errBox.textContent = "יש לתקן את השדות המסומנים."; return; }
    const done = await runSubmit(btn, errBox, () => opts.onSubmit(names, save.checked));
    if (done) close();
  });

  const close = openModal(form);
  if (!seats[0].input.value) seats[0].input.focus();
}

// opts: { table, firstLabel, names, registered, onSubmit(names[]) }
function joinDialog(opts) {
  const free = SEATS - opts.table.players.length;
  const errBox = h("p", { class: "ferr", role: "alert" });
  const btn = submitButton("הצטרפות לשולחן");
  const inputsBox = h("div");
  const inputs = [];
  const addBtn = h("button", { class: "linkbtn", type: "button", onclick: () => addInput() }, "+ להוסיף עוד שחקן");

  function addInput() {
    const i = inputs.length;
    const input = h("input", { type: "text", placeholder: "שם מלא", "aria-label": `שחקן ${i + 1}` });
    inputs.push(input);
    inputsBox.append(h("label", { class: "flabel" }, i === 0 ? opts.firstLabel : "שחקן נוסף"), autocomplete(input, opts));
    addBtn.hidden = inputs.length >= free;
    if (i > 0) input.focus();
  }
  addInput();

  const form = h("form", { novalidate: true },
    h("h3", {}, `הצטרפות לשולחן ${opts.table.number}`),
    h("p", { class: "lead" }, `בשולחן: ${opts.table.players.map((p) => p.name).join(", ")}. ${free === 1 ? "חסר שחקן אחד" : `חסרים ${free}`}.`),
    inputsBox, addBtn, errBox, btn,
    h("button", { class: "btn plain", type: "button", onclick: () => close() }, "ביטול"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const names = inputs.map((i) => normName(i.value)).filter(Boolean);
    const reg = opts.registered();
    if (!names.length) { errBox.textContent = "צריך לכתוב שם."; inputs[0].classList.add("invalid"); return; }
    if (new Set(names).size !== names.length) { errBox.textContent = "אותו שם מופיע פעמיים."; return; }
    const taken = names.find((n) => reg.get(n) === "table");
    if (taken) { errBox.textContent = `${taken} כבר רשום/ה בשולחן אחר.`; return; }
    const done = await runSubmit(btn, errBox, () => opts.onSubmit(names));
    if (done) close();
  });

  const close = openModal(form);
  inputs[0].focus();
}

// opts: { title, lead, firstLabel, names, registered, onSubmit(names[]) }
function waitingDialog(opts) {
  const errBox = h("p", { class: "ferr", role: "alert" });
  const btn = submitButton("רישום");
  const a = h("input", { type: "text", placeholder: "שם מלא", "aria-label": opts.firstLabel });
  const b = h("input", { type: "text", placeholder: "אפשר להשאיר ריק", "aria-label": "בן/בת זוג למשחק" });

  const form = h("form", { novalidate: true },
    h("h3", {}, opts.title),
    h("p", { class: "lead" }, opts.lead),
    h("label", { class: "flabel" }, opts.firstLabel), autocomplete(a, opts),
    h("label", { class: "flabel" }, "בן/בת זוג למשחק (לא חובה)"), autocomplete(b, opts),
    errBox, btn,
    h("button", { class: "btn plain", type: "button", onclick: () => close() }, "ביטול"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const names = [normName(a.value), normName(b.value)].filter(Boolean);
    const reg = opts.registered();
    if (!normName(a.value)) { errBox.textContent = "צריך לכתוב שם."; a.classList.add("invalid"); return; }
    if (names.length === 2 && names[0] === names[1]) { errBox.textContent = "אותו שם מופיע פעמיים."; return; }
    const taken = names.find((n) => reg.has(n));
    if (taken) { errBox.textContent = `${taken} כבר רשום/ה למפגש הזה.`; return; }
    const done = await runSubmit(btn, errBox, () => opts.onSubmit(names));
    if (done) close();
  });

  const close = openModal(form);
  a.focus();
}

// ---------- live updates ----------

// Registrations are private (no realtime feed), so the admin page polls.
function subscribeChanges(onChange) {
  document.addEventListener("visibilitychange", () => { if (!document.hidden) onChange(); });
  setInterval(() => { if (!document.hidden) onChange(); }, 20000);
}
