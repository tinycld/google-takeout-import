import { isCalendarPath, parseCalendarEntry } from './parsers/calendar'
import { isContactsPath, parseContactsEntry } from './parsers/contacts'
import { countDriveFiles, driveFileFromEntry, foldersFromPaths, isDrivePath } from './parsers/drive'
import { countMboxMessagesInBytes, isMboxPath, parseMboxStream } from './parsers/mail'
import { scanZipEntries, streamZipEntries } from './streaming-unzip'
import type {
    ImportContext,
    ImportService,
    ParsedRecord,
    TakeoutDetection,
    TakeoutFile,
} from './types'

const BATCH_SIZE = 50

// Uncompressed-size ceiling. Even with streaming, an absurdly large export is
// rejected up front with a clear message rather than being attempted. Gmail's
// largest single-archive Takeout is ~2 GB; 8 GB across all selected zips is a
// generous belt-and-suspenders limit that still fits comfortably below the
// point where PocketBase uploads would dominate wall-clock time anyway.
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024

function yieldToUI(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
}

function tooLargeMessage(totalBytes: number): string {
    const gb = (totalBytes / (1024 * 1024 * 1024)).toFixed(1)
    return `This export is too large to import (${gb} GB uncompressed). Split your Google Takeout archive into smaller downloads and import them one at a time.`
}

/**
 * Detect which services an export contains, plus record counts, by reading the
 * zip directory and decompressing only the small metadata artifacts (mbox for a
 * message count, `.vcf`/`.ics` for contact/event counts). Drive-file and
 * attachment payloads are never decompressed here — detection stays cheap.
 */
export async function detectOnly(files: TakeoutFile[]): Promise<TakeoutDetection> {
    const drivePaths: string[] = []
    let contactCount = 0
    let eventCount = 0
    let mailThreadCount = 0
    let fileCount = 0

    const totalSize = await scanZipEntries(
        files,
        entry => {
            fileCount++
            if (isDrivePath(entry.path)) drivePaths.push(entry.path)
            // Only decompress the small metadata artifacts we must read to count.
            return (
                isMboxPath(entry.path) || isContactsPath(entry.path) || isCalendarPath(entry.path)
            )
        },
        (path, bytes) => {
            if (isMboxPath(path)) {
                mailThreadCount += countMboxMessagesInBytes(bytes)
            } else if (isContactsPath(path)) {
                contactCount += parseContactsEntry(bytes).length
            } else if (isCalendarPath(path)) {
                const cal = parseCalendarEntry(path, bytes)
                if (cal) eventCount += cal.events.length
            }
        }
    )

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
        fileCount,
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

/**
 * Buffers records for one service and flushes them to `onBatch` in fixed-size
 * batches, so bytes carried by each record (drive-file / attachment payloads)
 * are released as soon as the batch is inserted rather than held for the whole
 * run. Progress is reported as the batches drain.
 */
function createServiceSink(service: ImportService, callbacks: FallbackCallbacks) {
    const buffer: ParsedRecord[] = []

    async function flush() {
        if (buffer.length === 0) return
        const batch = buffer.splice(0, buffer.length)
        await callbacks.onBatch(service, batch)
        await yieldToUI()
    }

    return {
        async add(record: ParsedRecord) {
            buffer.push(record)
            if (buffer.length >= BATCH_SIZE) await flush()
        },
        async addMany(records: ParsedRecord[]) {
            for (const record of records) {
                buffer.push(record)
                if (buffer.length >= BATCH_SIZE) await flush()
            }
        },
        flush,
    }
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

        // Single lightweight names/sizes scan: no payloads are decompressed. It
        // yields the folder tree (for parents-first drive insertion), the size
        // guard total, and lets us surface per-service progress totals before
        // the heavy streaming pass.
        const drivePaths: string[] = []
        const totalSize = await scanZipEntries(
            files,
            entry => {
                if (isDrivePath(entry.path)) drivePaths.push(entry.path)
                return false
            },
            () => {}
        )

        const maxBytes = callbacks.maxTotalUncompressedBytes ?? MAX_TOTAL_UNCOMPRESSED_BYTES
        if (totalSize > maxBytes) {
            throw new Error(tooLargeMessage(totalSize))
        }

        const wantContacts = services.includes('contacts')
        const wantCalendar = services.includes('calendar')
        const wantDrive = services.includes('drive')
        const wantMail = services.includes('mail')
        const totals = callbacks.expectedTotals ?? {}

        const driveFolders = wantDrive ? foldersFromPaths(drivePaths) : []
        const driveTotal = driveFolders.length + countDriveFiles(drivePaths)

        const contactsSink = createServiceSink('contacts', callbacks)
        const calendarSink = createServiceSink('calendar', callbacks)
        const driveSink = createServiceSink('drive', callbacks)
        const mailSink = createServiceSink('mail', callbacks)

        if (wantContacts) callbacks.onProgress('contacts', 'scanning', 0)
        if (wantCalendar) callbacks.onProgress('calendar', 'scanning', 0)
        if (wantDrive) callbacks.onProgress('drive', 'scanning', 0)
        if (wantMail) callbacks.onProgress('mail', 'scanning', 0)
        await yieldToUI()

        // Drive folders come from entry names only — insert them first so files
        // (streamed next) resolve their parents. Their bytes never materialize.
        if (wantDrive) {
            callbacks.onProgress('drive', 'importing', driveTotal)
            await driveSink.addMany(driveFolders)
            await driveSink.flush()
        }

        if (wantContacts) callbacks.onProgress('contacts', 'importing', totals.contacts ?? 0)
        if (wantCalendar) callbacks.onProgress('calendar', 'importing', totals.calendar ?? 0)
        if (wantMail) callbacks.onProgress('mail', 'importing', totals.mail ?? 0)

        // Single heavy pass: decompress each entry once, route its bytes to the
        // owning service, and release them as each batch flushes.
        await streamZipEntries(files, async (path, bytes) => {
            if (wantDrive && isDrivePath(path)) {
                const file = driveFileFromEntry(path, bytes)
                if (file) await driveSink.add(file)
            } else if (wantContacts && isContactsPath(path)) {
                await contactsSink.addMany(parseContactsEntry(bytes))
            } else if (wantCalendar && isCalendarPath(path)) {
                const cal = parseCalendarEntry(path, bytes)
                if (cal) {
                    await calendarSink.add(cal)
                    await calendarSink.addMany(cal.events)
                }
            } else if (wantMail && isMboxPath(path)) {
                for (const thread of parseMboxStream(bytes)) {
                    await mailSink.add(thread)
                }
            }
        })

        await contactsSink.flush()
        await calendarSink.flush()
        await driveSink.flush()
        await mailSink.flush()

        if (wantContacts) callbacks.onProgress('contacts', 'done', totals.contacts ?? 0)
        if (wantCalendar) callbacks.onProgress('calendar', 'done', totals.calendar ?? 0)
        if (wantDrive) callbacks.onProgress('drive', 'done', driveTotal)
        if (wantMail) callbacks.onProgress('mail', 'done', totals.mail ?? 0)

        callbacks.onDone()
    } catch (err) {
        callbacks.onError(err instanceof Error ? err.message : 'Import failed')
    }
}
