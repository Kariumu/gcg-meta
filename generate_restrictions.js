/**
 * generate_restrictions.js — 禁止・制限カード一覧ページ生成器（指示書57）
 *
 * data/restrictions.json（唯一の正）＋ data/cards_master.json（カード名の解決）から
 * ルート直下の restrictions.html を LF で出力する単体スクリプト。
 *
 * 設計方針:
 *  - 夜間チェーン（rebuild-site.bat / run-auto-news-daily.bat）には組み込まない。
 *    禁止・制限の改定は年数回程度のため、改定時に手動で1回実行する運用とする。
 *  - ページ内の表示値（施行日・発表日・件数・カード一覧・制限枚数）は
 *    すべて data/restrictions.json から動的に生成する。ハードコード禁止。
 *  - 決定性: 生成日時を埋め込まない（同一入力なら2回生成でバイト一致）。
 *  - 公式発表文の転載は必要最小限の引用にとどめ、出典URLを明記する。
 *
 * 使い方: node generate_restrictions.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SITE_URL = 'https://gcg-stats.com';
const OUT_FILE = 'restrictions.html';

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "2026-07-25" → "2026年7月25日"（不正な値はそのまま返す） */
function formatJpDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

// ---------- データ読み込み ----------

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
}

function loadMaster() {
  // cards_master.json は data/ 配下（2026-07-30 現物確認）。
  // 配列形式・辞書形式のどちらでも id→card の辞書に正規化する。
  const raw = readJson('data/cards_master.json');
  const map = {};
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  for (const c of arr) {
    if (c && typeof c === 'object' && c.id) map[c.id] = c;
  }
  return map;
}

// ---------- 部品 ----------

const TYPE_JP = { UNIT: 'ユニット', PILOT: 'パイロット', COMMAND: 'コマンド', BASE: 'ベース', TOKEN: 'トークン' };
const COLOR_HEX = { Blue: '#4488ff', Green: '#44cc64', Red: '#ff4444', White: '#cccccc', Purple: '#b444ff' };

/**
 * カード1枚のタイル。
 * master に存在しない id でも「id のみ表示」で必ず描画する（将来の改定で
 * 先行掲載カードが現れてもページを落とさないための防御）。
 */
function cardTile(id, master, badge) {
  const c = master[id];
  const name = c && c.name_jp ? c.name_jp : '';
  const typeJp = c ? (TYPE_JP[c.card_type] || '') : '';
  const colorHex = c ? (COLOR_HEX[c.color] || '#888') : '#888';
  const alt = name || id;
  const badgeHtml = badge
    ? `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:4px;background:var(--bg-elevated);border:1px solid var(--border);font-size:10px;color:var(--accent)">${escapeHtml(badge)}</span>`
    : '';
  const nameHtml = name
    ? `<div style="font-size:13px;font-weight:600;color:var(--text-primary)">${escapeHtml(name)}</div>`
    : `<div style="font-size:13px;font-weight:600;color:var(--text-muted)">カード名未登録</div>`;
  return `<a href="cards/${escapeHtml(id)}/" style="display:flex;align-items:center;gap:8px;text-decoration:none;padding:6px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;transition:border-color 0.15s"
                 onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
                <img src="images/cards/${escapeHtml(id)}.webp" alt="${escapeHtml(alt)}" loading="lazy"
                     style="width:36px;height:50px;border-radius:3px;object-fit:cover;border:1px solid var(--border)"
                     onerror="this.style.display='none'">
                <div>
                  ${nameHtml}
                  <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${escapeHtml(id)}${typeJp ? `<span style="color:${colorHex};margin-left:4px">${escapeHtml(typeJp)}</span>` : ''}${badgeHtml}</div>
                </div>
              </a>`;
}

function cardGrid(ids, master, badgeOf) {
  return `<div style="display:flex;flex-wrap:wrap;gap:10px">
              ${ids.map((id) => cardTile(id, master, badgeOf ? badgeOf(id) : '')).join('\n              ')}
            </div>`;
}

function sectionOpen(title, countLabel) {
  return `      <section style="margin-bottom:32px">
        <h2 style="font-size:16px;color:var(--accent);margin-bottom:12px">${escapeHtml(title)}<span style="margin-left:8px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">${escapeHtml(countLabel)}</span></h2>`;
}

// ---------- 本体 ----------

function buildHtml(r, master) {
  const effective = formatJpDate(r.effective_date);
  const announced = formatJpDate(r.announced_date);
  const sourceUrl = r.source_url || '';

  const banned = Array.isArray(r.banned) ? r.banned : [];
  const restricted = Array.isArray(r.restricted) ? r.restricted : [];
  const pairs = (r.banned_pairs && Array.isArray(r.banned_pairs.specific)) ? r.banned_pairs.specific : [];
  const group = (r.banned_pairs && r.banned_pairs.group) ? r.banned_pairs.group : null;
  const members = group && Array.isArray(group.members) ? group.members : [];

  const title = `ガンダムカードゲーム 禁止・制限カード一覧【${effective}施行】| GCG STATS`;
  const description = `ガンダムカードゲーム（GCG）の禁止カード・制限カード・禁止ペアを${effective}施行の内容で一覧。禁止${banned.length}種・制限${restricted.length}種・禁止ペア${pairs.length}組・グループ禁止ペア対象${members.length}種を、カード画像と個別ページへのリンクつきで掲載しています。`;

  // --- 禁止カード ---
  let bannedHtml = sectionOpen('① 禁止カード', `${banned.length}種`);
  bannedHtml += `
        <p style="margin-bottom:12px">デッキに1枚も入れることができないカードです。</p>
        ${banned.length ? cardGrid(banned, master) : '<p style="color:var(--text-muted)">該当なし</p>'}
      </section>`;

  // --- 制限カード ---
  let restrictedHtml = sectionOpen('② 制限カード', `${restricted.length}種`);
  restrictedHtml += `
        <p style="margin-bottom:12px">記載された枚数までしかデッキに入れることができないカードです。</p>
        ${restricted.length
          ? cardGrid(restricted.map((x) => x.id), master, (id) => {
              const hit = restricted.find((x) => x.id === id);
              return hit ? `${hit.count}枚まで` : '';
            })
          : '<p style="color:var(--text-muted)">該当なし</p>'}
      </section>`;

  // --- 禁止ペア ---
  let pairsHtml = sectionOpen('③ 禁止ペア', `${pairs.length}組`);
  pairsHtml += `
        <p style="margin-bottom:12px">組み合わせで指定されたカードを、同じデッキに同時に入れることができません（片方だけであれば使用できます）。</p>`;
  if (pairs.length) {
    pairsHtml += pairs.map((pair) => `
        <div style="margin-bottom:12px;padding:14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">
            ${pair.map((id) => cardTile(id, master)).join(`
            <span style="font-size:18px;font-weight:700;color:var(--red)">×</span>
            `)}
          </div>
        </div>`).join('');
  } else {
    pairsHtml += '\n        <p style="color:var(--text-muted)">該当なし</p>';
  }
  pairsHtml += `
      </section>`;

  // --- グループ禁止ペア ---
  let groupHtml = '';
  if (group) {
    groupHtml = sectionOpen('④ グループ禁止ペア', `対象${members.length}種`);
    groupHtml += `
        <p style="margin-bottom:12px">下記の条件に当てはまるカード同士は、すべての組み合わせが禁止ペアとして扱われます。つまり、このグループの中から使えるのは<strong>1種類だけ</strong>で、その1種類を<strong>4枚まで</strong>入れられます。</p>
        <div style="margin-bottom:12px;padding:14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px">対象条件</div>
          <p style="margin:0 0 10px;color:var(--text-primary)">${escapeHtml(group.label || '')}</p>
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:4px">公式発表より引用</div>
          <blockquote style="margin:0;padding:8px 12px;border-left:3px solid var(--accent);color:var(--text-secondary);font-size:13px">${escapeHtml(group.rule || '')}</blockquote>
        </div>`;
    if (group.st05_exception) {
      groupHtml += `
        <div style="margin-bottom:12px;padding:12px 14px;background:var(--bg-elevated);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:6px">
          <div style="font-size:13px;font-weight:600;color:var(--accent);margin-bottom:6px">スタートデッキの例外規定</div>
          <p style="margin:0;font-size:13px">${escapeHtml(group.st05_exception)}</p>
        </div>`;
    }
    groupHtml += `
        ${members.length ? cardGrid(members, master) : '<p style="color:var(--text-muted)">該当なし</p>'}
      </section>`;
  }

  // --- 更新履歴（初版1行を restrictions.json から機械生成） ---
  const historyLine = `${effective}施行（${announced}発表）時点の内容: 禁止${banned.length}種・制限${restricted.length}種・禁止ペア${pairs.length}組・グループ禁止ペア対象${members.length}種`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-3MY17P4E7F');
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:site_name" content="GCG STATS">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE_URL}/${OUT_FILE}">
  <meta property="og:image" content="${SITE_URL}/images/ogp-default.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${SITE_URL}/images/ogp-default.png">
  <link rel="canonical" href="${SITE_URL}/${OUT_FILE}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "name": "ガンダムカードゲーム 禁止・制限カード一覧",
    "description": ${JSON.stringify(description)},
    "url": "${SITE_URL}/${OUT_FILE}",
    "isPartOf": {
      "@type": "WebSite",
      "name": "GCG STATS",
      "url": "${SITE_URL}/"
    }
  }
  </script>
</head>
<body>
  <div id="header"></div>

  <main class="container" style="max-width:900px">
    <div class="section-header" style="margin-bottom:16px">
      <h1 class="section-title">ガンダムカードゲーム 禁止・制限カード一覧</h1>
    </div>

    <div style="margin-bottom:24px;padding:14px 16px;background:var(--bg-card);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:var(--radius-lg)">
      <div style="font-size:18px;font-weight:700;color:var(--accent);margin-bottom:4px">${escapeHtml(effective)}施行</div>
      <div style="font-size:13px;color:var(--text-muted)">${escapeHtml(announced)}発表${sourceUrl ? ` ／ <a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">公式発表を見る</a>` : ''}</div>
      <p style="margin:8px 0 0;font-size:12px;color:var(--text-muted)">本ページは非公式ファンサイトによるまとめです。最新かつ正式な内容は必ず公式発表をご確認ください。</p>
    </div>

    <article style="line-height:1.9;font-size:14px;color:var(--text-primary)">

      <section style="margin-bottom:32px">
        <h2 style="font-size:16px;color:var(--accent);margin-bottom:12px">禁止・制限とは</h2>
        <p><strong>禁止カード</strong> — デッキに1枚も入れることができないカードです。公認・公式イベントでは使用できません。</p>
        <p><strong>制限カード</strong> — 記載された枚数までしかデッキに入れることができないカードです。通常は同名カードを4枚まで入れられますが、制限カードはその上限が下がります。</p>
        <p><strong>禁止ペア</strong> — 指定された2枚の組み合わせを、同じデッキに同時に入れることができません。どちらか片方だけであれば使用できます。</p>
        <p><strong>グループ禁止ペア</strong> — 指定された条件に当てはまるカード同士のすべての組み合わせが禁止ペアになります。結果として、そのグループからは1種類のみ・4枚までしかデッキに入れられません。</p>
      </section>

${bannedHtml}

${restrictedHtml}

${pairsHtml}
${groupHtml ? '\n' + groupHtml + '\n' : ''}
      <section style="margin-bottom:32px">
        <h2 style="font-size:16px;color:var(--accent);margin-bottom:12px">デッキ構築時のチェック</h2>
        <p>GCG STATSの<a href="deck-builder.html" style="color:var(--accent)">デッキビルダー</a>は、ここに掲載した禁止・制限・禁止ペアを自動でチェックします。デッキを組みながら違反の有無を確認できます。</p>
        <p style="margin-top:10px"><a href="deck-builder.html" style="display:inline-block;padding:10px 18px;background:var(--accent);color:var(--bg-primary);border-radius:6px;text-decoration:none;font-weight:600">デッキビルダーを開く</a></p>
      </section>

      <section style="margin-bottom:32px">
        <h2 style="font-size:16px;color:var(--accent);margin-bottom:12px">更新履歴</h2>
        <ul style="margin:0;padding-left:20px">
          <li>${escapeHtml(historyLine)}</li>
        </ul>
      </section>

      <section style="margin-bottom:32px">
        <h2 style="font-size:16px;color:var(--accent);margin-bottom:12px">出典・免責</h2>
        <p>本ページの内容は公式発表${sourceUrl ? `（<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(sourceUrl)}</a>）` : ''}を基に、当サイトが独自に整理・解説したものです。引用は必要最小限にとどめています。</p>
        <p>本サイトはガンダムカードゲームの非公式・非営利のファンサイトです。バンダイ・サンライズの認可・許諾は得ていません。掲載情報の利用により生じた損害について、当サイトは一切の責任を負いません。</p>
        <p>©SOTSU・SUNRISE ©BANDAI</p>
      </section>

    </article>
  </main>

  <div id="footer"></div>

  <script src="js/common.js?v=15"></script>
  <script>
    GCG.init();
    document.getElementById('header').innerHTML = GCG.renderHeader('restrictions');
    document.getElementById('footer').innerHTML = GCG.renderFooter();
  </script>
</body>
</html>
`;

  return html;
}

function main() {
  const r = readJson('data/restrictions.json');
  const master = loadMaster();
  const html = buildHtml(r, master);
  // LF固定で出力（既存生成器の慣習）
  fs.writeFileSync(path.join(ROOT, OUT_FILE), html.replace(/\r\n/g, '\n'), 'utf-8');

  const banned = (r.banned || []).length;
  const restricted = (r.restricted || []).length;
  const pairs = ((r.banned_pairs || {}).specific || []).length;
  const members = (((r.banned_pairs || {}).group || {}).members || []).length;
  const all = [
    ...(r.banned || []),
    ...(r.restricted || []).map((x) => x.id),
    ...(((r.banned_pairs || {}).specific) || []).flat(),
    ...((((r.banned_pairs || {}).group || {}).members) || [])
  ];
  const uniq = [...new Set(all)];
  const missing = uniq.filter((id) => !master[id]);

  console.log(`[generate_restrictions] ${OUT_FILE} 生成完了 (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  console.log(`  施行日: ${r.effective_date} / 発表日: ${r.announced_date}`);
  console.log(`  禁止 ${banned} / 制限 ${restricted} / 禁止ペア ${pairs}組 / グループ対象 ${members}`);
  console.log(`  言及カード: 延べ${all.length} / 重複なし${uniq.length}`);
  if (missing.length) {
    console.log(`  [警告] cards_master.json 未登録のid（id表示のみで出力）: ${missing.join(', ')}`);
  }
}

main();
