import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Button, ButtonText } from '@tinycld/core/ui/button'
import { Switch } from '@tinycld/core/ui/switch'
import {
    AlertTriangle,
    ArrowUpRight,
    Check,
    CircleCheck,
    FileArchive,
    PackageOpen,
} from 'lucide-react-native'
import { ActivityIndicator, Linking, Platform, Pressable, Text, View } from 'react-native'
import type { TakeoutSection } from '../hooks/useTakeoutSection'
import {
    type ChoiceRow,
    completeSummary,
    formatBytes,
    pluralize,
    progressDetail,
    progressPercent,
} from '../lib/import-view'
import { SERVICE_LABELS } from '../lib/service-labels'
import type { ImportProgress } from '../lib/takeout-import/types'
import { ErrorList, ProgressBar, ServiceRow } from './ServiceRow'

const TAKEOUT_URL = 'https://takeout.google.com/'

const KEEP_OPEN_HINT = Platform.select({
    web: 'Keep this tab open until the import finishes.',
    default: 'Keep the app open until the import finishes.',
})

function Divider() {
    return <View className="h-px bg-border" />
}

function DropZone({ children }: { children: React.ReactNode }) {
    return (
        <View className="m-4 rounded-lg border-2 border-dashed border-border items-center px-6 py-10 gap-3">
            {children}
        </View>
    )
}

export function ChooseFilesPanel({
    isVisible,
    onSelectFiles,
}: {
    isVisible: boolean
    onSelectFiles: () => void
}) {
    const primaryColor = useThemeColor('primary')
    const linkColor = useThemeColor('link')

    if (!isVisible) return null

    return (
        <View>
            <DropZone>
                <View className="w-14 h-14 rounded-2xl bg-primary/10 items-center justify-center">
                    <PackageOpen size={28} color={primaryColor} />
                </View>
                <View className="items-center gap-1">
                    <Text className="text-[17px] font-semibold text-foreground text-center">
                        Select your Takeout .zip files
                    </Text>
                    <Text className="text-[13px] text-muted-foreground text-center max-w-[420px]">
                        Pick every numbered part at once. Nothing is saved until you start the
                        import.
                    </Text>
                </View>
                <Button onPress={onSelectFiles} className="mt-2">
                    <ButtonText>Select Takeout files</ButtonText>
                </Button>
            </DropZone>
            <Divider />
            <Pressable
                onPress={() => Linking.openURL(TAKEOUT_URL)}
                accessibilityRole="link"
                className="flex-row items-center gap-1 px-4 py-3"
            >
                <Text className="text-[13px] text-muted-foreground">
                    No export yet? Request one at
                </Text>
                <Text className="text-[13px] text-link font-medium">takeout.google.com</Text>
                <ArrowUpRight size={14} color={linkColor} />
            </Pressable>
        </View>
    )
}

export function ScanningPanel({ isVisible }: { isVisible: boolean }) {
    if (!isVisible) return null
    return (
        <DropZone>
            <ActivityIndicator size="small" />
            <View className="items-center gap-1">
                <Text className="text-[15px] font-semibold text-foreground">
                    Reading your files…
                </Text>
                <Text className="text-[13px] text-muted-foreground text-center">
                    Large exports can take a minute. Nothing is saved yet.
                </Text>
            </View>
        </DropZone>
    )
}

export function ChoicePanel({ section }: { section: TakeoutSection }) {
    const mutedColor = useThemeColor('muted-foreground')
    const { detection, choiceRows } = section

    if (section.step !== 'services' || !detection) return null

    const filesLabel = `${pluralize(detection.fileCount, 'file', 'files')} · ${formatBytes(detection.totalSize)}`
    const selectedCount = choiceRows.filter(r => r.selected).length

    return (
        <View>
            <View className="flex-row items-center gap-2 px-4 py-3 bg-surface-secondary">
                <FileArchive size={16} color={mutedColor} />
                <Text className="flex-1 text-[13px] text-muted-foreground">{filesLabel}</Text>
                <Button variant="ghost" size="sm" onPress={section.selectFiles}>
                    <ButtonText>Change files</ButtonText>
                </Button>
            </View>
            {choiceRows.map(row => (
                <ChoiceRowItem key={row.service} row={row} onToggle={section.onToggleService} />
            ))}
            <MailboxNotice isVisible={section.mailboxMissing} />
            <Divider />
            <View className="flex-row items-center gap-3 px-4 py-3">
                <Text className="flex-1 text-[13px] text-muted-foreground">
                    {pluralize(selectedCount, 'service', 'services')} selected
                </Text>
                <Button onPress={section.onStartImport} isDisabled={!section.canStart}>
                    <ButtonText>Start import</ButtonText>
                </Button>
            </View>
        </View>
    )
}

function ChoiceRowItem({
    row,
    onToggle,
}: {
    row: ChoiceRow
    onToggle: (service: ChoiceRow['service']) => void
}) {
    const isAvailable = row.availability === 'available'
    return (
        <View>
            <Divider />
            <Pressable
                onPress={() => onToggle(row.service)}
                disabled={!isAvailable}
                accessibilityRole="switch"
                accessibilityState={{ checked: row.selected, disabled: !isAvailable }}
                accessibilityLabel={`${row.label}, ${row.detail}`}
            >
                <ServiceRow
                    service={row.service}
                    label={row.label}
                    detail={row.detail}
                    tone={isAvailable && row.selected ? 'active' : 'muted'}
                    trailing={
                        <Switch
                            value={row.selected}
                            disabled={!isAvailable}
                            style={{ pointerEvents: 'none' }}
                        />
                    }
                />
            </Pressable>
        </View>
    )
}

function MailboxNotice({ isVisible }: { isVisible: boolean }) {
    const warningColor = useThemeColor('warning')
    if (!isVisible) return null
    return (
        <View className="flex-row items-start gap-2 mx-4 mb-3 rounded-md bg-warning/10 px-3 py-2">
            <AlertTriangle size={16} color={warningColor} />
            <Text className="flex-1 text-[13px] text-foreground">
                This export has mail, but you have no mailbox. Create or join one in Mail settings,
                then come back. Your files stay selected.
            </Text>
        </View>
    )
}

function PanelHeader({
    title,
    subtitle,
    icon,
}: {
    title: string
    subtitle: string
    icon?: React.ReactNode
}) {
    return (
        <View className="flex-row items-center gap-3 px-4 py-4 bg-surface-secondary">
            {icon}
            <View className="flex-1 gap-0.5">
                <Text className="text-[16px] font-semibold text-foreground">{title}</Text>
                <Text className="text-[13px] text-muted-foreground">{subtitle}</Text>
            </View>
        </View>
    )
}

export function ProgressPanel({ section }: { section: TakeoutSection }) {
    if (section.step !== 'import') return null

    const services = section.activeServices.map(svc => section.progress[svc])
    const cancelLabel = section.cancelRequested ? 'Canceling…' : 'Cancel import'

    return (
        <View>
            <PanelHeader title="Importing" subtitle={KEEP_OPEN_HINT} />
            {services.map(p => (
                <View key={p.service}>
                    <Divider />
                    <ProgressRow progress={p} />
                </View>
            ))}
            <Divider />
            <View className="flex-row justify-end px-4 py-3">
                <Button
                    variant="outline"
                    onPress={section.onCancel}
                    isDisabled={section.cancelRequested}
                >
                    <ButtonText>{cancelLabel}</ButtonText>
                </Button>
            </View>
        </View>
    )
}

function ProgressRow({ progress: p }: { progress: ImportProgress }) {
    const percent = progressPercent(p)
    const isDone = p.phase === 'done'
    return (
        <ServiceRow
            service={p.service}
            label={SERVICE_LABELS[p.service]}
            detail={progressDetail(p)}
            tone={isDone ? 'success' : 'active'}
            trailing={<ProgressTrailing progress={p} percent={percent} />}
        >
            <ProgressBar percent={percent} tone={isDone ? 'success' : 'active'} />
            <ErrorList messages={p.errorMessages} />
        </ServiceRow>
    )
}

function ProgressTrailing({ progress: p, percent }: { progress: ImportProgress; percent: number }) {
    const successColor = useThemeColor('success')
    if (p.phase === 'done') return <Check size={18} color={successColor} strokeWidth={2.5} />
    if (p.phase === 'scanning') return <ActivityIndicator size="small" />
    return (
        <Text
            className="text-[15px] font-semibold text-foreground"
            style={{ fontVariant: ['tabular-nums'] }}
        >
            {percent}%
        </Text>
    )
}

export function CompletePanel({ section }: { section: TakeoutSection }) {
    const successColor = useThemeColor('success')

    if (section.step !== 'finished') return null

    const services = section.activeServices.map(svc => section.progress[svc])

    return (
        <View>
            <PanelHeader
                title="Import complete"
                subtitle={completeSummary(section.totals)}
                icon={<CircleCheck size={28} color={successColor} />}
            />
            {services.map(p => (
                <View key={p.service}>
                    <Divider />
                    <ResultRow progress={p} />
                </View>
            ))}
            <Divider />
            <View className="flex-row justify-end px-4 py-3">
                <Button variant="outline" onPress={section.onReset}>
                    <ButtonText>Import more files</ButtonText>
                </Button>
            </View>
        </View>
    )
}

function ResultRow({ progress: p }: { progress: ImportProgress }) {
    const hasErrors = p.errors > 0
    const tone = hasErrors ? 'warning' : 'success'
    return (
        <ServiceRow
            service={p.service}
            label={SERVICE_LABELS[p.service]}
            detail={progressDetail(p)}
            tone={tone}
            trailing={<ResultTrailing hasErrors={hasErrors} />}
        >
            <ErrorList messages={p.errorMessages} />
        </ServiceRow>
    )
}

function ResultTrailing({ hasErrors }: { hasErrors: boolean }) {
    const successColor = useThemeColor('success')
    const warningColor = useThemeColor('warning')
    if (hasErrors) return <AlertTriangle size={18} color={warningColor} />
    return <Check size={18} color={successColor} strokeWidth={2.5} />
}

export function FailedPanel({
    isVisible,
    error,
    onReset,
}: {
    isVisible: boolean
    error: string | null
    onReset: () => void
}) {
    const dangerColor = useThemeColor('danger')
    if (!isVisible) return null
    return (
        <View className="items-center gap-3 px-6 py-10">
            <View className="w-14 h-14 rounded-2xl bg-danger/10 items-center justify-center">
                <AlertTriangle size={26} color={dangerColor} />
            </View>
            <Text className="text-[17px] font-semibold text-foreground">Import failed</Text>
            <Text className="text-[13px] text-muted-foreground text-center max-w-[420px]">
                {error || 'The files could not be read. Select them again to retry.'}
            </Text>
            <Button variant="outline" onPress={onReset} className="mt-2">
                <ButtonText>Try again</ButtonText>
            </Button>
        </View>
    )
}
