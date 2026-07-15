/**
 * GCG STATS お気に入り機能（店舗 / イベント）
 * 2026-07-16 指示書39（松岡さん指示）で追加
 *
 * - ログイン・アカウントは持たない。保存はブラウザの localStorage のみ（サーバへの送信なし）
 * - localStorage が使えない環境（プライベートブラウズ等）でもページを壊さない
 * - 公開API: window.GCGFav
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'gcg_favorites';
  var SCHEMA_VERSION = 1;
  var _available = null;

  // --- localStorage 使用可否（例外を投げる環境があるため実書き込みで判定） ---
  function available() {
    if (_available !== null) return _available;
    try {
      var probe = '__gcg_fav_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      _available = true;
    } catch (e) {
      _available = false;
    }
    return _available;
  }

  function emptyData() {
    return { version: SCHEMA_VERSION, stores: [], events: [] };
  }

  function uniq(arr) {
    var seen = {};
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) { seen[k] = 1; out.push(arr[i]); }
    }
    return out;
  }

  // --- 読み込み（壊れた値・旧バージョンは空扱いにフォールバック） ---
  function read() {
    if (!available()) return emptyData();
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyData();
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return emptyData();
      if (data.version !== SCHEMA_VERSION) return emptyData();
      var stores = Array.isArray(data.stores)
        ? data.stores.map(function (v) { return String(v); }).filter(function (v) { return v !== ''; })
        : [];
      var events = Array.isArray(data.events)
        ? data.events.map(function (v) { return Number(v); }).filter(function (v) { return isFinite(v); })
        : [];
      return { version: SCHEMA_VERSION, stores: uniq(stores), events: uniq(events) };
    } catch (e) {
      return emptyData();
    }
  }

  function write(data) {
    if (!available()) return false;
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: SCHEMA_VERSION,
        stores: data.stores,
        events: data.events
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function getStores() { return read().stores.slice(); }
  function getEvents() { return read().events.slice(); }

  function isStoreFav(id) {
    return read().stores.indexOf(String(id)) !== -1;
  }
  function isEventFav(id) {
    return read().events.indexOf(Number(id)) !== -1;
  }

  function toggleStore(id) {
    var key = String(id);
    var data = read();
    var i = data.stores.indexOf(key);
    if (i === -1) { data.stores.push(key); } else { data.stores.splice(i, 1); }
    write(data);
    return data.stores.indexOf(key) !== -1;
  }

  function toggleEvent(id) {
    var key = Number(id);
    var data = read();
    var i = data.events.indexOf(key);
    if (i === -1) { data.events.push(key); } else { data.events.splice(i, 1); }
    write(data);
    return data.events.indexOf(key) !== -1;
  }

  // --- ☆ボタン ---
  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function labelFor(on) {
    if (!available()) return 'この環境ではお気に入りを保存できません';
    return on ? 'お気に入りを解除' : 'お気に入りに追加';
  }

  function starButtonHtml(kind, id, extraClass) {
    var on = (kind === 'store') ? isStoreFav(id) : isEventFav(id);
    var cls = 'fav-star' + (on ? ' is-on' : '') + (extraClass ? ' ' + extraClass : '');
    var label = labelFor(on);
    return '<button type="button" class="' + escapeAttr(cls) + '"'
      + ' data-kind="' + escapeAttr(kind) + '"'
      + ' data-id="' + escapeAttr(id) + '"'
      + (available() ? '' : ' disabled aria-disabled="true"')
      + ' aria-label="' + escapeAttr(label) + '"'
      + ' title="' + escapeAttr(label) + '">'
      + (on ? '★' : '☆')
      + '</button>';
  }

  function setButtonState(btn, on) {
    if (on) { btn.classList.add('is-on'); } else { btn.classList.remove('is-on'); }
    btn.textContent = on ? '★' : '☆';
    var label = labelFor(on);
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
  }

  // 同一対象の☆が複数箇所にあっても全て同期する（セレクタ組み立てを避けて属性比較で走査）
  function syncButtons(kind, id) {
    var on = (kind === 'store') ? isStoreFav(id) : isEventFav(id);
    var all = document.querySelectorAll('.fav-star');
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b.getAttribute('data-kind') !== kind) continue;
      if (String(b.getAttribute('data-id')) !== String(id)) continue;
      setButtonState(b, on);
    }
  }

  // rootEl 配下の .fav-star をイベント委譲で処理（再描画されてもハンドラ付け直し不要）
  function bindStarButtons(rootEl) {
    var root = rootEl || document.body;
    if (!root || root.__gcgFavBound) return;
    root.__gcgFavBound = true;
    root.addEventListener('click', function (ev) {
      var target = ev.target;
      var btn = (target && target.closest) ? target.closest('.fav-star') : null;
      if (!btn || !root.contains(btn)) return;
      // 行全体が <a> の場合のページ遷移を抑止
      ev.preventDefault();
      ev.stopPropagation();
      if (!available()) return;
      var kind = btn.getAttribute('data-kind');
      var id = btn.getAttribute('data-id');
      if (kind !== 'store' && kind !== 'event') return;
      var on = (kind === 'store') ? toggleStore(id) : toggleEvent(id);
      syncButtons(kind, id);
      try {
        document.dispatchEvent(new CustomEvent('gcgfav:change', {
          detail: { kind: kind, id: id, on: on }
        }));
      } catch (e) { /* CustomEvent 非対応環境では通知のみ省略 */ }
    });
  }

  global.GCGFav = {
    available: available,
    getStores: getStores,
    getEvents: getEvents,
    isStoreFav: isStoreFav,
    isEventFav: isEventFav,
    toggleStore: toggleStore,
    toggleEvent: toggleEvent,
    starButtonHtml: starButtonHtml,
    bindStarButtons: bindStarButtons,
    syncButtons: syncButtons,
    STORAGE_KEY: STORAGE_KEY,
    SCHEMA_VERSION: SCHEMA_VERSION
  };
})(window);
