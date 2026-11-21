import pkg from '../package.json';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import vueDom from '@vue/compiler-dom/package.json';
import vueSfc from '@vue/compiler-sfc/package.json';
import ignore from 'ignore/package.json';
import { VERSION as svelteVersion } from 'svelte/compiler';
import { computeAnalysisSourceFingerprint } from './analysis-source-fingerprint';

export const STRATA_VERSION: string = pkg.version;
declare const __STRATA_ANALYSIS_SOURCE__: string;

const sourceFingerprint = typeof __STRATA_ANALYSIS_SOURCE__ === 'string'
  ? __STRATA_ANALYSIS_SOURCE__
  : computeAnalysisSourceFingerprint(import.meta.dir + '/..');
export const ANALYSIS_FINGERPRINT = createHash('sha256').update(JSON.stringify([
  sourceFingerprint, ts.version, vueDom.version, vueSfc.version, svelteVersion, ignore.version,
])).digest('hex');
export const ENGINE_BUILD_FINGERPRINT = ANALYSIS_FINGERPRINT.slice(0, 16);

export const FULL_ENGINE_REVISION: string = `${STRATA_VERSION}+${ENGINE_BUILD_FINGERPRINT}`;
