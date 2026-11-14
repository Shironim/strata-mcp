import { stripQuotes } from '../patterns';
import type { ComponentPropContract, ComponentVariantsInfo } from '../../types';

/**
 * Extracts a balanced curly-brace object string starting at the specified index or first '{' after it.
 */
export function extractBalancedObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString: string | null = null;
  let started = false;
  let startPos = -1;

  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') {
      if (!started) {
        started = true;
        startPos = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        return text.slice(startPos, i + 1);
      }
    }
  }
  return null;
}

/**
 * Extracts top-level keys from an object literal code snippet while ignoring string literals and nested values.
 */
export function extractObjectKeys(objCode: string): string[] {
  const keys: string[] = [];
  const inner = objCode.trim().slice(1, -1);
  let inString: string | null = null;
  let currentKey = '';
  let collectingKey = true;
  let depth = 0;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      continue;
    }

    if (depth === 0) {
      if (ch === ':') {
        const trimmed = stripQuotes(currentKey.trim());
        if (trimmed && !trimmed.includes('\n') && !trimmed.includes(' ')) {
          keys.push(trimmed);
        }
        collectingKey = false;
        currentKey = '';
      } else if (ch === ',') {
        collectingKey = true;
        currentKey = '';
      } else if (collectingKey) {
        currentKey += ch;
      }
    }
  }

  return keys;
}

/**
 * Extracts Design System variants defined via CVA (Class Variance Authority) or TypeScript prop unions.
 */
export function extractComponentVariants(
  content: string,
  props: ComponentPropContract[] = []
): ComponentVariantsInfo | undefined {
  // 1. Try CVA pattern: look for cva( ... )
  const cvaIndex = content.indexOf('cva(');
  if (cvaIndex !== -1) {
    const firstBrace = content.indexOf('{', cvaIndex);
    if (firstBrace !== -1) {
      const configObj = extractBalancedObject(content, firstBrace);
      if (configObj) {
        const variants: Record<string, string[]> = {};
        let defaultVariants: Record<string, string> | undefined;

        // Look for variants: { ... } inside configObj
        const variantsKeyword = configObj.match(/\bvariants\s*:\s*\{/);
        if (variantsKeyword && variantsKeyword.index !== undefined) {
          const variantsBrace = configObj.indexOf('{', variantsKeyword.index);
          const variantsObj = extractBalancedObject(configObj, variantsBrace);
          if (variantsObj) {
            // Match groupName: { ... }
            const groupHeaderRegex = /\b([A-Za-z0-9_$]+)\s*:\s*\{/g;
            for (const gm of variantsObj.matchAll(groupHeaderRegex)) {
              const groupName = gm[1];
              if (groupName === 'defaultVariants' || groupName === 'compoundVariants') continue;
              const groupBrace = variantsObj.indexOf('{', gm.index);
              const groupBody = extractBalancedObject(variantsObj, groupBrace);
              if (groupBody) {
                const optKeys = extractObjectKeys(groupBody);
                if (optKeys.length > 0) {
                  variants[groupName] = optKeys;
                }
              }
            }
          }
        }

        // Look for defaultVariants: { ... } inside configObj
        const defKeyword = configObj.match(/\bdefaultVariants\s*:\s*\{/);
        if (defKeyword && defKeyword.index !== undefined) {
          const defBrace = configObj.indexOf('{', defKeyword.index);
          const defObj = extractBalancedObject(configObj, defBrace);
          if (defObj) {
            const defMap: Record<string, string> = {};
            const defPairs = defObj
              .slice(1, -1)
              .matchAll(/([A-Za-z0-9_$]+)\s*:\s*['"]?([A-Za-z0-9_$-]+)['"]?/g);
            for (const dm of defPairs) {
              defMap[dm[1]] = stripQuotes(dm[2].trim());
            }
            if (Object.keys(defMap).length > 0) {
              defaultVariants = defMap;
            }
          }
        }

        if (Object.keys(variants).length > 0) {
          return { variants, defaultVariants };
        }
      }
    }
  }

  // 2. Fallback: inspect props with union string literals (e.g. variant: 'primary' | 'secondary' | 'outline')
  const unionVariants: Record<string, string[]> = {};
  for (const prop of props) {
    if (prop.name === 'variant' || prop.name === 'size' || prop.name === 'intent' || prop.name === 'color') {
      if (prop.type && prop.type.includes('|')) {
        const parts = prop.type
          .split('|')
          .map((p) => stripQuotes(p.trim()))
          .filter((p) => p && !['undefined', 'null', 'string', 'boolean', 'number', 'any'].includes(p));
        if (parts.length > 1) {
          unionVariants[prop.name] = parts;
        }
      }
    }
  }

  if (Object.keys(unionVariants).length > 0) {
    return { variants: unionVariants };
  }

  return undefined;
}
