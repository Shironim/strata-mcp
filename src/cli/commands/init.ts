import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { STRATA_FRONTEND_RULE, STRATA_INSPECT_SKILL, STRATA_POST_WRITE_HOOK } from '../templates';
import { syncWorkspace } from '../../engine/database';

export interface StrataInitOptions {
  cwd?: string;
  force?: boolean;
}

export async function handleStrataInit(options: StrataInitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

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

  // 2. Write agent harness rules, skills, and hooks
  const rulePath = join(rulesDir, 'strata-frontend.md');
  const skillPath = join(skillsDir, 'SKILL.md');
  const hookPath = join(hooksDir, 'strata-post-write.sh');

  await fs.writeFile(rulePath, STRATA_FRONTEND_RULE, 'utf8');
  await fs.writeFile(skillPath, STRATA_INSPECT_SKILL, 'utf8');
  await fs.writeFile(hookPath, STRATA_POST_WRITE_HOOK, { encoding: 'utf8', mode: 0o755 });

  console.log('  ✓ Generated agent rule:  .agents/rules/strata-frontend.md');
  console.log('  ✓ Generated agent skill: .agents/skills/strata-inspect/SKILL.md');
  console.log('  ✓ Generated agent hook:  .agents/hooks/strata-post-write.sh');

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
