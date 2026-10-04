import { useThemeColor } from '@tinycld/core/lib/use-app-theme'
import { Check } from 'lucide-react-native'
import { Text, View } from 'react-native'
import type { ImportStep } from '../lib/import-view'

const STEPS = [
    { key: 'files', label: 'Choose files' },
    { key: 'services', label: 'Pick services' },
    { key: 'import', label: 'Import' },
] as const

const STEP_INDEX: Record<ImportStep, number> = { files: 0, services: 1, import: 2, finished: 3 }

type StepState = 'done' | 'current' | 'upcoming'

function stepState(index: number, current: number): StepState {
    if (index < current) return 'done'
    return index === current ? 'current' : 'upcoming'
}

export function ImportSteps({ step }: { step: ImportStep }) {
    const current = STEP_INDEX[step]
    const items = STEPS.map((s, index) => ({
        ...s,
        number: index + 1,
        state: stepState(index, current),
        isLast: index === STEPS.length - 1,
    }))

    return (
        <View className="flex-row items-center" accessibilityRole="list">
            {items.map(item => (
                <StepItem
                    key={item.key}
                    number={item.number}
                    label={item.label}
                    state={item.state}
                    isLast={item.isLast}
                />
            ))}
        </View>
    )
}

const BADGE_CLASS: Record<StepState, string> = {
    done: 'bg-primary border-primary',
    current: 'bg-background border-primary',
    upcoming: 'bg-background border-border',
}

const LABEL_CLASS: Record<StepState, string> = {
    done: 'text-foreground',
    current: 'text-foreground font-semibold',
    upcoming: 'text-muted-foreground',
}

function StepItem({
    number,
    label,
    state,
    isLast,
}: {
    number: number
    label: string
    state: StepState
    isLast: boolean
}) {
    return (
        <View
            className={isLast ? 'flex-row items-center' : 'flex-1 flex-row items-center'}
            accessibilityLabel={`Step ${number}: ${label}${state === 'current' ? ', current' : ''}`}
        >
            <View
                className={`w-6 h-6 rounded-full border-2 items-center justify-center ${BADGE_CLASS[state]}`}
            >
                <StepBadgeContent number={number} state={state} />
            </View>
            <Text className={`ml-2 text-[13px] ${LABEL_CLASS[state]}`} numberOfLines={1}>
                {label}
            </Text>
            <StepConnector isVisible={!isLast} isDone={state === 'done'} />
        </View>
    )
}

function StepBadgeContent({ number, state }: { number: number; state: StepState }) {
    const onPrimary = useThemeColor('primary-foreground')
    if (state === 'done') return <Check size={13} color={onPrimary} strokeWidth={3} />
    const textClass = state === 'current' ? 'text-primary' : 'text-muted-foreground'
    return <Text className={`text-[11px] font-bold ${textClass}`}>{number}</Text>
}

function StepConnector({ isVisible, isDone }: { isVisible: boolean; isDone: boolean }) {
    if (!isVisible) return null
    return (
        <View className={`flex-1 h-0.5 mx-3 rounded-full ${isDone ? 'bg-primary' : 'bg-border'}`} />
    )
}
