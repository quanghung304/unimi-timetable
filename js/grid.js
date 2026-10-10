// Renders one Mon–Fri week as a CSS grid of 30-minute rows.
import { toKey, addDays, toMin, fmtMin, ddmm } from "./dates.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PALETTE = [
  { bg: "#dcfce7", border: "#16a34a" }, { bg: "#fef9c3", border: "#ca8a04" },
  { bg: "#dbeafe", border: "#2563eb" }, { bg: "#fce7f3", border: "#db2777" },
  { bg: "#ede9fe", border: "#7c3aed" }, { bg: "#ffedd5", border: "#ea580c" },
  { bg: "#cffafe", border: "#0891b2" }, { bg: "#f1f5f9", border: "#475569" },
];

// Stable colour per course, computed over ALL of the user's courses (not just the visible
// week): each course hashes to a palette slot; on a clash it takes the next free slot.
// Courses are processed by first date, so a course added later (e.g. a language class)
// never takes the colour of a course that was already there.
function hash(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
export function courseColors(allSessions) {
  const first = new Map();
  for (const s of allSessions) if (!first.has(s.course) || s.date < first.get(s.course)) first.set(s.course, s.date);
  const courses = [...first.keys()].sort((a, b) => first.get(a).localeCompare(first.get(b)) || a.localeCompare(b));
  const used = new Set(), map = new Map();
  for (const c of courses) {
    let slot = hash(c.toLowerCase()) % PALETTE.length;
    for (let i = 0; used.has(slot) && i < PALETTE.length; i++) slot = (slot + 1) % PALETTE.length;
    used.add(slot);
    if (used.size >= PALETTE.length) used.clear();   // more courses than colours: start reusing
    map.set(c, PALETTE[slot]);
  }
  return map;
}

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function timeRange(sessions) {
  let lo = 8 * 60, hi = 19 * 60;
  for (const s of sessions) { lo = Math.min(lo, toMin(s.start)); hi = Math.max(hi, toMin(s.end)); }
  return { lo: Math.floor(lo / 60) * 60, hi: Math.ceil(hi / 60) * 60 };
}

// Assign side-by-side lanes to overlapping sessions within a day.
function layoutDay(list) {
  list.sort((a, b) => toMin(a.start) - toMin(b.start) || toMin(b.end) - toMin(a.end));
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const s of cluster) {
      let lane = lanes.findIndex(end => end <= toMin(s.start));
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = toMin(s.end);
      out.push({ s, lane, lanes: 0 });
    }
    out.slice(-cluster.length).forEach(o => o.lanes = lanes.length);
    cluster = []; clusterEnd = -1;
  };
  for (const s of list) {
    if (cluster.length && toMin(s.start) >= clusterEnd) flush();
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, toMin(s.end));
  }
  if (cluster.length) flush();
  return out;
}

// nDays: 5 (Mon–Fri) or 7 (Mon–Sun). note: optional line shown under the grid.
export function renderWeek(container, weekStart, sessions, colors, nDays = 5, note = "") {
  const color = c => colors.get(c) || PALETTE[PALETTE.length - 1];
  const days = Array.from({ length: nDays }, (_, i) => addDays(weekStart, i));
  const dayKeys = days.map(toKey);
  const todayKey = toKey(new Date());
  const { lo, hi } = timeRange(sessions);
  const nSlots = (hi - lo) / 30;

  let html = `<div class="corner"></div>`;
  days.forEach((d, i) => {
    html += `<div class="day-head${dayKeys[i] === todayKey ? " today" : ""}${i >= 5 ? " weekend" : ""}" style="grid-column:${i + 2};grid-row:1">${DAY_NAMES[i]} ${ddmm(d)}</div>`;
  });
  for (let k = 0; k < nSlots; k++) {
    const m = lo + k * 30, row = k + 2;
    html += `<div class="time${m % 60 ? " half" : ""}" style="grid-column:1;grid-row:${row}">${fmtMin(m)}</div>`;
    dayKeys.forEach((dk, i) => {
      html += `<div class="slot${m % 60 ? " half" : ""}${dk === todayKey ? " today" : i >= 5 ? " weekend" : ""}" data-date="${dk}" data-min="${m}" style="grid-column:${i + 2};grid-row:${row}"></div>`;
    });
  }

  let count = 0;
  dayKeys.forEach((dk, i) => {
    const list = sessions.filter(s => s.date === dk);
    count += list.length;
    for (const { s, lane, lanes } of layoutDay(list)) {
      const r0 = Math.round((toMin(s.start) - lo) / 30) + 2;
      const span = Math.max(1, Math.round((toMin(s.end) - toMin(s.start)) / 30));
      const c = color(s.course), w = 100 / lanes;
      const style = `grid-column:${i + 2};grid-row:${r0} / span ${span};background:${c.bg};border-color:${c.border};` +
        (lanes > 1 ? `width:calc(${w}% - 6px);margin-left:calc(${w * lane}% + 3px);` : "");
      const tip = `${s.course}\n${s.start} – ${s.end}\n${s.lecturer}\n${s.room}${s.note ? "\n\n📝 " + s.note : ""}`;
      const exam = /^exam$/i.test(s.type || "");
      html += `<button type="button" class="event${lanes > 1 ? " conflict" : ""}${exam ? " exam" : ""}" data-id="${esc(s.id)}" style="${style}" title="${esc(tip)}">
        ${s.modified ? `<span class="badge" title="Edited">✎</span>` : ""}
        ${exam ? `<span class="exam-tag">Exam</span>` : ""}
        <span class="course">${esc(s.course)}</span>
        <span class="info">${esc(s.start)} – ${esc(s.end)}${s.type ? " · " + esc(s.type) : ""}</span>
        ${s.room ? `<span class="info">📍 ${esc(s.room)}</span>` : ""}
        ${s.lecturer ? `<span class="info">👤 ${esc(s.lecturer)}</span>` : ""}
        ${s.note ? `<span class="note">📝 ${esc(s.note)}</span>` : ""}
      </button>`;
    }
  });

  const cols = `grid-template-columns:56px repeat(${nDays}, minmax(${nDays > 5 ? 115 : 130}px, 1fr));min-width:${56 + nDays * (nDays > 5 ? 115 : 130)}px`;
  const msgs = [count ? "" : "No sessions this week.", note].filter(Boolean).join(" ");
  container.innerHTML = `<div class="grid-wrap"><div class="grid" style="${cols};grid-template-rows:auto repeat(${nSlots}, var(--slot-h))">${html}</div></div>` +
    (msgs ? `<p class="week-empty">${esc(msgs)}</p>` : "");
  const grid = container.querySelector(".grid");
  grid.dataset.lo = lo;
  grid.dataset.hi = hi;
  drawNowLine(container);
}

export function drawNowLine(container) {
  const grid = container.querySelector(".grid");
  if (!grid) return;
  grid.querySelector(".now-line")?.remove();
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const lo = +grid.dataset.lo, hi = +grid.dataset.hi;
  if (mins < lo || mins >= hi) return;
  const slot = grid.querySelector(`.slot[data-date="${toKey(now)}"][data-min="${lo + Math.floor((mins - lo) / 30) * 30}"]`);
  if (!slot) return;
  const line = document.createElement("div");
  line.className = "now-line";
  line.style.left = slot.offsetLeft + "px";
  line.style.width = slot.offsetWidth + "px";
  line.style.top = slot.offsetTop + ((mins - lo) % 30) / 30 * slot.offsetHeight + "px";
  grid.appendChild(line);
}
