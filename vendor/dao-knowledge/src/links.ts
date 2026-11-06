/** Project wiki references become inert Markdown destinations; the Client resolves project-local actions. */
import { fromMarkdown } from 'mdast-util-from-markdown'

type Node = ReturnType<typeof fromMarkdown>['children'][number]

/** Markdown prepared for display, with unique authored page references in source order. */
export interface KnowledgeBody {
  readonly markdown: string
  readonly references: readonly string[]
}

/**
 * Project plain [[page-id]] tokens outside code, HTML, and existing links.
 * @param markdown - complete document body without metadata or timeline.
 * @returns display Markdown and referenced slugs; escaped brackets remain literal.
 */
export function projectKnowledgeLinks(markdown: string): KnowledgeBody {
  const edits: Array<{ start: number; end: number; text: string }> = []
  const references = new Set<string>()
  const visit = (node: Node): void => {
    if (node.type === 'link' || node.type === 'linkReference') return
    if (node.type === 'text') {
      // The parser supplies offsets; authored MDAST nodes without positions are not inputs here.
      const position = node.position as { start: { offset: number }; end: { offset: number } }
      const start = position.start.offset
      const raw = markdown.slice(start, position.end.offset)
      for (const match of raw.matchAll(/(?<!\\)((?:\\\\)*)\[\[([^\[\]\r\n]+)\]\]/g)) {
        const slug = (match[2] as string).trim()
        if (slug === '') continue
        references.add(slug)
        const label = slug.replace(/[\\`*_\[\]<>]/g, '\\$&')
        edits.push({ start: start + match.index + (match[1] as string).length, end: start + match.index + match[0].length,
          text: `[${label}](<dsh-knowledge:${encodeURIComponent(slug)}>)` })
      }
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  for (const node of fromMarkdown(markdown).children) visit(node)
  let output = ''
  let offset = 0
  for (const edit of edits) {
    output += markdown.slice(offset, edit.start) + edit.text
    offset = edit.end
  }
  return { markdown: output + markdown.slice(offset), references: [...references] }
}
