import { log } from '@tinycld/core/lib/logger'
import { describe, expect, it, vi } from 'vitest'
import { recordImportFinished } from '../tinycld/google-takeout-import/lib/takeout-import/record-import-finished'

describe('recordImportFinished', () => {
    it('resolves when perform succeeds', async () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
        const perform = vi.fn().mockResolvedValue(undefined)

        await expect(recordImportFinished('user-1', ['mail'], perform)).resolves.toBeUndefined()

        expect(perform).toHaveBeenCalledTimes(1)
        expect(warnSpy).not.toHaveBeenCalled()
        warnSpy.mockRestore()
    })

    it('resolves when perform rejects, and logs one warn', async () => {
        const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
        const perform = vi.fn().mockRejectedValue(new Error('insert failed'))

        await expect(recordImportFinished('user-1', ['mail'], perform)).resolves.toBeUndefined()

        expect(warnSpy).toHaveBeenCalledTimes(1)
        warnSpy.mockRestore()
    })
})
