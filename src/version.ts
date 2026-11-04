import pkg from '../package.json';
import { createHash } from 'node:crypto';
import ts from 'typescript';

export const STRATA_VERSION: string = pkg.version;

export const ENGINE_BUILD_FINGERPRINT: string = createHash('sha256')
  .update(STRATA_VERSION)
  .update('\0ts:' + ts.version)
  .update('\0vue:' + ((pkg as any).dependencies?.['@vue/compiler-dom'] ?? 'unknown'))
  .digest('hex')
  .slice(0, 16);

export const FULL_ENGINE_REVISION: string = `${STRATA_VERSION}+${ENGINE_BUILD_FINGERPRINT}`;
