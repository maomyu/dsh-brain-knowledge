/** Durable conversation-review completion status for read-only Client presentation. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent'
import type { KnowledgeReviewStatusState } from './types.ts'
import { startsConversationWork } from './curation-access.ts'

const source = 'project-brain-curation-check'

function isReview(kind: string): boolean {
  return kind === source || kind === 'plugin:project-brain-curation-check'
}

/** Reconstruct review completion without executing an Agent or inferring a Brain write. */
export const curationStatusProjection = {
  key: 'knowledgeReviewUnfinished', stateVersion: 2,
  stateSchema: z.object({ unfinished: z.boolean(), admitted: z.boolean() }),
  init: (): KnowledgeReviewStatusState => ({ unfinished: false, admitted: false }),
  apply(state, event) {
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message =>
      isReview(message.source.kind))) {
      return { unfinished: true, admitted: false }
    }
    if (event.type === 'user/message' && isReview(event.data.source.kind)) {
      return { unfinished: true, admitted: true }
    }
    if (event.type === 'user/message' && state.admitted && startsConversationWork(event.data)) {
      return { ...state, admitted: false }
    }
    if (event.type === 'assistant/message' && state.admitted && event.data.stream.some(record =>
      record.type === 'chunk' && record.chunk.type === 'finish' && record.chunk.reason.kind === 'stop')) {
      return { unfinished: false, admitted: false }
    }
    if (event.type === 'turn/end' && state.admitted) return { ...state, admitted: false }
    return state
  },
  wire: { viewSchema: z.boolean(), view: state => state.unfinished },
} satisfies ProjectionDefinition<'knowledgeReviewUnfinished'>
