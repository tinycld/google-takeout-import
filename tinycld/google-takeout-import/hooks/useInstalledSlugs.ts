import { usePackages } from '@tinycld/core/lib/packages/use-packages'

// Shared by BringYourMailStep and GoogleTakeoutImportSection, both of which
// need the same installed-package check (mail/contacts/calendar/drive may or
// may not be present in this deployment).
export function useInstalledSlugs(): Set<string> {
    const packages = usePackages()
    return new Set(packages.map(p => p.slug))
}
