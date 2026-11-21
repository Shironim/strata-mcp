import { basename, extname } from 'node:path';
import type { RouteType } from '../../types';

const NEXT_APP_EXTENSIONS = new Set(['.tsx', '.jsx', '.js', '.ts']);
const NEXT_APP_TYPES = new Map<string, RouteType>([
  ['page', 'page'], ['layout', 'layout'], ['loading', 'loading'],
  ['error', 'error'], ['global-error', 'error'], ['not-found', 'not-found'],
  ['template', 'template'], ['default', 'default'],
]);

export function nextAppFileType(file: string): RouteType | undefined {
  const ext = extname(file);
  if (!NEXT_APP_EXTENSIONS.has(ext)) return;
  const name = basename(file, ext);
  if (name === 'route' && (ext === '.ts' || ext === '.js')) return 'api';
  return NEXT_APP_TYPES.get(name);
}

