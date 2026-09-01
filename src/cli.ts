#!/usr/bin/env bun
import { existsSync, promises as fs } from 'node:fs';
import { findCode, findCodeByRule, findComponentUsage, formatMatchesAsText } from './engine/search';
import { dumpSyntaxTree } from './engine/astgrep';
import { extractComponentContract, formatContractAsText } from './engine/contract';
import { getComponentTree, formatTreeAsText } from './engine/tree';
import { findUnusedComponents, formatUnusedAsText } from './engine/audit';

function printHelp() {
  console.log(`
vue-ast — Vue-Aware & Astro-Aware Structural Code Search CLI

Usage:
  vue-ast search <pattern> [options]
  vue-ast find-component-usage <component-name> [options]
  vue-ast contract <component-file> [options]
  vue-ast tree <entry-file> [options]
  vue-ast unused [target-dir] [options]
  vue-ast rule <rule-file-or-yaml> [options]
  vue-ast dump <code> [options]

Options:
  --path <dir|file>   Target directory or file (default: .)
  --depth <number>    Max tree depth for tree command (default: 3)
  --ignore <pattern>  Glob pattern to ignore (can repeat or comma-separated)
  --lang <lang>       Language hint (default: ts)
  --scope <scope>     Component scope: template | script | both (default: both)
  --json              Output raw JSON instead of text
  --help, -h          Show this help message
`);
}

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const { flags, positional } = parseArgs(argv);
  const command = positional[0];

  if (flags.help || !command) {
    printHelp();
    return;
  }

  const targetPath = (flags.path as string) || '.';
  const isJson = Boolean(flags.json);

  try {
    if (command === 'search') {
      const pattern = positional[1];
      if (!pattern) {
        console.error('Error: Pattern is required for search command.');
        process.exit(1);
      }

      const matches = await findCode({
        pattern,
        targetPath,
        language: (flags.lang as string) || 'ts',
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'find-component-usage') {
      const componentName = positional[1];
      if (!componentName) {
        console.error('Error: Component name is required.');
        process.exit(1);
      }

      const matches = await findComponentUsage({
        componentName,
        targetPath,
        scope: (flags.scope as any) || 'both',
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'rule') {
      const ruleInput = positional[1];
      if (!ruleInput) {
        console.error('Error: Rule file or inline YAML is required.');
        process.exit(1);
      }

      let ruleYaml = ruleInput;
      if (existsSync(ruleInput)) {
        ruleYaml = await fs.readFile(ruleInput, 'utf8');
      }

      const matches = await findCodeByRule({
        rule: ruleYaml,
        targetPath,
      });

      if (isJson) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(formatMatchesAsText(matches));
      }
      return;
    }

    if (command === 'contract' || command === 'extract-contract') {
      const filePath = positional[1];
      if (!filePath) {
        console.error('Error: Component file path is required.');
        process.exit(1);
      }

      const contract = await extractComponentContract(filePath);
      if (isJson) {
        console.log(JSON.stringify(contract, null, 2));
      } else {
        console.log(formatContractAsText(contract));
      }
      return;
    }

    if (command === 'tree' || command === 'component-tree') {
      const entryFile = positional[1];
      if (!entryFile) {
        console.error('Error: Entry component/page file path is required.');
        process.exit(1);
      }

      const maxDepth = flags.depth ? Number(flags.depth) : 3;
      const result = await getComponentTree({
        entryPath: entryFile,
        maxDepth,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatTreeAsText(result));
      }
      return;
    }

    if (command === 'unused' || command === 'find-unused') {
      const auditPath = positional[1] || targetPath;
      const ignoreArg = flags.ignore ? String(flags.ignore).split(',') : undefined;

      const result = await findUnusedComponents({
        targetPath: auditPath,
        ignorePatterns: ignoreArg,
      });

      if (isJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatUnusedAsText(result));
      }
      return;
    }

    if (command === 'dump') {
      const code = positional[1];
      if (!code) {
        console.error('Error: Code snippet is required.');
        process.exit(1);
      }

      const dump = await dumpSyntaxTree(code, (flags.lang as string) || 'ts');
      console.log(dump);
      return;
    }

    console.error(`Unknown command: "${command}". Run "vue-ast --help" for available commands.`);
    process.exit(1);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
