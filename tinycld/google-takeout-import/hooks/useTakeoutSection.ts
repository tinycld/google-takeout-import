import { useAuth } from '@tinycld/core/lib/auth'
import { buildChoiceRows, currentStep, importTotals } from '../lib/import-view'
import { useTakeoutImport } from '../lib/takeout-import'
import { useDefaultMailbox } from './useDefaultMailbox'
import { useInstalledSlugs } from './useInstalledSlugs'

export function useTakeoutSection() {
    const userId = useAuth().user.id
    const { mailboxId, loading: mailboxLoading } = useDefaultMailbox()
    const installedSlugs = useInstalledSlugs()
    const { selectFiles, startImport, requestCancel, store } = useTakeoutImport({
        userId,
        mailboxId,
    })
    const { detection, phase, overallError, progress, activeServices, selectedServices } = store

    const choiceRows = detection
        ? buildChoiceRows({
              detection,
              installedSlugs,
              selectedServices,
              hasMailbox: !!mailboxId,
              mailboxLoading,
          })
        : []
    const chosenServices = choiceRows.filter(r => r.selected).map(r => r.service)
    const mailboxMissing = choiceRows.some(r => r.availability === 'needs-mailbox')
    // A selected mail row still waiting on the mailbox lookup must not start
    // an import with a null mailbox.
    const mailboxPending = choiceRows.some(
        r => r.availability === 'checking' && selectedServices[r.service]
    )

    const onStartImport = () => {
        if (chosenServices.length > 0) startImport(chosenServices)
    }

    return {
        step: currentStep(phase, !!detection),
        phase,
        detection,
        overallError,
        progress,
        activeServices,
        choiceRows,
        canStart: chosenServices.length > 0 && !mailboxPending,
        mailboxMissing,
        totals: importTotals(activeServices, progress),
        cancelRequested: store.cancelRequested,
        selectFiles,
        onStartImport,
        onToggleService: store.toggleService,
        onCancel: requestCancel,
        onReset: store.reset,
    }
}

export type TakeoutSection = ReturnType<typeof useTakeoutSection>
