import { describe, expect, it } from 'vitest'
import { MailPlanBuilder } from '~/tinycld/google-takeout-import/lib/takeout-import/parsers/mail-plan'

function planLabels(labels: string[]) {
    const builder = new MailPlanBuilder()
    builder.add(0, {
        gmailThreadId: 't1',
        messageId: '<m1@x>',
        date: '2025-01-01T00:00:00.000Z',
        subject: 'Hi',
        labels,
        participants: [],
    })
    return builder.build().lookup(0)?.thread.labels
}

describe('mail plan labels', () => {
    it('drops the IMAP client flags Gmail stores as labels', () => {
        expect(
            planLabels(['IMAP_$Forwarded', 'IMAP_$Junk', 'IMAP_NotJunk', 'IMAP_JunkRecorded'])
        ).toEqual([])
    })

    it('keeps folders an IMAP client made and labels the user made', () => {
        expect(planLabels(['[Imap]/Archive', 'Deleted Messages', 'WelcomeEmail'])).toEqual([
            '[Imap]/Archive',
            'Deleted Messages',
            'WelcomeEmail',
        ])
    })

    it('drops system labels and categories', () => {
        expect(planLabels(['Inbox', 'Unread', 'Category Promotions', 'Receipts'])).toEqual([
            'Receipts',
        ])
    })
})
