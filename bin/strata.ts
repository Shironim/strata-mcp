#!/usr/bin/env bun
import { main as runCli } from '../src/cli.ts';

runCli(process.argv.slice(2)).catch((err) => {
  console.error('Fatal CLI error:', err);
  process.exit(1);
});
