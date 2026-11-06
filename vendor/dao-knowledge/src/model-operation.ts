/** Model guidance for choosing Brain retry identities without terminal commands. */

/** Shared parameter guidance; callers still supply required operation IDs. */
export const OPERATION_ID_DESCRIPTION = 'Use a supplied UUID when provided; otherwise write a fresh UUID directly in the arguments. '
  + 'Do not run terminal commands or call another tool to generate it. Keep the UUID and every original input unchanged for retries.'
