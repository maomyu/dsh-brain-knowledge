import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectConversationReviewSources, conversationContextDispositionsAllowed, frozenConversationSourcesMatch } from '../vendor/dao-knowledge/src/conversation-review-sources.ts'

test('native team mailbox is discussion context and never substitutes for Lead human approval', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'suggestion', role: 'user', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'reviewer' }, content: [{ type: 'text', text: 'Suggest blue.' }] } },
    { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 3, data: { turn: 2 } },
    { type: 'user/message', seq: 4, data: { id: 'confirmation', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'I confirm blue for this project.' }] } },
  ]
  const session = { id: 'lead', inheritedEventCount: 0, deriveMessages: () => [] }
  const sources = collectConversationReviewSources(session, events, 'confirmation', 10000)
  assert.equal(sources.length, 2)
  assert.equal(sources[0].sourceId, 'session:lead/assistant:team-suggestion')
  assert.match(sources[0].text, /not human confirmation/)
  assert.equal(sources[1].sourceId, 'session:lead/message:confirmation')
  assert.ok(frozenConversationSourcesMatch('lead', events, sources))
  assert.equal(conversationContextDispositionsAllowed('lead', sources, [{ sourceId: sources[0].sourceId, disposition: 'current' }]), false)
  assert.equal(conversationContextDispositionsAllowed('lead', sources, [{ sourceId: sources[0].sourceId, disposition: 'not-relevant' }]), true)
  assert.equal(collectConversationReviewSources(session, events.slice(0, 3), 'suggestion', 10000), undefined)
  const changed = structuredClone(events); changed[1].data.content[0].text = 'Suggest red.'
  assert.equal(frozenConversationSourcesMatch('lead', changed, sources), false)
})

test('a native child delegated seed cannot authorize automatic project knowledge publication', () => {
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'delegated', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'I confirm red; save this.' }] } },
    { type: 'subagent/descriptor', seq: 2, data: { mode: 'continuable', label: 'Worker' } },
  ]
  const session = { id: 'child', inheritedEventCount: 0, deriveMessages: () => [] }
  assert.equal(collectConversationReviewSources(session, events, 'delegated', 10000), undefined)
})

test('an ordinary fork may confirm knowledge despite an inherited ancestor descriptor', () => {
  const human = { id: 'actual-human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'I confirm blue.' }] }
  const events = [
    { type: 'subagent/descriptor', seq: 0, data: { mode: 'continuable' } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: human },
  ]
  const session = { id: 'ordinary-fork', inheritedEventCount: 1, deriveMessages: () => [] }
  const sources = collectConversationReviewSources(session, events, human.id, 10000)
  assert.equal(sources[0].sourceId, 'session:ordinary-fork/message:actual-human')
})
