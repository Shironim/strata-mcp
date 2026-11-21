import { isOwnedNextAppFile, resolveProjectOwnership } from '../project-ownership';
import type { ProjectOwnershipInfo } from '../../types';
import { nextAppFileType } from './next-app-file';

/**
 * Checks if a file path is a page or route file based on common framework conventions.
 */
export function isPageFile(filePath: string, ownership?: ProjectOwnershipInfo): boolean {
  const norm = filePath.replace(/\\/g, '/');
  const inAppDirectory = /(?:^|\/)app\//.test(norm);
  const context = inAppDirectory ? ownership ?? resolveProjectOwnership(filePath) : undefined;
  if (context && isOwnedNextAppFile(filePath, context)) return nextAppFileType(filePath) === 'page';
  if (/\/(?:Pages|pages|Views|views)\/(?:.*\/)?(?:Partials|partials|Components|components)\//.test(norm)) {
    return false;
  }
  return (
    norm.includes('/pages/') ||
    norm.includes('/Pages/') ||
    norm.includes('/views/') ||
    norm.includes('/Views/') ||
    norm.includes('/routes/') ||
    (context?.applicationFramework !== 'next' && norm.includes('/app/') &&
      (norm.endsWith('/page.tsx') ||
        norm.endsWith('/page.jsx') ||
        norm.endsWith('/page.vue') ||
        norm.endsWith('/page.js')))
  );
}

