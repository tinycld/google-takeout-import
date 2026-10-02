import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Calendar, ChevronDown, ChevronUp, HardDrive, Mail, Users } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { pluralize } from '../lib/import-view'
import type { ImportService } from '../lib/takeout-import/types'

const SERVICE_ICONS: Record<ImportService, typeof Users> = {
    contacts: Users,
    calendar: Calendar,
    drive: HardDrive,
    mail: Mail,
}

export type RowTone = 'active' | 'muted' | 'success' | 'warning'

const TILE_CLASS: Record<RowTone, string> = {
    active: 'bg-primary/10',
    muted: 'bg-muted',
    success: 'bg-success/15',
    warning: 'bg-warning/15',
}

const TONE_COLOR: Record<RowTone, 'primary' | 'muted-foreground' | 'success' | 'warning'> = {
    active: 'primary',
    muted: 'muted-foreground',
    success: 'success',
    warning: 'warning',
}

// One layout for a service across every phase, so the list the user picked
// from is the same list that fills up while importing and reports at the end.
export function ServiceRow({
    service,
    label,
    detail,
    tone,
    trailing,
    children,
}: {
    service: ImportService
    label: string
    detail: string
    tone: RowTone
    trailing: React.ReactNode
    children?: React.ReactNode
}) {
    const Icon = SERVICE_ICONS[service]
    const iconColor = useThemeColor(TONE_COLOR[tone])
    const labelClass = tone === 'muted' ? 'text-muted-foreground' : 'text-foreground'

    return (
        <View className="px-4 py-3 gap-2">
            <View className="flex-row items-center gap-3">
                <View
                    className={`w-9 h-9 rounded-lg items-center justify-center ${TILE_CLASS[tone]}`}
                >
                    <Icon size={18} color={iconColor} />
                </View>
                <View className="flex-1 gap-0.5">
                    <Text className={`text-[15px] font-semibold ${labelClass}`}>{label}</Text>
                    <Text
                        className="text-[13px] text-muted-foreground"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {detail}
                    </Text>
                </View>
                {trailing}
            </View>
            {children}
        </View>
    )
}

export function ProgressBar({ percent, tone }: { percent: number; tone: 'active' | 'success' }) {
    const fill = tone === 'success' ? 'bg-success' : 'bg-primary'
    return (
        <View
            className="h-1 rounded-full overflow-hidden bg-muted ml-12"
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
        >
            <View className={`h-full rounded-full ${fill}`} style={{ width: `${percent}%` }} />
        </View>
    )
}

const ERROR_LIMIT = 20

export function ErrorList({ messages }: { messages: string[] }) {
    const [isOpen, setIsOpen] = useState(false)
    const dangerColor = useThemeColor('danger')

    if (messages.length === 0) return null

    const Chevron = isOpen ? ChevronUp : ChevronDown
    const toggleLabel = `${pluralize(messages.length, 'item', 'items')} failed — ${isOpen ? 'hide' : 'show'} details`

    return (
        <View className="ml-12 gap-1.5">
            <Pressable
                onPress={() => setIsOpen(v => !v)}
                className="flex-row items-center gap-1 self-start"
                accessibilityRole="button"
                accessibilityState={{ expanded: isOpen }}
            >
                <Text className="text-[13px] text-danger">{toggleLabel}</Text>
                <Chevron size={14} color={dangerColor} />
            </Pressable>
            <ErrorMessages isVisible={isOpen} messages={messages} />
        </View>
    )
}

function ErrorMessages({ isVisible, messages }: { isVisible: boolean; messages: string[] }) {
    if (!isVisible) return null
    const shown = messages.slice(0, ERROR_LIMIT)
    const remaining = messages.length - shown.length
    return (
        <View className="rounded-md bg-danger/10 px-3 py-2 gap-1">
            {shown.map(msg => (
                <Text key={msg} className="text-[12px] text-danger">
                    {msg}
                </Text>
            ))}
            <RemainingCount count={remaining} />
        </View>
    )
}

function RemainingCount({ count }: { count: number }) {
    if (count <= 0) return null
    return (
        <Text className="text-[12px] text-muted-foreground">and {count.toLocaleString()} more</Text>
    )
}
