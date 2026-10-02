import { HelpIcon } from '@tinycld/core/components/help/HelpIcon'
import { ScrollView, Text, View } from 'react-native'
import { useTakeoutSection } from '../hooks/useTakeoutSection'
import { ImportSteps } from './ImportSteps'
import {
    ChoicePanel,
    ChooseFilesPanel,
    CompletePanel,
    FailedPanel,
    ProgressPanel,
    ScanningPanel,
} from './TakeoutPanels'

// The settings shell already renders the page title, so this section starts
// at the intro line.
export function GoogleTakeoutImportSection() {
    const section = useTakeoutSection()
    const isChoosingFiles = section.step === 'files' && section.phase === 'idle'

    return (
        <ScrollView className="flex-1 bg-background" contentContainerStyle={{ flexGrow: 1 }}>
            <View className="w-full p-5 gap-5" style={{ maxWidth: 760 }}>
                <View className="flex-row items-center gap-2">
                    <Text className="flex-1 text-[14px] text-muted-foreground">
                        Move your Gmail, Calendar, Contacts, and Drive into TinyCld from a Google
                        Takeout export.
                    </Text>
                    <HelpIcon topic="google-takeout-import:importing-from-google" size={18} />
                </View>

                <ImportSteps step={section.step} />

                <View className="rounded-xl border border-border bg-surface overflow-hidden">
                    <ChooseFilesPanel
                        isVisible={isChoosingFiles}
                        onSelectFiles={section.selectFiles}
                    />
                    <ScanningPanel isVisible={section.phase === 'detecting'} />
                    <ChoicePanel section={section} />
                    <ProgressPanel section={section} />
                    <CompletePanel section={section} />
                    <FailedPanel
                        isVisible={section.phase === 'error'}
                        error={section.overallError}
                        onReset={section.onReset}
                    />
                </View>
            </View>
        </ScrollView>
    )
}
