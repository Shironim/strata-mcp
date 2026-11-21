export function isSqliteBusy(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'SQLITE_BUSY' ||
    (error instanceof Error && ['locked', 'busy', 'SQLITE_BUSY'].some(text => error.message.includes(text)));
}
