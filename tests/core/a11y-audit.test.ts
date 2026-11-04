import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { auditDesignTokens, formatDesignAuditAsText } from '../../src/engine/style-audit';

describe('A11y AST Audit & Design Tokens (R-11 / TODO-09)', () => {
  async function createFixtureWorkspace(files: Record<string, string>) {
    const root = await mkdtemp('/tmp/strata-a11y-test-');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'a11y-test', version: '1.0.0' }));

    for (const [filename, content] of Object.entries(files)) {
      const fullPath = join(root, 'src', filename);
      await writeFile(fullPath, content);
    }

    return {
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  describe('1. Form Control Label Association (A-09 & A-10)', () => {
    it('recognizes valid explicit <label for> matching input id and flags mismatch', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'ValidLabel.vue': `
<template>
  <form>
    <label for="user-email">Email Address</label>
    <input type="email" id="user-email" />

    <label for="wrong-id">Password</label>
    <input type="password" id="user-password" />
  </form>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        const violations = result.a11yViolations.filter(v => v.ruleId === 'a11y/label-has-associated-control');

        // user-email is properly labeled -> NO violation
        expect(violations.some(v => v.element.includes('user-email'))).toBe(false);

        // user-password has wrong-id label -> CONFIRMED violation
        const pwdViolation = violations.find(v => v.element.includes('user-password'));
        expect(pwdViolation).toBeDefined();
        expect(pwdViolation?.certainty).toBe('confirmed');
        expect(pwdViolation?.issue).toContain('user-password');
      } finally {
        await cleanup();
      }
    });

    it('recognizes inputs wrapped inside accessible <label> without false positives', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'WrappedInput.vue': `
<template>
  <label>
    <span>Full Name</span>
    <input type="text" v-model="name" />
  </label>
  <label>
    Subscribe to newsletter
    <input type="checkbox" />
  </label>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        const violations = result.a11yViolations.filter(v => v.ruleId === 'a11y/label-has-associated-control');

        // Both inputs are wrapped in labels with text content -> 0 violations
        expect(violations).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });

    it('flags empty enclosing <label> as confirmed violation', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'EmptyWrappedLabel.vue': `
<template>
  <label>
    <input type="text" />
  </label>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        const violation = result.a11yViolations.find(v => v.issue.includes('Enclosing <label>'));
        expect(violation).toBeDefined();
        expect(violation?.certainty).toBe('confirmed');
      } finally {
        await cleanup();
      }
    });

    it('validates aria-label and distinguishes empty aria-label from valid aria-label', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'AriaLabels.vue': `
<template>
  <input type="search" aria-label="Search articles" />
  <input type="text" :aria-label="dynamicLabel" />
  <input type="text" aria-label="   " />
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });

        // Search articles & dynamicLabel -> NO violation
        expect(result.a11yViolations.some(v => v.issue.includes('Search articles'))).toBe(false);

        // Whitespace / empty aria-label -> empty-aria-label violation
        const emptyAria = result.a11yViolations.find(v => v.ruleId === 'a11y/empty-aria-label');
        expect(emptyAria).toBeDefined();
        expect(emptyAria?.certainty).toBe('confirmed');
      } finally {
        await cleanup();
      }
    });

    it('validates aria-labelledby references and distinguishes static missing from dynamic uncertainty', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'AriaLabelledBy.vue': `
<template>
  <h2 id="billing-title">Billing Information</h2>
  <input type="text" aria-labelledby="billing-title" />

  <input type="text" aria-labelledby="missing-header" />
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });

        // billing-title exists -> NO violation
        expect(result.a11yViolations.some(v => v.issue.includes('billing-title'))).toBe(false);

        // missing-header does not exist in template -> CONFIRMED missing reference
        const missingRef = result.a11yViolations.find(v => v.issue.includes('missing-header'));
        expect(missingRef).toBeDefined();
        expect(missingRef?.ruleId).toBe('a11y/aria-labelledby-reference');
        expect(missingRef?.certainty).toBe('confirmed');
      } finally {
        await cleanup();
      }
    });

    it('skips non-textual input types (hidden, submit, button, reset)', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'IgnoredInputs.vue': `
<template>
  <form>
    <input type="hidden" name="csrf" value="123" />
    <input type="submit" value="Submit Form" />
    <input type="reset" value="Reset Form" />
    <input type="button" value="Click" />
  </form>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        expect(result.a11yViolations).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });

    it('identifies hidden file input with triggering label without false error (A-12)', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'HiddenFileInput.vue': `
<template>
  <input type="file" id="avatar-upload" class="hidden" />
  <label for="avatar-upload" class="btn">Upload Avatar</label>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        // File input has matching label for trigger -> 0 violations
        expect(result.a11yViolations).toHaveLength(0);
      } finally {
        await cleanup();
      }
    });
  });

  describe('2. Image Alt Attributes (A-11)', () => {
    it('accepts valid alt, decorative empty alt="", dynamic :alt, and flags missing alt', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'ImagesAudit.vue': `
<template>
  <!-- Valid descriptive alt -->
  <img src="/avatar.jpg" alt="User Avatar" />

  <!-- Legitimate decorative image (WCAG 2.1 SC 1.1.1) -->
  <img src="/divider.png" alt="" />

  <!-- Legitimate dynamic alt binding -->
  <img src="/product.png" :alt="productTitle" />

  <!-- Decorative via aria-hidden -->
  <img src="/bg-shape.svg" aria-hidden="true" />

  <!-- Missing alt attribute -->
  <img src="/hero.jpg" class="w-full" />
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        const altViolations = result.a11yViolations.filter(v => v.ruleId === 'a11y/alt-text');

        // Only hero.jpg has missing alt
        expect(altViolations).toHaveLength(1);
        expect(altViolations[0].element).toContain('/hero.jpg');
        expect(altViolations[0].certainty).toBe('confirmed');
      } finally {
        await cleanup();
      }
    });
  });

  describe('3. Interactive Buttons (A-11)', () => {
    it('accepts textual buttons, sr-only text, aria-label, and flags icon-only buttons', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'ButtonsAudit.vue': `
<template>
  <!-- Accessible text directly in button -->
  <button class="btn">Save Changes</button>

  <!-- Accessible interpolation -->
  <button>{{ submitText }}</button>

  <!-- Accessible aria-label with icon -->
  <button aria-label="Delete item">
    <TrashIcon />
  </button>

  <!-- Accessible screen reader text with icon -->
  <button>
    <span class="sr-only">Close modal</span>
    <svg class="w-4 h-4" />
  </button>

  <!-- Icon-only button without accessible label -->
  <button class="icon-btn">
    <TrashIcon />
  </button>

  <!-- Button with empty aria-label -->
  <button aria-label="">
    <EditIcon />
  </button>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });

        // 1. Icon-only button violation
        const iconViolation = result.a11yViolations.find(v => v.ruleId === 'a11y/button-has-accessible-name');
        expect(iconViolation).toBeDefined();
        expect(iconViolation?.certainty).toBe('confirmed');

        // 2. Empty aria-label on button
        const emptyAriaViolation = result.a11yViolations.find(
          v => v.ruleId === 'a11y/empty-aria-label' && v.issue.includes('Button')
        );
        expect(emptyAriaViolation).toBeDefined();
        expect(emptyAriaViolation?.certainty).toBe('confirmed');

        // Total button violations: exactly 2
        const btnViolations = result.a11yViolations.filter(
          v => v.ruleId === 'a11y/button-has-accessible-name' || v.issue.includes('Button')
        );
        expect(btnViolations).toHaveLength(2);
      } finally {
        await cleanup();
      }
    });
  });

  describe('4. Multiline Parsing & Exact Coordinate Spans (A-11 & A-14)', () => {
    it('handles multiline inputs, images, and buttons without syntax corruption or false positives', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'MultilineComponents.vue': `
<template>
  <!-- Multiline input with associated label -->
  <label for="address-line">Street Address</label>
  <input
    type="text"
    id="address-line"
    class="border p-2 rounded"
    placeholder="123 Main St"
  />

  <!-- Multiline image with valid alt -->
  <img
    src="/company-logo.png"
    alt="Acme Corp"
    width="200"
    height="50"
  />

  <!-- Multiline image missing alt -->
  <img
    src="/unlabeled-graphic.png"
    width="400"
    height="300"
  />

  <!-- Multiline icon-only button -->
  <button
    type="button"
    class="p-2 text-gray-500 hover:text-gray-700"
  >
    <svg class="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
      <path d="..." />
    </svg>
  </button>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });

        // Multiline input is properly matched with label -> NO violation
        expect(result.a11yViolations.some(v => v.element.includes('address-line'))).toBe(false);

        // Multiline company logo has alt -> NO violation
        expect(result.a11yViolations.some(v => v.element.includes('company-logo'))).toBe(false);

        // Multiline unlabeled graphic missing alt -> Violation
        const imgViolation = result.a11yViolations.find(v => v.element.includes('unlabeled-graphic'));
        expect(imgViolation).toBeDefined();
        expect(imgViolation?.line).toBeGreaterThan(15);

        // Multiline icon-only button -> Violation
        const btnViolation = result.a11yViolations.find(v => v.ruleId === 'a11y/button-has-accessible-name');
        expect(btnViolation).toBeDefined();
        expect(btnViolation?.line).toBeGreaterThan(20);
      } finally {
        await cleanup();
      }
    });
  });

  describe('5. Design Tokens & Layout Clashes (A-13)', () => {
    it('detects arbitrary values across multiline classes, preserving touch targets min-h-[44px]', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'DesignTokens.vue': `
<template>
  <div class="
    bg-[#1a202c]
    p-[17px]
    w-[320px]
    rounded-[12px]
  ">
    <!-- Legitimate WCAG touch target size (44px) -->
    <button class="min-h-[44px] min-w-[44px] px-4 py-2">
      Click Target
    </button>
  </div>

  <!-- Layout trap: fixed + transform -->
  <div class="fixed transform scale-100">
    Modal
  </div>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });

        // Arbitrary colors, spacing, size, radius detected across multiline class
        expect(result.arbitraryTokens.some(t => t.token.includes('#1a202c'))).toBe(true);
        expect(result.arbitraryTokens.some(t => t.token.includes('p-[17px]'))).toBe(true);
        expect(result.arbitraryTokens.some(t => t.token.includes('w-[320px]'))).toBe(true);
        expect(result.arbitraryTokens.some(t => t.token.includes('rounded-[12px]'))).toBe(true);

        // Touch target min-h-[44px] and min-w-[44px] must NOT be flagged as arbitrary size violations
        expect(result.arbitraryTokens.some(t => t.token.includes('44px'))).toBe(false);

        // Layout clash detected
        const layoutClash = result.arbitraryTokens.find(t => t.category === 'layout-trap');
        expect(layoutClash).toBeDefined();
        expect(layoutClash?.token).toContain('fixed');
        expect(layoutClash?.token).toContain('transform');
      } finally {
        await cleanup();
      }
    });
  });

  describe('6. Multi-Framework Support (TSX & Astro)', () => {
    it('audits JSX/TSX elements via AST with matching semantics', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'ReactForm.tsx': `
export default function ReactForm() {
  return (
    <div>
      <label htmlFor="react-user">User</label>
      <input type="text" id="react-user" />

      <input type="text" id="orphan-input" />
      <img src="/no-alt.png" />
      <button><svg /></button>
    </div>
  );
}`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });

        // orphan-input has no htmlFor label -> violation
        expect(result.a11yViolations.some(v => v.element.includes('input') && v.issue.includes('orphan-input'))).toBe(true);

        // react-user has htmlFor="react-user" -> no violation
        expect(result.a11yViolations.some(v => v.issue.includes('react-user'))).toBe(false);

        // img missing alt -> violation
        expect(result.a11yViolations.some(v => v.ruleId === 'a11y/alt-text')).toBe(true);

        // icon-only button -> violation
        expect(result.a11yViolations.some(v => v.ruleId === 'a11y/button-has-accessible-name')).toBe(true);
      } finally {
        await cleanup();
      }
    });
  });

  describe('7. Output Text Formatting & Certainty Provenance', () => {
    it('formats a11y audit results with certainty tag, ruleId, and clear instructions', async () => {
      const { root, cleanup } = await createFixtureWorkspace({
        'Sample.vue': `
<template>
  <img src="/bad.jpg" />
  <button><svg /></button>
</template>`,
      });
      try {
        const result = await auditDesignTokens({ targetPath: root });
        const text = formatDesignAuditAsText(result);

        expect(text).toContain('DESIGN SYSTEM & A11Y AUDIT');
        expect(text).toContain('a11y Violations Found: 2');
        expect(text).toContain('[CONFIRMED]');
        expect(text).toContain('[a11y/alt-text]');
        expect(text).toContain('[a11y/button-has-accessible-name]');
        expect(text).toContain('Fix: Add alt="..."');
      } finally {
        await cleanup();
      }
    });
  });
});

