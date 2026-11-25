const SESSION_KEY = 'miauth_session';
const SESSION_INSTANCE_KEY = 'miauth_session_instance';
const ACCOUNTS_KEY = 'misskey_accounts'; // { [domain]: StoredAccount[] }

export interface StoredAccount {
  token: string;
  userId: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
}

function loadAccounts(): Record<string, StoredAccount[]> {
  try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '{}'); } catch { return {}; }
}

export function getAccountsForDomain(domain: string): StoredAccount[] {
  return loadAccounts()[domain] ?? [];
}

export function saveAccount(domain: string, account: StoredAccount): void {
  const all = loadAccounts();
  const list = all[domain] ?? [];
  const idx = list.findIndex((a) => a.userId === account.userId);
  if (idx >= 0) list[idx] = account;
  else list.push(account);
  all[domain] = list;
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(all));
}

export function removeAccount(domain: string, userId: string): void {
  const all = loadAccounts();
  all[domain] = (all[domain] ?? []).filter((a) => a.userId !== userId);
  if (all[domain].length === 0) delete all[domain];
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(all));
}

export async function startMiAuth(instanceUrl: string): Promise<void> {
  const { getMiAuthCallbackUrl, isTauri } = await import('./tauri-bridge');
  const sessionId = crypto.randomUUID();
  const appName = 'Misskey Archive Downloader';
  const callbackUrl = getMiAuthCallbackUrl();
  const permissions = 'read:account,read:notes,read:reactions,read:favorites,read:clips';

  localStorage.setItem(SESSION_KEY, sessionId);
  localStorage.setItem(SESSION_INSTANCE_KEY, instanceUrl);

  const authUrl = `https://${instanceUrl}/miauth/${sessionId}?name=${encodeURIComponent(appName)}&callback=${encodeURIComponent(callbackUrl)}&permission=${permissions}`;

  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_auth_window', { url: authUrl });
  } else {
    window.location.href = authUrl;
  }
}

export async function completeMiAuth(sessionId: string): Promise<{ token: string; instanceUrl: string }> {
  const instanceUrl = localStorage.getItem(SESSION_INSTANCE_KEY);
  if (!instanceUrl) throw new Error('セッション情報が見つかりません。最初からやり直してください。');

  const res = await fetch(`https://${instanceUrl}/api/miauth/${sessionId}/check`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('認証に失敗しました');
  const data = await res.json();
  if (!data.ok || !data.token) throw new Error('トークンの取得に失敗しました');

  return { token: data.token, instanceUrl };
}

export function getStoredSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function getSessionInstance(): string | null {
  return localStorage.getItem(SESSION_INSTANCE_KEY);
}

export function clearSession(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(SESSION_INSTANCE_KEY);
}
