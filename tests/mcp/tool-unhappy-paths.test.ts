import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import { createMcpServer } from '../../src/mcp';
import { getWorkspaceDatabase, closeAllDatabases } from '../../src/engine/database';
import { syncWorkspace } from '../../src/engine/storage/delta-sync';

const FIXTURES_DIR = join(import.meta.dir, '../fixtures');
const VUE_APP_DIR = join(import.meta.dir, '../mock-projects/vue-app');

describe('MCP Tools Unhappy Paths & Edge Cases Suite', () => {
  let server: ReturnType<typeof createMcpServer>;

  beforeAll(async () => {
    server = createMcpServer();
    getWorkspaceDatabase(FIXTURES_DIR, { create: true });
    await syncWorkspace(FIXTURES_DIR);
  });

  afterAll(() => {
    closeAllDatabases();
  });

  const callTool = async (name: string, args: Record<string, any>) => {
    const handler = (server as any)._requestHandlers?.get('tools/call');
    return handler({ method: 'tools/call', params: { name, arguments: args } });
  };

  // ==========================================
  // Tool 1: find_code
  // ==========================================
  describe('Tool 1: find_code Unhappy Paths', () => {
    it('rejects empty or whitespace-only patterns', async () => {
      const res = await callTool('find_code', {
        pattern: '   ',
        path: FIXTURES_DIR,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Pattern cannot be empty or whitespace only');
    });

    it('rejects unsupported action (e.g. action: "dump_ast")', async () => {
      const res = await callTool('find_code', {
        action: 'dump_ast',
        code: 'const a = 1;',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Invalid action: must be 'search' or 'map'.");
    });

    it('rejects code snippet without pattern or rule_yaml', async () => {
      const res = await callTool('find_code', {
        code: 'const a = 1;',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Missing required argument 'pattern' or 'rule_yaml'");
    });

    it('accepts action: "map" even when client passes default mode: "ast"', async () => {
      const res = await callTool('find_code', {
        action: 'map',
        path: FIXTURES_DIR,
        mode: 'ast',
        limit: 5,
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toBeDefined();
    });

    it('rejects action: "map" when conflicting search arguments are provided', async () => {
      const res = await callTool('find_code', {
        action: 'map',
        path: FIXTURES_DIR,
        pattern: 'defineProps',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("'action: map' accepts a path, limit, offset, and exclude_dirs only.");
    });
  });

  // ==========================================
  // Tool 2: inspect_component
  // ==========================================
  describe('Tool 2: inspect_component Unhappy Paths', () => {
    it('rejects sfc_sections on non-Vue files (.ts)', async () => {
      const res = await callTool('inspect_component', {
        path: join(FIXTURES_DIR, 'Barrel.ts'),
        sfc_sections: true,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("'sfc_sections' is only available for .vue files");
    });

    it('extracts sfc_sections correctly on valid Vue SFC', async () => {
      const res = await callTool('inspect_component', {
        path: join(FIXTURES_DIR, 'NewButton.vue'),
        sfc_sections: true,
      });
      expect(res.isError).toBeFalsy();
      expect(res.content[0].text).toContain('Vue SFC blocks');
      expect(res.content[0].text).toContain('template');
      expect(res.content[0].text).toContain('script');
    });

    it('handles malformed Vue SFC with unclosed template tag without crashing', async () => {
      const tempFile = join(FIXTURES_DIR, 'MalformedTemp.vue');
      await fs.writeFile(tempFile, '<template><div><span>unclosed</div></template><script setup>const x = 1;</script>', 'utf8');
      try {
        const res = await callTool('inspect_component', {
          path: tempFile,
          sfc_sections: true,
        });
        expect(res.isError).toBeFalsy();
        expect(res.content[0].text).toContain('Vue SFC blocks');
      } finally {
        await fs.unlink(tempFile).catch(() => {});
      }
    });

    it('rejects view: "source" when source_ref is missing', async () => {
      const res = await callTool('inspect_component', {
        path: join(FIXTURES_DIR, 'NewButton.vue'),
        view: 'source',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("'view: source' requires a source_ref returned by 'view: map'.");
    });

    it('rejects conflicting view options when view: "map" is combined with symbol extraction', async () => {
      const res = await callTool('inspect_component', {
        path: join(FIXTURES_DIR, 'NewButton.vue'),
        view: 'map',
        symbol: 'buttonProps',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("'view' cannot be combined with");
    });

    it('rejects inverted source_range where start_line > end_line', async () => {
      const res = await callTool('inspect_component', {
        path: join(FIXTURES_DIR, 'NewButton.vue'),
        source_range: { start_line: 20, end_line: 5 },
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("'source_range' requires positive integer start_line and end_line, with end_line >= start_line");
    });

    it('rejects target path that points to a directory', async () => {
      const res = await callTool('inspect_component', {
        path: FIXTURES_DIR,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("is a directory");
    });
  });

  // ==========================================
  // Tool 3: get_component_tree
  // ==========================================
  describe('Tool 3: get_component_tree Unhappy Paths', () => {
    it('returns error when both entry_path and route are omitted', async () => {
      const res = await callTool('get_component_tree', {
        target_path: FIXTURES_DIR,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("provide 'entry_path'");
    });

    it('returns error with suggestions when route does not match any registered routes', async () => {
      const res = await callTool('get_component_tree', {
        target_path: FIXTURES_DIR,
        route: '/non-existent-route-xyz',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('could not be resolved');
    });

    it('returns NOT_INDEXED or not found error when entry_path does not exist', async () => {
      const res = await callTool('get_component_tree', {
        target_path: FIXTURES_DIR,
        entry_path: join(FIXTURES_DIR, 'GhostComponentNonExistent.vue'),
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/not found|NOT_INDEXED/i);
    });
  });

  // ==========================================
  // Tool 4: trace_state
  // ==========================================
  describe('Tool 4: trace_state Unhappy Paths', () => {
    it('returns error when state identifier is omitted without path', async () => {
      const res = await callTool('trace_state', {
        target_path: FIXTURES_DIR,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Missing required argument: 'identifier'");
    });

    it('returns error when state identifier is whitespace only', async () => {
      const res = await callTool('trace_state', {
        target_path: FIXTURES_DIR,
        identifier: '   ',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain("Missing required argument: 'identifier'");
    });

    it('returns NOT_INDEXED status when target workspace is unindexed', async () => {
      const emptyTmp = await fs.mkdtemp(join(tmpdir(), 'strata-unindexed-'));
      try {
        const res = await callTool('trace_state', {
          target_path: emptyTmp,
          identifier: 'useAuth',
        });
        expect(res.content[0].text).toContain('NOT_INDEXED');
      } finally {
        await fs.rm(emptyTmp, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  // ==========================================
  // Tool 5: audit_frontend
  // ==========================================
  describe('Tool 5: audit_frontend Unhappy Paths', () => {
    it('rejects unsupported or unknown audit target enum', async () => {
      const res = await callTool('audit_frontend', {
        target_path: FIXTURES_DIR,
        target: 'security-audit-unknown',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid audit target: "security-audit-unknown"');
    });

    it('rejects removed archetype-drift target', async () => {
      const res = await callTool('audit_frontend', {
        target_path: FIXTURES_DIR,
        target: 'archetype-drift',
        path: FIXTURES_DIR,
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid audit target');
    });
  });

  // ==========================================
  // Tool 6: generate_patch_plan
  // ==========================================
  describe('Tool 6: generate_patch_plan Unhappy Paths', () => {
    it('rejects when component_path/path argument is missing', async () => {
      const res = await callTool('generate_patch_plan', {
        target_path: FIXTURES_DIR,
        refactor_type: 'rename_prop',
        old_name: 'title',
        new_name: 'header',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Either "component_path" or "path"');
    });

    it('rejects when refactor_type is unsupported', async () => {
      const res = await callTool('generate_patch_plan', {
        path: join(FIXTURES_DIR, 'NewButton.vue'),
        target_path: FIXTURES_DIR,
        refactor_type: 'unsupported_refactor_op' as any,
        old_name: 'foo',
        new_name: 'bar',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Invalid refactor_type');
    });

    it('rejects rename_prop when new_name is missing', async () => {
      const res = await callTool('generate_patch_plan', {
        path: join(FIXTURES_DIR, 'NewButton.vue'),
        target_path: FIXTURES_DIR,
        refactor_type: 'rename_prop',
        old_name: 'title',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('"new_name" is required');
    });

    it('handles non-existent component path returning failure diagnostic without crashing', async () => {
      const res = await callTool('generate_patch_plan', {
        path: join(FIXTURES_DIR, 'NonExistentButton.vue'),
        target_path: FIXTURES_DIR,
        refactor_type: 'rename_prop',
        old_name: 'title',
        new_name: 'heading',
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/not found|ENOENT/i);
    });
  });
});
