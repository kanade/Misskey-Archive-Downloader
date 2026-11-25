/** Data file loaded by the viewer via <script src> (works on file:// where fetch does not). */
export type ArchiveDataKind = 'notes' | 'favorites' | 'clips';

/** archive-data.js: the export index plus the data scripts the viewer loads in order. */
export function archiveDataJs(indexJson: string, partPaths: string[]): string {
  return [
    `window.__ARCHIVE_INDEX__ = ${indexJson};`,
    `window.__ARCHIVE_PARTS__ = ${JSON.stringify(partPaths)};`,
  ].join('\n');
}

/** One data script listed in __ARCHIVE_PARTS__, holding JSON-encoded items of one kind. */
export function archiveDataPartJs(kind: ArchiveDataKind, itemsJson: string[]): string {
  return `window.__archiveAddPart(${JSON.stringify(kind)}, [${itemsJson.join(',')}]);\n`;
}

export function viewerHtml(version = ''): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Misskey Archive</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --bg: #f8f7f5;
      --surface: #ffffff;
      --border: #e8e6e0;
      --text: #374151;
      --text-muted: #9ca3af;
      --text-heading: #111827;
      --accent: #7c3aed;
      --accent-light: #ede9fe;
      --tag: #dbeafe;
      --tag-text: #1d4ed8;
      --cw-bg: #fef9c3;
      --cw-text: #92400e;
      --renote: #ecfdf5;
      --renote-border: #6ee7b7;
      --sidebar-w: 200px;
    }
    .dark {
      --bg: #0f0f13;
      --surface: #1a1a24;
      --border: #2d2d3a;
      --text: #d1d5db;
      --text-muted: #6b7280;
      --text-heading: #f9fafb;
      --accent: #a78bfa;
      --accent-light: #1e1b4b;
      --tag: #1e3a5f;
      --tag-text: #93c5fd;
      --cw-bg: #2d2208;
      --cw-text: #fcd34d;
      --renote: #052e16;
      --renote-border: #4ade80;
    }
    @media (prefers-color-scheme: dark) {
      :root:not(.light) {
        --bg: #0f0f13;
        --surface: #1a1a24;
        --border: #2d2d3a;
        --text: #d1d5db;
        --text-muted: #6b7280;
        --text-heading: #f9fafb;
        --accent: #a78bfa;
        --accent-light: #1e1b4b;
        --tag: #1e3a5f;
        --tag-text: #93c5fd;
        --cw-bg: #2d2208;
        --cw-text: #fcd34d;
        --renote: #052e16;
        --renote-border: #4ade80;
      }
    }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: system-ui, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.6; }
    #wrap { max-width: 1060px; margin: 0 auto; padding: 0 16px 80px; }

    .user-header { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
    .avatar { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; }
    .user-info h1 { margin: 0; font-size: 22px; color: var(--text-heading); }
    .user-info p { margin: 0; font-size: 13px; color: var(--text-muted); }
    .stats { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-muted); }
    .stats strong { color: var(--text-heading); }

    #layout { display: grid; grid-template-columns: 1fr var(--sidebar-w); gap: 24px; align-items: start; }
    #sidebar-toggle { display: none; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); font-size: 20px; cursor: pointer; align-self: center; flex-shrink: 0; }
    #sidebar-toggle:hover { border-color: var(--accent); }
    #sidebar-close { display: none; }
    @media (max-width: 640px) {
      #layout { grid-template-columns: 1fr; }
      #sidebar-toggle { display: flex; }
      #sidebar { display: none; }
    }
    header { padding: 32px 0 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
    #header-content { flex: 1; min-width: 0; }

    #tab-bar { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
    .tab-btn { padding: 8px 16px; font-size: 13px; font-weight: 500; color: var(--text-muted); cursor: pointer; border: none; background: none; border-bottom: 2px solid transparent; margin-bottom: -1px; transition: color 0.15s; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--accent); border-bottom-color: var(--accent); }
    .clip-section { margin-bottom: 24px; }
    .clip-header { font-size: 14px; font-weight: 700; color: var(--text-heading); padding: 10px 0 8px; border-bottom: 1px solid var(--border); margin-bottom: 10px; display: flex; align-items: baseline; gap: 8px; }
    .clip-desc { font-size: 12px; color: var(--text-muted); font-weight: 400; }
    .search-bar { display: flex; gap: 8px; margin-bottom: 12px; }
    .search-bar input { flex: 1; padding: 8px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 14px; outline: none; }
    .search-bar input:focus { border-color: var(--accent); }
    .filter-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px; font-size: 13px; }
    .filter-row select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font-size: 13px; cursor: pointer; }
    .result-count { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }

    /* Calendar sidebar */
    #sidebar { position: sticky; top: 16px; }
    .sidebar-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 12px; }
    .sidebar-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 10px; }
    .cal-year { margin-bottom: 8px; }
    .cal-year-label { font-size: 13px; font-weight: 600; color: var(--text-heading); cursor: pointer; padding: 2px 4px; border-radius: 4px; display: flex; align-items: center; justify-content: space-between; }
    .cal-year-label:hover { background: var(--accent-light); color: var(--accent); }
    .cal-year-label.active { color: var(--accent); }
    .cal-months { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; margin-top: 4px; }
    .cal-month { font-size: 12px; padding: 3px 4px; border-radius: 4px; cursor: pointer; text-align: center; color: var(--text-muted); white-space: nowrap; }
    .cal-month:hover { background: var(--accent-light); color: var(--accent); }
    .cal-month.active { background: var(--accent); color: #fff; font-weight: 600; }
    .cal-month.empty { opacity: 0.25; cursor: default; pointer-events: none; padding: 3px 4px; }
    .cal-month.empty:hover { background: none; }
    .cal-clear { font-size: 12px; color: var(--accent); cursor: pointer; text-align: center; margin-top: 6px; padding: 4px; border-radius: 4px; }
    .cal-clear:hover { background: var(--accent-light); }

    .note-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
    .note-card.is-renote { border-left: 3px solid var(--accent); }
    .note-card.highlight { outline: 2px solid var(--accent); outline-offset: 2px; }
    .note-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .note-avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; }
    .note-user { flex: 1; }
    .note-user .display-name { font-weight: 600; color: var(--text-heading); font-size: 14px; }
    .note-user .username { font-size: 12px; color: var(--text-muted); }
    .note-date { font-size: 12px; color: var(--text-muted); white-space: nowrap; }
    .visibility-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--accent-light); color: var(--accent); }

    .cw-label { background: var(--cw-bg); color: var(--cw-text); padding: 4px 10px; border-radius: 6px; font-size: 13px; margin-bottom: 8px; cursor: pointer; display: inline-block; }
    .cw-content { margin-top: 8px; }
    .note-text { white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
    .note-text a { color: var(--accent); text-decoration: none; }
    .note-text a:hover { text-decoration: underline; }
    .note-text code { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-size: 0.88em; font-family: monospace; }

    .media-grid { display: grid; gap: 6px; margin-bottom: 10px; }
    .media-grid.count-1 { grid-template-columns: 1fr; }
    .media-grid.count-2 { grid-template-columns: 1fr 1fr; }
    .media-grid.count-3 { grid-template-columns: 1fr 1fr 1fr; }
    .media-grid.count-4 { grid-template-columns: 1fr 1fr; }
    .media-grid img, .media-grid video { width: 100%; border-radius: 8px; max-height: 400px; object-fit: cover; cursor: pointer; }
    .media-grid audio { width: 100%; }
    .media-file { padding: 8px 12px; background: var(--bg); border-radius: 6px; font-size: 13px; color: var(--text-muted); }

    .poll { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 10px; }
    .poll-choice { padding: 8px 12px; position: relative; font-size: 13px; }
    .poll-bar { position: absolute; inset: 0; background: var(--accent-light); z-index: 0; transition: width 0.3s; }
    .poll-choice-text { position: relative; z-index: 1; display: flex; justify-content: space-between; }

    .reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
    .reaction { padding: 3px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 100px; position: relative; cursor: default; display: inline-flex; align-items: center; gap: 3px; }
    /* reaction size variants */
    .rxs-sm .reaction { font-size: 12px; padding: 2px 7px; }
    .rxs-md .reaction { font-size: 15px; padding: 4px 11px; }
    .rxs-lg .reaction { font-size: 18px; padding: 5px 13px; }
    .reaction-tooltip { display: none; position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: #fff; font-size: 11px; padding: 4px 8px; border-radius: 6px; white-space: nowrap; z-index: 100; pointer-events: none; max-width: 200px; white-space: normal; text-align: center; }
    .reaction:hover .reaction-tooltip { display: block; }

    .renote-quote { background: var(--renote); border: 1px solid var(--renote-border); border-radius: 8px; padding: 10px 14px; margin-bottom: 10px; font-size: 13px; }
    .renote-quote .rn-header { font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }

    .note-footer { display: flex; gap: 16px; font-size: 13px; color: var(--text-muted); padding-top: 8px; border-top: 1px solid var(--border); }
    .note-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .tag { font-size: 12px; padding: 2px 8px; background: var(--tag); color: var(--tag-text); border-radius: 100px; cursor: pointer; }

    .emoji-fb { font-size: 0.82em; color: var(--text-muted); background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; vertical-align: middle; }
    .media-missing { display: flex; align-items: center; justify-content: center; gap: 8px; background: var(--bg); border: 1px dashed var(--border); border-radius: 8px; padding: 20px; color: var(--text-muted); font-size: 13px; width: 100%; }

    /* Calendar modal (mobile only) */
    #cal-modal { display: none; position: fixed; inset: 0; z-index: 500; background: rgba(0,0,0,0.45); touch-action: none; }
    #cal-modal.open { display: flex; align-items: flex-start; justify-content: center; padding-top: 56px; }
    #cal-modal-box { background: var(--bg); border-radius: 14px; padding: 16px; max-height: 75vh; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; touch-action: pan-y; width: min(320px, 90vw); box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
    #cal-modal-close { display: flex; align-items: center; justify-content: flex-end; margin-bottom: 8px; }
    #cal-modal-close button { background: none; border: none; font-size: 18px; color: var(--text-muted); cursor: pointer; padding: 4px 8px; border-radius: 6px; }
    #cal-modal-close button:hover { background: var(--border); }
    @media (min-width: 641px) { #cal-modal { display: none !important; } }

    .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 1000; align-items: center; justify-content: center; cursor: zoom-out; touch-action: none; }
    body.lb-open #wrap { pointer-events: none; }
    .lightbox.open { display: flex; }
    .lightbox img { max-width: calc(95vw - 80px); max-height: 95vh; object-fit: contain; border-radius: 4px; cursor: zoom-out; }
    .lb-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.15); border: none; color: #fff; font-size: 2.5rem; line-height: 1; padding: 8px 14px; border-radius: 8px; cursor: pointer; z-index: 1; transition: background 0.15s; }
    .lb-nav:hover { background: rgba(255,255,255,0.3); }
    .lb-nav:disabled { opacity: 0.2; cursor: default; }
    #lb-prev { left: 12px; }
    #lb-next { right: 12px; }
    .lb-counter { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); color: rgba(255,255,255,0.7); font-size: 13px; pointer-events: none; }

    .pagination { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 16px; flex-wrap: wrap; }
    .pg-btn { padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font-size: 13px; cursor: pointer; min-width: 36px; text-align: center; }
    .pg-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
    .pg-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
    .pg-btn:disabled { opacity: 0.35; cursor: default; }
    .pg-info { font-size: 13px; color: var(--text-muted); padding: 0 4px; }

    .empty { text-align: center; padding: 60px 20px; color: var(--text-muted); }

    /* Settings panel */
    #settings-btn { position: fixed; bottom: 4rem; right: 1rem; width: 36px; height: 36px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; z-index: 200; }
    #settings-btn:hover { transform: scale(1.1); }
    #settings-panel { display: none; position: fixed; bottom: 7rem; right: 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: 0 4px 16px rgba(0,0,0,0.15); z-index: 200; min-width: 200px; }
    #settings-panel.open { display: block; }
    .settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; font-size: 13px; }
    .settings-row:last-child { margin-bottom: 0; }
    .settings-label { color: var(--text-muted); white-space: nowrap; }
    .seg-btns { display: flex; gap: 2px; }
    .seg-btn { font-size: 12px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; }
    .seg-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

    /* Theme toggle */
    #theme-btn { position: fixed; bottom: 1rem; right: 1rem; width: 36px; height: 36px; border-radius: 50%; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center; z-index: 200; transition: transform 0.1s; }
    #theme-btn:hover { transform: scale(1.1); }
    #errorlog-btn { position: fixed; bottom: 1rem; right: 4rem; height: 36px; padding: 0 12px; border-radius: 18px; background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); box-shadow: 0 2px 8px rgba(0,0,0,0.15); cursor: pointer; font-size: 12px; z-index: 200; }
    #errorlog-btn:hover { color: var(--text); }
    #errorlog-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 300; align-items: center; justify-content: center; padding: 16px; }
    #errorlog-modal.open { display: flex; }
    #errorlog-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; width: 100%; max-width: 960px; max-height: 85vh; display: flex; flex-direction: column; }
    #errorlog-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); font-weight: 600; }
    #errorlog-text { margin: 0; padding: 12px 16px; overflow: auto; white-space: pre-wrap; word-break: break-all; font-family: monospace; font-size: 12px; line-height: 1.6; }
    #errorlog-text a { color: var(--accent); }
  </style>
</head>
<body>
<div id="wrap">
  <header id="header">
    <div id="header-content"></div>
    <button id="sidebar-toggle" onclick="_toggleSidebar()" title="カレンダー">📅</button>
  </header>
  <div id="layout">
    <div id="main">
      <div id="tab-bar"></div>
      <div id="controls"></div>
      <div id="clip-controls" style="display:none"></div>
      <div id="result-count"></div>
      <div id="notes-list"></div>
    </div>
    <aside id="sidebar">
      <button id="sidebar-close" onclick="_toggleSidebar()">✕ 閉じる</button>
      <div class="sidebar-section">
        <div class="sidebar-title">アーカイブ</div>
        <div id="calendar"></div>
      </div>
    </aside>
  </div>
</div>
<div id="cal-modal">
  <div id="cal-modal-box">
    <div id="cal-modal-close"><button onclick="_toggleSidebar()" title="閉じる">✕</button></div>
    <div class="sidebar-section" style="margin-bottom:0">
      <div class="sidebar-title">アーカイブ</div>
      <div id="calendar-modal"></div>
    </div>
  </div>
</div>
<div class="lightbox" id="lightbox">
  <button class="lb-nav" id="lb-prev">&#8249;</button>
  <img id="lightbox-img" src="" alt="" />
  <button class="lb-nav" id="lb-next">&#8250;</button>
  <div class="lb-counter" id="lb-counter"></div>
</div>
<button id="settings-btn" title="表示設定">⚙️</button>
<div id="settings-panel">
  <div class="settings-row">
    <span class="settings-label">リアクション</span>
    <div class="seg-btns" id="rxsize-seg"></div>
  </div>
  <div class="settings-row">
    <span class="settings-label">表示スタイル</span>
    <div class="seg-btns" id="navmode-seg"></div>
  </div>
  <div class="settings-row" id="pgsize-row">
    <span class="settings-label">件数</span>
    <div class="seg-btns" id="pgsize-seg"></div>
  </div>
</div>
<button id="theme-btn" title="テーマ切り替え"></button>
<button id="errorlog-btn" title="取得できなかったファイルの記録を表示">error.log</button>
<div id="errorlog-modal">
  <div id="errorlog-box">
    <div id="errorlog-head"><span>error.log</span><button class="pg-btn" id="errorlog-close">閉じる</button></div>
    <pre id="errorlog-text"></pre>
  </div>
</div>
${version ? `<p style="position:fixed;bottom:6px;left:50%;transform:translateX(-50%);margin:0;font-size:10px;color:var(--text-muted);opacity:0.6;pointer-events:none;user-select:none;white-space:nowrap;z-index:100">${version}</p>` : ''}
<script src="./archive-data.js"></script>
<script>
(function() {
  let allNotes = [];
  let filtered = [];
  let page = 0;
  let cwExpanded = new Set();
  const index = window.__ARCHIVE_INDEX__;
  let allFavorites = [];
  let allClips = [];
  let activeTab = 'notes'; // 'notes' | 'favorites' | 'clips'
  let selectedClipIdx = -1;

  // --- Settings ---
  function lsGet(key, def) { try { return localStorage.getItem(key) ?? def; } catch { return def; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch {} }

  const settings = {
    themeOverridden: lsGet('arc_theme_ov', '0') === '1',
    rxSize: lsGet('arc_rxsize', 'md'),
    navMode: lsGet('arc_nav', 'more'),
    pgSize: parseInt(lsGet('arc_pgsize', '50'), 10),
  };

  function prefersDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }

  function applyTheme() {
    const isDark = settings.themeOverridden ? !prefersDark() : prefersDark();
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.classList.toggle('light', !isDark);
    const icon = isDark ? '🌙' : '☀️';
    document.getElementById('theme-btn').textContent = icon;
    document.querySelectorAll('#theme-seg .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.v === (settings.themeOverridden ? 'override' : 'os'));
    });
  }

  function applyRxSize() {
    const nl = document.getElementById('notes-list');
    nl.classList.remove('rxs-sm', 'rxs-md', 'rxs-lg');
    nl.classList.add('rxs-' + settings.rxSize);
    document.querySelectorAll('#rxsize-seg .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.v === settings.rxSize);
    });
  }

  function updatePgSizeRowVisibility() {
    document.getElementById('pgsize-row').style.display = settings.navMode === 'page' ? '' : 'none';
  }

  function initSettings() {
    // Reaction size seg
    const rseg = document.getElementById('rxsize-seg');
    [['sm','小'],['md','中'],['lg','大']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = 'seg-btn'; b.dataset.v = v; b.textContent = label;
      b.onclick = () => {
        settings.rxSize = v;
        lsSet('arc_rxsize', v);
        applyRxSize();
      };
      rseg.appendChild(b);
    });
    // Nav mode seg
    const nseg = document.getElementById('navmode-seg');
    [['more','追加読込'],['page','ページ切替']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = 'seg-btn'; b.dataset.v = v; b.textContent = label;
      b.onclick = () => {
        settings.navMode = v;
        lsSet('arc_nav', v);
        document.querySelectorAll('#navmode-seg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.v === v));
        updatePgSizeRowVisibility();
        page = 0; if (activeTab === 'notes') applyFilter();
      };
      if (settings.navMode === v) b.classList.add('active');
      nseg.appendChild(b);
    });
    // Page size seg
    const pseg = document.getElementById('pgsize-seg');
    [['25','25'],['50','50'],['100','100']].forEach(([v, label]) => {
      const b = document.createElement('button');
      b.className = 'seg-btn'; b.dataset.v = v; b.textContent = label;
      b.onclick = () => {
        settings.pgSize = parseInt(v, 10);
        lsSet('arc_pgsize', v);
        document.querySelectorAll('#pgsize-seg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.v === v));
        page = 0; if (activeTab === 'notes') renderPage();
      };
      if (settings.pgSize === parseInt(v, 10)) b.classList.add('active');
      pseg.appendChild(b);
    });
    updatePgSizeRowVisibility();

    document.getElementById('theme-btn').onclick = () => {
      settings.themeOverridden = !settings.themeOverridden;
      lsSet('arc_theme_ov', settings.themeOverridden ? '1' : '0');
      applyTheme();
    };

    document.getElementById('settings-btn').onclick = (e) => {
      e.stopPropagation();
      document.getElementById('settings-panel').classList.toggle('open');
    };
    document.addEventListener('click', () => {
      document.getElementById('settings-panel').classList.remove('open');
    });
    document.getElementById('settings-panel').addEventListener('click', e => e.stopPropagation());

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!settings.themeOverridden) applyTheme();
    });

    applyTheme();
    applyRxSize();
  }

  // --- Calendar ---
  let calYear = null, calMonth = null;
  let calMap = {}; // { year: { month: count } }

  function buildCalMap() {
    calMap = {};
    for (const n of allNotes) {
      const d = new Date(n.createdAt);
      const y = d.getFullYear(), m = d.getMonth() + 1;
      if (!calMap[y]) calMap[y] = {};
      calMap[y][m] = (calMap[y][m] || 0) + 1;
    }
  }

  function renderCalendar() {
    const years = Object.keys(calMap).map(Number).sort((a,b) => b - a);
    let html = '';
    for (const y of years) {
      const isYearActive = calYear === y;
      const total = Object.values(calMap[y]).reduce((a,b)=>a+b,0);
      html += \`<div class="cal-year">
        <div class="cal-year-label \${isYearActive ? 'active' : ''}" onclick="_calYear(\${y})">\${y}年 <span style="font-size:11px;color:var(--text-muted)">\${total}</span></div>
        <div class="cal-months">\`;
      for (let m = 1; m <= 12; m++) {
        const cnt = calMap[y][m] || 0;
        const isActive = calYear === y && calMonth === m;
        if (cnt) {
          html += \`<div class="cal-month\${isActive ? ' active' : ''}" onclick="_calMonth(\${y},\${m})" title="\${cnt}件">\${m}月</div>\`;
        } else {
          html += \`<div class="cal-month empty">\${m}月</div>\`;
        }
      }
      html += '</div></div>';
    }
    if (calYear !== null) {
      html += '<div class="cal-clear" onclick="_calClear()">✕ 絞り込み解除</div>';
    }
    // render into both desktop sidebar and mobile modal
    const desktopEl = document.getElementById('calendar');
    if (desktopEl) desktopEl.innerHTML = html;
    const modalEl = document.getElementById('calendar-modal');
    if (modalEl) modalEl.innerHTML = html;
  }

  window._calYear = function(y) {
    if (calYear === y && calMonth === null) { calYear = null; }
    else { calYear = y; calMonth = null; }
    page = 0; applyFilter(); renderCalendar();
  };
  window._calMonth = function(y, m) {
    if (calYear === y && calMonth === m) { calYear = null; calMonth = null; }
    else { calYear = y; calMonth = m; }
    page = 0; applyFilter(); renderCalendar();
  };
  window._calClear = function() {
    calYear = null; calMonth = null;
    page = 0; applyFilter(); renderCalendar();
  };

  // --- Init ---
  // Archives list their data scripts in __ARCHIVE_PARTS__; older archives define the arrays in archive-data.js itself.
  async function loadArchiveParts() {
    const parts = window.__ARCHIVE_PARTS__;
    if (!parts) return;
    const store = { notes: [], favorites: [], clips: [] };
    window.__archiveAddPart = (kind, items) => {
      const target = store[kind];
      for (const item of items) target.push(item);
    };
    const status = document.getElementById('result-count');
    for (let i = 0; i < parts.length; i++) {
      status.textContent = 'データを読み込み中... (' + (i + 1) + ' / ' + parts.length + ')';
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = parts[i];
        s.onload = () => { s.remove(); resolve(); };
        s.onerror = () => reject(new Error(parts[i]));
        document.head.appendChild(s);
      });
    }
    window.__ARCHIVE_NOTES__ = store.notes;
    window.__ARCHIVE_FAVORITES__ = store.favorites;
    window.__ARCHIVE_CLIPS__ = store.clips;
  }

  function init() {
    allNotes = (window.__ARCHIVE_NOTES__ || []).slice().sort((a, b) => a.id < b.id ? 1 : -1);
    allFavorites = window.__ARCHIVE_FAVORITES__ || [];
    allClips = window.__ARCHIVE_CLIPS__ || [];
    initSettings();
    buildCalMap();
    renderHeader();
    renderControls();
    renderCalendar();
    applyFilter();
    const noteId = noteIdFromHash();
    if (noteId) showNote(noteId);
  }

  // --- Tab switching ---
  window._switchTab = function(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const showSidebar = tab === 'notes';
    document.getElementById('sidebar').style.display = showSidebar ? '' : 'none';
    const sidebarToggle = document.getElementById('sidebar-toggle');
    if (sidebarToggle) sidebarToggle.style.display = showSidebar ? '' : 'none';
    document.getElementById('clip-controls').style.display = tab === 'clips' ? '' : 'none';
    if (tab === 'clips') renderClipSelector();
    page = 0;
    applyFilter();
  };

  window._selectClip = function(idx) {
    selectedClipIdx = idx;
    page = 0;
    applyFilter();
  };

  function renderClipSelector() {
    const cc = document.getElementById('clip-controls');
    if (!allClips.length) { cc.innerHTML = ''; return; }
    let html = '<select id="clip-select" onchange="window._selectClip(parseInt(this.value))" style="font-size:13px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);cursor:pointer;width:100%">' +
      '<option value="-1">クリップを選択してください</option>';
    allClips.forEach((clip, i) => {
      html += \`<option value="\${i}"\${i === selectedClipIdx ? ' selected' : ''}>\${esc(clip.name)} (\${clip.clipNotes.length}件)</option>\`;
    });
    html += '</select>';
    cc.innerHTML = html;
  }

  function renderHeader() {
    const u = index.user;
    document.title = (u.name || u.username) + ' - Misskey Archive';
    document.getElementById('header-content').innerHTML = \`
      <div class="user-header" onclick="_resetAll()" title="フィルターをリセットして先頭に戻る" style="cursor:pointer">
        \${u.avatarUrl ? \`<img class="avatar" src="\${esc(u.avatarUrl)}" onerror="this.style.display='none'" alt="" />\` : ''}
        <div class="user-info">
          <h1>\${esc(u.name || u.username)}</h1>
          <p>@\${esc(u.username)}@\${esc(index.instanceUrl)}</p>
        </div>
      </div>
      <div class="stats" onclick="_resetAll()" title="フィルターをリセットして先頭に戻る" style="cursor:pointer">
        <span><strong>\${index.noteCount.toLocaleString()}</strong> ノート</span>
        <span>エクスポート: \${(() => { const d = new Date(index.exportedAt); const pad = n => String(n).padStart(2,'0'); return d.getFullYear() + '/' + pad(d.getMonth()+1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); })()}</span>
      </div>
    \`;
  }

  function renderControls() {
    const hasFav = allFavorites.length > 0;
    const hasClips = allClips.length > 0;
    if (hasFav || hasClips) {
      document.getElementById('tab-bar').innerHTML =
        '<button class="tab-btn active" data-tab="notes" onclick="_switchTab(this.dataset.tab)">ノート</button>' +
        (hasFav ? '<button class="tab-btn" data-tab="favorites" onclick="_switchTab(this.dataset.tab)">お気に入り</button>' : '') +
        (hasClips ? '<button class="tab-btn" data-tab="clips" onclick="_switchTab(this.dataset.tab)">クリップ</button>' : '');
    }
    document.getElementById('controls').innerHTML = \`
      <div class="search-bar">
        <input type="search" id="search-input" placeholder="ノートを検索..." oninput="window._search()" />
      </div>
      <div class="filter-row">
        <select id="vis-filter" onchange="window._applyFilter()">
          <option value="">すべての公開範囲</option>
          <option value="public">公開</option>
          <option value="home">ホーム</option>
          <option value="followers">フォロワー</option>
          <option value="specified">指定ユーザー</option>
        </select>
        <select id="local-filter" onchange="window._applyFilter()">
          <option value="">連合あり・ローカルのみ</option>
          <option value="local">ローカルのみ</option>
          <option value="federated">連合あり</option>
        </select>
        <select id="media-filter" onchange="window._applyFilter()">
          <option value="">すべて</option>
          <option value="media">メディアあり</option>
          <option value="text">テキストのみ</option>
        </select>
        <select id="sort-filter" onchange="window._applyFilter()">
          <option value="desc">新しい順</option>
          <option value="asc">古い順</option>
        </select>
      </div>
    \`;
  }

  let searchTimer;
  window._search = function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 0; applyFilter(); }, 200);
  };
  window._applyFilter = function() { page = 0; applyFilter(); };
  window._toggleSidebar = function() {
    const isMobile = window.innerWidth <= 640;
    if (isMobile) {
      const modal = document.getElementById('cal-modal');
      const isOpen = modal.classList.toggle('open');
      document.body.classList.toggle('sidebar-open', isOpen);
      if (isOpen) renderCalendar();
    } else {
      const s = document.getElementById('sidebar');
      const isOpen = s.classList.toggle('open');
      if (isOpen) renderCalendar();
    }
  };
  window._resetAll = function() {
    document.getElementById('search-input').value = '';
    document.getElementById('vis-filter').value = '';
    document.getElementById('local-filter').value = '';
    document.getElementById('media-filter').value = '';
    document.getElementById('sort-filter').value = 'desc';
    calYear = null; calMonth = null;
    page = 0;
    applyFilter();
    renderCalendar();
    window.scrollTo({ top: 0 });
  };
  window._tag = function(tag) {
    document.getElementById('search-input').value = '#' + tag;
    page = 0; applyFilter();
  };

  // --- Opening a note by id: index.html#note-<id> ---
  function locateNote(id) {
    if (allNotes.some(n => n.id === id)) return { tab: 'notes' };
    if (allFavorites.some(f => f.note && f.note.id === id)) return { tab: 'favorites' };
    const clipIdx = allClips.findIndex(c => c.clipNotes.some(cn => cn.note && cn.note.id === id));
    if (clipIdx >= 0) return { tab: 'clips', clipIdx };
    return null;
  }

  function showNote(id) {
    const loc = locateNote(id);
    if (!loc) {
      document.getElementById('result-count').textContent = 'このアーカイブにはノート ' + id + ' がありません';
      return;
    }
    // Filters are cleared so that the note is in the list.
    document.getElementById('search-input').value = '';
    document.getElementById('vis-filter').value = '';
    document.getElementById('local-filter').value = '';
    document.getElementById('media-filter').value = '';
    document.getElementById('sort-filter').value = 'desc';
    calYear = null; calMonth = null;
    renderCalendar();
    if (loc.tab === 'clips') selectedClipIdx = loc.clipIdx;
    window._switchTab(loc.tab);
    const idx = filtered.findIndex(n => n.id === id);
    page = Math.floor(Math.max(idx, 0) / settings.pgSize);
    renderPage(false);
    const el = document.getElementById('note-' + id);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('highlight');
      setTimeout(() => el.classList.remove('highlight'), 3000);
    }
  }

  function noteIdFromHash() {
    return location.hash.startsWith('#note-') ? decodeURIComponent(location.hash.slice(6)) : null;
  }

  window.addEventListener('hashchange', () => {
    const id = noteIdFromHash();
    if (id) showNote(id);
  });

  // --- error.log popup ---
  // error-log.js is written next to error.log; opened from file://, the text can only be read through a script.
  function loadErrorLog() {
    if (window.__ARCHIVE_ERROR_LOG__ !== undefined) return Promise.resolve(window.__ARCHIVE_ERROR_LOG__);
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = './error-log.js';
      s.onload = () => { s.remove(); resolve(window.__ARCHIVE_ERROR_LOG__ ?? null); };
      s.onerror = () => { s.remove(); resolve(null); };
      document.head.appendChild(s);
    });
  }

  // Note references (index.html#note-<id>) open the note in this viewer; URLs open in a new tab.
  function linkifyLog(text) {
    return esc(text)
      .replace(/index\\.html#note-([A-Za-z0-9]+)/g, (m, id) => '<a href="#note-' + id + '" data-note="' + id + '">' + m + '</a>')
      .replace(/https?:\\/\\/[^\\s）)<]+/g, u => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>');
  }

  async function openErrorLog() {
    const pre = document.getElementById('errorlog-text');
    pre.textContent = '読み込み中...';
    document.getElementById('errorlog-modal').classList.add('open');
    const text = await loadErrorLog();
    if (text === null) {
      pre.textContent = 'このアーカイブには表示用の error.log がありません。index.html と同じフォルダの error.log を開いてください。';
      return;
    }
    pre.innerHTML = linkifyLog(text);
  }

  function closeErrorLog() {
    document.getElementById('errorlog-modal').classList.remove('open');
  }

  document.getElementById('errorlog-btn').onclick = openErrorLog;
  document.getElementById('errorlog-close').onclick = closeErrorLog;
  document.getElementById('errorlog-modal').addEventListener('click', e => {
    if (e.target.id === 'errorlog-modal') closeErrorLog();
  });
  document.getElementById('errorlog-text').addEventListener('click', e => {
    const a = e.target.closest('a[data-note]');
    if (!a) return;
    e.preventDefault();
    closeErrorLog();
    history.replaceState(null, '', '#note-' + a.dataset.note);
    showNote(a.dataset.note);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeErrorLog();
  });
  window._toggleCw = function(id) {
    if (cwExpanded.has(id)) cwExpanded.delete(id); else cwExpanded.add(id);
    const savedPage = page;
    computeFiltered();
    page = savedPage;
    renderPage(false);
  };

  function computeFiltered() {
    const q = (document.getElementById('search-input')?.value || '').toLowerCase();
    const vis = document.getElementById('vis-filter')?.value || '';
    const local = document.getElementById('local-filter')?.value || '';
    const media = document.getElementById('media-filter')?.value || '';
    const sort = document.getElementById('sort-filter')?.value || 'desc';

    let sourceNotes;
    if (activeTab === 'favorites') {
      sourceNotes = allFavorites.map(f => f.note);
    } else if (activeTab === 'clips') {
      sourceNotes = selectedClipIdx >= 0 ? (allClips[selectedClipIdx]?.clipNotes.map(cn => cn.note) ?? []) : [];
    } else {
      sourceNotes = allNotes;
    }

    filtered = sourceNotes.filter(n => {
      if (vis && n.visibility !== vis) return false;
      if (local === 'local' && !n.localOnly) return false;
      if (local === 'federated' && n.localOnly) return false;
      if (media === 'media' && n.files.length === 0) return false;
      if (media === 'text' && n.files.length > 0) return false;
      if (activeTab === 'notes' && calYear !== null) {
        const d = new Date(n.createdAt);
        if (d.getFullYear() !== calYear) return false;
        if (calMonth !== null && d.getMonth() + 1 !== calMonth) return false;
      }
      if (q) {
        if (q.startsWith('#')) {
          const tag = q.slice(1);
          if (!n.tags?.some(t => t.toLowerCase().includes(tag))) return false;
        } else {
          const text = ((n.text || '') + (n.cw || '')).toLowerCase();
          if (!text.includes(q)) return false;
        }
      }
      return true;
    });

    if (sort === 'asc') filtered = [...filtered].reverse();
    return sourceNotes;
  }

  function applyFilter() {
    const sourceNotes = computeFiltered();
    page = 0;
    document.getElementById('result-count').textContent =
      filtered.length < sourceNotes.length
        ? \`\${filtered.length.toLocaleString()} 件 / \${sourceNotes.length.toLocaleString()} 件\`
        : \`\${sourceNotes.length.toLocaleString()} 件\`;
    renderPage();
  }

  // ページネーション用のフッター要素を取得/生成
  function getPaginationEl() {
    let el = document.getElementById('pagination');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pagination';
      el.className = 'pagination';
      document.getElementById('notes-list').after(el);
    }
    return el;
  }

  function renderPage(scrollToTop = true) {
    const container = document.getElementById('notes-list');
    container.innerHTML = '';

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty">ノートが見つかりません</div>';
      applyRxSize();
      getPaginationEl().innerHTML = '';
      return;
    }

    if (settings.navMode === 'more') {
      // 「さらに読み込む」モード: page は読み込み済みページ数として使う
      const shown = filtered.slice(0, (page + 1) * settings.pgSize);
      const frag = document.createDocumentFragment();
      for (const note of shown) {
        const el = document.createElement('div');
        el.innerHTML = renderNote(note);
        frag.appendChild(el.firstElementChild);
      }
      container.appendChild(frag);
      applyRxSize();

      const pgEl = getPaginationEl();
      if (shown.length < filtered.length) {
        pgEl.innerHTML = \`<button class="pg-btn" style="width:100%;padding:10px" onclick="_loadMore()">さらに読み込む</button>\`;
      } else {
        pgEl.innerHTML = '';
      }
    } else {
      // ページネーションモード
      const totalPages = Math.max(1, Math.ceil(filtered.length / settings.pgSize));
      if (page >= totalPages) page = totalPages - 1;
      const slice = filtered.slice(page * settings.pgSize, (page + 1) * settings.pgSize);

      const frag = document.createDocumentFragment();
      for (const note of slice) {
        const el = document.createElement('div');
        el.innerHTML = renderNote(note);
        frag.appendChild(el.firstElementChild);
      }
      container.appendChild(frag);
      applyRxSize();
      renderPagination(totalPages);
      if (scrollToTop) window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  window._loadMore = function() {
    page++;
    renderPage();
  };

  function renderPagination(totalPages) {
    const el = getPaginationEl();
    if (totalPages <= 1) { el.innerHTML = ''; return; }

    const MAX_SHOWN = 7;
    let pages = [];
    if (totalPages <= MAX_SHOWN) {
      pages = Array.from({length: totalPages}, (_, i) => i);
    } else {
      pages = [0];
      const lo = Math.max(1, page - 2), hi = Math.min(totalPages - 2, page + 2);
      if (lo > 1) pages.push('…');
      for (let i = lo; i <= hi; i++) pages.push(i);
      if (hi < totalPages - 2) pages.push('…');
      pages.push(totalPages - 1);
    }

    let html = \`<button class="pg-btn" \${page === 0 ? 'disabled' : ''} onclick="_pgGo(\${page-1})">‹</button>\`;
    for (const p of pages) {
      if (p === '…') {
        html += '<span class="pg-info">…</span>';
      } else {
        html += \`<button class="pg-btn \${p === page ? 'active' : ''}" onclick="_pgGo(\${p})">\${p+1}</button>\`;
      }
    }
    html += \`<button class="pg-btn" \${page === totalPages - 1 ? 'disabled' : ''} onclick="_pgGo(\${page+1})">›</button>\`;
    html += \`<span class="pg-info">\${page+1} / \${totalPages}</span>\`;
    el.innerHTML = html;
  }

  window._pgGo = function(p) {
    page = p;
    history.pushState({ page: p }, '', '#p' + (p + 1));
    renderPage();
  };

  window.addEventListener('popstate', function(e) {
    if (e.state && typeof e.state.page === 'number') {
      page = e.state.page;
      renderPage();
    }
  });

  function renderNote(note) {
    const u = note.user;
    const date = new Date(note.createdAt);
    const dateStr = date.toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const visLabels = { public: '公開', home: 'ホーム', followers: 'フォロワー', specified: '指定' };
    const hasCw = !!note.cw;
    const isExpanded = cwExpanded.has(note.id);

    let content = '';

    if (note.renoteId && !note.text && !note.files.length) {
      content = note.renote ? \`<div class="renote-quote"><div class="rn-header">🔁 Renote</div>\${renderNoteBody(note.renote, true)}</div>\` : \`<div class="renote-quote"><div class="rn-header">🔁 Renote (not available)</div></div>\`;
    } else {
      if (hasCw) {
        content += \`<div class="cw-label" onclick="_toggleCw('\${note.id}')">\${renderEmoji(esc(note.cw), Object.assign({}, index.emojis, note.emojis, note.reactionEmojis))} \${isExpanded ? '▲ 折りたたむ' : '▼ 続きを見る'}</div>\`;
        if (isExpanded) content += \`<div class="cw-content">\${renderNoteBody(note, false)}</div>\`;
      } else {
        content = renderNoteBody(note, false);
      }
      if (note.renoteId && note.renote) {
        content += \`<div class="renote-quote"><div class="rn-header">🔁 引用</div>\${renderNoteBody(note.renote, true)}</div>\`;
      }
    }

    const reactions = Object.entries(note.reactions || {})
      .filter(([,v]) => v > 0)
      .map(([k, v]) => {
        const emojiKey = k.replace(/^:|:$/g, '');
        const localKey = emojiKey.replace(/@\.$/, '');
        const emojiUrl = note.reactionEmojis?.[emojiKey] || index.emojis?.[localKey] || index.emojis?.[emojiKey];
        const label = emojiUrl
          ? \`<img src="\${esc(emojiUrl)}" alt="\${esc(k)}" data-fb="\${esc(k)}" onerror="_emojiErr(this)" style="height:1.2em;vertical-align:middle" />\`
          : \`<span class="emoji-fb">\${esc(k)}</span>\`;
        const users = note.reactionUsers?.[k];
        const tooltip = users?.length
          ? \`<span class="reaction-tooltip">\${users.map(u => esc(u)).join(', ')}</span>\`
          : '';
        return \`<span class="reaction">\${label} \${v}\${tooltip}</span>\`;
      })
      .join('');

    const tags = (note.tags || []).map(t => \`<span class="tag" onclick="_tag('\${esc(t)}')">#\${esc(t)}</span>\`).join('');

    return \`<div class="note-card\${note.renoteId && !note.text ? ' is-renote' : ''}" id="note-\${esc(note.id)}">
      <div class="note-meta">
        \${u.avatarUrl ? \`<img class="note-avatar" src="\${esc(u.avatarUrl)}" onerror="this.style.display='none'" alt="" />\` : ''}
        <div class="note-user">
          <div class="display-name">\${esc(u.name || u.username)}</div>
          <div class="username">@\${esc(u.username)}\${u.host ? '@' + esc(u.host) : ''}</div>
        </div>
        \${(note.uri || note.url) ? \`<a href="\${esc(note.uri || note.url)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--text-muted);white-space:nowrap">↗ 元投稿</a>\` : ''}
        <span class="visibility-badge">\${visLabels[note.visibility] || note.visibility}\${note.localOnly ? '・ローカルのみ' : ''}</span>
        <span class="note-date">\${dateStr}</span>
      </div>
      \${content}
      \${reactions ? \`<div class="reactions">\${reactions}</div>\` : ''}
      \${tags ? \`<div class="note-tags">\${tags}</div>\` : ''}
      <div class="note-footer">
        \${note.replyCount > 0 ? \`<span>💬 \${note.replyCount}</span>\` : ''}
        \${note.renoteCount > 0 ? \`<span>🔁 \${note.renoteCount}</span>\` : ''}
      </div>
    </div>\`;
  }

  function renderNoteBody(note, compact) {
    let html = '';
    const allEmojis = Object.assign({}, index.emojis, note.emojis, note.reactionEmojis);
    if (note.text) html += \`<div class="note-text">\${renderEmoji(linkify(esc(note.text)), allEmojis)}</div>\`;
    if (note.files?.length) html += renderMedia(note.files, compact, note.id);
    if (note.poll) html += renderPoll(note.poll);
    return html;
  }

  function guessTypeFromName(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp','avif','svg'].includes(ext)) return 'image';
    if (['mp4','webm','mov','avi'].includes(ext)) return 'video';
    if (['mp3','ogg','wav','flac','aac'].includes(ext)) return 'audio';
    return 'other';
  }

  function renderMedia(files, compact, noteId) {
    const count = Math.min(files.length, compact ? 2 : 4);
    const shown = files.slice(0, count);
    const imgSrcs = files.filter(f => {
      const kind = f.type?.startsWith('image/') ? 'image' : guessTypeFromName(f.name);
      return kind === 'image';
    }).map(f => f.localPath || f.url);
    const imgSrcsJson = JSON.stringify(imgSrcs).replace(/"/g, '&quot;');
    let html = \`<div class="media-grid count-\${count}">\`;
    let imgIdx = 0;
    for (const f of shown) {
      const src = f.localPath || f.url;
      const kind = f.type?.startsWith('image/') ? 'image'
        : f.type?.startsWith('video/') ? 'video'
        : f.type?.startsWith('audio/') ? 'audio'
        : guessTypeFromName(f.name);
      if (kind === 'image') {
        const i = imgIdx++;
        html += \`<img src="\${esc(src)}" loading="lazy" alt="\${esc(f.name)}" data-imgs="\${imgSrcsJson}" data-idx="\${i}" onclick="_lightbox(JSON.parse(this.dataset.imgs),+this.dataset.idx)" onerror="_mediaErr(this,\${JSON.stringify(esc(f.name))})" />\`;
      } else if (kind === 'video') {
        html += \`<video src="\${esc(src)}" controls onerror="_mediaErrEl(this,\${JSON.stringify(esc(f.name))})"></video>\`;
      } else if (kind === 'audio') {
        html += \`<audio src="\${esc(src)}" controls onerror="_mediaErrEl(this,\${JSON.stringify(esc(f.name))})"></audio>\`;
      } else {
        html += \`<div class="media-file">📎 <a href="\${esc(src)}" target="_blank" rel="noopener">\${esc(f.name)}</a></div>\`;
      }
    }
    html += '</div>';
    return html;
  }

  function renderPoll(poll) {
    const total = poll.choices.reduce((s, c) => s + c.votes, 0);
    return '<div class="poll">' + poll.choices.map(c => {
      const pct = total > 0 ? Math.round(c.votes / total * 100) : 0;
      return \`<div class="poll-choice"><div class="poll-bar" style="width:\${pct}%"></div><div class="poll-choice-text"><span>\${esc(c.text)}</span><span>\${pct}% (\${c.votes})</span></div></div>\`;
    }).join('') + '</div>';
  }

  window._mediaErr = function(img, name) {
    const div = document.createElement('div');
    div.className = 'media-missing';
    div.innerHTML = '🖼️ <span>' + name + '（取得失敗）</span>';
    img.replaceWith(div);
  };
  window._mediaErrEl = function(el, name) {
    const div = document.createElement('div');
    div.className = 'media-missing';
    div.innerHTML = '📄 <span>' + name + '（取得失敗）</span>';
    el.replaceWith(div);
  };

  window._emojiErr = function(img) {
    const span = document.createElement('span');
    span.className = 'emoji-fb';
    span.textContent = img.dataset.fb || img.alt;
    img.replaceWith(span);
  };

  var _lbImgs = [], _lbIdx = 0;
  function _lbShow(idx) {
    _lbIdx = idx;
    document.getElementById('lightbox-img').src = _lbImgs[_lbIdx];
    document.getElementById('lb-counter').textContent = _lbImgs.length > 1 ? (_lbIdx + 1) + ' / ' + _lbImgs.length : '';
    document.getElementById('lb-prev').disabled = _lbIdx === 0;
    document.getElementById('lb-next').disabled = _lbIdx === _lbImgs.length - 1;
    document.getElementById('lb-prev').style.display = _lbImgs.length > 1 ? '' : 'none';
    document.getElementById('lb-next').style.display = _lbImgs.length > 1 ? '' : 'none';
  }
  function _lbClose() {
    document.getElementById('lightbox').classList.remove('open');
    // delay removing lb-open so the synthesized click after touch doesn't reach underlying elements
    setTimeout(() => document.body.classList.remove('lb-open'), 100);
  }
  window._lightbox = function(imgs, idx) {
    _lbImgs = Array.isArray(imgs) ? imgs : [imgs];
    _tsScale = 1; _tsCurScale = 1;
    document.getElementById('lightbox-img').style.transform = '';
    document.getElementById('lightbox').classList.add('open');
    document.body.classList.add('lb-open');
    _lbShow(idx || 0);
  };
  document.getElementById('lb-prev').addEventListener('click', function(e) {
    e.stopPropagation();
    if (_lbIdx > 0) _lbShow(_lbIdx - 1);
  });
  document.getElementById('lb-next').addEventListener('click', function(e) {
    e.stopPropagation();
    if (_lbIdx < _lbImgs.length - 1) _lbShow(_lbIdx + 1);
  });
  document.getElementById('lightbox').addEventListener('click', _lbClose);
  document.addEventListener('keydown', function(e) {
    if (!document.getElementById('lightbox').classList.contains('open')) return;
    if (e.key === 'Escape') _lbClose();
    if (e.key === 'ArrowLeft' && _lbIdx > 0) _lbShow(_lbIdx - 1);
    if (e.key === 'ArrowRight' && _lbIdx < _lbImgs.length - 1) _lbShow(_lbIdx + 1);
  });
  // タッチ操作: 左右スワイプで切り替え、タップで閉じる、ピンチで拡大縮小
  var _tsX = 0, _tsY = 0, _tsPinchDist = 0, _tsScale = 1, _tsCurScale = 1;
  var _lbImg = document.getElementById('lightbox-img');
  function _pinchDist(e) {
    var dx = e.touches[0].clientX - e.touches[1].clientX;
    var dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }
  document.getElementById('lightbox').addEventListener('touchstart', function(e) {
    if (e.touches.length === 2) {
      _tsPinchDist = _pinchDist(e);
    } else {
      _tsX = e.touches[0].clientX; _tsY = e.touches[0].clientY;
    }
  }, { passive: true });
  document.getElementById('lightbox').addEventListener('touchmove', function(e) {
    if (e.touches.length === 2) {
      var dist = _pinchDist(e);
      _tsCurScale = Math.max(0.5, Math.min(5, _tsScale * (dist / _tsPinchDist)));
      _lbImg.style.transform = 'scale(' + _tsCurScale + ')';
    }
  }, { passive: true });
  document.getElementById('lightbox').addEventListener('touchend', function(e) {
    if (e.touches.length === 0 && _tsPinchDist > 0) {
      _tsScale = _tsCurScale;
      _tsPinchDist = 0;
      return;
    }
    if (_tsPinchDist > 0) return;
    var dx = e.changedTouches[0].clientX - _tsX;
    var dy = e.changedTouches[0].clientY - _tsY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0 && _lbIdx > 0) { _tsScale = 1; _lbImg.style.transform = ''; _lbShow(_lbIdx - 1); }
      else if (dx < 0 && _lbIdx < _lbImgs.length - 1) { _tsScale = 1; _lbImg.style.transform = ''; _lbShow(_lbIdx + 1); }
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      // タップ: スケールが1に近ければ閉じる、拡大中ならリセット
      if (_tsScale > 1.05) { _tsScale = 1; _tsCurScale = 1; _lbImg.style.transform = ''; }
      else { _lbClose(); }
    }
  }, { passive: true });

  // モーダル背景クリックで閉じる
  document.getElementById('cal-modal').addEventListener('click', function(e) {
    if (e.target === this) {
      this.classList.remove('open');
      document.body.classList.remove('sidebar-open');
    }
  });

  // オーバーレイ表示中のバックグラウンドスクロール防止
  document.addEventListener('touchmove', function(e) {
    if (document.getElementById('lightbox').classList.contains('open')) {
      e.preventDefault(); return;
    }
    if (document.body.classList.contains('sidebar-open') && !document.getElementById('cal-modal-box').contains(e.target)) {
      e.preventDefault();
    }
  }, { passive: false });

  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function trimUrl(url) {
    // strip trailing punctuation; respect balanced parentheses
    let s = url;
    for (;;) {
      const c = s[s.length - 1];
      if (/[.,!?;:]/.test(c)) { s = s.slice(0, -1); continue; }
      if (c === ')') {
        const opens = (s.match(/\\(/g) || []).length;
        const closes = (s.match(/\\)/g) || []).length;
        if (closes > opens) { s = s.slice(0, -1); continue; }
      }
      break;
    }
    return s;
  }
  function linkify(text) {
    // Markdown link [label](url) — handle balanced parens in url
    text = text.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/\\S+?)\\)([^(]|$)/g, (_, label, url, after) => {
      const clean = trimUrl(url);
      return \`<a href="\${clean}" target="_blank" rel="noopener">\${label}</a>\${after}\`;
    });
    // bare URLs not already inside an href
    text = text.replace(/(?<!href=")(https?:\\/\\/[^\\s<>"）]+)/g, (url) => {
      const clean = trimUrl(url);
      return \`<a href="\${clean}" target="_blank" rel="noopener">\${clean}</a>\`;
    });
    // **bold** / __bold__
    text = text.replace(/\\*\\*(.+?)\\*\\*|__(.+?)__/g, (_, a, b) => \`<strong>\${a ?? b}</strong>\`);
    // *italic* / _italic_ (not inside words)
    text = text.replace(/(?<!\\w)\\*([^*\\n]+)\\*(?!\\w)|(?<!\\w)_([^_\\n]+)_(?!\\w)/g, (_, a, b) => \`<em>\${a ?? b}</em>\`);
    // ~~strikethrough~~
    text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
    // \`code\`
    text = text.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
    return text;
  }

  function renderEmoji(text, emojis) {
    if (!emojis) return text;
    return text.replace(/:([a-zA-Z0-9_@.-]+):/g, (match, name) => {
      const url = emojis[name] || emojis[name + '@.'] || emojis[name.replace(/@\.$/, '')];
      if (!url) return match;
      return \`<img src="\${esc(url)}" alt=":\${esc(name)}:" title=":\${esc(name)}:" data-fb=":\${esc(name)}:" onerror="_emojiErr(this)" style="height:1.5em;vertical-align:middle" />\`;
    });
  }

  loadArchiveParts().then(init, (e) => {
    document.getElementById('result-count').textContent = 'データの読み込みに失敗しました: ' + e.message;
  });
})();
</script>
</body>
</html>`;
}
