'use strict';
// candle-pipe tests — run with: npm test  (node --test)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const cp = require('../bin/candle-pipe.js');
const BIN = path.join(__dirname, '..', 'bin', 'candle-pipe.js');
const FIX = path.join(__dirname, 'fixtures');

const R = (t, o, h, l, c, v = 100, lineNo = 1, rawTime = 'x') =>
  ({ t, o, h, l, c, v, lineNo, rawTime });

/* ---------- parseTimeframe ---------- */

test('parseTimeframe accepts units and aliases', () => {
  assert.equal(cp.parseTimeframe('5m'), 5);
  assert.equal(cp.parseTimeframe('M5'), 5);
  assert.equal(cp.parseTimeframe('15m'), 15);
  assert.equal(cp.parseTimeframe('1h'), 60);
  assert.equal(cp.parseTimeframe('H4'), 240);
  assert.equal(cp.parseTimeframe('1d'), 1440);
  assert.equal(cp.parseTimeframe('D1'), 1440);
  assert.equal(cp.parseTimeframe('1w'), 10080);
});

test('parseTimeframe rejects garbage', () => {
  assert.throws(() => cp.parseTimeframe('abc'), cp.UsageError);
  assert.throws(() => cp.parseTimeframe(''), cp.UsageError);
  assert.throws(() => cp.parseTimeframe('1y'), cp.UsageError);
  assert.equal(cp.parseTimeframe('1M'), 1); // M-suffix = minutes in trading convention
});

/* ---------- parseTimestamp ---------- */

test('parseTimestamp handles epoch s/ms/us and ISO', () => {
  const iso = Date.parse('2026-10-12T00:00:00Z');
  assert.equal(cp.parseTimestamp('1791763200', 'UTC'), iso);          // seconds
  assert.equal(cp.parseTimestamp('1791763200000', 'UTC'), iso);        // millis
  assert.equal(cp.parseTimestamp('1791763200000000', 'UTC'), iso);     // micros
  assert.equal(cp.parseTimestamp('2026-10-12T00:00:00Z', 'UTC'), iso);
});

test('parseTimestamp handles broker format with tz', () => {
  // 2026-10-13 00:00 in Jakarta (UTC+7) == 2026-10-12 17:00 UTC
  const got = cp.parseTimestamp('2026.10.13 00:00', 'Asia/Jakarta');
  assert.equal(got, Date.parse('2026-10-12T17:00:00Z'));
  // naive ISO treated in tz too
  assert.equal(cp.parseTimestamp('2026-10-13 00:00:00', 'Asia/Jakarta'), got);
});

test('parseTimestamp returns NaN for garbage', () => {
  assert.ok(Number.isNaN(cp.parseTimestamp('not-a-date', 'UTC')));
  assert.ok(Number.isNaN(cp.parseTimestamp('', 'UTC')));
  assert.ok(Number.isNaN(cp.parseTimestamp('12', 'UTC'))); // implausible epoch
});

/* ---------- columns ---------- */

test('detectColumns maps alias headers', () => {
  const cols = cp.detectColumns(['Date', 'Open', 'High', 'Low', 'Close', 'Vol']);
  assert.deepEqual(cols, { time: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 });
});

test('detectColumns returns null when required columns missing', () => {
  assert.equal(cp.detectColumns(['a', 'b', 'c']), null);
});

test('looksLikeHeader distinguishes header from data', () => {
  assert.equal(cp.looksLikeHeader(['time', 'open', 'high', 'low', 'close'], 'UTC'), true);
  assert.equal(cp.looksLikeHeader(['2026-10-12T00:00:00Z', '1', '2', '0.5', '1.5'], 'UTC'), false);
  assert.equal(cp.looksLikeHeader(['foo', 'bar'], 'UTC'), true);
});

/* ---------- resample core ---------- */

function m5Rows() {
  const base = Date.UTC(2026, 9, 12, 0, 0, 0);
  const mk = (i, o, h, l, c, v) => R(base + i * 300000, o, h, l, c, v, i + 1);
  return [
    mk(0, 10, 11, 9, 10.5, 100),
    mk(1, 10.5, 12, 10, 11.5, 200),   // hour 0
    mk(12, 11.5, 13, 11, 12.5, 300),
    mk(13, 12.5, 14, 12, 13.5, 400),  // hour 1
  ];
}

test('resample aggregates OHLCV correctly', () => {
  const { candles, stats } = cp.resample(m5Rows(), 60, {});
  assert.equal(candles.length, 2);
  const [h0, h1] = candles;
  assert.equal(h0.o, 10); assert.equal(h0.h, 12); assert.equal(h0.l, 9);
  assert.equal(h0.c, 11.5); assert.equal(h0.v, 300);
  assert.equal(h1.o, 11.5); assert.equal(h1.h, 14); assert.equal(h1.l, 11);
  assert.equal(h1.c, 13.5); assert.equal(h1.v, 700);
  assert.equal(new Date(h0.t).toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(stats.output_candles, 2);
});

test('resample keeps partial bucket by default, drops with --drop-partial', () => {
  const rows = m5Rows(); // last hour has 2 of 12 candles
  const kept = cp.resample(rows, 60, { fromMinutes: 5 });
  assert.equal(kept.candles.length, 2);
  assert.equal(kept.stats.partial_buckets, 2); // both buckets partial vs 12 expected
  const dropped = cp.resample(rows, 60, { fromMinutes: 5, dropPartial: true });
  assert.equal(dropped.candles.length, 1); // only the trailing partial bucket is dropped
  assert.equal(dropped.stats.partial_buckets, 2);
});

test('resample rejects non-ascending timestamps', () => {
  const rows = m5Rows();
  const bad = [...rows];
  [bad[2], bad[3]] = [bad[3], bad[2]];
  assert.throws(() => cp.resample(bad, 60, {}), cp.RuntimeError);
});

test('resample detects gaps', () => {
  const base = Date.UTC(2026, 9, 12, 0, 0, 0);
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(R(base + i * 300000, 1, 2, 0.5, 1.5, 10, i + 1));
  rows.push(R(base + 30 * 300000, 1, 2, 0.5, 1.5, 10, 11)); // 100-min gap
  const { stats } = cp.resample(rows, 60, {});
  assert.ok(stats.gaps >= 1);
  assert.equal(stats.gap_samples[0].gap_minutes, 105);
});

test('validateRow catches inconsistent OHLC', () => {
  assert.equal(cp.validateRow(R(1, 10, 12, 9, 11)), null);
  assert.match(cp.validateRow(R(1, 10, 9, 8, 9)), /high/);   // high < open
  assert.match(cp.validateRow(R(1, 10, 12, 13, 11)), /low/);  // low > open
  assert.match(cp.validateRow(R(1, 10, 12, 9, 11, -5)), /volume/);
});

/* ---------- loadRows ---------- */

test('loadRows skips invalid rows and counts them', () => {
  const text = fs.readFileSync(path.join(FIX, 'messy.csv'), 'utf8');
  const warns = [];
  // messy.csv has an unsorted duplicate -> loadRows itself does not sort-check;
  // it must load 4 valid rows and skip 2 (bad OHLC + garbage).
  const { rows, skipped } = cp.loadRows(text, { tz: 'UTC', sort: true }, (m) => warns.push(m));
  assert.equal(rows.length, 4);
  assert.equal(skipped, 2);
  assert.ok(warns.length >= 2);
  // sorted: timestamps ascending
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].t >= rows[i - 1].t);
});

/* ---------- parseArgs ---------- */

test('parseArgs requires --to and rejects unknown flags', () => {
  assert.throws(() => cp.parseArgs([]), cp.UsageError);
  assert.throws(() => cp.parseArgs(['--to', 'H1', '--bogus']), cp.UsageError);
  assert.throws(() => cp.parseArgs(['--to', 'H1', '--from', 'H4']), cp.UsageError); // from finer only
  const { opts } = cp.parseArgs(['--to', 'H1', 'f.csv']);
  assert.equal(opts.file, 'f.csv');
});

/* ---------- end-to-end via real process ---------- */

function runCli(args, stdinText) {
  return spawnSync('node', [BIN, ...args], {
    input: stdinText, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

test('e2e: m5 file -> h1 stdout, 72 candles', () => {
  const r = runCli(['--to', 'H1', path.join(FIX, 'm5-3days.csv')]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'timestamp,open,high,low,close,volume');
  assert.equal(lines.length, 1 + 72); // 3 days x 24h, all buckets complete
  assert.ok(lines[1].startsWith('2026-10-12T00:00:00.000Z,'));
  assert.equal(r.stderr, '');
});

test('e2e: stdin pipe works', () => {
  const csv = fs.readFileSync(path.join(FIX, 'm5-3days.csv'), 'utf8');
  const r = runCli(['--to', 'D1'], csv);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 4); // header + 3 daily candles
  assert.ok(lines[1].startsWith('2026-10-12T00:00:00.000Z,'));
});

test('e2e: --stats prints JSON summary to stderr', () => {
  const csv = fs.readFileSync(path.join(FIX, 'm5-3days.csv'), 'utf8');
  const r = runCli(['--to', 'H1', '--from', 'M5', '--stats'], csv);
  assert.equal(r.status, 0, r.stderr);
  const stats = JSON.parse(r.stderr);
  assert.equal(stats.input_rows, 864);
  assert.equal(stats.output_candles, 72);
  assert.equal(stats.skipped_rows, 0);
  assert.equal(stats.gaps, 0);
});

test('e2e: unsorted input fails with clear message; --sort fixes', () => {
  const csv = fs.readFileSync(path.join(FIX, 'messy.csv'), 'utf8');
  const bad = runCli(['--to', '15m'], csv);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /strictly ascending/);
  const ok = runCli(['--to', '15m', '--sort'], csv);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes('timestamp,open,high,low,close,volume'));
});

test('e2e: empty stdin is a runtime error', () => {
  const r = runCli(['--to', 'H1'], '');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no input rows/);
});

test('e2e: --help and --version exit 0', () => {
  assert.equal(runCli(['--help']).status, 0);
  assert.match(runCli(['--help']).stdout, /--to <TF>/);
  const v = runCli(['--version']);
  assert.equal(v.status, 0);
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('e2e: broker format via --cols positional auto-detect', () => {
  const r = runCli(['--to', '1h', path.join(FIX, 'broker-m5.csv')]);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 5); // header + 4 hourly candles
  // volume column missing -> zeros
  assert.ok(lines[1].endsWith(',0'));
});
