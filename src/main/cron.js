'use strict';

// Pure 5-field cron engine: parse/expand, next-occurrence scan (local or UTC wall
// clock), and whole-hour timezone shifting. No IO; callers supply `from` explicitly
// wherever determinism matters (tests, previews).

class CronError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'CronError';
    this.reason = reason;
  }
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
];

function parseField(raw, spec) {
  if (!/^[\d*,/-]+$/.test(raw)) {
    throw new CronError(`unsupported ${spec.name} field "${raw}" (names and L/W/? are not supported)`);
  }
  const values = new Set();
  for (const part of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`cannot parse ${spec.name} field "${part}"`);
    const [, range, stepStr] = m;
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (step < 1) throw new CronError(`step must be >= 1 in ${spec.name} field "${part}"`);
    let lo;
    let hi;
    if (range === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (range.includes('-')) {
      [lo, hi] = range.split('-').map(Number);
    } else {
      lo = Number(range);
      hi = stepStr === undefined ? lo : spec.max; // vixie: "N/step" means N through max
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new CronError(`${spec.name} value out of range in "${part}"`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  let sorted = [...values].sort((a, b) => a - b);
  if (spec.name === 'day-of-week') {
    sorted = [...new Set(sorted.map((d) => d % 7))].sort((a, b) => a - b);
  }
  // `star` drives the vixie dom/dow rule: fields *starting* with `*` count as unrestricted.
  return { raw, star: raw.startsWith('*'), values: sorted };
}

function parseCron(expr) {
  if (typeof expr !== 'string' || expr.trim() === '') {
    throw new CronError('cron expression must be a non-empty string');
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(`expected 5 cron fields, got ${parts.length}`);
  }
  const [minute, hour, dom, month, dow] = parts.map((raw, i) => parseField(raw, FIELDS[i]));
  return { minute, hour, dom, month, dow };
}

function accessors(utc) {
  return utc
    ? {
        minute: (d) => d.getUTCMinutes(),
        hour: (d) => d.getUTCHours(),
        date: (d) => d.getUTCDate(),
        month: (d) => d.getUTCMonth() + 1,
        day: (d) => d.getUTCDay(),
        year: (d) => d.getUTCFullYear(),
      }
    : {
        minute: (d) => d.getMinutes(),
        hour: (d) => d.getHours(),
        date: (d) => d.getDate(),
        month: (d) => d.getMonth() + 1,
        day: (d) => d.getDay(),
        year: (d) => d.getFullYear(),
      };
}

function dayMatches(p, g, t) {
  const domHit = p.dom.values.includes(g.date(t));
  const dowHit = p.dow.values.includes(g.day(t));
  if (p.dom.star && p.dow.star) return true;
  if (p.dom.star) return dowHit;
  if (p.dow.star) return domHit;
  return domHit || dowHit; // vixie OR when both are restricted
}

function startOfNextDay(t, utc) {
  const d = new Date(t);
  if (utc) d.setUTCHours(24, 0, 0, 0);
  else d.setHours(24, 0, 0, 0);
  return d;
}

function startOfNextMonth(t, utc) {
  const g = accessors(utc);
  // g.month() is 1-based, so passing it as a 0-based month index yields the next month.
  return utc ? new Date(Date.UTC(g.year(t), g.month(t), 1)) : new Date(g.year(t), g.month(t), 1);
}

/**
 * The next `count` occurrences strictly after `from`, scanned minute-by-minute with
 * month/day/hour skips, bounded at 366 days (an expression that never matches, e.g.
 * Feb 30, simply returns fewer results).
 */
function nextOccurrences(expr, { utc = false, from, count = 3 } = {}) {
  const p = parseCron(expr);
  const g = accessors(utc);
  const start = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(start.getTime())) throw new CronError('invalid "from" date');
  const limit = start.getTime() + 366 * 24 * 60 * 60 * 1000;
  const out = [];
  let t = new Date((Math.floor(start.getTime() / 60000) + 1) * 60000);
  while (out.length < count && t.getTime() <= limit) {
    if (!p.month.values.includes(g.month(t))) {
      t = startOfNextMonth(t, utc);
    } else if (!dayMatches(p, g, t)) {
      t = startOfNextDay(t, utc);
    } else if (!p.hour.values.includes(g.hour(t))) {
      t = new Date((Math.floor(t.getTime() / 3600000) + 1) * 3600000);
    } else if (!p.minute.values.includes(g.minute(t))) {
      t = new Date(t.getTime() + 60000);
    } else {
      out.push(t);
      t = new Date(t.getTime() + 60000);
    }
  }
  return out;
}

/** Smallest gap in minutes between consecutive occurrences (sampled over the next few). */
function minIntervalMinutes(expr, { utc = false, from = new Date() } = {}) {
  const occ = nextOccurrences(expr, { utc, from, count: 5 });
  if (occ.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 1; i < occ.length; i++) {
    min = Math.min(min, (occ[i].getTime() - occ[i - 1].getTime()) / 60000);
  }
  return min;
}

/** Sorted/deduped ints back to cron list syntax; runs of >= 3 become "a-b". */
function compress(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}-${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return parts.join(',');
}

/** Canonical form: every non-`*` field expanded and re-compressed (steps disappear). */
function normalize(expr) {
  const p = parseCron(expr);
  return [p.minute, p.hour, p.dom, p.month, p.dow]
    .map((f) => (f.raw === '*' ? '*' : compress(f.values)))
    .join(' ');
}

/**
 * Shift a cron's hours by a whole-hour timezone offset (local->UTC uses a positive
 * offset for zones west of UTC, matching getTimezoneOffset()/60).
 * Returns { expr } or { unsupported: reason } when the shift cannot be expressed
 * as a single cron (the UI then asks for a manually entered target cron).
 */
function shiftCron(expr, offsetHours) {
  let p;
  try {
    p = parseCron(expr);
  } catch (err) {
    if (err instanceof CronError) return { unsupported: err.reason };
    throw err;
  }
  if (!Number.isInteger(offsetHours) || Math.abs(offsetHours) > 23) {
    return { unsupported: 'timezone offset is not a whole number of hours' };
  }
  const unchanged = [p.minute.raw, p.hour.raw, p.dom.raw, p.month.raw, p.dow.raw].join(' ');
  if (offsetHours === 0 || p.hour.raw === '*') return { expr: unchanged };

  const shifted = p.hour.values.map((h) => h + offsetHours);
  const wrapped = shifted.filter((h) => h < 0 || h > 23);
  const mod24 = (h) => ((h % 24) + 24) % 24;
  const rebuild = (hours, dowText) =>
    [p.minute.raw, compress(hours.map(mod24)), p.dom.raw, p.month.raw, dowText].join(' ');

  const daysFree = p.dom.raw === '*' && p.month.raw === '*' && p.dow.raw === '*';
  if (daysFree) return { expr: rebuild(shifted, p.dow.raw) };
  if (wrapped.length === 0) return { expr: rebuild(shifted, p.dow.raw) };
  if (p.dom.raw !== '*' || p.month.raw !== '*') {
    return {
      unsupported:
        'the schedule is pinned to calendar dates and the shift crosses midnight — enter the target cron manually',
    };
  }
  if (wrapped.length !== shifted.length) {
    return {
      unsupported:
        'some times cross midnight and some do not, so the day-of-week would differ per hour — enter the target cron manually',
    };
  }
  // All hours wrap the same direction: move every day-of-week by one day.
  const delta = shifted[0] > 23 ? 1 : -1;
  const dowShifted = p.dow.values.map((d) => (((d + delta) % 7) + 7) % 7);
  return { expr: rebuild(shifted, compress(dowShifted)) };
}

module.exports = {
  CronError,
  parseCron,
  nextOccurrences,
  minIntervalMinutes,
  compress,
  normalize,
  shiftCron,
};
