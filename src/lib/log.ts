export type LogLevel = 'info' | 'warn' | 'error';

export type LogEntry = { time: Date; level: LogLevel; text: string };

export type Log = (level: LogLevel, text: string) => void;

export function formatLogEntry(entry: LogEntry): string {
  const t = entry.time;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}`;
  return `${time} [${entry.level.toUpperCase()}] ${entry.text}`;
}

export function formatLog(entries: LogEntry[]): string {
  return entries.map(formatLogEntry).join('\n') + '\n';
}

/** Default file name when the log panel is saved. */
export const LOG_FILE_NAME = 'misskey-archive.log';
