# Secere

A local-first family tree app for Android and PC, built around one idea: **facts always
travel, image bytes are optional cargo.**

Secere is built on a web core and shell, so the same code runs today in a browser, and
packs for desktop and Android through the usual local-first toolchain (Tauri on PC,
Capacitor on Android). The engine is framework-agnostic, so a Dart/Flutter thin layer is
mechanical later.

```
npm install
npm run dev      # http://localhost:3000
npm test         # 20 engine tests
npm run build
```

## Why a graph, not a tree

Real families are not trees: cousin marriage, multiple marriages, unmarried partners,
adoption, foster and step relations, disputed parentage. The model is
**persons + unions + child links**, where each child link carries a pedigree type and a
certainty level. Nothing enforces a single path to an ancestor.

Every record has a stable id (GEDCOM xref or UUID). Ids surviving export and import is
what makes re-importing the same file a no-op.

## The slice engine (`src/core/subset.ts`)

Three separate concerns, which is what makes "export exactly this range" trustworthy:

1. **Select** — traversal from anchors (generations up/down, sideways collateral,
   spouses) and/or attribute filters (name, place, birth/death year, sex, living status,
   media presence, tags). With no anchor, filters query the whole tree.
2. **Close the boundary** — three explicit policies:
   - `include`: also take a selected person's co-partners and co-children, one hop, so
     families are not half-empty;
   - `stub`: keep the topology, but outsiders arrive as name-only placeholders;
   - `prune`: drop the outer links entirely.
   After any policy, no exported record references a person outside the slice. There is a
   test for that invariant.
3. **Redact** — living people (explicit flag, or no death fact and born within 110
   years), private records, private notes and private media. Redaction fails closed.

Filters act as a mask on the walked set; boundary repair then keeps the graph valid for
whoever the mask removed.

## Media: the index always travels, pixels never have to

Every asset has a **SHA-256 content address**, its original size, mime, caption, date and
the facts it documents. That index is part of the data, not an attachment.

Three export tiers:

| mode | what ships | size (sample tree) |
| --- | --- | --- |
| `none` (facts only) | index only, 0 image bytes | ~5 KB zip for 23 people, 9 media refs holding 27 MB of originals |
| `thumbs` | ~256 px previews | +6 KB for 9 thumbnails |
| `full` | originals | +27 MB |

Consequences worth designing around:

- **A facts-only bundle is lossless for the family data.** You lose pixels, not
  structure: the gallery, captions, dates and ordering survive, and every tile renders as
  a "no pixels · 2.3 MB original" placeholder rather than disappearing.
- **Deduplication is free.** The same photo attached in three branches, or in two
  different exports, is one hash. Media packs can be shipped once per device.
- **Relinking replaces re-downloading.** Point the app at a folder; files are matched by
  hash and reattached, path-independent. Paths are never used to resolve media, because
  they break across OSes and leak usernames.
- **Missing pixels are declared, not hidden.** The manifest carries
  `media.complete: false` plus the byte total that would be needed, so the recipient knows
  the bundle is media-incomplete rather than corrupt.
- **Checksums catch corruption.** A tampered media file is rejected on import with a
  warning (tested).

## Bundle format

```
manifest.json        format, schema version, exact criteria, counts, media status, file checksums
data.json            the complete slice, including the media index
media/<sha256>.<ext> optional image bytes
thumbs/<sha256>.<ext> optional previews
```

The manifest records the query that produced the slice, so an export is reproducible and
the recipient can see how it was scoped.

## GEDCOM

- Reads and writes GEDCOM 5.5.1 (UTF-8) — still the widest-supported interchange format.
- Round-trip is **stable**: `write → read → write` produces a byte-identical file (tested),
  which is the property that makes merging two files sane.
- Dates keep the author's original string *and* a normalized range. Filtering uses the
  range; exports use the original ("ABT 1851", "BET 1903 AND 1904").
- Custom data rides on underscore tags: `_SHA256`, `_BYTES`, `_THUMB`, `_PRIV`, `_CONF`,
  `_KIND`, `_TREE`. These are legal in 5.5.1 and ignored by other tools.
- Citations whose source is not part of a slice degrade to inline text, so the evidence
  trail never silently vanishes.
- Import is additive and idempotent: dry-run style counts, local versions win, nothing is
  overwritten.

## What is deliberately not here yet

- **Charts** (pedigree, descendant, hourglass, fan) — v0.3. The model supports them; the
  rendering is custom work.
- **Durable storage** — now a real SQLite repository behind the same persistence
  interface: `src/core/persistence-store.ts` exports `SecereRepo`, a `LocalStorageRepo`
  fallback, and `SqliteRepo` for a Cloudflare D1 database (or, mechanically, a
  wa-sqlite DB on Tauri desktop, or Drift on Flutter). The app calls `repo.load()` /
  `repo.save()` everywhere, so pointing the singleton `repo` at a real D1 binding is
  mechanical. Media bytes are stored as a BLOB keyed by SHA-256; the tree is a single
  JSON row; the schema is `create table if not exists` on first access.
- **Merge UI** for duplicates beyond id matching (fuzzy name + date + place scoring).
- **Sync/collaboration** — local-first, no accounts, encrypted backup file first. The
  `change_log` table design exists for later; multi-user merge is a project of its own.
- **Place hierarchy with historic validity**, and non-Gregorian date entry.

## Tests

`npm test` covers: GEDCOM round-trip stability, continuation lines and date ranges,
adoption pedigree, ancestor/descendant traversal and depth limits, global year-window
queries, living-person redaction, the three boundary policies and their no-dangling-link
invariant, private note/media exclusion, facts-only bundles declaring incompleteness,
thumbnail dedup, checksum failure, hash relinking, and merge idempotency.
