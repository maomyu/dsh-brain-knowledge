import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
//#region lib/types/windows-native-resources.js
/** Read-only verification for installed source-bound Windows native command resources. */
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;
const digest = (body) => createHash("sha256").update(body).digest("hex");
/** Require ordinary directories for a native resource path and every ancestor.
* @param path - Absolute resource directory.
* @returns Resolves when every directory is real and unredirected.
*/
async function requireWindowsNativeResourceDirectory(path) {
	if (!isAbsolute(path)) throw new Error("windows native resources: absolute directory required");
	for (let at = resolve(path);;) {
		const info = await lstat(at);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("windows native resources: redirected or non-directory ancestor");
		const parent = dirname(at);
		if (parent === at) return;
		at = parent;
	}
}
/** Read an ordinary, unlinked native input within a caller-owned byte bound.
* @param path - Absolute input file with ordinary directory ancestors.
* @param maximum - Maximum admitted file bytes.
* @returns Complete file bytes after type and length checks.
*/
async function readWindowsNativeResourceFile(path, maximum) {
	await requireWindowsNativeResourceDirectory(dirname(path));
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) throw new Error("windows native resources: linked, oversized or non-regular file");
	const body = await readFile(path);
	if (body.length !== info.size || body.length > maximum) throw new Error("windows native resources: file length changed");
	return body;
}
/** Require Windows x64 PE bytes without executing the file.
* @param body - Complete executable bytes.
*/
function verifyWindowsNativeResourceExecutable(body) {
	const pe = body.length >= 64 && body.readUInt16LE(0) === 23117 ? body.readUInt32LE(60) : -1;
	if (pe < 64 || pe + 26 > body.length || body.readUInt32LE(pe) !== 17744 || body.readUInt16LE(pe + 4) !== 34404 || body.readUInt16LE(pe + 24) !== 523) throw new Error("windows native resources: Windows x64 PE required");
}
/** Parse the fixed native manifest fields without applying a build-specific source lock.
* @param body - Untrusted UTF-8 manifest bytes.
* @returns Exact manifest paths, target and fingerprints.
*/
function parseWindowsNativeResourceManifest(body) {
	let value;
	try {
		value = JSON.parse(body.toString("utf8"));
	} catch (error) {
		throw new Error("windows native resources: invalid manifest JSON", { cause: error });
	}
	const keys = [
		"schemaVersion",
		"platform",
		"arch",
		"executable",
		"executableSha256",
		"executableBytes",
		"source",
		"sourceSha256"
	];
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || !("schemaVersion" in value) || value.schemaVersion !== 1 && value.schemaVersion !== 2 || !("platform" in value) || value.platform !== "win32" || !("arch" in value) || value.arch !== "x64" || !("executable" in value) || value.executable !== "appcontainer-runner.exe" || !("source" in value) || value.source !== "appcontainer-runner.cs" || !("sourceSha256" in value) || typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.sourceSha256) || !("executableSha256" in value) || typeof value.executableSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.executableSha256) || !("executableBytes" in value) || typeof value.executableBytes !== "number" || !Number.isSafeInteger(value.executableBytes) || value.executableBytes <= 0 || value.executableBytes > MAX_EXECUTABLE_BYTES) throw new Error("windows native resources: unsupported manifest fields or source binding");
	return {
		schemaVersion: value.schemaVersion,
		platform: "win32",
		arch: "x64",
		executable: value.executable,
		executableSha256: value.executableSha256,
		executableBytes: value.executableBytes,
		source: value.source,
		sourceSha256: value.sourceSha256
	};
}
/**
* Verify the complete native resource directory and both source and executable bytes.
* @param runtime - Existing external Desktop runtime directory.
* @returns The exact verified manifest used for native executable pins.
*/
async function verifyWindowsNativeResources(runtime) {
	const directory = join(runtime, "windows-native");
	await requireWindowsNativeResourceDirectory(directory);
	const names = (await readdir(directory)).sort();
	if (JSON.stringify(names) !== JSON.stringify([
		"appcontainer-runner.cs",
		"appcontainer-runner.exe",
		"manifest.json"
	])) throw new Error("windows native resources: unexpected or missing resource member");
	const result = parseWindowsNativeResourceManifest(await readWindowsNativeResourceFile(join(directory, "manifest.json"), 16 * 1024));
	const source = await readWindowsNativeResourceFile(join(directory, result.source), 1024 * 1024);
	const executable = await readWindowsNativeResourceFile(join(directory, result.executable), MAX_EXECUTABLE_BYTES);
	if (digest(source) !== result.sourceSha256 || executable.length !== result.executableBytes || digest(executable) !== result.executableSha256) throw new Error("windows native resources: source or executable fingerprint changed");
	verifyWindowsNativeResourceExecutable(executable);
	return result;
}
//#endregion
export { parseWindowsNativeResourceManifest, readWindowsNativeResourceFile, requireWindowsNativeResourceDirectory, verifyWindowsNativeResourceExecutable, verifyWindowsNativeResources };
