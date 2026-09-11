---
title: What gets imported
summary: Which parts of a Google Takeout export land in Mail, Calendar, Contacts, and Drive, and what is left out
tags: [import, google, takeout, gmail, mbox, ics, vcf, drive, docs]
order: 20
---

The importer reads four folders of a Google Takeout archive — **Mail**, **Calendar**, **Contacts**, and **Drive** — and writes each into the matching TinyCld package. A service only appears on the import screen when its package is installed on this server; anything else in the archive is ignored.

Every item is checked against what you already have before it is written. An item that already exists is **skipped**, not replaced — see [Re-running an import](help://google-takeout-import:re-running-an-import).

## Gmail → Mail

Google exports your mail as one `.mbox` file. Each message is imported into your **default mailbox** — you need one before the Mail row becomes available (see [Mailboxes](help://mail:mailboxes)). Messages that share a Gmail conversation are grouped into one thread.

- **Folder** — the Gmail label decides where a thread lands: Inbox, Sent, Drafts, Trash, or Spam. Anything with no folder label goes to **Archive**, unless it was unread, in which case it goes to **Inbox**.
- **Read and starred state** are preserved.
- **Your own labels** become TinyCld [labels](help://mail:labels) with the same names, created if they don't exist yet. Gmail's built-in labels (Important, Category Promotions, and so on) are not turned into labels.
- **Attachments** are imported with their messages.
- The body is imported as HTML, with plain-text-only messages converted so they display the same way.

## Google Calendar → Calendar

Each calendar in the export is a separate `.ics` file and becomes one TinyCld calendar with the same name. If you already have a calendar with that name, the events are added to it instead of creating a second one.

For each event: title, description, location, start and end, all-day flag, the repeat rule for recurring events, guests with their RSVP status, the first reminder, busy/free status, and visibility. Events with no start time are dropped.

## Google Contacts → Contacts

Every contact card in the export is imported into your personal address book with name, first email address, first phone number, company, job title, and notes. Google exports a contact into every group it belongs to; the importer recognises the repeats and imports each person once.

For the full field-by-field mapping, what is not carried over (photos, additional emails and phones, groups), and how a contact is matched to one you already have, see [Importing contacts from Google](help://contacts:importing).

## Google Drive → Drive

Files are imported into [Drive](help://drive:getting-started) in the same folder structure they had in Google Drive, with you as the owner. Folders that already exist with the same name in the same place are reused, and a file that already exists in that folder is skipped.

Google Docs, Sheets, and Slides have no file of their own in Google Drive, so Takeout converts them when it builds the export — by default to `.docx`, `.xlsx`, and `.pptx`, which is what you should keep so they open in Text and Calc. Whatever format you chose in Takeout is what arrives in Drive. The small `-metadata.json` file Google writes next to some items is not imported.

## What is not imported

Anything outside those four folders is left alone, including Photos, Keep, Chat, Meet, Tasks, YouTube, Maps, and your Google account settings. Within the four services, comments and version history on Drive files, Gmail filters and signatures, and calendar sharing settings are not part of the export and cannot be imported.
