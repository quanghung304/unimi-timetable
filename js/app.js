import { ALLOWED_EMAIL_DOMAIN } from "./config.js";
import { remember } from "./supabase.js";
import * as api from "./api.js";
import { parseWorkbook, planMerge } from "./importer.js";
import { renderWeek, drawNowLine } from "./grid.js";
import { toKey, fromKey, addDays, toMin, fmtMin, ddmm, mondayOf, currentWeekStart } from "./dates.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const RESEND_SECONDS = 60;

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

// ---------- login (email OTP / magic link) ----------
let loginEmail = "", resendTimer;

function startResendCountdown() {
  let left = RESEND_SECONDS;
  const btn = $("resendBtn");
  btn.disabled = true;
  clearInterval(resendTimer);
  const tick = () => {
    btn.textContent = left > 0 ? `Resend code (${left}s)` : "Resend code";
    if (left-- <= 0) { clearInterval(resendTimer); btn.disabled = false; }
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

async function requestCode() {
  const email = $("loginEmail").value.trim().toLowerCase();
  $("loginErr").textContent = "";
  if (!email.endsWith("@" + ALLOWED_EMAIL_DOMAIN)) {
    $("loginErr").textContent = `Please use your @${ALLOWED_EMAIL_DOMAIN} address.`;
    return;
  }
  remember.set($("rememberMe").checked);
  try {
    await api.sendCode(email);
    loginEmail = email;
    $("sentTo").textContent = email;
    $("stepEmail").hidden = true;
    $("stepCode").hidden = false;
    $("loginCode").value = "";
    $("loginCode").focus();
    startResendCountdown();
  } catch (e) {
    $("loginErr").textContent = /rate|security purposes/i.test(errMsg(e))
      ? "Too many requests. Please wait a minute and try again."
      : "Could not send the code: " + errMsg(e);
  }
}

$("emailForm").addEventListener("submit", e => { e.preventDefault(); busy($("sendBtn"), requestCode); });
$("resendBtn").onclick = () => busy($("resendBtn"), async () => {
  try { await api.sendCode(loginEmail); toast("A new code has been sent"); startResendCountdown(); }
  catch (e) { $("codeErr").textContent = errMsg(e); }
});
$("changeEmail").onclick = () => { $("stepCode").hidden = true; $("stepEmail").hidden = false; $("codeErr").textContent = ""; };
$("codeForm").addEventListener("submit", e => {
  e.preventDefault();
  busy($("verifyBtn"), async () => {
    $("codeErr").textContent = "";
    try { await api.verifyCode(loginEmail, $("loginCode").value.trim()); }
    catch (err) { $("codeErr").textContent = "Invalid or expired code. Check the latest email, or resend."; }
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
  show("app");
  render();
}

function render() {
  const ws = state.weekStart, fri = addDays(ws, 4);
  $("weekLabel").textContent = `${ddmm(ws)} – ${ddmm(fri)}/${fri.getFullYear()}`;
  $("jumpDate").value = toKey(ws);
  const main = $("main");
  if (!state.sessions.length) {
    main.innerHTML = `<div class="empty"><h2>No timetable yet</h2>
      <p>Export your timetable from the UniMi website as <b>.xls</b>, then click <b>Import .xls</b>.<br>
      You can also add lessons by hand with <b>+ Add lesson</b>.</p></div>`;
  } else {
    const keys = new Set([0, 1, 2, 3, 4].map(i => toKey(addDays(ws, i))));
    renderWeek(main, ws, state.sessions.filter(s => keys.has(s.date)));
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
const dlg = $("editDlg"), form = $("editForm");

function openEditor(session, defaults) {
  state.editingId = session ? session.id : null;
  const s = session || { type: "Lezione", ...defaults };
  $("editTitle").textContent = session ? "Edit lesson" : "Add lesson";
  $("delBtn").hidden = !session;
  $("editErr").textContent = "";
  for (const k of FIELDS) form.elements[k].value = s[k] || "";
  dlg.showModal();
  (session ? form.elements.note : form.elements.course).focus();
}

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
  const now = new Date(), inWeek = mondayOf(now).getTime() === state.weekStart.getTime();
  openEditor(null, { date: toKey(inWeek ? now : state.weekStart), start: "09:30", end: "11:30" });
};
$("cancelBtn").onclick = () => dlg.close();

form.addEventListener("submit", e => {
  e.preventDefault();
  const f = Object.fromEntries(FIELDS.map(k => [k, form.elements[k].value.trim()]));
  if (toMin(f.end) <= toMin(f.start)) { $("editErr").textContent = "End time must be after start time."; return; }
  busy($("saveBtn"), async () => {
    try {
      let saved;
      if (state.editingId) {
        const old = state.sessions.find(s => s.id === state.editingId);
        // A note-only edit keeps the lesson in sync with future imports.
        const modified = old.modified || CORE.some(k => (old[k] || "") !== f[k]);
        saved = await api.updateSession(old.id, f, modified);
        state.sessions[state.sessions.indexOf(old)] = saved;
      } else {
        saved = await api.createSession(f);
        state.sessions.push(saved);
      }
      dlg.close();
      render();
      toast("Saved");
    } catch (err) { $("editErr").textContent = "Could not save: " + errMsg(err); }
  });
});

$("delBtn").onclick = () => {
  if (!confirm("Delete this lesson?")) return;
  busy($("delBtn"), async () => {
    try {
      await api.deleteSession(state.editingId);
      state.sessions = state.sessions.filter(s => s.id !== state.editingId);
      dlg.close(); render(); toast("Deleted");
    } catch (err) { $("editErr").textContent = "Could not delete: " + errMsg(err); }
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
    if (!parsed.sessions.length) throw new Error("No lessons found in this file.");
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

// ---------- profile ----------
const pDlg = $("profileDlg"), pForm = $("profileForm");
const PFIELDS = ["full_name", "course_of_study", "academic_year", "year_of_study"];

$("profileBtn").onclick = () => {
  pForm.elements.email.value = state.profile?.email || state.user.email;
  for (const k of PFIELDS) pForm.elements[k].value = state.profile?.[k] || "";
  $("profileErr").textContent = "";
  pDlg.showModal();
};
$("profileCancel").onclick = () => pDlg.close();
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
    $("stepCode").hidden = true; $("stepEmail").hidden = false;
    show("login");
  }
});
