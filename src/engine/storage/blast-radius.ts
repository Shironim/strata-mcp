import { Database } from 'bun:sqlite';
import { normalize } from 'node:path';

export interface UpwardBlastRadiusNode {
  path: string;
  framework: string;
  isPage: boolean;
  depth: number;
}

/**
 * Queries the upward blast radius (consumers up to pages) using SQLite Recursive CTE.
 */
export function queryUpwardBlastRadiusFromDb(
  db: Database,
  targetPath: string,
  maxDepth: number = 5
): UpwardBlastRadiusNode[] {
  const normTarget = normalize(targetPath);
  const target = db
    .query('SELECT id FROM files WHERE path = ?')
    .get(normTarget) as { id: number } | null;
  if (!target) return [];

  const rows = db
    .query(
      `
    WITH RECURSIVE blast_radius(file_id, depth) AS (
      SELECT parent_file_id, 1 FROM edges WHERE child_file_id = ?
      UNION
      SELECT e.parent_file_id, b.depth + 1
      FROM edges e JOIN blast_radius b ON e.child_file_id = b.file_id
      WHERE b.depth < ?
    )
    SELECT DISTINCT f.path, f.framework, f.is_page, b.depth
    FROM blast_radius b
    JOIN files f ON b.file_id = f.id
    ORDER BY b.depth ASC, f.is_page DESC;
  `
    )
    .all(target.id, maxDepth) as Array<{
    path: string;
    framework: string;
    is_page: number;
    depth: number;
  }>;

  return rows.map((r) => ({
    path: r.path,
    framework: r.framework,
    isPage: r.is_page === 1,
    depth: r.depth,
  }));
}

/**
 * Queries unused/orphan components directly using an SQL anti-join.
 */
export function queryUnusedComponentsFromDb(
  db: Database
): Array<{ name: string; path: string; framework: string }> {
  const rows = db
    .query(
      `
    SELECT c.name, f.path, f.framework
    FROM components c
    JOIN files f ON c.file_id = f.id
    LEFT JOIN edges e ON c.file_id = e.child_file_id
    WHERE e.child_file_id IS NULL AND f.is_page = 0 AND f.is_layout = 0
    ORDER BY c.name ASC;
  `
    )
    .all() as Array<{ name: string; path: string; framework: string }>;

  return rows;
}
