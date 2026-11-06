export const PACKAGE = 'dsh-brain-knowledge'
export const SERVICE = 'brainKnowledge'
const codec = {
  mode: 'strict',
  typeSymbol: 'BrainKnowledgeJson',
  create: () => ({ parse(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a knowledge request or result object')
    return value
  } }),
}
export const descriptors = [{
  id: SERVICE + '/request', service: SERVICE, namespace: SERVICE, method: 'request',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec }],
  cancellation: { parameter: 'signal' },
  result: codec,
}, {
  id: SERVICE + '/followWorkflow', service: SERVICE, namespace: SERVICE, method: 'followWorkflow',
  mode: 'stream',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'input', wire: 'input', source: 'json', codec }],
  cancellation: { parameter: 'signal' },
  result: codec,
}]
export const TYPERT = {
  package: PACKAGE, face: 'host', schemas: [],
  model: { services: [], events: [], objects: [] }, invocations: descriptors,
}
