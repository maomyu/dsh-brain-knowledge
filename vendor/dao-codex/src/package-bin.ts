/** Resolve the maintained Codex wrapper to a filesystem path its native children can use. */
import { dirname, resolve } from 'node:path'

/**
 * Select the package wrapper, using Electron's physical unpacked package tree when archived.
 * @param manifestPath - Resolved Codex package.json path.
 * @param bin - Wrapper path declared by the package manifest.
 * @returns Absolute wrapper path; Electron packaging must unpack the wrapper and platform package.
 */
export function codexPackageBin(manifestPath: string, bin: string): string {
  const wrapper = resolve(dirname(manifestPath), bin)
  return process.versions.electron === undefined ? wrapper : wrapper.replace(/\.asar(?=[\\/])/u, '.asar.unpacked')
}
