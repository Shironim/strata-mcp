import { expect, test } from 'bun:test';
import { AnalysisSupervisor } from '../../src/analysis-supervisor';
import { executeAstGrep } from '../../src/engine/astgrep';
import { TOOLS } from '../../src/tools';
import { analysisSignal } from '../../src/engine/analysis-context';

test('ast-grep streaming stops early when maxResults is reached', async () => {
  const code = Array.from({ length: 50 }, (_, i) => `const val_${i} = ref(${i});`).join('\n');
  const results = await executeAstGrep({
    code,
    pattern: 'ref($$$)',
    language: 'ts',
    maxResults: 3,
  });

  expect(results.length).toBe(3);
  expect(results[0].text).toContain('ref');
});

test('supervisor rejects an already cancelled request without starting analysis', async () => {
  const supervisor = new AnalysisSupervisor();
  const controller = new AbortController();

  controller.abort();
  await expect(supervisor.run('find_code', { pattern: 'test' }, undefined, controller.signal)).rejects.toThrow('REQUEST_CANCELLED');

  await supervisor.close();

});

for (const cancellation of ['timeout', 'abort'] as const) {
  test(`${cancellation} keeps the execution slot until the handler settles`, async () => {
    const tool = TOOLS[0], original = tool.handler;
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const supervisor = new AnalysisSupervisor({ limits: { timeoutMs: cancellation === 'timeout' ? 10 : 1000 } });
    let calls = 0, running = 0, maximum = 0;
    let signal: AbortSignal | undefined;
    tool.handler = async () => {
      calls++; running++; maximum = Math.max(maximum, running);
      if (calls === 1) { signal = analysisSignal(); entered.resolve(); await gate.promise; }
      running--;
      return { content: [{ type: 'text', text: 'done' }] };
    };
    try {
      const first = supervisor.run('find_code', {}, undefined, controller.signal).catch(error => error as Error);
      await entered.promise;
      const second = supervisor.run('find_code', {});
      if (cancellation === 'abort') controller.abort();
      const failure = await first;
      expect((failure as Error).message).toContain(cancellation === 'timeout' ? '0.01 seconds' : 'REQUEST_CANCELLED');
      expect(signal?.aborted).toBe(true);
      expect(calls).toBe(1);
      gate.resolve();
      await second;
      expect(maximum).toBe(1);
      expect(running).toBe(0);
    } finally { gate.resolve(); await supervisor.close(); tool.handler = original; }
  });
}

test('close rejects queued work and waits for active cleanup after cancellation', async () => {
  const tool = TOOLS[0], original = tool.handler;
  const gate = Promise.withResolvers<void>();
  const supervisor = new AnalysisSupervisor();
  let calls = 0, cleaned = false, closed = false;
  tool.handler = async () => {
    calls++;
    try { await gate.promise; return { content: [] }; }
    finally { cleaned = true; }
  };
  try {
    const first = supervisor.run('find_code', {}).catch(e => e.message);
    const queued = supervisor.run('find_code', {}).catch(e => e.message);
    const closing = supervisor.close().then(() => { closed = true; });
    expect(await first).toContain('SERVER_CLOSED');
    expect(await queued).toContain('SERVER_CLOSED');
    expect(closed).toBe(false);
    expect(cleaned).toBe(false);
    gate.resolve(); await closing;
    expect(cleaned).toBe(true);
    expect(calls).toBe(1);
  } finally { gate.resolve(); await supervisor.close(); tool.handler = original; }
});

test('cancelling a queued request frees capacity without running its handler', async () => {
  const tool = TOOLS[0], original = tool.handler;
  const gate = Promise.withResolvers<void>();
  const controller = new AbortController();
  const supervisor = new AnalysisSupervisor({ limits: { queued: 1 } });
  const called: unknown[] = [];
  tool.handler = async args => {
    called.push(args.id);
    if (args.id === 'first') await gate.promise;
    return { content: [] };
  };
  try {
    const first = supervisor.run('find_code', { id: 'first' });
    const queued = supervisor.run('find_code', { id: 'cancelled' }, undefined, controller.signal).catch(e => e.message);
    controller.abort();
    expect(await queued).toContain('queued analysis cancelled');
    const replacement = supervisor.run('find_code', { id: 'replacement' });
    gate.resolve(); await first; await replacement;
    expect(called).toEqual(['first', 'replacement']);
  } finally { gate.resolve(); await supervisor.close(); tool.handler = original; }
});
