import { captureException } from '@tinycld/core/lib/errors'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useTakeoutImportStore } from '@tinycld/core/lib/stores/takeout-import-store'
import { createBatchInserter } from './batch-inserter'
import { detectOnly, runFallbackImport } from './import-worker-fallback'
import type { ImportContext, ImportService, TakeoutDetection, TakeoutFile } from './types'

// Native has always run the import on the main thread (no Web Worker). Web now
// does too; the two files are kept only for Metro's platform-suffix resolution
// and behave identically.

const SERVICE_FOR_RECORD: Record<string, ImportService> = {
    contact: 'contacts',
    calendar: 'calendar',
    calendar_event: 'calendar',
    drive_folder: 'drive',
    drive_file: 'drive',
    mail_thread: 'mail',
}

export async function detect(
    files: TakeoutFile[],
    _context: ImportContext
): Promise<TakeoutDetection> {
    return detectOnly(files)
}

export async function runImport(
    files: TakeoutFile[],
    services: ImportService[],
    context: ImportContext
): Promise<void> {
    await runOnMainThread(files, services, context)
}

export function requestCancel() {
    useTakeoutImportStore.getState().requestCancel()
}

async function runOnMainThread(
    files: TakeoutFile[],
    services: ImportService[],
    context: ImportContext
) {
    const store = useTakeoutImportStore.getState()
    const inserter = createBatchInserter({
        pb,
        context,
        onProgress: (recordType, update) => {
            const svc = SERVICE_FOR_RECORD[recordType]
            if (svc) useTakeoutImportStore.getState().updateProgress(svc, update)
        },
        cancelSignal: () => useTakeoutImportStore.getState().cancelRequested,
        onException: captureException,
    })

    await runFallbackImport(files, services, context, {
        onBatch: async (_service, records) => {
            await inserter.insertRecords(records)
        },
        onProgress: (service, phase, total) => {
            useTakeoutImportStore.getState().updateProgress(service, { phase, total })
        },
        onDone: () => {},
        onError: message => {
            throw new Error(message)
        },
        expectedTotals: {
            contacts: store.detection?.contactCount,
            calendar: store.detection?.eventCount,
            mail: store.detection?.mailThreadCount,
        },
    })
}
