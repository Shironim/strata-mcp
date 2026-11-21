import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { USE_STRATA_SKILL_TEMPLATE } from '../../src/cli/templates';
import { DEFAULT_RESPONSE_BUDGET_BYTES } from '../../src/engine/context-budget';
import {
  getStrataPrompt,
  listStrataPrompts,
  listStrataResources,
  listStrataResourceTemplates,
  readStrataResource,
} from '../../src/resources-and-prompts';
import { TOOLS, findTool } from '../../src/tools';

const fixturesDir = join(import.meta.dir, '../fixtures');

describe('MCP Resources & Prompts Contract', () => {
  test('lists static resources, resource templates, and prompts with valid metadata', () => {
    const { resources } = listStrataResources();
    expect(resources.map((r) => r.uri)).toEqual([
      'strata://project/overview',
      'strata://components/index',
    ]);
    for (const resource of resources) {
      expect(resource.mimeType).toBe('application/json');
    }

    const { resourceTemplates } = listStrataResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual(['strata://component/{name}']);

    const { prompts } = listStrataPrompts();
    expect(prompts.map((p) => p.name)).toEqual([
      'trace-state-bug',
      'safe-component-patch',
      'audit-component-tree',
    ]);
  });

  test('reads project overview, components index, and component template within token budget', async () => {
    for (const uri of [
      'strata://project/overview',
      'strata://components/index',
      'strata://component/PageOne',
      'strata://component/DoesNotExistComponent',
    ]) {
      const result = await readStrataResource(uri, fixturesDir);
      expect(result.contents.length).toBe(1);
      const item = result.contents[0];
      expect(item.uri).toBe(uri);
      expect(item.mimeType).toBe('application/json');
      expect(Buffer.byteLength(item.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_RESPONSE_BUDGET_BYTES);
      const parsed = JSON.parse(item.text);
      expect(parsed.workspaceRoot).toBe(fixturesDir);
      if (uri.endsWith('/PageOne')) {
        expect(parsed.found).toBe(true);
        expect(parsed.matches[0].name).toBe('PageOne');
      }
      if (uri.endsWith('/DoesNotExistComponent')) {
        expect(parsed.found).toBe(false);
        expect(parsed.matches).toEqual([]);
      }
    }
  });

  test('rejects unknown resource URIs and empty component names', async () => {
    await expect(readStrataResource('strata://unknown/resource', fixturesDir)).rejects.toThrow(
      'Unknown resource URI'
    );
    await expect(readStrataResource('strata://component/%20', fixturesDir)).rejects.toThrow(
      'must not be empty'
    );
  });

  test('prompts only reference active tools and valid schema parameters (anti prompt-drift)', async () => {
    const registeredToolNames = new Set(TOOLS.map((t) => t.name));

    const promptCases: Array<{ name: string; args: Record<string, string> }> = [
      { name: 'trace-state-bug', args: { target: 'useAuthStore' } },
      { name: 'safe-component-patch', args: { component: 'PageOne.vue', refactor_type: 'rename_prop' } },
      { name: 'audit-component-tree', args: { entry: '/dashboard' } },
    ];

    for (const testCase of promptCases) {
      const promptResult = await getStrataPrompt(testCase.name, testCase.args, fixturesDir);
      expect(promptResult.messages.length).toBe(2);
      expect(promptResult.messages[0].content.type).toBe('resource');
      const textMessage = promptResult.messages[1].content;
      expect(textMessage.type).toBe('text');
      if (textMessage.type !== 'text') continue;

      // Verify every `Call \`toolName\` with \`{ ... }\`` matches an actual tool and its inputSchema properties
      const callMatches = textMessage.text.matchAll(/Call `([a-z_]+)` with `(\{[^`]+\})`/g);
      let matchedAny = false;
      for (const match of callMatches) {
        matchedAny = true;
        const toolName = match[1];
        const argObjectText = match[2];
        expect(registeredToolNames.has(toolName)).toBe(true);
        const tool = findTool(toolName)!;
        const props = Object.keys(tool.inputSchema.properties ?? {});
        const paramKeys = Array.from(argObjectText.matchAll(/([a-z_]+)\s*:/g)).map((m) => m[1]);
        for (const key of paramKeys) {
          expect(props).toContain(key);
        }
      }
      expect(matchedAny).toBe(true);
    }

    await expect(getStrataPrompt('unknown-prompt', {}, fixturesDir)).rejects.toThrow('Unknown prompt');

    const routePrompt = await getStrataPrompt('audit-component-tree', { entry: '/dashboard' }, fixturesDir);
    expect(routePrompt.messages[1].content.type).toBe('text');
    if (routePrompt.messages[1].content.type === 'text') {
      expect(routePrompt.messages[1].content.text).toContain('route: "/dashboard"');
    }

    const filePrompt = await getStrataPrompt('audit-component-tree', { entry: 'src/App.vue' }, fixturesDir);
    expect(filePrompt.messages[1].content.type).toBe('text');
    if (filePrompt.messages[1].content.type === 'text') {
      expect(filePrompt.messages[1].content.text).toContain('path: "src/App.vue"');
    }
  });

  test('USE_STRATA_SKILL_TEMPLATE stays synchronized with WORKFLOW_PLAYBOOKS and .agents/skills/use-strata/SKILL.md (anti template-drift)', () => {
    const registeredToolNames = new Set(TOOLS.map((t) => t.name));
    expect(USE_STRATA_SKILL_TEMPLATE).toContain('Canonical Workflow Playbooks');

    const repoSkill = readFileSync(join(process.cwd(), '.agents', 'skills', 'use-strata', 'SKILL.md'), 'utf8');
    expect(repoSkill).toBe(USE_STRATA_SKILL_TEMPLATE);

    const callMatches = USE_STRATA_SKILL_TEMPLATE.matchAll(/Call `([a-z_]+)` with `(\{[^`]+\})`/g);
    let matchedAny = false;
    for (const match of callMatches) {
      matchedAny = true;
      const toolName = match[1];
      const argObjectText = match[2];
      expect(registeredToolNames.has(toolName)).toBe(true);
      const tool = findTool(toolName)!;
      const props = Object.keys(tool.inputSchema.properties ?? {});
      const paramKeys = Array.from(argObjectText.matchAll(/([a-z_]+)\s*:/g)).map((m) => m[1]);
      for (const key of paramKeys) {
        expect(props).toContain(key);
      }
    }
    expect(matchedAny).toBe(true);
  });

  test('smart truncation keeps strata://components/index under 16 KB and stays read-only (no .strata/)', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'strata-res-budget-'));
    try {
      const compDir = join(tempDir, 'src', 'features', 'long-domain-segment-for-budget-testing', 'components');
      mkdirSync(compDir, { recursive: true });
      for (let i = 0; i < 220; i++) {
        writeFileSync(join(compDir, `BudgetTestComponentItem${String(i).padStart(3, '0')}.vue`), '<template><div /></template>\n');
      }

      const indexResult = await readStrataResource('strata://components/index', tempDir);
      const item = indexResult.contents[0];
      expect(Buffer.byteLength(item.text, 'utf8')).toBeLessThanOrEqual(DEFAULT_RESPONSE_BUDGET_BYTES);
      const parsed = JSON.parse(item.text);
      expect(parsed.truncated).toBe(true);
      expect(parsed.totalReturned).toBeGreaterThan(0);
      expect(parsed.totalReturned).toBeLessThan(220);

      await readStrataResource('strata://project/overview', tempDir);
      await readStrataResource('strata://component/BudgetTestComponentItem000', tempDir);
      expect(existsSync(join(tempDir, '.strata'))).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
