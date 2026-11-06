import { execFile, spawnSync } from "node:child_process";
import { createReadStream, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT, grantArgs, launcherPath, probe } from "@deepseek-ai/node-addon-system/landlock-run";
import z from "@deepseek-ai/schemastery";
import { SandboxProvider, SandboxUnavailableError, SandboxUnsupportedPolicyError, canonicalPath, workspaceWritableRoots, writableRoots } from "./sandbox.js";
import { AclWriteGrant, assertTempRootOutsideWorkspace, registerAclDiagnosisSkill, tempWriteSid, workspaceWriteSid } from "@deepseek-ai/dsh-sandbox-windows-acl";
import { assertNever } from "@deepseek-ai/dsh-util-values";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
//#region lib/types/profiles.js
/**
* Internal platform-profile builders for the local sandbox provider.
*
* @module @deepseek-ai/dsh-sandbox-local/profiles
*/
/**
* Refuse path-only Seatbelt confinement when a protected file has another writable hardlink.
* @param policy - policy whose protected trees a writable process will read.
*/
function assertProtectedRootsHaveNoHardlinks(policy) {
	for (const root of new Set((policy.protectedWriteRoots ?? []).map(canonicalPath))) {
		const pending = [root];
		while (pending.length > 0) {
			const path = pending.pop();
			let stat;
			try {
				stat = lstatSync(path);
			} catch (error) {
				if (path === root && error.code === "ENOENT") break;
				throw new SandboxUnavailableError(policy.mode, "cannot inspect a protected write root", true);
			}
			if (stat.isFile() && stat.nlink > 1) throw new SandboxUnavailableError(policy.mode, "a protected write root contains a hardlinked file", true);
			if (stat.isFile()) continue;
			if (!stat.isDirectory()) throw new SandboxUnavailableError(policy.mode, "a protected write root contains an unsupported entry", true);
			try {
				for (const entry of readdirSync(path)) pending.push(join(path, entry));
			} catch {
				throw new SandboxUnavailableError(policy.mode, "cannot enumerate a protected write root", true);
			}
		}
	}
}
/**
* Build the bwrap profile arguments for one file-effect policy.
* @param policy - file-effect policy to express as bwrap mounts.
* @returns profile arguments before the trailing separator and command argv.
*/
function bwrapProfileArgs(policy) {
	if (policy.mode === "danger-full-access") throw new SandboxUnavailableError(policy.mode, "bwrap profile does not support full-access confinement", (policy.protectedWriteRoots?.length ?? 0) > 0);
	const args = [
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--unshare-pid",
		"--proc",
		"/proc",
		"--die-with-parent"
	];
	if (policy.mode === "workspace-write") {
		args.push("--tmpfs", "/tmp");
		for (const root of workspaceWritableRoots(policy)) args.push("--bind", root, root);
	}
	return args;
}
/**
* Build the Landlock launcher grants for one file-effect policy.
* @param policy - file-effect policy to express as Landlock allow-list grants.
* @returns launcher grant arguments before the trailing separator and command argv.
*/
function landlockProfileArgs(policy) {
	if (policy.mode === "danger-full-access") throw new SandboxUnavailableError(policy.mode, "Landlock profile does not support full-access confinement", (policy.protectedWriteRoots?.length ?? 0) > 0);
	const readWrite = ["/dev/null"];
	if (policy.mode === "workspace-write") readWrite.push("/tmp", ...workspaceWritableRoots(policy));
	return grantArgs({
		readOnly: ["/"],
		readWrite
	});
}
/** Quote one path as an SBPL string literal. */
function sbplString(path) {
	return `"${path.replaceAll("\\", String.raw`\\`).replaceAll("\"", String.raw`\"`)}"`;
}
/**
* Build the sandbox-exec arguments and SBPL profile for one policy. The
* workspace-owned writable roots (workspace plus explicit extra directories)
* come from the shared {@link writableRoots} helper (canonical, deduplicated)
* so the Seatbelt grant and the in-process fs fence
* (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart; the helper adds the
* documented Seatbelt temp areas.
* @param policy - file-effect policy to express as an SBPL profile.
* @returns sandbox-exec arguments before the trailing separator and command argv.
*/
function seatbeltProfileArgs(policy) {
	const forms = ["(version 1)", "(allow default)"];
	if (policy.mode !== "danger-full-access") forms.push("(deny file-write*)", `(allow file-write* (literal ${sbplString("/dev/null")}))`);
	const roots = writableRoots(policy);
	if (roots.length > 0) forms.push(`(allow file-write* ${roots.map((root) => `(subpath ${sbplString(root)})`).join(" ")})`);
	const protectedRoots = [...new Set((policy.protectedWriteRoots ?? []).map(canonicalPath))];
	for (const root of protectedRoots) {
		forms.push(`(deny file-write* (subpath ${sbplString(root)}))`);
		let ancestor = dirname(root);
		while (true) {
			forms.push(`(deny file-write* (literal ${sbplString(ancestor)}))`);
			const parent = dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
	}
	return ["-p", forms.join(" ")];
}
//#endregion
//#region lib/types/windows-prepared-system-roots.js
/** Read-only admission of the platform roots refreshed by the pinned Windows sandbox. */
const SYSTEM_READ_ROOTS = [
	"C:\\",
	"C:\\Windows",
	"C:\\Program Files",
	"C:\\Program Files (x86)",
	"C:\\ProgramData"
];
function rootKey(path) {
	return path.replace(/\\$/u, "").toLowerCase();
}
/**
* Require every existing platform root; absent-root admission is unsupported.
* @param roots - approved descriptors for the fixed Codex 0.165.0 platform roots and drive root.
*/
function validatePreparedSystemReadRoots(roots) {
	const expected = new Set(SYSTEM_READ_ROOTS.map(rootKey));
	if (roots.length !== expected.size || roots.some((root) => !/^[A-Za-z]:\\/u.test(root.path) || !expected.delete(rootKey(root.path)) || root.sddl.length === 0 || /[\r\n\0]/u.test(root.sddl))) throw new Error("windowsPreparedSandbox requires exact existing system read roots and approved SDDLs");
}
/** PowerShell admission appended before a public CLI launch; performs no filesystem or ACL mutations. */
const PREPARED_SYSTEM_ROOT_CHECK = `
function Has-DaoBuiltinReadExecuteAce($Descriptor) {
  if ($null -eq $Descriptor.DiscretionaryAcl) { return $false }
  foreach ($ace in $Descriptor.DiscretionaryAcl) {
    if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { continue }
    if (([int]$ace.AceFlags -band 8) -ne 0) { continue }
    if (@('S-1-5-32-545','S-1-5-11','S-1-1-0') -notcontains $ace.SecurityIdentifier.Value) { continue }
    $mask=[uint64][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ace.AccessMask),0)
    if (($mask -band 2147483648) -ne 0) { $mask=$mask -bor 1179785 }
    if (($mask -band 1073741824) -ne 0) { $mask=$mask -bor 1179926 }
    if (($mask -band 536870912) -ne 0) { $mask=$mask -bor 1179808 }
    if (($mask -band 268435456) -ne 0) { $mask=$mask -bor 2032127 }
    $mask=$mask -band 268435455
    if (($mask -band 1179817) -eq 1179817) { return $true }
  }
  return $false
}
$systemRoots=ConvertFrom-Json $env:DAO_SANDBOX_SYSTEM_READ_ROOTS
$requiredSystemRoots=@('C:\\','C:\\Windows','C:\\Program Files','C:\\Program Files (x86)','C:\\ProgramData')
if ($systemRoots.Count -ne $requiredSystemRoots.Count) { throw 'SYSTEM_READ_ROOT_SET_CHANGED' }
foreach ($requiredRoot in $requiredSystemRoots) {
  $rootMatches=@($systemRoots | Where-Object { $_.path.TrimEnd([char]92) -ieq $requiredRoot.TrimEnd([char]92) })
  if ($rootMatches.Count -ne 1 -or [string]::IsNullOrEmpty($rootMatches[0].sddl)) { throw 'SYSTEM_READ_ROOT_SET_CHANGED' }
  $entry=$rootMatches[0]
  if (!$entry.path.StartsWith('C:\\',[StringComparison]::OrdinalIgnoreCase)) { throw 'SYSTEM_READ_ROOT_SET_CHANGED' }
  $current=$entry.path
  while ($null -ne $current) {
    $item=Get-Item -LiteralPath $current -Force -ErrorAction Stop
    if (!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'SYSTEM_READ_ROOT_REDIRECTED' }
    $parent=[IO.Directory]::GetParent($current)
    $current=if ($null -eq $parent) { $null } else { $parent.FullName }
  }
  $acl=Get-Acl -LiteralPath $entry.path -ErrorAction Stop
  if ($acl.Sddl -cne $entry.sddl) { throw 'SYSTEM_READ_ROOT_ACL_CHANGED' }
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  if (!(Has-DaoBuiltinReadExecuteAce $descriptor)) { throw 'SYSTEM_READ_ROOT_WOULD_RECEIVE_GRANT' }
}
`;
//#endregion
//#region lib/types/windows-ancestors.js
/** Windows path ancestry shared by the prepared-workspace and volume admission checks. */
/** Enumerate strict parents through the volume root, without inspecting the filesystem.
* @param path - Windows path whose spelling has already been admitted by the caller.
* @returns nearest parent first, including the root exactly once.
*/
function windowsAncestors(path) {
	const result = [];
	for (let current = win32.dirname(path);; current = win32.dirname(current)) {
		result.push(current);
		if (win32.dirname(current) === current) return result;
	}
}
//#endregion
//#region lib/types/windows-prepared-protected-tree.js
/** Read-only admission of existing file identities and ACLs for a prepared Windows workspace. */
const WRITE_ALLOW$1 = 1245631;
const WRITE_DENY = 1245526;
const MUTATION$1 = 852310;
const CHANGE_SECURITY = 786432;
const runFile$3 = promisify(execFile);
const key$1 = (path) => win32.normalize(path).toLowerCase();
const within$3 = (path, root) => key$1(path) === key$1(root) || key$1(path).startsWith(`${key$1(root).replace(/\\$/u, "")}\\`);
function object$1(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("protected-tree observation is malformed");
	return value;
}
function string$2(value) {
	if (typeof value !== "string" || value.length === 0) throw new Error("protected-tree string is malformed");
	return value;
}
function integer(value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4294967295) throw new Error("protected-tree integer is malformed");
	return value;
}
function array$1(value) {
	if (!Array.isArray(value)) throw new Error("protected-tree array is malformed");
	return value;
}
function boolean$1(value) {
	if (typeof value !== "boolean") throw new Error("protected-tree boolean is malformed");
	return value;
}
function mask$1(ace) {
	let value = ace.mask;
	if (value & 2147483648) value |= 1179785;
	if (value & 1073741824) value |= 1179926;
	if (value & 536870912) value |= 1179808;
	if (value & 268435456) value |= 2032127;
	return value & 268435455;
}
function descriptor$1(value) {
	const item = object$1(value);
	return {
		path: string$2(item.path),
		directory: boolean$1(item.directory),
		owner: string$2(item.owner),
		protected: boolean$1(item.protected),
		canonical: boolean$1(item.canonical),
		aces: array$1(item.aces).map((value) => {
			const ace = object$1(value);
			return {
				type: integer(ace.type),
				sid: string$2(ace.sid),
				mask: integer(ace.mask),
				flags: integer(ace.flags)
			};
		})
	};
}
/** Read the already-created capability selected by the pinned CLI; never synthesize a SID.
* @param input - parsed private cap_sid JSON, which contains no passwords.
* @param config - actual execution placement and sole writable root.
* @returns the existing write capability SID, or rejects a missing/ambiguous record.
*/
function preparedWriteCapability(input, config) {
	const caps = object$1(input);
	const entries = object$1(key$1(config.cwd) === key$1(config.workspaceRoot) ? caps.workspace_by_cwd : caps.writable_root_by_path);
	const matching = Object.entries(entries).filter(([path]) => key$1(path.replace(/^\\\\\?\\/u, "")) === key$1(config.workspaceRoot));
	const [matched] = matching;
	if (matching.length !== 1 || matched === void 0) throw new Error("prepared workspace capability is missing or ambiguous");
	const sid = string$2(matched[1]);
	if (!/^S-1-5-21-(?:\d+-){3}\d+$/u.test(sid)) throw new Error("prepared workspace capability SID is malformed");
	return sid;
}
/** Validate raw ACL observations without granting or repairing permissions.
* @param input - JSON emitted by the read-only PowerShell collector.
* @param config - the sole writable root and direct-child protected directories.
* @param capability - SID read from the private registry for this execution.
* @param expectedPaths - complete ACL paths independently enumerated by the Host.
* @returns after every promised descriptor is admitted; complex or incomplete ACLs reject.
*/
function validatePreparedTreeAcls(input, config, capability, expectedPaths) {
	const snapshot = object$1(input);
	const host = string$2(snapshot.hostSid);
	const users = array$1(snapshot.sandboxSids).map(string$2);
	const group = string$2(snapshot.sandboxGroupSid);
	if (users.length !== 2 || new Set(users).size !== 2 || users.includes(host) || users.includes(capability) || users.includes(group) || group === host || group === capability || !/^S-1-5-21-(?:\d+-){3}\d+$/u.test(group)) throw new Error("protected-tree account identities are ambiguous");
	const entries = array$1(snapshot.entries).map(descriptor$1);
	const byPath = new Map(entries.map((entry) => [key$1(entry.path), entry]));
	if (byPath.size !== entries.length) throw new Error("protected-tree descriptor paths are duplicated");
	if (byPath.size !== expectedPaths.length || expectedPaths.some((path) => !byPath.has(key$1(path)))) throw new Error("protected-tree descriptor enumeration is incomplete");
	const trustedOwner = new Set([
		host,
		"S-1-5-18",
		"S-1-5-32-544"
	]);
	const restricting = (sid) => sid === capability || sid === "S-1-1-0" || users.includes(sid) || sid.startsWith("S-1-5-5-");
	const root = byPath.get(key$1(config.workspaceRoot));
	if (root === void 0 || !root.directory) throw new Error("protected-tree workspace descriptor is missing");
	for (const path of [...windowsAncestors(config.workspaceRoot), ...config.protectedWriteRoots]) if (!byPath.get(key$1(path))?.directory) throw new Error("protected-tree required directory descriptor is missing");
	for (const sid of [capability, group]) {
		const allows = root.aces.filter((ace) => ace.type === 0 && ace.sid === sid && !(ace.flags & 16));
		if (!allows.some((ace) => !(ace.flags & 8) && (mask$1(ace) & WRITE_ALLOW$1) === WRITE_ALLOW$1) || !allows.some((ace) => (ace.flags & 3) === 3 && !(ace.flags & 4) && (mask$1(ace) & WRITE_ALLOW$1) === WRITE_ALLOW$1)) throw new Error("prepared workspace capability/group does not match its explicit write grant");
	}
	for (const entry of entries) {
		const protectedRoot = config.protectedWriteRoots.find((root) => within$3(entry.path, root));
		const isWorkspace = key$1(entry.path) === key$1(config.workspaceRoot);
		const isAncestor = windowsAncestors(config.workspaceRoot).some((path) => key$1(path) === key$1(entry.path));
		if (!isWorkspace && !isAncestor && protectedRoot === void 0) throw new Error("protected-tree descriptor escaped the admitted paths");
		if (!entry.canonical || entry.aces.length === 0 || entry.aces.some((ace) => ![0, 1].includes(ace.type) || (ace.flags & -32) !== 0)) throw new Error("protected-tree ACL is null, noncanonical, or unsupported");
		if (isAncestor && (restricting(entry.owner) || entry.owner === group)) throw new Error("prepared ancestor owner can change its ACL");
		if (!isAncestor && !trustedOwner.has(entry.owner)) throw new Error("protected-tree owner is not the Host or system administrator");
		for (const ace of entry.aces) {
			if (ace.type !== 0) continue;
			const rights = mask$1(ace);
			if (restricting(ace.sid) && (isAncestor ? (rights & MUTATION$1) !== 0 : isWorkspace && (rights & 786496) !== 0)) throw new Error("prepared ancestor/workspace grants a restricting SID unsafe write rights");
			if ((isWorkspace || protectedRoot !== void 0) && !trustedOwner.has(ace.sid) && (rights & 64) !== 0) throw new Error("prepared workspace/protected directory grants untrusted delete-child rights");
			if (!trustedOwner.has(ace.sid) && (rights & CHANGE_SECURITY) !== 0) throw new Error("protected-tree ACL grants untrusted ownership or DACL changes");
			if (protectedRoot !== void 0 && !(ace.flags & 16) && !trustedOwner.has(ace.sid) && (rights & MUTATION$1) !== 0) throw new Error("protected-tree explicit write allow precedes inherited denial");
		}
		if (protectedRoot === void 0) continue;
		if (entry.protected) throw new Error("protected-tree descendant disables ACL inheritance");
		const rootEntry = key$1(entry.path) === key$1(protectedRoot);
		const denies = entry.aces.filter((ace) => ace.type === 1 && ace.sid === capability && Boolean(ace.flags & 16) !== rootEntry && (mask$1(ace) & WRITE_DENY) === WRITE_DENY);
		if (!denies.some((ace) => !(ace.flags & 8)) || entry.directory && !denies.some((ace) => (ace.flags & 3) === 3 && !(ace.flags & 4))) throw new Error("protected-tree complete effective and inheritable deny is missing");
	}
}
/** Read-only PS 5.1 collection; raw SIDs and ACL fields contain no file contents or credentials. */
const PREPARED_TREE_ACL_READ = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$settings=ConvertFrom-Json $env:DAO_PREPARED_TREE
$records=[Collections.Generic.List[object]]::new()
$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
function Read-DaoTreeAcl([string]$Path) {
  if (!$seen.Add($Path)) { return }
  $item=Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROTECTED_TREE_REPARSE' }
  $acl=Get-Acl -LiteralPath $Path -ErrorAction Stop
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.Sddl)
  if ($null -eq $raw.DiscretionaryAcl) { throw 'PROTECTED_TREE_NULL_DACL' }
  $aces=[Collections.Generic.List[object]]::new()
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) { throw 'PROTECTED_TREE_COMPLEX_ACE' }
    $aces.Add(@{type=[int]$ace.AceType;sid=$ace.SecurityIdentifier.Value;mask=[uint64][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ace.AccessMask),0);flags=[int]$ace.AceFlags})
  }
  $records.Add(@{path=$item.FullName;directory=[bool]$item.PSIsContainer;owner=$raw.Owner.Value;protected=[bool]$acl.AreAccessRulesProtected;canonical=[bool]$acl.AreAccessRulesCanonical;aces=$aces.ToArray()})
}
$current=[string]$settings.workspaceRoot
while ($null -ne $current) {
  Read-DaoTreeAcl $current
  $parent=[IO.Directory]::GetParent($current)
  $current=if ($null -eq $parent) { $null } else { $parent.FullName }
}
$queue=[Collections.Generic.Queue[string]]::new()
$queue.Enqueue([string]$settings.workspaceRoot)
$count=0
while ($queue.Count -gt 0) {
  $path=$queue.Dequeue();$count++
  if ($count -gt $settings.maxEntries) { throw 'PROTECTED_TREE_ENTRY_LIMIT' }
  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROTECTED_TREE_REPARSE' }
  foreach ($root in $settings.protectedWriteRoots) {
    if ($path -ieq $root -or $path.StartsWith(([string]$root).TrimEnd([char]92)+[char]92,[StringComparison]::OrdinalIgnoreCase)) { Read-DaoTreeAcl $path;break }
  }
  if ($item.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop) { $queue.Enqueue($child.FullName) }
  }
}
$online=Get-LocalUser -Name CodexSandboxOnline -ErrorAction Stop
$offline=Get-LocalUser -Name CodexSandboxOffline -ErrorAction Stop
$group=Get-LocalGroup -Name CodexSandboxUsers -ErrorAction Stop
@{hostSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;sandboxSids=@($online.SID.Value,$offline.SID.Value);sandboxGroupSid=$group.SID.Value;entries=$records.ToArray()} | ConvertTo-Json -Depth 8 -Compress
`;
async function scanTree(config, signal) {
	const queue = [config.workspaceRoot];
	const records = [];
	for (const path of queue) {
		signal?.throwIfAborted();
		if (queue.length > config.maxEntries) throw new Error("prepared workspace exceeds protectedTreeMaxEntries");
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1) throw new Error("prepared workspace contains a link or unsupported file");
		records.push(JSON.stringify([
			key$1(path),
			info.dev,
			info.ino,
			info.isDirectory(),
			info.nlink
		]));
		if (info.isDirectory()) for (const name of await readdir(path)) queue.push(win32.join(path, name));
	}
	return {
		identities: records.sort().join("\n"),
		aclPaths: [
			...windowsAncestors(config.workspaceRoot),
			config.workspaceRoot,
			...queue.filter((path) => config.protectedWriteRoots.some((root) => within$3(path, root)))
		]
	};
}
/** Inspect an existing workspace before public CLI refresh; this function never repairs ACLs.
* @param config - prepared roots, actual cwd and bounded complete-tree allowance.
* @param timeoutMs - maximum time for the read-only ACL subprocess.
* @param signal - cancellation of scanning and the owned subprocess.
* @returns after filesystem identities, registry SID and complete ACL observations are admitted.
*/
async function inspectPreparedProtectedTree(config, timeoutMs, signal) {
	const before = await scanTree(config, signal);
	const registry = win32.join(config.codexHome, "cap_sid");
	const info = await lstat(registry);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("prepared capability registry is not a single regular file");
	const registryText = await readFile(registry, "utf8");
	const capability = preparedWriteCapability(JSON.parse(registryText), config);
	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	if (systemRoot === void 0) throw new Error("Windows system directory is unavailable");
	const env = { DAO_PREPARED_TREE: JSON.stringify(config) };
	for (const [name, value] of Object.entries(process.env)) if (/^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC)$/iu.test(name)) env[name] = value;
	const result = await runFile$3(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(PREPARED_TREE_ACL_READ, "utf16le").toString("base64")
	], {
		env,
		signal,
		timeout: timeoutMs,
		maxBuffer: (config.maxEntries + 32) * 4096,
		windowsHide: true,
		encoding: "utf8"
	});
	validatePreparedTreeAcls(JSON.parse(result.stdout), config, capability, before.aclPaths);
	if (registryText !== await readFile(registry, "utf8")) throw new Error("prepared capability registry changed during ACL admission");
	if (before.identities !== (await scanTree(config, signal)).identities) throw new Error("prepared workspace identities changed during ACL admission");
}
//#endregion
//#region lib/types/windows-full-access.js
/** Inspect explicit volume grants and protected trees; this does not establish the complete Windows trusted code inventory. */
const runFile$2 = promisify(execFile);
const key = (path) => win32.normalize(path).toLowerCase();
const within$2 = (path, root) => key(path) === key(root) || key(path).startsWith(`${key(root).replace(/\\$/u, "")}\\`);
const MUTATION = 852310;
const ANCESTOR_DENY = 852032;
const WRITE_ALLOW = 1245631;
const SID = /^S-1-5-21-(?:\d+-){3}\d+$/u;
const VOLUME = /^\\\\\?\\Volume\{[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\}\\$/iu;
function fail$1(message) {
	throw new Error(`Windows full-access admission: ${message}`);
}
function object(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fail$1("malformed observation");
	return value;
}
function array(value) {
	if (!Array.isArray(value)) return fail$1("malformed array");
	return value;
}
function string$1(value) {
	if (typeof value !== "string" || value === "") return fail$1("malformed string");
	return value;
}
function number(value) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4294967295) return fail$1("malformed unsigned integer");
	return value;
}
function boolean(value) {
	if (typeof value !== "boolean") return fail$1("malformed boolean");
	return value;
}
function plain(path) {
	return /^[a-z]:\\/iu.test(path) && !/[\x00-\x1f<>:"|?*/]/u.test(path.slice(2)) && path.split("\\").slice(1).every((part) => part !== "." && part !== ".." && !/[ .]$/u.test(part));
}
function roots(config) {
	return [...new Map([...config.protectedWriteRoots, ...config.fullAccess.infrastructureRoots].map((path) => [key(path), path])).values()];
}
function mask(ace) {
	let bits = ace.mask;
	if (bits & 2147483648) bits |= 1179785;
	if (bits & 1073741824) bits |= 1179926;
	if (bits & 536870912) bits |= 1179808;
	if (bits & 268435456) bits |= 2032127;
	return bits & 268435455;
}
/** Validate configured local placement before any native inspection or temporary file creation.
* @param config - explicit volume inventory and existing protected directory placement.
* @returns after rejecting aliases, ambiguous inventories, overlapping execution and unprotected private state.
*/
function validateWindowsFullAccessConfig(config) {
	const volumes = config.fullAccess.volumes;
	if (volumes.length === 0 || config.protectedWriteRoots.length === 0 || config.executionRoots.length === 0 || !Number.isSafeInteger(config.protectedTreeMaxEntries) || config.protectedTreeMaxEntries <= 0) fail$1("empty roots or invalid entry limit");
	const letters = /* @__PURE__ */ new Set(), names = /* @__PURE__ */ new Set(), mounts = /* @__PURE__ */ new Set();
	for (const volume of volumes) {
		if (!/^[a-z]:\\$/iu.test(volume.root) || !VOLUME.test(volume.volumeName) || !Number.isInteger(volume.serialNumber) || volume.serialNumber < 0 || volume.serialNumber > 4294967295 || letters.has(key(volume.root)) || names.has(volume.volumeName.toLowerCase()) || !volume.mountPaths.some((path) => key(path) === key(volume.root))) fail$1("invalid or duplicate volume inventory");
		letters.add(key(volume.root));
		names.add(volume.volumeName.toLowerCase());
		for (const path of volume.mountPaths) {
			if (!plain(path) || !path.endsWith("\\") || mounts.has(key(path))) fail$1("invalid or duplicate volume mount");
			mounts.add(key(path));
		}
	}
	if ([
		config.workspaceRoot,
		config.codexHome,
		...roots(config),
		...config.executionRoots
	].some((path) => !plain(path) || !volumes.some((volume) => within$2(path, volume.root)))) fail$1("path is outside the initialized local volumes");
	if (roots(config).some((path) => volumes.some((volume) => key(path) === key(volume.root)))) fail$1("a volume cannot be a protected tree");
	if (!config.fullAccess.infrastructureRoots.some((root) => within$2(config.codexHome, root))) fail$1("Codex home is not protected infrastructure");
	if (config.executionRoots.some((path) => volumes.some((volume) => key(path) === key(volume.root)) || roots(config).some((root) => within$2(path, root)))) fail$1("execution directory is a volume root or protected directory");
}
function capabilities(value, config) {
	const entries = object(object(value).writable_root_by_path);
	const result = config.fullAccess.volumes.map((volume) => {
		const matches = Object.entries(entries).filter(([path]) => key(path.replace(/^\\\\\?\\/u, "")) === key(volume.root));
		if (matches.length !== 1 || matches[0] === void 0 || !SID.test(string$1(matches[0][1]))) return fail$1("missing or ambiguous volume capability");
		return string$1(matches[0][1]);
	});
	if (new Set(result).size !== result.length) fail$1("volume capabilities are not distinct");
	return result;
}
function descriptor(value) {
	const row = object(value);
	return {
		path: string$1(row.path),
		directory: boolean(row.directory),
		owner: string$1(row.owner),
		canonical: boolean(row.canonical),
		aces: array(row.aces).map((value) => {
			const ace = object(value);
			return {
				type: number(ace.type),
				sid: string$1(ace.sid),
				mask: number(ace.mask),
				flags: number(ace.flags)
			};
		})
	};
}
function validateObservation(input, config, caps, expectedPaths) {
	const snapshot = object(input);
	if (snapshot.ok !== true) fail$1(typeof snapshot.code === "string" && /^FULL_ACCESS_[A-Z_]+$/u.test(snapshot.code) ? snapshot.code : "native collector failed");
	const group = string$1(snapshot.sandboxGroupSid), host = string$1(snapshot.hostSid), users = array(snapshot.sandboxSids).map(string$1);
	if (!SID.test(group) || users.length !== 2 || !users.every((sid) => SID.test(sid)) || new Set([
		group,
		host,
		...users,
		...caps
	]).size !== 4 + caps.length) fail$1("account identities overlap");
	const trusted = new Set([
		host,
		"S-1-5-18",
		"S-1-5-32-544"
	]);
	const actualVolumes = array(snapshot.volumes).map((value) => {
		const row = object(value);
		return {
			volumeName: string$1(row.volumeName),
			serialNumber: number(row.serialNumber),
			fileSystem: string$1(row.fileSystem),
			driveType: number(row.driveType),
			mountPaths: array(row.mountPaths).map(string$1)
		};
	}).filter((volume) => volume.driveType === 3 && volume.mountPaths.length > 0);
	if (actualVolumes.length !== config.fullAccess.volumes.length) fail$1("mounted fixed volume inventory changed");
	for (const expected of config.fullAccess.volumes) {
		const matches = actualVolumes.filter((volume) => volume.volumeName.toLowerCase() === expected.volumeName.toLowerCase());
		if (matches.length !== 1 || matches[0] === void 0 || matches[0].serialNumber !== expected.serialNumber || matches[0].fileSystem.toUpperCase() !== "NTFS" || JSON.stringify(matches[0].mountPaths.map(key).sort()) !== JSON.stringify(expected.mountPaths.map(key).sort())) fail$1("volume identity or mount paths changed");
	}
	const drives = array(snapshot.fixedDrives).map((value) => {
		const row = object(value);
		return {
			root: string$1(row.root),
			volumeName: string$1(row.volumeName)
		};
	});
	const expectedDrives = config.fullAccess.volumes.flatMap((volume) => volume.mountPaths.filter((path) => /^[a-z]:\\$/iu.test(path)).map((root) => `${key(root)}=${volume.volumeName.toLowerCase()}`)).sort();
	if (JSON.stringify(drives.map((drive) => `${key(drive.root)}=${drive.volumeName.toLowerCase()}`).sort()) !== JSON.stringify(expectedDrives)) fail$1("fixed drive mapping changed");
	const entries = array(snapshot.entries).map(descriptor), byPath = new Map(entries.map((entry) => [key(entry.path), entry]));
	if (byPath.size !== entries.length || byPath.size !== expectedPaths.length || expectedPaths.some((path) => !byPath.has(key(path)))) fail$1("descriptor enumeration is incomplete");
	const protectedRoots = roots(config), ancestorPaths = new Set(protectedRoots.flatMap(windowsAncestors).map(key));
	for (const volume of config.fullAccess.volumes) {
		const entry = byPath.get(key(volume.root)), cap = caps[config.fullAccess.volumes.indexOf(volume)];
		if (entry === void 0 || !entry.directory || cap === void 0) fail$1("volume root descriptor missing");
		for (const sid of [group, cap]) if (!entry.aces.some((ace) => ace.type === 0 && ace.sid === sid && ace.flags === 3 && mask(ace) === WRITE_ALLOW)) fail$1("volume grant would require refresh");
	}
	for (const entry of entries) {
		if (!entry.canonical || entry.aces.length === 0 || entry.aces.some((ace) => ![0, 1].includes(ace.type) || (ace.flags & -32) !== 0)) fail$1("unsupported ACL");
		const protectedEntry = protectedRoots.some((root) => within$2(entry.path, root));
		const ancestor = ancestorPaths.has(key(entry.path));
		if (!protectedEntry && !ancestor) continue;
		if (!trusted.has(entry.owner)) fail$1("protected object or ancestor has an untrusted owner");
		const required = protectedEntry ? MUTATION : ANCESTOR_DENY;
		for (const sid of [group, ...caps]) {
			const denies = entry.aces.filter((ace) => ace.type === 1 && ace.sid === sid);
			if (!denies.some((ace) => !(ace.flags & 8) && (mask(ace) & required) === required) || protectedEntry && entry.directory && !denies.some((ace) => (ace.flags & 3) === 3 && !(ace.flags & 4) && (mask(ace) & required) === required) || ancestor && !protectedEntry && !denies.some((ace) => ace.flags === 0 && (mask(ace) & required) === required)) fail$1("complete protected or ancestor denial is missing");
		}
		for (const ace of entry.aces) {
			if (ace.type !== 0 || ace.flags & 8 || trusted.has(ace.sid)) continue;
			if (entry.directory && mask(ace) & 64) fail$1("directory grants untrusted delete-child rights");
			if (mask(ace) & 786432) fail$1("untrusted ACL or owner modification grant");
			if (protectedEntry && !(ace.flags & 16) && mask(ace) & MUTATION) fail$1("protected explicit write allow can precede inherited denial");
		}
	}
}
async function scan(config, temp, signal) {
	const paths = /* @__PURE__ */ new Map();
	for (const path of [
		...roots(config),
		config.workspaceRoot,
		...config.executionRoots,
		temp
	]) {
		paths.set(key(path), path);
		for (const parent of windowsAncestors(path)) paths.set(key(parent), parent);
	}
	for (const volume of config.fullAccess.volumes) paths.set(key(volume.root), volume.root);
	const queue = [...roots(config)], seen = /* @__PURE__ */ new Set();
	for (const path of queue) {
		signal?.throwIfAborted();
		if (seen.has(key(path))) continue;
		seen.add(key(path));
		paths.set(key(path), path);
		if (paths.size > config.protectedTreeMaxEntries) fail$1("protectedTreeMaxEntries exceeded");
		const info = await lstat(path, { bigint: true });
		if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1n) fail$1("protected tree contains a link or unsupported entry");
		if (info.isDirectory() && key(path) !== key(temp)) for (const name of await readdir(path)) queue.push(win32.join(path, name));
	}
	const records = [];
	if (paths.size > config.protectedTreeMaxEntries) fail$1("protectedTreeMaxEntries exceeded");
	for (const path of [...paths.values()].sort((a, b) => key(a).localeCompare(key(b)))) {
		signal?.throwIfAborted();
		const info = await lstat(path, { bigint: true });
		if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1n) fail$1("observed path contains a link or unsupported entry");
		records.push(JSON.stringify([
			key(path),
			String(info.dev),
			String(info.ino),
			info.isDirectory(),
			String(info.nlink)
		]));
	}
	return {
		identities: records.join("\n"),
		paths: [...paths.values()]
	};
}
/** Inspect fixed volumes, protected files and ancestors before starting the public CLI.
* @param config - already initialized profile placement; no missing infrastructure is created.
* @param actualCwd - exact consumer execution directory, excluding volume roots and protected directories.
* @param timeoutMs - deadline for the native collector; cancellation also stops pending scans.
* @param signal - aborts observation and the owned PowerShell subprocess.
* @returns after stable filesystem identities, capability registry, volume mappings and complete ACLs are admitted.
* @remarks Only private compiler temporary files are created; ACLs and configuration are never repaired.
* Unknown child exit retains the temporary directory. This inspection alone does not authorize activation
* or establish the complete Windows trusted code inventory.
*/
async function inspectWindowsFullAccess(config, actualCwd, timeoutMs, signal) {
	validateWindowsFullAccessConfig(config);
	signal?.throwIfAborted();
	if (!plain(actualCwd) || !config.executionRoots.some((path) => key(path) === key(actualCwd))) fail$1("actual cwd is not explicitly admitted");
	for (const path of [config.codexHome, ...windowsAncestors(config.codexHome)]) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.isSymbolicLink()) fail$1("private compiler parent is missing or redirected");
	}
	const registry = win32.join(config.codexHome, "cap_sid"), registryInfo = await lstat(registry);
	if (!registryInfo.isFile() || registryInfo.isSymbolicLink() || registryInfo.nlink !== 1 || registryInfo.size > 1048576) fail$1("capability registry is not a bounded regular file");
	const registryText = await readFile(registry, "utf8"), caps = capabilities(JSON.parse(registryText), config);
	const temp = await mkdtemp(win32.join(config.codexHome, ".full-access-inspect-"));
	const tempIdentity = await lstat(temp, { bigint: true });
	let failure;
	const lifecycle = { cleanupSafe: true };
	try {
		const before = await scan(config, temp, signal);
		const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
		if (systemRoot === void 0 || !plain(systemRoot)) fail$1("Windows system directory is unavailable");
		const env = {
			DAO_FULL_ACCESS: JSON.stringify({
				roots: roots(config),
				anchors: [
					config.workspaceRoot,
					...config.executionRoots,
					...config.fullAccess.volumes.map((volume) => volume.root)
				],
				temp,
				caps,
				maxEntries: config.protectedTreeMaxEntries
			}),
			TEMP: temp,
			TMP: temp
		};
		for (const [name, value] of Object.entries(process.env)) if (/^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/iu.test(name)) env[name] = value;
		if (Object.entries(env).reduce((size, [name, value]) => size + name.length + (value?.length ?? 0) + 2, 1) >= 32767) fail$1("native collector environment exceeds Windows limit");
		let output;
		try {
			lifecycle.cleanupSafe = false;
			output = (await runFile$2(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(NATIVE_READ, "utf16le").toString("base64")
			], {
				env,
				signal,
				timeout: timeoutMs,
				maxBuffer: (config.protectedTreeMaxEntries + 64) * 4096,
				windowsHide: true,
				encoding: "utf8"
			})).stdout;
			lifecycle.cleanupSafe = true;
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if (error instanceof Error && "code" in error && error.code === 2 && "stdout" in error && typeof error.stdout === "string" && error.stdout.startsWith("{")) {
				output = error.stdout;
				lifecycle.cleanupSafe = true;
			} else fail$1("native collector did not complete; owned compiler directory retained");
		}
		validateObservation(JSON.parse(output), config, caps, before.paths);
		if (registryText !== await readFile(registry, "utf8")) fail$1("capability registry changed during inspection");
		if (before.identities !== (await scan(config, temp, signal)).identities) fail$1("filesystem identities changed during inspection");
	} catch (error) {
		failure = error;
	}
	if (!lifecycle.cleanupSafe) throw new Error("Windows full-access native collector did not complete; owned compiler directory retained", { cause: failure });
	try {
		const info = await lstat(temp, { bigint: true });
		if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== tempIdentity.dev || info.ino !== tempIdentity.ino) fail$1("owned compiler directory changed identity");
		await rm(temp, { recursive: true });
	} catch (error) {
		if (failure !== void 0) throw new AggregateError([failure, error], "Windows full-access admission and compiler cleanup failed");
		throw error;
	}
	if (failure instanceof Error) throw failure;
	if (failure !== void 0) throw new Error("Windows full-access inspection failed", { cause: failure });
}
const NATIVE_READ = String.raw`
$ErrorActionPreference='Stop';Set-StrictMode -Version 2.0
$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
$settings=$env:DAO_FULL_ACCESS | ConvertFrom-Json
$group=(Get-LocalGroup -Name CodexSandboxUsers -ErrorAction Stop).SID.Value
$users=@((Get-LocalUser -Name CodexSandboxOnline -ErrorAction Stop).SID.Value,(Get-LocalUser -Name CodexSandboxOffline -ErrorAction Stop).SID.Value)
$hostSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Read-AclRow([string]$path) {
  $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'FULL_ACCESS_REPARSE'}
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  $raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0)
  $aces=New-Object 'Collections.Generic.List[object]'
  if ($null -eq $raw.DiscretionaryAcl) {throw 'FULL_ACCESS_NULL_DACL'}
  foreach ($ace in $raw.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback) {throw 'FULL_ACCESS_COMPLEX_ACE'}
    $aces.Add([ordered]@{type=[int]$ace.AceType;sid=$ace.SecurityIdentifier.Value;mask=[uint64][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$ace.AccessMask),0);flags=[int]$ace.AceFlags})
  }
  return [ordered]@{path=$item.FullName;directory=[bool]$item.PSIsContainer;owner=$raw.Owner.Value;canonical=[bool]$acl.AreAccessRulesCanonical;sddl=$acl.Sddl;aces=$aces.ToArray()}
}
$private=Read-AclRow $settings.temp
if (-not $private.directory -or -not $private.canonical -or $private.owner -notin @($hostSid,'S-1-5-18','S-1-5-32-544')) {throw 'FULL_ACCESS_COMPILER_NOT_PRIVATE'}
foreach ($sid in @($group)+@($settings.caps)) {
  if (@($private.aces | Where-Object {$_.type -eq 1 -and $_.sid -ceq $sid -and ($_.flags -band 8) -eq 0 -and ($_.mask -band 0xd0156) -eq 0xd0156}).Count -eq 0) {throw 'FULL_ACCESS_COMPILER_NOT_PRIVATE'}
}
foreach ($ace in $private.aces) {if ($ace.type -eq 0 -and ($ace.flags -band 24) -eq 0 -and $ace.sid -notin @($hostSid,'S-1-5-18','S-1-5-32-544') -and ($ace.mask -band 0x500d0156) -ne 0) {throw 'FULL_ACCESS_COMPILER_NOT_PRIVATE'}}
$compiler=New-Object CodeDom.Compiler.CompilerParameters
$compiler.GenerateInMemory=$true;$compiler.TempFiles=[CodeDom.Compiler.TempFileCollection]::new([string]$settings.temp,$false)
Add-Type -CompilerParameters $compiler -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;using System.ComponentModel;
public static class DaoVolumeRead {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr FindFirstVolumeW(StringBuilder name,uint length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool FindNextVolumeW(IntPtr handle,StringBuilder name,uint length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FindVolumeClose(IntPtr handle);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumePathNamesForVolumeNameW(string name,[Out] char[] paths,uint length,out uint needed);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationW(string root,StringBuilder label,uint length,out uint serial,out uint component,out uint flags,StringBuilder fs,uint fsLength);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern uint GetDriveTypeW(string root);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeNameForVolumeMountPointW(string root,StringBuilder name,uint length);
 public static string Name(string root){var s=new StringBuilder(1024);if(!GetVolumeNameForVolumeMountPointW(root,s,1024))throw new Win32Exception();return s.ToString();}
 public static string[] Names(){var rows=new List<string>();var s=new StringBuilder(1024);var h=FindFirstVolumeW(s,1024);if(h==new IntPtr(-1))throw new Win32Exception();try{do{rows.Add(s.ToString());}while(FindNextVolumeW(h,s,1024));if(Marshal.GetLastWin32Error()!=18)throw new Win32Exception();}finally{FindVolumeClose(h);}return rows.ToArray();}
 public static string[] Paths(string name){uint needed;var p=new char[32768];if(!GetVolumePathNamesForVolumeNameW(name,p,(uint)p.Length,out needed))throw new Win32Exception();return new string(p).Split(new char[]{'\0'},StringSplitOptions.RemoveEmptyEntries);}
 public static string[] Info(string name){uint serial,component,flags;var label=new StringBuilder(1024);var fs=new StringBuilder(1024);if(!GetVolumeInformationW(name,label,1024,out serial,out component,out flags,fs,1024))throw new Win32Exception();return new string[]{serial.ToString(System.Globalization.CultureInfo.InvariantCulture),fs.ToString()};}
}
'@
function Snapshot {
  $volumes=New-Object 'Collections.Generic.List[object]';$drives=New-Object 'Collections.Generic.List[object]'
  foreach ($name in @([DaoVolumeRead]::Names() | Sort-Object)) {
    $type=[DaoVolumeRead]::GetDriveTypeW($name);$paths=@([DaoVolumeRead]::Paths($name) | Sort-Object)
    if ($type -ne 3 -or $paths.Count -eq 0) {continue}
    $info=[DaoVolumeRead]::Info($name)
    $volumes.Add([ordered]@{volumeName=$name;serialNumber=[uint64]$info[0];fileSystem=$info[1];driveType=$type;mountPaths=$paths})
  }
  foreach ($drive in @([IO.Directory]::GetLogicalDrives() | Sort-Object)) {if ([DaoVolumeRead]::GetDriveTypeW($drive) -eq 3) {$drives.Add([ordered]@{root=$drive;volumeName=[DaoVolumeRead]::Name($drive)})}}
  $all=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($anchor in @($settings.roots)+@($settings.anchors)+@($settings.temp)) {
    $current=[IO.Path]::GetFullPath([string]$anchor)
    while ($null -ne $current) {$null=$all.Add($current);$parent=[IO.Directory]::GetParent($current);if ($null -eq $parent) {break};$current=$parent.FullName}
  }
  $queue=New-Object 'Collections.Generic.Queue[string]';$visited=New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($root in $settings.roots) {$queue.Enqueue([string]$root)}
  while ($queue.Count -gt 0) {
    $path=$queue.Dequeue();if (-not $visited.Add($path)) {continue};$null=$all.Add($path)
    if ($all.Count -gt $settings.maxEntries) {throw 'FULL_ACCESS_ENTRY_LIMIT'}
    $item=Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {throw 'FULL_ACCESS_REPARSE'}
    if ($item.PSIsContainer -and $item.FullName -ine $settings.temp) {foreach ($child in Get-ChildItem -LiteralPath $path -Force -ErrorAction Stop) {$queue.Enqueue($child.FullName)}}
  }
  if ($all.Count -gt $settings.maxEntries) {throw 'FULL_ACCESS_ENTRY_LIMIT'}
  $records=New-Object 'Collections.Generic.List[object]'
  foreach ($path in @($all | Sort-Object)) {$records.Add((Read-AclRow $path))}
  return [ordered]@{ok=$true;hostSid=$hostSid;sandboxSids=$users;sandboxGroupSid=$group;volumes=$volumes.ToArray();fixedDrives=$drives.ToArray();entries=$records.ToArray()}
}
$before=Snapshot | ConvertTo-Json -Depth 10 -Compress
$after=Snapshot | ConvertTo-Json -Depth 10 -Compress
if ($before -cne $after) {throw 'FULL_ACCESS_ACL_OR_VOLUME_CHANGED'}
$after
} catch {
  $code='FULL_ACCESS_NATIVE_QUERY_FAILED';$match=[regex]::Match($_.Exception.Message,'FULL_ACCESS_[A-Z_]+');if ($match.Success) {$code=$match.Value}
  @{ok=$false;code=$code;line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json -Compress
  exit 2
}
`;
//#endregion
//#region lib/types/windows-prepared.js
/** Admission and public-CLI invocation for an operator-prepared Windows permission profile. */
const EXECUTABLE_SHA256 = "d4b2e6a054ea1dfe53217f9d8942c5f8a9f4b76171a1e0bb76ced5759915300a";
const RUNNER_SHA256 = "8f1a9d4217a34d6b44df81c25999ff9b98bb8d0e3c179aa070fcd84b3ce7a9d3";
const SETUP_SHA256 = "a39f42dc697919e650cd24f82daaecd6121e41e3f4d56373fef4f4177f8eee02";
const runFile$1 = promisify(execFile);
const ACL_CHECK = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
${PREPARED_SYSTEM_ROOT_CHECK}
$programData=$env:DAO_SANDBOX_PROGRAM_DATA
$actualProgramData=[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData,[Environment+SpecialFolderOption]::DoNotVerify)
if ([string]::IsNullOrWhiteSpace($programData) -or $programData -notmatch '^[A-Za-z]:\\\\' -or
  [string]::IsNullOrWhiteSpace($actualProgramData) -or $actualProgramData -notmatch '^[A-Za-z]:\\\\' -or
  [IO.Path]::GetFullPath($actualProgramData).TrimEnd('\\') -ine [IO.Path]::GetFullPath($programData).TrimEnd('\\') -or
  @($systemRoots | Where-Object { $_.path.TrimEnd('\\') -ieq $programData.TrimEnd('\\') }).Count -ne 1) {
  throw 'UNADMITTED_PROGRAM_DATA_DIRECTORY'
}
$managedRoot=Join-Path $programData 'OpenAI\\Codex'
foreach($name in @('config.toml','requirements.toml')) {
  if (Test-Path -LiteralPath (Join-Path $managedRoot $name)) { throw 'UNADMITTED_MANAGED_CONFIGURATION' }
}
$machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
try {
  $policy=$machine.OpenSubKey('SOFTWARE\\Policies\\OpenAI\\Codex')
  if ($null -ne $policy) {
    try { if ($null -ne $policy.GetValue('RequirementsPath')) { throw 'UNADMITTED_MANAGED_CONFIGURATION' } }
    finally { $policy.Dispose() }
  }
} finally { $machine.Dispose() }
$paths=ConvertFrom-Json $env:DAO_SANDBOX_ADMITTED_ACL_PATHS
foreach($entry in $paths) {
  if ((Get-Acl -LiteralPath $entry.path).Sddl -cne $entry.sddl) { throw 'PREPARED_ACL_CHANGED' }
}
foreach($name in @('CodexSandboxOnline','CodexSandboxOffline')) {
  $user=Get-LocalUser -Name $name
  if (!$user.Enabled -or ($null -ne $user.PasswordExpires -and $user.PasswordExpires -le [DateTime]::Now)) {
    throw 'PREPARED_ACCOUNT_UNAVAILABLE'
  }
}
[Console]::Write('PREPARED_ACL_AND_ACCOUNTS_MATCH')
`;
function pathKey$1(path) {
	return win32.normalize(path).replace(/[\\]+$/u, "").toLowerCase();
}
function admittedProgramData(config) {
	const roots = config.systemReadRoots.filter((root) => pathKey$1(root.path) === "c:\\programdata");
	const programData = roots[0]?.path;
	if (roots.length !== 1 || programData === void 0 || !/^[A-Za-z]:\\/u.test(programData)) throw new Error("prepared Windows ProgramData directory is unavailable");
	for (const [name, value] of Object.entries(process.env)) if (name.toLowerCase() === "programdata" && (value === void 0 || !/^[A-Za-z]:\\/u.test(value) || pathKey$1(value) !== pathKey$1(programData))) throw new Error("Windows ProgramData environment differs from the admitted directory");
	return programData;
}
function admissionProcessFailure(error) {
	let exit = "unavailable";
	let stderr = "";
	if (typeof error === "object" && error !== null) {
		if ("code" in error && (typeof error.code === "number" || typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code))) exit = String(error.code);
		if ("stderr" in error && typeof error.stderr === "string") stderr = error.stderr.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim().slice(0, 1024);
	}
	return /* @__PURE__ */ new Error(`prepared Windows ACL/account inspection failed (exit ${exit})${stderr === "" ? "" : `: ${stderr}`}`);
}
function within$1(path, root) {
	const rel = win32.relative(root, path);
	return rel === "" || !win32.isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\");
}
function samePaths(actual, expected) {
	return JSON.stringify(actual.map(pathKey$1).sort()) === JSON.stringify(expected.map(pathKey$1).sort());
}
/**
* Reject policy or placement drift before any filesystem or subprocess work.
* @param config - operator-approved fixed profile and roots.
* @param policy - actual requested mode and roots.
* @param execution - actual consumer spawn cwd.
* @returns the admitted working directory.
*/
function admitPreparedPolicy(config, policy, execution) {
	const mode = config.fullAccess === void 0 ? "workspace-write" : "danger-full-access";
	if (policy.mode !== mode || pathKey$1(policy.workspaceRoot) !== pathKey$1(config.workspaceRoot) || !samePaths(policy.additionalWritableRoots ?? [], config.additionalWritableRoots) || !samePaths(policy.protectedWriteRoots ?? [], config.protectedWriteRoots)) throw new Error("prepared Windows permission profile does not match the requested policy");
	if (execution === void 0 || !win32.isAbsolute(execution.cwd) || !config.executionRoots.some((root) => config.fullAccess === void 0 ? within$1(execution.cwd, root) : pathKey$1(execution.cwd) === pathKey$1(root)) || [...config.protectedWriteRoots, ...config.fullAccess?.infrastructureRoots ?? []].some((root) => within$1(execution.cwd, root))) throw new Error("actual execution cwd is outside the prepared Windows profile");
	return execution.cwd;
}
/**
* Validate self-contained deployment configuration before the provider becomes available.
* @param config - one fixed, prepared Windows profile.
*/
function validatePreparedConfig(config) {
	validatePreparedSystemReadRoots(config.systemReadRoots);
	if (!Number.isSafeInteger(config.protectedTreeMaxEntries) || config.protectedTreeMaxEntries <= 0) throw new Error("windowsPreparedSandbox requires a positive protected-tree entry limit");
	const roots = [config.workspaceRoot, ...config.additionalWritableRoots];
	if ([
		config.executable,
		config.codexHome,
		...roots,
		...config.protectedWriteRoots,
		...config.executionRoots,
		config.userProfile,
		config.appData,
		config.localAppData,
		config.tempRoot
	].some((path) => !/^[A-Za-z]:\\/u.test(path) || /[\r\n]/u.test(path))) throw new Error("windowsPreparedSandbox paths must be absolute local Windows paths");
	if (!/^[A-Za-z0-9_-]+$/u.test(config.profile) || ![config.configSha256, config.setupMarkerSha256].every((hash) => /^[a-fA-F0-9]{64}$/u.test(hash))) throw new Error("windowsPreparedSandbox requires a profile name and SHA-256 fingerprints");
	if (config.fullAccess !== void 0) {
		validateWindowsFullAccessConfig({
			...config,
			fullAccess: config.fullAccess
		});
		if (!config.fullAccess.infrastructureRoots.some((root) => within$1(config.executable, root)) || !config.fullAccess.infrastructureRoots.some((root) => within$1(config.codexHome, root)) || [...config.protectedWriteRoots, ...config.fullAccess.infrastructureRoots].some((root) => within$1(config.tempRoot, root))) throw new Error("prepared Windows full access requires protected executable and private runtime state");
	} else if (config.additionalWritableRoots.length !== 0 || config.protectedWriteRoots.some((root) => pathKey$1(win32.dirname(root)) !== pathKey$1(config.workspaceRoot)) || config.protectedWriteRoots.some((root) => within$1(config.tempRoot, root) || config.executionRoots.some((path) => within$1(path, root)))) throw new Error("prepared Windows support requires one writable root with direct-child protected directories and separate cwd/temp");
	const writableRoots = config.fullAccess?.volumes.map((volume) => volume.root) ?? roots;
	if (config.protectedWriteRoots.length === 0 || config.executionRoots.length === 0 || config.executionRoots.some((path) => !writableRoots.some((root) => within$1(path, root))) || !writableRoots.some((root) => within$1(config.tempRoot, root)) || config.fullAccess === void 0 && roots.some((root) => within$1(config.codexHome, root) || within$1(config.executable, root))) throw new Error("windowsPreparedSandbox requires protected roots, admitted cwd/temp, and private runtime state");
	if (win32.basename(config.executable).toLowerCase() !== "codex.exe" || win32.basename(win32.dirname(config.executable)).toLowerCase() !== "bin") throw new Error("windowsPreparedSandbox requires the official bin/codex.exe package layout");
	const required = [
		config.codexHome,
		win32.join(config.codexHome, "config.toml"),
		win32.join(config.codexHome, "cap_sid"),
		win32.join(config.codexHome, ".sandbox"),
		win32.join(config.codexHome, ".sandbox", "setup_marker.json"),
		win32.join(config.codexHome, ".sandbox-secrets"),
		win32.join(config.codexHome, ".sandbox-secrets", "sandbox_users.json"),
		win32.join(config.codexHome, ".sandbox-bin"),
		win32.join(config.codexHome, ".sandbox-bin", "codex-command-runner-0.165.0.exe")
	];
	if (!samePaths(config.admittedAcls.map((entry) => entry.path), required) || config.admittedAcls.some((entry) => entry.sddl.length === 0) || !Number.isSafeInteger(config.credentialsFile.bytes) || config.credentialsFile.bytes <= 0 || !Number.isFinite(config.credentialsFile.mtimeMs) || config.credentialsFile.mtimeMs <= 0) throw new Error("windowsPreparedSandbox requires exact private-state ACLs and credential-file metadata");
}
async function noLinks(path, directory) {
	let current = path;
	let leaf = true;
	for (;;) {
		const info = await lstat(current);
		if (info.isSymbolicLink() || (leaf ? directory ? !info.isDirectory() : !info.isFile() : !info.isDirectory())) throw new Error("prepared Windows path is missing, redirected, or has an unexpected file type");
		const parent = win32.dirname(current);
		if (parent === current) break;
		current = parent;
		leaf = false;
	}
}
async function sha256(path, signal) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal })) {
		if (!Buffer.isBuffer(chunk)) throw new Error("prepared binary stream returned a non-buffer chunk");
		hash.update(chunk);
	}
	return hash.digest("hex");
}
/**
* Check fixed preparation metadata and return the public CLI argv; never falls back to another runner.
* The CLI still refreshes approved ACLs and can repair its own account state at execution time.
* @param config - reviewed profile, roots, binary, and private-state fingerprints.
* @param argv - exact child program and arguments.
* @param policy - actual requested file policy.
* @param execution - actual consumer working directory.
* @param timeoutMs - bound for the read-only ACL/account admission subprocess.
* @param signal - cancellation for admission reads and the read-only subprocess.
* @returns stdio-only confinement with provider-owned environment values.
*/
async function prepareWindowsSandbox(config, argv, policy, execution, timeoutMs, signal) {
	try {
		signal?.throwIfAborted();
		const cwd = admitPreparedPolicy(config, policy, execution);
		for (const path of [
			config.workspaceRoot,
			...config.additionalWritableRoots,
			...config.protectedWriteRoots,
			...config.fullAccess?.volumes.map((volume) => volume.root) ?? [],
			...config.fullAccess?.infrastructureRoots ?? [],
			...config.executionRoots,
			cwd,
			config.userProfile,
			config.appData,
			config.localAppData,
			config.tempRoot
		]) await noLinks(path, true);
		for (const entry of config.admittedAcls) await noLinks(entry.path, [
			config.codexHome,
			win32.join(config.codexHome, ".sandbox"),
			win32.join(config.codexHome, ".sandbox-secrets"),
			win32.join(config.codexHome, ".sandbox-bin")
		].some((path) => pathKey$1(path) === pathKey$1(entry.path)));
		await noLinks(config.executable, false);
		const bin = win32.dirname(config.executable);
		const resources = win32.join(win32.dirname(bin), "codex-resources");
		const helpers = [{
			name: "codex-command-runner.exe",
			sha256: RUNNER_SHA256,
			bytes: 8748848
		}, {
			name: "codex-windows-sandbox-setup.exe",
			sha256: SETUP_SHA256,
			bytes: 18794288
		}];
		for (const helper of helpers) try {
			await lstat(win32.join(bin, helper.name));
			throw new Error("unadmitted sibling sandbox helper shadows the official package resource");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		const helperFiles = helpers.map((helper) => ({
			...helper,
			path: win32.join(resources, helper.name)
		}));
		helperFiles.push({
			name: "cached runner",
			path: win32.join(config.codexHome, ".sandbox-bin", "codex-command-runner-0.165.0.exe"),
			sha256: RUNNER_SHA256,
			bytes: 8748848
		});
		for (const helper of helperFiles) {
			await noLinks(helper.path, false);
			if ((await lstat(helper.path)).size !== helper.bytes || await sha256(helper.path, signal) !== helper.sha256) throw new Error("prepared Windows sandbox helper differs from the pinned official package");
		}
		for (let ancestor = cwd;;) {
			try {
				await lstat(win32.join(ancestor, ".codex", "config.toml"));
				throw new Error("project Codex configuration is not admitted by the prepared profile");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
			const parent = win32.dirname(ancestor);
			if (parent === ancestor) break;
			ancestor = parent;
		}
		const markerPath = win32.join(config.codexHome, ".sandbox", "setup_marker.json");
		const credentials = await lstat(win32.join(config.codexHome, ".sandbox-secrets", "sandbox_users.json"));
		if (credentials.size !== config.credentialsFile.bytes || Math.abs(credentials.mtimeMs - config.credentialsFile.mtimeMs) > 1) throw new Error("prepared Windows credential-file metadata changed");
		if (await sha256(config.executable, signal) !== EXECUTABLE_SHA256 || await sha256(win32.join(config.codexHome, "config.toml"), signal) !== config.configSha256.toLowerCase() || await sha256(markerPath, signal) !== config.setupMarkerSha256.toLowerCase()) throw new Error("prepared Windows executable, configuration, or setup marker changed");
		const marker = JSON.parse(await readFile(markerPath, "utf8"));
		if (typeof marker !== "object" || marker === null || !("version" in marker) || marker.version !== 5 || !("online_username" in marker) || marker.online_username !== "CodexSandboxOnline" || !("offline_username" in marker) || marker.offline_username !== "CodexSandboxOffline") throw new Error("prepared Windows setup marker is incompatible");
		const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
		if (systemRoot === void 0) throw new Error("Windows system directory is unavailable");
		const programData = admittedProgramData(config);
		const admissionEnv = {
			DAO_SANDBOX_ADMITTED_ACL_PATHS: JSON.stringify(config.admittedAcls),
			DAO_SANDBOX_SYSTEM_READ_ROOTS: JSON.stringify(config.systemReadRoots),
			DAO_SANDBOX_PROGRAM_DATA: programData
		};
		for (const [name, value] of Object.entries(process.env)) if (name.toLowerCase() === "programdata") admissionEnv.ProgramData = value;
		else if (/^(SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|PROGRAMFILES|PROGRAMFILES\(X86\))$/iu.test(name)) admissionEnv[name] = value;
		if ((await runFile$1(win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(ACL_CHECK, "utf16le").toString("base64")
		], {
			env: admissionEnv,
			signal,
			timeout: timeoutMs,
			maxBuffer: 64 * 1024,
			windowsHide: true,
			encoding: "utf8"
		}).catch((error) => {
			throw signal?.aborted ? error : admissionProcessFailure(error);
		})).stdout !== "PREPARED_ACL_AND_ACCOUNTS_MATCH") throw new Error("prepared Windows ACL/account check did not complete");
		if (config.fullAccess === void 0) await inspectPreparedProtectedTree({
			workspaceRoot: config.workspaceRoot,
			protectedWriteRoots: config.protectedWriteRoots,
			codexHome: config.codexHome,
			cwd,
			maxEntries: config.protectedTreeMaxEntries
		}, timeoutMs, signal);
		else {
			await inspectWindowsFullAccess({
				...config,
				fullAccess: config.fullAccess
			}, cwd, timeoutMs, signal);
			throw new Error("Windows full-access execution is unavailable: protection of shared system code is not verified");
		}
		signal?.throwIfAborted();
		return {
			argv: [
				config.executable,
				"sandbox",
				"--include-managed-config",
				"--permission-profile",
				config.profile,
				"-C",
				cwd,
				"--",
				...argv
			],
			env: {
				CODEX_HOME: config.codexHome,
				USERPROFILE: config.userProfile,
				HOME: config.userProfile,
				APPDATA: config.appData,
				LOCALAPPDATA: config.localAppData,
				TEMP: config.tempRoot,
				TMP: config.tempRoot,
				CODEX_SQLITE_HOME: config.codexHome,
				CODEX_WINDOWS_SANDBOX_PROXY_PORTS: null,
				CODEX_NETWORK_ALLOW_LOCAL_BINDING: null,
				HTTP_PROXY: null,
				HTTPS_PROXY: null,
				ALL_PROXY: null,
				WS_PROXY: null,
				WSS_PROXY: null
			},
			transport: "stdio",
			enforcement: "partial",
			protectedWriteEnforcement: "full",
			denialSignatures: [
				"access is denied",
				"access to the path",
				"permission denied",
				"operation not permitted"
			],
			runnerFailureRules: [{ fatalSignatures: ["windows sandbox failed:"] }]
		};
	} catch (error) {
		if (signal?.aborted) throw error;
		const detail = error instanceof Error ? error.message : "prepared Windows admission failed";
		throw new SandboxUnavailableError(policy.mode, detail, (policy.protectedWriteRoots?.length ?? 0) > 0);
	}
}
//#endregion
//#region lib/types/windows-appcontainer-receipt.js
/** Strict parsing and request matching for private AppContainer preparation receipts. */
function fail(reason) {
	throw new Error(`AppContainer preparation: ${reason}`);
}
function record(value, keys) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("expected an object");
	const result = value;
	if (Object.keys(result).some((key) => !keys.includes(key))) fail("unknown receipt field");
	return result;
}
function string(value) {
	if (typeof value !== "string" || value.length === 0 || /[\u0000\r\n]/u.test(value)) fail("invalid text field");
	return value;
}
function hash(value) {
	const result = string(value);
	if (!/^[a-f0-9]{64}$/u.test(result)) fail("invalid SHA-256");
	return result;
}
function positive(value) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) fail("invalid positive entry bound");
	return value;
}
function sid(value) {
	const result = string(value);
	if (!/^S-1-(?:[0-9]+-)*[0-9]+$/u.test(result)) fail("invalid SID");
	return result;
}
function mode(value) {
	if (value !== "workspace-write") fail("unsupported mode: only workspace-write preparation is admitted");
	return value;
}
/** Accepts canonical local drive paths, excluding aliases, device names and alternate streams.
* @param value - Parsed JSON path or deployment configuration path.
* @returns The absolute Windows path, preserving its spelling.
*/
function appContainerPath(value) {
	const result = string(value);
	if (!/^[A-Za-z]:\\/u.test(result) || result.includes("/") || /[\u0000-\u001f<>"|?*]/u.test(result) || win32.normalize(result) !== result || result.slice(2).includes(":")) fail("expected a canonical local Windows path");
	const components = result.slice(3).split("\\");
	if (components.some((part, index) => part.length === 0 && !(components.length === 1 && index === 0) || /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))) fail("ambiguous Windows path component");
	return result;
}
function pathKey(path) {
	return path.toLowerCase();
}
function within(path, root) {
	return pathKey(path) === pathKey(root) || pathKey(path).startsWith(pathKey(root.endsWith("\\") ? root : `${root}\\`));
}
function paths(value) {
	if (!Array.isArray(value)) fail("expected a path array");
	const result = value.map(appContainerPath);
	if (new Set(result.map(pathKey)).size !== result.length) fail("duplicate paths");
	return result;
}
function volume(value) {
	const item = record(value, [
		"root",
		"volumeName",
		"serialNumber",
		"mountPaths"
	]);
	const root = appContainerPath(item.root), volumeName = string(item.volumeName);
	if (!/^[A-Za-z]:\\$/u.test(root) || !/^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\$/iu.test(volumeName)) fail("invalid volume identity");
	const serialNumber = item.serialNumber;
	if (typeof serialNumber !== "number" || !Number.isSafeInteger(serialNumber) || serialNumber < 0 || serialNumber > 4294967295) fail("invalid volume serial");
	const mountPaths = paths(item.mountPaths);
	if (mountPaths.length !== 1 || pathKey(mountPaths[0] ?? "") !== pathKey(root)) fail("volume aliases are unsupported");
	return {
		root,
		volumeName,
		serialNumber,
		mountPaths
	};
}
function anchor(value) {
	const item = record(value, [
		"path",
		"objectId",
		"kind",
		"sddl",
		"sha256"
	]);
	const path = appContainerPath(item.path), objectId = string(item.objectId), sddl = string(item.sddl);
	if (!/^[a-f0-9]{8}:[a-f0-9]{16}$/u.test(objectId)) fail("invalid file identity");
	if (item.kind !== "directory" && item.kind !== "file") fail("invalid anchor kind");
	const result = {
		path,
		objectId,
		kind: item.kind,
		sddl
	};
	if (item.sha256 !== void 0) {
		if (item.kind !== "file") fail("content hash requires a file");
		result.sha256 = hash(item.sha256);
	}
	return result;
}
/** Checks native executable deployment pins without touching the filesystem.
* @param config - Explicit native executable path and SHA-256.
*/
function validateWindowsNativeRunnerConfig(config) {
	appContainerPath(config.executable);
	hash(config.executableSha256);
}
/** Checks deployment pins without touching the filesystem.
* @param config - Explicit native executable and private receipt pins.
*/
function validateAppContainerConfig(config) {
	validateWindowsNativeRunnerConfig(config);
	appContainerPath(config.preparationReceipt);
	hash(config.preparationReceiptSha256);
	if (pathKey(config.executable) === pathKey(config.preparationReceipt)) fail("runner and receipt must be distinct files");
}
/** Parses a completed preparation record; acceptance still requires independent native ACL inspection.
* @param value - Untrusted JSON decoded from the private preparation file.
* @returns Validated preparation fields.
*/
function parseAppContainerReceipt(value) {
	const item = record(value, [
		"format",
		"status",
		"ownerSid",
		"packageName",
		"packageSid",
		"mode",
		"workspaceRoot",
		"additionalWritableRoots",
		"protectedWriteRoots",
		"executionRoots",
		"volumes",
		"infrastructureRoots",
		"readOnlyRoots",
		"profileRoot",
		"tempRoot",
		"maxTreeEntries",
		"anchors"
	]);
	if (item.format !== "dao-appcontainer-prepared-v1" || item.status !== "admitted") fail("preparation is not admitted");
	const packageName = string(item.packageName), packageSid = sid(item.packageSid);
	if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(packageName) || !packageSid.startsWith("S-1-15-2-")) fail("invalid AppContainer identity");
	if (!Array.isArray(item.volumes) || !Array.isArray(item.anchors)) fail("missing volume or anchor inventory");
	const result = {
		format: "dao-appcontainer-prepared-v1",
		status: "admitted",
		ownerSid: sid(item.ownerSid),
		packageName,
		packageSid,
		mode: mode(item.mode),
		workspaceRoot: appContainerPath(item.workspaceRoot),
		additionalWritableRoots: paths(item.additionalWritableRoots),
		protectedWriteRoots: paths(item.protectedWriteRoots),
		executionRoots: paths(item.executionRoots),
		volumes: item.volumes.map(volume),
		infrastructureRoots: paths(item.infrastructureRoots),
		readOnlyRoots: paths(item.readOnlyRoots),
		profileRoot: appContainerPath(item.profileRoot),
		tempRoot: appContainerPath(item.tempRoot),
		maxTreeEntries: positive(item.maxTreeEntries),
		anchors: item.anchors.map(anchor)
	};
	if (result.volumes.length === 0 || new Set(result.volumes.map((entry) => pathKey(entry.root))).size !== result.volumes.length || new Set(result.volumes.map((entry) => entry.volumeName.toLowerCase())).size !== result.volumes.length) fail("missing or duplicate volumes");
	const fixedRoots = [
		...result.protectedWriteRoots,
		...result.infrastructureRoots,
		...result.readOnlyRoots
	];
	if (result.protectedWriteRoots.length === 0 || result.infrastructureRoots.length === 0 || result.readOnlyRoots.length === 0 || result.executionRoots.length === 0) fail("missing protected, private, runtime or execution roots");
	if (fixedRoots.some((root, index) => fixedRoots.some((other, otherIndex) => index !== otherIndex && within(root, other)))) fail("overlapping protected classifications");
	const writable = [result.workspaceRoot, ...result.additionalWritableRoots];
	if (writable.some((path) => result.volumes.some((entry) => pathKey(path) === pathKey(entry.root)))) fail("a writable scope cannot be a volume root");
	if ([
		result.workspaceRoot,
		...result.additionalWritableRoots,
		...fixedRoots,
		...result.executionRoots,
		result.tempRoot,
		result.profileRoot
	].some((path) => !result.volumes.some((entry) => within(path, entry.root)))) fail("path outside admitted volumes");
	if ([...result.executionRoots, result.tempRoot].some((path) => !writable.some((root) => within(path, root)) || fixedRoots.some((root) => within(path, root)))) fail("cwd or temporary directory is not writable");
	const byPath = new Map(result.anchors.map((entry) => [pathKey(entry.path), entry]));
	if (byPath.size !== result.anchors.length || new Set(result.anchors.map((entry) => entry.objectId)).size !== result.anchors.length) fail("aliased anchors");
	for (const root of [
		...fixedRoots,
		result.profileRoot,
		result.tempRoot,
		result.workspaceRoot,
		...result.executionRoots,
		...result.additionalWritableRoots
	]) {
		let path = root;
		for (;;) {
			if (byPath.get(pathKey(path))?.kind !== "directory") fail("incomplete root or ancestor identity inventory");
			const parent = win32.dirname(path);
			if (parent === path) break;
			path = parent;
		}
	}
	return result;
}
/** Matches a current request to the exact prepared policy without widening permissions.
* @param receipt - Validated initializer output.
* @param config - Trusted executable and receipt pins.
* @param policy - Actual requested file-effect policy.
* @param execution - Actual consumer cwd; it must be supplied explicitly.
* @returns The admitted cwd for native inspection and launch.
*/
function admitAppContainerPolicy(receipt, config, policy, execution) {
	const samePaths = (left, right) => left.length === right.length && left.map(pathKey).sort().every((entry, index) => entry === right.map(pathKey).sort()[index]);
	if (receipt.mode !== policy.mode || pathKey(receipt.workspaceRoot) !== pathKey(policy.workspaceRoot) || !samePaths(receipt.additionalWritableRoots, policy.additionalWritableRoots ?? []) || !samePaths(receipt.protectedWriteRoots, policy.protectedWriteRoots ?? [])) fail("requested mode or roots differ from preparation");
	const cwd = appContainerPath(execution?.cwd);
	if (!receipt.executionRoots.some((root) => within(cwd, root)) || [
		...receipt.protectedWriteRoots,
		...receipt.infrastructureRoots,
		...receipt.readOnlyRoots
	].some((root) => within(cwd, root))) fail("cwd is outside the admitted execution scope");
	if (!receipt.infrastructureRoots.some((root) => within(config.preparationReceipt, root)) || !receipt.readOnlyRoots.some((root) => within(config.executable, root))) fail("runner or receipt lacks its required protection");
	const executable = receipt.anchors.find((entry) => pathKey(entry.path) === pathKey(config.executable));
	if (executable?.kind !== "file" || executable.sha256 !== config.executableSha256) fail("runner pin is absent from preparation");
	return cwd;
}
/** Validates native inspection output against the exact requested receipt and cwd.
* @param value - Untrusted JSON from the read-only native subprocess.
* @param receipt - The parsed prepared policy.
* @param receiptSha256 - Exact file-byte digest.
* @param cwd - Admitted current working directory.
* @returns The matching native admission result.
*/
function parseAppContainerInspection(value, receipt, receiptSha256, cwd) {
	const item = record(value, [
		"format",
		"status",
		"receiptSha256",
		"cwd",
		"ownerSid",
		"packageSid",
		"mode",
		"protectedWriteEnforcement"
	]);
	if (item.format !== "dao-appcontainer-inspection-v1" || item.status !== "admitted" || item.receiptSha256 !== receiptSha256 || item.cwd !== cwd || item.ownerSid !== receipt.ownerSid || item.packageSid !== receipt.packageSid || item.mode !== receipt.mode || item.protectedWriteEnforcement !== "full") fail("native inspection did not admit the requested preparation");
	return {
		format: "dao-appcontainer-inspection-v1",
		status: "admitted",
		receiptSha256,
		cwd,
		ownerSid: receipt.ownerSid,
		packageSid: receipt.packageSid,
		mode: receipt.mode,
		protectedWriteEnforcement: "full"
	};
}
//#endregion
//#region lib/types/windows-appcontainer.js
/** Opt-in AppContainer wrapping with pinned deployment files and independent native admission. */
const runFile = promisify(execFile);
const FAILURE_PREFIX = "DSH_APPCONTAINER_RUNNER:";
const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const INSPECTION_MAX_BYTES = 64 * 1024;
const ENV_DENY_PREFIXES = [
	"COMPLUS_",
	"COR_",
	"CORECLR_",
	"DOTNET_",
	"APPDOMAIN_MANAGER_"
];
const ENV_DENY_NAMES = ["__COMPAT_LAYER"];
async function regularFile(path) {
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("AppContainer deployment file is linked or not regular");
	let parent = win32.dirname(path);
	for (;;) {
		const entry = await lstat(parent);
		if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("AppContainer deployment has a redirected ancestor");
		const next = win32.dirname(parent);
		if (next === parent) break;
		parent = next;
	}
}
async function fileHash(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) {
		if (!Buffer.isBuffer(chunk)) throw new Error("AppContainer control file returned non-binary data");
		hash.update(chunk);
	}
	return hash.digest("hex");
}
/** Reads only OS variables needed by the native read-only inspection subprocess. */
function inspectionEnvironment() {
	const allowed = new Set([
		"systemroot",
		"windir",
		"systemdrive",
		"programdata",
		"programfiles",
		"programfiles(x86)",
		"localappdata",
		"appdata",
		"userprofile",
		"temp",
		"tmp",
		"processor_architecture"
	]);
	const environment = {};
	const seen = /* @__PURE__ */ new Set();
	for (const [key, value] of Object.entries(process.env)) {
		const normalized = key.toLowerCase();
		if (value !== void 0 && allowed.has(normalized)) {
			if (seen.has(normalized)) throw new Error("AppContainer inspection has ambiguous OS environment names");
			seen.add(normalized);
			environment[key] = value;
		}
	}
	return environment;
}
/** Keeps command text and encoded arguments out of subprocess failure diagnostics. */
function inspectionFailure(error) {
	if (typeof error !== "object" || error === null) return "native inspection failed";
	if ("stderr" in error && typeof error.stderr === "string") {
		const code = error.stderr.split(/\r?\n/u).find((line) => /^DSH_APPCONTAINER_RUNNER:[A-Z0-9_]+$/u.test(line));
		if (code !== void 0) return code;
	}
	if ("code" in error && (typeof error.code === "number" || typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code))) return `native inspection failed (${error.code})`;
	return "native inspection failed";
}
/** Inspects a pinned preparation and returns a stdio-only native invocation; no setup runs here.
* @param config - Deployment-pinned native runner and private preparation record.
* @param argv - Exact executable and arguments requested by the consumer.
* @param policy - Actual requested sandbox mode and roots.
* @param execution - Actual consumer cwd.
* @param timeoutMs - Bound for native read-only admission; command lifetime remains consumer-owned.
* @param signal - Cancellation before or during admission.
* @returns Native argv with an independent protected-write guarantee after successful inspection.
*/
async function prepareAppContainer(config, argv, policy, execution, timeoutMs, signal) {
	try {
		signal?.throwIfAborted();
		if (argv[0] === void 0) throw new Error("AppContainer command requires an executable");
		appContainerPath(argv[0]);
		await regularFile(config.executable);
		await regularFile(config.preparationReceipt);
		if (await fileHash(config.executable) !== config.executableSha256) throw new Error("AppContainer runner fingerprint changed");
		if ((await lstat(config.preparationReceipt)).size > RECEIPT_MAX_BYTES) throw new Error("AppContainer preparation exceeds the protocol size limit");
		const bytes = await readFile(config.preparationReceipt);
		if (bytes.length > RECEIPT_MAX_BYTES || createHash("sha256").update(bytes).digest("hex") !== config.preparationReceiptSha256) throw new Error("AppContainer preparation fingerprint changed");
		let parsed;
		try {
			parsed = JSON.parse(bytes.toString("utf8"));
		} catch (error) {
			throw new Error("AppContainer preparation contains invalid JSON", { cause: error });
		}
		const receipt = parseAppContainerReceipt(parsed);
		const cwd = admitAppContainerPolicy(receipt, config, policy, execution);
		const common = [
			config.preparationReceipt,
			"--sha256",
			config.preparationReceiptSha256,
			"--cwd",
			cwd
		];
		let output;
		try {
			output = await runFile(config.executable, ["--inspect", ...common], {
				cwd,
				env: inspectionEnvironment(),
				windowsHide: true,
				timeout: timeoutMs,
				maxBuffer: INSPECTION_MAX_BYTES,
				encoding: "utf8",
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			signal?.throwIfAborted();
			throw new Error(inspectionFailure(error));
		}
		if (output.stderr.trim() !== "") throw new Error("AppContainer inspection emitted an unexpected diagnostic");
		let inspected;
		try {
			inspected = JSON.parse(output.stdout);
		} catch (error) {
			throw new Error("AppContainer inspection returned invalid JSON", { cause: error });
		}
		parseAppContainerInspection(inspected, receipt, config.preparationReceiptSha256, cwd);
		signal?.throwIfAborted();
		const environment = {
			TEMP: receipt.tempRoot,
			TMP: receipt.tempRoot
		};
		for (const name of Object.keys(process.env)) {
			const folded = name.toUpperCase();
			if (ENV_DENY_NAMES.includes(folded) || ENV_DENY_PREFIXES.some((prefix) => folded.startsWith(prefix))) environment[name] = null;
		}
		return {
			argv: [
				config.executable,
				"--run",
				...common,
				"--",
				...argv
			],
			env: environment,
			envDenyPrefixes: ENV_DENY_PREFIXES,
			envDenyNames: ENV_DENY_NAMES,
			transport: "stdio",
			enforcement: "partial",
			protectedWriteEnforcement: "full",
			denialSignatures: [
				"access is denied",
				"access to the path",
				"permission denied",
				"operation not permitted"
			],
			runnerFailureRules: [{
				allowedExitCodes: [125],
				fatalSignatures: [FAILURE_PREFIX]
			}]
		};
	} catch (error) {
		signal?.throwIfAborted();
		const detail = error instanceof Error ? error.message : "AppContainer preparation failed";
		throw new SandboxUnavailableError(policy.mode, detail, (policy.protectedWriteRoots?.length ?? 0) > 0 && policy.mode !== "read-only");
	}
}
/** Wraps a full-access command with the current Windows token and an owned Job.
* @param config - Pinned native executable; no AppContainer preparation is required.
* @param argv - Exact absolute executable and arguments requested by the consumer.
* @param policy - Full-access policy without protected write roots.
* @param execution - Actual consumer cwd, supplied explicitly.
* @param signal - Cancellation before returning a runnable invocation.
* @returns A pinned stdio invocation, optionally preserving fd7, with the current user's filesystem authority.
*/
async function prepareWindowsFullAccess(config, argv, policy, execution, signal) {
	try {
		signal?.throwIfAborted();
		if (policy.mode !== "danger-full-access" || (policy.protectedWriteRoots?.length ?? 0) > 0) throw new Error("normal-token Windows execution requires full access without protected write roots");
		if (argv[0] === void 0) throw new Error("native command requires an executable");
		appContainerPath(argv[0]);
		const cwd = appContainerPath(execution?.cwd);
		await regularFile(config.executable);
		if (await fileHash(config.executable) !== config.executableSha256) throw new Error("native runner fingerprint changed");
		signal?.throwIfAborted();
		const environment = {};
		for (const key of Object.keys(process.env)) {
			const upper = key.toUpperCase();
			if (ENV_DENY_PREFIXES.some((prefix) => upper.startsWith(prefix)) || ENV_DENY_NAMES.includes(upper)) environment[key] = null;
		}
		return {
			argv: [
				config.executable,
				"--full-access",
				"--cwd",
				cwd,
				"--",
				...argv
			],
			env: environment,
			envDenyPrefixes: ENV_DENY_PREFIXES,
			envDenyNames: ENV_DENY_NAMES,
			transport: config.controlPipe === "fd7" ? "stdio-control" : "stdio",
			enforcement: "full",
			denialSignatures: [
				"access is denied",
				"access to the path",
				"permission denied",
				"operation not permitted"
			],
			runnerFailureRules: [{
				allowedExitCodes: [125],
				fatalSignatures: [FAILURE_PREFIX]
			}]
		};
	} catch (error) {
		signal?.throwIfAborted();
		throw new SandboxUnavailableError(policy.mode, error instanceof Error ? error.message : "native runner preparation failed", (policy.protectedWriteRoots?.length ?? 0) > 0);
	}
}
//#endregion
//#region lib/types/index.js
/**
* Local sandbox backend. It selects the platform runner chain (Linux bwrap then
* Landlock; macOS Seatbelt; Windows the ACL restricted-token runner), functionally probes
* competing candidates once, and reports each wrap's enforcement and stderr
* classification facts. Missing or unusable confinement fails closed rather
* than returning the original argv.
*
* The windows-acl rung additionally owns the write grants: the write SID is
* the per-WORKSPACE identity derived from the canonical workspace path
* (`workspaceWriteSid`), while every live session receives a RANDOM private
* temp directory and its own derived capability (`tempWriteSid`). The
* workspace-root ACE materializes once per workspace per server lifetime
* and STANDS (the cross-session reuse cache — the exact-ACE skip makes
* every later provision O(1) instead of re-propagating the tree per
* session); the private-temp ACEs are revoked on dispose. The runner
* receives both SIDs (their presence marks the seam-managed contract) and
* stops managing DACLs itself. The rung reports partial enforcement because
* NTFS hard links alias one file object across paths, reads stay unconfined,
* and a tree another AppContainer tool has ACL'd with a package SID is not
* readable by the Low-integrity child.
* @module @deepseek-ai/dsh-sandbox-local
*/
/** Probe whether `bwrap` can create the profile; the provider caches the bounded result. */
function defaultProbeBwrap(timeoutMs) {
	return spawnSync("bwrap", [
		...bwrapProfileArgs({
			mode: "read-only",
			workspaceRoot: "/"
		}),
		"--",
		"true"
	], {
		timeout: timeoutMs,
		stdio: "ignore"
	}).status === 0;
}
/**
* Functional Seatbelt probe: apply the real `read-only` profile through
* `sandbox-exec -p` and run `true` under it — exit 0 means the kernel
* accepted and enforced the profile (`sandbox-exec` exits non-zero when
* `sandbox_init` refuses it). A missing `sandbox-exec` (every non-macOS
* host) fails the spawn and probes `unusable`, exactly like the other
* rungs' absent binaries. Apple marks the CLI deprecated but ships it on
* every macOS; if it ever disappears, this probe is what fails closed.
*/
function defaultProbeSeatbelt(seatbeltExec, timeoutMs) {
	return spawnSync(seatbeltExec, [
		...seatbeltProfileArgs({
			mode: "read-only",
			workspaceRoot: "/"
		}),
		"--",
		"true"
	], {
		timeout: timeoutMs,
		stdio: "ignore"
	}).status === 0;
}
/**
* Functional windows-acl probe: run the runner in read-only mode (zero grants,
* no ACL mutation) around `cmd /c exit 0` — exit 0 means the runner created
* the restricted token and spawned the child under it. The win32 chain is a
* sole candidate, so the product never probes; the probe exists for override
* chains and mirrors the other rungs' shape.
*/
function defaultProbeWindowsAcl(runnerInvocation, timeoutMs) {
	const program = runnerInvocation[0];
	if (program === void 0) return false;
	return spawnSync(program, [
		...runnerInvocation.slice(1),
		"--workspace",
		tmpdir(),
		"--temp",
		tmpdir(),
		"--mode",
		"read-only",
		"--",
		"cmd",
		"/c",
		"exit",
		"0"
	], {
		timeout: timeoutMs,
		stdio: "ignore"
	}).status === 0;
}
/**
* The runner chain per platform — selection is BY PLATFORM first, probes
* second: a platform's chain is probed in preference order only when it has
* MORE than one candidate (probing arbitrates; it does not re-validate a
* choice that has no alternative). A platform with no chain fails closed at
* `confine()`. Linux prefers `bwrap` (its mount profile is closest to the
* mode vocabulary) over the Landlock launcher; darwin has exactly one
* candidate, selected without any probe.
*/
const PLATFORM_CHAINS = {
	linux: ["bwrap", "landlock"],
	darwin: ["seatbelt"],
	win32: ["windows-acl"]
};
/**
* Enforcement completeness a rung claims when selected WITHOUT a probe (a
* chain of one). `bwrap` and Seatbelt govern every promised file effect by
* construction, so the claim is a profile fact; `landlock` is listed for the
* table's totality but is unreachable without a probe (the Linux chain has
* two rungs, so it is only ever selected through its probe, whose report is
* what distinguishes full from per-ABI-partial — and the launcher additionally
* self-reports partial enforcement on stderr at every confined run).
*/
const STATIC_ENFORCEMENT = {
	bwrap: "full",
	landlock: "full",
	seatbelt: "full",
	"windows-acl": "partial"
};
/**
* A probe bound must be a positive finite number: Node treats
* `spawnSync({ timeout: 0 })` as NO timeout, so an unvalidated 0 would
* silently mean "unbounded" — the opposite of what the field promises.
*/
function assertPositiveFinite(name, value) {
	if (!Number.isFinite(value) || value <= 0) throw new Error(`sandbox-local: ${name} must be a positive finite number`);
}
/**
* The denial dialect each runner's kernel speaks — the case-insensitive stderr substrings a
* denied file effect produces under it, carried on every wrap (the seam's
* `ConfinedArgv.denialSignatures`).
*/
const DENIAL_SIGNATURES = {
	bwrap: ["read-only file system"],
	landlock: ["permission denied"],
	seatbelt: ["operation not permitted"],
	"windows-acl": [
		"access is denied",
		"access to the path",
		"permission denied",
		"operation not permitted"
	],
	runnerCommand: ["read-only file system", "permission denied"]
};
/**
* Runner-owned fatal diagnostics. Landlock has a versioned exit-125 plus
* fatal-line launcher-failure contract. Bubblewrap's current fatal paths exit
* 1 but its public contract does not reserve that status, while sandbox-exec
* publishes no launcher-failure status; those backends remain signature-only.
* The windows-acl runner prints `windows-acl-run: <detail>` on every
* runner-side failure and exits 127 — the rule is exit-gated on that status
* so a confined command that merely PRINTS the signature (or a runner
* cleanup failure reported on a non-zero child exit) is never misclassified
* as "the command did not run". Keep the Landlock tuple aligned with the
* assembled snapshot fixture at
* `packages/test-support/session-snapshot/tests/fixtures/partial-landlock-sandbox.ts`.
*/
const RUNNER_FAILURE_RULES = {
	bwrap: [{ fatalSignatures: ["bwrap: "] }],
	landlock: [{
		allowedExitCodes: [LAUNCHER_FAILURE_EXIT],
		fatalSignatures: [`${LAUNCHER_BIN}: `],
		informationalLines: [`${LAUNCHER_BIN}: partial enforcement (older Landlock ABI)`]
	}],
	seatbelt: [{ fatalSignatures: ["sandbox-exec: "] }],
	"windows-acl": [{
		allowedExitCodes: [127],
		fatalSignatures: ["windows-acl-run: "]
	}]
};
/**
* Local process-sandbox provider. Registers as `ctx.sandbox`. Caches the
* chain verdict and, on the windows-acl rung, the write grants
* ({@link AclWriteGrant}: the standing workspace-root grant per workspace
* and the revocable private-temp grant per live session/workspace pair, the
* latter revoked on provider dispose); the one-time probes spawn nothing
* else.
*/
var LocalSandboxProvider = class extends SandboxProvider {
	static Config = z.object({
		runnerCommand: z.array(z.string()).default([]),
		runnerFailureSignatures: z.array(z.string()).default([]),
		probeTimeoutMs: z.natural().default(5e3),
		windowsNativeRunner: z.union([z.object({
			executable: z.string(),
			executableSha256: z.string(),
			controlPipe: z.union(["fd7"])
		})]),
		windowsAppContainer: z.union([z.object({
			executable: z.string(),
			executableSha256: z.string(),
			preparationReceipt: z.string(),
			preparationReceiptSha256: z.string()
		})]),
		windowsPreparedSandbox: z.union([z.object({
			fullAccess: z.union([z.object({
				volumes: z.array(z.object({
					root: z.string(),
					volumeName: z.string(),
					serialNumber: z.number(),
					mountPaths: z.array(z.string())
				})),
				infrastructureRoots: z.array(z.string())
			})]),
			executable: z.string(),
			codexHome: z.string(),
			configSha256: z.string(),
			profile: z.string(),
			workspaceRoot: z.string(),
			additionalWritableRoots: z.array(z.string()),
			protectedWriteRoots: z.array(z.string()),
			protectedTreeMaxEntries: z.natural(),
			executionRoots: z.array(z.string()),
			userProfile: z.string(),
			appData: z.string(),
			localAppData: z.string(),
			tempRoot: z.string(),
			setupMarkerSha256: z.string(),
			credentialsFile: z.object({
				bytes: z.number(),
				mtimeMs: z.number()
			}),
			admittedAcls: z.array(z.object({
				path: z.string(),
				sddl: z.string()
			})),
			systemReadRoots: z.array(z.object({
				path: z.string(),
				sddl: z.string()
			}))
		})])
	});
	/** Test hook (mirrors the bash executors' `internals`). */
	internals = {};
	runnerCommand;
	configuredRunnerFailureSignatures;
	probeTimeoutMs;
	windowsPreparedSandbox;
	windowsAppContainer;
	windowsNativeRunner;
	/** Cached chain verdict; undefined until the first confined wrap needs it. */
	selectedRunner;
	/**
	* Server-lifetime write grants (windows-acl rung): the STANDING
	* workspace-root grant per workspace (its ACE is the cross-session reuse
	* cache and outlives the provider — never revoked) and the REVOCABLE
	* private-temp grant per live session/workspace pair (revoked on provider
	* dispose).
	*/
	workspaceGrants = /* @__PURE__ */ new Map();
	tempCapabilities = /* @__PURE__ */ new Map();
	get requiresFullAccessWrapper() {
		return this.windowsNativeRunner !== void 0;
	}
	constructor(ctx, config) {
		super(ctx);
		const runner = config.runnerCommand;
		const runnerFailureSignatures = config.runnerFailureSignatures;
		if (runner.length === 0 && runnerFailureSignatures.length > 0) throw new Error("sandbox-local: runnerFailureSignatures requires runnerCommand");
		if (runner.length > 0 && runnerFailureSignatures.length === 0) throw new Error("sandbox-local: runnerCommand requires at least one runnerFailureSignatures entry");
		if (runnerFailureSignatures.some((signature) => signature.trim().length === 0 || /[\r\n]/u.test(signature))) throw new Error("sandbox-local: runnerFailureSignatures entries must be non-empty single-line strings");
		if (config.windowsAppContainer !== void 0) {
			if (runner.length > 0 || config.windowsPreparedSandbox !== void 0) throw new Error("windowsAppContainer cannot be combined with runnerCommand or windowsPreparedSandbox");
			validateAppContainerConfig(config.windowsAppContainer);
		}
		this.windowsAppContainer = config.windowsAppContainer;
		if (config.windowsNativeRunner !== void 0) {
			if (runner.length > 0) throw new Error("windowsNativeRunner cannot be combined with runnerCommand");
			validateWindowsNativeRunnerConfig(config.windowsNativeRunner);
		}
		this.windowsNativeRunner = config.windowsNativeRunner;
		if (config.windowsPreparedSandbox !== void 0) {
			if (runner.length > 0) throw new Error("windowsPreparedSandbox cannot be combined with runnerCommand");
			validatePreparedConfig(config.windowsPreparedSandbox);
		}
		this.windowsPreparedSandbox = config.windowsPreparedSandbox;
		this.runnerCommand = runner.length > 0 ? runner : void 0;
		this.configuredRunnerFailureSignatures = runnerFailureSignatures;
		this.probeTimeoutMs = config.probeTimeoutMs;
		assertPositiveFinite("probeTimeoutMs", this.probeTimeoutMs);
		/* v8 ignore next 3 -- Windows-only registration; the Linux coverage lane cannot take this branch */
		if (process.platform === "win32" && this.runnerCommand === void 0 && this.windowsPreparedSandbox === void 0 && this.windowsAppContainer === void 0) ctx.inject(["skills"], (skillsCtx) => {
			registerAclDiagnosisSkill(skillsCtx);
		});
		ctx.effect(() => () => {
			this.revokeAclGrants();
		});
	}
	/**
	* Wrap `argv` in the selected runner's invocation for `policy` — the configured
	* `runnerCommand` when present (the operator's assertion, no probe), else the platform
	* chain's runner speaking its own profile dialect.
	*
	* @param argv - the exact argv the caller is about to spawn.
	* @param policy - the file-effect policy this execution runs under.
	* @param signal - cancellation before policy resolution or grant creation.
	* @param execution - actual consumer cwd, required by the prepared Windows backend.
	* @returns the wrapped argv plus the selected backend's enforcement completeness, denial
	*   signatures, and structured runner-failure rules; throws the fail-closed
	*   `SANDBOX_UNAVAILABLE` error when the platform has no usable runner.
	*/
	async confine(argv, policy, signal, execution) {
		signal?.throwIfAborted();
		if (this.windowsNativeRunner !== void 0 && policy.mode === "danger-full-access") {
			if ((this.internals.platform ?? process.platform) !== "win32") throw new SandboxUnavailableError(policy.mode, "native Windows runner requires a Windows host");
			return prepareWindowsFullAccess(this.windowsNativeRunner, argv, policy, execution, signal);
		}
		if (this.windowsAppContainer !== void 0) {
			if ((this.internals.platform ?? process.platform) !== "win32") throw new SandboxUnavailableError(policy.mode, "AppContainer requires a Windows host", true);
			return prepareAppContainer(this.windowsAppContainer, argv, policy, execution, this.probeTimeoutMs, signal);
		}
		if (this.windowsPreparedSandbox !== void 0) {
			if ((this.internals.platform ?? process.platform) !== "win32") throw new SandboxUnavailableError(policy.mode, "prepared Windows profile requires a Windows host", true);
			return prepareWindowsSandbox(this.windowsPreparedSandbox, argv, policy, execution, this.probeTimeoutMs, signal);
		}
		policy = {
			...policy,
			workspaceRoot: canonicalPath(policy.workspaceRoot)
		};
		const protectedWrites = (policy.protectedWriteRoots?.length ?? 0) > 0 && policy.mode !== "read-only";
		if (protectedWrites && (this.runnerCommand !== void 0 || (this.internals.platform ?? process.platform) !== "darwin")) throw new SandboxUnavailableError(policy.mode, "selected local backend cannot enforce protected write exclusions", true);
		if (this.runnerCommand !== void 0) {
			if (policy.mode === "danger-full-access") throw new SandboxUnavailableError(policy.mode, "configured runner does not support full-access confinement", protectedWrites);
			return Promise.resolve({
				argv: [
					...this.runnerCommand,
					...bwrapProfileArgs(policy),
					"--",
					...argv
				],
				enforcement: "full",
				denialSignatures: DENIAL_SIGNATURES.runnerCommand,
				runnerFailureRules: [{ fatalSignatures: this.configuredRunnerFailureSignatures }]
			});
		}
		const selected = this.selectRunner(policy.mode);
		if (policy.mode === "danger-full-access" && selected.runner !== "seatbelt") throw new SandboxUnavailableError(policy.mode, "selected runner does not support full-access confinement", protectedWrites);
		if (protectedWrites && (selected.runner !== "seatbelt" || selected.enforcement !== "full")) throw new SandboxUnavailableError(policy.mode, "selected runner cannot enforce protected write exclusions", true);
		if (protectedWrites) assertProtectedRootsHaveNoHardlinks(policy);
		const runnerArgv = this.runnerArgv(selected.runner, policy);
		return Promise.resolve({
			argv: [
				...runnerArgv,
				"--",
				...argv
			],
			enforcement: selected.enforcement,
			denialSignatures: DENIAL_SIGNATURES[selected.runner],
			runnerFailureRules: RUNNER_FAILURE_RULES[selected.runner]
		});
	}
	/** The selected rung's runner invocation (program + profile arguments) for one policy. */
	runnerArgv(runner, policy) {
		switch (runner) {
			case "bwrap": return ["bwrap", ...bwrapProfileArgs(policy)];
			case "landlock": return [this.landlockLauncher(), ...landlockProfileArgs(policy)];
			case "seatbelt": return [this.seatbeltExec(), ...seatbeltProfileArgs(policy)];
			case "windows-acl": return this.windowsAclRunnerArgv(policy);
			default: return assertNever(runner);
		}
	}
	/**
	* The windows-acl runner argv for one policy. With a calling session (the
	* policy's `sessionId`) under workspace-write, the grants are materialized
	* once per provider lifetime — the standing workspace-root grant per
	* workspace and a revocable, RANDOM private-temp capability per live
	* session/workspace pair. The runner receives `--write-sid` plus
	* `--temp-write-sid` and grants nothing itself. Agentless workspace-write
	* calls pass the ambient temp ROOT and no SID flags: the runner creates and
	* removes a random private child directory for that one invocation.
	* @param policy - the resolved per-call policy.
	* @returns the runner invocation.
	*/
	windowsAclRunnerArgv(policy) {
		if (policy.mode === "workspace-write" && (policy.additionalWritableRoots?.length ?? 0) > 0) throw new SandboxUnsupportedPolicyError("Windows ACL confinement does not support additional writable directories; remove the extra grants or use a supported host");
		const sessionId = policy.sessionId;
		if (sessionId === void 0 || policy.mode === "read-only") return [
			...this.windowsAclRunnerInvocation(),
			"--workspace",
			policy.workspaceRoot,
			"--temp",
			tmpdir(),
			"--mode",
			policy.mode
		];
		const temp = this.materializeAclGrant(sessionId, policy.workspaceRoot);
		return [
			...this.windowsAclRunnerInvocation(),
			"--workspace",
			policy.workspaceRoot,
			"--temp",
			temp.dir,
			"--mode",
			policy.mode,
			"--write-sid",
			workspaceWriteSid(policy.workspaceRoot),
			"--temp-write-sid",
			temp.writeSid
		];
	}
	/**
	* Materialize one workspace-write policy's ACEs once per provider
	* lifetime. The workspace SID and standing root grant are shared by the
	* workspace. The temp directory is random and carries a distinct SID, so
	* another session on the same workspace cannot use the shared workspace
	* SID to enter it. A fresh provider always chooses a new path; crash
	* residue therefore cannot collide with or authorize a resumed session.
	* Fail-closed: a half-materialized temp grant is revoked and its directory
	* removed before the error propagates.
	* @param sessionId - the policy's calling-session identity.
	* @param workspaceRoot - the resolved policy root.
	* @returns the pair's private temp directory and write capability.
	*/
	materializeAclGrant(sessionId, workspaceRoot) {
		assertTempRootOutsideWorkspace(workspaceRoot, tmpdir());
		const writeSid = workspaceWriteSid(workspaceRoot);
		if (!this.workspaceGrants.has(workspaceRoot)) {
			const grant = AclWriteGrant.create(writeSid);
			try {
				grant.add(workspaceRoot, true);
			} catch (error) {
				try {
					grant.dispose();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "sandbox-local windows-acl workspace grant failed and its cleanup also failed");
				}
				throw error;
			}
			this.workspaceGrants.set(workspaceRoot, grant);
		}
		const key = JSON.stringify([String(sessionId), workspaceRoot]);
		const existing = this.tempCapabilities.get(key);
		if (existing !== void 0) return existing;
		const tempDir = mkdtempSync(join(tmpdir(), "dsh-"));
		const tempSid = tempWriteSid(tempDir);
		let grant;
		try {
			grant = AclWriteGrant.create(tempSid);
			grant.add(tempDir);
		} catch (error) {
			const cleanupFailures = [];
			if (grant !== void 0) try {
				grant.dispose();
			} catch (cleanupError) {
				cleanupFailures.push(cleanupError);
			}
			try {
				this.removeTempDir(tempDir);
			} catch (cleanupError) {
				cleanupFailures.push(cleanupError);
			}
			if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], "sandbox-local windows-acl temp grant materialization failed and its cleanup also failed");
			throw error;
		}
		const capability = {
			dir: tempDir,
			writeSid: tempSid,
			grant
		};
		this.tempCapabilities.set(key, capability);
		return capability;
	}
	/**
	* Dispose every write grant (provider dispose): the revocable temp ACEs
	* are revoked, the private temp directories this provider created are
	* removed, and every SID allocation is freed; the standing workspace ACEs
	* stay (the reuse cache). Cleanup failures are reported, not thrown:
	* cordis teardown must not be aborted by grant cleanup. A crash skips all
	* of it, but a new provider never reuses the residue's random path or SID;
	* OS temp hygiene (or manual removal) eventually reclaims it.
	*/
	revokeAclGrants() {
		if (this.workspaceGrants.size === 0 && this.tempCapabilities.size === 0) return;
		const failures = [];
		for (const grant of [...this.workspaceGrants.values(), ...[...this.tempCapabilities.values()].map((capability) => capability.grant)]) try {
			grant.dispose();
		} catch (error) {
			failures.push(error);
		}
		for (const { dir } of this.tempCapabilities.values()) try {
			this.removeTempDir(dir);
		} catch (error) {
			failures.push(error);
		}
		this.workspaceGrants.clear();
		this.tempCapabilities.clear();
		if (failures.length > 0) {
			this.ctx.logger.warn(`sandbox-local: windows-acl grant cleanup completed with ${failures.length} failure(s)`);
			for (const error of failures) this.ctx.logger.warn(error);
		}
	}
	/** Remove one provider-owned private temp directory (injectable for cleanup tests). */
	removeTempDir(dir) {
		(this.internals.rmTempDir ?? ((path) => {
			rmSync(path, {
				recursive: true,
				force: true
			});
		}))(dir);
	}
	/**
	* Resolve which runner confines commands, once, for the provider's
	* lifetime: this platform's chain ({@link PLATFORM_CHAINS}), its sole
	* candidate selected directly, multiple candidates arbitrated by
	* functional probes in chain order. Fail closed when the platform has no
	* chain or no candidate passes — the command never runs.
	*/
	selectRunner(mode) {
		this.selectedRunner ??= this.chainVerdict();
		if (this.selectedRunner === "unavailable") throw new SandboxUnavailableError(mode);
		return this.selectedRunner;
	}
	/** Walk this platform's chain: sole candidate unprobed, several probed in order, none usable → unavailable. */
	chainVerdict() {
		const chain = this.internals.chain ?? PLATFORM_CHAINS[this.internals.platform ?? process.platform] ?? [];
		const [first, ...rest] = chain;
		if (first === void 0) return "unavailable";
		if (rest.length === 0) return {
			runner: first,
			enforcement: STATIC_ENFORCEMENT[first]
		};
		for (const runner of chain) {
			const enforcement = this.probeRunner(runner);
			if (enforcement !== "unusable") return {
				runner,
				enforcement
			};
		}
		return "unavailable";
	}
	/** One rung's functional probe (each at most once, via the chain walk). */
	probeRunner(runner) {
		switch (runner) {
			case "bwrap": return (this.internals.probeBwrap ?? (() => defaultProbeBwrap(this.probeTimeoutMs)))() ? "full" : "unusable";
			case "landlock": return (this.internals.probeLandlock ?? ((launcher) => probe(launcher, { timeoutMs: this.probeTimeoutMs })))(this.landlockLauncher());
			case "seatbelt": return (this.internals.probeSeatbelt ?? ((exec) => defaultProbeSeatbelt(exec, this.probeTimeoutMs)))(this.seatbeltExec()) ? "full" : "unusable";
			case "windows-acl": return (this.internals.probeWindowsAcl ?? (() => defaultProbeWindowsAcl(this.windowsAclRunnerInvocation(), this.probeTimeoutMs)))() ? "partial" : "unusable";
			default: return assertNever(runner);
		}
	}
	/** The Landlock launcher to probe and exec (test hook over the resolved one). */
	landlockLauncher() {
		return this.internals.landlockLauncher ?? launcherPath();
	}
	/** The `sandbox-exec` executable to probe and exec (test hook over the system one). */
	seatbeltExec() {
		return this.internals.seatbeltExec ?? "sandbox-exec";
	}
	/**
	* The windows-acl runner argv prefix: the built lib/runner.js entry when
	* present (production), else the package source through tsx (development).
	* Pin the source loader and TypeScript paths to this installation, independently
	* of target cwd or environment overrides.
	* The prefix stays `[node, runner, ...]` — a future native-exe runner keeps
	* the same argv contract and only swaps these entries.
	*/
	windowsAclRunnerInvocation() {
		const override = this.internals.windowsAclRunnerArgs;
		if (override !== void 0) return override;
		const builtEntry = this.internals.windowsAclRunnerEntry ?? fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner"));
		if (existsSync(builtEntry)) return [process.execPath, builtEntry];
		const sourceEntry = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/src/runner.ts"));
		const sourceConfig = fileURLToPath(new URL("../../../../tsconfig.base.json", import.meta.url));
		const registration = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register({ tsconfig: ${JSON.stringify(sourceConfig)} });`;
		return [
			process.execPath,
			"--import",
			`data:text/javascript,${encodeURIComponent(registration)}`,
			sourceEntry
		];
	}
};
//#endregion
export { LocalSandboxProvider, LocalSandboxProvider as default };
