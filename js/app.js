// Participant signup page.

const app = document.getElementById("app");
let state = null;
let known = [];

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("bridge." + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("bridge." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const dialogOpts = () => ({
  names: () => known,
  registered: () => registeredMap(state),
});

async function refresh() {
  try {
    state = await rpc("get_state");
    render();
  } catch (e) {
    if (!state) {
      app.replaceChildren(
        h("div", { class: "card empty-state" },
          h("p", {}, errorText(e)),
          h("button", { class: "btn primary", onclick: () => { app.replaceChildren(h("p", { class: "loading" }, "טוען...")); refresh(); } }, "לנסות שוב")));
    }
  }
}

function myGroup() {
  const me = store.get("me");
  if (!me) return null;
  return state.groups.find((g) => g.players.some((p) => p.name === me)) || null;
}

// Remember the composition of my table so next week it can be re-registered in one go.
function rememberUsualTable(group) {
  if (!group || group.kind !== "table") return;
  const names = group.players.map((p) => p.name);
  while (names.length < SEATS) names.push(null);
  store.set("usual", names);
}

function usualTable() {
  const usual = store.get("usual");
  if (!Array.isArray(usual) || !usual.some(Boolean)) return null;
  const me = store.get("me");
  const names = usual.filter(Boolean);
  if (me && names.includes(me)) names.splice(names.indexOf(me), 1), names.unshift(me);
  while (names.length < SEATS) names.push(null);
  return names;
}

// ---------- actions ----------

function afterRegister(firstName, msg) {
  store.set("me", firstName);
  toast(msg);
  return refresh();
}

function openTable(prefill) {
  openTableDialog({
    ...dialogOpts(),
    title: prefill ? "השולחן הקבוע שלי" : "פתיחת שולחן",
    firstLabel: "שחקן 1 (את/ה)",
    prefill,
    onSubmit: async (names) => {
      await rpc("open_table", { p_names: names });
      await afterRegister(names[0], "נרשמתם. השולחן מופיע ברשימה.");
    },
  });
}

function joinTable(table) {
  joinDialog({
    ...dialogOpts(),
    table,
    firstLabel: "השם שלך",
    onSubmit: async (names) => {
      try {
        await rpc("join_table", { p_group: table.id, p_names: names });
      } catch (e) {
        refresh();
        throw e;
      }
      await afterRegister(names[0], `הצטרפתם לשולחן ${table.number}.`);
    },
  });
}

function addWaiting() {
  waitingDialog({
    ...dialogOpts(),
    title: "מעוניין להצטרף לשולחן",
    lead: "נרשום אותך ברשימת המעוניינים, וכך יהיה קל לצרף אותך לשולחן שחסרים בו שחקנים.",
    firstLabel: "השם שלך",
    onSubmit: async (names) => {
      await rpc("add_waiting", { p_names: names });
      await afterRegister(names[0], "נרשמת לרשימת המעוניינים.");
    },
  });
}

async function cancelPlayer(player) {
  const isMe = player.name === store.get("me");
  const ok = await confirmDialog(isMe
    ? { title: "לבטל את הרישום שלך?", confirmText: "כן, לבטל את הרישום", danger: true }
    : {
        title: `לבטל את הרישום של ${player.name}?`,
        lead: `דיברת עם ${player.name} לפני הביטול?`,
        confirmText: "כן, לבטל רישום",
        danger: true,
      });
  if (!ok) return;
  try {
    await rpc("remove_player", { p_player: player.id });
    toast(`הרישום של ${player.name} בוטל.`);
  } catch (e) {
    toast(errorText(e), true);
  }
  refresh();
}

// ---------- rendering ----------

function playerRow(p) {
  return h("li", {}, h("span", {}, p.name),
    h("button", { class: "xbtn", onclick: () => cancelPlayer(p), "aria-label": `ביטול הרישום של ${p.name}` }, "ביטול"));
}

function tableCard(t, mine) {
  const missing = SEATS - t.players.length;
  const empties = Array.from({ length: missing }, () => h("li", { class: "empty" }, "מקום פנוי"));
  return h("div", { class: "card tcard" + (mine ? " mine" : "") },
    h("div", { class: "thead" },
      h("span", { class: "tname" }, `שולחן ${t.number}`, mine ? " (השולחן שלך)" : ""),
      missing
        ? h("span", { class: "pill missing" }, missing === 1 ? "חסר 1" : `חסרים ${missing}`)
        : h("span", { class: "pill full" }, "מלא")),
    h("ul", { class: "plist" }, t.players.map(playerRow), empties),
    missing && state.is_open
      ? h("button", { class: "btn small", onclick: () => joinTable(t) }, "הצטרפות לשולחן")
      : null);
}

function render() {
  const { tables, waiting } = splitGroups(state);
  const mine = myGroup();
  rememberUsualTable(mine);
  const reg = registeredMap(state);
  const seated = tables.reduce((n, t) => n + t.players.length, 0);
  const waitingCount = waiting.reduce((n, g) => n + g.players.length, 0);

  const status = h("section", { class: "card status" },
    h("h2", {}, `מפגש ${sessionDateText(state.session_date)}`),
    h("p", { class: "count" }, h("b", {}, tables.length), ` מתוך ${state.max_tables} שולחנות · ${seated} שחקנים`,
      waitingCount ? ` · ${waitingCount} מעוניינים` : ""),
    state.is_open ? h("p", { class: "deadline" }, `ההרשמה פתוחה עד ${deadlineText(state.deadline)}`) : null);

  const banners = [];
  if (!state.is_open) {
    banners.push(h("div", { class: "banner closed" }, "ההרשמה למפגש הזה נסגרה. אפשר עדיין לבטל רישום. לשינויים אחרים אפשר לפנות למנהלי המועדון."));
  }
  if (mine) {
    const where = mine.kind === "table" ? `בשולחן ${tables.indexOf(mine) + 1}` : "ברשימת המעוניינים";
    banners.push(h("div", { class: "banner info" }, `${store.get("me")}, את/ה רשום/ה ${where}.`));
  }

  const actions = [];
  if (state.is_open) {
    const usual = usualTable();
    if (!mine && usual && !usual.some((n) => n && reg.get(n) === "table")) {
      actions.push(h("button", { class: "btn", onclick: () => openTable(usual) },
        h("span", {}, "להירשם עם השולחן הקבוע שלי", h("span", { class: "sub" }, usual.filter(Boolean).join(", ")))));
    }
    actions.push(
      h("button", { class: "btn primary", onclick: () => openTable(null) }, "פתיחת שולחן"),
      h("button", { class: "btn", onclick: addWaiting }, "מעוניין להצטרף לשולחן"));
  }

  const tablesSection = [
    h("h2", { class: "section-title" }, "שולחנות"),
    tables.length
      ? tables.map((t) => tableCard(t, t === mine))
      : h("div", { class: "card empty-state" }, "עוד לא נפתחו שולחנות למפגש הזה."),
  ];

  const waitingSection = waiting.length ? [
    h("h2", { class: "section-title" }, "מעוניינים להצטרף לשולחן"),
    h("div", { class: "card tcard" }, h("ul", { class: "plist" }, waiting.flatMap((g) => g.players.map((p, i) =>
      h("li", {}, h("span", {}, p.name, g.players.length > 1
          ? h("small", { style: "color:var(--muted)" }, ` (זוג עם ${g.players[1 - i].name})`) : ""),
        h("button", { class: "xbtn", onclick: () => cancelPlayer(p), "aria-label": `ביטול הרישום של ${p.name}` }, "ביטול")))))),
  ] : [];

  app.replaceChildren(...[
    status,
    ...banners,
    h("div", {}, actions),
    ...tablesSection,
    ...waitingSection,
    h("footer", { class: "foot" }, h("a", { href: "admin.html", class: "linkbtn" }, "כניסת מנהלים")),
  ].flat());
}

// ---------- start ----------

loadKnownNames().then((list) => { known = list; });
refresh();
subscribeChanges(refresh);
