/** Local human decision fields shared by Task and Goal proposal forms. */
import { useState, type Dispatch, type SetStateAction } from 'react'
import type { ProjectTaskKnowledgeDecisionRequest } from '@deepseek-ai/dsh-api-task-controller/types'

type ChoiceInput = {
  choice: ProjectTaskKnowledgeDecisionRequest['action'] | null
  reason: string
  pageIndex: string
  path: string
  title: string
  category: 'project' | 'concept' | 'decision' | 'person' | 'reference'
  kind: 'decision' | 'observation' | 'source' | 'reversal' | 'evidence'
  tags: string
}
type ChoiceFields = ChoiceInput & {
  [K in keyof ChoiceInput as `set${Capitalize<K>}`]: Dispatch<SetStateAction<ChoiceInput[K]>>
}

/** Initialize independent form fields; request retention and submission remain with each owner.
 * @returns editable choice, destination and metadata fields with their React setters.
 */
export function useKnowledgeChoiceFields(): ChoiceFields {
  const [choice, setChoice] = useState<ProjectTaskKnowledgeDecisionRequest['action'] | null>(null)
  const [reason, setReason] = useState('')
  const [pageIndex, setPageIndex] = useState('')
  const [path, setPath] = useState('')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<'project' | 'concept' | 'decision' | 'person' | 'reference'>('project')
  const [kind, setKind] = useState<'decision' | 'observation' | 'source' | 'reversal' | 'evidence'>('observation')
  const [tags, setTags] = useState('')
  return { choice, setChoice, reason, setReason, pageIndex, setPageIndex, path, setPath,
    title, setTitle, category, setCategory, kind, setKind, tags, setTags }
}
