import { captureException } from '@tinycld/core/lib/errors'
import { performMutations, useMutation } from '@tinycld/core/lib/mutations'
import { notificationsCollection } from '@tinycld/core/lib/pocketbase'
import { useTakeoutImportStore } from '@tinycld/core/lib/stores/takeout-import-store'
import * as DocumentPicker from 'expo-document-picker'
import { useCallback, useRef } from 'react'
import { Platform } from 'react-native'
import { IMPORT_PANEL_HREF, importFinishedNotice } from './import-notice'
import { recordImportFinished } from './record-import-finished'
import * as runImportImpl from './run-import'
import { nativeTakeoutFile, webTakeoutFile } from './takeout-file'
import type { ImportContext, ImportService, TakeoutFile } from './types'

export { useTakeoutImportStore } from '@tinycld/core/lib/stores/takeout-import-store'

// Selected files live at module scope rather than in the zustand store: they
// are range-reading TakeoutFile wrappers, not the DOM Files the store's `files`
// field is typed as, and nothing renders the list
// so no reactivity is lost. Entries left behind by a store reset are
// unreachable — Start Import only appears after a new selection replaces them.
let selectedFiles: TakeoutFile[] = []

export function useTakeoutImport(context: ImportContext) {
    const store = useTakeoutImportStore()
    const contextRef = useRef(context)
    contextRef.current = context

    const detect = useCallback(
        (files: TakeoutFile[]) => {
            store.setPhase('detecting')

            const run = async () => {
                try {
                    const detection = await runImportImpl.detect(files, contextRef.current)
                    store.setDetection(detection)
                    store.setPhase('idle')
                } catch (err) {
                    store.setOverallError(
                        err instanceof Error ? err.message : 'Failed to read zip files'
                    )
                    store.setPhase('error')
                    captureException('takeout-detect', err)
                }
            }
            run()
        },
        [store]
    )

    const selectFiles = useCallback(() => {
        if (Platform.OS === 'web') {
            const input = document.createElement('input')
            input.type = 'file'
            input.multiple = true
            input.accept = '.zip'
            input.onchange = () => {
                if (input.files?.length) {
                    const files = Array.from(input.files).map(webTakeoutFile)
                    selectedFiles = files
                    detect(files)
                }
            }
            input.click()
        } else {
            DocumentPicker.getDocumentAsync({
                multiple: true,
                type: ['application/zip'],
            })
                .then(result => {
                    if (result.canceled) return
                    const files = result.assets.map(asset =>
                        nativeTakeoutFile(asset.uri, asset.name)
                    )
                    selectedFiles = files
                    detect(files)
                })
                .catch(err => {
                    // A picker rejection was an unhandled promise rejection
                    // (P2-11/R3). The user sees no file chosen; record why.
                    captureException('takeout-pick', err)
                })
        }
    }, [detect])

    const startImportMutation = useMutation({
        mutationFn: async (services: ImportService[]) => {
            store.setPhase('importing')
            store.setActiveServices(services)
            store.setProgressHref(IMPORT_PANEL_HREF)

            await runImportImpl.runImport(selectedFiles, services, contextRef.current)

            if (useTakeoutImportStore.getState().cancelRequested) {
                store.setPhase('idle')
            } else {
                store.setPhase('complete')

                // A finished import is the signal the "Bring your mail" setup
                // step waits on. recordImportFinished never throws, so a notice
                // failure can't turn an otherwise-successful import into an
                // error state for the user.
                await recordImportFinished(contextRef.current.userId, services, () =>
                    performMutations(function* () {
                        yield notificationsCollection.insert(
                            importFinishedNotice(contextRef.current.userId, services)
                        )
                    })
                )
            }
        },
        onError: err => {
            store.setOverallError(err instanceof Error ? err.message : 'Import failed')
            store.setPhase('error')
            captureException('takeout-import', err)
        },
    })

    const startImport = useCallback(
        (services: ImportService[]) => {
            startImportMutation.mutate(services)
        },
        [startImportMutation]
    )

    const requestCancel = useCallback(() => {
        runImportImpl.requestCancel()
    }, [])

    return {
        selectFiles,
        startImport,
        requestCancel,
        isImporting: startImportMutation.isPending,
        store,
    }
}
