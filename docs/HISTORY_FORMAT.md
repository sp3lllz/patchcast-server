# Patchcast play-history file — format `patchcast-history`, version 1

Created by **Settings → Play history → Export history** (saved through the system file picker,
default name `patchcast-history.json`) and read by **Import history**. UTF-8 JSON.

```json
{
  "format": "patchcast-history",
  "version": 1,
  "exportedAt": "2026-11-23T04:35:55.732Z",
  "podcasts": [
    {
      "feedUrl": "https://feeds.simplecast.com/BqbsxVfO",
      "title": "99% Invisible",
      "priority": 4,
      "autoQueue": false,
      "autoDownload": true,
      "retentionMode": "KEEP_LATEST",
      "retentionKeep": 5,
      "playbackSpeed": 1.5,
      "newTimeoutDays": 7
    }
  ],
  "episodes": [
    {
      "feedUrl": "https://feeds.simplecast.com/BqbsxVfO",
      "guid": "71238b32-5ba6-4fa3-8a7a-9ebc7775d633",
      "enclosureUrl": "https://…/episode.mp3?tracking=…",
      "title": "100 Objects #25: Beaded Moccasin",
      "pubDate": 1763622000000,
      "played": false,
      "positionMs": 547941,
      "playedAt": null,
      "lastPlayedAt": 1795392211216
    }
  ]
}
```

## Fields

**Top level**: `format` must be `"patchcast-history"`; `version` is an integer (readers reject versions
newer than they understand); `exportedAt` is ISO-8601 UTC.

**podcasts[]**: `feedUrl` is required. All other keys are optional; a missing/`null` override means
"follow the global setting".
- `priority`: rank in the New-episodes playlist (lower = higher priority).
- `autoQueue`: per-podcast auto-queue override (`false` = excluded from New episodes).
- `autoDownload`: per-podcast auto-download override.
- `retentionMode`: `KEEP_ALL`, `KEEP_LATEST` or `DELETE_PLAYED`. `retentionKeep` is N for `KEEP_LATEST`.
- `playbackSpeed`: remembered speed.
- `newTimeoutDays`: New-episode timeout override (`0` = never).

**episodes[]**: only episodes with non-default state (played, or a saved position) are written.
`feedUrl` is required. `pubDate`, `playedAt` and `lastPlayedAt` are epoch milliseconds; `positionMs` is in
milliseconds.

## Import semantics
1. Podcasts in the file that aren't subscribed are subscribed (4 at a time), then per-podcast settings are applied.
2. Every episode entry is stored in a local *pending* table and matched immediately. Entries that don't
   match yet (feed not refreshed, episode not in the feed yet) stay pending. They are re-tried after every
   subscribe/refresh and on app start, so import works **before or after** the feeds have refreshed.
3. Matching is per feed (feed identity ignores scheme, `www.`, host case and trailing slash), in this order:
   GUID → exact enclosure URL → enclosure URL ignoring scheme/query string (tracking params change) →
   case/whitespace-insensitive title with `pubDate` within 36 h (or both dates missing).
4. Merge rule: an episode played on either side stays played; otherwise the furthest position wins.
   Played episodes are removed from Up Next.
