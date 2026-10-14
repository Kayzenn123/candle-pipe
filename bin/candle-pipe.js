#!/usr/bin/env node
/*
 * candle-pipe — pipe-friendly OHLC timeframe converter.
 * Reads CSV candles (file or stdin), aggregates them into a coarser
 * timeframe, writes CSV candles to stdout, diagnostics to stderr.
 * Zero dependencies, single file. Node >= 18.
 */
'use strict';

const fs = require('fs');

const VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class UsageError extends Error {}
class RuntimeError extends Error {}

/* ------------------------------------------------------------------ */
/* Timeframe parsing                                                   */
/* ------------------------------------------------------------------ */

// "5m", "15m", "1h", "4h", "1d", "1w" and common aliases M5/H1/D1/W1.
function parseTimeframe(str) {
  if (typeof str !== 'string') throw new UsageError('timeframe must be a string');
  const t = str.trim();
  let m = t.match(/^(\d+)\s*([mhdw])$/i);
  if (!m) {
    // letter-first aliases: M5, H1, D1, W1
    const m2 = t.match(/^([mhdw])(\d+)$/i);
    if (m2) m = [m2[0], m2[2], m2[1]];
  }
  if (!m) throw new UsageError(
    `invalid timeframe "${str}": use like 5m, 15m, 1h, 4h, 1d, 1w (or M5/H1/D1/W1)`
  );
  const n = parseInt(m[1], 10);
  const mult = { m: 1, h: 60, d: 1440, w: 10080 }[m[2].toLowerCase()];
  const minutes = n * mult;
  if (minutes <= 0 || !Number.isSafeInteger(minutes)) {
    throw new UsageError(`invalid timeframe "${str}"`);
  }
  return minutes;
}

/* ------------------------------------------------------------------ */
/* Timestamp parsing                                                   */
/* ------------------------------------------------------------------ */

// Interpret a naive "YYYY-MM-DD HH:MM[:SS]" in the given IANA zone,
// returning UTC milliseconds.
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guessUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let offMs = 0;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const asIfUtc = Date.parse(fmt.format(new Date(guessUtc)).replace(',', '') + ' UTC');
    if (!Number.isNaN(asIfUtc)) offMs = asIfUtc - guessUtc;
  } catch {
    throw new UsageError(`unknown timezone "${tz}"`);
  }
  return guessUtc - offMs;
}

const NAIVE_DT = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const BROKER_DT = /^(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

function parseTimestamp(raw, tz) {
  const s = String(raw).trim();
  if (!s) return NaN;
  // Pure number: epoch. Magnitude decides the unit.
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    if (n >= 1e18) return n / 1e6;   // nanoseconds
    if (n >= 1e15) return n / 1000;  // microseconds
    if (n >= 1e12) return n;          // milliseconds
    if (n >= 1e9) return n * 1000;   // seconds
    return NaN; // too small to be a plausible epoch
  }
  let m = s.match(BROKER_DT);
  if (m) {
    return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  }
  m = s.match(NAIVE_DT);
  if (m) {
    return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), tz);
  }
  const t = Date.parse(s); // ISO 8601 with offset, RFC 2822, etc.
  return Number.isNaN(t) ? NaN : t;
}

/* ------------------------------------------------------------------ */
/* CSV parsing                                                         */
/* ------------------------------------------------------------------ */

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur); cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/* ------------------------------------------------------------------ */
/* Column detection                                                    */
/* ------------------------------------------------------------------ */

const COL_ALIASES = {
  time: ['time', 'timestamp', 'datetime', 'date', 't'],
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c'],
  volume: ['volume', 'vol', 'v', 'tick_volume', 'tickvolume', 'base_volume'],
};

function detectColumns(headerCells) {
  const norm = headerCells.map(c => c.trim().toLowerCase());
  const idx = {};
  for (const [key, aliases] of Object.entries(COL_ALIASES)) {
    const i = norm.findIndex(c => aliases.includes(c));
    idx[key] = i === -1 ? null : i;
  }
  if (idx.time === null || idx.open === null || idx.high === null ||
      idx.low === null || idx.close === null) return null;
  return idx;
}

function looksLikeHeader(cells, tz) {
  const norm = cells.map(c => c.trim().toLowerCase());
  const known = new Set(Object.values(COL_ALIASES).flat());
  if (norm.some(c => known.has(c))) return true;
  // Otherwise: data row if time parses and o/h/l/c are numeric.
  if (cells.length < 5) return true;
  const t = parseTimestamp(cells[0], tz);
  if (Number.isNaN(t)) return true;
  return !cells.slice(1, 5).every(c => c.trim() !== '' && Number.isFinite(Number(c)));
}

/* ------------------------------------------------------------------ */
/* Row validation                                                      */
/* ------------------------------------------------------------------ */

function validateRow(r) {
  if (!Number.isFinite(r.t)) return 'bad timestamp';
  for (const k of ['o', 'h', 'l', 'c']) {
    if (!Number.isFinite(r[k])) return `bad ${k}`;
  }
  if (r.h < r.o || r.h < r.c || r.h < r.l) return 'high lower than open/close/low';
  if (r.l > r.o || r.l > r.c || r.l > r.h) return 'low higher than open/close/high';
  if (r.v !== null && !(Number.isFinite(r.v) && r.v >= 0)) return 'bad volume';
  return null;
}

/* ------------------------------------------------------------------ */
/* Resampling                                                          */
/* ------------------------------------------------------------------ */

function fmtNum(n) {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(10);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

function resample(rows, targetMinutes, opts) {
  const bucketMs = targetMinutes * 60000;
  const candles = [];
  const stats = {
    input_rows: rows.length,
    skipped_rows: 0,
    output_candles: 0,
    gaps: 0,
    gap_samples: [],
    partial_buckets: 0,
  };
  let cur = null;
  let prevT = -Infinity;
  let deltas = [];

  const flush = (isLast) => {
    if (!cur) return;
    const expected = opts.fromMinutes ? targetMinutes / opts.fromMinutes : null;
    const isPartial = expected !== null && cur.n < expected;
    if (isLast && isPartial && opts.dropPartial) {
      stats.partial_buckets++;
      cur = null;
      return;
    }
    if (isPartial) stats.partial_buckets++;
    candles.push(cur);
    cur = null;
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.t <= prevT) {
      throw new RuntimeError(
        `timestamps must be strictly ascending (row ${r.lineNo}: ${r.rawTime} ` +
        `is not after previous row); pass --sort to sort first`
      );
    }
    const d = r.t - prevT;
    if (prevT !== -Infinity) deltas.push(d);
    prevT = r.t;

    const key = Math.floor(r.t / bucketMs);
    if (!cur || cur.key !== key) {
      flush(false);
      cur = { key, t: key * bucketMs, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0, n: 1 };
    } else {
      if (r.h > cur.h) cur.h = r.h;
      if (r.l < cur.l) cur.l = r.l;
      cur.c = r.c;
      cur.v += r.v || 0;
      cur.n++;
    }
  }
  flush(true);

  // Gap detection from median interval (informational only).
  if (deltas.length >= 3) {
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) {
      for (let i = 0; i < rows.length - 1; i++) {
        const gap = rows[i + 1].t - rows[i].t;
        if (gap > median * 2.5) {
          stats.gaps++;
          if (stats.gap_samples.length < 5) {
            stats.gap_samples.push({
              after: new Date(rows[i].t).toISOString(),
              gap_minutes: Math.round(gap / 60000),
            });
          }
        }
      }
    }
  }

  stats.output_candles = candles.length;
  return { candles, stats };
}

function renderCsv(candles, opts) {
  const lines = [];
  if (!opts.noHeader) lines.push('timestamp,open,high,low,close,volume');
  for (const c of candles) {
    const ts = opts.epoch ? String(Math.round(c.t / 1000)) : new Date(c.t).toISOString();
    lines.push([ts, fmtNum(c.o), fmtNum(c.h), fmtNum(c.l), fmtNum(c.c), fmtNum(c.v)].join(','));
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/* ------------------------------------------------------------------ */
/* Input loading                                                       */
/* ------------------------------------------------------------------ */

function loadRows(text, opts, warn) {
  const lines = text.split(/\r?\n/);
  const dataLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') dataLines.push({ line: lines[i], no: i + 1 });
  }
  if (dataLines.length === 0) throw new RuntimeError('no input rows found');

  let cols = null;
  let startIdx = 0;
  if (opts.cols) {
    cols = parseColsOpt(opts.cols);
  } else if (looksLikeHeader(parseCsvLine(dataLines[0].line), opts.tz)) {
    cols = detectColumns(parseCsvLine(dataLines[0].line));
    if (!cols) {
      throw new RuntimeError(
        `could not detect columns from header row 1; ` +
        `expected time/open/high/low/close (got: ${dataLines[0].line.trim()}). ` +
        `Use --cols "time,open,high,low,close,volume" to map columns explicitly`
      );
    }
    startIdx = 1;
  } else {
    const n = parseCsvLine(dataLines[0].line).length;
    cols = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: n >= 6 ? 5 : null };
  }

  const rows = [];
  let skipped = 0;
  for (let i = startIdx; i < dataLines.length; i++) {
    const { line, no } = dataLines[i];
    const cells = parseCsvLine(line);
    const need = Math.max(cols.time, cols.open, cols.high, cols.low, cols.close,
      cols.volume === null ? 0 : cols.volume);
    if (cells.length <= need) {
      skipped++;
      if (skipped <= 5) warn(`row ${no}: skipped (only ${cells.length} columns)`);
      continue;
    }
    const rawTime = cells[cols.time];
    const r = {
      lineNo: no,
      rawTime,
      t: parseTimestamp(rawTime, opts.tz),
      o: Number(cells[cols.open]),
      h: Number(cells[cols.high]),
      l: Number(cells[cols.low]),
      c: Number(cells[cols.close]),
      v: cols.volume === null ? null : Number(cells[cols.volume]),
    };
    const problem = validateRow(r);
    if (problem) {
      skipped++;
      if (skipped <= 5) warn(`row ${no}: skipped (${problem})`);
      continue;
    }
    rows.push(r);
  }
  if (rows.length === 0) {
    throw new RuntimeError(`no valid data rows (skipped ${skipped}); check column mapping with --cols`);
  }
  if (skipped > 5) warn(`... and ${skipped - 5} more skipped rows`);
  if (opts.sort) rows.sort((a, b) => a.t - b.t);
  return { rows, skipped };
}

function parseColsOpt(s) {
  const names = s.split(',').map(x => x.trim().toLowerCase());
  const idx = { time: null, open: null, high: null, low: null, close: null, volume: null };
  names.forEach((name, i) => {
    for (const [key, aliases] of Object.entries(COL_ALIASES)) {
      if (aliases.includes(name) && idx[key] === null) idx[key] = i;
    }
  });
  if (idx.time === null || idx.open === null || idx.high === null ||
      idx.low === null || idx.close === null) {
    throw new UsageError('--cols must name time, open, high, low, close (volume optional), e.g. --cols "date,o,h,l,c,vol"');
  }
  return idx;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const HELP = `candle-pipe ${VERSION} — pipe-friendly OHLC timeframe converter

Usage:
  candle-pipe --to <TF> [file] [options]
  cat m5.csv | candle-pipe --to H1 > h1.csv

Reads CSV candles (timestamp,open,high,low,close[,volume]) from a file
or stdin, aggregates them into a coarser timeframe, writes CSV candles
to stdout. Diagnostics go to stderr, so stdout stays machine-parseable.

Timeframes: 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 1w (also M5/M15/M30/H1/H4/D1/W1)

Options:
  --to <TF>        target timeframe (required)
  --from <TF>      source candle interval; enables gap stats baseline and
                   partial-bucket detection for --drop-partial
  --cols "a,b,c"   explicit column mapping by name, e.g.
                   --cols "date,o,h,l,c,vol" (default: auto-detect)
  --tz <IANA>      timezone for naive timestamps (default: UTC),
                   e.g. --tz Asia/Jakarta
  --sort           sort rows by timestamp before resampling
  --drop-partial   drop the trailing bucket when it holds fewer candles
                   than expected (needs --from); default: keep it
  --epoch          output timestamps as epoch seconds (default: ISO 8601)
  --no-header      omit the CSV header row
  --stats          print a JSON summary to stderr when done
  --help           show this help
  --version        show version

Exit codes: 0 ok · 1 runtime error · 2 usage error

Examples:
  candle-pipe --to H1 m5.csv > h1.csv
  cat ticks.csv | candle-pipe --to 15m --from 1m --stats 2>stats.log > m15.csv
`;

function parseArgs(argv) {
  const opts = {
    to: null, from: null, fromMinutes: null, cols: null, tz: 'UTC',
    sort: false, dropPartial: false, epoch: false, noHeader: false,
    stats: false, file: null,
  };
  const takesValue = new Set(['--to', '--from', '--cols', '--tz']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--version' || a === '-V') return { version: true };
    if (takesValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new UsageError(`option ${a} needs a value`);
      }
      if (a === '--to') opts.to = v;
      if (a === '--from') opts.from = v;
      if (a === '--cols') opts.cols = v;
      if (a === '--tz') opts.tz = v;
      i++;
    } else if (a === '--sort') opts.sort = true;
    else if (a === '--drop-partial') opts.dropPartial = true;
    else if (a === '--epoch') opts.epoch = true;
    else if (a === '--no-header') opts.noHeader = true;
    else if (a === '--stats') opts.stats = true;
    else if (a.startsWith('-')) throw new UsageError(`unknown option "${a}" (try --help)`);
    else if (opts.file === null) opts.file = a;
    else throw new UsageError(`unexpected argument "${a}" (only one input file allowed)`);
  }
  if (!opts.to) throw new UsageError('missing required --to <TF> (try --help)');
  const targetMinutes = parseTimeframe(opts.to);
  if (opts.from) {
    const fromMinutes = parseTimeframe(opts.from);
    if (fromMinutes >= targetMinutes) {
      throw new UsageError(`--from (${opts.from}) must be finer than --to (${opts.to})`);
    }
    opts.fromMinutes = fromMinutes;
  }
  opts.targetMinutes = targetMinutes;
  // Validate timezone early so the error is a usage error.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: opts.tz });
  } catch {
    throw new UsageError(`unknown timezone "${opts.tz}"`);
  }
  return { opts };
}

function readInput(file) {
  if (!file || file === '-') {
    if (process.stdin.isTTY) {
      throw new UsageError('no input: pass a file or pipe CSV to stdin (try --help)');
    }
    return fs.readFileSync(0, 'utf8');
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new RuntimeError(`cannot read "${file}": ${e.code === 'ENOENT' ? 'file not found' : e.message}`);
  }
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) { process.stdout.write(HELP); return 0; }
  if (parsed.version) { process.stdout.write(VERSION + '\n'); return 0; }
  const opts = parsed.opts;

  const targetMinutes = opts.targetMinutes;

  const warnings = [];
  const warn = (m) => warnings.push(m);
  const text = readInput(opts.file);
  const { rows, skipped } = loadRows(text, opts, warn);
  const { candles, stats } = resample(rows, targetMinutes, opts);
  stats.skipped_rows = skipped;
  stats.target_timeframe = opts.to;
  stats.first_candle = new Date(candles[0].t).toISOString();
  stats.last_candle = new Date(candles[candles.length - 1].t).toISOString();

  process.stdout.write(renderCsv(candles, opts));
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  if (opts.stats) process.stderr.write(JSON.stringify(stats, null, 2) + '\n');
  return 0;
}

// Export pure functions for tests.
module.exports = {
  parseTimeframe, parseTimestamp, zonedToUtc, parseCsvLine,
  detectColumns, looksLikeHeader, validateRow, resample, renderCsv,
  loadRows, parseColsOpt, parseArgs, fmtNum, UsageError, RuntimeError,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(1);
  }
}
