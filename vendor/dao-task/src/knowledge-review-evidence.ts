/** Shared decoding of durable Task and Goal Brain-read evidence. */

/** A byte-addressed fragment returned by the Brain read tool. */
export interface BrainReadFragment {
  readonly project_id: string
  readonly project: string
  readonly path: string
  readonly version: string
  readonly sha256: string
  readonly startByte: number
  readonly endByte: number
  readonly totalBytes: number
  readonly fragment: string
}

/** Decode an object from a durable tool payload.
 * @param value - parsed JSON or a PTC argument value.
 * @returns a non-array object, or undefined for other values.
 */
export function readEvidenceObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Decode one object-valued JSON tool argument or result.
 * @param text - durable tool text.
 * @returns the parsed object, or undefined for malformed or non-object JSON.
 */
export function readEvidenceJson(text: string): Record<string, unknown> | undefined {
  try { return readEvidenceObject(JSON.parse(text)) } catch (_invalidToolJson) { return undefined }
}

/** Validate an exact project/page fragment and its UTF-8 byte interval.
 * @param value - decoded Brain tool result.
 * @param projectId - registered project identity authorized by the review.
 * @param project - retained project directory.
 * @param path - selected Brain page.
 * @returns validated fragment metadata and bytes, or undefined for incomplete evidence.
 */
export function readBrainFragment(value: Record<string, unknown>, projectId: string,
  project: string, path: string): BrainReadFragment | undefined {
  if (value.format !== 'brain-read-json-v1' || value.partial !== true || value.project_id !== projectId
    || value.project !== project || value.path !== path || typeof value.version !== 'string'
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.fragment !== 'string' || typeof value.startByte !== 'number'
    || typeof value.endByte !== 'number' || typeof value.totalBytes !== 'number'
    || !Number.isSafeInteger(value.startByte) || !Number.isSafeInteger(value.endByte)
    || !Number.isSafeInteger(value.totalBytes) || value.startByte < 0 || value.startByte >= value.endByte
    || value.endByte > value.totalBytes || Buffer.byteLength(value.fragment, 'utf8') !== value.endByte - value.startByte) return undefined
  return { project_id: projectId, project, path, version: value.version, sha256: value.sha256,
    fragment: value.fragment, startByte: value.startByte, endByte: value.endByte, totalBytes: value.totalBytes }
}
