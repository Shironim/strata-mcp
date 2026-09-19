/**
 * Database Facade (Strata MCP Engine)
 *
 * Backward-compatible facade re-exporting SQLite schema, delta sync,
 * blast radius queries, and state persistence operations from `src/engine/storage/`.
 */

export * from './storage/schema';
export { getWorkspaceDatabase as getDatabase } from './storage/schema';
export * from './storage/delta-sync';
export * from './storage/blast-radius';
export * from './storage/state-storage';
