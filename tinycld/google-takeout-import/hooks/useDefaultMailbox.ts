import { useAuth } from '@tinycld/core/lib/auth'
import { captureException } from '@tinycld/core/lib/errors'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useEffect, useState } from 'react'

// A local mirror of mail's mail_mailbox_members shape, so this package needs no
// hard @tinycld/mail dependency. It must track mail's migration: the field is
// `user` (a users id).
type MailMailboxMember = { user: string; mailbox: string }

export interface DefaultMailbox {
    mailboxId: string | null
    /** True while a user is present and the mailbox lookup is in flight. */
    loading: boolean
}

export function useDefaultMailbox(): DefaultMailbox {
    const userId = useAuth({ throwIfAnon: false }).user?.id
    const [members, setMembers] = useState<MailMailboxMember[]>([])
    // Start loading whenever there's a user to look up for, so the UI can
    // avoid flashing a "no mailbox" warning before the fetch resolves.
    const [loading, setLoading] = useState<boolean>(!!userId)

    useEffect(() => {
        if (!userId) {
            setMembers([])
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        pb.collection('mail_mailbox_members')
            // biome-ignore lint/plugin/pbtsdb-no-raw-pb-access: cross-package read of mail's mail_mailbox_members without a hard @tinycld/mail dependency (the collection is absent when mail isn't installed), so useStore/useOrgLiveQuery can't be used here.
            .getList<MailMailboxMember>(1, 1, {
                filter: pb.filter('user = {:user}', { user: userId }),
            })
            .then(r => {
                if (!cancelled) setMembers(r.items)
            })
            .catch(err => {
                // A mirrored-schema drift lands here, and an empty list reads to
                // the UI as "you have no mailbox" — indistinguishable from the
                // real thing. Report it so the next rename is loud.
                captureException('takeout.useDefaultMailbox', err, { userId })
                if (!cancelled) setMembers([])
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [userId])

    return { mailboxId: members[0]?.mailbox ?? null, loading }
}
