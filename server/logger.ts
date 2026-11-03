import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let primaryLogPath = '';
let fallbackLogPath = '';
let isInitialized = false;

function formatTimestamp(): string {
  return new Date().toISOString();
}

function safeAppend(filePath: string, text: string) {
  try {
    fs.appendFileSync(filePath, text, 'utf-8');
  } catch {
    // Ignore secondary write failures
  }
}

export function writeLog(level: 'INFO' | 'WARN' | 'ERROR' | 'FATAL' | 'DEBUG', message: string, extra?: unknown) {
  const time = formatTimestamp();
  let line = `[${time}] [${level}] ${message}`;
  if (extra !== undefined) {
    if (extra instanceof Error) {
      line += `\n${extra.stack || extra.message}`;
    } else if (typeof extra === 'object') {
      try {
        line += `\n${JSON.stringify(extra, null, 2)}`;
      } catch {
        line += `\n[Unserializable Object]`;
      }
    } else {
      line += ` ${String(extra)}`;
    }
  }
  line += '\n';

  if (primaryLogPath) {
    safeAppend(primaryLogPath, line);
  }
  if (fallbackLogPath && fallbackLogPath !== primaryLogPath) {
    safeAppend(fallbackLogPath, line);
  }
}

export function initLogger(rootDir: string): { primaryLogPath: string; fallbackLogPath: string } {
  if (isInitialized) {
    return { primaryLogPath, fallbackLogPath };
  }

  // 1. Primary log path: <rootDir>/logs/qadrive-app.log
  try {
    const localLogsDir = path.join(rootDir, 'logs');
    if (!fs.existsSync(localLogsDir)) {
      fs.mkdirSync(localLogsDir, { recursive: true });
    }
    primaryLogPath = path.join(localLogsDir, 'qadrive-app.log');
  } catch (err) {
    // If rootDir is read-only, primaryLogPath remains empty
  }

  // 2. Fallback log path: %LOCALAPPDATA%/QADrive/logs/qadrive-app.log
  try {
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(os.homedir(), 'AppData', 'Local');
    const appDataLogsDir = path.join(localAppData, 'QADrive', 'logs');
    if (!fs.existsSync(appDataLogsDir)) {
      fs.mkdirSync(appDataLogsDir, { recursive: true });
    }
    fallbackLogPath = path.join(appDataLogsDir, 'qadrive-app.log');
  } catch {
    // Fallback failure
  }

  // If local logs failed, use fallback as primary
  if (!primaryLogPath && fallbackLogPath) {
    primaryLogPath = fallbackLogPath;
  }

  isInitialized = true;

  // Header separator
  const header = `\n================================================================================\n` +
    `  QA DRIVE APPLICATION STARTUP\n` +
    `  Time:          ${formatTimestamp()}\n` +
    `  Node:          ${process.version} (${process.arch})\n` +
    `  Platform:      ${process.platform} (${os.type()} ${os.release()})\n` +
    `  PID:           ${process.pid}\n` +
    `  Exec Path:     ${process.execPath}\n` +
    `  Working Dir:   ${process.cwd()}\n` +
    `  Root Dir:      ${rootDir}\n` +
    `  Exe Mode:      ${process.env.QA_DRIVE_EXE_MODE === 'true' ? 'YES (QADrive.exe)' : 'NO (npm/node)'}\n` +
    `  Primary Log:   ${primaryLogPath || 'N/A'}\n` +
    `  Fallback Log:  ${fallbackLogPath || 'N/A'}\n` +
    `================================================================================\n`;

  if (primaryLogPath) safeAppend(primaryLogPath, header);
  if (fallbackLogPath && fallbackLogPath !== primaryLogPath) safeAppend(fallbackLogPath, header);

  // Hook console methods so all stdout/stderr also gets persisted to file
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    origLog.apply(console, args as [unknown, ...unknown[]]);
    const msg = args.map((a) => (typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
    writeLog('INFO', msg);
  };

  console.warn = (...args: unknown[]) => {
    origWarn.apply(console, args as [unknown, ...unknown[]]);
    const msg = args.map((a) => (typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
    writeLog('WARN', msg);
  };

  console.error = (...args: unknown[]) => {
    origError.apply(console, args as [unknown, ...unknown[]]);
    const msg = args.map((a) => (typeof a === 'string' ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a)))).join(' ');
    writeLog('ERROR', msg);
  };

  // Global uncaught exception and unhandled rejection handlers
  process.on('uncaughtException', (err: Error) => {
    writeLog('FATAL', `UNCAUGHT EXCEPTION: ${err.message}`, err);
    origError('FATAL: Uncaught Exception:', err);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    writeLog('FATAL', `UNHANDLED PROMISE REJECTION: ${reason}`, reason);
    origError('FATAL: Unhandled Promise Rejection:', reason);
  });

  process.on('exit', (code: number) => {
    writeLog('INFO', `Process exiting with code ${code}`);
  });

  return { primaryLogPath, fallbackLogPath };
}

export function getActiveLogPaths(): { primary: string; fallback: string } {
  return { primary: primaryLogPath, fallback: fallbackLogPath };
}
