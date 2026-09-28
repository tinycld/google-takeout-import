import { usePackages } from '@tinycld/core/lib/packages/use-packages'
import { useMemo } from 'react'

// The installed-package check GoogleTakeoutImportSection needs
// (mail/contacts/calendar/drive may or may not be present in this
// deployment). Memoized on packages so callers can put the returned Set in a
// dependency array without it changing (and re-triggering) on every render.
export function useInstalledSlugs(): Set<string> {
    const packages = usePackages()
    return useMemo(() => new Set(packages.map(p => p.slug)), [packages])
}
