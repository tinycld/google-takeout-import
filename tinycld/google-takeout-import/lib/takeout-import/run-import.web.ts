import { captureException } from '@tinycld/core/lib/errors'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useTakeoutImportStore } from '@tinycld/core/lib/stores/takeout-import-store'
import { createBatchInserter } from './batch-inserter'
import { detectOnly, runFallbackImport } from './import-worker-fallback'
import type { ImportContext, ImportService, TakeoutDetection, TakeoutFile } from './types'

// The web build used to run the import in a Web Worker, but the worker module
// was never bundled (this package ships raw `.ts` with no metro/expo config),
// so worker construction always 404'd at runtime and silently fell back to the
// main thread. The worker path is gone; web now runs on the main thread exactly
// like native. Both platform files are kept only for Metro's platform-suffix
// resolution and behave identically.

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
        onProgress: (service, update) =>
            useTakeoutImportStore.getState().updateProgress(service, update),
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
