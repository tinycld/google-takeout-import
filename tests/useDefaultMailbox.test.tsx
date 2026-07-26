// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { useDefaultMailbox } from '@tinycld/google-takeout-import/hooks/useDefaultMailbox'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getList = vi.fn()

vi.mock('@tinycld/core/lib/pocketbase', () => ({
    pb: {
        collection: () => ({ getList }),
        filter: (expr: string, params: Record<string, string>) =>
            expr.replace(/\{:(\w+)\}/g, (_m, k) => params[k]),
    },
}))

vi.mock('@tinycld/core/lib/errors', () => ({
    captureException: vi.fn(),
}))

let mockUserId = 'u1'
vi.mock('@tinycld/core/lib/auth', () => ({
    useAuth: () => ({ user: mockUserId ? { id: mockUserId } : null }),
}))

beforeEach(() => {
    getList.mockReset()
    mockUserId = 'u1'
})

describe('useDefaultMailbox', () => {
    it('starts loading, then resolves the mailbox id', async () => {
        let resolveList: (v: { items: { user: string; mailbox: string }[] }) => void = () => {}
        getList.mockReturnValue(
            new Promise(resolve => {
                resolveList = resolve
            })
        )

        const { result } = renderHook(() => useDefaultMailbox())

        // While the fetch is in flight: loading true, no mailbox yet.
        expect(result.current.loading).toBe(true)
        expect(result.current.mailboxId).toBeNull()

        resolveList({ items: [{ user: 'u1', mailbox: 'mb-42' }] })

        await waitFor(() => {
            expect(result.current.loading).toBe(false)
        })
        expect(result.current.mailboxId).toBe('mb-42')
    })

    // This hook queries mail's mail_mailbox_members through a mirrored local
    // type, so a rename in mail's migration is invisible to the compiler here.
    // pb is mocked, which means the filter is never checked against a real
    // collection either — so assert the field name explicitly. Without this the
    // suite passed for the whole multi-org→single-org migration while the hook
    // filtered on `user_org`, a column that no longer exists: PB 400s, the
    // .catch swallows it, and the UI shows a benign "no mailbox" warning.
    it('filters mail_mailbox_members on the `user` field', async () => {
        getList.mockResolvedValue({ items: [] })

        renderHook(() => useDefaultMailbox())

        await waitFor(() => {
            expect(getList).toHaveBeenCalled()
        })
        const filter = getList.mock.calls[0][2].filter as string
        expect(filter).toBe('user = u1')
        expect(filter).not.toContain('user_org')
    })

    it('resolves to null (not loading) when the user has no mailbox', async () => {
        getList.mockResolvedValue({ items: [] })

        const { result } = renderHook(() => useDefaultMailbox())

        await waitFor(() => {
            expect(result.current.loading).toBe(false)
        })
        expect(result.current.mailboxId).toBeNull()
    })

    it('is not loading when there is no user to look up', async () => {
        mockUserId = ''
        const { result } = renderHook(() => useDefaultMailbox())

        expect(result.current.loading).toBe(false)
        expect(result.current.mailboxId).toBeNull()
        expect(getList).not.toHaveBeenCalled()
    })
})
