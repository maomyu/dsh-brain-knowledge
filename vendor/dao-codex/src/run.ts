/**
 * One-shot Codex child lifecycle: spawn the real app-server through the
 * subprocess seam, publish only after initialization and thread creation,
 * acknowledge retained Task identity before submission, flatten failures, and dispose to whole-range
 * quiescence.
 *
 * @module @deepseek-ai/dsh-subagent-codex/run
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { codexTaskWriteConfig } from './task-sandbox.ts'
import { codexReviewerConfig, type CodexReviewerIsolation } from './reviewer-isolation.ts'
import { codexDocumentationConfig, resolveDocumentationDirectory, type CodexDocumentationIsolation } from './documentation-isolation.ts'
import { codexPackageBin } from './package-bin.ts'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  CodexAppServerWire,
  type CodexWireFailureFacts,
} from './wire.ts'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

interface CodexPackageManifest {
  readonly bin: {
    readonly codex: string
  }
}

const codexPackageJsonPath = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const codexPackageManifest = JSON.parse(
  readFileSync(codexPackageJsonPath, 'utf8'),
) as CodexPackageManifest

/** Absolute maintained wrapper, physically unpacked beside Electron's archive when packaged. */
const CODEX_PACKAGE_BIN = codexPackageBin(codexPackageJsonPath, codexPackageManifest.bin.codex)

/** Profile-selectable non-interactive Codex permission mode. */
export type CodexPermissionMode =
  | 'never'
  | 'approve-for-me'
  | 'dangerously-bypass-approvals-and-sandbox'

/** Native non-interactive Codex modes mapped to official `thread/start` fields. */
export const CODEX_PERMISSION_MODES = [
  'never',
  'approve-for-me',
  'dangerously-bypass-approvals-and-sandbox',
] as const satisfies readonly CodexPermissionMode[]

/** Safe default for unattended Codex runs. */
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = 'never'

/** Codex-owned thread identity, independent of the Harness run or Session id. */
export type CodexThreadId = Branded<'CodexThreadId'>

/** Durable Task consumer; rejection prevents submission or stops the active turn. */
export interface CodexTaskJournal {
  /** Explicit turn effort; omission preserves the native configuration. */
  readonly reasoningEffort?: string | undefined
  /** Explicit native sandbox; workspace-write excludes ambient extra roots and shared temporary directories. */
  readonly sandbox: 'read-only' | 'workspace-write'
  /** Inclusive serialized byte limit for notifications awaiting acknowledgement. */
  readonly maxPendingBytes: number
  /** Model adapters retain the Harness transcript without retaining a native thread. */
  readonly ephemeral?: true
  /** Persist the real thread id before the task is sent to Codex. */
  readonly started: (id: CodexThreadId) => Promise<void>
  /** Persist matching-thread notifications before result publication; the native peer does not wait for this acknowledgement. */
  readonly event: (method: string, params: Readonly<Record<string, unknown>>) => Promise<void>
}

type CodexFailureStage =
  | 'initialize'
  | 'thread-start'
  | CodexWireFailureFacts['stage']
  | 'process'
  | 'teardown'

type CodexFailureCategory = CodexWireFailureFacts['category'] | 'process'

interface CodexFailureFacts {
  readonly stage: CodexFailureStage
  readonly category: CodexFailureCategory
  readonly httpStatus?: number | undefined
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: CodexFailureFacts): string {
  const fields = [
    'product: Codex',
    `stage: ${facts.stage}`,
    `category: ${facts.category}`,
  ]
  if (facts.httpStatus !== undefined) {
    fields.push(`HTTP status: ${facts.httpStatus}`)
  }
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class CodexRunFailure extends Error {
  constructor(
    readonly facts: CodexFailureFacts,
    cause?: unknown,
  ) {
    super(
      `subagent-codex: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'CodexRunFailure'
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function codexStartupFailure(cause: unknown): Error {
  return new CodexRunFailure({
    stage: 'initialize',
    category: 'unknown',
  }, cause)
}

/**
 * Fixed package-local app-server command, independent of the host `PATH`; Electron uses unpacked package files.
 * @returns Node, the official wrapper, and the fixed app-server arguments.
 */
export function codexAppServerArgv(): string[] {
  return [process.execPath, CODEX_PACKAGE_BIN, 'app-server', '--stdio']
}

/** Build an interactive continuation for the exact retained native thread, without submitting a prompt.
 * @param threadId - Codex-issued identity; never a Harness Task or Session id.
 * @param cwd - original execution directory, checked by the handoff owner.
 * @param selection - retained model, effort and sandbox; approval remains non-interactive and workspace-write excludes ambient extra roots.
 * @returns package-local Node and Codex wrapper arguments, independent of the Terminal PATH.
 */
export function codexResumeArgv(threadId: CodexThreadId, cwd: string,
  selection: {
    readonly sandbox: 'read-only' | 'workspace-write'
    readonly model?: string | undefined
    readonly reasoningEffort?: string | undefined
  }): string[] {
  return [process.execPath, CODEX_PACKAGE_BIN, 'resume', '--sandbox', selection.sandbox,
    '--ask-for-approval', 'never', '--cd', cwd,
    ...(selection.sandbox === 'workspace-write' ? Object.entries(codexTaskWriteConfig)
      .flatMap(([key, value]) => ['--config', `${key}=${JSON.stringify(value)}`]) : []),
    ...(selection.model === undefined ? [] : ['--model', selection.model]),
    ...(selection.reasoningEffort === undefined ? [] : ['--config', `model_reasoning_effort=${JSON.stringify(selection.reasoningEffort)}`]),
    '--', threadId]
}

/** Fully resolved inputs for one Codex app-server run. */
export interface CodexRunSpec {
  /** Structured model-only response; Harness executes returned tool requests. */
  readonly modelRequest?: {
    readonly instructions: string
    readonly outputSchema: Record<string, unknown>
    readonly reasoningEffort?: string
  }
  /** Acknowledged host tools exposed as native dynamic tools; the caller owns side-effect authority. */
  readonly nativeTools?: import('@deepseek-ai/dsh-subagent').NativeTaskTools
  /** Retain a native Task thread with an acknowledged journal; omission creates an ephemeral subagent. */
  readonly journal?: CodexTaskJournal
  /** Exclude ambient tool providers and enforce read-only, network-denied execution.
   * NativeTools and write-enabled modes are not accepted.
   */
  readonly reviewerIsolation?: CodexReviewerIsolation
  /** Private documentation writes with no ambient MCP, hooks, plugins or command network access.
   * Requires never approval, workspace-write journaling, a disjoint source project and read-only host tools.
   */
  readonly documentationIsolation?: CodexDocumentationIsolation
  /** Parent Session workspace, also supplied to `thread/start`. */
  readonly cwd: string
  /** Profile-selected native model; omitted to preserve Codex settings. */
  readonly model?: string
  /** Profile-selected native non-interactive permission mode. */
  readonly permissionMode: CodexPermissionMode
  /** Explicit deployment/test environment layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed subprocess/wire failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Validate and preserve the one-shot task before crossing the process boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-codex: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-codex: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-codex: the one-shot task must not be empty')
  }
  return texts
}

/**
 * Close the private wire, terminate the managed range, and wait for the
 * subprocess owner to prove it is quiescent.
 * @param wire - private app-server protocol connection.
 * @param child - shared-service handle that owns the managed range.
 */
export async function disposeCodexChild(
  wire: CodexAppServerWire,
  child: SubprocessHandle,
): Promise<void> {
  wire.close()
  child.terminate()

  let outcome: SubprocessOutcome | undefined
  void child.done.then(
    (value) => { outcome = value },
    () => {},
  )
  try {
    child.stdin?.end()
  } catch {
    // A concurrently closed stdin does not change range ownership below.
  }
  try {
    await child.waitForExit()
  } catch (error: unknown) {
    throw new CodexRunFailure({
      stage: 'teardown',
      category: 'unknown',
      outcome,
    }, thrown(error))
  }
  await child.done.catch(() => {})
}

/**
 * Start the real `codex app-server --stdio` child and publish its one-shot run.
 * @param request - text-only input and caller cancellation.
 * @param spec - Workspace, environment, process service, and diagnostic policy.
 * @returns the published run after thread creation and any journal acknowledgement.
 */
export async function startCodexRun(
  request: Pick<SubagentStartRequest, 'prompt' | 'signal'>,
  spec: CodexRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (spec.modelRequest !== undefined && (spec.reviewerIsolation === undefined || spec.permissionMode !== 'never'
    || spec.nativeTools !== undefined || spec.journal?.sandbox !== 'read-only' || spec.journal.ephemeral !== true)) {
    throw new Error('Codex model requests require ephemeral read-only audit, native isolation and no host callbacks')
  }
  if (spec.reviewerIsolation !== undefined && (spec.permissionMode !== 'never' || spec.nativeTools !== undefined
    || (spec.journal !== undefined && spec.journal.sandbox !== 'read-only'))) {
    throw new Error('Codex reviewer isolation requires never approval, read-only journaling and no host tools')
  }
  if (spec.documentationIsolation !== undefined && (spec.permissionMode !== 'never' || spec.journal?.sandbox !== 'workspace-write'
    || spec.reviewerIsolation !== undefined)) {
    throw new Error('Codex documentation isolation requires never approval, workspace-write journaling and no reviewer mode')
  }
  const documentationDirectory = spec.documentationIsolation === undefined ? undefined
    : resolveDocumentationDirectory(spec.cwd, spec.documentationIsolation, spec.nativeTools)
  if (request.signal.aborted) {
    throw new Error('subagent-codex: request was aborted before app-server startup')
  }

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: [...codexAppServerArgv(), ...(spec.documentationIsolation !== undefined ? Object.entries(codexDocumentationConfig)
        .flatMap(([key, value]) => ['--config', `${key}=${JSON.stringify(value)}`]) : []), ...(spec.reviewerIsolation === undefined ? [] : Object.entries(codexReviewerConfig)
        .flatMap(([key, value]) => ['--config', `${key}=${JSON.stringify(value)}`]))],
      cwd: spec.cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw new CodexRunFailure({
      stage: 'initialize',
      category: 'unknown',
    }, thrown(error))
  }

  const wire = new CodexAppServerWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
    spec.permissionMode,
    spec.model,
    spec.journal,
    spec.nativeTools,
    spec.reviewerIsolation,
    spec.documentationIsolation,
    documentationDirectory,
    spec.modelRequest,
  )
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary. JSON-RPC and child.done remain the
    // only terminal authorities if the diagnostic stream itself fails.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)
  const disposeProcess = async (): Promise<void> => {
    try {
      try { await disposeCodexChild(wire, child) }
      finally { await wire.flushJournal() }
      // Let stderr already queued by the process close reach the Host before
      // its forwarding listeners are detached.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    } finally {
      child.stderr?.off('data', onStderr)
      child.stderr?.off('error', onStderrError)
    }
  }

  let processFailureFacts: CodexFailureFacts | undefined
  const processFailure: Promise<never> = child.done.then<never>(
    (outcome) => {
      processFailureFacts = {
        stage: 'process',
        category: 'process',
        outcome,
      }
      throw new CodexRunFailure(processFailureFacts)
    },
    (error: unknown) => {
      processFailureFacts = {
        stage: 'process',
        category: 'unknown',
      }
      throw new CodexRunFailure(processFailureFacts, thrown(error))
    },
  )
  // A normal post-result dispose also closes the process. Keep its expected
  // late rejection observed when the terminal result settles first.
  processFailure.catch(() => {})

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-codex: run cancelled locally'))
    // Capture and stop owned descendants before remote interruption can reparent them.
    child.terminate()
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let startupStage: 'initialize' | 'thread-start' = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(request.signal), processFailure])
    startupStage = 'thread-start'
    await Promise.race([wire.startThread(spec.cwd, request.signal), processFailure])
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = runAbort.signal.aborted
    if (!(error instanceof CodexRunFailure) && !cancelledBeforeCleanup) {
      // Node reports stdout EOF before the child close that owns its outcome.
      // Let an already-exiting process publish those facts before rollback.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    const failure = new CodexRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: error instanceof CodexRunFailure
        ? error.facts.outcome
        : processFailureFacts?.outcome,
    }, thrown(error))
    try {
      await disposeProcess()
    } catch (disposeError: unknown) {
      const cleanupFailure = thrown(disposeError)
      throw new AggregateError(
        [failure, cleanupFailure],
        `${failure.message}; ${cleanupFailure.message}`,
      )
    }
    if (cancelledBeforeCleanup) {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    try {
      request.signal.throwIfAborted()
    } catch {
      throw new Error('subagent-codex: request was aborted before run publication')
    }
    throw failure
  }

  const collectOutput = (): ContentBlock[] => wire.collectOutput()
  let diagnostic: string | undefined
  const recordFailureDiagnostic = (facts: CodexFailureFacts): string => {
    const failure = failureDiagnostic(facts)
    const permission = wire.collectDiagnostic()
    diagnostic = permission === undefined
      ? failure
      : `${failure}\n${permission}`
    return diagnostic
  }
  const withProcessOutcome = (facts: CodexFailureFacts): CodexFailureFacts => {
    const outcome = processFailureFacts?.outcome
    return outcome === undefined
      ? facts
      : { ...facts, outcome }
  }
  const publishedProcessFailure = processFailure.catch(
    async (error: unknown): Promise<never> => {
      // Frames already queued by the exiting app-server remain authoritative.
      // One I/O turn lets them settle before process exit ends the run.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      throw error
    },
  )
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          publishedProcessFailure,
        ])
        if (terminal.stopReason === 'completed') return terminal
        // Let stderr already queued with the terminal frame reach the Host
        // before the non-completed result settles.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const facts = withProcessOutcome(wire.collectFailure())
        return { ...terminal, diagnostic: recordFailureDiagnostic(facts) }
      } catch (error: unknown) {
        // Give stderr data already queued in Node one turn to reach the Host
        // before error settlement.
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        const endedBeforeTerminal = wire.endedBeforeTerminal()
        if (
          endedBeforeTerminal
          && processFailureFacts === undefined
          && !runAbort.signal.aborted
        ) {
          try {
            const exited = await child.waitForExit(
              AbortSignal.timeout(Math.ceil(spec.disposeGraceMs)),
            )
            if (exited) await child.done
          } catch {
            // The wire failure remains authoritative when exit observation fails.
          }
        }
        const facts = error instanceof CodexRunFailure
          ? error.facts
          : endedBeforeTerminal && processFailureFacts !== undefined
            ? processFailureFacts
            : withProcessOutcome(wire.collectFailure())
        recordFailureDiagnostic(facts)
        throw error instanceof CodexRunFailure
          ? error
          : new CodexRunFailure(facts, thrown(error))
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}
