import { useEffect, useRef, useState } from 'react';
import { saveBlob } from '../lib/tauri-bridge';
import { formatLog, formatLogEntry, LOG_FILE_NAME, type LogEntry, type LogLevel } from '../lib/log';

const levelClass: Record<LogLevel, string> = {
  info: 'text-gray-300',
  warn: 'text-yellow-300',
  error: 'text-red-400',
};

const toolButtonClass = 'px-2 py-1 rounded-md text-xs text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed';

export function LogPanel({ entries, onClear, className = '' }: {
  entries: LogEntry[];
  onClear: () => void;
  className?: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Follow new lines only while the view is at the bottom.
  const followRef = useRef(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const fullText = () => formatLog(entries);

  async function copy() {
    await navigator.clipboard.writeText(fullText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className={`flex flex-col rounded-2xl border border-gray-200 dark:border-gray-800 bg-gray-900 dark:bg-gray-950 overflow-hidden ${className}`}>
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-700 dark:border-gray-800">
        <p className="flex-1 text-xs font-medium text-gray-200">ログ（{entries.length.toLocaleString()} 件）</p>
        <button onClick={copy} disabled={entries.length === 0} className={toolButtonClass}>
          {copied ? 'コピーしました' : 'コピー'}
        </button>
        <button
          onClick={() => saveBlob(new Blob([fullText()], { type: 'text/plain' }), LOG_FILE_NAME)}
          disabled={entries.length === 0}
          className={toolButtonClass}
        >
          保存
        </button>
        <button onClick={onClear} disabled={entries.length === 0} className={toolButtonClass}>
          クリア
        </button>
      </div>
      <div
        ref={bodyRef}
        onScroll={e => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="flex-1 min-h-0 overflow-auto p-3 font-mono text-xs leading-relaxed select-text"
      >
        {entries.length === 0
          ? <p className="text-gray-500">まだログはありません</p>
          : entries.map((entry, i) => (
            <div key={i} className={`whitespace-pre-wrap break-all ${levelClass[entry.level]}`}>
              {formatLogEntry(entry)}
            </div>
          ))}
      </div>
    </section>
  );
}
