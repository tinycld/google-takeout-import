export type ImportService = 'contacts' | 'calendar' | 'drive' | 'mail'

/**
 * Random-access view of one selected archive. The import reads it in ranges
 * and never loads a whole archive: browsers cannot hold a file of more than
 * about 2 GB in one array, and Google splits exports into parts of up to 50 GB.
 */
export interface TakeoutFile {
    name: string
    byteLength(): Promise<number>
    readRange(start: number, length: number): Promise<Uint8Array>
}

export type ImportPhase = 'scanning' | 'importing' | 'done'

export interface ImportProgress {
    service: ImportService
    phase: ImportPhase
    total: number
    imported: number
    skipped: number
    errors: number
    errorMessages: string[]
}

export interface TakeoutDetection {
    hasContacts: boolean
    hasCalendar: boolean
    hasDrive: boolean
    hasMail: boolean
    contactCount: number
    eventCount: number
    driveFileCount: number
    mailThreadCount: number
    fileCount: number
    totalSize: number
}

export interface ImportContext {
    userId: string
    mailboxId: string | null
}

// Parsed record types
export type ParsedRecord =
    | ParsedContact
    | ParsedCalendarEvent
    | ParsedCalendar
    | ParsedDriveFolder
    | ParsedDriveFile
    | ParsedMailMessageRecord
    | ParsedUnreadable

/**
 * An item the parser found in the export but cannot turn into a record. It is
 * reported as a failure with its reason — nothing in an export is dropped
 * without the user seeing why.
 */
export interface ParsedUnreadable {
    recordType: 'unreadable'
    service: ImportService
    reason: string
}

export function unreadable(service: ImportService, reason: string): ParsedUnreadable {
    return { recordType: 'unreadable', service, reason }
}

export interface ParsedContact {
    recordType: 'contact'
    first_name: string
    last_name: string
    email: string
    phone: string
    company: string
    job_title: string
    notes: string
    vcard_uid: string
}

export interface ParsedCalendar {
    recordType: 'calendar'
    name: string
    events: ParsedCalendarEvent[]
}

export interface ParsedCalendarEvent {
    recordType: 'calendar_event'
    calendarName: string
    title: string
    description: string
    location: string
    start: string
    end: string
    all_day: boolean
    recurrence: string
    ical_uid: string
    guests: EventGuest[]
    reminder: number
    busy_status: 'busy' | 'free'
    visibility: 'default' | 'public' | 'private'
}

export interface EventGuest {
    name: string
    email: string
    rsvp: string
}

export interface ParsedDriveFolder {
    recordType: 'drive_folder'
    path: string
    name: string
}

export interface ParsedDriveFile {
    recordType: 'drive_file'
    path: string
    name: string
    parentPath: string
    mime_type: string
    size: number
    bytes: ArrayBuffer
}

export type MailFolder = 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive'

/**
 * Everything a thread row needs, worked out from the headers of all its
 * messages in a first pass over the mbox. A thread's messages are scattered
 * through the file, so the insert pass cannot see them together.
 */
export interface MailThreadPlan {
    key: string
    subject: string
    messageCount: number
    latestDate: string
    participants: { name: string; email: string }[]
    folder: MailFolder
    isRead: boolean
    isStarred: boolean
    labels: string[]
    /** message_id of the earliest message; if that row exists, the thread was imported before. */
    earliestMessageId: string
}

/** One message, streamed in the insert pass, with the plan of its thread. */
export interface ParsedMailMessageRecord {
    recordType: 'mail_message'
    thread: MailThreadPlan
    message: ParsedMailMessage
    /** The thread's earliest message, whose snippet the thread row shows. */
    isEarliest: boolean
}

export interface ParsedMailMessage {
    message_id: string
    in_reply_to: string
    sender_name: string
    sender_email: string
    recipients_to: { name: string; email: string }[]
    recipients_cc: { name: string; email: string }[]
    date: string
    subject: string
    snippet: string
    body_html: string
    has_attachments: boolean
    attachments: ParsedAttachment[]
    /** Parts of the message that could not be imported, e.g. a corrupt attachment. */
    problems: string[]
}

export interface ParsedAttachment {
    filename: string
    mime_type: string
    bytes: ArrayBuffer
}
