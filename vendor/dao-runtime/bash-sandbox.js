import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature, matchesSignature as matchesSignature$1, mergeConfinementEnv, supportsProtectedWrites } from "./sandbox.js";
import { ENV_OVERRIDES, LocalBashExecutor } from "@deepseek-ai/dsh-bash-local";
//#region lib/types/helpers.js
/**
* Classify a failed run against the selected backend's denial dialect.
* @param result - settled foreground run.
* @param signatures - case-insensitive denial substrings from the active wrap.
* @returns whether the failed run matches that denial dialect.
*/
function classifyDenial(result, signatures) {
	return matchesSignature(result.exitCode, result.stderr.text, signatures);
}
//#endregion
//#region lib/types/index.js
/**
* Sandbox-consuming bash executor. It wraps the exact local bash argv through
* `ctx.sandbox`, inherits local process mechanics, and reports the selected
* mode, enforcement, and denial facts. Positive runner-executable evidence
* identifies a broken confinement runner: foreground calls throw
* `SANDBOX_UNAVAILABLE`, while background processes carry `runnerFailed`;
* other provider rejections retain stage-neutral local-executor semantics. The
* tool owns approval and passes a complete per-call policy.
* @module @deepseek-ai/dsh-bash-sandbox
*/
/**
* Registers as `ctx.shell` in place of the local executor and requires a
* `ctx.sandbox` provider plus `ctx.sandboxPolicy`; the tool layer is
* unchanged. Tool calls pass the calling session's resolved policy; direct
* calls fall back to deployment policy. `result.sandbox` reports the mode and
* enforcement actually used.
*/
var SandboxBashExecutor = class SandboxBashExecutor extends LocalBashExecutor {
	static inject = [
		"subprocess",
		"sandbox",
		"sandboxPolicy"
	];
	mode;
	/**
	* Per-process confinement facts retained until settlement. Providers may
	* vary enforcement and diagnostic dialect between overlapping calls, so a
	* shared latest-wrap value would classify a process against the wrong facts.
	* Full-access processes without protected exclusions have no entry.
	*/
	processFacts = /* @__PURE__ */ new Map();
	constructor(ctx, config) {
		super(ctx, config);
		this.mode = ctx.sandboxPolicy.defaultMode;
	}
	/** The configured default mode — the capability fact the tool layer reads. */
	get sandboxMode() {
		return this.mode;
	}
	/**
	* Stamp a complete per-call policy onto the spec. Tool calls supply the
	* calling session's resolved mode and root; lower-level callers fall back to
	* the deployment policy.
	*/
	resolve(request) {
		return {
			...super.resolve(request),
			sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
		};
	}
	async execute(spec) {
		const policy = spec.sandboxPolicy;
		const { mode } = policy;
		const protectedWrites = (policy.protectedWriteRoots?.length ?? 0) > 0;
		if (mode === "danger-full-access" && !protectedWrites && !this.ctx.sandbox.requiresFullAccessWrapper) return SandboxBashExecutor.decorateResult(await super.execute(spec), (result) => ({
			...result,
			sandbox: {
				mode,
				denied: false
			}
		}));
		let confined;
		// The target Host's preparation callback returns argv, not { argv, env }.
		// Keep provider environment exclusions after both ordinary and managed values.
		const executionSpec = { ...spec };
		const ex = await this.executeArgv(executionSpec, async (signal) => {
			const prepared = await this.confine(spec, policy, signal);
			signal.throwIfAborted();
			if (protectedWrites && mode !== "read-only" && !supportsProtectedWrites(prepared)) throw new SandboxUnavailableError(mode, "selected provider reports partial protected-write enforcement", true);
			confined = prepared;
			executionSpec.env = mergeConfinementEnv({ ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv }, prepared.env, prepared);
			executionSpec.dshEnv = undefined;
			return prepared.argv;
		}, (process) => {
			const facts = confined;
			this.processFacts.set(process, {
				mode,
				enforcement: facts.enforcement,
				denialSignatures: facts.denialSignatures,
				runnerFailureRules: facts.runnerFailureRules,
				runnerProgram: facts.argv[0],
				workdir: spec.workdir
			});
		});
		return SandboxBashExecutor.decorateResult(ex, (result) => {
			if (confined === void 0) return {
				...result,
				sandbox: {
					mode,
					denied: false
				}
			};
			const { enforcement, denialSignatures, runnerFailureRules } = confined;
			const runnerFailure = classifyRunnerFailure(result.exitCode, result.stderr.text, runnerFailureRules);
			if (runnerFailure !== void 0) throw new SandboxUnavailableError(mode, runnerFailure.detail, protectedWrites);
			return {
				...result,
				sandbox: {
					mode,
					denied: classifyDenial(result, denialSignatures),
					enforcement
				}
			};
		}, (error) => {
			if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
			if (confined !== void 0 && isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) throw new SandboxUnavailableError(mode, String(error), protectedWrites);
			throw error;
		});
	}
	/**
	* Decorate the handle's foreground projection in place, memoized once. The
	* handle keeps its identity (never wrapped in a second object) because the
	* per-process facts and `onProcessDone` key on the exact instance.
	*/
	static decorateResult(ex, map, mapError) {
		const base = ex.result.bind(ex);
		let decorated;
		ex.result = () => {
			decorated ??= base().then(map, mapError);
			return decorated;
		};
		return ex;
	}
	/**
	* Stamp per-process sandbox facts before `done` settles. Full-access processes
	* have no facts; signal deaths are not denials.
	*/
	onProcessDone(proc, stderr, providerRejected, providerError) {
		const facts = this.processFacts.get(proc);
		if (facts !== void 0) {
			this.processFacts.delete(proc);
			const runnerFailed = providerRejected ? isRunnerSpawnFailure(providerError, facts.runnerProgram, facts.workdir) : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== void 0;
			proc.sandbox = {
				mode: facts.mode,
				denied: !runnerFailed && matchesSignature$1(proc.exitCode, stderr, facts.denialSignatures),
				enforcement: facts.enforcement,
				...runnerFailed ? { runnerFailed } : {}
			};
		}
		super.onProcessDone(proc, stderr, providerRejected, providerError);
	}
	/**
	* Wrap one shell command via the `ctx.sandbox` provider. Provider errors
	* propagate unchanged; the returned argv is handed directly to the local
	* executor's subprocess path.
	* @param command - shell source for the confined inner `bash -c`.
	* @param policy - resolved confined execution policy.
	* @param signal - cancellation of confinement preparation.
	* @returns the provider's exact argv and settlement-classification facts.
	*/
	confine(spec, policy, signal) {
		return this.ctx.sandbox.confine([
			"bash",
			"-c",
			spec.command
		], policy, signal, { cwd: spec.workdir });
	}
};
//#endregion
export { SandboxBashExecutor, SandboxBashExecutor as default };
