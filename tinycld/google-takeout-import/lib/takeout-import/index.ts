import { captureException } from '@tinycld/core/lib/errors'
import { useMutation } from '@tinycld/core/lib/mutations'
import { useTakeoutImportStore } from '@tinycld/core/lib/stores/takeout-import-store'
import * as DocumentPicker from 'expo-document-picker'
import { useCallback, useRef } from 'react'
import { Platform } from 'react-native'
import * as runImportImpl from './run-import'
import type { ImportContext, ImportService, TakeoutFile } from './types'

export { useTakeoutImportStore } from '@tinycld/core/lib/stores/takeout-import-store'

// Selected files live at module scope rather than in the zustand store: on
// native they are lazy TakeoutFile wrappers around picker URIs, not the DOM
// Files the store's `files` field is typed as, and nothing renders the list
// so no reactivity is lost. Entries left behind by a store reset are
// unreachable — Start Import only appears after a new selection replaces them.
let selectedFiles: TakeoutFile[] = []

// Wraps a picked document so the import pipeline can read its bytes on
// demand, like a web File. expo-file-system is imported lazily so this
// module stays loadable in vitest's node environment (same pattern as
// drive's save-to-drive).
function nativeTakeoutFile(asset: DocumentPicker.DocumentPickerAsset): TakeoutFile {
    return {
        name: asset.name,
        arrayBuffer: async () => {
            const { File: FsFile } = await import('expo-file-system')
            const bytes = await new FsFile(asset.uri).bytes()
            return bytes.buffer
        },
    }
}

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
                    const files = Array.from(input.files)
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
                    const files = result.assets.map(nativeTakeoutFile)
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

            await runImportImpl.runImport(selectedFiles, services, contextRef.current)

            if (useTakeoutImportStore.getState().cancelRequested) {
                store.setPhase('idle')
            } else {
                store.setPhase('complete')
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
