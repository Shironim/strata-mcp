import { describe, expect, it } from 'bun:test';
import { formatTreeAsMermaid } from '../../src/engine/tree';
import type { ComponentTreeResult } from '../../src/types';

describe('Mermaid Topology Export in Component Tree', () => {
  it('formats downward component tree as Mermaid flowchart syntax', () => {
    const mockTree: ComponentTreeResult = {
      root: {
        component: 'DashboardPage',
        filePath: '/src/pages/DashboardPage.vue',
        isPage: true,
        children: [
          {
            component: 'Header',
            filePath: '/src/components/Header.vue',
            children: [
              {
                component: 'UserAvatar',
                filePath: '/src/components/UserAvatar.vue',
                passedProps: [{ propName: 'src' }, { propName: 'alt' }],
                children: [],
              },
            ],
          },
          {
            component: 'LazyChart',
            filePath: '/src/components/LazyChart.vue',
            isDynamic: true,
            children: [],
          },
        ],
      },
      totalComponents: 4,
      maxDepthReached: 2,
      direction: 'downward',
    };

    const mermaid = formatTreeAsMermaid(mockTree);
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('DashboardPage (Root)');
    expect(mermaid).toContain('Header');
    expect(mermaid).toContain('UserAvatar');
    expect(mermaid).toContain('LazyChart');
    expect(mermaid).toContain('-.->'); // Dynamic relation
    expect(mermaid).toContain('-->|"src, alt"|'); // Passed props
    expect(mermaid).toContain('classDef rootNode');
  });

  it('formats upward component tree with target marker', () => {
    const mockTree: ComponentTreeResult = {
      root: {
        component: 'Button',
        filePath: '/src/components/Button.vue',
        children: [
          {
            component: 'FormModal',
            filePath: '/src/components/FormModal.vue',
            children: [
              {
                component: 'CheckoutPage',
                filePath: '/src/pages/CheckoutPage.vue',
                isPage: true,
                children: [],
              },
            ],
          },
        ],
      },
      totalComponents: 3,
      maxDepthReached: 2,
      direction: 'upward',
    };

    const mermaid = formatTreeAsMermaid(mockTree);
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('Button (Target)');
    expect(mermaid).toContain('FormModal');
    expect(mermaid).toContain('CheckoutPage [Page]');
  });

  it('renders Mermaid flowchart from componentTreeTool handler with format="mermaid"', async () => {
    const { componentTreeTool } = await import('../../src/tools/component-tree');
    const { join } = await import('node:path');
    const pagePath = join(import.meta.dir, '../fixtures/PageOne.vue');
    const res = await componentTreeTool.handler({
      entry_path: pagePath,
      format: 'mermaid',
      max_depth: 2,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('graph TD');
    expect(res.content[0].text).toContain('PageOne.vue (Root)');
  });
});
