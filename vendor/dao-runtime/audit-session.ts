import { Session, type SessionId, type SessionStore, type PrepareSessionOptions } from '@deepseek-ai/dsh-session'

/** Native audit writers own their persistence handle independently of the live Session store. */
export function detachedAuditSession(sessions: SessionStore, id: SessionId | undefined, options: PrepareSessionOptions) {
  const prepared = sessions.prepare(id, options)
  return Session.create(prepared.id, undefined, prepared.header)
}
