import { useEffect, useState } from 'react';
import { completeMiAuth } from '../lib/miauth';

type Props = {
  sessionId: string;
  onSuccess: (token: string, instanceUrl: string) => void;
  onGoHome: () => void;
};

export function CallbackPage({ sessionId, onSuccess, onGoHome }: Props) {
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    completeMiAuth(sessionId)
      .then(({ token, instanceUrl }) => onSuccess(token, instanceUrl))
      .catch((e: Error) => setErrorMsg(e.message));
  }, [sessionId]);

  return (
    <div className="min-h-dvh bg-gray-50 dark:bg-gray-950 flex items-center justify-center p-4">
      <div className="text-center">
        {!errorMsg ? (
          <>
            <div className="text-4xl mb-4 animate-spin inline-block">⚙️</div>
            <p className="text-gray-600 dark:text-gray-400">認証を確認しています...</p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-4">❌</div>
            <p className="text-red-500 mb-4">{errorMsg}</p>
            <button
              onClick={onGoHome}
              className="px-4 py-2 bg-violet-600 text-white rounded-lg text-sm hover:bg-violet-700"
            >
              最初からやり直す
            </button>
          </>
        )}
      </div>
    </div>
  );
}
