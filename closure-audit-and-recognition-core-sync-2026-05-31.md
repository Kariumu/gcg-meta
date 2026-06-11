# ①完全監査 ＋ ②recognition-core 全面同期 — 結果（二次確認用）

実施日: 2026-05-31 JST / 作業者: Claude（Cowork）/ 二次確認: 松岡さん側（ホスト Read）
方法: 読み取りは CRLF 正規化＋md5。②は OneDrive→dev のバイト移植。

---

## ① 完全監査：依存閉包の乖離表

OneDrive `auto-news.js` の require 閉包（再帰）＋実行時読込ファイルを列挙し分類。

### A. require 閉包のローカル JS（コード）

| ファイル | 判定 | dev / OneDrive | 備考 |
|---|---|---|---|
| `auto-news.js` | **双方向差分** | 119,265B / 126,592B（<33 >201） | ③でマージ（OneDrive基底＋dev class版 buildCardBlockHtml） |
| `scripts/shared/recognition-core.js` | **dev遅れ→②で同期済** | 旧48,182B→109,749B | dev固有<6は旧署名（破棄）。下記②参照 |
| `scripts/manual-card-news.js` | **同一**（md5一致） | 50,516B | 対応不要 |
| `git-push.js` | **同一**（md5一致） | 5,908B | 対応不要 |
| `scripts/post-processing.js` | **dev先行** | 19,660B / 17,272B（<32 >0） | Stage1+2（パンくず）。dev維持 |

require グラフ: auto-news.js → {git-push, manual-card-news, recognition-core, post-processing}、manual-card-news → recognition-core。**閉包のコードはこの5本で全数**。

### B. 入力で出力に効くデータ/テンプレ

| ファイル | 判定 | 備考 |
|---|---|---|
| `data/qa_database.json` | **同一**（156,266B） | ルール解説の入力。整合済 |
| `data/card_texts.json` | **同一**（131,712B） | 整合済 |
| `data/card_names.json` | **同一**（23,205B） | 整合済 |
| `data/card_colors.json` | 双方向差分（dev29,227B/OD11,845B、<650 >1） | データ蓄積（dev が多い）。コードでない。dev維持で可 |

### C. 揮発データ/ログ（実行時状態・同期対象外、参考）

`data/cards_master.json`（dev先行）, `data/summary.json`（双方向）, `data/cards_preview.json`（dev遅れ・OneDriveが日次で新しい）, `data/last-check.json`, `data/vision-api-usage.json`（devなし＝初回実行で生成）。いずれも実行時に dev 側が管理する状態/データで、コード整合の対象外。

### 監査の結論

**コード乖離は `auto-news.js`（マージ）と `recognition-core.js`（同期）の2本のみに限定**。manual-card-news.js・git-push.js は同一、post-processing.js は dev 先行（ Stage1+2 ）。入力データ（qa_database 等）は整合済。閉包内に隠れた「遅れコード」は無し。

---

## ② recognition-core.js 全面同期（OneDrive→dev）

- 同期前: dev 48,182B / 1,096行（md5 112c3752…）
- 同期後: dev **109,749B / 2,285行 / md5 `73cb6941c2a37327a5a9494f90f1cd74`**
- OneDrive 原本: 109,749B / 2,285行 / md5 `73cb6941c2a37327a5a9494f90f1cd74`
- **→ サイズ・md5・全文一致（バイト移植成功）**。bash ビューも一致（末尾切断なし）。

### ホスト権威ビューでの確認（私の側）

- 新署名が反映: `generateIntroText(cardInfoList, relatedCards, articleDate, sameDayLinkPairs = [])`（:1865）、`generateCardAnalyses(cardInfoList, relatedCards, sameDayLinkPairs = [])`（:1982）。旧3引数/2引数版は消滅。
- `module.exports`（〜:2285 で `};` 完結）に **detectSameDayLinkPairs / matchesLinkCondition / findComboCandidates / evaluateComboCandidates / writeComboCandidatesReport / evaluateRuleClarifications / writeRuleClarificationsReport** が揃う。ファイル完全（切断なし）。
- 破棄した dev 固有6行＝旧 `generateIntroText`(3引数)/`generateCardAnalyses`(2引数) 署名と関連カード整形の旧行。OneDrive に上位版があり**保全不要**で正しい。

### 副次的効果（③への布石）

`detectSameDayLinkPairs` 等は recognition-core.js が定義・エクスポートする。dev `auto-news.js` の `module.exports` は `...require('./scripts/shared/recognition-core.js')` で recognition-core の export を展開するため、**②同期により、auto-news.js を require した際にこれら6関数も再エクスポートされる**ようになった（regenerate-article.js の分割代入が解決する前提が揃う）。ただし日次の同日リンク機能を main 経路に入れるには③（auto-news.js マージ）が必要。

---

## 次：③ auto-news.js 3-wayマージ（あなたの①②二次確認の後）

OneDrive `auto-news.js`（2722行）を基底に、dev の class版 `buildCardBlockHtml` のみ再適用。`generateIntroText/generateCardAnalyses` 呼び出しは OneDrive の `sameDayLinkPairs` 付き版を採用（同期済 recognition-core の新署名と整合）。実施後、node --check ＋隔離レンダリング＋ Phase3 結線確認を行い、二次確認に回します。
