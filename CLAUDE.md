# CLAUDE.md

このファイルは、このリポジトリで作業する Claude Code（claude.ai/code）向けの案内です。

## コマンド

```bash
npm run dev      # 開発サーバーを起動
npm run build    # 型チェック + 本番ビルド
npm run lint     # ESLint
npm run preview  # 本番ビルドをローカルで配信
npm run build:viewer  # ビューア（dist-viewer/index.html）だけを作る。CI はこれを index.html.zip にして latest リリースに入れる

npm run tauri:dev:admin    # 管理者アプリを起動（「管理者アプリ」を参照）
npm run tauri:build:admin  # 管理者アプリをビルド
```

## 構成

シングルページアプリ（Vite + React + TypeScript + Tailwind CSS）で、次のことを行う。
1. 利用者が指定した Misskey のサーバーに **MiAuth**（Misskey のアプリ認証）で認証する
2. Misskey の API から全ノートとドライブファイルを取得する
3. ドライブファイルをダウンロードし、JSON 内の参照をローカルのパスに書き換える
4. すべてを、自己完結型の静的ビューアを含む **ZIP**（zip.js で生成）にまとめてダウンロードさせる

### ルーティング

`src/App.tsx` でハッシュによるルーティングを行う（ルーターのライブラリは使わない）。ルートは 3 つ。
- `/` — `HomePage`: ドメインの入力フォーム
- `/callback/<sessionId>` — `CallbackPage`: MiAuth のセッションを API トークンに交換する
- `/export` — `ExportPage`: 進捗を表示し、ダウンロードを始める

### 主要ファイル

| パス | 役割 |
|------|------|
| `src/lib/miauth.ts` | MiAuth の流れ: `startMiAuth()` でサーバーへリダイレクトし、`completeMiAuth()` で `/api/miauth/<id>/check` に POST する |
| `src/lib/misskey-api.ts` | `MisskeyClient`。ノート・ファイルのページング取得を非同期ジェネレーターで行う |
| `src/lib/exporter.ts` | `buildArchive()` でファイルのダウンロードと ZIP の組み立て（zip.js）をまとめて行う |
| `src/lib/viewer-template.ts` | `index.html` の HTML 全体と、`archive-data.js` / `data/*.js` のスクリプトを返す |
| `src/lib/links.ts` | 配布している差し替え用ビューアの URL（`LATEST_VIEWER_URL`、`index.html.zip`）と、外部のページへのリンクを PC のブラウザで開く `openLinkInBrowser()`。「最新ビューア」のリンクはトップページ・本ツールのエクスポート画面・管理者アプリのどれもこの URL を開き、アプリの中で index.html を作らない |
| `src/lib/tauri-bridge.ts` | デスクトップ版と Web 版の差を吸収する: `fetchBlob()`、`openSaveTarget()`（ファイルへ逐次書き出し）、`openFolderTarget()`（フォルダへそのままのファイルで書き出し）、`saveBlob()` |
| `src/types/misskey.ts` | Misskey API の型と `ArchiveNote` / `ArchiveDriveFile`（`localPath` を持つ） |
| `src/components/LogPanel.tsx`・`src/lib/log.ts`・`src/lib/use-log.ts` | ログ欄（本ツールのエクスポート画面と管理者アプリの右側。狭いときは下）。時刻付きで全文を出し、コピー・保存・クリアができる。1 回のエクスポートで数万行になるので、`useLog` は 200 ms ごとにまとめて画面へ反映する |
| `src/admin/` | 管理者アプリ: `AdminApp.tsx`（画面）、`standard-exports.ts`（`i/export-*` の依頼と結果の待ち受け）、`url-rewrite.ts`、`admin-bridge.ts` |
| `src-tauri/src/lib.rs` | デスクトップ版の Rust 側（`fetch_bytes`・保存の IPC・管理者アプリのコマンドの登録）。Rust から送る通信（`fetch_bytes`・`admin_post_json`）には `user_agent()` の User-Agent を付ける: `Misskey-Archive-Downloader/<版> (+<リポジトリの URL>)`（管理者アプリは `Misskey-Archive-Downloader-for-Admin/<版>`）。版は `src/version.ts` を `include_str!` で読む。Misskey の `/proxy/` は User-Agent が無いと 400、小文字にして `misskey/` を含むと 403 を返すので、User-Agent は必ず付け、`misskey/` を含めない。WebView の `fetch`（本ツールの API と MiAuth の確認）は WebView の User-Agent のまま |
| `src-tauri/src/admin.rs` | 管理者アプリ専用のコマンド: `admin_find_user`（PostgreSQL、読み取りのみ）、`admin_post_json`（Rust からの API 送信）、`admin_tunnel_open` / `admin_tunnel_close`（SSH のポート転送） |

### ZIP の中身

```
archive.zip
└── misskey-archive-<domain>-<date>/
    ├── index.html        ← 自己完結型のビューア（素の JS、依存なし）
    ├── archive-data.js   ← window.__ARCHIVE_INDEX__ + window.__ARCHIVE_PARTS__（data/*.js の一覧）
    ├── data/             ← notes-001.js, favorites-001.js, ...（それぞれ最大約 16M 文字）
    ├── index.json        ← エクスポートのメタ情報（ユーザー・日時・件数）
    ├── notes.json        ← 全ノート。ファイルの URL は files/<name> に書き換え済み
    ├── favorites.json / clips.json（取得したとき）
    ├── error.log         ← 取得の失敗（FAIL）と注意（WARN）だけ
    ├── error-log.js      ← window.__ARCHIVE_ERROR_LOG__ = error.log の内容（ビューアのポップアップ用）
    ├── emojis/           ← ノートで使われているサーバーのカスタム絵文字
    └── files/ fav-files/ clip-files/  ← ダウンロードしたドライブファイル
```

サーバーのカスタム絵文字（`emojis` API の一覧）のうち、アーカイブに入るノート（お気に入り・クリップ、返信先・リノート先を含む）の本文・CW・リアクションで使われているものだけを `buildArchive` が `emojis/<名前><拡張子>` に保存し、`index.emojis` のその名前の値をこの相対パスに書き換える（ビューアは `index.emojis` を `<img src>` にそのまま使う）。拡張子は URL から、無ければ先頭のバイトから決める。絵文字のキャッシュは `buildArchive` の `useEmojiCache`（ドライブファイルの `useFileCache` とは別。保存先は同じ IndexedDB のファイルのストアで、キーは元の URL。サーバー・ユーザーで置き場所を分けないので、URL が同じなら別のユーザーの作成でも当たる。サーバーが違えば URL が違うので当たらない）。両アプリとも「絵文字をキャッシュする」（既定でオン）で切り替える。取得に失敗した絵文字は元の URL のまま残し、error.log に `[emojis]` として書く。他のサーバーの絵文字（`note.emojis`・`reactionEmojis`）は保存しない。

### ログとエラーの出し分け

- ログ欄（画面）: 成功も失敗も出す。`buildArchive` の `onLog` は、添付ファイル・絵文字を 1 件取得するたびに `OK [<フォルダ>] ...`（info）・`WARN ...`（warn）・`FAIL ...`（error）を渡す
- 出力先のファイル: エラーだけ。`buildArchive` が最後に書く `error.log`（FAIL と WARN）。フォルダへの出力が途中で失敗してフォルダを残すときは、`buildArchive` が `error.log` を書く前に止まっているので、画面のログのうち error の行だけを `error.log` に書く（本ツール・管理者アプリとも）。全文のログは出力先に書かない（大きくなるため）

### 大容量のアーカイブ

数万ノートのアカウントでは、アーカイブが数 GB になる。次の不変条件を守る。
- 1 つのデータ全体を 1 本の JS 文字列にしない（エンジンの文字列長の上限は約 2^29 文字）。JSON は Blob の断片から組み立て（`jsonArrayBlob`）、ビューア用のデータは `data/*.js` に分割する。
- JSON アップロードのノートに埋めるアカウントの情報は UserLite の項目だけにする（`toNoteUser`）。`i` の応答をまるごと入れない。
- `buildArchive()` は、ファイルをダウンロードするたびに `ArchiveSink` へ書き込む。実装は `zipSink`（zip.js。Web 版はメモリ上、デスクトップ版はファイルへ逐次書き出し）と `folderSink`（デスクトップ版のみ。圧縮せずにファイルのまま書き出す）の 2 つ。
- デスクトップ版の IPC は生のバイナリで送り、base64 にしない: `save_begin`（保存ダイアログ）または `folder_begin`（フォルダ選択ダイアログ）+ `folder_open_file`（相対パス。区切りごとに検証する）のあと、`save_write`（8 MB 以下ずつ）/ `save_finish`。`save_abort` / `folder_abort` で書きかけの出力を捨てる。
- zip.js は必要に応じて自動で ZIP64 に切り替わる（4 GiB 超、または 65535 エントリ超）。

### 管理者アプリ

閉鎖したサーバーの管理者向けの、別ビルドの Windows・macOS アプリ。ローカルユーザーの代わりに、アーカイブと Misskey の標準エクスポートを作り、1 つの ZIP にまとめる（標準エクスポートは `exports/` の下）。
- 同じソースからビルドする: `admin.html` → `src/admin/main.tsx`、`vite build --mode admin`（→ `dist-admin/`）、`src-tauri/tauri.admin.conf.json`（`tauri.conf.json` に重ねてマージする。Cargo の feature `admin` を有効にし、`tokio-postgres` と管理者用のコマンドが加わる）。本ツールのビルドにはどれも含まれない。CI は `.github/workflows/admin-build.yml`（手動実行のみ）。Windows x64（`--no-bundle`）と macOS の x64・arm64（`--bundles dmg`）をビルドし、リリース `admin-latest` に `Misskey-Archive-Downloader-for-Admin.exe`・`Misskey-Archive-Downloader-for-Admin-macos-x64.dmg`・`Misskey-Archive-Downloader-for-Admin-macos-arm64.dmg` を置く。リリースの説明文は両方のワークフローの `body:` に書く。
- `user` テーブルから読んだ、そのユーザーのネイティブトークンで認証する。`i/export-*` は `secure` なので MiAuth のトークンでは拒否される。ネイティブトークンだと `i` が `email` / `emailVerified` / `securityKeysList` も返すため、アーカイブに入れる前に取り除く。
- API の送信は `MisskeyClient` の `ApiTransport`（Rust の `admin_post_json`）を通すので、サーバーに `http://` のローカルアドレスで接続できる。
- SSH のポート転送: `admin_tunnel_open` が PC の `ssh` コマンドを `-N -L 127.0.0.1:<空きポート>:<host>:<port>`（PostgreSQL と Misskey の 2 つ）、`BatchMode=yes`、`StrictHostKeyChecking=accept-new`、`ExitOnForwardFailure=yes` で起動し、両方のローカルポートが接続を受け付けるまで待つ。ssh の標準エラーは `admin-tunnel-log` イベントでログ欄に出す。プロセスは `TunnelState` に持ち、次の `admin_tunnel_open`・`admin_tunnel_close`・アプリの終了（`RunEvent::Exit`）で止める。Windows では `CREATE_NO_WINDOW` でコンソールを出さない。SSH を使うとき、画面の Misskey の URL と PostgreSQL のホストはサーバーから見た場所として扱う。
- 「X-Gone-Bypass-Token ヘッダを付ける」: 有効なら `X-Gone-Bypass-Token: <トークン>` を、指定したドメイン（改行区切り。`bypass-hosts.ts` の `parseBypassHosts()` で読む。URL を書いてもホストを取り出す）とそのサブドメインへの HTTP 通信にだけ付ける（閉鎖したサーバーのドメインで 410 を返す Cloudflare Workers を通すため）。`tauri-bridge.ts` の `setRequestHeaders(headers, hosts)` に入れ、`requestHeadersFor(url)` が宛先のホストで判定する。`fetchBlob()`（Rust の `fetch_bytes` の `headers`）と `backendTransport`（Rust の `admin_post_json` の `headers`）がこれを使う。値はログに出さない。本ツールは `setRequestHeaders()` を呼ばないので何も付かない。
- サーバーが記録したファイルの URL は、サーバーの公開 URL で始まる。`buildArchive` に渡す `UrlRewriter` が、`/files/` をローカルのサーバーに向け、`/proxy/?url=` から元の URL を取り出し、利用者が指定した置き換えを適用する。アーカイブには元の URL を残す。
- 標準エクスポートの結果は、`drive/files`（ドライブのルート。依頼の前に取った最新のファイル ID より後）を定期的に取得し、`<prefix>-yyyy-MM-dd-HH-mm-ss.<json|csv>` の名前で見つける。結果は sink の `close()` の中で、`buildArchive` がほかのすべてを書き終えたあとに追加する。
- 本ツールの機能はすべて使える。アーカイブの各部（ノート・お気に入り・クリップ）の元データは `api` / `export`（同じ実行で依頼した標準エクスポートの結果。アーカイブを作る前にその種類だけ完了を待つ）/ `file`（手元の JSON）/ `none` から選び、`buildArchive` の `api` / `upload` / `none` に対応させる。保存形式（ZIP / フォルダ）、ノートとドライブファイルのキャッシュ（IndexedDB。キーは公開 URL のホストとユーザー ID）、ビューアのみのダウンロード、テーマの切り替えも本ツールと同じ。MiAuth・保存済みアカウントは使わない。
- 画面の右（狭いときは下）にログ欄（`LogPanel.tsx`）を置き、DB の検索、API の送信（`backendTransport` が記録。トークン `i` は除く）、進捗の文言の変化、標準エクスポートの状態の変化、`buildArchive` の `onLog`、エラーの全文を出す。Rust のエラーは `error_chain()` で原因（`source()`）までつなげて返す（reqwest と tokio-postgres は `Display` に原因を含めない）。

### MiAuth のコールバック URL

Misskey に渡すコールバック URL は `<origin><pathname>#/callback`。Misskey がセッション ID をパスの区切りとして付け足すので、`#/callback/<uuid>` になる。`App.tsx` は起動時にハッシュからこれを読み取る。

### ビューア（ZIP 内）

`viewer-template.ts` は、CSS と素の JS を埋め込んだ 1 ファイルの HTML を生成する。ビューアは次のことを行う。
- `<script>` タグでデータを読み込む（`file://` でも動く）: まず `archive-data.js`、次に `__ARCHIVE_PARTS__` の各パス。各パートは `window.__archiveAddPart(kind, items)` を呼ぶ。旧版のアーカイブは `archive-data.js` で `__ARCHIVE_NOTES__` などを直接定義しており、ビューアはその形式も読める。
- ノートを表示する。メディアの遅延読み込み、投票のグラフ、リアクション、CW の開閉、タグでの絞り込みに対応する
- 全文検索と、公開範囲・ローカルのみ／連合あり（`note.localOnly`）・メディアでの絞り込みに対応する。公開範囲の表示はローカルのみのノートに「・ローカルのみ」を付ける。ページ分けはクライアント側で行う（1 ページ 30 件）
- 画像はライトボックスで表示する
- `index.html#note-<ID>` で開くと、そのノートを含むタブ（ノート・お気に入り・クリップ）に切り替え、絞り込みを解除して該当ページを表示し、ノートを強調する。ノートの枠は `id="note-<ID>"`
- `error.log` の「添付ノート」には `index.html#note-<ID>` と元の URL を書く。取得できなかったファイルをヘッダーなどに出して、開くたびにエラーを見せることはしない
- 右下の「error.log」ボタン（`#errorlog-btn`）で、`error-log.js` を初回だけ `<script>` で読み込み、ポップアップに表示する。`index.html#note-<ID>` はそのノートへ移るリンク、URL は新しいタブのリンクにする。`error-log.js` が無い旧アーカイブでは、`error.log` を直接開くよう案内する
