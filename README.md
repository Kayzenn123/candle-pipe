# candle-pipe

> Convert OHLC candles between timeframes through a unix pipe. Daily Tools #8.

## Why

Preparing backtest data usually means converting M5 candles to H1/D1 with a
spreadsheet or a throwaway pandas script. The closest existing tool,
[adiled/ohlc-resample](https://github.com/adiled/ohlc-resample), is a full npm
package that needs Node 26, an install script, and file arguments — overkill
for a one-off conversion inside a shell pipeline. `candle-pipe` is the
opposite: one file, zero dependencies, reads stdin and writes stdout, so it
composes with `curl`, `jq`, `cut`, and friends. It also validates every row
(bad OHLC, unsorted timestamps, gaps) and reports diagnostics on stderr,
keeping stdout machine-parseable — something the heavier tools don't promise.

## Install

```bash
git clone https://github.com/Kayzenn123/candle-pipe.git
cd candle-pipe
# no dependencies — Node >= 18 is all you need
```

Requires: Node >= 18

Optional global install:

```bash
npm install -g .
candle-pipe --help
```

## Usage

```bash
candle-pipe --to <TF> [file] [options]
cat m5.csv | candle-pipe --to H1 > h1.csv
```

Timeframes: `5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 1w`
(aliases `M5/M15/M30/H1/H4/D1/W1` also work).

| Flag | Function | Default |
| --- | --- | --- |
| `--to <TF>` | target timeframe (**required**) | — |
| `--from <TF>` | source interval; enables partial-bucket detection | auto |
| `--cols "a,b,c"` | explicit column mapping by name | auto-detect |
| `--tz <IANA>` | timezone for naive timestamps | `UTC` |
| `--sort` | sort rows by timestamp first | off (strictly ascending input required) |
| `--drop-partial` | drop trailing bucket with fewer candles than expected (needs `--from`) | keep it |
| `--epoch` | output timestamps as epoch seconds | ISO 8601 |
| `--no-header` | omit the CSV header | include header |
| `--stats` | print a JSON summary to stderr | off |
| `--help`, `--version` | — | — |

Exit codes: `0` ok · `1` runtime error · `2` usage error.

Input is CSV with columns `time,open,high,low,close[,volume]` — header names
are auto-detected (`date/datetime/timestamp`, `o/h/l/c`, `vol/v`, …), or
positional when there is no header. Timestamps accept epoch seconds / millis /
micros, ISO 8601, and broker format `YYYY.MM.DD HH:MM`.

## Example output

Command:

```bash
cat test/fixtures/m5-3days.csv | node bin/candle-pipe.js --to H1 --from M5 --stats > h1.csv
```

Output (real, copied from an actual run):

```text
timestamp,open,high,low,close,volume
2026-10-12T00:00:00.000Z,4025.5,4027.93,4024.72,4026.02,3504
2026-10-12T01:00:00.000Z,4026.02,4028.68,4024.67,4027.39,3409
2026-10-12T02:00:00.000Z,4027.39,4029.98,4025.16,4025.67,3287
2026-10-12T03:00:00.000Z,4025.67,4027.64,4023.88,4027.2,3490
```

73 lines total (header + 72 hourly candles from 864 M5 rows), verified
candle-by-candle against an independent Python aggregation. Stats on stderr:

```text
{
  "input_rows": 864,
  "skipped_rows": 0,
  "output_candles": 72,
  "gaps": 0,
  "gap_samples": [],
  "partial_buckets": 0,
  "target_timeframe": "H1",
  "first_candle": "2026-10-12T00:00:00.000Z",
  "last_candle": "2026-10-14T23:00:00.000Z"
}
```

Messy input is diagnosed, not silently mangled:

```bash
node bin/candle-pipe.js --to 15m --sort --stats test/fixtures/messy.csv
```

```text
timestamp,open,high,low,close,volume
2026-10-13T00:00:00.000Z,4025.5,4026.4,4025.2,4026.2,390
2026-10-13T00:15:00.000Z,4025.95,4026.5,4025.7,4026.3,150
warning: row 4: skipped (high lower than open/close/low)
warning: row 6: skipped (bad timestamp)
```

## How it works

1. **Load**: read file or stdin; detect header vs positional columns; map
   columns via alias lists or explicit `--cols`.
2. **Parse**: each timestamp is normalized to UTC millis (magnitude-based
   epoch detection, broker `YYYY.MM.DD HH:MM`, naive datetimes interpreted
   in `--tz`); each row is validated (high ≥ open/close/low, low ≤ …, finite
   numbers, strictly ascending timestamps).
3. **Aggregate**: rows fall into epoch-aligned buckets
   (`floor(t / targetMs)`); open = first, high = max, low = min,
   close = last, volume = sum. Gap detection uses the median input interval
   (informational only, never drops data).
4. **Emit**: CSV to stdout, warnings + optional `--stats` JSON to stderr.

Single file (`bin/candle-pipe.js`, ~430 lines); pure functions are exported
for tests. No dependencies.

## Limitations

- Only **coarsening** is supported (M5→H1, H1→D1); it cannot split H1 into
  synthetic M5 candles.
- Bucket boundaries align to the **Unix epoch** (UTC), not to broker
  day/session boundaries. Daily candles start at 00:00 UTC.
- No monthly timeframe (`1M` means 1 minute here, per trading convention).
- Gap detection is heuristic (median interval × 2.5); irregular tick data
  may report false positives.
- Entire input is read into memory; multi-GB tick files are out of scope.

## Disclaimer

For data preparation, analysis, and education only — not investment advice.
Resampled candles don't change market reality; backtest results on converted
data don't guarantee future performance.

## Development

```bash
npm test   # node --test, 22 tests incl. end-to-end CLI runs
```

## License

MIT

---
Ringkasan (Bahasa Indonesia): candle-pipe mengubah candle OHLC antar
timeframe (mis. M5 ke H1) lewat pipe stdin→stdout — satu file, tanpa
dependensi, cukup Node 18. Kolom dan format timestamp terdeteksi otomatis
(epoch, ISO, format broker `YYYY.MM.DD HH:MM`), baris rusak dilewati dengan
peringatan jelas, dan ada ringkasan `--stats` di stderr. Cocok untuk
menyiapkan data backtest dari terminal. Batasan utama: hanya bisa
menggabungkan ke timeframe lebih besar, bucket rata ke epoch UTC, dan bukan
saran investasi.
