import { describe, expect, it } from 'vitest'
import {
    importStepCopy,
    isStepDoneFromRow,
    isStepVisibleFromRole,
} from '../tinycld/google-takeout-import/setup/BringYourMailStep'

describe('importStepCopy', () => {
    it('names only mail when only mail is installed', () => {
        const copy = importStepCopy(new Set(['mail']))
        expect(copy).toContain('Gmail')
        expect(copy).not.toContain('Contacts')
        expect(copy).not.toContain('Calendar')
        expect(copy).not.toContain('Drive')
    })

    it('names every installed service', () => {
        const copy = importStepCopy(new Set(['mail', 'contacts', 'calendar', 'drive']))
        expect(copy).toContain('Gmail')
        expect(copy).toContain('Contacts')
        expect(copy).toContain('Calendar')
        expect(copy).toContain('Drive')
    })

    it('names nothing when no importable service is installed', () => {
        const copy = importStepCopy(new Set())
        expect(copy).not.toContain('Gmail')
        expect(copy).not.toContain('Contacts')
        expect(copy).not.toContain('Calendar')
        expect(copy).not.toContain('Drive')
    })
})

describe('isStepDoneFromRow', () => {
    it('is undefined while loading', () => {
        expect(isStepDoneFromRow(undefined, true)).toBeUndefined()
    })

    it('is false once ready with no notice row', () => {
        expect(isStepDoneFromRow(undefined, false)).toBe(false)
    })

    it('is true once ready with a notice row', () => {
        expect(isStepDoneFromRow({ id: 'n1' }, false)).toBe(true)
    })
})

describe('isStepVisibleFromRole', () => {
    it('is undefined when the role is not yet known', () => {
        expect(isStepVisibleFromRole(undefined)).toBeUndefined()
    })

    it('is true for owner and admin', () => {
        expect(isStepVisibleFromRole('owner')).toBe(true)
        expect(isStepVisibleFromRole('admin')).toBe(true)
    })

    it('is false for member and guest', () => {
        expect(isStepVisibleFromRole('member')).toBe(false)
        expect(isStepVisibleFromRole('guest')).toBe(false)
    })
})
