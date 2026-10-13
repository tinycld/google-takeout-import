// The SDK's error message is only the summary ("Failed to create record.");
// the reason sits in the per-field errors of the response body.
interface FieldErrors {
    response?: { data?: Record<string, { message?: string } | undefined> }
}

export function describeFailure(err: unknown): string {
    const summary = err instanceof Error ? err.message : 'Unknown error'
    const fields = (err as FieldErrors | null)?.response?.data ?? {}
    const details = Object.entries(fields)
        .filter(([, field]) => field?.message)
        .map(([name, field]) => `${name}: ${field?.message}`)
    if (details.length === 0) return summary
    return `${summary} ${details.join('; ')}`
}
