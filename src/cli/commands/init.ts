import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { STRATA_FRONTEND_RULE, STRATA_INSPECT_SKILL, STRATA_POST_WRITE_HOOK } from '../templates';
import { syncWorkspace } from '../../engine/database';
import { resolveProjectRoot } from '../../engine/path-resolver';

export interface StrataInitOptions {
  cwd?: string;
  force?: boolean;
}

export async function handleStrataInit(options: StrataInitOptions = {}): Promise<void> {
  const cwd = options.cwd ? resolveProjectRoot(options.cwd) : process.cwd();
  const force = Boolean(options.force);

  console.log('[strata] Initializing Strata frontend intelligence environment...\n');

  // 1. Prepare directory structure for agent harness & cache
  const agentsDir = join(cwd, '.agents');
  const rulesDir = join(agentsDir, 'rules');
  const skillsDir = join(agentsDir, 'skills', 'strata-inspect');
  const hooksDir = join(agentsDir, 'hooks');
  const strataDir = join(cwd, '.strata');

  await fs.mkdir(rulesDir, { recursive: true });
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(strataDir, { recursive: true });

  // 2. Write agent harness rules, skills, and hooks (respecting --force)
  const targets = [
    { label: 'agent rule', rel: '.agents/rules/strata-frontend.md', path: join(rulesDir, 'strata-frontend.md'), content: STRATA_FRONTEND_RULE },
    { label: 'agent skill', rel: '.agents/skills/strata-inspect/SKILL.md', path: join(skillsDir, 'SKILL.md'), content: STRATA_INSPECT_SKILL },
    { label: 'agent hook', rel: '.agents/hooks/strata-post-write.sh', path: join(hooksDir, 'strata-post-write.sh'), content: STRATA_POST_WRITE_HOOK, mode: 0o755 },
  ];

  for (const t of targets) {
    if (!force && existsSync(t.path)) {
      console.log(`  • Skipped existing ${t.label}: ${t.rel} (use --force to overwrite)`);
    } else {
      await fs.writeFile(t.path, t.content, t.mode ? { encoding: 'utf8', mode: t.mode } : 'utf8');
      console.log(`  ✓ Generated ${t.label}: ${t.rel}`);
    }
  }

  // 3. Update .gitignore
  const gitignorePath = join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const content = await fs.readFile(gitignorePath, 'utf8');
    if (!content.includes('.strata')) {
      await fs.appendFile(gitignorePath, '\n# Strata AST cache\n.strata/\n', 'utf8');
      console.log('  ✓ Added .strata/ to .gitignore');
    }
  }

  // 4. Initial Workspace Sync
  console.log('\n  • Indexing frontend components into SQLite graph (.strata/graph.db)...');
  const stats = await syncWorkspace(cwd);
  console.log(`  ✓ Indexed ${stats.total} files (${stats.added} indexed, ${stats.unchanged} cached) in ${stats.durationMs}ms.\n`);

  console.log('[strata] Initialization complete! Your AI Agent is now equipped with frontend structural AST intelligence.');
}
