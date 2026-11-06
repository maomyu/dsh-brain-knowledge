/** Native-model evidence retained by Preview Session readers and model requests. */
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { CodexThreadId } from './run.ts'

/** Recorded native model evidence; restoration neither invokes Codex nor creates model messages. */
export type CodexConversationEvent = { readonly callId: MessageId } & (
  | { readonly kind: 'input'; readonly text: string; readonly model: string; readonly instructions: string; readonly outputSchema: string; readonly reasoningEffort?: string }
  | { readonly kind: 'thread'; readonly threadId: CodexThreadId }
  | { readonly kind: 'notification'; readonly method: string; readonly params: string }
  | { readonly kind: 'output'; readonly text: string; readonly stopReason: string }
)

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Native CLI audit evidence written by the Preview model route. */
    'codex-model/call': CodexConversationEvent
  }
}
