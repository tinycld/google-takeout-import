import { describe, expect, it } from 'vitest'
import {
    IMPORT_NOTICE_PACKAGE,
    IMPORT_NOTICE_TYPE,
    IMPORT_PANEL_HREF,
    importFinishedNotice,
} from '../tinycld/google-takeout-import/lib/takeout-import/import-notice'

describe('importFinishedNotice', () => {
    it('addresses the notice to the given user', () => {
        const notice = importFinishedNotice('user-1', ['mail'])
        expect(notice.user).toBe('user-1')
    })

    it('stamps the package and type constants', () => {
        const notice = importFinishedNotice('user-1', ['mail'])
        expect(notice.package).toBe(IMPORT_NOTICE_PACKAGE)
        expect(notice.type).toBe(IMPORT_NOTICE_TYPE)
    })

    it('titles the notice "Import from Google finished"', () => {
        const notice = importFinishedNotice('user-1', ['mail'])
        expect(notice.title).toBe('Import from Google finished')
    })

    it('lists the imported services by their display names in the body', () => {
        const notice = importFinishedNotice('user-1', ['mail', 'contacts'])
        expect(notice.body).toContain('Mail')
        expect(notice.body).toContain('Contacts')
    })

    it('joins more than two services with commas', () => {
        const notice = importFinishedNotice('user-1', ['contacts', 'calendar', 'drive', 'mail'])
        expect(notice.body).toBe('Import finished: Contacts, Calendar, Drive, Mail.')
    })

    it('links to the takeout settings panel', () => {
        const notice = importFinishedNotice('user-1', ['mail'])
        expect(notice.url).toBe(IMPORT_PANEL_HREF)
        expect(notice.url).toBe('/a/settings/google-takeout-import/google-takeout')
    })

    it('records the imported services in metadata', () => {
        const notice = importFinishedNotice('user-1', ['drive', 'calendar'])
        expect(notice.metadata).toEqual({ services: ['drive', 'calendar'] })
    })

    it('is unread and undismissed', () => {
        const notice = importFinishedNotice('user-1', ['mail'])
        expect(notice.read).toBe(false)
        expect(notice.dismissed).toBe(false)
    })

    it('generates a fresh id each call', () => {
        const a = importFinishedNotice('user-1', ['mail'])
        const b = importFinishedNotice('user-1', ['mail'])
        expect(a.id).not.toBe(b.id)
    })
})
