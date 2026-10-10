// All server access goes through this module (auth + data).
import { sb } from "./supabase.js";

const COLS = "id,date,start_time,end_time,course,lecturer,room,type,note,source,source_key,modified,series_id";
const CORE = ["date", "start", "end", "course", "lecturer", "room", "type"];
export const SERIES_FIELDS = CORE.filter(f => f !== "date");

const fromRow = r => ({ ...r, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) });
function toRow(s, fields) {
  const r = {};
  for (const f of fields) {
    if (f === "start") r.start_time = s.start;
    else if (f === "end") r.end_time = s.end;
    else r[f] = s[f];
  }
  return r;
}
const check = ({ data, error }) => { if (error) throw error; return data; };

// ---------- auth ----------
export function onAuthChange(cb) {
  // Supabase recommends not awaiting other calls inside this callback.
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => cb(session?.user ?? null), 0));
}
// Requires "Confirm email" OFF in Supabase, so sign-up returns a session right away.
export const signUp = (email, password) => sb.auth.signUp({ email, password }).then(check);
export const signIn = (email, password) => sb.auth.signInWithPassword({ email, password }).then(check);
export const changePassword = password => sb.auth.updateUser({ password }).then(check);
export const signOut = () => sb.auth.signOut().then(check);
export const deleteAccount = () => sb.rpc("delete_my_account").then(check);

// ---------- admin ----------
export const isAdmin = () => sb.rpc("is_admin").then(check);
export const adminResetPassword = (email, password) =>
  sb.rpc("admin_reset_password", { target_email: email, new_password: password }).then(check);

// ---------- profile ----------
export const loadProfile = () => sb.from("profiles").select("*").single().then(check);
export const saveProfile = (userId, p) => sb.from("profiles").update(p).eq("id", userId).then(check);

// ---------- sessions ----------
export async function loadSessions() {
  const all = [], page = 1000;
  for (let from = 0; ; from += page) {
    const rows = check(await sb.from("sessions").select(COLS).order("date").order("start_time").range(from, from + page - 1));
    all.push(...rows);
    if (rows.length < page) break;
  }
  return all.map(fromRow);
}

export async function createSession(s) {
  return fromRow(check(await sb.from("sessions").insert({ ...toRow(s, [...CORE, "note"]), source: "manual", modified: true }).select(COLS).single()));
}

export async function updateSession(id, s, modified) {
  return fromRow(check(await sb.from("sessions").update({ ...toRow(s, [...CORE, "note"]), modified }).eq("id", id).select(COLS).single()));
}

export const deleteSession = id => sb.from("sessions").delete().eq("id", id).then(check);

// ---------- weekly series ----------
export async function createSeries(list) {
  const series_id = crypto.randomUUID();
  const rows = list.map(s => ({ ...toRow(s, [...CORE, "note"]), source: "manual", modified: true, series_id }));
  return check(await sb.from("sessions").insert(rows).select(COLS)).map(fromRow);
}

// Applies time/course/room… (not date, not note) to lessons of a series on or after fromDate.
export const updateSeries = (seriesId, fromDate, s) =>
  sb.from("sessions").update({ ...toRow(s, SERIES_FIELDS), modified: true })
    .eq("series_id", seriesId).gte("date", fromDate).then(check);

export const deleteSeries = (seriesId, fromDate) =>
  sb.from("sessions").delete().eq("series_id", seriesId).gte("date", fromDate).then(check);

// Applies a plan from importer.planMerge. Updates leave `note` untouched.
export async function applyImport({ inserts, updates, deletes }) {
  const chunks = (arr, n = 500) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
  for (const c of chunks(inserts))
    check(await sb.from("sessions").insert(c.map(s => toRow(s, [...CORE, "note", "source", "source_key", "modified"]))));
  for (const c of chunks(updates))
    check(await sb.from("sessions").upsert(c.map(s => toRow(s, [...CORE, "source", "source_key"])), { onConflict: "user_id,source_key" }));
  for (const c of chunks(deletes, 200))
    check(await sb.from("sessions").delete().in("id", c));
}

// ---------- feedback ----------
const FB_COLS = "id,email,kind,rating,message,context,status,admin_reply,created_at,updated_at";
export const submitFeedback = f => sb.from("feedback").insert(f).then(check);
export const loadMyFeedback = userId =>
  sb.from("feedback").select(FB_COLS).eq("user_id", userId).order("created_at", { ascending: false }).limit(100).then(check);
export const loadAllFeedback = () =>   // admin only (RLS)
  sb.from("feedback").select(FB_COLS).order("created_at", { ascending: false }).limit(500).then(check);
export const updateFeedback = (id, patch) => sb.from("feedback").update(patch).eq("id", id).then(check);

// ---------- admin: users ----------
export const adminListUsers = () => sb.rpc("admin_list_users").then(check);
export const adminSetAdmin = (id, make) => sb.rpc("admin_set_admin", { target: id, make }).then(check);
export const adminSetBanned = (id, banned) => sb.rpc("admin_set_banned", { target: id, banned }).then(check);
export const adminDeleteUser = id => sb.rpc("admin_delete_user", { target: id }).then(check);
