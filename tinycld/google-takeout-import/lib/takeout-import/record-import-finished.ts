import { log } from '@tinycld/core/lib/logger'
import type { ImportService } from './types'

/**
 * Writes the import-finished notice via `perform`, but never throws — a
 * notice failure must not turn an otherwise-successful import into an error
 * state for the user (see index.ts's call site). Failures are logged so
 * they're still visible in Sentry.
 */
export async function recordImportFinished(
    userId: string,
    services: ImportService[],
    perform: () => Promise<void>
): Promise<void> {
    try {
        await perform()
    } catch (err) {
        log.warn('takeout-import.notice', 'failed to write import-finished notice', {
            userId,
            services,
            err,
        })
    }
}
