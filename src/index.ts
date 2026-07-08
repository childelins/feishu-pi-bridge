#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDaemon } from './daemon.js';
import * as cli from './cli.js';

const args = parseArgs({
  options: {
    follow: { type: 'boolean', short: 'f', default: false },
    lines: { type: 'string', short: 'n', default: '50' },
  },
  allowPositionals: true,
  strict: false,
});

const cmd = args.positionals[0] ?? 'help';

async function main(): Promise<void> {
  switch (cmd) {
    case 'daemon':
      await runDaemon();
      break;
    case 'start':
      await cli.start();
      break;
    case 'stop':
      await cli.stop();
      break;
    case 'restart':
      await cli.restart();
      break;
    case 'status':
      await cli.status();
      break;
    case 'logs':
      await cli.logs({
        follow: Boolean(args.values.follow),
        lines: parseInt(String(args.values.lines ?? '50'), 10),
      });
      break;
    case 'help':
    case '--help':
    case '-h':
      cli.printHelp();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      cli.printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
