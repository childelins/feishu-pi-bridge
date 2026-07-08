import { appendFileSync, renameSync, statSync } from 'node:fs';
import { config } from './config.js';

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

function rotateIfNeeded() {
  try {
    const stat = statSync(config.paths.logFile);
    if (stat.size > config.log.rotateAtBytes) {
      renameSync(config.paths.logFile, config.paths.logFile + '.1');
    }
  } catch {
    // file missing or inaccessible — skip rotation, write will create it
  }
}

function write(level: Level, msg: string) {
  const line = `${new Date().toISOString()} [${level.padEnd(5)}] ${msg}\n`;
  try {
    appendFileSync(config.paths.logFile, line);
  } catch {
    // log filesystem unavailable — last-resort stderr
    process.stderr.write(line);
  }
}

rotateIfNeeded();

export const logger = {
  debug: (msg: string) => write('DEBUG', msg),
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string) => write('ERROR', msg),
};
