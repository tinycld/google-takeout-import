// biome-ignore-all lint/plugin/pbtsdb-no-raw-pb-access: dedicated bulk importer — operates on a raw PocketBase handle passed in (BatchInserterOptions.pb), outside React/the optimistic store, doing batched create + existence-check reads with retry/cancel/progress. Every pb access here is intentional, like the seed scripts.
import { newRecordId } from 'pbtsdb/core'
import type PocketBase from 'pocketbase'
import { describeFailure } from './describe-failure'
import { asHtmlDocument } from './html-document'
import type {
    ImportContext,
    ImportProgress,
    ImportService,
    MailThreadPlan,
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
    } catch (err) {
        if (isRejectedRequest(err)) throw err
        await new Promise(r => setTimeout(r, 1000))
        return fn()
    }
}

// The server refused the request itself (validation, permissions), so sending
// the same payload again gets the same answer. 429 is the exception: it asks
// for a later retry.
function isRejectedRequest(err: unknown): boolean {
    const status = (err as { status?: number } | null)?.status ?? 0
    return status >= 400 && status < 500 && status !== 429
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
}

export function createBatchInserter({
    pb,
    context,
    onProgress,
    cancelSignal,
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
                // A failed item is reported to the user in the import panel,
                // not to Sentry: it is a problem with their data, not an app
                // fault, and a large mailbox can fail thousands of items.
                const reason = `${recordLabel(record)}: ${describeFailure(err)}`
                reportFailure(service, reason, Math.max(units, 1))
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
        } else {
            // The parser always sets first_name. A card with a one-part name,
            // such as a company or a bare phone number, is matched on its
            // phone too, so two such contacts with the same name both import.
            const filter = contact.last_name
                ? 'first_name = {:first} && last_name = {:last} && owner = {:owner}'
                : 'first_name = {:first} && last_name = "" && phone = {:phone} && owner = {:owner}'
            try {
                await pb.collection('contacts').getFirstListItem(
                    pb.filter(filter, {
                        first: contact.first_name,
                        last: contact.last_name,
                        phone: contact.phone,
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
        // calendars they're a member of.
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
            throw new Error(`Not imported because calendar "${event.calendarName}" was not created`)
        }

        // UIDs are unique within a calendar, not across calendars. An event
        // with no UID gets a random one below, so a later run matches it on
        // title and start instead.
        const title = event.title || '(No title)'
        const existing = event.ical_uid
            ? pb.filter('calendar = {:cal} && ical_uid = {:uid}', {
                  cal: calendarId,
                  uid: event.ical_uid,
              })
            : pb.filter('calendar = {:cal} && title = {:title} && start = {:start}', {
                  cal: calendarId,
                  title,
                  start: toStoredDate(event.start),
              })
        try {
            await pb.collection('calendar_events').getFirstListItem(existing)
            return 'skipped'
        } catch (err) {
            if (!isNotFound(err)) throw err
            // Not found — proceed to create
        }

        await withRetry(() =>
            pb.collection('calendar_events').create({
                id: newRecordId(),
                calendar: calendarId,
                created_by: userId,
                title,
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
            throw new Error(`Not imported because folder "${parentPath}" was not created`)
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
            throw new Error(`Not imported because folder "${file.parentPath}" was not created`)
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

    // The thread each plan resolved to in this run. `reused` marks a thread an
    // earlier import made, which may already hold some of the messages.
    const threads = new Map<string, ResolvedThread>()
    const claimedThreadIds = new Set<string>()

    // An import can be run again after a partial failure, so the thread may
    // exist already. It is found through any message of it that imported, or,
    // when none did, as the empty thread the earlier run left behind.
    async function findImportedThread(thread: MailThreadPlan): Promise<string | undefined> {
        const messageIds = thread.messageIds.filter(Boolean)
        for (let i = 0; i < messageIds.length; i += MESSAGE_ID_CHUNK) {
            const params: Record<string, string | null> = { mailbox: mailboxId }
            const terms = messageIds.slice(i, i + MESSAGE_ID_CHUNK).map((mid, n) => {
                params[`m${n}`] = mid
                return `message_id = {:m${n}}`
            })
            const found = await pb.collection('mail_messages').getList<{ thread: string }>(1, 1, {
                filter: pb.filter(`thread.mailbox = {:mailbox} && (${terms.join(' || ')})`, params),
            })
            if (found.items[0]) return found.items[0].thread
        }
        return findEmptyThread(thread)
    }

    async function findEmptyThread(thread: MailThreadPlan): Promise<string | undefined> {
        const candidates = await pb
            .collection('mail_threads')
            .getList<{ id: string; latest_date: string }>(1, 50, {
                filter: pb.filter('mailbox = {:mailbox} && subject = {:subject}', {
                    mailbox: mailboxId,
                    subject: threadSubject(thread),
                }),
            })
        for (const candidate of candidates.items) {
            if (claimedThreadIds.has(candidate.id)) continue
            if (!isSameInstant(candidate.latest_date, thread.latestDate)) continue
            const messages = await pb.collection('mail_messages').getList(1, 1, {
                filter: pb.filter('thread = {:thread}', { thread: candidate.id }),
            })
            if (messages.items.length === 0) return candidate.id
        }
        return undefined
    }

    async function resolveThread(record: ParsedMailMessageRecord): Promise<ResolvedThread> {
        const existingId = await findImportedThread(record.thread)
        const resolved = existingId
            ? { id: existingId, reused: true }
            : { id: await createThread(record), reused: false }
        await addThreadState(resolved, record.thread)
        claimedThreadIds.add(resolved.id)
        return resolved
    }

    async function createThread(record: ParsedMailMessageRecord): Promise<string> {
        const { thread } = record
        const threadRecord = await withRetry(() =>
            pb.collection('mail_threads').create({
                mailbox: mailboxId,
                subject: threadSubject(thread),
                // The thread shows its earliest message's snippet; a thread
                // started by a later message gets it when that one arrives.
                snippet: record.isEarliest ? record.message.snippet.slice(0, 300) : '',
                message_count: thread.messageCount,
                latest_date: thread.latestDate,
                participants: thread.participants,
            })
        )
        return threadRecord.id
    }

    // A reused thread keeps the state and labels the earlier run gave it, and
    // gets only the parts that run did not reach.
    async function addThreadState(resolved: ResolvedThread, thread: MailThreadPlan) {
        const existingStateId = resolved.reused ? await findThreadState(resolved.id) : undefined
        const stateId = existingStateId ?? (await createThreadState(resolved.id, thread))

        for (const labelName of thread.labels) {
            const labelId = await getOrCreateLabel(labelName)
            if (existingStateId && (await hasLabelAssignment(labelId, stateId))) continue
            await withRetry(() =>
                pb.collection('label_assignments').create({
                    label: labelId,
                    record_id: stateId,
                    collection: 'mail_thread_state',
                    user: userId,
                })
            )
        }
    }

    async function findThreadState(threadId: string): Promise<string | undefined> {
        const found = await pb.collection('mail_thread_state').getList(1, 1, {
            filter: pb.filter('thread = {:thread} && user = {:user}', {
                thread: threadId,
                user: userId,
            }),
        })
        return found.items[0]?.id
    }

    async function createThreadState(threadId: string, thread: MailThreadPlan): Promise<string> {
        const state = await withRetry(() =>
            pb.collection('mail_thread_state').create({
                thread: threadId,
                user: userId,
                folder: thread.folder,
                is_read: thread.isRead,
                is_starred: thread.isStarred,
            })
        )
        return state.id
    }

    async function hasLabelAssignment(labelId: string, stateId: string): Promise<boolean> {
        const found = await pb.collection('label_assignments').getList(1, 1, {
            filter: pb.filter('label = {:label} && record_id = {:record}', {
                label: labelId,
                record: stateId,
            }),
        })
        return found.items.length > 0
    }

    // A message without a Message-ID is matched on sender, subject and date.
    async function isMessageImported(threadId: string, msg: ParsedMailMessage): Promise<boolean> {
        if (msg.message_id) {
            const found = await pb.collection('mail_messages').getList(1, 1, {
                filter: pb.filter('thread = {:thread} && message_id = {:mid}', {
                    thread: threadId,
                    mid: msg.message_id,
                }),
            })
            return found.items.length > 0
        }
        const candidates = await pb.collection('mail_messages').getList<{ date: string }>(1, 50, {
            filter: pb.filter(
                'thread = {:thread} && sender_email = {:sender} && subject = {:subject}',
                { thread: threadId, sender: msg.sender_email, subject: msg.subject.slice(0, 998) }
            ),
        })
        return candidates.items.some(candidate => isSameInstant(candidate.date, msg.date))
    }

    async function insertMailRecord(record: ParsedMailMessageRecord): Promise<InsertOutcome> {
        if (!mailboxId) throw new Error('No mailbox to import mail into')

        let thread = threads.get(record.thread.key)
        const isThreadStart = thread === undefined
        if (thread === undefined) {
            thread = await resolveThread(record)
            threads.set(record.thread.key, thread)
        }
        if (thread.reused && (await isMessageImported(thread.id, record.message))) return 'skipped'

        await insertMailMessage(thread.id, record.message)
        const hasSnippet = isThreadStart && !thread.reused
        if (record.isEarliest && !hasSnippet) {
            const id = thread.id
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

        const htmlBlob = new File([asHtmlDocument(msg.body_html)], 'body.html', {
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

interface ResolvedThread {
    id: string
    reused: boolean
}

// Message-IDs per thread lookup, to keep the filter well under URL limits.
const MESSAGE_ID_CHUNK = 25

function threadSubject(thread: MailThreadPlan): string {
    return thread.subject.slice(0, 998)
}

// The form PocketBase stores a date in, which a filter must match exactly.
function toStoredDate(iso: string): string {
    return new Date(iso).toISOString().replace('T', ' ')
}

// PocketBase returns dates as "2024-01-29 17:34:35.000Z", not ISO 8601, so the
// same instant can be written two ways.
function isSameInstant(stored: string, parsed: string): boolean {
    const time = Date.parse(stored.replace(' ', 'T'))
    return !Number.isNaN(time) && time === Date.parse(parsed)
}

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

function recordLabel(record: InsertableRecord): string {
    switch (record.recordType) {
        case 'contact':
            return `"${contactName(record) || record.email || '(No name)'}"`
        case 'calendar':
            return `"${record.name || 'Imported Calendar'}"`
        case 'calendar_event':
            return `"${record.title || '(No title)'}"`
        case 'drive_folder':
            return `"${record.path}"`
        case 'drive_file':
            return `"${record.parentPath ? `${record.parentPath}/` : ''}${record.name}"`
        case 'mail_message':
            return `"${record.message.subject || '(No Subject)'}"`
    }
}

function contactName(contact: ParsedContact): string {
    return [contact.first_name, contact.last_name].filter(Boolean).join(' ')
}

// Parts of an imported record that could not be carried over, such as a
// corrupt attachment on a message that otherwise imported.
function partialProblems(record: InsertableRecord): string[] {
    if (record.recordType !== 'mail_message') return []
    const { message } = record
    return message.problems.map(problem => `"${message.subject || '(No Subject)'}": ${problem}`)
}
