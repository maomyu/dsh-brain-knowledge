const reviewMethods = new Map([
  ['import-decide', 'decideReview'], ['import-save-draft', 'saveZeroHitDraft'],
  ['import-publish-draft', 'publishZeroHitDraft'], ['import-page-decision', 'setComparedPageDecision'],
  ['import-source-decision', 'setSourceDispositionDecision'], ['import-read-compared', 'readComparedPage'],
  ['import-read-catalog', 'readHeldDraftCatalogPage'],
])

export async function requestImport(ctx, input, signal) {
  const service = ctx.knowledgeImportController
  if (input.op === 'import-review') return { lookup: await service.inspectReview(input.sessionId, signal) }
  if (input.op === 'import-source') return await service.readReviewSource(input.sessionId, input.documentId, signal)
  if (input.op === 'import-resume') return await service.resumeAutomaticMaintenance(input.sessionId, signal)
  const reviewMethod = reviewMethods.get(input.op)
  if (reviewMethod) {
    const lookup = await service.inspectReview(input.sessionId, signal)
    if (!lookup) throw new Error('这个会话没有可审查的文档。')
    return await service[reviewMethod](lookup.workspaceId, lookup.importId, input.request, signal)
  }
  const project = ctx.workspaceRegistry.get(input.projectId)
  if (!project || project.archivedAt !== undefined) throw new Error('请选择有效的导入项目。')
  switch (input.op) {
    case 'import-brain-page': {
      const { entry, markdown } = await ctx.knowledgeController.read(project.id, input.path, signal)
      return { document: { kind: entry.kind, path: entry.id, version: entry.version, body: markdown } }
    }
    case 'import-list': return { imports: await service.listPending(project.id) }
    case 'import-begin': return await service.begin(project.id, input.manifest, signal)
    case 'import-stage': return await service.stage(project.id, input.importId, input.documentId, input.dataBase64, signal)
    case 'import-compile': return await service.compile(project.id, input.importId, signal)
    case 'import-abandon': return await service.abandon(project.id, input.importId, signal)
    default: throw new Error('无效的文档导入操作。')
  }
}
