import { eq } from '@tanstack/db'
import { SetupContinueButton } from '@tinycld/core/components/setup/wizard/SetupContinueButton'
import { usePackages } from '@tinycld/core/lib/packages/use-packages'
import { useStore } from '@tinycld/core/lib/pocketbase'
import type { SetupStepProps } from '@tinycld/core/lib/setup/types'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
import { useMyLiveQuery } from '@tinycld/core/lib/use-my-live-query'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { useRouter } from 'expo-router'
import { Text, View } from 'react-native'
import { SERVICE_LABELS } from '../lib/service-labels'
import {
    IMPORT_NOTICE_PACKAGE,
    IMPORT_NOTICE_TYPE,
    IMPORT_PANEL_HREF,
} from '../lib/takeout-import/import-notice'
import type { ImportService } from '../lib/takeout-import/types'

// Order matches GoogleTakeoutImportSection's SERVICE_META / detection order.
// Gmail is the service's marketing name; SERVICE_LABELS.mail ("Mail") names
// the installed package instead, so this step's own copy is worded here.
const STEP_SERVICE_LABELS: Record<ImportService, string> = {
    ...SERVICE_LABELS,
    mail: 'Gmail',
}
const STEP_SERVICES: ImportService[] = ['mail', 'contacts', 'calendar', 'drive']

// Names only the services the reader actually has installed — naming an
// uninstalled service (e.g. "Drive" on a mail-only deployment) promises data
// this step can't deliver.
export function importStepCopy(installedSlugs: Set<string>): string {
    const names = STEP_SERVICES.filter(svc => installedSlugs.has(svc)).map(
        svc => STEP_SERVICE_LABELS[svc]
    )
    if (names.length === 0) {
        return 'Import your data from a Google Takeout export.'
    }
    return `Import your ${names.join(', ')} from a Google Takeout export.`
}

// The wizard itself only opens for owners and admins, so this step matches
// that gate — mirrors the other admin-gated steps (e.g. hosting-ui's
// PlanStep). The import writes only the importing user's own data.
export function isStepVisibleFromRole(role: string | null | undefined): boolean | undefined {
    if (role === undefined) return undefined
    return role === 'owner' || role === 'admin'
}

export function useIsStepVisible(): boolean | undefined {
    const { isReady, role } = useCurrentRole()
    return isStepVisibleFromRole(isReady ? role : undefined)
}

// Done once Task 19's import-finished notification exists for this user.
export function isStepDoneFromRow(row: unknown, isLoading: boolean): boolean | undefined {
    if (isLoading) return undefined
    return row !== undefined
}

// A single indexed lookup, cheap enough to run on every wizard render.
export function useIsStepDone(): boolean | undefined {
    const [notificationsCollection] = useStore('notifications')
    const { data, isReady } = useMyLiveQuery((query, { userId }) =>
        query
            .from({ n: notificationsCollection })
            .where(({ n }) => eq(n.user, userId))
            .where(({ n }) => eq(n.package, IMPORT_NOTICE_PACKAGE))
            .where(({ n }) => eq(n.type, IMPORT_NOTICE_TYPE))
            .findOne()
    )
    return isStepDoneFromRow(data, !isReady)
}

export default function BringYourMailStep({ next }: SetupStepProps) {
    const router = useRouter()
    const packages = usePackages()
    const installedSlugs = new Set(packages.map(p => p.slug))
    const openImportPanel = () => router.push(IMPORT_PANEL_HREF)
    return (
        <View className="max-w-[440px] gap-1">
            <Text className="text-2xl font-bold text-foreground">Bring your mail</Text>
            <Text className="mb-3 text-sm text-muted-foreground">
                {importStepCopy(installedSlugs)}
            </Text>
            <Button
                variant="outline"
                className="mb-4 self-start"
                onPress={openImportPanel}
                testID="setup-import-open"
            >
                <ButtonText>Import from Google</ButtonText>
            </Button>
            <SetupContinueButton onPress={next} />
        </View>
    )
}
