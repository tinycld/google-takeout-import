import { describe, expect, it } from 'vitest'
import { SERVICE_LABELS } from '../tinycld/google-takeout-import/lib/service-labels'
import { importFinishedNotice } from '../tinycld/google-takeout-import/lib/takeout-import/import-notice'

describe('SERVICE_LABELS', () => {
    it('labels every import service', () => {
        expect(SERVICE_LABELS).toEqual({
            contacts: 'Contacts',
            calendar: 'Calendar',
            drive: 'Drive',
            mail: 'Mail',
        })
    })

    it('is the source import-notice reads its labels from', () => {
        const notice = importFinishedNotice('user-1', ['mail', 'contacts'])
        expect(notice.body).toBe(
            `Import finished: ${SERVICE_LABELS.mail}, ${SERVICE_LABELS.contacts}.`
        )
    })
})
