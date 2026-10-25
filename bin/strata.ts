#!/usr/bin/env bun
import { main as runCli } from '../src/cli.ts';
import { runServer } from '../src/mcp.ts';
import { runWorker } from '../src/analysis-worker.ts';

const argv = process.argv.slice(2);
if (argv[0] === '__worker') {
  runWorker(argv[1]).catch((err) => {
    console.error('Fatal Worker error:', err);
    process.exit(1);
  });
} else if (argv.length > 0) {
  runCli(argv).catch((err) => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
} else if (process.stdin.isTTY) {
  runCli([]).catch((err) => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
} else {
  runServer().catch((err) => {
    console.error('Fatal MCP Server error:', err);
    process.exit(1);
  });
}
