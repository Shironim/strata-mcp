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
});
