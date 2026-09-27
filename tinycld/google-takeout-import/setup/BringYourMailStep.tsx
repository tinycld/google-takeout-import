import { eq } from '@tanstack/db'
import { SetupContinueButton } from '@tinycld/core/components/setup/wizard/SetupContinueButton'
import { useStore } from '@tinycld/core/lib/pocketbase'
import type { SetupStepProps } from '@tinycld/core/lib/setup/types'
import { useCurrentRole } from '@tinycld/core/lib/use-current-role'
import { useMyLiveQuery } from '@tinycld/core/lib/use-my-live-query'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { useRouter } from 'expo-router'
import { Text, View } from 'react-native'
import {
    IMPORT_NOTICE_PACKAGE,
    IMPORT_NOTICE_TYPE,
    IMPORT_PANEL_HREF,
} from '../lib/takeout-import/import-notice'

// The wizard itself only opens for owners and admins, so this step matches
// that gate — mirrors the other admin-gated steps (e.g. hosting-ui's
// PlanStep). The import writes only the importing user's own data.
export function useIsStepVisible(): boolean | undefined {
    const { isReady, isAdmin } = useCurrentRole()
    return isReady ? isAdmin : undefined
}

// Done once Task 19's import-finished notification exists for this user — a
// single indexed lookup, cheap enough to run on every wizard render.
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
    return isReady ? data !== undefined : undefined
}

export default function BringYourMailStep({ next }: SetupStepProps) {
    const router = useRouter()
    const openImportPanel = () => router.push(IMPORT_PANEL_HREF)
    return (
        <View className="max-w-[440px] gap-1">
            <Text className="text-2xl font-bold text-foreground">Bring your mail</Text>
            <Text className="mb-3 text-sm text-muted-foreground">
                Import your Gmail, Contacts, Calendar, and Drive from a Google Takeout export.
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
