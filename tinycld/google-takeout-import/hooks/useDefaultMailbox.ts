import { eq } from '@tanstack/db'
import { log } from '@tinycld/core/lib/logger'
import { collectionByName } from '@tinycld/core/lib/pocketbase'
import { useMyLiveQuery } from '@tinycld/core/lib/use-my-live-query'
import { useEffect } from 'react'

// mail owns this collection, and this package takes no hard @tinycld/mail
// dependency, so it is resolved by name: undefined when mail is not installed.
const MAILBOX_MEMBERS = 'mail_mailbox_members'

// The row type is whichever registered collection the name resolves to, so
// mail's columns cannot be keys of it. These names mirror mail's migration:
// `user` is a users id and `mailbox` a mail_mailboxes id.
function column(ref: object, name: 'user' | 'mailbox'): string {
    return (ref as Record<string, string>)[name]
}

export interface DefaultMailbox {
    mailboxId: string | null
    /** True while a user is present and the mailbox lookup is in flight. */
    loading: boolean
}

export function useDefaultMailbox(): DefaultMailbox {
    const collection = collectionByName(MAILBOX_MEMBERS)
    const {
        data,
        isEnabled,
        isReady,
        isError,
        collection: liveQuery,
    } = useMyLiveQuery((query, { userId }) =>
        collection
            ? query
                  .from({ member: collection })
                  .where(({ member }) => eq(column(member, 'user'), userId))
                  .findOne()
            : null
    )

    // A drift from mail's schema (a renamed column, a changed rule) fails the
    // query, and the UI reads that as "you have no mailbox", which is
    // indistinguishable from the real thing. Report it so the next rename is
    // loud. The effect runs when the query enters the error state, not on
    // every render, so each failure reports once.
    useEffect(() => {
        if (!isError) return
        log.error('google-takeout-import.default-mailbox', liveQuery?._lifecycle.getSyncError(), {
            collection: MAILBOX_MEMBERS,
        })
    }, [isError, liveQuery])

    const mailboxId = data ? column(data, 'mailbox') : undefined
    return {
        mailboxId: mailboxId || null,
        // Loading until the query settles, so the UI does not flash a
        // "no mailbox" warning before the lookup answers.
        loading: isEnabled && !isReady && !isError,
    }
}
