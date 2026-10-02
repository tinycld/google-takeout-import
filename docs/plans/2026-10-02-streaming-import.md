# Streaming Takeout import

## Problem

The import calls itself streaming, but it is not:

| Stage | Holds in memory | Real export (Oct 2026) |
|---|---|---|
| Read zip | `file.arrayBuffer()` loads the whole zip | 445 MB |
| Decompress | each entry inflates whole; the mbox is one array | 767 MB |
| Mail threads | every parsed message (with attachments) until the mbox ends | ~310 MB |

Peak is about 1.5 GB. A browser cannot load a file of more than about 2 GB
into one array, and Google offers archive parts of up to 50 GB. Our help text
tells users to pick the largest part size, so a big mail export fails at once.

Also, fflate's async `unzip` inflates entries of 512 KB or more in a Worker
built from a blob URL. Hermes has no `Worker`, so on native a large entry
(mbox, most Drive documents) is expected to fail with `Worker is not defined`.

## Goal

Peak memory = a few MB of read/inflate chunks + the largest single Drive file
+ small per-message mail metadata. Same code on web and native, no Workers.

## Design

### 1. Range reads (`TakeoutFile`)

`TakeoutFile` becomes `{ name, size, readRange(start, length) }`.

- Web: `File.slice(start, end).arrayBuffer()`.
- Native: `expo-file-system` `File.open()` → `FileHandle` (`offset`,
  `readBytes`), closed after each read.

### 2. Zip reader (`zip-reader.ts`, replaces `streaming-unzip.ts`)

- Find the end-of-central-directory record in the last 64 KB; follow the
  ZIP64 locator when a field is saturated (Takeout parts over 4 GB use ZIP64).
- Read the central directory once; take names, method, sizes and local-header
  offsets from it (Takeout writes data-descriptor entries, so local headers
  carry no sizes, and nested docx/pptx zips make header scanning unsafe).
- `streamEntry(file, entry, onChunk)`: read compressed bytes in 1 MB ranges,
  pass stored entries through, inflate deflate entries with fflate's
  synchronous streaming `Inflate`, and await `onChunk` per output chunk
  (backpressure: nothing is read ahead of the consumer).
- `readEntry` collects one entry whole, for small files (`.vcf`, `.ics`) and
  for Drive files (the upload needs the whole file).
- Unsupported compression method or a short read → the entry is reported as
  unreadable, never skipped.

### 3. Streaming mbox splitter

`MboxSplitter.push(chunk)` / `end()` emits each complete raw message as soon
as the next `From ` line arrives. It holds back the last 5 bytes of each chunk
so a separator split across two chunks is still found. Memory: one message.

### 4. Mail in two passes

Threads need all their messages (subject and snippet of the earliest message,
latest date, participants, labels, reply chain), but a thread's messages are
not contiguous in the mbox.

- **Plan pass:** stream the mbox and parse headers only. Keep per message:
  thread key, date, message id, labels, addresses. Build one `MailThreadPlan`
  per thread and the previous-message id for each message (by message index,
  which is stable between passes because both passes split the same bytes).
- **Insert pass:** stream the mbox again and fully parse one message at a
  time. Each becomes a `mail_message` record carrying its thread plan. The
  inserter creates the thread (plus state and labels) on the first message of
  the thread it sees, then inserts messages as they arrive. Dedup stays per
  thread: if the earliest message id already exists, all its messages count
  as skipped.

The mbox is inflated three times (detect count, plan, insert). That costs CPU
seconds, not memory.

### 5. Pipeline

`detectOnly` and `runFallbackImport` use the zip reader. Detection inflates
only `.vcf`, `.ics` and the mbox (mbox counted chunk by chunk). The insert
pass yields to the UI after each batch, as now.

## Out of scope

- Chunked/resumable Drive uploads (peak stays at the largest Drive file).
- Raising the 8 GB total limit — revisit after measuring.

## Verification

- Unit: zip reader against the real fixtures in `tests/assets/takeout`, a
  synthetic ZIP64 archive, stored + deflate entries, a 1-byte chunk size.
- Unit: splitter with separators split at every chunk offset.
- Unit: thread plan (out-of-order messages, reply chain, dedup by earliest id).
- Real export in `~/Downloads`: all 7,939 messages / 71 events / 7 files reach
  the inserter, and peak heap is measured before and after.
