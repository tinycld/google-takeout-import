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

let mockUserOrgId = 'uo1'
vi.mock('@tinycld/core/lib/use-current-role', () => ({
    useCurrentRole: () => ({ userOrgId: mockUserOrgId }),
}))

beforeEach(() => {
    getList.mockReset()
    mockUserOrgId = 'uo1'
})

describe('useDefaultMailbox', () => {
    it('starts loading, then resolves the mailbox id', async () => {
        let resolveList: (v: { items: { user_org: string; mailbox: string }[] }) => void = () => {}
        getList.mockReturnValue(
            new Promise(resolve => {
                resolveList = resolve
            })
        )

        const { result } = renderHook(() => useDefaultMailbox())

        // While the fetch is in flight: loading true, no mailbox yet.
        expect(result.current.loading).toBe(true)
        expect(result.current.mailboxId).toBeNull()

        resolveList({ items: [{ user_org: 'uo1', mailbox: 'mb-42' }] })

        await waitFor(() => {
            expect(result.current.loading).toBe(false)
        })
        expect(result.current.mailboxId).toBe('mb-42')
    })

    it('resolves to null (not loading) when the org has no mailbox', async () => {
        getList.mockResolvedValue({ items: [] })

        const { result } = renderHook(() => useDefaultMailbox())

        await waitFor(() => {
            expect(result.current.loading).toBe(false)
        })
        expect(result.current.mailboxId).toBeNull()
    })

    it('is not loading when there is no user-org to look up', async () => {
        mockUserOrgId = ''
        const { result } = renderHook(() => useDefaultMailbox())

        expect(result.current.loading).toBe(false)
        expect(result.current.mailboxId).toBeNull()
        expect(getList).not.toHaveBeenCalled()
    })
})
