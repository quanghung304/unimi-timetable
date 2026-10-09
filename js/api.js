// All server access goes through this module (auth + data).
import { sb } from "./supabase.js";

const COLS = "id,date,start_time,end_time,course,lecturer,room,type,note,source,source_key,modified";
const CORE = ["date", "start", "end", "course", "lecturer", "room", "type"];

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
export const sendCode = email =>
  sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } }).then(check);
export const verifyCode = (email, token) => sb.auth.verifyOtp({ email, token, type: "email" }).then(check);
export const signOut = () => sb.auth.signOut().then(check);
export const deleteAccount = () => sb.rpc("delete_my_account").then(check);

// ---------- profile ----------
export const loadProfile = () => sb.from("profiles").select("email,full_name,course_of_study,academic_year,year_of_study").single().then(check);
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
