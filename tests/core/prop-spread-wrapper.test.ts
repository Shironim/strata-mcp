import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getComponentTree, formatTreeAsText, formatTreeAsMermaid } from '../../src/engine/tree';
import { generatePatchPlan } from '../../src/engine/patch-plan';

describe('1-Hop Prop Spread Cascading Wrapper Detection', () => {
  it('detects cascading spread wrappers in component tree and renders spread tags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'strata-wrapper-test-'));
    try {
      const buttonFile = join(root, 'Button.tsx');
      const iconButtonFile = join(root, 'IconButton.tsx');
      const pageFile = join(root, 'Page.tsx');

      await writeFile(
        buttonFile,
        `import React from 'react';
export function Button(props: { variant?: string; children?: React.ReactNode }) {
  return <button>{props.children}</button>;
}`
      );

      await writeFile(
        iconButtonFile,
        `import React from 'react';
import { Button } from './Button';

export function IconButton({ icon, ...props }: { icon: string; [key: string]: any }) {
  return <Button {...props}>{icon}</Button>;
}`
      );

      await writeFile(
        pageFile,
        `import React from 'react';
import { IconButton } from './IconButton';

export function Page() {
  return <IconButton icon="star" />;
}`
      );

      // 1. Downward tree from Page
      const downward = await getComponentTree({
        entryPath: pageFile,
        direction: 'downward',
        targetPath: root,
      });

      const iconBtnNode = downward.root.children.find((c) => c.filePath.includes('IconButton'));
      expect(iconBtnNode).toBeDefined();

      const btnNode = iconBtnNode?.children.find((c) => c.filePath.includes('Button'));
      expect(btnNode).toBeDefined();
      expect(btnNode?.isCascadingWrapper).toBe(true);

      const treeText = formatTreeAsText(downward);
      expect(treeText).toContain('cascading-wrapper: spread');

      const mermaid = formatTreeAsMermaid(downward);
      expect(mermaid).toContain('|"...spread"|');

      // 2. Upward tree from Button
      const upward = await getComponentTree({
        entryPath: buttonFile,
        direction: 'upward',
        targetPath: root,
      });

      const upwardWrapper = upward.root.children.find((c) => c.filePath.includes('IconButton'));
      expect(upwardWrapper).toBeDefined();
      expect(upwardWrapper?.isCascadingWrapper).toBe(true);

      // 3. generatePatchPlan on Button flags cascading wrapper warning
      const plan = await generatePatchPlan({
        componentPath: buttonFile,
        refactorType: 'rename_prop',
        oldName: 'variant',
        newName: 'tone',
        targetPath: root,
      });

      const spreadOmission = plan.coverage.omissions.find((o) => o.code === 'DYNAMIC_PROP_SPREAD');
      expect(spreadOmission).toBeDefined();
      expect(spreadOmission?.file).toBe(iconButtonFile);
      expect(spreadOmission?.message).toContain('acts as cascading wrapper');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
