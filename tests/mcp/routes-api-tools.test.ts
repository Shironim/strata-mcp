import { describe, it, expect } from 'bun:test';
import { getRoutesTool } from '../../src/tools/get-routes';
import { getApiContractsTool } from '../../src/tools/get-api-contracts';
import { resolve } from 'node:path';

describe('strata MCP tools parity (get_routes & get_api_contracts)', () => {
  const fixtureDir = resolve(import.meta.dir, '../fixtures');

  it('executes get_routes tool and returns structured text manifest', async () => {
    const response = await getRoutesTool.handler({
      targetPath: fixtureDir,
      view: 'summary',
    });

    expect(response).toBeDefined();
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
  });

  it('executes get_api_contracts tool and returns extracted endpoint contracts', async () => {
    const response = await getApiContractsTool.handler({
      targetPath: fixtureDir,
    });

    expect(response).toBeDefined();
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe('text');
    expect(typeof response.content[0].text).toBe('string');
  });
});
