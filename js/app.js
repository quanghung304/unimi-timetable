import { remember } from "./supabase.js";
import * as api from "./api.js";
import { parseWorkbook, planMerge } from "./importer.js";
import { renderWeek, drawNowLine, courseColors, esc } from "./grid.js";
import { pad, toKey, fromKey, addDays, toMin, fmtMin, ddmm, mondayOf, currentWeekStart, weeklyDates } from "./dates.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MIN_PASSWORD = 6;

const $ = id => document.getElementById(id);
const state = { user: null, profile: null, sessions: [], weekStart: currentWeekStart(), editingId: null };

// ---------- small UI helpers ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), isError ? 5000 : 2500);
}
const errMsg = e => e?.message || String(e);
function show(view) {
  for (const v of ["loading", "login", "app"]) $(`view-${v}`).hidden = v !== view;
}
async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

// ---------- show/hide toggle on every password field ----------
const EYE = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.6 5.1A10.7 10.7 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/></svg>`;

function setPasswordVisible(input, btn, visible) {
  input.type = visible ? "text" : "password";
  btn.innerHTML = visible ? EYE_OFF : EYE;
  btn.setAttribute("aria-label", visible ? "Hide password" : "Show password");
  btn.setAttribute("aria-pressed", String(visible));
}
for (const input of document.querySelectorAll("input[type=password]")) {
  const wrap = document.createElement("span");
  wrap.className = "pw-wrap";
  input.replaceWith(wrap);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pw-toggle";
  btn.title = "Show / hide password";
  btn.onclick = e => { e.preventDefault(); setPasswordVisible(input, btn, input.type === "password"); input.focus(); };
  setPasswordVisible(input, btn, false);
  wrap.append(input, btn);
}
const hideAllPasswords = () =>
  document.querySelectorAll(".pw-wrap").forEach(w => setPasswordVisible(w.querySelector("input"), w.querySelector(".pw-toggle"), false));

// ---------- login / sign-up (email + password) ----------
let mode = "signin";

function setMode(m) {
  mode = m;
  const up = m === "signup";
  $("tabSignIn").classList.toggle("active", !up);
  $("tabSignUp").classList.toggle("active", up);
  $("tabSignIn").setAttribute("aria-selected", String(!up));
  $("tabSignUp").setAttribute("aria-selected", String(up));
  $("confirmWrap").hidden = !up;
  $("forgotHint").hidden = up;
  $("authBtn").textContent = up ? "Create account" : "Sign in";
  $("authPassword").autocomplete = up ? "new-password" : "current-password";
  $("authErr").textContent = "";
}
$("tabSignIn").onclick = () => setMode("signin");
$("tabSignUp").onclick = () => setMode("signup");

function authError(e) {
  const m = errMsg(e);
  if (/invalid login credentials/i.test(m)) return "Wrong email or password.";
  if (/already registered|already exists/i.test(m)) return "This email already has an account. Sign in instead.";
  if (/database error saving new user/i.test(m)) return "Could not create the account. Please try again.";
  if (/rate limit|too many/i.test(m)) return "Too many attempts. Please wait a minute and try again.";
  return m;
}

$("authForm").addEventListener("submit", e => {
  e.preventDefault();
  const email = $("authEmail").value.trim().toLowerCase();
  const pw = $("authPassword").value;
  const err = $("authErr");
  err.textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = "Please enter a valid email address."; return; }
  if (pw.length < MIN_PASSWORD) { err.textContent = `Password must be at least ${MIN_PASSWORD} characters.`; return; }
  if (mode === "signup" && pw !== $("authPassword2").value) { err.textContent = "Passwords do not match."; return; }
  remember.set($("rememberMe").checked);
  busy($("authBtn"), async () => {
    try {
      if (mode === "signin") await api.signIn(email, pw);
      else {
        const { session } = await api.signUp(email, pw);
        if (!session) err.textContent = 'Account created, but "Confirm email" is still on in Supabase. Turn it off (see README).';
      }
    } catch (ex) { err.textContent = authError(ex); }
  });
});

// ---------- app ----------
async function enterApp(user) {
  state.user = user;
  show("loading");
  try {
    [state.profile, state.sessions] = await Promise.all([api.loadProfile(), api.loadSessions()]);
  } catch (e) {
    show("app");
    toast("Could not load your data: " + errMsg(e), true);
    return;
  }
  state.weekStart = currentWeekStart();
  $("userName").textContent = state.profile.full_name || user.email;
  $("adminBtn").hidden = true;
  api.isAdmin().then(yes => { $("adminBtn").hidden = !yes; }).catch(() => {});
  show("app");
  render();
  maybeShowGuide();
}

// ---------- weekend columns ----------
// auto: Sat/Sun columns appear only in weeks that have weekend sessions; show / hide: always.
const WEEKEND_KEY = "tt.weekend";
const WEEKEND_LABEL = { auto: "Auto", show: "Shown", hide: "Hidden" };
let weekendMode = "auto";
try { weekendMode = localStorage.getItem(WEEKEND_KEY) || "auto"; } catch { /* ignore */ }
if (!WEEKEND_LABEL[weekendMode]) weekendMode = "auto";

const weekendKeys = ws => [5, 6].map(i => toKey(addDays(ws, i)));
function showWeekend(ws = state.weekStart) {
  if (weekendMode !== "auto") return weekendMode === "show";
  const keys = weekendKeys(ws);
  return state.sessions.some(s => keys.includes(s.date));
}

function setWeekendMode(mode) {
  weekendMode = mode;
  try { localStorage.setItem(WEEKEND_KEY, mode); } catch { /* ignore */ }
  render();
}
function toggleWeekendPop(open) {
  $("weekendPop").hidden = !open;
  $("weekendBtn").setAttribute("aria-expanded", String(open));
  if (open) $("weekendPop").querySelector(`input[value="${weekendMode}"]`).checked = true;
}
$("weekendBtn").onclick = e => { e.stopPropagation(); toggleWeekendPop($("weekendPop").hidden); };
$("weekendPop").addEventListener("change", e => { setWeekendMode(e.target.value); toggleWeekendPop(false); });
$("weekendPop").addEventListener("click", e => e.stopPropagation());
document.addEventListener("click", () => toggleWeekendPop(false));
document.addEventListener("keydown", e => { if (e.key === "Escape") toggleWeekendPop(false); });

function render() {
  const ws = state.weekStart, nDays = showWeekend() ? 7 : 5, last = addDays(ws, nDays - 1);
  $("weekLabel").textContent = `${ddmm(ws)} – ${ddmm(last)}/${last.getFullYear()}`;
  $("weekendBtn").textContent = `Weekend: ${WEEKEND_LABEL[weekendMode]} ▾`;
  $("jumpDate").value = toKey(ws);
  const main = $("main");
  if (!state.sessions.length) {
    main.innerHTML = `<div class="empty"><h2>No timetable yet</h2>
      <p>Import the Excel export of your timetable with <b>Import Excel</b>,
      or add lessons and exams by hand with <b>+ Add session</b>.</p>
      <p><button type="button" class="primary" data-open-guide>Show me how</button></p></div>`;
  } else {
    const keys = new Set(Array.from({ length: nDays }, (_, i) => toKey(addDays(ws, i))));
    const hidden = nDays === 5 ? state.sessions.filter(s => weekendKeys(ws).includes(s.date)).length : 0;
    const note = hidden ? `${hidden} weekend session${hidden > 1 ? "s" : ""} hidden — change “Weekend” above to see ${hidden > 1 ? "them" : "it"}.` : "";
    renderWeek(main, ws, state.sessions.filter(s => keys.has(s.date)), courseColors(state.sessions), nDays, note);
  }
  fillDatalists();
}

function fillDatalists() {
  const set = (id, key) => {
    const vals = [...new Set(state.sessions.map(s => s[key]).filter(Boolean))].sort();
    const dl = $(id);
    dl.replaceChildren(...vals.map(v => Object.assign(document.createElement("option"), { value: v })));
  };
  set("courseList", "course"); set("lecturerList", "lecturer"); set("roomList", "room");
}

const go = d => { state.weekStart = d; render(); };
$("prevWeek").onclick = () => go(addDays(state.weekStart, -7));
$("nextWeek").onclick = () => go(addDays(state.weekStart, 7));
$("thisWeek").onclick = () => go(currentWeekStart());
$("jumpDate").onchange = e => { if (e.target.value) go(mondayOf(fromKey(e.target.value))); };
document.addEventListener("keydown", e => {
  if ($("view-app").hidden || document.querySelector("dialog[open]") || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft") $("prevWeek").click();
  if (e.key === "ArrowRight") $("nextWeek").click();
});
setInterval(() => drawNowLine($("main")), 60 * 1000);
window.addEventListener("resize", () => drawNowLine($("main")));

// ---------- edit dialog ----------
const FIELDS = ["course", "date", "start", "end", "lecturer", "room", "type", "note"];
const CORE = FIELDS.filter(f => f !== "note");
const MAX_SERIES = 200;
const dlg = $("editDlg"), form = $("editForm");
const dayBoxes = [...$("repeatDays").querySelectorAll("input")];
const weekdayOf = key => (fromKey(key).getDay() + 6) % 7;

// 24-hour time pickers (hour + minute selects). <input type="time"> shows AM/PM in the
// browser's own language, so we build our own; the hidden input keeps the "HH:MM" value.
const option = (value, text = value) => Object.assign(document.createElement("option"), { value, textContent: text });
const timePickers = [...form.querySelectorAll(".time-pick")].map(wrap => {
  const hidden = wrap.querySelector("input");
  const hh = document.createElement("select"), mm = document.createElement("select");
  hh.setAttribute("aria-label", "Hour");
  mm.setAttribute("aria-label", "Minutes");
  for (let h = 0; h < 24; h++) hh.append(option(pad(h)));
  for (let m = 0; m < 60; m += 5) mm.append(option(pad(m)));
  const sync = () => { hidden.value = `${hh.value}:${mm.value}`; hidden.dispatchEvent(new Event("input")); };
  hh.onchange = mm.onchange = sync;
  wrap.append(hh, document.createTextNode(":"), mm);
  return {
    set(v) {
      const [h, m] = (v || "09:00").split(":");
      if (![...mm.options].some(o => o.value === m)) mm.append(option(m));  // e.g. an imported 10:23
      hh.value = h; mm.value = m; hidden.value = `${h}:${m}`;
    },
  };
});

// Keep an unknown type (e.g. "Lezione" from earlier imports) selectable instead of losing it.
const TYPES = ["", "Lecture", "Exercise", "Lab", "Exam"];
function setType(v) {
  const sel = form.elements.type;
  sel.querySelector("option[data-extra]")?.remove();
  if (v && !TYPES.includes(v)) {
    const o = option(v);
    o.dataset.extra = "1";
    sel.append(o);
  }
  sel.value = v || "";
}

function openEditor(session, defaults) {
  state.editingId = session ? session.id : null;
  const s = session || { type: "", ...defaults };
  $("editTitle").textContent = session ? "Edit session" : "Add session";
  $("delBtn").hidden = !session;
  $("editErr").textContent = "";
  for (const k of ["course", "date", "lecturer", "room", "note"]) form.elements[k].value = s[k] || "";
  timePickers[0].set(s.start);
  timePickers[1].set(s.end);
  setType(s.type);
  // Repeat options only when adding; series scope only when editing a series lesson.
  $("repeatBox").hidden = !!session;
  $("repeatOn").checked = false;
  $("repeatUntil").value = "";
  $("scopeBox").hidden = !session?.series_id;
  form.elements.scope.value = "one";
  syncRepeat();
  dlg.showModal();
  (session ? form.elements.note : form.elements.course).focus();
}

function repeatDates() {
  const from = form.elements.date.value, until = $("repeatUntil").value;
  const days = dayBoxes.filter(b => b.checked).map(b => +b.value);
  return from && until && days.length ? weeklyDates(from, until, days) : [];
}

function syncRepeat() {
  const on = $("repeatOn").checked;
  $("repeatOpts").hidden = !on;
  $("dateLabel").textContent = on ? "Starts on" : "Date";
  if (!on) return;
  const dates = repeatDates();
  $("repeatPreview").textContent = !$("repeatUntil").value ? "Pick the last day of the series."
    : !dates.length ? "No sessions in that range on the selected days."
    : `${dates.length} session${dates.length > 1 ? "s" : ""}: ${ddmm(fromKey(dates[0]))} → ${ddmm(fromKey(dates.at(-1)))}/${dates.at(-1).slice(0, 4)}` +
      (dates.length > MAX_SERIES ? ` (max ${MAX_SERIES})` : "");
}

$("repeatOn").onchange = () => {
  // Default weekday = the day of the chosen date.
  if ($("repeatOn").checked && !dayBoxes.some(b => b.checked) && form.elements.date.value) {
    const wd = weekdayOf(form.elements.date.value);
    if (dayBoxes[wd]) dayBoxes[wd].checked = true;
  }
  syncRepeat();
};
for (const el of [...dayBoxes, $("repeatUntil"), form.elements.date]) el.addEventListener("input", syncRepeat);
dlg.addEventListener("close", () => dayBoxes.forEach(b => b.checked = false));

$("main").addEventListener("click", e => {
  const ev = e.target.closest(".event");
  if (ev) return openEditor(state.sessions.find(s => s.id === ev.dataset.id));
  const slot = e.target.closest(".slot");
  if (slot) {
    const m = +slot.dataset.min;
    openEditor(null, { date: slot.dataset.date, start: fmtMin(m), end: fmtMin(Math.min(m + 120, 23 * 60 + 30)) });
  }
});
$("addBtn").onclick = () => {
  // Today if it is a visible day of the shown week, else that week's Monday.
  const now = new Date();
  const inWeek = mondayOf(now).getTime() === state.weekStart.getTime() && (now.getDay() % 6 !== 0 || showWeekend());
  openEditor(null, { date: toKey(inWeek ? now : state.weekStart), start: "09:30", end: "11:30" });
};
$("cancelBtn").onclick = () => dlg.close();

form.addEventListener("submit", e => {
  e.preventDefault();
  const f = Object.fromEntries(FIELDS.map(k => [k, form.elements[k].value.trim()]));
  const err = $("editErr");
  if (toMin(f.end) <= toMin(f.start)) { err.textContent = "End time must be after start time."; return; }
  const repeat = !state.editingId && $("repeatOn").checked;
  const dates = repeat ? repeatDates() : [];
  if (repeat) {
    if (!$("repeatUntil").value) { err.textContent = "Pick the last day of the series."; return; }
    if (!dates.length) { err.textContent = "No sessions in that range on the selected days."; return; }
    if (dates.length > MAX_SERIES) { err.textContent = `Too many sessions (${dates.length}); max ${MAX_SERIES}.`; return; }
  }
  busy($("saveBtn"), async () => {
    try {
      let msg = "Saved";
      if (state.editingId) {
        const old = state.sessions.find(s => s.id === state.editingId);
        if (old.series_id && form.elements.scope.value === "following") {
          // Course/time/room… go to this and later lessons; date and note only to this one.
          await api.updateSeries(old.series_id, old.date, f);
          await api.updateSession(old.id, f, true);
          state.sessions = await api.loadSessions();
          msg = "Series updated";
        } else {
          // A note-only edit keeps the lesson in sync with future imports.
          const modified = old.modified || CORE.some(k => (old[k] || "") !== f[k]);
          state.sessions[state.sessions.indexOf(old)] = await api.updateSession(old.id, f, modified);
        }
      } else if (repeat) {
        state.sessions.push(...await api.createSeries(dates.map(date => ({ ...f, date }))));
        msg = `Added ${dates.length} sessions`;
      } else {
        state.sessions.push(await api.createSession(f));
      }
      dlg.close();
      render();
      toast(msg);
    } catch (ex) { err.textContent = "Could not save: " + errMsg(ex); }
  });
});

$("delBtn").onclick = () => {
  const old = state.sessions.find(s => s.id === state.editingId);
  const following = old.series_id && form.elements.scope.value === "following";
  const n = following ? state.sessions.filter(s => s.series_id === old.series_id && s.date >= old.date).length : 1;
  if (!confirm(following ? `Delete this and the following sessions of the series (${n})?` : "Delete this session?")) return;
  busy($("delBtn"), async () => {
    try {
      if (following) {
        await api.deleteSeries(old.series_id, old.date);
        state.sessions = state.sessions.filter(s => !(s.series_id === old.series_id && s.date >= old.date));
      } else {
        await api.deleteSession(old.id);
        state.sessions = state.sessions.filter(s => s.id !== old.id);
      }
      dlg.close(); render(); toast(n > 1 ? `Deleted ${n} sessions` : "Deleted");
    } catch (ex) { $("editErr").textContent = "Could not delete: " + errMsg(ex); }
  });
};

// ---------- import ----------
$("xlsFile").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) return toast("File is too large (max 2 MB).", true);
  const label = $("importLabel");
  label.classList.add("disabled");
  try {
    const XLSX = await import(SHEETJS_URL);
    const parsed = parseWorkbook(XLSX, await file.arrayBuffer());
    if (!parsed.sessions.length) throw new Error("No sessions found in this file.");
    const plan = planMerge(state.sessions, parsed.sessions);
    await api.applyImport(plan);
    state.sessions = await api.loadSessions();
    await prefillProfile(parsed.meta);
    render();
    toast(`Imported: ${plan.inserts.length} new, ${plan.updates.length} updated, ${plan.deletes.length} removed` +
      (plan.kept ? `, ${plan.kept} kept as you edited them` : ""));
  } catch (err) {
    toast("Import failed: " + errMsg(err), true);
  } finally {
    label.classList.remove("disabled");
  }
};

// Fill empty profile fields from the export header (course, academic year, year of study).
async function prefillProfile(meta) {
  const patch = {};
  for (const k of ["course_of_study", "academic_year", "year_of_study"])
    if (meta[k] && !state.profile[k]) patch[k] = meta[k];
  if (!Object.keys(patch).length) return;
  try {
    await api.saveProfile(state.user.id, patch);
    Object.assign(state.profile, patch);
  } catch { /* not critical */ }
}

// ---------- how-to guide ----------
// Shown automatically once per account: it is marked as seen as soon as it opens
// (profiles.guide_seen, plus a per-device fallback in case the column is missing).
// "? Help" reopens it any time.
const guideDlg = $("guideDlg");
const guideKey = () => `tt.guideSeen.${state.user?.id}`;

function openGuide(tab = "unimi") {
  setGuideTab(tab);
  guideDlg.showModal();
}
function setGuideTab(tab) {
  guideDlg.querySelectorAll("[data-guide]").forEach(b => {
    b.classList.toggle("active", b.dataset.guide === tab);
    b.setAttribute("aria-selected", String(b.dataset.guide === tab));
  });
  guideDlg.querySelectorAll("[data-guide-panel]").forEach(p => p.hidden = p.dataset.guidePanel !== tab);
}
function maybeShowGuide() {
  let seenHere = false;
  try { seenHere = localStorage.getItem(guideKey()) === "1"; } catch { /* ignore */ }
  if (state.profile?.guide_seen || seenHere) return;
  openGuide();
  markGuideSeen();
}
function markGuideSeen() {
  try { localStorage.setItem(guideKey(), "1"); } catch { /* ignore */ }
  if (state.profile && !state.profile.guide_seen) {
    state.profile.guide_seen = true;
    api.saveProfile(state.user.id, { guide_seen: true }).catch(() => {});
  }
}

guideDlg.querySelectorAll("[data-guide]").forEach(b => b.onclick = () => setGuideTab(b.dataset.guide));
$("guideClose").onclick = () => guideDlg.close();
$("helpBtn").onclick = () => openGuide();
$("main").addEventListener("click", e => { if (e.target.closest("[data-open-guide]")) openGuide(); });

// Template for students of other universities: same layout as the UniMi export.
$("templateBtn").onclick = async () => {
  try {
    const XLSX = await import(SHEETJS_URL);
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Academic year: 2026/2027"],
      ["Course of study: <your course of study>"],
      ["Year of study: 1"],
      [], [],
      ["Weekday", "Day", "Hour", "Course", "Lecturer", "Academic trail", "Room", "Notes"],
      ["Monday", "12-10-2026", "09:30 - 11:30", "Microeconomics", "Rossi Mario", "", "Aula 1", ""],
      ["Monday", "12-10-2026", "14:30 - 18:30", "Data Analysis Lab", "Bianchi Anna", "", "Lab 3", "4h block: shown as two 2h slots"],
      ["Wednesday", "14-10-2026", "11:30 - 13:30", "Microeconomics", "Rossi Mario", "", "Aula 1", ""],
    ]);
    sheet["!cols"] = [11, 12, 15, 34, 22, 14, 16, 32].map(wch => ({ wch }));
    const help = XLSX.utils.aoa_to_sheet([
      ["How to fill in this template"],
      ["• One row per session (lesson or exam), below the header row (Weekday, Day, Hour, Course…). Don't rename or move the header."],
      ["• Day: dd-mm-yyyy, e.g. 12-10-2026.   Hour: HH:MM - HH:MM in 24-hour time, e.g. 14:30 - 16:30."],
      ["• Course is required. Weekday, Lecturer, Academic trail, Room and Notes are optional."],
      ["• Rows 1–3 (Academic year, Course of study, Year of study) fill in your profile; you can leave them out."],
      ["• Replace the example rows with your own. Only the first sheet is imported."],
    ]);
    help["!cols"] = [{ wch: 110 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, "Timetable");
    XLSX.utils.book_append_sheet(wb, help, "How to fill in");
    XLSX.writeFile(wb, "timetable-template.xlsx");
  } catch (ex) { toast("Could not create the template: " + errMsg(ex), true); }
};

// ---------- feedback ----------
const fbDlg = $("feedbackDlg"), fbForm = $("fbForm");
const FB_KIND = { review: "⭐ Review", bug: "🐞 Bug", feature: "💡 Feature" };
const FB_STATUS = { new: "New", in_progress: "In progress", done: "Done", wont_fix: "Won't fix" };
const FB_PLACEHOLDER = {
  review: ["Your review", "What do you like? What could be better?"],
  bug: ["What went wrong?", "What did you do, what did you expect, and what happened instead?"],
  feature: ["Your idea", "Which feature or improvement would help you?"],
};
let fbRating = 0, fbAll = [];

const fmtDateTime = iso => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const stars = n => n ? "★".repeat(n) + "☆".repeat(5 - n) : "";

function setFbTab(tab) {
  fbDlg.querySelectorAll("[data-fb-tab]").forEach(b => {
    b.classList.toggle("active", b.dataset.fbTab === tab);
    b.setAttribute("aria-selected", String(b.dataset.fbTab === tab));
  });
  fbDlg.querySelectorAll("[data-fb-panel]").forEach(p => p.hidden = p.dataset.fbPanel !== tab);
  if (tab === "mine") loadMine();
}

function setRating(n) {
  fbRating = n;
  $("fbRating").querySelectorAll("[data-star]").forEach(b => {
    b.classList.toggle("on", +b.dataset.star <= n);
    b.setAttribute("aria-pressed", String(+b.dataset.star === n));
  });
}

function syncKind() {
  const kind = fbForm.elements.kind.value;
  $("fbRating").hidden = kind !== "review";
  $("fbContextWrap").hidden = kind !== "bug";
  const [label, ph] = FB_PLACEHOLDER[kind];
  $("fbMsgLabel").textContent = label;
  fbForm.elements.message.placeholder = ph;
}

function openFeedback() {
  $("fbErr").textContent = "";
  syncKind();
  setFbTab("send");
  fbDlg.showModal();
}

function itemHtml(f, admin) {
  const head = `<div class="fb-head"><b>${FB_KIND[f.kind]}</b>
    ${f.rating ? `<span style="color:#f59e0b">${stars(f.rating)}</span>` : ""}
    <span class="badge-st ${f.status}">${FB_STATUS[f.status]}</span>
    <span>${fmtDateTime(f.created_at)}</span>${admin ? ` · <span>${esc(f.email)}</span>` : ""}</div>
    <div class="fb-msg">${esc(f.message)}</div>`;
  if (!admin)
    return `<div class="fb-item">${head}${f.admin_reply ? `<div class="fb-reply"><b>Reply:</b> ${esc(f.admin_reply)}</div>` : ""}</div>`;
  const ctx = Object.keys(f.context || {}).length ? `<details class="small muted"><summary>Technical info</summary><pre class="fb-msg">${esc(JSON.stringify(f.context, null, 1))}</pre></details>` : "";
  return `<div class="fb-item" data-fb-id="${esc(f.id)}">${head}${ctx}
    <div class="fb-admin">
      <select data-fb-status>${Object.entries(FB_STATUS).map(([v, t]) => `<option value="${v}"${v === f.status ? " selected" : ""}>${t}</option>`).join("")}</select>
      <textarea data-fb-reply maxlength="4000" placeholder="Reply to the user (optional)">${esc(f.admin_reply)}</textarea>
      <button type="button" class="primary" data-fb-save>Save</button>
    </div></div>`;
}

async function loadMine() {
  const box = $("fbMine");
  box.innerHTML = `<p class="muted small">Loading…</p>`;
  try {
    const list = await api.loadMyFeedback(state.user.id);
    box.innerHTML = list.length ? list.map(f => itemHtml(f, false)).join("") : `<p class="muted small">You haven't sent any feedback yet.</p>`;
  } catch (ex) { box.innerHTML = `<p class="err">Could not load: ${esc(errMsg(ex))}</p>`; }
}

async function loadAll() {
  $("fbAll").innerHTML = `<p class="muted small">Loading…</p>`;
  try { fbAll = await api.loadAllFeedback(); renderAll(); }
  catch (ex) { $("fbAll").innerHTML = `<p class="err">Could not load: ${esc(errMsg(ex))}</p>`; }
}

function renderAll() {
  const k = $("fbFilterKind").value, st = $("fbFilterStatus").value;
  const list = fbAll.filter(f => (!k || f.kind === k) && (!st || f.status === st));
  const reviews = fbAll.filter(f => f.rating);
  const avg = reviews.length ? (reviews.reduce((a, f) => a + f.rating, 0) / reviews.length).toFixed(1) : "–";
  $("fbAdminSummary").textContent = `${fbAll.length} total · ${fbAll.filter(f => f.status === "new").length} new · average rating ${avg} (${reviews.length} reviews)`;
  $("fbAll").innerHTML = list.length ? list.map(f => itemHtml(f, true)).join("") : `<p class="muted small">Nothing here.</p>`;
}

fbDlg.querySelectorAll("[data-fb-tab]").forEach(b => b.onclick = () => setFbTab(b.dataset.fbTab));
fbDlg.querySelectorAll(".fb-close").forEach(b => b.onclick = () => fbDlg.close());
$("feedbackBtn").onclick = openFeedback;
fbForm.querySelectorAll("input[name=kind]").forEach(r => r.onchange = syncKind);
$("fbRating").querySelectorAll("[data-star]").forEach(b => b.onclick = () => setRating(+b.dataset.star));
$("fbFilterKind").onchange = $("fbFilterStatus").onchange = renderAll;

fbForm.addEventListener("submit", e => {
  e.preventDefault();
  const kind = fbForm.elements.kind.value, message = fbForm.elements.message.value.trim(), err = $("fbErr");
  err.textContent = "";
  if (kind === "review" && !fbRating) { err.textContent = "Please pick a rating (1–5 stars)."; return; }
  if (!message) { err.textContent = "Please write a message."; return; }
  const context = kind === "bug" && fbForm.elements.withContext.checked ? {
    userAgent: navigator.userAgent, language: navigator.language,
    screen: `${screen.width}x${screen.height}`, viewport: `${innerWidth}x${innerHeight}`,
    url: location.href, week: toKey(state.weekStart), lessons: state.sessions.length,
  } : {};
  busy($("fbSend"), async () => {
    try {
      await api.submitFeedback({ kind, message, rating: kind === "review" ? fbRating : null, context });
      fbForm.reset();
      setRating(0);
      syncKind();
      fbDlg.close();
      toast("Thank you for your feedback!");
    } catch (ex) { err.textContent = "Could not send: " + errMsg(ex); }
  });
});

// Admin: save status / reply of one item.
$("fbAll").addEventListener("click", e => {
  const btn = e.target.closest("[data-fb-save]");
  if (!btn) return;
  const item = btn.closest("[data-fb-id]"), id = item.dataset.fbId;
  const patch = { status: item.querySelector("[data-fb-status]").value, admin_reply: item.querySelector("[data-fb-reply]").value.trim() };
  busy(btn, async () => {
    try {
      await api.updateFeedback(id, patch);
      Object.assign(fbAll.find(f => f.id === id), patch);
      renderAll();
      toast("Saved");
    } catch (ex) { toast("Could not save: " + errMsg(ex), true); }
  });
});

// ---------- admin: users + feedback ----------
const adminDlg = $("adminDlg");
let users = [];

const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("en-GB") : "never";
const daysAgo = iso => iso ? (Date.now() - new Date(iso)) / 86400000 : Infinity;

function setAdminTab(tab) {
  adminDlg.querySelectorAll("[data-admin-tab]").forEach(b => {
    b.classList.toggle("active", b.dataset.adminTab === tab);
    b.setAttribute("aria-selected", String(b.dataset.adminTab === tab));
  });
  adminDlg.querySelectorAll("[data-admin-panel]").forEach(p => p.hidden = p.dataset.adminPanel !== tab);
  if (tab === "users") loadUsers();
  if (tab === "feedback") loadAll();
}

async function loadUsers() {
  $("userList").innerHTML = `<p class="muted small">Loading…</p>`;
  try { users = await api.adminListUsers(); renderUsers(); }
  catch (ex) { $("userList").innerHTML = `<p class="err">Could not load users: ${esc(errMsg(ex))}</p>`; }
}

function renderUsers() {
  const q = $("userSearch").value.trim().toLowerCase();
  const list = users.filter(u => !q || [u.email, u.full_name, u.university, u.course_of_study].some(v => (v || "").toLowerCase().includes(q)));
  $("userSummary").textContent = `${users.length} users · ${users.filter(u => daysAgo(u.last_sign_in_at) <= 7).length} active in the last 7 days · ` +
    `${users.filter(u => u.is_admin).length} admin · ${users.filter(u => u.banned).length} disabled`;
  $("userList").innerHTML = list.length ? list.map(u => {
    const me = u.id === state.user.id;
    const info = [u.full_name, u.university, u.course_of_study].filter(Boolean).map(esc).join(" · ");
    return `<div class="fb-item" data-user-id="${esc(u.id)}">
      <div class="fb-head"><b style="color:var(--text)">${esc(u.email)}</b>
        ${me ? `<span class="badge-st new">You</span>` : ""}
        ${u.is_admin ? `<span class="badge-st in_progress">Admin</span>` : ""}
        ${u.banned ? `<span class="badge-st wont_fix">Disabled</span>` : ""}</div>
      ${info ? `<div>${info}</div>` : ""}
      <div class="small muted">Joined ${fmtDate(u.created_at)} · last sign-in ${fmtDate(u.last_sign_in_at)} · ${u.sessions} sessions · ${u.feedback} feedback</div>
      <div class="user-actions">
        <button type="button" data-act="reset">Reset password</button>
        ${me ? "" : `
        <button type="button" data-act="admin">${u.is_admin ? "Remove admin" : "Make admin"}</button>
        <button type="button" data-act="ban">${u.banned ? "Enable" : "Disable"}</button>
        <button type="button" class="danger" data-act="delete">Delete</button>`}
      </div>
    </div>`;
  }).join("") : `<p class="muted small">No users found.</p>`;
}

function tempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(crypto.getRandomValues(new Uint32Array(10)), n => chars[n % chars.length]).join("");
}

$("userList").addEventListener("click", e => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const u = users.find(x => x.id === btn.closest("[data-user-id]").dataset.userId);
  const run = (fn, msg) => busy(btn, async () => {
    try { await fn(); toast(msg); await loadUsers(); }
    catch (ex) { toast(errMsg(ex), true); }
  });
  switch (btn.dataset.act) {
    case "reset": {
      const pw = prompt(`Temporary password for ${u.email} (min. ${MIN_PASSWORD} characters):`, tempPassword());
      if (pw == null) return;
      if (pw.length < MIN_PASSWORD) return toast(`At least ${MIN_PASSWORD} characters.`, true);
      busy(btn, async () => {
        try {
          await api.adminResetPassword(u.email, pw);
          alert(`Password of ${u.email} is now:\n\n${pw}\n\nSend it to the user and ask them to change it in Profile.`);
        } catch (ex) { toast(errMsg(ex), true); }
      });
      break;
    }
    case "admin":
      if (confirm(u.is_admin ? `Remove admin rights from ${u.email}?` : `Give admin rights to ${u.email}? They will see all users and feedback.`))
        run(() => api.adminSetAdmin(u.id, !u.is_admin), u.is_admin ? "Admin rights removed" : "Admin rights given");
      break;
    case "ban":
      if (confirm(u.banned ? `Enable ${u.email} again?` : `Disable ${u.email}? They will not be able to sign in.`))
        run(() => api.adminSetBanned(u.id, !u.banned), u.banned ? "Account enabled" : "Account disabled");
      break;
    case "delete":
      if (prompt(`This permanently deletes ${u.email} with all their sessions and feedback.\nType the email to confirm:`)?.trim().toLowerCase() === u.email.toLowerCase())
        run(() => api.adminDeleteUser(u.id), "User deleted");
      break;
  }
});

adminDlg.querySelectorAll("[data-admin-tab]").forEach(b => b.onclick = () => setAdminTab(b.dataset.adminTab));
$("userSearch").addEventListener("input", renderUsers);
$("adminBtn").onclick = () => { adminDlg.showModal(); setAdminTab("users"); };
$("adminClose").onclick = () => adminDlg.close();

// ---------- profile ----------
const pDlg = $("profileDlg"), pForm = $("profileForm");
const PFIELDS = ["full_name", "university", "course_of_study", "academic_year", "year_of_study"];
// UniMi addresses don't need the (optional) university field.
const isUnimiEmail = email => /@(studenti\.)?unimi\.it$/i.test(email || "");

$("profileBtn").onclick = () => {
  pForm.elements.email.value = state.profile?.email || state.user.email;
  for (const k of PFIELDS) pForm.elements[k].value = state.profile?.[k] || "";
  $("universityWrap").hidden = isUnimiEmail(pForm.elements.email.value) && !state.profile?.university;
  $("profileErr").textContent = $("passwordErr").textContent = "";
  $("passwordForm").reset();
  pDlg.showModal();
};
$("profileCancel").onclick = () => pDlg.close();

$("passwordForm").addEventListener("submit", e => {
  e.preventDefault();
  const f = e.target.elements, err = $("passwordErr");
  if (f.pw1.value.length < MIN_PASSWORD) { err.textContent = `At least ${MIN_PASSWORD} characters.`; return; }
  if (f.pw1.value !== f.pw2.value) { err.textContent = "Passwords do not match."; return; }
  busy($("passwordSave"), async () => {
    try {
      await api.changePassword(f.pw1.value);
      e.target.reset();
      err.textContent = "";
      toast("Password updated");
    } catch (ex) {
      err.textContent = /different from the old/i.test(errMsg(ex)) ? "New password must differ from the current one." : errMsg(ex);
    }
  });
});

pForm.addEventListener("submit", e => {
  e.preventDefault();
  const p = Object.fromEntries(PFIELDS.map(k => [k, pForm.elements[k].value.trim()]));
  busy($("profileSave"), async () => {
    try {
      await api.saveProfile(state.user.id, p);
      Object.assign(state.profile, p);
      $("userName").textContent = p.full_name || state.user.email;
      pDlg.close();
      toast("Profile saved");
    } catch (err) { $("profileErr").textContent = "Could not save: " + errMsg(err); }
  });
});

$("exportBtn").onclick = () => {
  const data = { exported_at: new Date().toISOString(), profile: state.profile, sessions: state.sessions };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `timetable-${toKey(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

$("deleteAccountBtn").onclick = () => {
  const typed = prompt('This permanently deletes your account, profile and timetable.\nType DELETE to confirm.');
  if (typed !== "DELETE") return;
  busy($("deleteAccountBtn"), async () => {
    try {
      await api.deleteAccount();
      await api.signOut().catch(() => {});
      pDlg.close();
      toast("Your account has been deleted");
    } catch (err) { $("profileErr").textContent = "Could not delete account: " + errMsg(err); }
  });
};

$("signOutBtn").onclick = () => busy($("signOutBtn"), () => api.signOut().catch(e => toast(errMsg(e), true)));

// ---------- start ----------
$("rememberMe").checked = remember.get();
api.onAuthChange(user => {
  if (user && user.id !== state.user?.id) enterApp(user);
  else if (!user) {
    state.user = null; state.profile = null; state.sessions = [];
    $("authPassword").value = $("authPassword2").value = "";
    hideAllPasswords();
    show("login");
  }
});
