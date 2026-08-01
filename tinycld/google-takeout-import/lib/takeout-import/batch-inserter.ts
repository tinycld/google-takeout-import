// biome-ignore-all lint/plugin/pbtsdb-no-raw-pb-access: dedicated bulk importer — operates on a raw PocketBase handle passed in (BatchInserterOptions.pb), outside React/the optimistic store, doing batched create + existence-check reads with retry/cancel/progress. Every pb access here is intentional, like the seed scripts.
import { newRecordId } from 'pbtsdb/core'
import type PocketBase from 'pocketbase'
import type {
    ImportContext,
    ImportProgress,
    ParsedCalendar,
    ParsedCalendarEvent,
    ParsedContact,
    ParsedDriveFile,
    ParsedDriveFolder,
    ParsedMailMessage,
    ParsedMailThread,
    ParsedRecord,
} from './types'

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn()
    } catch {
        await new Promise(r => setTimeout(r, 1000))
        return fn()
    }
}

// Dedup lookups may treat ONLY a 404 as "not found — create it". Any other
// failure (network drop, auth expiry, 500) must propagate: swallowing it here
// answered "does this record exist?" with "no" on a transient error, and the
// import then minted a duplicate (P2-11/R3).
function isNotFound(err: unknown): boolean {
    return (err as { status?: number } | null)?.status === 404
}

export interface BatchInserterOptions {
    pb: PocketBase
    context: ImportContext
    onProgress: (service: string, update: Partial<ImportProgress>) => void
    cancelSignal?: () => boolean
    onException?: (context: string, err: unknown) => void
}

export function createBatchInserter({
    pb,
    context,
    onProgress,
    cancelSignal,
    onException,
}: BatchInserterOptions) {
    const isCancelled = () => cancelSignal?.() === true
    const { userId, mailboxId } = context

    const folderIdMap = new Map<string, string>()
    const calendarIdMap = new Map<string, string>()
    const labelIdMap = new Map<string, string>()

    async function insertRecords(records: ParsedRecord[]) {
        for (const record of records) {
            if (isCancelled()) return
            try {
                switch (record.recordType) {
                    case 'contact':
                        await insertContact(record)
                        break
                    case 'calendar':
                        await insertCalendar(record)
                        break
                    case 'calendar_event':
                        await insertCalendarEvent(record)
                        break
                    case 'drive_folder':
                        await insertDriveFolder(record)
                        break
                    case 'drive_file':
                        await insertDriveFile(record)
                        break
                    case 'mail_thread':
                        await insertMailThread(record)
                        break
                }
                onProgress(record.recordType, { imported: 1 })
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Unknown error'
                onProgress(record.recordType, { errors: 1, errorMessages: [msg] })
                onException?.('takeout-import', err)
            }
        }
    }

    async function insertContact(contact: ParsedContact) {
        if (contact.vcard_uid) {
            try {
                await pb
                    .collection('contacts')
                    .getFirstListItem(pb.filter('vcard_uid = {:uid}', { uid: contact.vcard_uid }))
                onProgress('contact', { skipped: 1, imported: -1 })
                return
            } catch (err) {
                if (!isNotFound(err)) throw err
                // Not found — proceed to create
            }
        } else if (contact.email) {
            try {
                await pb.collection('contacts').getFirstListItem(
                    pb.filter('email = {:email} && owner = {:owner}', {
                        email: contact.email,
                        owner: userId,
                    })
                )
                onProgress('contact', { skipped: 1, imported: -1 })
                return
            } catch (err) {
                if (!isNotFound(err)) throw err
                // Not found — proceed to create
            }
        } else if (contact.first_name && contact.last_name) {
            try {
                await pb.collection('contacts').getFirstListItem(
                    pb.filter('first_name = {:first} && last_name = {:last} && owner = {:owner}', {
                        first: contact.first_name,
                        last: contact.last_name,
                        owner: userId,
                    })
                )
                onProgress('contact', { skipped: 1, imported: -1 })
                return
            } catch (err) {
                if (!isNotFound(err)) throw err
                // Not found — proceed to create
            }
        }

        await withRetry(() =>
            pb.collection('contacts').create({
                id: newRecordId(),
                first_name: contact.first_name,
                last_name: contact.last_name,
                email: contact.email,
                phone: contact.phone,
                company: contact.company,
                job_title: contact.job_title,
                notes: contact.notes,
                vcard_uid: contact.vcard_uid || crypto.randomUUID(),
                favorite: false,
                owner: userId,
            })
        )
    }

    async function insertCalendar(cal: ParsedCalendar) {
        const calName = cal.name || 'Imported Calendar'

        // Reuse an existing calendar with the same name.
        //
        // Deliberately unscoped: the read is evaluated under the caller's
        // credentials, so calendar_calendars' list rule already narrows it to
        // calendars they're a member of. Safe while one deployment is one org —
        // but if a router ever multiplexes several orgs over ONE PocketBase
        // instance, this (and the ical_uid/message_id lookups below) would match
        // across tenants. See multi-org/HANDOFF.md.
        try {
            const existing = await pb
                .collection('calendar_calendars')
                .getFirstListItem(pb.filter('name = {:name}', { name: calName }))
            calendarIdMap.set(cal.name, existing.id)
            onProgress('calendar', { skipped: 1, imported: -1 })
            return
        } catch (err) {
            if (!isNotFound(err)) throw err
            // Not found — create
        }

        const calId = newRecordId()
        await withRetry(() =>
            pb.collection('calendar_calendars').create({
                id: calId,
                name: calName,
                color: 'blue',
            })
        )
        calendarIdMap.set(cal.name, calId)

        // A server hook auto-creates the owner membership when a calendar is created.
        // Poll until the membership is visible through the events collection's rule context.
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                await pb.collection('calendar_events').getList(1, 1, {
                    filter: pb.filter('calendar = {:cal}', { cal: calId }),
                })
                break
            } catch {
                await new Promise(r => setTimeout(r, 300))
            }
        }
    }

    async function insertCalendarEvent(event: ParsedCalendarEvent) {
        const calendarId = calendarIdMap.get(event.calendarName)
        if (!calendarId) return

        if (event.ical_uid) {
            try {
                await pb
                    .collection('calendar_events')
                    .getFirstListItem(pb.filter('ical_uid = {:uid}', { uid: event.ical_uid }))
                onProgress('calendar_event', { skipped: 1, imported: -1 })
                return
            } catch (err) {
                if (!isNotFound(err)) throw err
                // Not found — proceed to create
            }
        }

        await withRetry(() =>
            pb.collection('calendar_events').create({
                id: newRecordId(),
                calendar: calendarId,
                created_by: userId,
                title: event.title || '(No title)',
                description: event.description,
                location: event.location,
                start: event.start,
                end: event.end || event.start,
                all_day: event.all_day,
                recurrence: event.recurrence,
                ical_uid: event.ical_uid || crypto.randomUUID(),
                guests: event.guests,
                reminder: event.reminder,
                busy_status: event.busy_status,
                visibility: event.visibility,
            })
        )
    }

    async function isDriveDupe(name: string, parentId: string): Promise<boolean> {
        try {
            await pb.collection('drive_items').getFirstListItem(
                pb.filter('name = {:name} && parent = {:parent}', {
                    name,
                    parent: parentId,
                })
            )
            return true
        } catch (err) {
            if (!isNotFound(err)) throw err
            return false
        }
    }

    async function insertDriveFolder(folder: ParsedDriveFolder) {
        if (folderIdMap.has(folder.path)) return

        const parentPath = folder.path.split('/').slice(0, -1).join('/')
        const parentId = folderIdMap.get(parentPath) || ''

        // Check for existing folder — reuse its ID for child resolution
        try {
            const existing = await pb.collection('drive_items').getFirstListItem(
                pb.filter('name = {:name} && parent = {:parent} && is_folder = true', {
                    name: folder.name,
                    parent: parentId,
                })
            )
            folderIdMap.set(folder.path, existing.id)
            onProgress('drive_folder', { skipped: 1, imported: -1 })
            return
        } catch (err) {
            if (!isNotFound(err)) throw err
            // Not found — create
        }

        const folderId = newRecordId()
        const formData = new FormData()
        formData.append('id', folderId)
        formData.append('name', folder.name)
        formData.append('is_folder', 'true')
        formData.append('mime_type', '')
        formData.append('parent', parentId)
        formData.append('created_by', userId)
        formData.append('size', '0')
        formData.append('description', '')

        await withRetry(() => pb.collection('drive_items').create(formData))
        folderIdMap.set(folder.path, folderId)

        await withRetry(() =>
            pb.collection('drive_shares').create({
                id: newRecordId(),
                item: folderId,
                user: userId,
                role: 'owner',
                created_by: userId,
            })
        )
    }

    async function insertDriveFile(file: ParsedDriveFile) {
        const parentId = folderIdMap.get(file.parentPath) || ''

        if (await isDriveDupe(file.name, parentId)) {
            onProgress('drive_file', { skipped: 1, imported: -1 })
            return
        }

        const itemId = newRecordId()
        const blob = new Blob([file.bytes], { type: file.mime_type })
        const fileObj = new File([blob], file.name, { type: file.mime_type })

        const formData = new FormData()
        formData.append('id', itemId)
        formData.append('name', file.name)
        formData.append('is_folder', 'false')
        formData.append('mime_type', file.mime_type || 'application/octet-stream')
        formData.append('parent', parentId)
        formData.append('created_by', userId)
        formData.append('size', String(file.size))
        formData.append('file', fileObj)
        formData.append('description', '')

        await withRetry(() => pb.collection('drive_items').create(formData))

        await withRetry(() =>
            pb.collection('drive_shares').create({
                id: newRecordId(),
                item: itemId,
                user: userId,
                role: 'owner',
                created_by: userId,
            })
        )
    }

    async function getOrCreateLabel(name: string): Promise<string> {
        const cached = labelIdMap.get(name)
        if (cached) return cached

        try {
            const existing = await pb.collection('labels').getFirstListItem(
                pb.filter('name = {:name} && user = {:user}', {
                    name,
                    user: userId,
                })
            )
            labelIdMap.set(name, existing.id)
            return existing.id
        } catch (err) {
            if (!isNotFound(err)) throw err
            // Not found — create
        }

        const labelId = newRecordId()
        await withRetry(() =>
            pb.collection('labels').create({
                id: labelId,
                user: userId,
                name,
                color: '#3949ab',
            })
        )
        labelIdMap.set(name, labelId)
        return labelId
    }

    async function insertMailThread(thread: ParsedMailThread) {
        if (!mailboxId) return

        const firstMsg = thread.messages[0]
        if (firstMsg?.message_id) {
            try {
                await pb
                    .collection('mail_messages')
                    .getFirstListItem(
                        pb.filter('message_id = {:mid}', { mid: firstMsg.message_id })
                    )
                onProgress('mail_thread', { skipped: 1, imported: -1 })
                return
            } catch (err) {
                if (!isNotFound(err)) throw err
                // Not found — proceed
            }
        }

        const latestDate =
            thread.messages.length > 0
                ? thread.messages.reduce(
                      (latest, m) => (m.date > latest ? m.date : latest),
                      thread.messages[0].date
                  )
                : new Date().toISOString()

        const participants = extractParticipants(thread.messages)

        const threadRecord = await withRetry(() =>
            pb.collection('mail_threads').create({
                mailbox: mailboxId,
                subject: thread.subject.slice(0, 998),
                snippet: thread.snippet.slice(0, 300),
                message_count: thread.messages.length,
                latest_date: latestDate,
                participants,
            })
        )

        let prevMessageId = ''
        for (const msg of thread.messages) {
            await insertMailMessage(threadRecord.id, msg, prevMessageId)
            prevMessageId = msg.message_id
        }

        const threadState = await withRetry(() =>
            pb.collection('mail_thread_state').create({
                thread: threadRecord.id,
                user: userId,
                folder: thread.folder,
                is_read: thread.is_read,
                is_starred: thread.is_starred,
            })
        )

        for (const labelName of thread.labels) {
            const labelId = await getOrCreateLabel(labelName)
            await withRetry(() =>
                pb.collection('label_assignments').create({
                    label: labelId,
                    record_id: threadState.id,
                    collection: 'mail_thread_state',
                    user: userId,
                })
            )
        }
    }

    async function insertMailMessage(
        threadId: string,
        msg: ParsedMailMessage,
        inReplyToOverride: string
    ) {
        const formData = new FormData()
        formData.append('thread', threadId)
        formData.append('sender_name', msg.sender_name)
        formData.append('sender_email', msg.sender_email)
        formData.append('recipients_to', JSON.stringify(msg.recipients_to))
        formData.append('recipients_cc', JSON.stringify(msg.recipients_cc))
        formData.append('date', msg.date)
        formData.append('subject', msg.subject.slice(0, 998))
        formData.append('snippet', msg.snippet.slice(0, 300))
        formData.append('has_attachments', String(msg.has_attachments))
        formData.append('message_id', msg.message_id)

        const replyTo = msg.in_reply_to || inReplyToOverride
        if (replyTo) {
            formData.append('in_reply_to', replyTo)
        }

        const htmlBlob = new File([msg.body_html || '<p></p>'], 'body.html', {
            type: 'text/html',
        })
        formData.append('body_html', htmlBlob)

        for (const att of msg.attachments) {
            const blob = new Blob([att.bytes], { type: att.mime_type })
            const file = new File([blob], att.filename, { type: att.mime_type })
            formData.append('attachments', file)
        }

        await withRetry(() => pb.collection('mail_messages').create(formData))
    }

    return { insertRecords }
}

function extractParticipants(messages: ParsedMailMessage[]): { name: string; email: string }[] {
    const seen = new Set<string>()
    const participants: { name: string; email: string }[] = []

    for (const msg of messages) {
        const all = [
            { name: msg.sender_name, email: msg.sender_email },
            ...msg.recipients_to,
            ...msg.recipients_cc,
        ]
        for (const p of all) {
            if (!p.email || seen.has(p.email)) continue
            seen.add(p.email)
            participants.push({ name: p.name, email: p.email })
        }
    }

    return participants
}
