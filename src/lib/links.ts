import { isTauri, openExternal } from './tauri-bridge';

/** The viewer that CI builds and publishes (a ZIP holding index.html). */
export const LATEST_VIEWER_URL = 'https://tools.e17.dev/misskey-archive-downloader/index.html.zip';

/** onClick for links to outside pages: the desktop app opens them in the system browser instead of its own window. */
export function openLinkInBrowser(e: { preventDefault(): void; currentTarget: HTMLAnchorElement }): void {
  if (!isTauri()) return;
  e.preventDefault();
  void openExternal(e.currentTarget.href);
}
