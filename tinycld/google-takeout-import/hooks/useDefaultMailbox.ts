import { useAuth } from '@tinycld/core/lib/auth'
import { pb } from '@tinycld/core/lib/pocketbase'
import { useEffect, useState } from 'react'

type MailMailboxMember = { user_org: string; mailbox: string }

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
                filter: pb.filter('user_org = {:userOrg}', { userOrg: userId }),
            })
            .then(r => {
                if (!cancelled) setMembers(r.items)
            })
            .catch(() => {
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
