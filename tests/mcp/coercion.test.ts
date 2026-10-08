import { describe, expect, it } from 'bun:test';
import { coerceToolArguments } from '../../src/mcp';
import {
  createSuccessEnvelope,
  createNotFoundEnvelope,
  createErrorEnvelope,
} from '../../src/tools/types';

describe('MCP Input Coercion & Contract Standardization', () => {
  it('coerces bare string to path for inspect_component and component tree tools', () => {
    expect(coerceToolArguments('inspect_component', 'src/components/MyButton.vue')).toEqual({
      path: 'src/components/MyButton.vue',
    });

    expect(coerceToolArguments('get_component_tree', 'src/App.vue')).toEqual({
      path: 'src/App.vue',
    });

    expect(coerceToolArguments('audit_frontend', './src')).toEqual({
      path: './src',
    });
  });

  it('coerces bare string to pattern for find_code based on content', () => {
    // AST pattern
    expect(coerceToolArguments('find_code', 'ref($$$)')).toEqual({
      pattern: 'ref($$$)',
    });

    // File path or filename coerced to pattern to prevent missing pattern error
    expect(coerceToolArguments('find_code', './src/components/Button.vue')).toEqual({
      pattern: './src/components/Button.vue',
    });
  });

  it('coerces bare string to identifier or path for trace_state', () => {
    expect(coerceToolArguments('trace_state', 'activeUserId')).toEqual({
      identifier: 'activeUserId',
    });

    expect(coerceToolArguments('trace_state', '/home/user/App.vue')).toEqual({
      path: '/home/user/App.vue',
    });
  });

  it('normalizes entity aliases to canonical keys', () => {
    const raw = {
      file_path: 'src/components/Card.vue',
      query: 'const $$$ = $$$',
      symbol_name: 'getUser',
      component_name: 'OldCard',
      workspace_root: '/project/root',
    };

    const coerced = coerceToolArguments('find_code', raw);
    expect(coerced.path).toBe('src/components/Card.vue');
    expect(coerced.pattern).toBe('const $$$ = $$$');
    expect(coerced.symbol).toBe('getUser');
    expect(coerced.component).toBe('OldCard');
    expect(coerced.root).toBe('/project/root');
  });

  it('creates standardized diagnostic envelopes', () => {
    const successRes = createSuccessEnvelope({ count: 42 }, 'Found 42 items');
    const parsedSuccess = JSON.parse(successRes.content[0].text);
    expect(parsedSuccess.success).toBe(true);
    expect(parsedSuccess.found).toBe(true);
    expect(parsedSuccess.data.count).toBe(42);
    expect(parsedSuccess.summary).toBe('Found 42 items');

    const notFoundRes = createNotFoundEnvelope('Component not found', ['Button.vue', 'Card.vue']);
    const parsedNotFound = JSON.parse(notFoundRes.content[0].text);
    expect(parsedNotFound.success).toBe(true);
    expect(parsedNotFound.found).toBe(false);
    expect(parsedNotFound.error).toBe('Component not found');
    expect(parsedNotFound.suggestions).toEqual(['Button.vue', 'Card.vue']);

    const errRes = createErrorEnvelope('Syntax error');
    expect(errRes.isError).toBe(true);
    const parsedErr = JSON.parse(errRes.content[0].text);
    expect(parsedErr.success).toBe(false);
    expect(parsedErr.found).toBe(false);
  });

  it('coerces bare string for get_routes and get_api_contracts to path', () => {
    expect(coerceToolArguments('get_routes', '.')).toEqual({
      path: '.',
    });
    expect(coerceToolArguments('get_api_contracts', './src')).toEqual({
      path: './src',
    });
  });

  it('preserves and synchronizes aliases bidirectionally in object mode', () => {
    // Legacy alias to canonical path
    const routesRes = coerceToolArguments('get_routes', { targetPath: '.' });
    expect(routesRes.path).toBe('.');
    expect(routesRes.targetPath).toBe('.');

    const apiRes = coerceToolArguments('get_api_contracts', { target_path: '.' });
    expect(apiRes.path).toBe('.');
    expect(apiRes.target_path).toBe('.');

    const treeRes = coerceToolArguments('get_component_tree', { entry_path: 'src/App.vue' });
    expect(treeRes.path).toBe('src/App.vue');
    expect(treeRes.entry_path).toBe('src/App.vue');

    // Canonical path populates legacy aliases
    const canonicalTree = coerceToolArguments('get_component_tree', { path: 'src/App.vue' });
    expect(canonicalTree.entry_path).toBe('src/App.vue');
    expect(canonicalTree.targetPath).toBe('src/App.vue');
  });
});


