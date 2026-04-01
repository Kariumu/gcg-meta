/**
 * GCG STATS - 共通モジュール
 */

const GCG = {
  // データキャッシュ
  _eventsData: null,
  _summaryData: null,

  // データパス
  DATA_PATH: './data/',

  // デッキカラーマッピング
  DECK_COLORS: {
    Blue: { hex: '#4488ff', jp: '青', cssClass: 'c-blue' },
    Red: { hex: '#ff4444', jp: '赤', cssClass: 'c-red' },
    Green: { hex: '#44cc64', jp: '緑', cssClass: 'c-green' },
    White: { hex: '#cccccc', jp: '白', cssClass: 'c-white' },
    Purple: { hex: '#b444ff', jp: '紫', cssClass: 'c-purple' },
    Unknown: { hex: '#888888', jp: '不明', cssClass: '' }
  },

  // カード画像URL（ローカル保存済み画像を優先、なければ公式サーバー）
  cardImageUrl(cardId) {
    return `${this.getBasePath()}images/cards/${cardId}.webp`;
  },

  // 公式カード詳細URL
  cardSearchUrl(cardId) {
    return `https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${cardId}`;
  },

  // データ読み込み
  async loadEvents() {
    if (this._eventsData) return this._eventsData;
    try {
      const res = await fetch(this.DATA_PATH + 'events.json');
      this._eventsData = await res.json();
      return this._eventsData;
    } catch (e) {
      console.error('events.json の読み込みに失敗:', e);
      return { series: {}, events: {} };
    }
  },

  async loadSummary() {
    if (this._summaryData) return this._summaryData;
    try {
      const res = await fetch(this.DATA_PATH + 'summary.json');
      this._summaryData = await res.json();
      return this._summaryData;
    } catch (e) {
      console.error('summary.json の読み込みに失敗:', e);
      return { total_events: 0, total_decks: 0, card_ranking: [], deck_type_ranking: [] };
    }
  },

  // ページのベースパスを自動検出
  getBasePath() {
    const path = window.location.pathname;
    if (path.includes('/reports/news/')) {
      return '../../';
    }
    if (path.includes('/reports/') || path.includes('/events/') || path.includes('/meta/') || path.includes('/cards/')) {
      return '../';
    }
    return './';
  },

  // 初期化時にパスを設定
  init() {
    this.DATA_PATH = this.getBasePath() + 'data/';
  },

  // 順位テキスト
  rankText(rank) {
    if (rank === 1) return '優勝';
    if (rank === 2) return '準優勝';
    return `${rank}位`;
  },

  // 順位CSSクラス
  rankClass(rank) {
    if (rank <= 3) return `rank-${rank}`;
    return '';
  },

  // 日付フォーマット
  formatDate(dateStr) {
    if (!dateStr) return '';
    return dateStr.replace(/-/g, '.');
  },

  // 色配列からカラータグHTMLを生成
  renderColorTags(colors) {
    return colors.map(c => {
      const info = this.DECK_COLORS[c] || this.DECK_COLORS.Unknown;
      return `<span class="color-tag color-tag-${c.toLowerCase()}">${info.jp}</span>`;
    }).join(' ');
  },

  // 色配列からドットHTMLを生成
  renderColorDots(colors) {
    return colors.map(c => {
      const info = this.DECK_COLORS[c] || this.DECK_COLORS.Unknown;
      return `<span class="color-dot ${info.cssClass}" title="${info.jp}"></span>`;
    }).join('');
  },

  // 色配列からprimary colorのhexを返す
  primaryColorHex(colors) {
    if (!colors || colors.length === 0) return '#888';
    return (this.DECK_COLORS[colors[0]] || this.DECK_COLORS.Unknown).hex;
  },

  // デッキタイプラベル
  deckTypeLabel(colors) {
    return colors.map(c => (this.DECK_COLORS[c] || this.DECK_COLORS.Unknown).jp).join('/');
  },

  // デッキリストをテキストに変換（コピー用）
  deckToText(deck) {
    return deck.map(c => `${c.card_id} x${c.count}`).join('\n');
  },

  // クリップボードにコピー
  async copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '✓ コピー済み';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('copied');
        }, 2000);
      }
    } catch (e) {
      console.error('コピーに失敗:', e);
    }
  },

  // URLパラメータ取得
  getParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  },

  // イベント一覧を日付降順でソート
  sortedEvents(eventsObj) {
    return Object.values(eventsObj)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  },

  // HTMLエスケープ
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // 数値アニメーション
  animateNumber(el, target, duration = 600) {
    const start = parseInt(el.textContent) || 0;
    const diff = target - start;
    if (diff === 0) { el.textContent = target.toLocaleString(); return; }
    const startTime = performance.now();
    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      el.textContent = Math.round(start + diff * eased).toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  },

  // 共通ヘッダーHTML生成
  renderHeader(activePage) {
    const basePath = this.getBasePath();
    return `
      <header class="site-header">
        <div class="header-inner">
          <a href="${basePath}" class="site-logo">
            <span class="logo-icon">G</span>
            <div>
              <span class="logo-text">GCG STATS</span>
              <span class="logo-sub">Tournament Analytics</span>
            </div>
          </a>
          <nav>
            <a href="${basePath}" class="${activePage === 'home' ? 'active' : ''}">ダッシュボード</a>
            <a href="${basePath}events.html" class="${activePage === 'events' ? 'active' : ''}">イベント</a>
            <a href="${basePath}meta.html" class="${activePage === 'meta' ? 'active' : ''}">環境分析</a>
            <a href="${basePath}cards.html" class="${activePage === 'cards' ? 'active' : ''}">カードリスト</a>
            <a href="${basePath}reports/" class="${activePage === 'reports' ? 'active' : ''}">レポート</a>
          </nav>
        </div>
      </header>`;
  },

  // 共通フッターHTML生成
  renderFooter() {
    const basePath = this.getBasePath();
    return `
      <footer class="site-footer">
        <div class="footer-disclaimer">
          本サイトはガンダムカードゲームの非公式ファンサイトです。<br>
          バンダイ・サンライズの認可・許諾は得ていません。<br>
          掲載情報は公式大会結果を基に自動集計しています。<br>
          ©SOTSU・SUNRISE ©BANDAI
        </div>
        <div class="footer-links" style="margin-top:16px;display:flex;justify-content:center;gap:20px;font-size:11px;font-family:var(--font-mono)">
          <a href="${basePath}privacy.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">プライバシーポリシー</a>
          <a href="${basePath}contact.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">お問い合わせ</a>
          <a href="${basePath}about.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">サイトについて</a>
        </div>
      </footer>`;
  },

  // シェアボタンを指定コンテナに描画
  renderShareButtons: function(containerId, title) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var url = window.location.href.split('#')[0];
    var tweetText = encodeURIComponent(title + '\n' + url + '\n#GCG #ガンダムカードゲーム');
    var tweetUrl = 'https://twitter.com/intent/tweet?text=' + tweetText;
    el.innerHTML =
      '<div class="share-section">' +
        '<span class="share-label">SHARE</span>' +
        '<a class="share-btn share-x" href="' + tweetUrl + '" target="_blank" rel="noopener">' +
          '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.742l7.731-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' +
          'X\u3067\u30b7\u30a7\u30a2' +
        '</a>' +
        '<button class="share-btn share-copy" onclick="GCG.copyShareUrl(this)">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
          '<span class="copy-label">URL\u3092\u30b3\u30d4\u30fc</span>' +
        '</button>' +
      '</div>';
  },

  // 日付フィルター: 半月単位のデフォルト範囲を計算
  // ルール: 半月期間の最初の1週間以内 → 前の半月を表示
  getDefaultDateRange() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth(); // 0-indexed
    const d = today.getDate();

    let startDate, endDate;

    if (d <= 7) {
      // 月前半の最初の1週間 → 前月16日〜前月末
      const prevMonth = m === 0 ? 11 : m - 1;
      const prevYear = m === 0 ? y - 1 : y;
      startDate = new Date(prevYear, prevMonth, 16);
      endDate = new Date(prevYear, prevMonth + 1, 0); // 前月末日
    } else if (d <= 15) {
      // 月前半の後半(8〜15日) → 当月1日〜15日
      startDate = new Date(y, m, 1);
      endDate = new Date(y, m, 15);
    } else if (d <= 22) {
      // 月後半の最初の1週間(16〜22日) → 当月1日〜15日
      startDate = new Date(y, m, 1);
      endDate = new Date(y, m, 15);
    } else {
      // 月後半の後半(23日〜) → 当月16日〜当月末
      startDate = new Date(y, m, 16);
      endDate = new Date(y, m + 1, 0); // 当月末日
    }

    const fmt = (dt) => {
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    };

    return { start: fmt(startDate), end: fmt(endDate) };
  },

  // 日付フィルターUIを生成して返す
  renderDateFilterHTML(startVal, endVal) {
    return `
      <div class="date-filter-container">
        <span class="date-filter-label">期間:</span>
        <input type="date" class="date-filter-input" id="date-start" value="${startVal}">
        <span class="date-filter-sep">〜</span>
        <input type="date" class="date-filter-input" id="date-end" value="${endVal}">
        <button class="date-filter-reset" id="date-reset-btn" title="フィルター解除">全期間</button>
      </div>`;
  },

  // イベント配列を日付範囲でフィルター
  filterEventsByDate(events, startDate, endDate) {
    if (!startDate && !endDate) return events;
    return events.filter(ev => {
      if (!ev.date) return false;
      if (startDate && ev.date < startDate) return false;
      if (endDate && ev.date > endDate) return false;
      return true;
    });
  },

  // イベントオブジェクト(events.json形式)を日付範囲でフィルター
  filterEventsObjByDate(eventsObj, startDate, endDate) {
    if (!startDate && !endDate) return eventsObj;
    const filtered = {};
    for (const [key, ev] of Object.entries(eventsObj)) {
      if (!ev.date) continue;
      if (startDate && ev.date < startDate) continue;
      if (endDate && ev.date > endDate) continue;
      filtered[key] = ev;
    }
    return filtered;
  },

  copyShareUrl: function(btn) {
    var url = window.location.href.split('#')[0];
    var label = btn.querySelector('.copy-label');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function() {
        btn.classList.add('copied');
        label.textContent = '\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f';
        setTimeout(function() { btn.classList.remove('copied'); label.textContent = 'URL\u3092\u30b3\u30d4\u30fc'; }, 2000);
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      btn.classList.add('copied');
      label.textContent = '\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f';
      setTimeout(function() { btn.classList.remove('copied'); label.textContent = 'URL\u3092\u30b3\u30d4\u30fc'; }, 2000);
    }
  }
};

// Lightbox（画像拡大表示）- グローバル関数
function openLightbox(src) {
  var lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;cursor:zoom-out;justify-content:center;align-items:center';
    lb.onclick = closeLightbox;
    lb.innerHTML = '<img id="lightbox-img" src="" alt="" style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);object-fit:contain">' +
      '<button onclick="closeLightbox()" style="position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:32px;cursor:pointer;opacity:0.7;line-height:1">&times;</button>';
    document.body.appendChild(lb);
  }
  document.getElementById('lightbox-img').src = src;
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  var lb = document.getElementById('lightbox');
  if (lb) {
    lb.style.display = 'none';
    document.body.style.overflow = '';
  }
}

// Escapeキーで閉じる
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeLightbox();
});
