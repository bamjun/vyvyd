#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {runCli} from '../dist/studio-companion/src/cli-main.mjs';

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    packageRoot: fileURLToPath(new URL('../', import.meta.url)),
    cliPath: fileURLToPath(import.meta.url),
  });
} catch (cause) {
  process.stderr.write(`vyvyd-studio: ${cause.message}\n`);
  process.exitCode = 1;
}
