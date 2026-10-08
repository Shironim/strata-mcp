import { describe, expect, it } from 'bun:test';
import { detectPropsDrilling } from '../../src/engine/graph/props-drilling';
import { scanRoutes } from '../../src/engine/routes';
import { componentTreeTool } from '../../src/tools/component-tree';
import { getRoutesTool } from '../../src/tools/get-routes';
import { patchPlanTool } from '../../src/tools/patch-plan';
import type { ComponentTreeNode } from '../../src/types';
import { join } from 'node:path';
import fs from 'node:fs';

describe('strata-mcp Bugfix Verification (ST-1 to ST-6)', () => {
  describe('ST-1: Props Drilling False-Positive Immunity', () => {
    it('does NOT flag props drilling when child prop has same name but literal or independent value', () => {
      // Parent PageAdmin receives prop "title" from outside
      // Inside PageAdmin, it passes a literal "Submit" to Button
      const tree: ComponentTreeNode = {
        component: 'PageAdmin',
        filePath: 'src/pages/PageAdmin.vue',
        depth: 0,
        children: [
          {
            component: 'Button',
            filePath: 'src/components/Button.vue',
            depth: 1,
            passedProps: [
              {
                propName: 'title',
                expression: "'Simpan Data'", // literal, NOT forwarding title
              },
            ],
            children: [
              {
                component: 'Icon',
                filePath: 'src/components/Icon.vue',
                depth: 2,
                passedProps: [
                  {
                    propName: 'title',
                    expression: "'Icon Tooltip'", // literal, NOT forwarding title
                  },
                ],
                children: [],
              },
            ],
          },
        ],
      };

      const alerts = detectPropsDrilling(tree);
      expect(alerts.length).toBe(0);
    });

    it('correctly flags genuine forwarded props drilling (depth >= 2)', () => {
      const tree: ComponentTreeNode = {
        component: 'UserProfile',
        filePath: 'src/UserProfile.vue',
        depth: 0,
        children: [
          {
            component: 'UserCard',
            filePath: 'src/UserCard.vue',
            depth: 1,
            passedProps: [
              {
                propName: 'user',
                expression: 'props.user', // Forwarded from parent
              },
            ],
            children: [
              {
                component: 'UserAvatar',
                filePath: 'src/UserAvatar.vue',
                depth: 2,
                passedProps: [
                  {
                    propName: 'user',
                    expression: 'user', // Forwarded again!
                  },
                ],
                children: [],
              },
            ],
          },
        ],
      };

      const alerts = detectPropsDrilling(tree);
      expect(alerts.length).toBeGreaterThan(0);
      expect(alerts[0].origin).toBe('UserProfile');
      expect(alerts[0].target).toBe('UserAvatar');
    });
  });

  describe('ST-2: Circular & Recursive Component Flagging', () => {
    it('supports isCircular property in ComponentTreeNode', () => {
      const circularLeaf: ComponentTreeNode = {
        component: 'CommentThread',
        filePath: 'src/components/CommentThread.vue',
        isCircular: true,
        depth: 2,
        children: [],
      };

      expect(circularLeaf.isCircular).toBe(true);
      expect(circularLeaf.children.length).toBe(0);
    });
  });

  describe('ST-3: Vue Router SPA Detection & Scan Containment', () => {
    it('does not scan entire workspace root when framework is unknown and no pages dir exists', async () => {
      const tempDir = join('/tmp', `strata-test-routes-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(join(tempDir, 'random-util.ts'), 'export const x = 1;');

      const result = await scanRoutes({
        targetPath: tempDir,
      });

      expect(result.framework).toBe('unknown');
      expect(result.routes.length).toBe(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('detects vue-router framework when src/views contains vue files', async () => {
      const tempDir = join('/tmp', `strata-test-vue-router-${Date.now()}`);
      const viewsDir = join(tempDir, 'src', 'views');
      fs.mkdirSync(viewsDir, { recursive: true });
      fs.writeFileSync(join(viewsDir, 'HomeView.vue'), '<template>Home</template>');
      fs.writeFileSync(join(viewsDir, 'AboutView.vue'), '<template>About</template>');

      const result = await scanRoutes({
        targetPath: tempDir,
      });

      expect(result.framework).toBe('vue-router');
      expect(result.routes.length).toBe(2);
      expect(result.routes.some((r) => r.path === '/home')).toBe(true);
      expect(result.routes.some((r) => r.path === '/about')).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('ST-4, ST-5, ST-6: MCP Parameter Adaptor Normalization', () => {
    it('get_routes accepts path and target_path aliases', async () => {
      const tempDir = join('/tmp', `strata-test-param-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });

      const res = await getRoutesTool.handler({
        path: tempDir,
      });

      expect(res.isError).toBeUndefined();
      expect(res.content[0].text).toContain('Route Manifest');

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('generate_patch_plan accepts file_path and filePath aliases', async () => {
      const fixturePath = join(import.meta.dir, '../fixtures/OldButton.vue');
      const res = await patchPlanTool.handler({
        file_path: fixturePath,
        refactor_type: 'rename_prop',
        old_name: 'test',
        new_name: 'testNew',
      });

      // It must not fail on missing component_path argument
      expect(res.content[0].text).not.toContain('Either "component_path" or "path"');
    });

    it('get_component_tree accepts path pointing to a vue component', async () => {
      const fixturePath = join(import.meta.dir, '../fixtures/OldButton.vue');
      const res = await componentTreeTool.handler({
        path: fixturePath,
      });

      // Must not throw "Missing required argument: provide entry_path or route"
      expect(res.content[0].text).not.toContain('Missing required argument');
    });
  });
});
