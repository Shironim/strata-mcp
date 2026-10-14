import { describe, it, expect } from 'bun:test';
import { auditFrontendTool } from '../../src/tools';
import { resolve } from 'node:path';

describe('strata MCP tools parity (audit_frontend routes & api-contracts)', () => {
  const fixtureDir = resolve(import.meta.dir, '../fixtures');

  it('executes routes target and returns structured text manifest', async () => {
    const response = await auditFrontendTool.handler({
      target: 'routes',
      targetPath: fixtureDir,
      view: 'summary',
    });

    expect(response).toBeDefined();
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
  });

  it('executes api-contracts target and returns extracted endpoint contracts', async () => {
    const response = await auditFrontendTool.handler({
      target: 'api-contracts',
      targetPath: fixtureDir,
    });

    expect(response).toBeDefined();
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
  });
});
