// Parses the timetable export from UniMi's website (.xls) into session rows,
// and plans how to merge a new import into the sessions a user already has.
import { pad, toMin, fmtMin } from "./dates.js";

export const SLOT_MIN = 120;     // a lesson is normally 2 hours
export const MAX_ROWS = 2000;

// The export puts PDF-printing instructions in the Notes column; drop them.
const JUNK_NOTE = /PDF|Print button|Save button|choose the folder|File tab/i;
const META_KEYS = { "academic year": "academic_year", "course of study": "course_of_study", "year of study": "year_of_study" };

// A block whose length is a multiple of 2h (4h, 6h…) becomes consecutive 2h slots.
export function splitBlock(start, end) {
  const s = toMin(start), e = toMin(end), d = e - s;
  if (d <= SLOT_MIN || d % SLOT_MIN !== 0) return [[start, end]];
  const out = [];
  for (let t = s; t < e; t += SLOT_MIN) out.push([fmtMin(t), fmtMin(t + SLOT_MIN)]);
  return out;
}

const slug = s => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
export const sourceKey = (date, start, course) => `${date}_${start.replace(":", "")}_${slug(course)}`;

function parseDateCell(v) {
  if (typeof v === "number") { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const m = String(v).trim().match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
}

// rows: array of arrays (first sheet). Returns { meta, sessions }.
export function parseRows(rows) {
  const cell = v => String(v ?? "").trim();
  const hi = rows.findIndex(r => r.some(c => /^weekday$/i.test(cell(c))) && r.some(c => /^course$/i.test(cell(c))));
  if (hi < 0) throw new Error("This doesn't look like a UniMi timetable export (header row Weekday / Day / Hour / Course… not found).");
  const header = rows[hi].map(c => cell(c).toLowerCase());
  const col = name => header.indexOf(name);
  const c = { day: col("day"), hour: col("hour"), course: col("course"), lecturer: col("lecturer"), room: col("room"), notes: col("notes") };
  if (c.day < 0 || c.hour < 0) throw new Error("Columns Day and Hour are required.");

  const meta = {};
  for (const r of rows.slice(0, hi)) {
    const m = cell(r.find(x => cell(x))).match(/^([^:]+):\s*(.+)$/);
    const key = m && META_KEYS[m[1].trim().toLowerCase()];
    if (key) meta[key] = m[2].trim();
  }

  const body = rows.slice(hi + 1);
  if (body.length > MAX_ROWS) throw new Error(`File has too many rows (max ${MAX_ROWS}).`);

  const sessions = [], seen = new Set();
  for (const r of body) {
    const date = parseDateCell(r[c.day]);
    const hm = cell(r[c.hour]).match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    const course = cell(r[c.course]).slice(0, 200);
    if (!date || !hm || !course) continue;
    const start = fmtMin(toMin(hm[1])), end = fmtMin(toMin(hm[2]));
    if (toMin(end) <= toMin(start)) continue;
    const note = c.notes >= 0 ? cell(r[c.notes]) : "";
    for (const [s, e] of splitBlock(start, end)) {
      const key = sourceKey(date, s, course);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({
        date, start: s, end: e, course,
        lecturer: c.lecturer >= 0 ? cell(r[c.lecturer]).slice(0, 300) : "",
        room: c.room >= 0 ? cell(r[c.room]).slice(0, 200) : "",
        type: "",   // the export has no lesson-type column
        note: JUNK_NOTE.test(note) ? "" : note.slice(0, 2000),
        source: "import", source_key: key, modified: false,
      });
    }
  }
  return { meta, sessions };
}

export function parseWorkbook(XLSX, buf) {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return parseRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }));
}

// existing: the user's current sessions. incoming: parsed import.
// - new slots are inserted
// - imported slots the user has not edited are refreshed (their note is kept)
// - imported slots the user edited are left alone
// - imported, unedited, note-less slots missing from the new file are deleted
export function planMerge(existing, incoming) {
  const byKey = new Map(existing.filter(s => s.source_key).map(s => [s.source_key, s]));
  const inKeys = new Set(incoming.map(s => s.source_key));
  const inserts = [], updates = [];
  let kept = 0;
  for (const s of incoming) {
    const old = byKey.get(s.source_key);
    if (!old) inserts.push(s);
    else if (!old.modified) updates.push(s);
    else kept++;
  }
  const deletes = existing
    .filter(s => s.source === "import" && !s.modified && !s.note && !inKeys.has(s.source_key))
    .map(s => s.id);
  return { inserts, updates, deletes, kept };
}
