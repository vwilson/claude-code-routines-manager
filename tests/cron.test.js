'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const cron = require('../src/main/cron');

test('parseCron expands field syntaxes', () => {
  const p = cron.parseCron('0 9-17/2 1,15 */3 1-5');
  assert.deepEqual(p.minute.values, [0]);
  assert.deepEqual(p.hour.values, [9, 11, 13, 15, 17]);
  assert.deepEqual(p.dom.values, [1, 15]);
  assert.deepEqual(p.month.values, [1, 4, 7, 10]);
  assert.deepEqual(p.dow.values, [1, 2, 3, 4, 5]);
});

test('parseCron maps day-of-week 7 to 0', () => {
  assert.deepEqual(cron.parseCron('0 0 * * 7').dow.values, [0]);
  assert.deepEqual(cron.parseCron('0 0 * * 5-7').dow.values, [0, 5, 6]);
});

test('parseCron rejects unsupported syntax', () => {
  assert.throws(() => cron.parseCron('0 9 * * MON'), cron.CronError);
  assert.throws(() => cron.parseCron('0 9 * *'), cron.CronError);
  assert.throws(() => cron.parseCron('60 9 * * *'), cron.CronError);
  assert.throws(() => cron.parseCron('0/0 9 * * *'), cron.CronError);
  assert.throws(() => cron.parseCron('0 9 L * *'), cron.CronError);
});

test('nextOccurrences in UTC', () => {
  // 2026-07-29 is a Wednesday.
  const from = new Date('2026-07-29T14:30:00Z');
  const next = cron.nextOccurrences('0 12 * * 1-5', { utc: true, from, count: 3 });
  assert.deepEqual(
    next.map((d) => d.toISOString()),
    ['2026-07-30T12:00:00.000Z', '2026-07-31T12:00:00.000Z', '2026-08-03T12:00:00.000Z'],
  );
});

test('nextOccurrences is strictly after `from`', () => {
  const from = new Date('2026-07-30T12:00:00Z');
  const [next] = cron.nextOccurrences('0 12 * * *', { utc: true, from, count: 1 });
  assert.equal(next.toISOString(), '2026-07-31T12:00:00.000Z');
});

test('nextOccurrences in local time', () => {
  const from = new Date(2026, 6, 29, 6, 0); // local Jul 29 06:00
  const next = cron.nextOccurrences('30 7 * * *', { from, count: 2 });
  assert.deepEqual(next, [new Date(2026, 6, 29, 7, 30), new Date(2026, 6, 30, 7, 30)]);
});

test('vixie OR semantics when both dom and dow are restricted', () => {
  // 2026-01-01 is a Thursday; "0 0 13 * 5" fires on the 13th OR on Fridays.
  const from = new Date('2026-01-01T00:00:00Z');
  const next = cron.nextOccurrences('0 0 13 * 5', { utc: true, from, count: 3 });
  assert.deepEqual(
    next.map((d) => d.toISOString()),
    ['2026-01-02T00:00:00.000Z', '2026-01-09T00:00:00.000Z', '2026-01-13T00:00:00.000Z'],
  );
});

test('dom/dow AND-like behavior when only one is restricted', () => {
  const from = new Date('2026-01-01T00:00:00Z');
  const [next] = cron.nextOccurrences('0 0 * * 5', { utc: true, from, count: 1 });
  assert.equal(next.toISOString(), '2026-01-02T00:00:00.000Z');
});

test('an expression that never matches returns fewer occurrences', () => {
  const next = cron.nextOccurrences('0 0 30 2 *', { utc: true, from: new Date('2026-01-01T00:00:00Z') });
  assert.deepEqual(next, []);
});

test('nextOccurrences finds leap days beyond the old one-year scan bound', () => {
  const next = cron.nextOccurrences('0 0 29 2 *', {
    utc: true,
    from: new Date('2025-03-01T00:00:00Z'),
    count: 3,
  });
  assert.deepEqual(
    next.map((d) => d.toISOString()),
    ['2028-02-29T00:00:00.000Z', '2032-02-29T00:00:00.000Z', '2036-02-29T00:00:00.000Z'],
  );
});

test('nextOccurrences crosses a skipped Gregorian century leap year', () => {
  const [next] = cron.nextOccurrences('0 0 29 2 *', {
    utc: true,
    from: new Date('2096-03-01T00:00:00Z'),
    count: 1,
  });
  assert.equal(next.toISOString(), '2104-02-29T00:00:00.000Z');
});

test('minIntervalMinutes', () => {
  const from = new Date('2026-07-29T00:00:00Z'); // Wednesday
  assert.equal(cron.minIntervalMinutes('*/5 * * * *', { utc: true, from }), 5);
  assert.equal(cron.minIntervalMinutes('0 7 * * 1-5', { utc: true, from }), 1440);
  assert.equal(cron.minIntervalMinutes('0 0 30 2 *', { utc: true, from }), Infinity);
});

test('compress', () => {
  assert.equal(cron.compress([1, 2, 3, 5, 9, 10]), '1-3,5,9,10');
  assert.equal(cron.compress([4]), '4');
  assert.equal(cron.compress([2, 1, 1, 0, 3]), '0-3');
});

// ---- shift table ----

const SHIFT_CASES = [
  ['0 7 * * 1-5', 5, '0 12 * * 1-5'], // plain weekday shift, no wrap
  ['0 20 * * 1-5', 5, '0 1 * * 2-6'], // all hours wrap forward: dow moves +1
  ['0 2 * * 0', -5, '0 21 * * 6'], // all hours wrap backward: dow moves -1
  ['30 */6 * * *', 5, '30 5,11,17,23 * * *'], // step hours expand and wrap freely (no day fields)
  ['0 1,23 * * *', 5, '0 4,6 * * *'], // mixed wrap is fine when days are unrestricted
  ['15 * * * *', 5, '15 * * * *'], // hour * is shift-invariant
  ['0 9 * * 1-5', 0, '0 9 * * 1-5'], // offset 0
];

for (const [expr, offset, expected] of SHIFT_CASES) {
  test(`shiftCron("${expr}", ${offset}) -> "${expected}"`, () => {
    assert.deepEqual(cron.shiftCron(expr, offset), { expr: expected });
  });
}

test('shiftCron: mixed wrap with restricted day-of-week is unsupported', () => {
  const result = cron.shiftCron('0 9,21 * * 1-5', 5);
  assert.match(result.unsupported, /day-of-week would differ/);
});

test('shiftCron: wrap with pinned calendar dates is unsupported', () => {
  const result = cron.shiftCron('0 22 15 * *', 5);
  assert.match(result.unsupported, /calendar dates/);
});

test('shiftCron: unparseable input is unsupported, not a throw', () => {
  assert.ok(cron.shiftCron('0 9 * * MON', 5).unsupported);
});

test('shiftCron: non-integer offsets are unsupported', () => {
  assert.ok(cron.shiftCron('0 9 * * *', 5.5).unsupported);
});

test('shift round-trip property: shift(shift(e, k), -k) === normalize(e)', () => {
  const exprs = ['0 7 * * 1-5', '0 20 * * 1-5', '30 */6 * * *', '0 2 * * 0', '0 1,23 * * *', '45 9-17 * * 1-5'];
  for (const expr of exprs) {
    for (const offset of [5, -5, 9, -11]) {
      const there = cron.shiftCron(expr, offset);
      if (there.unsupported) continue; // asymmetric wraps are covered by the explicit cases above
      const back = cron.shiftCron(there.expr, -offset);
      assert.equal(back.expr, cron.normalize(expr), `${expr} via ${offset}`);
    }
  }
});

test('normalize expands steps and canonicalizes dow 7', () => {
  assert.equal(cron.normalize('30 */6 * * 7'), '30 0,6,12,18 * * 0');
  assert.equal(cron.normalize('* * * * *'), '* * * * *');
});
