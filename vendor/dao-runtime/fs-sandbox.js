import { dirname, sep } from "node:path";
import { LocalFileSystem } from "@deepseek-ai/dsh-fs-local";
import { FsError } from "@deepseek-ai/dsh-fs";
import { writableRoots } from "./sandbox.js";
import { stat } from "node:fs/promises";
//#region lib/types/containment.js
/**
* Path-containment mechanics for the filesystem sandbox. Canonical spellings
* take the fast lexical path; filesystem identity supplies the conservative
* fallback for alias-equivalent roots such as Windows 8.3 names and casing.
* @module @deepseek-ai/dsh-fs-sandbox/containment
*/
const MISSING_CODES = new Set(["ENOENT", "ENOTDIR"]);
function isMissing(error) {
	const code = error.code;
	return MISSING_CODES.has(code);
}
function comparablePath(path, caseSensitive) {
	return caseSensitive ? path : path.toLowerCase().normalize("NFC");
}
function isLexicallyUnder(path, root, caseSensitive) {
	const comparableTarget = comparablePath(path, caseSensitive);
	const comparableRoot = comparablePath(root, caseSensitive);
	if (comparableTarget === comparableRoot) return true;
	const prefix = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
	return comparableTarget.startsWith(prefix);
}
async function statIfPresent(path) {
	try {
		return await stat(path, { bigint: true });
	} catch (error) {
		/* v8 ignore else -- a non-missing stat failure requires a host permission or I/O fault after resolve reached this ancestor. */
		if (isMissing(error)) return void 0;
		/* v8 ignore next -- requires a host permission or I/O fault after resolve already reached this ancestor. */
		throw error;
	}
}
function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}
/**
* Determine whether a canonical target is a writable root or lies beneath it.
* The lexical fast path handles normal canonical spellings. When spellings
* differ, walk the target's existing ancestors and compare filesystem identity
* with the root; this recognizes Windows long-name/8.3 aliases and casing
* without weakening containment to a textual approximation.
* @param path - canonical target key, which may end in a missing suffix.
* @param root - canonical writable root.
* @param caseSensitive - whether lexical comparison preserves case and exact Unicode spelling;
*   false applies case folding and NFC normalization for protected-root exclusions.
*   Defaults to the host filesystem convention used by supported platforms.
* @returns whether the target is the root or a descendant of it.
*/
async function isPathUnder(path, root, caseSensitive = process.platform !== "win32") {
	if (isLexicallyUnder(path, root, caseSensitive)) return true;
	const rootInfo = await statIfPresent(root);
	if (!rootInfo) return false;
	let ancestor = path;
	while (true) {
		const ancestorInfo = await statIfPresent(ancestor);
		if (ancestorInfo && sameIdentity(ancestorInfo, rootInfo)) return true;
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		ancestor = parent;
	}
}
//#endregion
//#region lib/types/mutation-policy.js
/** Explicit filesystem mutation policy shared by trusted in-process providers. */
/**
* Check an explicit mutation policy without resolving ambient policy or writing.
* Workspace-write returns the freshly resolved target; full access without
* exclusions returns the original target. Read-only and containment denials throw
* `FS_SANDBOX_DENIED`; filesystem resolution errors propagate unchanged.
*
* Callers must mutate the returned target and recheck at their final commit.
* This does not lock paths or eliminate resolve-to-syscall races.
* @param fs - filesystem that owns and resolves the target.
* @param target - previously resolved target whose display path is rechecked.
* @param policy - complete policy authorized for this operation.
* @returns the exact target admitted for mutation.
*/
async function resolveWritableTarget(fs, target, policy) {
	const { mode } = policy;
	if (mode === "read-only") throw new FsError(`cannot write "${target.displayPath}": file access denied under read-only mode`, "FS_SANDBOX_DENIED");
	if (mode === "danger-full-access" && (policy.protectedWriteRoots?.length ?? 0) === 0) return target;
	const fresh = await fs.resolve(target.displayPath);
	for (const root of policy.protectedWriteRoots ?? []) if (await isPathUnder(fresh.targetKey, root, false)) throw new FsError(`cannot write "${target.displayPath}": protected directory is read-only to generic tools`, "FS_SANDBOX_DENIED");
	if (mode === "danger-full-access") return fresh;
	for (const root of writableRoots(policy)) if (await isPathUnder(fresh.targetKey, root)) return fresh;
	throw new FsError(`cannot write "${target.displayPath}": file access denied under workspace-write mode`, "FS_SANDBOX_DENIED");
}
/** Refuse a tree publication that would replace an ancestor of protected knowledge.
* @param fs - filesystem that resolves the current destination identity.
* @param target - tree destination, including an as-yet missing path.
* @param policy - complete per-call mutation policy.
* @returns freshly admitted destination.
*/
async function resolveWritableTreeTarget(fs, target, policy) {
	const fresh = await resolveWritableTarget(fs, target, policy);
	for (const root of policy.protectedWriteRoots ?? []) if (await isPathUnder(root, fresh.targetKey, false)) throw new FsError(`cannot replace "${target.displayPath}": tree contains a protected directory`, "FS_SANDBOX_DENIED");
	return fresh;
}
//#endregion
//#region lib/types/index.js
/**
* `SandboxedFileSystem`: the sandbox-enforcing implementation of the
* `@deepseek-ai/dsh-fs` Service Definition. It extends `LocalFileSystem` so all
* storage mechanics — resolve, stat, read/stream, list, binary creation, atomic
* write and the read-match-write edit critical section — are the local
* implementation's, verbatim; this package adds only the per-call POLICY fence
* on all five mutations. Reads pass through untouched: every mode permits
* reading.
*
* The fence is a policy check in TRUSTED code over a MODEL-CONTROLLED path,
* NOT a kernel boundary — the operations are the seam's own (open, rename),
* and only the target path is untrusted, so canonicalize-then-contain is the
* complete answer to this surface. This is containment, not a security
* boundary; kernel-grade isolation of untrusted CODE stays `ctx.shell`'s job
* (`@deepseek-ai/dsh-bash-sandbox`). The residual
* TOCTOU (an ancestor symlink swapped between the containment re-check and the
* syscall) is narrowed by re-canonicalizing immediately before delegating and
* is accepted for this threat model.
*
* Per-call policy: `read-only` denies every mutation; `workspace-write` allows
* a mutation only when the target canonicalizes under the policy's workspace
* root, an explicit additional writable root, or a platform temp area from the
* shared `writableRoots` policy; `danger-full-access` delegates unfenced. A
* denial throws the structured `FS_SANDBOX_DENIED`.
*
* @module @deepseek-ai/dsh-fs-sandbox
*/
/**
* Sandbox-enforcing filesystem backend. Registers as `ctx.fs` (loading it
* INSTEAD OF `dsh-fs-local`, together with a `ctx.sandboxPolicy`, is the whole
* swap — the model-facing tools are untouched). Its configured default mode is
* the capability fact exposed by {@link sandboxMode}; `dsh-tool-fs` resolves
* each session's mode and cwd into a policy for every mutation, while an
* approved escalation may stamp a strictly wider mode for one call.
*/
var SandboxedFileSystem = class extends LocalFileSystem {
	static inject = ["sandboxPolicy"];
	defaultMode;
	constructor(ctx, config) {
		super(ctx, config);
		this.defaultMode = ctx.sandboxPolicy.defaultMode;
	}
	/** The deployment default mode — the capability fact the tool layer reads to advertise escalation. */
	get sandboxMode() {
		return this.defaultMode;
	}
	/** @param sandboxPolicy - explicit write policy, or the deployment fallback when omitted. */
	publishTree(target, entries, options, signal, sandboxPolicy) {
		const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
		const beforeCommit = async () => {
			await options.beforeCommit();
			const admitted = await resolveWritableTreeTarget(this, target, policy);
			const parent = await this.resolve(dirname(this.processPath(admitted)));
			await this.checkedTarget(parent, policy);
			if (admitted.targetKey !== target.targetKey) throw new FsError("Directory destination was reassigned", "FS_STALE_VERSION");
		};
		return resolveWritableTreeTarget(this, target, policy).then(() => super.publishTree(target, entries, {
			...options,
			beforeCommit
		}, signal));
	}
	/** @param sandboxPolicy - explicit write policy, or the deployment fallback when omitted. */
	async createBytes(target, content, signal, sandboxPolicy) {
		return super.createBytes(await this.checkedTarget(target, sandboxPolicy), content, signal);
	}
	/**
	* Fence the write by the per-call policy, then delegate to the inherited
	* atomic write. See {@link checkedTarget}.
	* @param target - the resolved target to write.
	* @param content - the full new file content.
	* @param expected - the write intent guarding the write; omit for unconditional.
	* @param signal - aborts before atomic publication takes effect.
	* @param sandboxPolicy - the per-call mode and workspace root; omit to use
	*   the deployment fallback.
	* @returns the write outcome from the inherited backend.
	*/
	async writeText(target, content, expected, signal, sandboxPolicy) {
		return super.writeText(await this.checkedTarget(target, sandboxPolicy), content, expected, signal);
	}
	/**
	* Fence the edit by the per-call policy, then delegate to the inherited
	* atomic edit. See {@link checkedTarget}.
	* @param target - the resolved target to edit.
	* @param edit - the literal search/replace request.
	* @param expected - the version guard; omit for an unconditional edit.
	* @param signal - aborts before atomic publication takes effect.
	* @param sandboxPolicy - the per-call mode and workspace root; omit to use
	*   the deployment fallback.
	* @returns the edit outcome from the inherited backend.
	*/
	async editText(target, edit, expected, signal, sandboxPolicy) {
		return super.editText(await this.checkedTarget(target, sandboxPolicy), edit, expected, signal);
	}
	/**
	* Fence the mutation before delegating to the local provider.
	* @param sandboxPolicy - per-call mode and workspace root; omit for the deployment fallback.
	*/
	async patchText(target, hunks, expected, signal, sandboxPolicy) {
		return super.patchText(await this.checkedTarget(target, sandboxPolicy), hunks, expected, signal);
	}
	/**
	* Fence the mutation before delegating to the local provider.
	* @param sandboxPolicy - per-call mode and workspace root; omit for the deployment fallback.
	*/
	async deleteFile(target, expected, signal, sandboxPolicy) {
		return super.deleteFile(await this.checkedTarget(target, sandboxPolicy), expected, signal);
	}
	/**
	* Fence the mutation before delegating to the local provider.
	* @param sandboxPolicy - per-call mode and workspace root; omit for the deployment fallback.
	*/
	async moveFile(source, destination, options, signal, sandboxPolicy) {
		const checkedSource = await this.checkedTarget(source, sandboxPolicy);
		const checkedDestination = await this.checkedTarget(destination, sandboxPolicy);
		return super.moveFile(checkedSource, checkedDestination, options, signal);
	}
	/** Only provider calls without an explicit policy use the deployment fallback. */
	async checkedTarget(target, sandboxPolicy) {
		return resolveWritableTarget(this, target, sandboxPolicy ?? this.ctx.sandboxPolicy.resolve());
	}
};
//#endregion
export { SandboxedFileSystem, SandboxedFileSystem as default };
