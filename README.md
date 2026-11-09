# Secere

A local-first family tree app for Android and PC, built around one idea: **facts always
travel, image bytes are optional cargo.**

The interface speaks English, French, German and Turkish. The tree is the same tree in
all four.

Secere is built on a web core and shell, so the same code runs today in a browser, and
packs for desktop and Android through the usual local-first toolchain (Tauri on PC,
Capacitor on Android). The engine is framework-agnostic, so a Dart/Flutter thin layer is
mechanical later.

```
npm install
npm run dev      # http://localhost:3000
npm test         # 88 unit tests
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

## Getting an archive off an Android device

A WebView has no download manager, so `a[download]` on a blob URL writes nothing on
Android — an export would silently vanish. Exports therefore go through the platform's own
"save as" sheet (`ACTION_CREATE_DOCUMENT`, in `SecereFilesPlugin.java`): the user picks
Downloads, an SD card or a cloud folder, no storage permission is involved, and the file
lands outside app-private storage. That is what makes a copy survive uninstalling the app
and travel to another device.

The archive action is deliberately separate from the slice export: a backup takes the
**whole tree with no filters and no redaction**, because a copy kept to survive a wipe must
not lose living people or private notes. Only the image tier follows the panel, since that
is the one choice with a real cost in bytes. Bytes cross the Capacitor bridge in 192 KiB
base64 chunks, so a large archive never has to exist as one giant JSON string.

## Building the APK

```
SECERE_TARGET=android npx vite build
npx cap sync android
(cd android && ./gradlew assembleDebug)
cp android/app/build/outputs/apk/debug/app-debug.apk \
   artifacts/secere-v$(node -p "require('./package.json').version")-debug.apk
```

The version in the file name comes from `package.json`. The same number lives in
`APP_VERSION` (`src/core/types.ts`) and in `versionName`/`versionCode`
(`android/app/build.gradle`) — bump them together, or the file name will lie about what is
actually installed.

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
- An event's own text (`1 OCCU Creamery manager`) is read from the tag line, carried as
  the event's `value`, and written back the same way, so the round trip stays
  byte-identical.
- Import is additive and idempotent: dry-run style counts, local versions win, nothing is
  overwritten.

## Charts

Four views, drawn as plain SVG from a pure layout module (`src/core/chart.ts`) rather than
from component state, so the geometry can be tested without a DOM:

| view | what it shows |
| --- | --- |
| pedigree | ancestors to the right, fathers above mothers |
| descendants | children below, siblings spread sideways |
| hourglass | both at once, focus in the middle |
| fan | ancestors as concentric arcs, one wedge per Ahnentafel slot |

What the graph model forces, and the layout therefore does:

- **Each person is drawn once.** Cousin marriage means the same grandparent is reachable
  by two paths; the box is shared and both child links still run to it.
- **A missing ancestor keeps its slot.** Fan wedges are fixed by Ahnentafel number, so a
  gap stays a gap instead of sliding every other wedge out of place.
- **Loops are cut and named.** A parent cycle from a bad import stops the walk and shows a
  note rather than hanging or silently dropping a branch.
- **Non-birth links are dashed** (adoption, step, foster), and a person with two sets of
  parents gets a note that only one is drawn.

Charts open at fit-to-width with a 100% option that scrolls, and the export panel steps
aside while charting so the drawing gets the width. Fan labels fall back from full name to
"T. Keane" to the surname as the arc gets narrower, rather than shrinking the type until
it is unreadable. Not yet: spouse boxes on descendant charts, and exporting a chart as an
image.

## Merging duplicates

Importing a second file usually brings the same ancestors back under fresh ids, so id
matching alone leaves two of everybody. The **Merge** tab scores every pair of records on
the evidence a genealogist would check — name (with a typo tolerance), birth and death
years, sex, shared parents, birth place — and lists the plausible ones with the reasons
that produced the score.

Nothing is merged without an explicit choice of which record wins. The merge then:

- rewrites every family link, child link and media reference to the kept record **before**
  deleting the other one, so no reference is ever left dangling;
- folds the other record's name in as an alternate name ("also recorded as James Kean");
- copies across facts the keeper is missing, including a more precise date — `2 FEB 1935`
  and `1935` are read as one fact, and the day is kept;
- keeps *both* dates when the years genuinely do not overlap, the incoming one marked
  disputed, and says how many it did that for;
- collapses two families with the same partners into one, keeping all their children.

Pairs the tree already knows are different people — partners, or a parent and child — are
never offered. Because a merge cannot be undone in the app, the panel says so, and the
answer is an archive export first (see above).

Two undated occupations that say different things ("Schoolteacher" and "Creamery
manager") stay two facts; an untitled occupation is treated as the same fact with less
written down, and the text is copied in.

## Languages

English, French, German and Turkish, chosen from the topbar and remembered (the choice is
stored as `secere.locale`; a first visit follows the browser's language, then falls back to
English).

The engine never formats text. Core modules return `Msg` descriptors — `{ key, params,
count? }` — and only `src/core/i18n` turns them into a sentence, so a message built while
the tree was English still reads correctly after a switch to Turkish. That is also why a
notice survives a language change: it is stored as a message, not as rendered text.

- **Catalogues**: `src/core/i18n/{en,fr,de,tr}.ts`, one flat map of dotted keys each.
  `en` is the contract — `MessageKey = keyof typeof en` — and the other three are typed
  `Record<MessageKey, string>`, so a missing translation is a build error rather than a
  key showing up in the interface.
- **Plurals** use `Intl.PluralRules`. The plain key is the "other" form (`count.people`),
  the singular sits beside it (`count.people.one`), and the plural is chosen in the
  language the message is *rendered* in — which is why counts travel as numbers, not as
  pre-formatted strings. French counts zero as singular, Turkish has one form.
- **Numbers**: a year is a label and is never grouped ("1935", not "1 935"); only real
  quantities are, through `formatNumber`.
- **Dates and lifespans** come from `Intl.DateTimeFormat`, so `2 FEB 1935` reads `2 févr.
  1935`, `2. Feb. 1935`, `2 Şub 1935`, and a lifespan follows the same pattern.
- **File names stay English**: `describeCriteria` (which builds archive names and the
  manifest) is deliberately not translated; `describeCriteriaParts` returns messages for
  the interface.

Adding a language: copy `en.ts`, translate the values, add it to `LOCALES`,
`LOCALE_NAMES` (endonym) and `LOCALE_TAGS`, and run the tests — catalogue parity,
placeholder parity and the plural cases will tell you what is missing.

## What is deliberately not here yet

- **Durable storage** — now a real SQLite repository behind the same persistence
  interface: `src/core/persistence-store.ts` exports `SecereRepo`, a `LocalStorageRepo`
  fallback, and `SqliteRepo` for a Cloudflare D1 database (or, mechanically, a
  wa-sqlite DB on Tauri desktop, or Drift on Flutter). The app calls `repo.load()` /
  `repo.save()` everywhere, so pointing the singleton `repo` at a real D1 binding is
  mechanical. Media bytes are stored as a BLOB keyed by SHA-256; the tree is a single
  JSON row; the schema is `create table if not exists` on first access.
- **Sync/collaboration** — local-first, no accounts, encrypted backup file first. The
  `change_log` table design exists for later; multi-user merge is a project of its own.
- **Place hierarchy with historic validity**, and non-Gregorian date entry.

## Tests

`npm test` covers: GEDCOM round-trip stability, continuation lines and date ranges,
adoption pedigree, ancestor/descendant traversal and depth limits, global year-window
queries, living-person redaction, the three boundary policies and their no-dangling-link
invariant, private note/media exclusion, facts-only bundles declaring incompleteness,
thumbnail dedup, checksum failure, hash relinking, merge idempotency, archive completeness,
the Android save protocol (chunk boundaries, cancel, abort on failure), chart layout
(pedigree collapse, single known parents, loops, generation direction, fan slots), and
duplicate handling (typo tolerance, date precision, no candidates for known relatives,
link rewriting, family collapse, conflicting dates kept, event values), four-language
catalogue parity and placeholder parity, plurals per language, locale date and lifespan
formatting, and the saved-language fallback when storage throws.
