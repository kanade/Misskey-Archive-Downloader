import { useCallback, useEffect, useRef, useState } from 'react';
import type { Log, LogEntry } from './log';

// One export can log a line per file and emoji (tens of thousands), so the panel is updated in batches.
const FLUSH_MS = 200;

/** Log entries for the log panel. `entriesRef` holds every entry immediately, `entries` follows within FLUSH_MS. */
export function useLog() {
  const entriesRef = useRef<LogEntry[]>([]);
  const timerRef = useRef<number | null>(null);
  const [entries, setEntries] = useState<LogEntry[]>([]);

  const log: Log = useCallback((level, text) => {
    entriesRef.current.push({ time: new Date(), level, text });
    if (timerRef.current != null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setEntries(entriesRef.current.slice());
    }, FLUSH_MS);
  }, []);

  const clear = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);

  return { entries, entriesRef, log, clear };
}
