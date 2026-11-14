/**
 * js/contact-form.js — お問い合わせフォーム（一般の問い合わせと広告掲載の相談を同じフォームで受ける）
 *
 * 送り先: 同じドメインの /api/contact（Cloudflare Workers。worker/contact-worker.js）
 * - 入力の確かめはここと送り先の両方で行う（ここの確かめは使いやすさのため。守りは送り先）。
 * - 迷惑投稿の対策: Cloudflare Turnstile（サイトキーは公開してよい値。秘密鍵は Worker の secret にだけ置く）と、人には見えない欄（website）。
 * - 「受け付けました」は送り先が { ok: true } を返したときだけ出す。失敗したときは入力をそのまま残し、もう一度送れるようにする。
 * - 送信中はボタンを止めて二重送信を防ぐ。
 * - GA4 へは問い合わせの種類だけを送る（名前・メールアドレス・本文・ショップ名などは送らない）。
 * - ?type=ad（ad / bug / data / other）で種類を選んだ状態で開く。
 */
(function () {
  'use strict';
  var form = document.getElementById('contact-form');
  if (!form) return;
  var ENDPOINT = form.getAttribute('data-endpoint') || '/api/contact';
  var TYPES = { ad: '広告掲載の相談', bug: '不具合の報告', data: '掲載データの訂正', other: 'その他' };
  var SLOTS = ['card_links', 'banner', 'parallel', 'undecided'];
  var LIMITS = { name: 100, email: 254, message: 4000, shop_name: 100, shop_url: 300, period: 100, budget: 100 };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var adBox = document.getElementById('ad-fields');
  var statusEl = document.getElementById('form-status');
  var btn = form.querySelector('button[type="submit"]');
  var btnLabel = btn ? btn.textContent : '';
  var sending = false;

  function val(name) { var el = form.elements[name]; return el && typeof el.value === 'string' ? el.value.trim() : ''; }
  function typeVal() { var r = form.querySelector('input[name="type"]:checked'); return r ? r.value : ''; }

  function syncAd() {
    var on = typeVal() === 'ad';
    adBox.hidden = !on;
    // 隠れている欄は確かめにも送信にも使わない
    Array.prototype.forEach.call(adBox.querySelectorAll('input,textarea,select'), function (el) { el.disabled = !on; });
  }

  // ?type= で種類を選ぶ
  try {
    var t = new URLSearchParams(location.search).get('type');
    if (t && TYPES[t]) { var r = form.querySelector('input[name="type"][value="' + t + '"]'); if (r) r.checked = true; }
  } catch (_) { /* 古いブラウザでは選ばずに開く */ }
  syncAd();
  Array.prototype.forEach.call(form.querySelectorAll('input[name="type"]'), function (r) { r.addEventListener('change', function () { syncAd(); clearErr('type'); }); });

  function setErr(name, msg) {
    var box = document.getElementById('err-' + name); if (box) { box.textContent = msg; box.hidden = !msg; }
    var el = form.elements[name];
    if (el && el.setAttribute && !(el instanceof RadioNodeList)) { if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
  }
  function clearErr(name) { setErr(name, ''); }
  Array.prototype.forEach.call(form.querySelectorAll('input,textarea'), function (el) { el.addEventListener('input', function () { if (el.name) clearErr(el.name === 'slots' ? 'slots' : el.name); }); });

  function validate() {
    var errs = {};
    var name = val('name'), email = val('email'), type = typeVal(), message = val('message');
    if (!name) errs.name = 'お名前（ご担当者名）を入力してください。'; else if (name.length > LIMITS.name) errs.name = LIMITS.name + ' 文字以内で入力してください。';
    if (!email) errs.email = 'メールアドレスを入力してください。'; else if (email.length > LIMITS.email || !EMAIL_RE.test(email)) errs.email = 'メールアドレスの形式をご確認ください（例: name@example.com）。';
    if (!TYPES[type]) errs.type = 'お問い合わせの種類を選んでください。';
    if (!message) errs.message = 'お問い合わせ内容を入力してください。'; else if (message.length > LIMITS.message) errs.message = LIMITS.message + ' 文字以内で入力してください。';
    if (type === 'ad') {
      var shop = val('shop_name'), url = val('shop_url');
      if (!shop) errs.shop_name = 'ショップ名（会社名）を入力してください。'; else if (shop.length > LIMITS.shop_name) errs.shop_name = LIMITS.shop_name + ' 文字以内で入力してください。';
      if (!url) errs.shop_url = 'ショップの URL を入力してください。'; else if (url.length > LIMITS.shop_url || !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(url)) errs.shop_url = 'http:// または https:// で始まる URL を入力してください。';
      if (!form.querySelectorAll('input[name="slots"]:checked').length) errs.slots = '希望する広告枠を 1 つ以上選んでください（未定でも構いません）。';
      if (val('period').length > LIMITS.period) errs.period = LIMITS.period + ' 文字以内で入力してください。';
      if (val('budget').length > LIMITS.budget) errs.budget = LIMITS.budget + ' 文字以内で入力してください。';
    }
    ['name', 'email', 'type', 'message', 'shop_name', 'shop_url', 'slots', 'period', 'budget'].forEach(function (k) { setErr(k, errs[k] || ''); });
    return errs;
  }

  function show(kind, html) {
    statusEl.className = 'form-status is-' + kind; statusEl.innerHTML = html; statusEl.hidden = false;
  }

  function turnstileToken() {
    var el = form.querySelector('input[name="cf-turnstile-response"]'); return el ? el.value : '';
  }
  function resetTurnstile() { try { if (window.turnstile) window.turnstile.reset(); } catch (_) { /* */ } }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return; // 連打しても 1 回だけ
    var errs = validate(); var first = Object.keys(errs)[0];
    if (first) {
      show('error', '入力内容をご確認ください。');
      var el = form.elements[first]; if (el && el.focus) el.focus(); else if (el && el[0] && el[0].focus) el[0].focus();
      return;
    }
    var token = turnstileToken();
    if (!token) { show('error', '送信前の確認（迷惑投稿の対策）が終わっていません。少し待ってからもう一度お試しください。'); return; }
    var type = typeVal();
    var body = { name: val('name'), email: val('email'), type: type, message: val('message'), website: val('website'), turnstile: token };
    if (type === 'ad') {
      body.shop_name = val('shop_name'); body.shop_url = val('shop_url'); body.period = val('period'); body.budget = val('budget');
      body.slots = Array.prototype.map.call(form.querySelectorAll('input[name="slots"]:checked'), function (c) { return c.value; }).filter(function (v) { return SLOTS.indexOf(v) >= 0; });
    }
    sending = true; btn.disabled = true; btn.textContent = '送信中…'; form.setAttribute('aria-busy', 'true');
    show('sending', '送信しています。画面を閉じずにお待ちください。');
    var done = false;
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 20000);
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin', signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { return { status: res.status, j: j }; }); })
      .then(function (r) {
        if (r.status === 200 && r.j && r.j.ok === true) {
          done = true;
          form.hidden = true;
          show('success', '<strong>お問い合わせを受け付けました。</strong><br>内容を確認し、必要に応じてご入力のメールアドレスへご連絡します。');
          statusEl.focus && statusEl.focus();
          try { if (typeof gtag === 'function') gtag('event', 'contact_submit', { inquiry_type: type }); } catch (_) { /* 計測の失敗は無視 */ }
          return;
        }
        var code = r.j && r.j.error;
        var msg = code === 'rate_limited' ? '短い時間に続けて送信されました。少し時間をおいてからもう一度お試しください。'
          : code === 'turnstile' ? '送信前の確認（迷惑投稿の対策）に失敗しました。もう一度お試しください。'
          : code === 'invalid' ? '入力内容をご確認ください。'
          : '送信できませんでした。時間をおいてもう一度お試しください。';
        throw new Error(msg);
      })
      .catch(function (err) {
        var msg = err && err.name === 'AbortError' ? '通信に時間がかかったため送信できませんでした。もう一度お試しください。'
          : (err && err.message && /[ぁ-ん]/.test(err.message) ? err.message : '送信できませんでした。通信の状態をご確認のうえ、もう一度お試しください。');
        show('error', msg + '<br>入力した内容はそのまま残っています。うまくいかない場合は、下記のメールアドレスへお送りください。');
      })
      .then(function () {
        clearTimeout(timer);
        sending = false; form.removeAttribute('aria-busy');
        if (!done) { btn.disabled = false; btn.textContent = btnLabel; resetTurnstile(); }
      });
  });
})();
