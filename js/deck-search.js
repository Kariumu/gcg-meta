/* GCG STATS — 入賞デッキ検索(deck-search.html)の画面。指示書174
 *
 * 手で書いたファイル(生成物ではない)。読むのは同じサイトの次のファイルだけ:
 *   data/deck-search/eras.json      … 全区切りの一覧(夜の処理で generate-events.js が作る)
 *   data/deck-search/<区切り>.json  … 区切りごとの入賞デッキ(順位は生成の時に変換済み。プレイヤー名は入っていない)
 *   data/deck-search/cards.json     … 型番 → 出たいちばん新しい区切り(URL に c だけがある時に、区切りのファイルを 1 本だけ読むため)
 *   data/card_names.json            … カード名
 * 「まだ使えない区切りを出さない」「既定の区切り」は、ここで日本時間の今日から決める(eras.json は日付に左右されない)。
 * 選んだカードが 1 枚以上入っていれば当たる(枚数の条件は持たない・裁定R1)。
 * デッキビルダーへは GCG.openDeckInBuilder に { source: 'deck_search', src: 'event' } を渡す(裁定R0 R-1: &src=event を付けて
 * 読み込みの確認を省く。どこから来たかはサイト側の builder_open の source で区別する)。
 */
(function () {
  'use strict';
  GCG.init();
  var BASE = GCG.getBasePath();
  var MAX_CARDS = 4;
  var PAGE = 20;

  var ERAS = null;          // eras.json の中身
  var NAMES = {};           // card_id → 名前
  var BASE_IDS = [];        // 候補に出す型番(パラレル _pN を除いた物)
  var files = {};           // 区切りのファイル名 → 中身(読んだ物を持っておく)
  var state = { cards: [], era: '', col: '', rk: '' };   // cards: [{ id }]
  var eraExplicit = false;  // 区切りを URL か利用者が決めたときだけ URL に e を書く(既定の区切りを URL に固定しない)
  var shown = PAGE;
  var lastHits = [];

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return GCG.escapeHtml(String(s == null ? '' : s)); };

  // ---------- 日付 ----------
  function todayJst() {
    if (typeof window.__DS_TODAY === 'string') return window.__DS_TODAY;   // 検証用の差し込み口
    return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function ymd(s) { var p = String(s).split('-'); return { y: +p[0], m: +p[1], d: +p[2] }; }
  function eraRangeText(e, i) {
    var all = ERAS.eras, today = todayJst();
    var a = ymd(e.start), t = a.y + '/' + a.m + '/' + a.d + '〜';
    var next = all[i + 1];
    if (e.end && next && next.start <= today) {
      var b = ymd(e.end);
      t += (b.y === a.y ? '' : b.y + '/') + b.m + '/' + b.d;
    }
    return t;
  }
  // 欄に出す区切り(古い順): もう使える物のうち、データの始まりより前に終わった物を除く
  function visibleEras() {
    var today = todayJst(), ds = ERAS.data_start || '';
    var out = [];
    ERAS.eras.forEach(function (e, i) {
      if (e.start > today) return;
      if (ds && e.end && e.end < ds) return;
      out.push({ e: e, i: i });
    });
    return out;
  }
  function eraByKey(key) {
    var v = visibleEras();
    for (var k = 0; k < v.length; k++) if (v[k].e.key === key) return v[k];
    return null;
  }
  function defaultEra() { var v = visibleEras(); return v.length ? v[v.length - 1] : null; }

  // ---------- 読み込み ----------
  function getJson(path) {
    return fetch(BASE + path).then(function (r) { if (!r.ok) throw new Error(path + ' ' + r.status); return r.json(); });
  }
  function loadEraFile(e) {
    if (!e.file) return Promise.resolve(null);
    if (files[e.file]) return Promise.resolve(files[e.file]);
    return getJson('data/deck-search/' + e.file).then(function (j) {
      // 引き当て用の表: 型番 → カードの番号
      j._ci = {};
      j.cards.forEach(function (c, k) { j._ci[c] = k; });
      files[e.file] = j;
      return j;
    });
  }

  // ---------- 探す ----------
  function baseId(id) { return String(id).replace(/_p\d+$/, ''); }
  function matchDecks(file, sel, col, rk) {
    if (!file) return [];
    var want = [];
    for (var s = 0; s < sel.length; s++) {
      var k = file._ci[sel[s].id];
      if (k === undefined) return [];
      want.push(k);
    }
    var ti = col ? file.types.indexOf(col) : -1;
    if (col && ti < 0) return [];
    var out = [];
    for (var d = 0; d < file.decks.length; d++) {
      var row = file.decks[d];
      if (rk && row[1] > rk) continue;
      if (col && row[3] !== ti) continue;
      var ok = true;
      for (var w = 0; w < want.length && ok; w++) {
        var found = false;
        for (var p = 4; p < row.length; p += 2) if (row[p] === want[w]) { found = row[p + 1] > 0; break; }
        if (!found) ok = false;
      }
      if (ok) out.push(row);
    }
    return out;
  }

  // ---------- URL ----------
  function readUrl() {
    var q = new URLSearchParams(location.search);
    var cards = [], seen = {};
    String(q.get('c') || '').split(',').forEach(function (tok) {
      if (cards.length >= MAX_CARDS) return;
      // 小文字も読む。パラレル(_pN)は元の番号に直す。後ろに :3 などが付いていたら、その部分は無視する(裁定R1)
      var m = /^([A-Z0-9]+-[A-Z0-9]+)(?:_P\d+)?(?::.*)?$/.exec(tok.trim().toUpperCase());
      if (!m) return;
      var id = m[1];
      if (seen[id] || !(id in NAMES)) return;
      seen[id] = true;
      cards.push({ id: id });
    });
    var col = String(q.get('col') || '');
    col = /^[A-Za-z]+(-[A-Za-z]+)?$/.test(col) ? GCG.normalizeTypeKey(col.replace('-', '+')) : '';
    var rk = q.get('rk');
    return { cards: cards, era: String(q.get('e') || ''), col: col, rk: rk === '1' || rk === '4' ? +rk : '' };
  }
  function writeUrl() {
    var q = new URLSearchParams();
    if (state.cards.length) q.set('c', state.cards.map(function (c) { return c.id; }).join(','));
    if (state.era && eraExplicit) q.set('e', state.era);
    if (state.col) q.set('col', state.col.replace('+', '-'));
    if (state.rk) q.set('rk', String(state.rk));
    var s = q.toString().replace(/%2C/g, ',');
    try { history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash); } catch (e) { /* 書けなくても検索は動く */ }
  }

  // ---------- 画面: 条件 ----------
  function renderEraSelect() {
    var sel = $('ds-era');
    sel.innerHTML = visibleEras().slice().reverse().map(function (v) {
      return '<option value="' + esc(v.e.key) + '"' + (v.e.key === state.era ? ' selected' : '') + '>'
        + esc(v.e.label + '（' + eraRangeText(v.e, v.i) + '）') + '</option>';
    }).join('');
  }
  function typeLabel(key) {
    return String(key).split('+').map(function (c) { return (GCG.DECK_COLORS[c] || GCG.DECK_COLORS.Unknown).jp; }).join('/');
  }
  function renderColSelect(file) {
    var counts = {};
    if (file) file.decks.forEach(function (r) { counts[r[3]] = (counts[r[3]] || 0) + 1; });
    var list = file ? file.types.map(function (t, k) { return { t: t, n: counts[k] || 0 }; })
      .sort(function (a, b) { return b.n - a.n || (a.t < b.t ? -1 : 1); }) : [];
    if (state.col && !list.some(function (x) { return x.t === state.col; })) state.col = '';
    $('ds-col').innerHTML = '<option value="">すべて</option>' + list.map(function (x) {
      return '<option value="' + esc(x.t) + '"' + (x.t === state.col ? ' selected' : '') + '>'
        + esc(typeLabel(x.t) + '（' + x.n.toLocaleString() + '）') + '</option>';
    }).join('');
    $('ds-rk').value = state.rk ? String(state.rk) : '';
  }
  function renderChips() {
    $('ds-chips').innerHTML = state.cards.map(function (c, k) {
      var nm = NAMES[c.id] || '';
      return '<span class="ds-chip" title="' + esc(c.id + ' ' + nm) + '"><span class="ds-id">' + esc(c.id) + '</span><span class="ds-nm">' + esc(nm) + '</span>'
        + '<button type="button" data-rm="' + k + '" aria-label="' + esc(c.id) + ' を外す">×</button></span>';
    }).join('');
    var full = state.cards.length >= MAX_CARDS;
    $('ds-q').disabled = full;
    $('ds-q').placeholder = full ? 'カードは 4 枚まで選べます' : '例: ガンダム / GD06-001';
  }

  // ---------- 画面: 候補 ----------
  var sugg = [], suggAt = -1;
  function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ''); }
  function currentFile() { var v = eraByKey(state.era); return v && v.e.file ? files[v.e.file] : null; }
  function usage(file) {
    if (!file._use) {
      file._use = [];
      for (var i = 0; i < file.cards.length; i++) file._use.push(0);
      file.decks.forEach(function (r) { for (var p = 4; p < r.length; p += 2) file._use[r[p]]++; });
    }
    return file._use;
  }
  function updateSugg() {
    var q = norm($('ds-q').value);
    var box = $('ds-sugg');
    if (!q) { box.hidden = true; $('ds-q').setAttribute('aria-expanded', 'false'); sugg = []; return; }
    var file = currentFile(), chosen = {};
    state.cards.forEach(function (c) { chosen[c.id] = true; });
    var hits = [];
    for (var i = 0; i < BASE_IDS.length; i++) {
      var id = BASE_IDS[i];
      if (chosen[id]) continue;
      var nid = norm(id), nnm = norm(NAMES[id]);
      var at = nid.indexOf(q) === 0 ? 0 : nnm.indexOf(q) >= 0 ? 1 : nid.indexOf(q) >= 0 ? 2 : -1;
      if (at < 0) continue;
      var k = file ? file._ci[id] : undefined;
      hits.push({ id: id, hot: k !== undefined ? 0 : 1, use: k !== undefined ? usage(file)[k] : 0, at: at });
    }
    // 今の区切りの入賞デッキに出たカードを先に(その中は採用デッキ数の多い順)、次に型番の頭が合う物
    hits.sort(function (a, b) { return a.hot - b.hot || b.use - a.use || a.at - b.at || (a.id < b.id ? -1 : 1); });
    sugg = hits.slice(0, 30);
    suggAt = sugg.length ? 0 : -1;
    box.innerHTML = sugg.length ? sugg.map(function (h, k) {
      return '<li role="option" id="ds-o' + k + '" data-k="' + k + '" aria-selected="' + (k === suggAt) + '" title="' + esc(h.id + ' ' + (NAMES[h.id] || '')) + '"><span class="ds-id">' + esc(h.id)
        + '</span><span class="ds-nm">' + esc(NAMES[h.id] || '') + '</span>' + (h.hot ? '<span class="ds-cold">この期間の採用なし</span>' : '') + '</li>';
    }).join('') : '<li aria-disabled="true" style="cursor:default;color:var(--text-muted)">見つかりません</li>';
    box.hidden = false;
    $('ds-q').setAttribute('aria-expanded', 'true');
  }
  function moveSugg(d) {
    if (!sugg.length) return;
    suggAt = (suggAt + d + sugg.length) % sugg.length;
    Array.prototype.forEach.call($('ds-sugg').children, function (li, k) { li.setAttribute('aria-selected', String(k === suggAt)); });
    var li = $('ds-o' + suggAt); if (li && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
  }
  function pick(k) {
    var h = sugg[k];
    if (!h || state.cards.length >= MAX_CARDS) return;
    state.cards.push({ id: h.id });
    $('ds-q').value = '';
    updateSugg();
    renderChips();
    search(true, true);
    if (!$('ds-q').disabled) $('ds-q').focus();
  }

  // ---------- 画面: 結果 ----------
  function rankTag(r) { return '<span class="ds-rank' + (r === 1 ? ' r1' : r === 2 ? ' r2' : '') + '">' + esc(GCG.rankText(r)) + '</span>'; }
  function itemHtml(file, row, n) {
    var ev = file.events[row[0]];
    var type = file.types[row[3]] || 'Unknown';
    var uses = state.cards.map(function (c) {
      var k = file._ci[c.id], cnt = 0;
      for (var p = 4; p < row.length; p += 2) if (row[p] === k) { cnt = row[p + 1]; break; }
      return esc(c.id) + ' ×' + cnt;
    }).join(' / ');
    var sel = {}; state.cards.forEach(function (c) { sel[c.id] = true; });
    var lis = [];
    for (var p = 4; p < row.length; p += 2) {
      var id = file.cards[row[p]];
      lis.push('<li' + (sel[id] ? ' class="ds-hit"' : '') + ' title="' + esc(id + ' ' + (NAMES[id] || '')) + '"><span class="ds-id">' + esc(id) + '</span><span class="ds-nm">' + esc(NAMES[id] || '') + '</span><span class="ds-ct">×' + row[p + 1] + '</span></li>');
    }
    var total = 0; for (var q = 5; q < row.length; q += 2) total += row[q];
    return '<article class="ds-item" data-ev="' + esc(ev[0]) + '" data-rank="' + row[1] + '" data-raw="' + row[2] + '">'
      + '<div class="ds-head"><span class="ds-date">' + esc(GCG.formatDate(ev[1])) + '</span>' + rankTag(row[1])
      + '<span class="ds-store">' + esc(ev[2]) + '</span>' + (ev[3] ? '<span class="ds-region">' + esc(ev[3]) + '</span>' : '')
      + '<span>' + GCG.renderColorTags(type.split('+')) + '</span></div>'
      + '<div class="ds-uses">' + uses + '</div>'
      + '<div class="ds-acts"><button type="button" class="btn-copy" data-open="' + n + '">\u{1F6E0}️ デッキビルダーで開く</button>'
      + '<a class="btn-link" href="events/' + encodeURIComponent(ev[0]) + '.html">大会のページへ</a></div>'
      + '<details class="ds-deck"><summary>デッキの中身（' + total + '枚・' + ((row.length - 4) / 2) + '種類）</summary><ul>' + lis.join('') + '</ul></details>'
      + '</article>';
  }
  function popularHtml(file) {
    if (!file) return '';
    var n = usage(file);
    var top = n.map(function (_, k) { return k; }).sort(function (a, b) { return n[b] - n[a] || a - b; }).slice(0, 8);
    return '<p style="margin:14px 0 6px;font-size:12px">この期間によく入っているカード（押すと選べます）</p><div class="ds-chips" style="justify-content:center">'
      + top.map(function (k) {
        var id = file.cards[k];
        return '<button type="button" class="ds-chip" data-add="' + esc(id) + '" title="' + esc(id + ' ' + (NAMES[id] || '')) + '" style="cursor:pointer;color:inherit"><span class="ds-id">' + esc(id) + '</span><span class="ds-nm">' + esc(NAMES[id] || '') + '</span></button>';
      }).join('') + '</div>';
  }
  function render(file, eraV) {
    var box = $('ds-result');
    var e = eraV && eraV.e;
    if (!e) { box.innerHTML = '<div class="ds-msg">表示できる期間がありません。</div>'; return; }
    if (!e.decks) {
      var v = visibleEras(), prev = null;
      for (var k = v.length - 1; k >= 0; k--) if (v[k].e.key !== e.key && v[k].e.start < e.start && v[k].e.decks) { prev = v[k].e; break; }
      var isLatest = defaultEra() && defaultEra().e.key === e.key;
      box.innerHTML = '<div class="ds-msg">この期間（' + esc(e.label) + '）の入賞デッキはありません。'
        + (isLatest ? '<br>新しい商品が使えるようになったばかりで、まだ大会の結果が入っていない可能性があります。' : '')
        + (prev ? '<br><button type="button" class="btn-copy" data-era="' + esc(prev.key) + '">1 つ前の区切り（' + esc(prev.label) + '）を見る</button>' : '') + '</div>';
      lastHits = [];
      return;
    }
    if (!state.cards.length) {
      box.innerHTML = '<div class="ds-msg">カードを 1 枚以上選ぶと、そのカードを全部入れている入賞デッキが出ます。<br><span style="font-size:12px">この期間の入賞デッキ ' + e.decks.toLocaleString() + ' 件・大会 ' + e.events.toLocaleString() + ' 件</span>' + popularHtml(file) + '</div>';
      lastHits = [];
      return;
    }
    var hits = matchDecks(file, state.cards, state.col, state.rk);
    lastHits = hits;
    var evs = {}; hits.forEach(function (r) { evs[r[0]] = 1; });
    var m = Object.keys(evs).length;
    var head = '<p class="ds-summary"><b>' + hits.length.toLocaleString() + '</b> デッキ（大会 <b>' + m.toLocaleString() + '</b> 件）・' + esc(e.label) + '</p>';
    if (!hits.length) {
      box.innerHTML = head + '<div class="ds-msg">条件に合う入賞デッキはありません。期間を変えるか、カードを減らしてください。</div>';
      return;
    }
    var list = hits.slice(0, shown).map(function (r, n) { return itemHtml(file, r, n); }).join('');
    box.innerHTML = head + '<div class="ds-list">' + list + '</div>'
      + (hits.length > shown ? '<button type="button" class="btn-copy ds-more" id="ds-more">もっと見る（残り ' + (hits.length - shown).toLocaleString() + ' 件）</button>' : '');
  }

  // 条件を決めて結果を出す。user=true のときだけ計測を送る(入力中の 1 文字ごとには送らない)
  // interact=true は利用者が条件を変えた時。その時点の区切りを URL に書く(開き直すと同じ結果になるように・二次確認 M-1)
  function search(user, interact) {
    shown = PAGE;
    if (interact) eraExplicit = true;
    var eraV = eraByKey(state.era);
    return loadEraFile(eraV ? eraV.e : {}).then(function (file) {
      renderColSelect(file);
      render(file, eraV);
      writeUrl();
      if (user && state.cards.length) {
        var tp = {
          card_count: state.cards.length, era: state.era, color: state.col ? state.col.replace('+', '-') : 'all',
          rank_filter: state.rk === 1 ? 'win' : state.rk === 4 ? 'top4' : 'all', result_count: lastHits.length,
          card_ids: state.cards.map(function (c) { return c.id; }).join(',')
        };
        GCG.track('deck_search', tp);
      }
    }).catch(function (err) {
      $('ds-result').innerHTML = '<div class="ds-msg">データを読み込めませんでした。時間をおいて開き直してください。</div>';
      if (window.console) console.warn('[deck-search]', err && err.message);
    });
  }

  // c だけが指定されて e が無いとき(e が読めないときも): 選んだカードを全部入れたデッキがある、いちばん新しい区切り。
  // cards.json(型番 → 出たいちばん新しい区切り)で、選んだカードの「いちばん新しい区切り」のうち最も古い物から探し始める
  // (それより新しい区切りには、全部のカードがそろったデッキは無いため)。cards.json を読めなければ、新しい区切りから順に探す
  function eraForCards() {
    return getJson('data/deck-search/cards.json').then(function (j) {
      var latest = (j && j.latest_era) || {}, startAt = null;
      for (var i = 0; i < state.cards.length; i++) {
        var key = latest[state.cards[i].id];
        if (!key) return null;   // どの入賞デッキにも出ていないカードがある → 当たる区切りは無い
        var v = eraByKey(key);
        if (!v) return null;
        if (startAt === null || v.i < startAt) startAt = v.i;
      }
      return scanEras(startAt);
    }, function () { return scanEras(null); });
  }
  function scanEras(startAt) {
    var v = visibleEras().filter(function (x) { return x.e.decks && (startAt === null || x.i <= startAt); }).reverse();
    var k = 0;
    function next() {
      if (k >= v.length) return Promise.resolve(null);
      var x = v[k++];
      return loadEraFile(x.e).then(function (f) { return matchDecks(f, state.cards, '', '').length ? x.e.key : next(); });
    }
    return next();
  }

  // ---------- 動き ----------
  function bind() {
    var q = $('ds-q');
    q.addEventListener('input', updateSugg);
    q.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); moveSugg(1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveSugg(-1); }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (suggAt >= 0) pick(suggAt); }
      else if (ev.key === 'Escape') { $('ds-sugg').hidden = true; q.setAttribute('aria-expanded', 'false'); }
    });
    q.addEventListener('blur', function () { setTimeout(function () { $('ds-sugg').hidden = true; q.setAttribute('aria-expanded', 'false'); }, 150); });
    q.addEventListener('focus', updateSugg);
    $('ds-sugg').addEventListener('mousedown', function (ev) {
      var li = ev.target.closest && ev.target.closest('li[data-k]');
      if (li) { ev.preventDefault(); pick(+li.getAttribute('data-k')); }
    });
    $('ds-chips').addEventListener('click', function (ev) {
      var b = ev.target.closest && ev.target.closest('button[data-rm]');
      if (!b) return;
      state.cards.splice(+b.getAttribute('data-rm'), 1);
      renderChips(); search(true, true);
    });
    $('ds-era').addEventListener('change', function () { state.era = this.value; eraExplicit = true; search(true, true); });
    $('ds-col').addEventListener('change', function () { state.col = this.value; search(true, true); });
    $('ds-rk').addEventListener('change', function () { state.rk = this.value ? +this.value : ''; search(true, true); });
    $('ds-result').addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'ds-more') {
        var eraV = eraByKey(state.era), file = eraV && files[eraV.e.file];
        var from = shown; shown += PAGE;
        var html = lastHits.slice(from, shown).map(function (r, n) { return itemHtml(file, r, from + n); }).join('');
        $('ds-result').querySelector('.ds-list').insertAdjacentHTML('beforeend', html);
        if (lastHits.length > shown) t.textContent = 'もっと見る（残り ' + (lastHits.length - shown).toLocaleString() + ' 件）'; else t.remove();
        return;
      }
      if (t.hasAttribute('data-era')) { state.era = t.getAttribute('data-era'); eraExplicit = true; renderEraSelect(); search(true, true); return; }
      if (t.hasAttribute('data-add')) {
        if (state.cards.length < MAX_CARDS) { state.cards.push({ id: t.getAttribute('data-add') }); renderChips(); search(true, true); }
        return;
      }
      if (t.hasAttribute('data-open')) {
        var eraV2 = eraByKey(state.era), f2 = eraV2 && files[eraV2.e.file];
        var row = lastHits[+t.getAttribute('data-open')];
        if (!row || !f2) return;
        var deck = [];
        for (var p = 4; p < row.length; p += 2) deck.push({ card_id: f2.cards[row[p]], count: row[p + 1] });
        GCG.openDeckInBuilder(deck, t, GCG.rankText(row[1]) + ' ' + f2.events[row[0]][2],
          { rank: row[1], source: 'deck_search', src: 'event' });
      }
    });
  }

  function start() {
    $('header').innerHTML = GCG.renderHeader('deck-search');
    $('footer').innerHTML = GCG.renderFooter();
    Promise.all([getJson('data/deck-search/eras.json'), getJson('data/card_names.json')]).then(function (r) {
      ERAS = r[0]; NAMES = r[1] || {};
      BASE_IDS = Object.keys(NAMES).filter(function (id) { return !/_p\d+$/.test(id); }).sort();
      var u = readUrl();
      state.cards = u.cards; state.col = u.col; state.rk = u.rk;
      var v = eraByKey(u.era);
      eraExplicit = !!v;
      var pickEra = v ? Promise.resolve(v.e.key)
        : (u.cards.length ? eraForCards() : Promise.resolve(null));
      return pickEra.then(function (key) {
        var d = defaultEra();
        state.era = key || (d ? d.e.key : '');
        renderEraSelect(); renderChips(); bind();
        return search(!!u.cards.length, false);
      });
    }).catch(function (err) {
      $('ds-result').innerHTML = '<div class="ds-msg">データを読み込めませんでした。時間をおいて開き直してください。</div>';
      if (window.console) console.warn('[deck-search]', err && err.message);
    });
  }
  start();
})();
