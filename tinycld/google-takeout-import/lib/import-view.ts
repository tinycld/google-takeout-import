import { SERVICE_LABELS } from './service-labels'
import type { ImportProgress, ImportService, TakeoutDetection } from './takeout-import/types'

export const SERVICE_ORDER: ImportService[] = ['mail', 'calendar', 'contacts', 'drive']

const COUNT_NOUNS: Record<ImportService, [string, string]> = {
    contacts: ['contact', 'contacts'],
    calendar: ['event', 'events'],
    drive: ['file', 'files'],
    mail: ['message', 'messages'],
}

export function pluralize(count: number, one: string, many: string) {
    return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

export function formatBytes(bytes: number) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = bytes
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit++
    }
    const digits = unit === 0 || value >= 10 ? 0 : 1
    return `${value.toFixed(digits)} ${units[unit]}`
}

export type ImportStep = 'files' | 'services' | 'import' | 'finished'

export function currentStep(phase: string, hasDetection: boolean): ImportStep {
    if (phase === 'importing') return 'import'
    if (phase === 'complete') return 'finished'
    if (phase === 'idle' && hasDetection) return 'services'
    return 'files'
}

export type Availability = 'available' | 'missing' | 'not-installed' | 'needs-mailbox' | 'checking'

export interface ChoiceRow {
    service: ImportService
    label: string
    availability: Availability
    detail: string
    selected: boolean
}

const UNAVAILABLE_DETAIL: Record<Exclude<Availability, 'available'>, string> = {
    missing: 'Not in these files',
    'not-installed': 'Not installed on this server',
    'needs-mailbox': 'Set up a mailbox first',
    checking: 'Checking your mailbox…',
}

interface ChoiceInput {
    detection: TakeoutDetection
    installedSlugs: Set<string>
    selectedServices: Record<ImportService, boolean>
    hasMailbox: boolean
    mailboxLoading: boolean
}

function detectedCount(detection: TakeoutDetection, service: ImportService) {
    const counts: Record<ImportService, [boolean, number]> = {
        contacts: [detection.hasContacts, detection.contactCount],
        calendar: [detection.hasCalendar, detection.eventCount],
        drive: [detection.hasDrive, detection.driveFileCount],
        mail: [detection.hasMail, detection.mailThreadCount],
    }
    return counts[service]
}

function availabilityFor(service: ImportService, input: ChoiceInput): Availability {
    const [found] = detectedCount(input.detection, service)
    if (!found) return 'missing'
    if (!input.installedSlugs.has(service)) return 'not-installed'
    if (service !== 'mail' || input.hasMailbox) return 'available'
    return input.mailboxLoading ? 'checking' : 'needs-mailbox'
}

export function buildChoiceRows(input: ChoiceInput): ChoiceRow[] {
    return SERVICE_ORDER.map(service => {
        const availability = availabilityFor(service, input)
        const [, count] = detectedCount(input.detection, service)
        const [one, many] = COUNT_NOUNS[service]
        const detail =
            availability === 'available'
                ? pluralize(count, one, many)
                : UNAVAILABLE_DETAIL[availability]
        return {
            service,
            label: SERVICE_LABELS[service],
            availability,
            detail,
            selected: availability === 'available' && input.selectedServices[service],
        }
    })
}

export function progressPercent(p: ImportProgress) {
    if (p.phase === 'done') return 100
    if (p.total === 0) return 0
    const processed = p.imported + p.skipped + p.errors
    return Math.min(100, Math.round((processed / p.total) * 100))
}

export function progressDetail(p: ImportProgress) {
    if (p.phase === 'scanning') return 'Reading archive…'
    const parts = [`${p.imported.toLocaleString()} imported`]
    if (p.skipped > 0) parts.push(`${p.skipped.toLocaleString()} skipped`)
    if (p.phase === 'importing' && p.total > 0) parts.push(`${p.total.toLocaleString()} total`)
    return parts.join(' · ')
}

export function importTotals(
    services: ImportService[],
    progress: Record<ImportService, ImportProgress>
) {
    return services.reduce(
        (sum, svc) => ({
            imported: sum.imported + progress[svc].imported,
            skipped: sum.skipped + progress[svc].skipped,
            errors: sum.errors + progress[svc].errors,
        }),
        { imported: 0, skipped: 0, errors: 0 }
    )
}

export function completeSummary(totals: ReturnType<typeof importTotals>) {
    const parts = [`${pluralize(totals.imported, 'item', 'items')} imported`]
    if (totals.skipped > 0) parts.push(`${totals.skipped.toLocaleString()} already here`)
    if (totals.errors > 0) parts.push(pluralize(totals.errors, 'error', 'errors'))
    return parts.join(' · ')
}
