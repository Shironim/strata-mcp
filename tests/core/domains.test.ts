import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectCodeDomains, classifyFileDomain, isNonDomainDir } from '../../src/engine/domains';
import { collectFiles, IGNORED_DIRS } from '../../src/engine/collector';

let tempDir = '';

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('Domain Code Detection & Multi-Nested Folder Traversal', () => {
  it('correctly identifies non-domain directories including tests, docs, and scripts', () => {
    expect(isNonDomainDir('node_modules')).toBe(true);
    expect(isNonDomainDir('dist')).toBe(true);
    expect(isNonDomainDir('docs')).toBe(true);
    expect(isNonDomainDir('scripts')).toBe(true);
    expect(isNonDomainDir('tests')).toBe(true);
    expect(isNonDomainDir('test')).toBe(true);
    expect(isNonDomainDir('__tests__')).toBe(true);
    expect(isNonDomainDir('.git')).toBe(true);
    expect(isNonDomainDir('.github')).toBe(true);
    expect(isNonDomainDir('.vscode')).toBe(true);

    // Standard code directories must NOT be flagged as non-domain
    expect(isNonDomainDir('src')).toBe(false);
    expect(isNonDomainDir('components')).toBe(false);
    expect(isNonDomainDir('domains')).toBe(false);
    expect(isNonDomainDir('features')).toBe(false);
    expect(isNonDomainDir('app')).toBe(false);
    expect(isNonDomainDir('pages')).toBe(false);
  });

  it('detects primary src root and maps nested bounded contexts', async () => {
    tempDir = join(tmpdir(), `strata-domain-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Mock project structure with src, domains, and multi-nested subfolders
    await fs.writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'enterprise-app' }), 'utf8');

    // Domain: Billing (multi-nested: src/domains/billing/components/tables)
    const billingTables = join(tempDir, 'src', 'domains', 'billing', 'components', 'tables');
    await fs.mkdir(billingTables, { recursive: true });
    await fs.writeFile(join(billingTables, 'InvoiceTable.vue'), '<template/>', 'utf8');

    // Domain: Auth (src/domains/auth/services)
    const authServices = join(tempDir, 'src', 'domains', 'auth', 'services');
    await fs.mkdir(authServices, { recursive: true });
    await fs.writeFile(join(authServices, 'token.service.ts'), 'export const token = "abc";', 'utf8');

    // Ignored folders at project root
    const docsDir = join(tempDir, 'docs');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(join(docsDir, 'Architecture.md'), '# Docs', 'utf8');

    const testsDir = join(tempDir, 'tests', 'e2e');
    await fs.mkdir(testsDir, { recursive: true });
    await fs.writeFile(join(testsDir, 'login.spec.ts'), 'test("login", () => {});', 'utf8');

    const scriptsDir = join(tempDir, 'scripts');
    await fs.mkdir(scriptsDir, { recursive: true });
    await fs.writeFile(join(scriptsDir, 'deploy.ts'), 'console.log("deploy");', 'utf8');

    const resolution = await detectCodeDomains(tempDir);

    expect(resolution.isStandardLayout).toBe(true);
    expect(resolution.primaryRoot).toBe(join(tempDir, 'src'));

    const domainNames = resolution.domains.map((d) => d.name);
    expect(domainNames).toContain('src');
    expect(domainNames).toContain('billing');
    expect(domainNames).toContain('auth');
    expect(domainNames).not.toContain('docs');
    expect(domainNames).not.toContain('tests');
    expect(domainNames).not.toContain('scripts');

    // Classify individual files
    const invoiceFile = join(billingTables, 'InvoiceTable.vue');
    const invoiceClassification = classifyFileDomain(invoiceFile, tempDir);
    expect(invoiceClassification.isDomainCode).toBe(true);
    expect(invoiceClassification.domain).toBe('billing');
    expect(invoiceClassification.layer).toBe('component');
    expect(invoiceClassification.subdomain).toBe('tables');
    expect(invoiceClassification.isMultiNested).toBe(true);

    const testFile = join(testsDir, 'login.spec.ts');
    const testClassification = classifyFileDomain(testFile, tempDir);
    expect(testClassification.isDomainCode).toBe(false);

    // Collect files with domainOnly: true
    const collected = await collectFiles(tempDir, { domainOnly: true });
    expect(collected).toContain(invoiceFile);
    expect(collected).toContain(join(authServices, 'token.service.ts'));
    expect(collected).not.toContain(testFile);
    expect(collected).not.toContain(join(scriptsDir, 'deploy.ts'));
  });

  it('detects flat framework domain structure without src/ directory', async () => {
    tempDir = join(tmpdir(), `strata-flat-domain-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await fs.writeFile(join(tempDir, 'package.json'), JSON.stringify({ name: 'next-flat-app' }), 'utf8');

    // Next.js App router at root
    const appDir = join(tempDir, 'app', '(dashboard)', 'analytics');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(join(appDir, 'page.tsx'), 'export default function Page() {}', 'utf8');

    // Components at root
    const compDir = join(tempDir, 'components', 'ui');
    await fs.mkdir(compDir, { recursive: true });
    await fs.writeFile(join(compDir, 'Button.tsx'), 'export const Button = () => null;', 'utf8');

    const resolution = await detectCodeDomains(tempDir);
    expect(resolution.isStandardLayout).toBe(true);

    const domainNames = resolution.domains.map((d) => d.name);
    expect(domainNames).toContain('app');
    expect(domainNames).toContain('components');

    const pageFile = join(appDir, 'page.tsx');
    const pageClassification = classifyFileDomain(pageFile, tempDir);
    expect(pageClassification.isDomainCode).toBe(true);
    expect(pageClassification.domain).toBe('app');
    expect(pageClassification.layer).toBe('route-or-page');
  });

  it('detects fullstack hybrid resources/js domain structure', async () => {
    tempDir = join(tmpdir(), `strata-inertia-domain-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    await fs.writeFile(join(tempDir, 'composer.json'), JSON.stringify({ name: 'laravel-inertia' }), 'utf8');

    const pagesDir = join(tempDir, 'resources', 'js', 'Pages', 'Auth');
    await fs.mkdir(pagesDir, { recursive: true });
    await fs.writeFile(join(pagesDir, 'Login.vue'), '<template><div>Login</div></template>', 'utf8');

    const resolution = await detectCodeDomains(tempDir);
    expect(resolution.isStandardLayout).toBe(true);
    expect(resolution.primaryRoot).toBe(join(tempDir, 'resources', 'js'));

    const loginFile = join(pagesDir, 'Login.vue');
    const classification = classifyFileDomain(loginFile, tempDir);
    expect(classification.isDomainCode).toBe(true);
    expect(classification.domain).toBe('Pages');
    expect(classification.subdomain).toBe('Auth');
    expect(classification.layer).toBe('route-or-page');
  });

  it('classifies Feature-Sliced Design (FSD) entities, widgets, and shared layers', () => {
    const dummyRoot = '/workspace/app';

    // Entity
    const entityFile = '/workspace/app/src/entities/user/ui/UserAvatar.vue';
    const entityClass = classifyFileDomain(entityFile, dummyRoot);
    expect(entityClass.isDomainCode).toBe(true);
    expect(entityClass.domain).toBe('user');
    expect(entityClass.layer).toBe('component');

    // Widget
    const widgetFile = '/workspace/app/src/widgets/Sidebar/ui/Sidebar.tsx';
    const widgetClass = classifyFileDomain(widgetFile, dummyRoot);
    expect(widgetClass.isDomainCode).toBe(true);
    expect(widgetClass.domain).toBe('Sidebar');
    expect(widgetClass.layer).toBe('component');

    // Shared UI
    const sharedFile = '/workspace/app/src/shared/ui/Button.tsx';
    const sharedClass = classifyFileDomain(sharedFile, dummyRoot);
    expect(sharedClass.isDomainCode).toBe(true);
    expect(sharedClass.domain).toBe('shared');
    expect(sharedClass.subdomain).toBe('ui');
    expect(sharedClass.layer).toBe('component');
  });

  it('classifies meta-framework special files for Next.js and SvelteKit', () => {
    const dummyRoot = '/workspace/next-project';

    // Next.js special files
    expect(classifyFileDomain('/workspace/next-project/app/api/users/route.ts', dummyRoot).layer).toBe('service');
    expect(classifyFileDomain('/workspace/next-project/app/actions.ts', dummyRoot).layer).toBe('action');
    expect(classifyFileDomain('/workspace/next-project/middleware.ts', dummyRoot).layer).toBe('middleware');
    expect(classifyFileDomain('/workspace/next-project/app/layout.tsx', dummyRoot).layer).toBe('layout');
    expect(classifyFileDomain('/workspace/next-project/app/loading.tsx', dummyRoot).layer).toBe('route-or-page');

    // SvelteKit special files
    expect(classifyFileDomain('/workspace/next-project/src/routes/+page.svelte', dummyRoot).layer).toBe('route-or-page');
    expect(classifyFileDomain('/workspace/next-project/src/routes/+layout.svelte', dummyRoot).layer).toBe('layout');
    expect(classifyFileDomain('/workspace/next-project/src/routes/api/+server.ts', dummyRoot).layer).toBe('service');
    expect(classifyFileDomain('/workspace/next-project/src/hooks.server.ts', dummyRoot).layer).toBe('middleware');
  });

  it('flags in-place test, storybook, and mock files as non-domain code', () => {
    const dummyRoot = '/workspace/my-app';

    const testFile = classifyFileDomain('/workspace/my-app/src/components/Button.test.tsx', dummyRoot);
    expect(testFile.isDomainCode).toBe(false);

    const specFile = classifyFileDomain('/workspace/my-app/src/components/Button.spec.ts', dummyRoot);
    expect(specFile.isDomainCode).toBe(false);

    const storyFile = classifyFileDomain('/workspace/my-app/src/components/Button.stories.tsx', dummyRoot);
    expect(storyFile.isDomainCode).toBe(false);

    const mockFile = classifyFileDomain('/workspace/my-app/src/services/api.mock.ts', dummyRoot);
    expect(mockFile.isDomainCode).toBe(false);
  });

  it('detects monorepo workspace packages in apps/ and packages/', async () => {
    tempDir = join(tmpdir(), `strata-monorepo-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // apps/web/src/components/Hero.vue
    const webCompDir = join(tempDir, 'apps', 'web', 'src', 'components');
    await fs.mkdir(webCompDir, { recursive: true });
    await fs.writeFile(join(webCompDir, 'Hero.vue'), '<template/>', 'utf8');

    // packages/ui/src/Button.tsx
    const uiPkgDir = join(tempDir, 'packages', 'ui', 'src');
    await fs.mkdir(uiPkgDir, { recursive: true });
    await fs.writeFile(join(uiPkgDir, 'Button.tsx'), 'export const Button = () => null;', 'utf8');

    const resolution = await detectCodeDomains(tempDir);
    expect(resolution.isStandardLayout).toBe(true);

    const domainNames = resolution.domains.map((d) => d.name);
    expect(domainNames).toContain('web');
    expect(domainNames).toContain('ui');

    const heroFile = join(webCompDir, 'Hero.vue');
    const heroClass = classifyFileDomain(heroFile, tempDir);
    expect(heroClass.isDomainCode).toBe(true);
    expect(heroClass.packageScope).toBe('web');
    expect(heroClass.domain).toBe('components');
    expect(heroClass.layer).toBe('component');
  });

  it('detects and classifies AI agent harness configurations (.gemini, .agents, .claude, .codex, opencode)', async () => {
    tempDir = join(tmpdir(), `strata-ai-harness-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Google Antigravity config
    const geminiDir = join(tempDir, '.gemini', 'skills', 'strata');
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(join(geminiDir, 'SKILL.md'), '# Antigravity Skill', 'utf8');
    await fs.writeFile(join(tempDir, 'GEMINI.md'), '# Gemini Rules', 'utf8');

    // .agents (general) config
    const agentsDir = join(tempDir, '.agents', 'rules');
    await fs.mkdir(agentsDir, { recursive: true });
    await fs.writeFile(join(agentsDir, 'rules.md'), '# General Agent Rules', 'utf8');
    await fs.writeFile(join(tempDir, 'AGENTS.md'), '# Agents Instructions', 'utf8');

    // Opencode folder config
    const opencodeDir = join(tempDir, 'opencode', 'skills', 'strata-inspect');
    await fs.mkdir(opencodeDir, { recursive: true });
    await fs.writeFile(join(opencodeDir, 'SKILL.md'), '# OpenCode Skill', 'utf8');

    // App code
    const srcDir = join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, 'App.vue'), '<template/>', 'utf8');

    const resolution = await detectCodeDomains(tempDir);
    expect(resolution.agentHarnesses.length).toBeGreaterThanOrEqual(3);

    const harnessNames = resolution.agentHarnesses.map((h) => h.harness);
    expect(harnessNames).toContain('Google Antigravity');
    expect(harnessNames).toContain('.agents (general)');
    expect(harnessNames).toContain('OpenCode');

    const geminiHarness = resolution.agentHarnesses.find((h) => h.harness === 'Google Antigravity');
    expect(geminiHarness?.hasRules).toBe(true);
    expect(geminiHarness?.hasSkills).toBe(true);

    // Classify file domain for harness files
    const geminiSkillFile = join(geminiDir, 'SKILL.md');
    const geminiClass = classifyFileDomain(geminiSkillFile, tempDir);
    expect(geminiClass.isDomainCode).toBe(false);
    expect(geminiClass.isHarnessConfig).toBe(true);
    expect(geminiClass.harnessType).toBe('Google Antigravity');

    const agentsRuleFile = join(agentsDir, 'rules.md');
    const agentsClass = classifyFileDomain(agentsRuleFile, tempDir);
    expect(agentsClass.isDomainCode).toBe(false);
    expect(agentsClass.isHarnessConfig).toBe(true);
    expect(agentsClass.harnessType).toBe('.agents (general)');

    const opencodeSkillFile = join(opencodeDir, 'SKILL.md');
    const opencodeClass = classifyFileDomain(opencodeSkillFile, tempDir);
    expect(opencodeClass.isDomainCode).toBe(false);
    expect(opencodeClass.isHarnessConfig).toBe(true);
    expect(opencodeClass.harnessType).toBe('OpenCode');

    // Ensure collectFiles ignores .gemini, .agents, and opencode folder by default
    const collected = await collectFiles(tempDir);
    expect(collected).toContain(join(srcDir, 'App.vue'));
    expect(collected).not.toContain(geminiSkillFile);
    expect(collected).not.toContain(agentsRuleFile);
    expect(collected).not.toContain(opencodeSkillFile);
  });
});

