import { appHref } from '@tinycld/core/lib/org-routes'
import { newRecordId } from 'pbtsdb/core'
import type { ImportService } from './types'

export const IMPORT_NOTICE_PACKAGE = 'google-takeout-import'
export const IMPORT_NOTICE_TYPE = 'import-finished'
export const IMPORT_PANEL_HREF = appHref('settings/google-takeout-import/google-takeout')

// Matches SERVICE_META's labels in GoogleTakeoutImportSection — kept as a
// separate map here so this module has no component/JSX dependency.
const SERVICE_LABELS: Record<ImportService, string> = {
    contacts: 'Contacts',
    calendar: 'Calendar',
    drive: 'Drive',
    mail: 'Mail',
}

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
