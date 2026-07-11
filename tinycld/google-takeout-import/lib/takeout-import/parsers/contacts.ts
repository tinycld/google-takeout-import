import ICAL from 'ical.js'
import type { ParsedContact } from '../types'

/** True for entry paths the contacts importer owns. */
export function isContactsPath(path: string): boolean {
    return path.includes('Contacts/') && path.endsWith('.vcf')
}

/** Parse the contacts in a single `.vcf` entry's bytes. */
export function parseContactsEntry(data: Uint8Array): ParsedContact[] {
    return parseVcfText(new TextDecoder().decode(data))
}

export function parseContacts(entries: Map<string, Uint8Array>): ParsedContact[] {
    const contacts: ParsedContact[] = []

    for (const [path, data] of entries) {
        if (!isContactsPath(path)) continue
        contacts.push(...parseContactsEntry(data))
    }

    return contacts
}

function parseVcfText(text: string): ParsedContact[] {
    const contacts: ParsedContact[] = []
    // Split on BEGIN:VCARD to handle multiple cards in one file
    const cards = text.split(/(?=BEGIN:VCARD)/i)

    for (const raw of cards) {
        if (!raw.trim()) continue
        const contact = parseOneVcard(raw.trim())
        if (contact) contacts.push(contact)
    }

    return contacts
}

function parseOneVcard(text: string): ParsedContact | null {
    let parsed: ReturnType<typeof ICAL.parse>
    try {
        parsed = ICAL.parse(text)
    } catch {
        return null
    }

    const vcard = new ICAL.Component(parsed)

    const fn = vcard.getFirstPropertyValue('fn') as string | null
    const n = vcard.getFirstPropertyValue('n') as string[] | null

    let firstName = ''
    let lastName = ''

    // N property: [last, first, middle, prefix, suffix]
    if (n && Array.isArray(n) && n.length >= 2) {
        lastName = n[0] || ''
        firstName = n[1] || ''
    } else if (fn) {
        const parts = fn.split(/\s+/)
        firstName = parts[0] || ''
        lastName = parts.slice(1).join(' ')
    }

    const emailProp = vcard.getFirstProperty('email')
    const email = emailProp ? (emailProp.getFirstValue() as string) || '' : ''

    const telProp = vcard.getFirstProperty('tel')
    const phone = telProp ? (telProp.getFirstValue() as string) || '' : ''

    const org = vcard.getFirstPropertyValue('org') as string | string[] | null
    const company = Array.isArray(org) ? org[0] || '' : org || ''

    const jobTitle = (vcard.getFirstPropertyValue('title') as string) || ''
    const notes = (vcard.getFirstPropertyValue('note') as string) || ''
    const vcardUid = (vcard.getFirstPropertyValue('uid') as string) || ''

    if (!firstName && !lastName && !email) return null

    return {
        recordType: 'contact',
        first_name: firstName.slice(0, 100),
        last_name: lastName.slice(0, 100),
        email,
        phone,
        company: company.slice(0, 200),
        job_title: jobTitle.slice(0, 200),
        notes,
        vcard_uid: vcardUid.slice(0, 255),
    }
}
