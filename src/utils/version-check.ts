import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pkg from '../../package.json';

export interface RuntimeVersionMeta {
  server_version: string;
  latest_version: string | null;
  update_available: boolean;
  upgrade_command: string | null;
}

export interface VersionCacheEntry {
  last_checked: number;
  latest_version: string | null;
}

export const STRATA_PACKAGE_NAME: string = pkg.name || '@dimassetoid/strata-mcp';
export const STRATA_CURRENT_VERSION: string = pkg.version;
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const DEFAULT_TIMEOUT_MS = 1500; // 1.5s strict timeout
export const DEFAULT_FAILURE_BACKOFF_MS = 15 * 60 * 1000; // 15 mins backoff on network failure

export function getDefaultCachePath(): string {
  return path.join(os.homedir(), '.strata', 'version-check.json');
}

export function parseSemver(v: string): [number, number, number] {
  const clean = v.trim().replace(/^v/, '').split('-')[0].split('+')[0];
  const parts = clean.split('.').map((n) => parseInt(n, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

export function isNewerVersion(current: string, latest: string): boolean {
  const [cMaj, cMin, cPatch] = parseSemver(current);
  const [lMaj, lMin, lPatch] = parseSemver(latest);

  if (lMaj > cMaj) return true;
  if (lMaj < cMaj) return false;
  if (lMin > cMin) return true;
  if (lMin < cMin) return false;
  return lPatch > cPatch;
}

export function readVersionCache(cachePath: string = getDefaultCachePath()): VersionCacheEntry | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.last_checked === 'number') {
      return {
        last_checked: parsed.last_checked,
        latest_version: typeof parsed.latest_version === 'string' ? parsed.latest_version.trim() : null,
      };
    }
  } catch {
    // Silently ignore corrupted or unreadable cache
  }
  return null;
}

export function writeVersionCache(
  cachePath: string = getDefaultCachePath(),
  entry: VersionCacheEntry
): void {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2), 'utf8');
  } catch {
    // Silently ignore disk write issues
  }
}

export async function fetchLatestNpmVersion(
  packageName: string = STRATA_PACKAGE_NAME,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string | null> {
  const encodedName = packageName.startsWith('@')
    ? '@' + encodeURIComponent(packageName.slice(1))
    : encodeURIComponent(packageName);
  const url = `https://registry.npmjs.org/${encodedName}/latest`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `${packageName}-version-check`,
      },
    }).finally(() => {
      clearTimeout(timer);
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: unknown };
    if (data && typeof data.version === 'string' && data.version.trim()) {
      return data.version.trim();
    }
  } catch {
    // Network offline, timeout, or DNS failure: silently catch
  }
  return null;
}

export interface CheckVersionOptions {
  timeoutMs?: number;
  cachePath?: string;
  cacheTtlMs?: number;
  fetchFn?: (pkg: string, timeout: number) => Promise<string | null>;
  currentVersion?: string;
  packageName?: string;
  forceRefresh?: boolean;
}

export async function checkRuntimeVersion(
  options: CheckVersionOptions = {}
): Promise<RuntimeVersionMeta> {
  const currentVersion = options.currentVersion ?? STRATA_CURRENT_VERSION;
  const packageName = options.packageName ?? STRATA_PACKAGE_NAME;
  const cachePath = options.cachePath ?? getDefaultCachePath();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetchFn ?? fetchLatestNpmVersion;

  const cached = readVersionCache(cachePath);
  const now = Date.now();

  let latestVersion: string | null = null;

  if (!options.forceRefresh && cached && now - cached.last_checked < cacheTtlMs) {
    latestVersion = cached.latest_version;
  } else {
    try {
      const fetched = await fetcher(packageName, timeoutMs);
      if (fetched) {
        latestVersion = fetched;
        writeVersionCache(cachePath, {
          last_checked: now,
          latest_version: fetched,
        });
      } else {
        latestVersion = cached ? cached.latest_version : null;
        writeVersionCache(cachePath, {
          last_checked: now,
          latest_version: latestVersion,
        });
      }
    } catch {
      latestVersion = cached ? cached.latest_version : null;
      writeVersionCache(cachePath, {
        last_checked: now,
        latest_version: latestVersion,
      });
    }
  }

  const updateAvailable = Boolean(
    latestVersion && isNewerVersion(currentVersion, latestVersion)
  );

  return {
    server_version: currentVersion,
    latest_version: latestVersion,
    update_available: updateAvailable,
    upgrade_command: updateAvailable ? `bun add -g ${packageName}` : null,
  };
}

export function getCachedRuntimeVersion(
  options: { currentVersion?: string; packageName?: string; cachePath?: string } = {}
): RuntimeVersionMeta {
  const currentVersion = options.currentVersion ?? STRATA_CURRENT_VERSION;
  const packageName = options.packageName ?? STRATA_PACKAGE_NAME;
  const cachePath = options.cachePath ?? getDefaultCachePath();
  const cached = readVersionCache(cachePath);
  const latestVersion = cached?.latest_version ?? null;
  const updateAvailable = Boolean(
    latestVersion && isNewerVersion(currentVersion, latestVersion)
  );

  return {
    server_version: currentVersion,
    latest_version: latestVersion,
    update_available: updateAvailable,
    upgrade_command: updateAvailable ? `bun add -g ${packageName}` : null,
  };
}

export function formatUpdateNotice(meta: RuntimeVersionMeta): string | null {
  if (!meta.update_available || !meta.latest_version || !meta.upgrade_command) {
    return null;
  }
  return `Update available: v${meta.server_version} -> v${meta.latest_version} (Run: ${meta.upgrade_command})`;
}

