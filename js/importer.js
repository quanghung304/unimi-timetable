// Parses timetable exports from UniMi's website (.xls) — lessons or exams — into session
// rows, and plans how to merge a new import into the sessions a user already has.
import { pad, toMin, fmtMin } from "./dates.js";

export const SLOT_MIN = 120;     // a lesson is normally 2 hours
export const MAX_ROWS = 2000;
// Imported exams get this source_key prefix, so lesson and exam imports never touch each other.
export const EXAM_PREFIX = "exam_";

// The export puts PDF-printing instructions in the Notes column; drop them.
const JUNK_NOTE = /PDF|Print button|Save button|choose the folder|File tab/i;
const META_KEYS = { "academic year": "academic_year", "course of study": "course_of_study", "year of study": "year_of_study" };
// "(Esame)" / "(Exam)" markers, possibly repeated, in exam course names.
const EXAM_TAG = /\s*\((esame|exam|appello)\)/gi;     // for replace()
const IS_EXAM = /\((esame|exam|appello)\)/i;              // for test() (no global state)
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7, agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12,
};

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

// Accepts Excel serial dates, "12-10-2026" / "12/10/2026", and "Wednesday 4 November 2026".
function parseDateCell(v) {
  if (typeof v === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const t = String(v).trim();
  let m = t.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = t.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/);
  const month = m && MONTHS[m[2].toLowerCase()];
  return month ? `${m[3]}-${pad(month)}-${pad(m[1])}` : null;
}

// Course name without "(Esame)" markers.
export const cleanExamCourse = name => name.replace(EXAM_TAG, "").replace(/\s+/g, " ").trim();

// rows: array of arrays (first sheet). kind: "lessons" | "exams" | undefined (= detect).
// Returns { meta, sessions, kind }.
export function parseRows(rows, kind) {
  const cell = v => String(v ?? "").trim();
  // Header row = the row with Day (or Date), Hour and Course columns.
  const isHeader = r => {
    const h = r.map(c => cell(c).toLowerCase());
    return (h.includes("day") || h.includes("date")) && h.includes("hour") && h.includes("course");
  };
  const hi = rows.findIndex(isHeader);
  if (hi < 0) throw new Error("Header row not found. The file needs columns named Day (or Date), Hour and Course (see the templates in Help).");
  const header = rows[hi].map(c => cell(c).toLowerCase());
  const col = name => header.indexOf(name);
  const c = {
    day: col("day") >= 0 ? col("day") : col("date"),
    hour: col("hour"), course: col("course"), lecturer: col("lecturer"),
    room: header.findIndex(h => h.startsWith("room")),          // "Room" or "Room and site"
    notes: col("notes"),
  };

  const body = rows.slice(hi + 1);
  if (body.length > MAX_ROWS) throw new Error(`File has too many rows (max ${MAX_ROWS}).`);

  // An exams export has a Date column (not Day) or "(Esame)" in course names.
  const detected = (col("day") < 0 && col("date") >= 0) || body.some(r => IS_EXAM.test(cell(r[c.course]))) ? "exams" : "lessons";
  kind = kind || detected;
  const exams = kind === "exams";

  const meta = {};
  for (const r of rows.slice(0, hi)) {
    const m = cell(r.find(x => cell(x))).match(/^([^:]+):\s*(.+)$/);
    const key = m && META_KEYS[m[1].trim().toLowerCase()];
    if (key) meta[key] = m[2].trim();
  }

  const sessions = [], seen = new Set();
  for (const r of body) {
    const date = parseDateCell(r[c.day]);
    // "14:30 - 16:30"; also accepts "14.30-16.30" and en/em dashes.
    const hm = cell(r[c.hour]).replace(/(\d)\.(\d{2})/g, "$1:$2").match(/(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})/);
    let course = cell(r[c.course]);
    if (exams) course = cleanExamCourse(course);
    course = course.slice(0, 200);
    if (!date || !hm || !course) continue;
    const start = fmtMin(toMin(hm[1])), end = fmtMin(toMin(hm[2]));
    if (toMin(end) <= toMin(start)) continue;
    const note = c.notes >= 0 ? cell(r[c.notes]) : "";
    // Lessons: 4h/6h blocks become 2h slots. Exams are kept whole.
    for (const [s, e] of exams ? [[start, end]] : splitBlock(start, end)) {
      const key = (exams ? EXAM_PREFIX : "") + sourceKey(date, s, course);
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({
        date, start: s, end: e, course,
        lecturer: c.lecturer >= 0 ? cell(r[c.lecturer]).slice(0, 300) : "",
        room: c.room >= 0 ? cell(r[c.room]).slice(0, 200) : "",
        type: exams ? "Exam" : "",   // the lessons export has no type column
        note: JUNK_NOTE.test(note) ? "" : note.slice(0, 2000),
        source: "import", source_key: key, modified: false,
      });
    }
  }
  return { meta, sessions, kind, detected };
}

export function parseWorkbook(XLSX, buf, kind) {
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return parseRows(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }), kind);
}

// The exams export may spell a course differently from the lessons export
// ("Statistical TheoryMathematics" vs "Statistical Theory and Mathematics").
// Use the user's existing name when both reduce to the same letters, ignoring "and"/"e"/"&",
// so the exam gets the same name and colour as the course's lessons.
const courseShape = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(and|e|ed|&)\b/g, " ").replace(/[^a-z0-9]/g, "");
export function alignCourseNames(sessions, knownCourses) {
  const byShape = new Map([...knownCourses].map(n => [courseShape(n), n]));
  for (const s of sessions) {
    const known = byShape.get(courseShape(s.course));
    if (known) s.course = known;
  }
  return sessions;
}

// existing: the user's current sessions. incoming: parsed import of one kind.
// Only imported sessions of the same kind are considered (lessons vs exams by key prefix).
// - new slots are inserted
// - imported slots the user has not edited are refreshed (their note is kept)
// - imported slots the user edited are left alone
// - imported, unedited, note-less slots missing from the new file are deleted
export function planMerge(existing, incoming, kind = "lessons") {
  const sameKind = s => !!s.source_key && s.source_key.startsWith(EXAM_PREFIX) === (kind === "exams");
  const mine = existing.filter(sameKind);
  const byKey = new Map(mine.map(s => [s.source_key, s]));
  const inKeys = new Set(incoming.map(s => s.source_key));
  const inserts = [], updates = [];
  let kept = 0;
  for (const s of incoming) {
    const old = byKey.get(s.source_key);
    if (!old) inserts.push(s);
    else if (!old.modified) updates.push(s);
    else kept++;
  }
  const deletes = mine
    .filter(s => s.source === "import" && !s.modified && !s.note && !inKeys.has(s.source_key))
    .map(s => s.id);
  return { inserts, updates, deletes, kept };
}
