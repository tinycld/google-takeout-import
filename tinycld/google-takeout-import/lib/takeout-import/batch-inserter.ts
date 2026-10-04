// biome-ignore-all lint/plugin/pbtsdb-no-raw-pb-access: dedicated bulk importer — operates on a raw PocketBase handle passed in (BatchInserterOptions.pb), outside React/the optimistic store, doing batched create + existence-check reads with retry/cancel/progress. Every pb access here is intentional, like the seed scripts.
import { log } from '@tinycld/core/lib/logger'
import { newRecordId } from 'pbtsdb/core'
import type PocketBase from 'pocketbase'
import type {
    ImportContext,
    ImportProgress,
    ImportService,
    ParsedCalendar,
    ParsedCalendarEvent,
    ParsedContact,
    ParsedDriveFile,
    ParsedDriveFolder,
    ParsedMailMessage,
    ParsedMailMessageRecord,
    ParsedRecord,
    ParsedUnreadable,
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
    onProgress: (service: ImportService, update: Partial<ImportProgress>) => void
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

    function reportFailure(service: ImportService, reason: string, count: number) {
        onProgress(service, { errors: count, errorMessages: [reason] })
    }

    function reportUnreadable(service: ImportService, reason: string) {
        reportFailure(service, reason, 1)
        log.warn('takeout-import.unreadable', reason, { service })
    }

    async function insertRecord(record: InsertableRecord): Promise<InsertOutcome> {
        switch (record.recordType) {
            case 'contact':
                return insertContact(record)
            case 'calendar':
                return insertCalendar(record)
            case 'calendar_event':
                return insertCalendarEvent(record)
            case 'drive_folder':
                return insertDriveFolder(record)
            case 'drive_file':
                return insertDriveFile(record)
            case 'mail_message':
                return insertMailRecord(record)
        }
    }

    async function insertRecords(records: ParsedRecord[]) {
        for (const record of records) {
            if (isCancelled()) return
            if (record.recordType === 'unreadable') {
                reportUnreadable(record.service, record.reason)
                continue
            }
            const service = SERVICE_FOR_RECORD[record.recordType]
            const units = progressUnits(record)
            try {
                const outcome = await insertRecord(record)
                if (units > 0) onProgress(service, { [outcome]: units })
                for (const problem of partialProblems(record)) reportUnreadable(service, problem)
            } catch (err) {
                const msg = err instanceof Error ? err.message : 'Unknown error'
                reportFailure(service, msg, Math.max(units, 1))
                onException?.('takeout-import', err)
            }
        }
    }

    async function insertContact(contact: ParsedContact): Promise<InsertOutcome> {
        if (contact.vcard_uid) {
            try {
                await pb
                    .collection('contacts')
                    .getFirstListItem(pb.filter('vcard_uid = {:uid}', { uid: contact.vcard_uid }))
                return 'skipped'
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
                return 'skipped'
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
                return 'skipped'
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
        return 'imported'
    }

    async function insertCalendar(cal: ParsedCalendar): Promise<InsertOutcome> {
        const calName = cal.name || 'Imported Calendar'

        // Reuse an existing calendar with the same name.
        //
        // Deliberately unscoped: the read is evaluated under the caller's
        // credentials, so calendar_calendars' list rule already narrows it to
        // calendars they're a member of. Safe while one deployment is one org —
        // but if a router ever multiplexes several orgs over ONE PocketBase
        // instance, this (and the ical_uid/message_id lookups below) would match
        // across tenants. See hosting/HANDOFF.md.
        try {
            const existing = await pb
                .collection('calendar_calendars')
                .getFirstListItem(pb.filter('name = {:name}', { name: calName }))
            calendarIdMap.set(cal.name, existing.id)
            return 'skipped'
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
        return 'imported'
    }

    async function insertCalendarEvent(event: ParsedCalendarEvent): Promise<InsertOutcome> {
        const calendarId = calendarIdMap.get(event.calendarName)
        if (!calendarId) {
            throw new Error(
                `Calendar "${event.calendarName}" was not created, so event "${event.title || '(No title)'}" was not imported`
            )
        }

        if (event.ical_uid) {
            try {
                await pb
                    .collection('calendar_events')
                    .getFirstListItem(pb.filter('ical_uid = {:uid}', { uid: event.ical_uid }))
                return 'skipped'
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
        return 'imported'
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

    async function insertDriveFolder(folder: ParsedDriveFolder): Promise<InsertOutcome> {
        if (folderIdMap.has(folder.path)) return 'skipped'

        const parentPath = folder.path.split('/').slice(0, -1).join('/')
        const parentId = parentPath ? folderIdMap.get(parentPath) : ''
        if (parentId === undefined) {
            throw new Error(
                `Folder "${parentPath}" was not created, so folder "${folder.path}" was not imported`
            )
        }

        // Check for existing folder — reuse its ID for child resolution
        try {
            const existing = await pb.collection('drive_items').getFirstListItem(
                pb.filter('name = {:name} && parent = {:parent} && is_folder = true', {
                    name: folder.name,
                    parent: parentId,
                })
            )
            folderIdMap.set(folder.path, existing.id)
            return 'skipped'
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

        // The drive server hook creates the owner drive_shares row in the same
        // transaction as the item, keyed on created_by. A second insert here
        // trips the (item, user, group) unique index.
        await withRetry(() => pb.collection('drive_items').create(formData))
        folderIdMap.set(folder.path, folderId)
        return 'imported'
    }

    async function insertDriveFile(file: ParsedDriveFile): Promise<InsertOutcome> {
        const parentId = file.parentPath ? folderIdMap.get(file.parentPath) : ''
        if (parentId === undefined) {
            throw new Error(
                `Folder "${file.parentPath}" was not created, so "${file.name}" was not imported`
            )
        }

        if (await isDriveDupe(file.name, parentId)) {
            return 'skipped'
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
        return 'imported'
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

    // Thread rows created so far, keyed by thread plan. A thread found to be
    // imported already maps to SKIPPED_THREAD so its later messages skip too.
    const threadIds = new Map<string, string>()
    const SKIPPED_THREAD = ''

    async function startThread(record: ParsedMailMessageRecord): Promise<string> {
        const { thread } = record
        if (thread.earliestMessageId) {
            try {
                await pb
                    .collection('mail_messages')
                    .getFirstListItem(
                        pb.filter('message_id = {:mid}', { mid: thread.earliestMessageId })
                    )
                return SKIPPED_THREAD
            } catch (err) {
                if (!isNotFound(err)) throw err
                // Not found — proceed
            }
        }

        const threadRecord = await withRetry(() =>
            pb.collection('mail_threads').create({
                mailbox: mailboxId,
                subject: thread.subject.slice(0, 998),
                // The thread shows its earliest message's snippet; a thread
                // started by a later message gets it when that one arrives.
                snippet: record.isEarliest ? record.message.snippet.slice(0, 300) : '',
                message_count: thread.messageCount,
                latest_date: thread.latestDate,
                participants: thread.participants,
            })
        )

        const threadState = await withRetry(() =>
            pb.collection('mail_thread_state').create({
                thread: threadRecord.id,
                user: userId,
                folder: thread.folder,
                is_read: thread.isRead,
                is_starred: thread.isStarred,
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
        return threadRecord.id
    }

    async function insertMailRecord(record: ParsedMailMessageRecord): Promise<InsertOutcome> {
        if (!mailboxId) throw new Error('No mailbox to import mail into')

        let threadId = threadIds.get(record.thread.key)
        const isThreadStart = threadId === undefined
        if (threadId === undefined) {
            threadId = await startThread(record)
            threadIds.set(record.thread.key, threadId)
        }
        if (threadId === SKIPPED_THREAD) return 'skipped'

        await insertMailMessage(threadId, record.message)
        if (record.isEarliest && !isThreadStart) {
            const id = threadId
            await withRetry(() =>
                pb
                    .collection('mail_threads')
                    .update(id, { snippet: record.message.snippet.slice(0, 300) })
            )
        }
        return 'imported'
    }

    async function insertMailMessage(threadId: string, msg: ParsedMailMessage) {
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

        if (msg.in_reply_to) {
            formData.append('in_reply_to', msg.in_reply_to)
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

type InsertableRecord = Exclude<ParsedRecord, ParsedUnreadable>
type InsertOutcome = 'imported' | 'skipped'

const SERVICE_FOR_RECORD: Record<InsertableRecord['recordType'], ImportService> = {
    contact: 'contacts',
    calendar: 'calendar',
    calendar_event: 'calendar',
    drive_folder: 'drive',
    drive_file: 'drive',
    mail_message: 'mail',
}

// Progress is counted in the units the detection totals use: a calendar
// container counts for nothing, since its events carry the count.
function progressUnits(record: InsertableRecord): number {
    return record.recordType === 'calendar' ? 0 : 1
}

// Parts of an imported record that could not be carried over, such as a
// corrupt attachment on a message that otherwise imported.
function partialProblems(record: InsertableRecord): string[] {
    if (record.recordType !== 'mail_message') return []
    const { message } = record
    return message.problems.map(problem => `"${message.subject || '(No Subject)'}": ${problem}`)
}
