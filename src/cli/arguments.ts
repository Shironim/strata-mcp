

export function toCamelCase(str: string): string {
  return str.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

export const BOOLEAN_FLAGS = new Set([
  'json',
  'version',
  'v',
  'help',
  'h',
  'yes',
  'y',
  'force',
  'f',
  'audit-events',
  'auditEvents',
  'include-pages',
  'includePages',
  'map',
  'dump-ast',
  'dumpAst',
  'outline',
]);

export function parseStringFlag(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

export function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (endOfFlags) {
      positional.push(arg);
      continue;
    }

    if (arg === '--') {
      endOfFlags = true;
      continue;
    }

    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
      flags.v = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
      flags.h = true;
    } else if (arg === '-y' || arg === '--yes') {
      flags.yes = true;
      flags.y = true;
    } else if (arg === '-f' || arg === '--force') {
      flags.force = true;
      flags.f = true;
    } else if (arg === '-p') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags.path = next;
        flags.p = next;
        i++;
      } else {
        flags.path = true;
        flags.p = true;
      }
    } else if (arg.startsWith('--no-')) {
      const rawKey = arg.slice(5);
      const camelKey = toCamelCase(rawKey);
      flags[rawKey] = false;
      if (camelKey !== rawKey) {
        flags[camelKey] = false;
      }
    } else if (arg.startsWith('--')) {
      const equalsIdx = arg.indexOf('=');
      let key = arg.slice(2);
      let val: string | boolean = true;
      if (equalsIdx > 2) {
        key = arg.slice(2, equalsIdx);
        val = arg.slice(equalsIdx + 1);
      } else if (BOOLEAN_FLAGS.has(key)) {
        val = true;
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          val = next;
          i++;
        }
      }
      const camelKey = toCamelCase(key);
      flags[key] = val;
      if (camelKey !== key) {
        flags[camelKey] = val;
      }
    } else if (arg.startsWith('-')) {
      const flagKey = arg.replace(/^-+/, '');
      flags[flagKey] = true;
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}
