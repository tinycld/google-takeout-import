# google-takeout-import

One-shot import of a Google Takeout export (`.zip`) into the packages installed on this deployment: Gmail into `mail`, Google Calendar into `calendar`, Google Contacts into `contacts`, and Google Drive into `drive`. Everything runs client-side — the archives are unzipped and parsed in the browser (or the native app) and written through PocketBase's REST API; nothing is uploaded to a server for processing.

A feature package for the [tinycld](https://tinycld.org/) ecosystem. Lives as a standalone git repo alongside the [`tinycld`](https://tinycld.org/) app shell and other sibling feature packages (`contacts`, `calendar`, `drive`, `mail`, `calc`, `text`). `@tinycld/core` is the shared runtime/UI library, nested inside the `tinycld` shell repo at `tinycld/core/` and imported as `@tinycld/core`.

## What it does

Adds one screen, **Settings → Import from Google** (`/a/settings/google-takeout`). The user selects one or more Takeout `.zip` files, the package scans them and reports what it found per service, the user unticks anything they don't want, and **Start Import** streams the records into the owning packages' collections with live per-service progress.

User-facing behavior:

- **Multi-file selection** — Google splits a large export into numbered parts; all parts of one export are selected at once (`multiple: true`). On web the picker is a hidden `<input type="file" accept=".zip">`; on iOS/Android it is `expo-document-picker` with `type: ['application/zip']`, and each picked document is wrapped in a lazy `TakeoutFile` that reads its bytes from the URI through `expo-file-system` only when the pipeline asks.
- **Detection before commit** — the zip directories are read and only the small metadata artifacts (`.vcf`, `.ics`, `.mbox`) are decompressed to count contacts, events, and messages; Drive files are counted from entry names alone. The detection screen shows one row per service with a toggle and a count (`— 1,234 contacts`).
- **Package-presence gating** — a service is offered only if the owning package is installed, read from the runtime registry (`usePackages()`), never from a hard import. On a deployment without `drive`, Drive files in the archive are simply greyed out.
- **Mailbox prerequisite** — mail lands in the user's default mailbox (`useDefaultMailbox`, the first `mail_mailbox_members` row where `user` is the current user). If Mail is detected but no mailbox resolves, the row is disabled and the screen says *"Mail was found but you don't have a mailbox set up."* Start is also held while the mailbox lookup is still in flight so a mail import can never launch with a null mailbox; `runFallbackImport` re-checks this (Guard B) and throws rather than silently importing zero threads.
- **Progress, cancel, and errors** — one progress card per active service (`Scanning...` → `NN%` → `Done`, with imported / skipped / errors counts). Per-record failures are recorded and the run continues; a **Show errors** disclosure lists the first 20 messages and summarises the rest. **Cancel Import** stops at the next record and leaves already-written records in place; the screen returns to the detection view so the same selection can be started again. Whole-run failures (unreadable zip, over the size limit, mail with no mailbox) show **Import Failed** with **Try Again**.
- **Completion** — *Import Complete — N records imported, N skipped, N errors* with **Import More**, which resets the store to the file-select state.
- **Idempotent re-runs** — every record type is deduplicated against what already exists (see below). A re-import of the same archive, or of a later export of the same account, adds only new items. An existing record is **skipped, never updated**.

Runs on web and native identically: the import used to run in a Web Worker on web, but the worker module was never bundled (this package ships raw `.ts` with no Metro config), so construction 404'd and fell through to the main thread every time. The worker path is gone; `run-import.web.ts` and `run-import.native.ts` are kept only for Metro's platform-suffix resolution and are byte-for-byte the same logic.

## How it plugs in

This is a **settings-only package**. The manifest declares no routes, nav entry, sidebar, migrations, collections, or Go server — `tests/manifest.test.ts` asserts exactly that:

```ts
const manifest = {
    name: 'Google Takeout Import',
    slug: 'google-takeout-import',
    version: '…',  // see package.json — the single source of truth
    description: 'Import data from Google Takeout .zip files.',
    settings: [
        { slug: 'google-takeout', component: 'settings/takeout', label: 'Import from Google' },
    ],
    help: { directory: 'help' },
    repository: { url: 'https://github.com/tinycld/google-takeout-import' },
    peerVersions: { '@tinycld/core': '>=0.1.0 <0.2.0' },
}
```

The `settings` entry is what the generator turns into the Settings sidebar item; `component` resolves through the `exports` map in `package.json`:

```json
"exports": {
    "./package.json": "./package.json",
    "./manifest": "./manifest.ts",
    "./types": "./tinycld/google-takeout-import/types.ts",
    "./hooks/*": "./tinycld/google-takeout-import/hooks/*.ts",
    "./components/*": "./tinycld/google-takeout-import/components/*.tsx",
    "./settings/*": "./tinycld/google-takeout-import/settings/*.tsx",
    "./lib/*": "./tinycld/google-takeout-import/lib/*.ts"
}
```

`settings/takeout.tsx` is a one-line default export that renders `GoogleTakeoutImportSection`.

Import state (phase, detection, per-service progress, cancel flag) lives in a zustand store in **core**, `@tinycld/core/lib/stores/takeout-import-store`, not in this package. Core carries structural duplicates of `ImportService` / `ImportProgress` / `TakeoutDetection` so it compiles without this package linked; `lib/takeout-import/types.ts` here is the package-side copy, kept in sync by convention.

`fflate` (zip) and `ical.js` (vCard + iCalendar) are this package's only third-party runtime deps, declared as `peerDependencies` like every framework dep.

## Import pipeline

```
GoogleTakeoutImportSection                     (components/)
   │  selectFiles / startImport / requestCancel
   ▼
useTakeoutImport                               (lib/takeout-import/index.ts)
   │  web: hidden <input multiple accept=.zip>   native: expo-document-picker
   ▼
run-import.{web,native}.ts                     identical; main thread
   ├─ detect()    → detectOnly()               (import-worker-fallback.ts)
   └─ runImport() → runFallbackImport()
                      │  1. scanZipEntries: names + sizes only → drive folder tree, size guard
                      │  2. streamZipEntries: decompress each entry once, route to a parser
                      ▼
                    parsers/{contacts,calendar,drive,mail}.ts
                      │  batched 50 records per service sink (bytes released per batch)
                      ▼
                    createBatchInserter()      (batch-inserter.ts) → raw PocketBase REST
```

`streaming-unzip.ts` is the reason a multi-GB export fits in memory: `scanZipEntries` decompresses only entries the caller opts into, and `streamZipEntries` hands each entry's bytes to the callback and drops them before reading the next. Nothing retains the full `Map<path, bytes>` the original implementation built (twice).

### Parsers and entry routing

| Service | Entry match | Parser | Notes |
|---|---|---|---|
| Contacts | `*Contacts/**/*.vcf` | `parsers/contacts.ts` (ical.js vCard) | One `.vcf` may hold many cards; `N` preferred over `FN`; first `EMAIL` / `TEL` only |
| Calendar | `*Calendar/**/*.ics` | `parsers/calendar.ts` (ical.js) | One `ParsedCalendar` per file, named from `X-WR-CALNAME` or the filename; events with no `DTSTART`, or with neither summary nor UID, are dropped |
| Drive | `Takeout/Drive/**` | `parsers/drive.ts` | Skips `*-metadata.json`; MIME inferred from extension; folder tree derived from paths (parents first) so files can resolve their parent |
| Mail | `*Mail/**/*.mbox` | `parsers/mail.ts` | Charset-aware header/body decoding, multipart + attachments, `X-Gmail-Labels` → folder / read / starred / custom labels, messages grouped into threads by Gmail thread id |

### Where rows land (mirrored schema)

The inserter writes into collections owned by four other packages plus core. It talks to a raw `PocketBase` handle (the file-level `biome-ignore-all` for `pbtsdb-no-raw-pb-access` is deliberate — this is a bulk importer with batching, retry, cancel, and existence checks, the same class as the seed scripts), so nothing typechecks its field names against the owning schema. That is what the mirrored-schema tests are for (below).

| Service | Collection | Fields written | Ownership |
|---|---|---|---|
| Contacts | `contacts` | `id`, `first_name`, `last_name`, `email`, `phone`, `company`, `job_title`, `notes`, `vcard_uid`, `favorite: false` | `owner = userId` |
| Calendar | `calendar_calendars` | `id`, `name`, `color: 'blue'` | membership is created by calendar's server hook; the inserter polls `calendar_events` until the new calendar is visible through the rule context before inserting into it |
| | `calendar_events` | `id`, `calendar`, `title`, `description`, `location`, `start`, `end`, `all_day`, `recurrence`, `ical_uid`, `guests`, `reminder`, `busy_status`, `visibility` | `created_by = userId` |
| Drive | `drive_items` | folders first (`is_folder: true`, `size: 0`), then files as multipart with the `file` blob; `parent` resolved from the folder map | `created_by = userId` |
| | `drive_shares` | one `role: 'owner'` share per created item | `user = userId` |
| Mail | `mail_threads` | `mailbox`, `subject`, `snippet`, `message_count`, `latest_date`, `participants` | scoped by the default `mailbox` |
| | `mail_messages` | multipart: headers, `recipients_to` / `recipients_cc` as JSON, `body_html` as an uploaded `body.html` file, each attachment under `attachments`, `in_reply_to` chained to the previous message when the header is absent | |
| | `mail_thread_state` | `thread`, `folder`, `is_read`, `is_starred` | `user = userId` |
| | core `labels` + `label_assignments` | one label per custom Gmail label (colour `#3949ab`), assigned to the `mail_thread_state` row | `user = userId` |

Every created record gets a client-side `newRecordId()`; `contacts.vcard_uid` and `calendar_events.ical_uid` fall back to `crypto.randomUUID()` when the source had none, so the row is deduplicable on a later run.

### Dedup rules

Dedup lookups treat **only a 404 as "not found — create it"**. Any other failure (network drop, expired auth, 500) propagates and aborts that row; swallowing it once answered "does this exist?" with "no" on a transient error and minted duplicates. On a hit the record is **skipped** (counted as such), never updated.

| Record | Matched by (first applicable rule wins) |
|---|---|
| Contact | `vcard_uid`; else `email` + `owner`; else `first_name` + `last_name` + `owner` |
| Calendar | `name` — an existing calendar of the same name is reused and its events go into it |
| Event | `ical_uid` |
| Drive folder | `name` + `parent` + `is_folder = true` — reused so children resolve into it |
| Drive file | `name` + `parent` |
| Mail thread | `message_id` of the thread's first message, looked up in `mail_messages` |
| Label | `name` + `user` |

The calendar-name, `ical_uid`, and `message_id` lookups are deliberately unscoped: they run under the caller's credentials, so each collection's list rule already narrows them to what the user can see. That holds while one deployment is one workspace on one PocketBase; if a router ever multiplexed several tenants over a single PocketBase instance these lookups would match across tenants (see the comment in `insertCalendar`).

### Limits and guards

- **8 GB uncompressed per run** — `MAX_TOTAL_UNCOMPRESSED_BYTES` in `import-worker-fallback.ts`, summed across every selected zip from the zip directories before anything is decompressed. Over the limit the run fails up front with *"This export is too large to import (N GB uncompressed). Split your Google Takeout archive into smaller downloads and import them one at a time."* Overridable via the `maxTotalUncompressedBytes` test seam.
- **Batches of 50** records per service sink, with a `setTimeout(0)` yield after each flush so the UI stays responsive on the main thread.
- **One retry** after 1 s on every `create`.
- **Field truncation** to the owning schemas' limits: contact names 100, company / title 200, `vcard_uid` 255; event title / location / recurrence / `ical_uid` 500, description 5000; mail subject 998, snippet 300.
- **Error list** in the UI is capped at 20 messages plus an *…and N more* line; the counts are always complete.

## Tests

```
tests/
    manifest.test.ts                       settings-only contract (no routes / nav / server)
    batch-inserter-schema.test.ts          mirrored-schema contract (below)
    batch-inserter-dedup-errors.test.ts    only a 404 means "not found"; anything else aborts the row
    import-worker-fallback.test.ts         streaming: drive payloads decompressed exactly once, folders
                                           before files, size guard, Guard B, bounded zip reads
    streaming-unzip-real-takeout.test.ts   fflate against the real fixture zips (nested docx/pptx archives)
    useDefaultMailbox.test.tsx             loading state + asserts the `user` filter field by name
    takeout-import.spec.ts                 Playwright: full import of the fixtures, then verifies each
                                           service's data through the owning package's UI
    assets/takeout/*.zip                   three real Takeout parts: Contacts+Calendar, Drive, Mail
tinycld/google-takeout-import/lib/takeout-import/parsers/
    mail.test.ts                           charset / encoded-word / multipart decoding, thread grouping
```

**The mirrored-schema tests** (`batch-inserter-schema.test.ts`) run a full import through a recording `pb` mock and assert, per collection, the exact set of filter expressions and the exact create-payload keys. This package has no compile-time link to the schemas it writes into, so a field rename in `contacts`, `calendar`, `drive`, `mail`, or core's labels is invisible to `tsc` here — this suite is the guard. When an owning package renames a field, update the inserter *and* the expected names in this test together. `useDefaultMailbox.test.tsx` does the same for the one read the hook makes (`mail_mailbox_members.user`).

## Client package layout

```
manifest.ts                     settings entry, help directory, peerVersions
help/                           in-app help topics (markdown + frontmatter)
tinycld/google-takeout-import/
    types.ts                    ImportService, TakeoutFile, Parsed* (local declarations)
    settings/takeout.tsx        settings panel → GoogleTakeoutImportSection
    components/
        GoogleTakeoutImportSection.tsx   the six states: idle / detecting / detected / importing / complete / error
    hooks/
        useDefaultMailbox.ts    first mail_mailbox_members row for the user (raw pb read; mail may be absent)
    lib/takeout-import/
        index.ts                useTakeoutImport: pickers, detect, start, cancel
        types.ts                TakeoutFile, ImportContext, Parsed* record shapes
        run-import.ts           base module (never runs; Metro picks a platform file)
        run-import.web.ts       main-thread runner (web)
        run-import.native.ts    main-thread runner (iOS / Android), identical
        import-worker-fallback.ts   detectOnly + runFallbackImport, size guard, service sinks
        streaming-unzip.ts      scanZipEntries / streamZipEntries over fflate
        batch-inserter.ts       createBatchInserter: dedup + writes into the mirrored collections
        parsers/                contacts.ts  calendar.ts  drive.ts  mail.ts
```

## Development

This package is a member of the TinyCld pnpm workspace. Assemble the workspace with `@tinycld/bootstrap`, then install at the **workspace root** (never inside a member — members carry no `node_modules` of their own):

```sh
npx @tinycld/bootstrap@latest --assemble-only --with google-takeout-import --with contacts --with calendar --with drive --with mail
pnpm install                    # links members + runs the generator (postinstall)
cd tinycld && pnpm run dev      # Expo + PocketBase
```

The import screen works with any subset of `contacts` / `calendar` / `drive` / `mail` present; services whose package is missing are greyed out.

## Standalone checks

Run checks from **inside this package** — they scope to this package only:

```sh
cd ~/code/tinycld/google-takeout-import
pnpm run typecheck   # tsc against this package's tsconfig (extends the shared base)
pnpm run test        # vitest, this package's tests/ + colocated *.test.ts
pnpm run check       # biome + typecheck + unit
pnpm run test:e2e    # Playwright against the app shell's live stack (180 s per-test budget)
```

These scripts delegate to `tinycld-pkg` (the `@tinycld/package-scripts` workspace member): it locates the app shell, then runs the scoped command with the shell's toolchain. `tsconfig.json` extends the base by relative path rather than the bare `@tinycld/core/…` specifier because Playwright resolves `extends` with a resolver that only checks this package's own `node_modules/`.

## CI

`.github/workflows/ci.yml` checks this repo out into a member slot, assembles the rest of the workspace with `@tinycld/bootstrap --assemble-only`, installs at the root, and runs `pnpm exec tinycld-pkg check`. If a branch of the same name exists on the `tinycld` repo it is assembled instead of `main`, so a coordinated core + package change tests against its own core.

## Package anatomy

- `manifest.ts` — settings entry, `help` directory, `peerVersions`
- `package.json` — name, exports map, `fflate` / `ical.js` peer deps
- `tsconfig.json` — typecheck config (extends the app's `tsconfig.package-base.json`)
- `help/` — in-app help topics (markdown + frontmatter)
- `tests/` — vitest unit tests, the mirrored-schema contract, real Takeout fixtures, Playwright e2e
- `vitest.config.ts` / `playwright.config.ts` — thin per-package configs inheriting the app shell's canonical config
- `tinycld/google-takeout-import/` — TypeScript source
