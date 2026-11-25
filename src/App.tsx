import { useState, useEffect } from 'react';
import { HomePage } from './pages/HomePage';
import { CallbackPage } from './pages/CallbackPage';
import { ExportPage } from './pages/ExportPage';
import { VERSION } from './version';
import { isTauri } from './lib/tauri-bridge';

type Route =
  | { name: 'home' }
  | { name: 'callback'; sessionId: string }
  | { name: 'export'; token: string; instanceUrl: string };

function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const callbackMatch = path.match(/^callback\/([a-f0-9-]{36})$/i);
  if (callbackMatch) return { name: 'callback', sessionId: callbackMatch[1] };
  return { name: 'home' };
}

function detectCallback(): string | null {
  // MiAuth redirects as: <origin>/?session=<uuid>#/callback
  const params = new URLSearchParams(window.location.search);
  const session = params.get('session');
  if (session) return session;

  // fallback: session ID in hash path
  const hashMatch = window.location.hash.match(/callback\/([a-f0-9-]{36})/i);
  if (hashMatch) return hashMatch[1];

  return null;
}

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function getInitialOverridden(): boolean {
  return localStorage.getItem('theme_overridden') === '1';
}

function applyTheme(overridden: boolean) {
  const isDark = overridden ? !prefersDark() : prefersDark();
  document.documentElement.classList.toggle('dark', isDark);
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => {
    const sessionId = detectCallback();
    if (sessionId) return { name: 'callback', sessionId };
    return parseHash(window.location.hash);
  });

  const [overridden, setOverridden] = useState<boolean>(getInitialOverridden);

  useEffect(() => {
    applyTheme(overridden);
    if (overridden) {
      localStorage.setItem('theme_overridden', '1');
    } else {
      localStorage.removeItem('theme_overridden');
    }
  }, [overridden]);

  // Follow OS changes when not overridden
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (!overridden) applyTheme(false); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [overridden]);

  useEffect(() => {
    function onHashChange() {
      const sessionId = detectCallback();
      if (sessionId) {
        setRoute({ name: 'callback', sessionId });
      } else {
        setRoute(parseHash(window.location.hash));
      }
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Tauri: receive miauth callback (session ID emitted by open_auth_window)
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('miauth-callback', (event) => {
        const sessionId = event.payload;
        if (sessionId) setRoute({ name: 'callback', sessionId });
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []);

  // Tauri: F12 / Ctrl+Shift+I opens DevTools
  useEffect(() => {
    if (!isTauri()) return;
    const handler = async (e: KeyboardEvent) => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('toggle_devtools');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  function handleAuthSuccess(token: string, instanceUrl: string) {
    setRoute({ name: 'export', token, instanceUrl });
  }

  function handleGoHome() {
    history.replaceState(null, '', window.location.pathname);
    setRoute({ name: 'home' });
  }

  const currentlyDark = overridden ? !prefersDark() : prefersDark();
  const themeIcon = currentlyDark ? '🌙' : '☀️';
  const themeLabel = overridden ? 'OS設定に戻す' : (currentlyDark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');

  function handleCallback(sessionId: string) {
    setRoute({ name: 'callback', sessionId });
  }

  const page = route.name === 'callback'
    ? <CallbackPage sessionId={route.sessionId} onSuccess={handleAuthSuccess} onGoHome={handleGoHome} />
    : route.name === 'export'
    ? <ExportPage token={route.token} instanceUrl={route.instanceUrl} onGoHome={handleGoHome} />
    : <HomePage onSuccess={handleAuthSuccess} onCallback={handleCallback} />;

  return (
    <>
      {page}
      <button
        onClick={() => setOverridden((v) => !v)}
        title={`テーマ: ${themeLabel}`}
        className="fixed bottom-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow text-base hover:scale-110 transition-transform"
      >
        {themeIcon}
      </button>
      <p className="fixed bottom-1.5 left-1/2 -translate-x-1/2 text-[10px] text-gray-400 dark:text-gray-500 select-none pointer-events-none">
        {VERSION}
      </p>
    </>
  );
}
