import { countCalendarEntry, isCalendarPath, parseCalendarEntry } from './parsers/calendar'
import { isContactsPath, parseContactsEntry } from './parsers/contacts'
import { countDriveFiles, driveFileFromEntry, foldersFromPaths, isDrivePath } from './parsers/drive'
import { isMboxPath, parseMailMessage, readMailHeaders } from './parsers/mail'
import { type MailPlan, MailPlanBuilder } from './parsers/mail-plan'
import { MboxSplitter } from './parsers/mbox-splitter'
import {
    type ImportContext,
    type ImportService,
    type ParsedRecord,
    type TakeoutDetection,
    type TakeoutFile,
    unreadable,
} from './types'
import { EntryReadError, readEntry, readZipEntries, streamEntry, type ZipEntry } from './zip-reader'

const BATCH_SIZE = 50
// Flush a batch early once its records carry this many payload bytes, so a run
// of large attachments or Drive files is never held fifty at a time.
const BATCH_BYTES = 8 * 1024 * 1024

// Uncompressed-size ceiling. The import streams, so this no longer guards
// memory; it keeps one run to a size that finishes in a sensible time.
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024

function yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function tooLargeMessage(totalBytes: number): string {
    const gb = (totalBytes / (1024 * 1024 * 1024)).toFixed(1)
    return `This export is too large to import (${gb} GB uncompressed). Split your Google Takeout archive into smaller downloads and import them one at a time.`
}

interface ArchiveEntry {
    file: TakeoutFile
    entry: ZipEntry
}

async function listEntries(files: TakeoutFile[]): Promise<ArchiveEntry[]> {
    const all: ArchiveEntry[] = []
    for (const file of files) {
        for (const entry of await readZipEntries(file)) all.push({ file, entry })
    }
    return all
}

/**
 * Stream an mbox entry message by message. `onMessage` gets each raw message
 * with its position in the mbox, which is the same in every pass.
 */
async function streamMbox(
    { file, entry }: ArchiveEntry,
    onMessage: (raw: Uint8Array, index: number) => void | Promise<void>
) {
    const splitter = new MboxSplitter()
    let index = 0
    await streamEntry(file, entry, async chunk => {
        for (const raw of splitter.push(chunk)) await onMessage(raw, index++)
    })
    for (const raw of splitter.end()) await onMessage(raw, index++)
}

/**
 * Detect which services an export contains, plus record counts. Only the
 * small `.vcf` / `.ics` entries are read whole; the mbox is counted as it
 * streams. Drive files are counted from the directory without reading them.
 */
export async function detectOnly(files: TakeoutFile[]): Promise<TakeoutDetection> {
    const entries = await listEntries(files)
    const drivePaths = entries.map(e => e.entry.name).filter(isDrivePath)
    let contactCount = 0
    let eventCount = 0
    let mailThreadCount = 0
    let totalSize = 0

    for (const archiveEntry of entries) {
        const { file, entry } = archiveEntry
        const path = entry.name
        totalSize += entry.size
        try {
            if (isMboxPath(path)) {
                await streamMbox(archiveEntry, () => {
                    mailThreadCount++
                })
            } else if (isContactsPath(path)) {
                // Unreadable cards count too: the import reports each as a
                // failure, so the total covers everything in the export.
                contactCount += parseContactsEntry(path, await readEntry(file, entry)).length
            } else if (isCalendarPath(path)) {
                eventCount += countCalendarEntry(path, await readEntry(file, entry))
            }
        } catch (err) {
            if (!(err instanceof EntryReadError)) throw err
            // The import reports this entry as one unreadable item.
            if (isMboxPath(path)) mailThreadCount++
            else if (isContactsPath(path)) contactCount++
            else if (isCalendarPath(path)) eventCount++
        }
    }

    const driveFileCount = countDriveFiles(drivePaths)

    return {
        hasContacts: contactCount > 0,
        hasCalendar: eventCount > 0,
        hasDrive: driveFileCount > 0,
        hasMail: mailThreadCount > 0,
        contactCount,
        eventCount,
        driveFileCount,
        mailThreadCount,
        fileCount: entries.length,
        totalSize,
    }
}

export interface FallbackCallbacks {
    onBatch: (service: ImportService, records: ParsedRecord[]) => Promise<void>
    onProgress: (
        service: ImportService,
        phase: 'scanning' | 'importing' | 'done',
        total: number
    ) => void
    onDone: () => void
    onError: (message: string) => void
    /**
     * Expected record counts per service (from the detection shown to the user),
     * used only to drive the progress bars. Streaming doesn't know counts up
     * front, so these keep the percentages accurate; they never gate insertion.
     */
    expectedTotals?: Partial<Record<ImportService, number>>
    /** Override the total-uncompressed-size ceiling. Test seam. */
    maxTotalUncompressedBytes?: number
}

function payloadBytes(record: ParsedRecord): number {
    if (record.recordType === 'drive_file') return record.bytes.byteLength
    if (record.recordType !== 'mail_message') return 0
    const { message } = record
    return (
        message.body_html.length +
        message.attachments.reduce((sum, a) => sum + a.bytes.byteLength, 0)
    )
}

/**
 * Buffers records for one service and flushes them to `onBatch` in batches
 * bounded by count and by payload bytes, so bytes carried by each record
 * (Drive files, mail bodies and attachments) are released as soon as the batch
 * is inserted. Progress is reported as the batches drain.
 */
function createServiceSink(service: ImportService, callbacks: FallbackCallbacks) {
    const buffer: ParsedRecord[] = []
    let bufferedBytes = 0

    async function flush() {
        if (buffer.length === 0) return
        const batch = buffer.splice(0, buffer.length)
        bufferedBytes = 0
        await callbacks.onBatch(service, batch)
        await yieldToUI()
    }

    async function add(record: ParsedRecord) {
        buffer.push(record)
        bufferedBytes += payloadBytes(record)
        if (buffer.length >= BATCH_SIZE || bufferedBytes >= BATCH_BYTES) await flush()
    }

    return {
        add,
        async addMany(records: ParsedRecord[]) {
            for (const record of records) await add(record)
        },
        flush,
    }
}

type Sink = ReturnType<typeof createServiceSink>

async function planMailbox(archiveEntry: ArchiveEntry): Promise<MailPlan> {
    const builder = new MailPlanBuilder()
    await streamMbox(archiveEntry, (raw, index) => {
        const headers = readMailHeaders(raw)
        if (headers) builder.add(index, headers)
    })
    return builder.build()
}

async function importMailbox(archiveEntry: ArchiveEntry, sink: Sink) {
    const plan = await planMailbox(archiveEntry)
    await streamMbox(archiveEntry, async (raw, index) => {
        const planned = plan.lookup(index)
        const message = planned ? parseMailMessage(raw) : null
        if (!planned || !message) {
            await sink.add(
                unreadable('mail', `Mail message ${index + 1} in the export has no headers`)
            )
            return
        }
        await sink.add({
            recordType: 'mail_message',
            thread: planned.thread,
            message: {
                ...message,
                in_reply_to: message.in_reply_to || planned.previousMessageId,
            },
            isEarliest: planned.isEarliest,
        })
    })
}

export async function runFallbackImport(
    files: TakeoutFile[],
    services: ImportService[],
    context: ImportContext,
    callbacks: FallbackCallbacks
) {
    try {
        // Pre-flight (Guard B): mail requires a resolved mailbox. Throwing here
        // converts a silent 0-thread import into a visible, retryable error.
        if (services.includes('mail') && !context.mailboxId) {
            throw new Error('Mail selected but no mailbox is ready — try again in a moment.')
        }

        // The zip directories give the folder tree (for parents-first drive
        // insertion) and the size-guard total without reading any payload.
        const entries = await listEntries(files)
        const totalSize = entries.reduce((sum, e) => sum + e.entry.size, 0)
        const maxBytes = callbacks.maxTotalUncompressedBytes ?? MAX_TOTAL_UNCOMPRESSED_BYTES
        if (totalSize > maxBytes) {
            throw new Error(tooLargeMessage(totalSize))
        }

        const wantContacts = services.includes('contacts')
        const wantCalendar = services.includes('calendar')
        const wantDrive = services.includes('drive')
        const wantMail = services.includes('mail')
        const totals = callbacks.expectedTotals ?? {}

        const drivePaths = entries.map(e => e.entry.name)
        const driveFolders = wantDrive ? foldersFromPaths(drivePaths) : []
        const driveTotal = driveFolders.length + countDriveFiles(drivePaths)

        const sinks: Record<ImportService, Sink> = {
            contacts: createServiceSink('contacts', callbacks),
            calendar: createServiceSink('calendar', callbacks),
            drive: createServiceSink('drive', callbacks),
            mail: createServiceSink('mail', callbacks),
        }

        const serviceFor = (path: string): ImportService | null => {
            if (wantDrive && isDrivePath(path)) return 'drive'
            if (wantContacts && isContactsPath(path)) return 'contacts'
            if (wantCalendar && isCalendarPath(path)) return 'calendar'
            if (wantMail && isMboxPath(path)) return 'mail'
            return null
        }

        for (const service of services) callbacks.onProgress(service, 'scanning', 0)
        await yieldToUI()

        // Drive folders come from entry names only — insert them first so files
        // (read next) resolve their parents.
        if (wantDrive) {
            callbacks.onProgress('drive', 'importing', driveTotal)
            await sinks.drive.addMany(driveFolders)
            await sinks.drive.flush()
        }

        if (wantContacts) callbacks.onProgress('contacts', 'importing', totals.contacts ?? 0)
        if (wantCalendar) callbacks.onProgress('calendar', 'importing', totals.calendar ?? 0)
        if (wantMail) callbacks.onProgress('mail', 'importing', totals.mail ?? 0)

        for (const archiveEntry of entries) {
            const { file, entry } = archiveEntry
            const path = entry.name
            const service = serviceFor(path)
            if (!service) continue
            const sink = sinks[service]
            try {
                if (service === 'mail') {
                    await importMailbox(archiveEntry, sink)
                } else if (service === 'drive') {
                    const driveFile = driveFileFromEntry(path, await readEntry(file, entry))
                    if (driveFile) await sink.add(driveFile)
                } else if (service === 'contacts') {
                    await sink.addMany(parseContactsEntry(path, await readEntry(file, entry)))
                } else {
                    const { calendar, unreadable: failures } = parseCalendarEntry(
                        path,
                        await readEntry(file, entry)
                    )
                    if (calendar) {
                        await sink.add(calendar)
                        await sink.addMany(calendar.events)
                    }
                    await sink.addMany(failures)
                }
            } catch (err) {
                if (!(err instanceof EntryReadError)) throw err
                await sink.add(unreadable(service, err.message))
            }
        }

        for (const service of services) await sinks[service].flush()

        if (wantContacts) callbacks.onProgress('contacts', 'done', totals.contacts ?? 0)
        if (wantCalendar) callbacks.onProgress('calendar', 'done', totals.calendar ?? 0)
        if (wantDrive) callbacks.onProgress('drive', 'done', driveTotal)
        if (wantMail) callbacks.onProgress('mail', 'done', totals.mail ?? 0)

        callbacks.onDone()
    } catch (err) {
        callbacks.onError(err instanceof Error ? err.message : 'Import failed')
    }
}
