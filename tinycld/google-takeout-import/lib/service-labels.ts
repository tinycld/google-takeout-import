import type { ImportService } from './takeout-import/types'

// Single source for a service's display label — import-notice.ts (no JSX
// dependency) and the import screen both read from here.
export const SERVICE_LABELS: Record<ImportService, string> = {
    contacts: 'Contacts',
    calendar: 'Calendar',
    drive: 'Drive',
    mail: 'Mail',
}
