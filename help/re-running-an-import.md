---
title: Re-running an import
summary: What happens when you import the same export twice, a newer export, or after cancelling
tags: [import, google, takeout, duplicates, skipped, cancel]
order: 30
---

You can run the importer as many times as you like. It never creates a second copy of something it already imported, so it is safe to re-run after a cancel, after an error, or with a newer export of the same Google account.

## Items that already exist are skipped

Before writing each item, the importer looks for a matching one in TinyCld:

- **Contacts** by the contact's Google identifier, otherwise by email address, otherwise by first and last name.
- **Calendar events** by the event's identifier; **calendars** by name.
- **Mail** by the message id of the first message in the thread.
- **Drive** files and folders by name within the same folder.

A match counts as **skipped** on the progress card and in the completion summary. Only items with no match are written, so a second run of the same archive reports everything skipped and nothing imported.

## Skipped means unchanged

A skipped item is **left exactly as it is** in TinyCld. If you edited an imported contact, moved a Drive file, or changed an event after the first import, a re-run does not overwrite your changes — and it also does not pick up changes made on the Google side since. The importer adds what is new; it never updates.

## Picking up after a cancel or a partial run

If you cancelled, hit the size limit, or lost the connection, simply run the import again with the same files. Everything written the first time is skipped and the run continues with what was missing. This is also how to import a large export in stages: select some of the numbered parts, import, then **Import More** with the rest — see [Importing from Google](help://google-takeout-import:importing-from-google).

## Services that are greyed out

A service row is disabled when its package is not installed on this server, even if the archive contains that data. Once the package is installed, select the same files again and the row becomes available; the other services are skipped as already imported.

Mail is also greyed out until you have a mailbox — create or join one in [Settings → Mailboxes](help://mail:mailboxes).
