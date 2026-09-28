---
title: Importing from Google
summary: Bring your Gmail, Google Calendar, Contacts, and Drive into TinyCld from a Google Takeout export
tags: [import, google, takeout, gmail, drive, calendar, contacts, zip]
order: 10
---

## Request your export from Google

1. Go to [takeout.google.com](https://takeout.google.com/) and sign in to the Google account you want to import.
2. Click **Deselect all**, then tick only what TinyCld can import: **Mail**, **Calendar**, **Contacts**, and **Drive**. Everything else is ignored by the importer, so leaving it in only makes the download bigger.
3. Click **Next step**. Choose **.zip** as the file type and the **largest archive size** offered — a bigger size means fewer parts to keep track of. Google splits an export that is larger than the size you pick into numbered parts (`takeout-…-001.zip`, `-002.zip`, …).
4. Click **Create export**. Google emails you when the download is ready; large exports can take hours or days.
5. Download every part to the device you will import from.

## Run the import

1. In TinyCld, open **Settings → Import from Google**.
2. Click **Select Takeout Files** and pick **every part** of the export at once. The file picker allows multi-select; a part you leave out is simply not imported.
3. The screen shows **Scanning zip files...** while it reads the archives. Nothing is written yet.
4. When scanning finishes you see one row per service — **Contacts**, **Calendar**, **Drive**, **Mail** — each with a toggle and a count of what was found (for example *Contacts — 412 contacts* or *Mail — 18,203 messages*). A row is greyed out when that service is not in the archive or its TinyCld package is not installed on this server.
5. Untick any service you don't want to bring in, then click **Start Import**. Use **Change Files** to pick a different set of archives instead.

To import mail, you need a mailbox first. If the screen says *Mail was found but you don't have a mailbox set up*, create or join one in [Settings → Mailboxes](help://mail:mailboxes), then come back — the Mail row becomes available without re-selecting the files.

## While it runs

Each service you started gets its own progress card: **Scanning...** while the archive is read, then a percentage and a running tally of *imported*, *skipped*, and *errors*. Skipped means the item already exists in TinyCld — see [Re-running an import](help://google-takeout-import:re-running-an-import).

Keep the tab or app open until you see **Import Complete**. The import runs in your browser or app, not on the server, so closing it stops the import. Large mail exports can take a while; you can keep using other tabs.

An item that fails to import is counted under *errors* and the import continues. Click **Show errors** on that card to see what went wrong for the first 20 items.

Click **Cancel Import** to stop early. The button reads **Canceling...** until the item currently being written finishes; everything imported up to that point stays in TinyCld, and the screen returns to the service list so you can start again later. A second run picks up where the first left off because already-imported items are skipped.

## When it finishes

**Import Complete** shows the totals across every service: *N records imported*, plus *skipped* and *errors* when there were any. Click **Import More** to go back to file selection for another export.

If the whole run fails instead — an unreadable file, an export that is too large, or mail with no mailbox — you see **Import Failed** with the reason. **Try Again** returns to file selection.

## The size limit

One import run handles up to **8 GB of uncompressed data** across all the files you selected. Over that, the run stops before writing anything and tells you the size it found.

To get under the limit, import the export in stages: select some of the numbered parts, run the import, then click **Import More** and select the rest. Order does not matter, and Drive folders are matched up across runs so files still land in the right place. If a single part is itself over the limit — this only really happens with very large mailboxes — go back to Takeout and request a smaller Mail export by choosing specific labels instead of all mail.

## What lands where

See [What gets imported](help://google-takeout-import:what-gets-imported) for the per-service details, and [Importing contacts from Google](help://contacts:importing) for how imported contacts are matched to ones you already have.
