/** Task-local write authority excludes ambient extra roots and shared temporary directories. */
export const codexTaskWriteConfig = {
  'sandbox_workspace_write.writable_roots': [],
  'sandbox_workspace_write.exclude_tmpdir_env_var': true,
  'sandbox_workspace_write.exclude_slash_tmp': true,
} as const
