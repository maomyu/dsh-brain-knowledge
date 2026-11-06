/** Git's NUL-delimited line counts preserve arbitrary filenames without decoding quoted paths. */
import { z } from 'zod'
import type { ProjectTaskFileStat } from './types.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()

/** Durable file statistics cannot mix binary and textual counts or repeat a path. */
export const taskFileStatsSchema = z.array(z.object({ path: z.string().min(1), added: count, removed: count }).strict()
  .refine(value => (value.added === null) === (value.removed === null)))
  .refine(files => new Set(files.map(file => file.path)).size === files.length)

/** Parse complete Git --numstat -z output with rename detection disabled.
 * @param output - bounded, complete subprocess stdout; each record ends in NUL.
 * @returns file changes in Git order; malformed, duplicate or partial records reject.
 */
export function parseTaskFileStats(output: string): ProjectTaskFileStat[] {
  if (output === '') return []
  if (!output.endsWith('\0')) throw new Error('Incomplete Git file statistics')
  return taskFileStatsSchema.parse(output.slice(0, -1).split('\0').map((record) => {
    const fields = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record)
    if (fields === null) throw new Error('Invalid Git file statistics')
    return { path: fields[3], added: fields[1] === '-' ? null : Number(fields[1]),
      removed: fields[2] === '-' ? null : Number(fields[2]) }
  }))
}
