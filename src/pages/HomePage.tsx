import { useState } from 'react';
import { startMiAuth, getAccountsForDomain, type StoredAccount } from '../lib/miauth';
import { isTauri } from '../lib/tauri-bridge';
import { LATEST_VIEWER_URL, openLinkInBrowser } from '../lib/links';

type Props = {
  onSuccess: (token: string, instanceUrl: string) => void;
  onCallback: (sessionId: string) => void;
};

async function resetAllData() {
  localStorage.clear();
  try { await indexedDB.deleteDatabase('misskey-archive-cache'); } catch { /* ignore */ }
}

export function HomePage({ onSuccess, onCallback }: Props) {
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [waitingCallback, setWaitingCallback] = useState(false);
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [resetDone, setResetDone] = useState(false);

  function cleanDomain(input: string) {
    return input.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  const cleaned = cleanDomain(domain);
  const savedAccounts: StoredAccount[] = cleaned ? getAccountsForDomain(cleaned) : [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cleaned) {
      setError('インスタンスのドメインを入力してください');
      return;
    }
    setError('');
    await startMiAuth(cleaned);
    // In Tauri mode, auth happens in an embedded window — no waiting screen needed.
  }

  function handlePasteSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = pasteUrl.trim();
    // accept: full URL (misskey-archive://callback?session=UUID) or bare UUID
    const match =
      text.match(/[?&]session=([a-f0-9-]{36})/i) ||
      text.match(/^([a-f0-9-]{36})$/i);
    if (!match) {
      setPasteError('URLが認識できませんでした。コールバックURLまたはセッションIDを貼り付けてください。');
      return;
    }
    onCallback(match[1]);
  }

  async function handleReset() {
    if (!confirm('トークン・アカウント情報・キャッシュをすべて削除します。よろしいですか？')) return;
    await resetAllData();
    setResetDone(true);
    setWaitingCallback(false);
    setPasteUrl('');
    setDomain('');
  }

  if (waitingCallback) {
    return (
      <div className="min-h-dvh bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="text-5xl mb-4">🔑</div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">ブラウザで認証してください</h1>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              ブラウザで「アクセスを許可」すると自動的に画面が切り替わります。<br />
              自動で切り替わらない場合は、ブラウザに表示されたURLを貼り付けてください。
            </p>
          </div>

          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
            <form onSubmit={handlePasteSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  コールバックURL / セッションID
                </label>
                <input
                  type="text"
                  value={pasteUrl}
                  onChange={(e) => { setPasteUrl(e.target.value); setPasteError(''); }}
                  placeholder="misskey-archive://callback?session=..."
                  className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent text-sm"
                  autoFocus
                />
                {pasteError && <p className="mt-1.5 text-xs text-red-500">{pasteError}</p>}
              </div>
              <button
                type="submit"
                className="w-full py-2.5 px-4 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg text-sm transition-colors"
              >
                続ける
              </button>
              <button
                type="button"
                onClick={() => setWaitingCallback(false)}
                className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                ← 戻る
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-5xl mb-4">🗃️</div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Misskey Archive Downloader</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Misskeyのノートとドライブファイルをまとめてダウンロードし、<br />
            ブラウザで閲覧できるアーカイブを作成します。
          </p>
        </div>

        <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Misskeyインスタンスのドメイン
              </label>
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="misskey.io"
                className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent text-sm"
              />
              {error && <p className="mt-1.5 text-xs text-red-500">{error}</p>}
            </div>

            {savedAccounts.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 dark:text-gray-400">保存済みアカウント</p>
                {savedAccounts.map((account) => (
                  <button
                    key={account.userId}
                    type="button"
                    onClick={() => onSuccess(account.token, cleaned)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950 transition-colors text-left"
                  >
                    {account.avatarUrl
                      ? <img src={account.avatarUrl} className="w-8 h-8 rounded-full object-cover shrink-0" alt="" />
                      : <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 shrink-0" />
                    }
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{account.name || account.username}</p>
                      <p className="text-xs text-gray-500 truncate">@{account.username}</p>
                    </div>
                    <span className="ml-auto text-xs text-violet-600 dark:text-violet-400 shrink-0">選択</span>
                  </button>
                ))}
                <button
                  type="submit"
                  className="w-full py-2 text-xs text-gray-400 hover:text-violet-500 border border-dashed border-gray-300 dark:border-gray-700 rounded-lg hover:border-violet-400 transition-colors"
                >
                  + 別のアカウントを追加
                </button>
              </div>
            )}

            {savedAccounts.length === 0 && (
              <button
                type="submit"
                className="w-full py-2.5 px-4 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-lg text-sm transition-colors"
              >
                認証してアーカイブを作成
              </button>
            )}
          </form>
        </div>

        <div className="mt-6 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-900 rounded-xl p-4 text-xs text-blue-700 dark:text-blue-300 space-y-1">
          <p className="font-medium">⚠️ 注意事項</p>
          <p>・このアプリはブラウザ上で動作し、データはサーバーに送信されません。</p>
          <p>・認証トークンはブラウザのローカルストレージに保存されます。</p>
          <p>・ノート数・ファイル数が多い場合、処理に時間がかかります。</p>
        </div>

        <div className="mt-4 text-center text-xs text-gray-400">
          <span>デスクトップ版:&nbsp;</span>
          <a
            href="https://tools.e17.dev/misskey-archive-downloader/Windows-x64.zip"
            onClick={openLinkInBrowser}
            className="hover:text-violet-500 underline decoration-dotted"
          >Windows</a>
          <span>&nbsp;/&nbsp;</span>
          <a
            href="https://tools.e17.dev/misskey-archive-downloader/macos-arm64.dmg"
            onClick={openLinkInBrowser}
            className="hover:text-violet-500 underline decoration-dotted"
          >Mac (Apple Silicon)</a>
          <span>&nbsp;/&nbsp;</span>
          <a
            href="https://tools.e17.dev/misskey-archive-downloader/macos-x64.dmg"
            onClick={openLinkInBrowser}
            className="hover:text-violet-500 underline decoration-dotted"
          >Mac (Intel)</a>
          {!isTauri() && <p className="mt-1">CORSの影響を受けずに画像をダウンロードできます</p>}
          <p className="mt-2">
            <a
              href={LATEST_VIEWER_URL}
              onClick={openLinkInBrowser}
              className="hover:text-violet-500 underline decoration-dotted"
            >最新ビューア（index.html）</a>
            <span>: 作成済みアーカイブの index.html と差し替えるとビューアだけ更新できます</span>
          </p>
        </div>

        <div className="mt-4 text-center">
          {resetDone
            ? <p className="text-xs text-green-600 dark:text-green-400">データをリセットしました</p>
            : (
              <button
                type="button"
                onClick={handleReset}
                className="text-xs text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                保存データ・キャッシュを初期化
              </button>
            )
          }
        </div>
      </div>
    </div>
  );
}
