import { useEffect, useState } from 'react'
import { pb } from '~/lib/pocketbase'
import { useCurrentRole } from '~/lib/use-current-role'

type MailMailboxMember = { user_org: string; mailbox: string }

export function useDefaultMailbox(): string | null {
    const { userOrgId } = useCurrentRole()
    const [members, setMembers] = useState<MailMailboxMember[]>([])

    useEffect(() => {
        if (!userOrgId) {
            setMembers([])
            return
        }
        let cancelled = false
        pb.collection('mail_mailbox_members')
            .getList<MailMailboxMember>(1, 1, { filter: `user_org="${userOrgId}"` })
            .then(r => {
                if (!cancelled) setMembers(r.items)
            })
            .catch(() => {
                if (!cancelled) setMembers([])
            })
        return () => {
            cancelled = true
        }
    }, [userOrgId])

    return members[0]?.mailbox ?? null
}
