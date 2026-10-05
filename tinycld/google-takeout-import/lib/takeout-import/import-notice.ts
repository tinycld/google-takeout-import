import { appHref } from '@tinycld/core/lib/org-routes'
import { newRecordId } from 'pbtsdb/core'
import { SERVICE_LABELS } from '../service-labels'
import type { ImportService } from './types'

export const IMPORT_NOTICE_PACKAGE = 'google-takeout-import'
export const IMPORT_NOTICE_TYPE = 'import-finished'
// This package's accountSettings panel (see manifest.ts).
export const IMPORT_PANEL_HREF = appHref('settings/account/google-takeout-import/google-takeout')

export function importFinishedNotice(userId: string, services: ImportService[]) {
    const names = services.map(svc => SERVICE_LABELS[svc]).join(', ')
    return {
        id: newRecordId(),
        user: userId,
        type: IMPORT_NOTICE_TYPE,
        package: IMPORT_NOTICE_PACKAGE,
        title: 'Import from Google finished',
        body: `Import finished: ${names}.`,
        url: IMPORT_PANEL_HREF,
        metadata: { services },
        read: false,
        dismissed: false,
    }
}
