# History behavior

The history implementation ports the relevant OpenUsage Swift logic to BB's
TypeScript runtime. Reference: [OpenUsage revision
2d2eabe](https://github.com/robinebers/openusage/tree/2d2eabe5e2764db9eff5ecf4dc7952443787659f).
The MIT license and attribution are included in `THIRD_PARTY_NOTICES.md`.

| OpenUsage implementation | BB implementation |
|---|---|
| `JSONLScanning`, provider root discovery | `history-discovery.ts`, `jsonl-scanner.ts` |
| `JSONLStreamingReader` | `readJSONL` in `jsonl-scanner.ts` |
| `IncrementalJSONLScanner`, `JSONLScanCacheStore` | `HistoryCache`, `history-store.ts` |
| `ClaudeLogUsageScanner` parsing and dedup | `createLogParser`, `dedupHistory` in `history.ts` |
| `CodexLogFileParser`, `CodexLogUsageScanner` | `createLogParser`, `dedupHistory` in `history.ts` |
| `GrokLogUsageScanner` | `createLogParser`, `dedupHistory` in `history.ts` |
| `CursorUsageClient.fetchUsageCSV`, `CursorUsageCSV` | `cursor-history.ts`, Cursor session selection in `usage-client.ts` |

Every matching file is discovered and every relevant recent file is scanned
on the first refresh. There is no cumulative scan-byte budget, maximum file
size, event-count cap or directory-count/depth cap. Files are processed in
64 KB streaming chunks with up to eight concurrent readers. Like OpenUsage,
an individual record larger than 1 MB is skipped and reported as partial;
this bounds reader memory without dropping the rest of that file.

Discovery resolves symlinked roots. Claude supports comma-separated config
homes, XDG/default homes, `projects` aliases and desktop Cowork sandboxes.
Codex includes active and archived sessions, preferring the active copy when
relative paths collide, and scans the home directly when neither directory
exists. Grok includes every session's durable `updates.jsonl`, including
child sessions.

Files are cached by provider/source identity, canonical path, size and mtime.
Changed files are reparsed completely, with independent parser state per file.
Only normalized usage events are persisted in the plugin's SQLite database;
conversation text and credentials never enter the parse cache. Parser versions
invalidate incompatible cache entries. Unreadable or corrupt cache records
are retried, changed/deleted sources are reconciled, and old cache entries
expire. This uses BB's existing database instead of OpenUsage's macOS plist
files and application/CLI filesystem locks: one plugin instance owns the cache.

Claude streaming and sidechain duplicates use message/request identifiers,
parent preference, larger token totals and explicit speed metadata. Advisor
iterations count separately. Codex uses cumulative deltas or last-turn usage,
ignores stale snapshots, excludes replayed parent history, supports older field
names and recorded service tiers, and uses OpenUsage's fallback pricing for
auto-review/reserve model slugs. Grok deduplicates event ID/model pairs and
preserves reported tick costs.

The displayed period is today plus the previous 29 local-calendar days.
Like OpenUsage, local scans use an extra day of cache/discovery margin; cached
raw timestamps are filtered at aggregation. Cursor requests the entire displayed
window with `strategy=tokens`, the dashboard session cookie, and a 30-second
timeout. Its complete UTF-8 CSV is consumed one row at a time, without a 16 MB
cutoff. CSV rows use base model prices because request context sizes are absent.

Reported costs take precedence over estimates. Unpriced models are warned
about separately and excluded from spend and token totals, following OpenUsage.
API prices can change estimates, and newly recorded usage can change totals;
repeated refreshes of unchanged files and prices produce identical totals.
History remains shared across machine logins, as labeled in BB's page.

Regression tests cover first-pass completeness above the former 64/256 MB
limits, stable repeated refreshes, persistent-cache restart/corruption recovery,
archive and symlink discovery, streaming continuation, provider parser parity,
and Cursor exports above 16 MB.
