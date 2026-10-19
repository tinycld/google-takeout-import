// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { useDefaultMailbox } from '@tinycld/google-takeout-import/hooks/useDefaultMailbox'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MemberRow = { id: string; user: string; mailbox: string }

const h = vi.hoisted(() => ({
    rows: [] as MemberRow[],
    isMailInstalled: true,
    userId: 'u1',
    collection: undefined as unknown,
}))

vi.mock('@tinycld/core/lib/pocketbase', async () => {
    const { createCollection, localOnlyCollectionOptions } = await import('@tanstack/db')
    // One collection per test, built on first lookup so it holds that test's rows.
    const membersCollection = () => {
        h.collection ??= createCollection(
            localOnlyCollectionOptions({ getKey: (r: MemberRow) => r.id, initialData: h.rows })
        )
        return h.collection
    }
    return {
        collectionByName: (name: string) =>
            name === 'mail_mailbox_members' && h.isMailInstalled ? membersCollection() : undefined,
    }
})

vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: h.userId ? { id: h.userId } : null }),
}))

beforeEach(() => {
    h.rows = []
    h.isMailInstalled = true
    h.userId = 'u1'
    h.collection = undefined
})

describe('useDefaultMailbox', () => {
    // This hook reads mail's mail_mailbox_members through mirrored column
    // names, so a rename in mail's migration is invisible to the compiler here.
    // Another user's row sits beside the caller's: the right mailbox comes back
    // only while the query filters on the `user` field. A stale name (the old
    // `user_org`) matches no row and the UI shows a benign "no mailbox" warning.
    it("resolves the caller's mailbox, filtered on the `user` field", async () => {
        h.rows = [
            { id: 'm1', user: 'u2', mailbox: 'mb-other' },
            { id: 'm2', user: 'u1', mailbox: 'mb-42' },
        ]

        const { result } = renderHook(() => useDefaultMailbox())

        await waitFor(() => {
            expect(result.current.mailboxId).toBe('mb-42')
        })
        expect(result.current.loading).toBe(false)
    })

    it('resolves to null (not loading) when the user has no mailbox', async () => {
        h.rows = [{ id: 'm1', user: 'u2', mailbox: 'mb-other' }]

        const { result } = renderHook(() => useDefaultMailbox())

        await waitFor(() => {
            expect(result.current.loading).toBe(false)
        })
        expect(result.current.mailboxId).toBeNull()
    })

    it('is not loading when there is no user to look up', () => {
        h.userId = ''
        h.rows = [{ id: 'm1', user: '', mailbox: 'mb-blank' }]

        const { result } = renderHook(() => useDefaultMailbox())

        expect(result.current.loading).toBe(false)
        expect(result.current.mailboxId).toBeNull()
    })

    it('is not loading when mail is not installed', () => {
        h.isMailInstalled = false

        const { result } = renderHook(() => useDefaultMailbox())

        expect(result.current.loading).toBe(false)
        expect(result.current.mailboxId).toBeNull()
    })
})
