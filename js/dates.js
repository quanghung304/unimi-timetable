// Date/time helpers. Everything is local time; date keys are "YYYY-MM-DD", times "HH:MM".
export const pad = n => String(n).padStart(2, "0");
export const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
export const toMin = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const ddmm = d => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;

export function mondayOf(d) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return addDays(r, -((r.getDay() + 6) % 7));
}

// All dates from..until (inclusive) falling on the given weekdays (0 = Mon … 6 = Sun).
export function weeklyDates(from, until, weekdays) {
  const out = [];
  for (let d = fromKey(from), end = fromKey(until); d <= end; d = addDays(d, 1))
    if (weekdays.includes((d.getDay() + 6) % 7)) out.push(toKey(d));
  return out;
}

// Weeks run Monday → Sunday; "this week" is the one containing today (also on weekends).
export const currentWeekStart = (now = new Date()) => mondayOf(now);
