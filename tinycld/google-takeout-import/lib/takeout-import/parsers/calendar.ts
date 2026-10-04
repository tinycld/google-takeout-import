import ICAL from 'ical.js'
import {
    type EventGuest,
    type ParsedCalendar,
    type ParsedCalendarEvent,
    type ParsedUnreadable,
    unreadable,
} from '../types'

/** True for entry paths the calendar importer owns. */
export function isCalendarPath(path: string): boolean {
    return path.includes('Calendar/') && path.endsWith('.ics')
}

export interface CalendarEntryResult {
    /** null when the file holds no importable events. */
    calendar: ParsedCalendar | null
    unreadable: ParsedUnreadable[]
}

/** Parse a single `.ics` entry's bytes into a calendar plus any unreadable items. */
export function parseCalendarEntry(path: string, data: Uint8Array): CalendarEntryResult {
    const file = path.split('/').pop() || path
    let parsed: ReturnType<typeof ICAL.parse>
    try {
        parsed = ICAL.parse(new TextDecoder().decode(data))
    } catch (err) {
        const detail = err instanceof Error ? `: ${err.message}` : ''
        return {
            calendar: null,
            unreadable: [
                unreadable('calendar', `Calendar file ${file} could not be read${detail}`),
            ],
        }
    }

    const vcalendar = new ICAL.Component(parsed)
    const calendarName =
        (vcalendar.getFirstPropertyValue('x-wr-calname') as string) ||
        file.replace('.ics', '') ||
        'Imported'

    const events: ParsedCalendarEvent[] = []
    const failures: ParsedUnreadable[] = []
    for (const vevent of vcalendar.getAllSubcomponents('vevent')) {
        const event = parseEvent(vevent, calendarName)
        if (event.recordType === 'calendar_event') events.push(event)
        else failures.push(event)
    }

    const calendar: ParsedCalendar | null =
        events.length > 0 ? { recordType: 'calendar', name: calendarName, events } : null
    return { calendar, unreadable: failures }
}

/** Number of events in an entry, readable or not — the total the import reports against. */
export function countCalendarEntry(path: string, data: Uint8Array): number {
    const { calendar, unreadable: failures } = parseCalendarEntry(path, data)
    return (calendar?.events.length ?? 0) + failures.length
}

function parseEvent(
    vevent: ICAL.Component,
    calendarName: string
): ParsedCalendarEvent | ParsedUnreadable {
    const summary = (vevent.getFirstPropertyValue('summary') as string) || ''
    const description = (vevent.getFirstPropertyValue('description') as string) || ''
    const location = (vevent.getFirstPropertyValue('location') as string) || ''
    const uid = (vevent.getFirstPropertyValue('uid') as string) || ''
    const rruleProp = vevent.getFirstProperty('rrule')
    const recurrence = rruleProp ? rruleProp.getFirstValue()?.toString() || '' : ''

    const dtstart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null
    const dtend = vevent.getFirstPropertyValue('dtend') as ICAL.Time | null

    // start is required. An event with no title or UID still imports: the
    // inserter supplies "(No title)" and a fresh UID.
    if (!dtstart) {
        const label = summary ? `"${summary}"` : uid ? `with UID ${uid}` : 'with no title'
        return unreadable('calendar', `Event ${label} in ${calendarName} has no start time`)
    }

    const allDay = dtstart.isDate
    const start = dtstart.toJSDate().toISOString()
    const end = dtend ? dtend.toJSDate().toISOString() : start

    // Attendees
    const guests: EventGuest[] = []
    for (const att of vevent.getAllProperties('attendee')) {
        const mailto = (att.getFirstValue() as string) || ''
        const email = mailto.replace(/^mailto:/i, '').trim()
        if (!email) continue

        guests.push({
            name: (att.getParameter('cn') as string) || '',
            email,
            rsvp: ((att.getParameter('partstat') as string) || 'NEEDS-ACTION').toLowerCase(),
        })
    }

    // Alarm / reminder
    let reminder = 0
    const valarms = vevent.getAllSubcomponents('valarm')
    for (const alarm of valarms) {
        const trigger = alarm.getFirstPropertyValue('trigger') as ICAL.Duration | null
        if (trigger?.isNegative) {
            const minutes =
                (trigger.weeks || 0) * 7 * 24 * 60 +
                (trigger.days || 0) * 24 * 60 +
                (trigger.hours || 0) * 60 +
                (trigger.minutes || 0)
            if (minutes > 0) {
                reminder = minutes
                break
            }
        }
    }

    // Busy status
    const transp = (vevent.getFirstPropertyValue('transp') as string) || ''
    const busyStatus: 'busy' | 'free' = transp.toUpperCase() === 'TRANSPARENT' ? 'free' : 'busy'

    // Visibility
    const classVal = (vevent.getFirstPropertyValue('class') as string) || ''
    let visibility: 'default' | 'public' | 'private' = 'default'
    if (classVal.toUpperCase() === 'PRIVATE') visibility = 'private'
    else if (classVal.toUpperCase() === 'PUBLIC') visibility = 'public'

    return {
        recordType: 'calendar_event',
        calendarName,
        title: summary.slice(0, 500),
        description: description.slice(0, 5000),
        location: location.slice(0, 500),
        start,
        end,
        all_day: allDay,
        recurrence: recurrence.slice(0, 500),
        ical_uid: uid.slice(0, 500),
        guests,
        reminder,
        busy_status: busyStatus,
        visibility,
    }
}
