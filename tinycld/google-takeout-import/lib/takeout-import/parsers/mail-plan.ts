import type { MailFolder, MailThreadPlan } from '../types'
import type { MailAddress, MailHeaderInfo } from './mail'

const FOLDER_BY_LABEL: [label: string, folder: MailFolder][] = [
    // Priority order: trash > spam > drafts > sent > inbox
    ['Trash', 'trash'],
    ['Spam', 'spam'],
    ['Junk', 'spam'],
    ['Draft', 'drafts'],
    ['Drafts', 'drafts'],
    ['Sent', 'sent'],
    ['Sent Messages', 'sent'],
    ['Inbox', 'inbox'],
]

const STANDARD_LABELS = new Set([
    ...FOLDER_BY_LABEL.map(([label]) => label),
    'Starred',
    'Unread',
    'Important',
    'Opened',
    'Chat',
])

function resolveFolder(labels: Set<string>): MailFolder {
    for (const [label, folder] of FOLDER_BY_LABEL) {
        if (labels.has(label)) return folder
    }
    // Non-standard labels: if has Unread flag → inbox, otherwise → archive
    return labels.has('Unread') ? 'inbox' : 'archive'
}

interface MessageEntry {
    index: number
    date: string
    messageId: string
    subject: string
}

interface ThreadAccumulator {
    key: string
    messages: MessageEntry[]
    labels: Set<string>
    participants: Map<string, MailAddress>
}

export interface PlannedMessage {
    thread: MailThreadPlan
    /** message_id of the message before this one in its thread, by date. */
    previousMessageId: string
    isEarliest: boolean
}

export interface MailPlan {
    lookup(index: number): PlannedMessage | undefined
}

/**
 * Collects message headers by their position in the mbox. Positions are stable
 * between passes because both passes split the same bytes the same way.
 */
export class MailPlanBuilder {
    private threads = new Map<string, ThreadAccumulator>()

    add(index: number, info: MailHeaderInfo) {
        const key = info.gmailThreadId || info.messageId || `message-${index}`
        let thread = this.threads.get(key)
        if (!thread) {
            thread = { key, messages: [], labels: new Set(), participants: new Map() }
            this.threads.set(key, thread)
        }
        thread.messages.push({
            index,
            date: info.date,
            messageId: info.messageId,
            subject: info.subject,
        })
        for (const label of info.labels) thread.labels.add(label)
        for (const p of info.participants) {
            if (p.email && !thread.participants.has(p.email)) thread.participants.set(p.email, p)
        }
    }

    build(): MailPlan {
        const planned = new Map<number, PlannedMessage>()
        for (const thread of this.threads.values()) {
            const ordered = thread.messages.sort(
                (a, b) => a.date.localeCompare(b.date) || a.index - b.index
            )
            const earliest = ordered[0]
            const labels = [...thread.labels]
            const plan: MailThreadPlan = {
                key: thread.key,
                subject: earliest.subject || '(No Subject)',
                messageCount: ordered.length,
                latestDate: ordered[ordered.length - 1].date,
                participants: [...thread.participants.values()],
                folder: resolveFolder(thread.labels),
                isRead: !thread.labels.has('Unread'),
                isStarred: thread.labels.has('Starred'),
                labels: labels.filter(l => !STANDARD_LABELS.has(l) && !l.startsWith('Category ')),
                earliestMessageId: earliest.messageId,
            }
            ordered.forEach(({ index }, position) => {
                planned.set(index, {
                    thread: plan,
                    previousMessageId: position > 0 ? ordered[position - 1].messageId : '',
                    isEarliest: position === 0,
                })
            })
        }
        this.threads.clear()
        return { lookup: index => planned.get(index) }
    }
}
