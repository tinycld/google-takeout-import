import ICAL from 'ical.js'
import { type ParsedContact, type ParsedUnreadable, unreadable } from '../types'

/** True for entry paths the contacts importer owns. */
export function isContactsPath(path: string): boolean {
    return path.includes('Contacts/') && path.endsWith('.vcf')
}

type ContactResult = ParsedContact | ParsedUnreadable

/** Parse the contacts in a single `.vcf` entry's bytes. */
export function parseContactsEntry(path: string, data: Uint8Array): ContactResult[] {
    return parseVcfText(new TextDecoder().decode(data), fileName(path))
}

export function parseContacts(entries: Map<string, Uint8Array>): ContactResult[] {
    const contacts: ContactResult[] = []

    for (const [path, data] of entries) {
        if (!isContactsPath(path)) continue
        contacts.push(...parseContactsEntry(path, data))
    }

    return contacts
}

function fileName(path: string) {
    return path.split('/').pop() || path
}

function parseVcfText(text: string, file: string): ContactResult[] {
    // Split on BEGIN:VCARD to handle multiple cards in one file
    const cards = text
        .split(/(?=BEGIN:VCARD)/i)
        .map(raw => raw.trim())
        .filter(Boolean)
    return cards.map((raw, index) => parseOneVcard(raw, `card ${index + 1} in ${file}`))
}

function parseOneVcard(text: string, where: string): ContactResult {
    let parsed: ReturnType<typeof ICAL.parse>
    try {
        parsed = ICAL.parse(text)
    } catch (err) {
        const detail = err instanceof Error ? `: ${err.message}` : ''
        return unreadable('contacts', `Contact ${where} could not be read${detail}`)
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

    // first_name is required. A card with only a last name, or only an
    // organization, email or phone, is still a contact worth keeping.
    if (!firstName) {
        firstName = lastName || fn || company || email || phone
        if (firstName === lastName) lastName = ''
    }
    if (!firstName) return unreadable('contacts', `Contact ${where} is empty`)

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
