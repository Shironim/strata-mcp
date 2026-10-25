import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  checkRuntimeVersion,
  formatUpdateNotice,
  isNewerVersion,
  parseSemver,
  readVersionCache,
  writeVersionCache,
  type RuntimeVersionMeta,
} from '../../src/utils/version-check';
import { createMcpServer } from '../../src/mcp';

describe('Strata Version & Update Notification Suite', () => {
  const tmpCacheDir = path.join(os.tmpdir(), `strata-version-test-${Date.now()}`);
  const tmpCacheFile = path.join(tmpCacheDir, 'version-check.json');

  const cleanTmp = () => {
    try {
      if (fs.existsSync(tmpCacheFile)) fs.unlinkSync(tmpCacheFile);
      if (fs.existsSync(tmpCacheDir)) fs.rmdirSync(tmpCacheDir);
    } catch {}
  };

  describe('Semver parsing and comparison', () => {
    it('correctly parses standard, v-prefixed, and prerelease versions', () => {
      expect(parseSemver('0.7.11')).toEqual([0, 7, 11]);
      expect(parseSemver('v1.0.0')).toEqual([1, 0, 0]);
      expect(parseSemver('0.8.0-beta.2')).toEqual([0, 8, 0]);
      expect(parseSemver('invalid')).toEqual([0, 0, 0]);
    });

    it('evaluates isNewerVersion accurately', () => {
      expect(isNewerVersion('0.7.11', '0.7.12')).toBe(true);
      expect(isNewerVersion('0.7.11', '0.8.0')).toBe(true);
      expect(isNewerVersion('0.7.11', '1.0.0')).toBe(true);
      expect(isNewerVersion('0.7.11', '0.7.11')).toBe(false);
      expect(isNewerVersion('0.7.12', '0.7.11')).toBe(false);
      expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
      expect(isNewerVersion('v0.7.11', 'v0.7.12')).toBe(true);
    });
  });

  describe('Cache read and write operations', () => {
    it('reads and writes cache safely without throwing', () => {
      cleanTmp();
      expect(readVersionCache(tmpCacheFile)).toBeNull();

      writeVersionCache(tmpCacheFile, {
        last_checked: 2000000,
        latest_version: '0.8.0',
      });

      const entry = readVersionCache(tmpCacheFile);
      expect(entry).not.toBeNull();
      expect(entry?.last_checked).toBe(2000000);
      expect(entry?.latest_version).toBe('0.8.0');

      cleanTmp();
    });
  });

  describe('(a) Up-to-date version', () => {
    it('reports update_available=false and upgrade_command=null when on latest version', async () => {
      const meta = await checkRuntimeVersion({
        currentVersion: '0.7.11',
        packageName: '@dimassetoid/strata-mcp',
        fetchFn: async () => '0.7.11',
        cachePath: tmpCacheFile,
        forceRefresh: true,
      });

      expect(meta.server_version).toBe('0.7.11');
      expect(meta.latest_version).toBe('0.7.11');
      expect(meta.update_available).toBe(false);
      expect(meta.upgrade_command).toBeNull();
      expect(formatUpdateNotice(meta)).toBeNull();
    });
  });

  describe('(b) Outdated version', () => {
    it('reports update_available=true and upgrade_command when newer version exists', async () => {
      const meta = await checkRuntimeVersion({
        currentVersion: '0.7.11',
        packageName: '@dimassetoid/strata-mcp',
        fetchFn: async () => '0.8.0',
        cachePath: tmpCacheFile,
        forceRefresh: true,
      });

      expect(meta.server_version).toBe('0.7.11');
      expect(meta.latest_version).toBe('0.8.0');
      expect(meta.update_available).toBe(true);
      expect(meta.upgrade_command).toBe('bun add -g @dimassetoid/strata-mcp');

      const notice = formatUpdateNotice(meta);
      expect(notice).toBe('Update available: v0.7.11 -> v0.8.0 (Run: bun add -g @dimassetoid/strata-mcp)');
    });
  });

  describe('(c) Network timeout / offline graceful fallback', () => {
    it('falls back to null latest_version without throwing when offline and cache empty', async () => {
      const meta = await checkRuntimeVersion({
        currentVersion: '0.7.11',
        packageName: '@dimassetoid/strata-mcp',
        fetchFn: async () => {
          throw new Error('ETIMEDOUT / Offline');
        },
        cachePath: path.join(tmpCacheDir, 'nonexistent.json'),
        forceRefresh: true,
      });

      expect(meta.server_version).toBe('0.7.11');
      expect(meta.latest_version).toBeNull();
      expect(meta.update_available).toBe(false);
      expect(meta.upgrade_command).toBeNull();
      expect(formatUpdateNotice(meta)).toBeNull();
    });

    it('falls back to stale cached version without throwing when network times out', async () => {
      cleanTmp();
      writeVersionCache(tmpCacheFile, {
        last_checked: Date.now() - 48 * 60 * 60 * 1000, // 48h ago (expired)
        latest_version: '0.7.12',
      });

      const meta = await checkRuntimeVersion({
        currentVersion: '0.7.11',
        packageName: '@dimassetoid/strata-mcp',
        fetchFn: async () => {
          throw new Error('Network timeout');
        },
        cachePath: tmpCacheFile,
        forceRefresh: true,
      });

      expect(meta.server_version).toBe('0.7.11');
      expect(meta.latest_version).toBe('0.7.12');
      expect(meta.update_available).toBe(true);
      expect(meta.upgrade_command).toBe('bun add -g @dimassetoid/strata-mcp');
      cleanTmp();
    });

    it('writes backoff cache on fetch failure so subsequent calls do not retry network immediately', async () => {
      cleanTmp();
      let fetchCount = 0;
      const failingFetcher = async () => {
        fetchCount++;
        throw new Error('DNS unreachable');
      };

      const meta1 = await checkRuntimeVersion({
        currentVersion: '0.7.11',
        fetchFn: failingFetcher,
        cachePath: tmpCacheFile,
      });
      expect(fetchCount).toBe(1);
      expect(meta1.latest_version).toBeNull();

      // Subsequent call within backoff window does not call fetcher
      const meta2 = await checkRuntimeVersion({
        currentVersion: '0.7.11',
        fetchFn: failingFetcher,
        cachePath: tmpCacheFile,
      });
      expect(fetchCount).toBe(1);
      expect(meta2.latest_version).toBeNull();
      cleanTmp();
    });
  });

  describe('MCP find_code and audit_frontend version metadata injection', () => {
    it('find_code (action: "map") returns runtime_version in top-level response and in payload', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'find_code',
          arguments: {
            action: 'map',
            path: path.resolve(__dirname, '../fixtures'),
            output_format: 'json',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.runtime_version).toBeDefined();
      expect(typeof response.runtime_version.server_version).toBe('string');

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.runtime_version).toBeDefined();
      expect(parsed.runtime_version.server_version).toBe(response.runtime_version.server_version);
    });

    it('audit_frontend returns runtime_version in top-level response and in payload', async () => {
      const server = createMcpServer();
      const callHandler = (server as any)._requestHandlers?.get('tools/call');

      const response = await callHandler({
        method: 'tools/call',
        params: {
          name: 'audit_frontend',
          arguments: {
            target: 'routes',
            path: path.resolve(__dirname, '../fixtures'),
            output_format: 'json',
          },
        },
      });

      expect(response.isError).toBeFalsy();
      expect(response.runtime_version).toBeDefined();
      expect(typeof response.runtime_version.server_version).toBe('string');

      const parsed = JSON.parse(response.content[0].text);
      expect(parsed.runtime_version).toBeDefined();
    });
  });

  describe('(d) Verification that serve mode emits zero non-JSON output to stdout', () => {
    it('spawns strata serve and verifies stdout contains exclusively valid JSON-RPC / zero raw text', async () => {
      const cliPath = path.resolve(__dirname, '../../src/cli.ts');
      const child = spawn('bun', ['run', cliPath, 'serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      await new Promise((resolve) => setTimeout(resolve, 300));

      const initMessage = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }) + '\n';

      child.stdin.write(initMessage);
      await new Promise((resolve) => setTimeout(resolve, 500));

      child.stdin.end();
      await new Promise((resolve) => {
        child.on('close', resolve);
        setTimeout(() => {
          child.kill('SIGTERM');
          resolve(true);
        }, 1000);
      });

      const stdoutRaw = Buffer.concat(stdoutChunks).toString('utf8');
      const lines = stdoutRaw.split('\n').filter((l) => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        const parsed = JSON.parse(line);
        expect(parsed).toHaveProperty('jsonrpc', '2.0');
        expect(line).not.toContain('\x1b[');
        expect(line).not.toContain('Update available:');
      }
    });
  });
});

