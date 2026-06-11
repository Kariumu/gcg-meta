# 第3案 runbook 点検結果（二次確認者レビュー）

対象文書: `pipeline-migration-runbook-v3-2026-05-30.md`（第3案・実行runbook）
点検日: 2026-05-30
点検者: Claude（新セッション ＝ 作成者とは別の確認者）
点検方法: **読み取り専用**（grep / find / cat / Read / python3。dev リポジトリへの変更・git操作・node実行なし）
独立再確認: 別エージェント（Explore）が dev側主張をゼロから再検証 → 全項目で一致（下記の `_pendingReview` 件数を含む）

---

## 0. 結論（先に要点）

第3案は **実行runbookとして概ね妥当**で、第2案レビューの主要指摘（§2の出典分離、移植後検証の順序）を正しく反映しています。dev側で検証できる事実はすべて実ファイルと一致しました。責任分担・コマンドも安全（読み取り専用 `Test-Path`、`npm install` は松岡さん）で、CLAUDE.md の運用ルールと整合します。

実行前に直す/補うべき点が **3つ**（うち1つは事実誤り）。

1. 【事実誤り・要修正】Stage 0-D の理由付け「preview に `_pendingReview` が実在するため regenerate-article.js 移植が必要寄り」は、根拠が不正確。`_pendingReview` フィールドは29件に在るが、**現在 `_pendingReview===true` は0件**。判断は「フィールドの有無」ではなく「auto-news.js の保留時フロー（手動補完→regenerate-article.js）が前提にしている」事実に基づくべき。
2. 【実務ギャップ・要補足】Stage 1 は Cowork が **OneDrive の post-processing.js を dev へコピー**する前提だが、dev中心の環境（本セッション等）では **OneDrive パスは見えない**。Stage 1 着手の前提として「実行者が OneDrive 出典を読めること（または松岡さんが先に dev へ配置）」を明記すべき。
3. 【精度・軽微】Stage 2 の `?set=` 値は **package_set そのもの**（例 `PROMO`）で、`プロモ` は表示ラベルのみ。PROMO/β は接頭辞≠package_set になり得る点を明示。

総合: 上記1の修正と2の前提明記を満たせば、**Stage 0 →（点検）→ Stage 1 へ進める水準**。2B（OneDrive post-processing.js の内部仕様）は runbook 記載どおり Stage 1 でコピー直後に dev 上で実検証する設計で妥当。

---

## 1. dev側で検証できた事実（§2A・Stage 1前提・すべて✅、独立確認者も一致）

| runbook の主張 | 判定 | 根拠（file:line / 実データ） |
|----------------|------|------------------------------|
| generate_cards.js 対象 = card_ranking(`:356`) ∪ cards_master キー(`:370-373`)、DEBUG時4枚(`:380-382`)、preview非読込 → master未収録の当日新カード生成不能 | ✅ | `generate_cards.js:356,371-374,381-382`。`cards_preview`参照なし |
| cards_preview.json は card_number キーの42件、セット識別フィールド無し | ✅ | 42件。フィールド集合に set/package_set/series/expansion 無し |
| cards_preview.json のフィールドに `_pendingReview`/`_pendingReviewIssues`/`_articleDate` が含まれる | ✅(存在) | `_pendingReview` 29件保有 / `_pendingReviewIssues` 29件 / `_articleDate` 41件（※1件欠落） |
| 新カードの preview 書き込み = auto-news.js `saveCardPreview()`、dev で既に機能 | ✅ | `auto-news.js:814,822,850,852`、呼出 `:2239` |
| Phase 3 が `require('./scripts/post-processing')` を try/catch で呼ぶ | ✅ | `auto-news.js:2479-2491` |
| auto-news.js 冒頭で sharp(`:17`)・dotenv(`:20`) require、外部npm = sharp+dotenv | ✅ | 同行＋ `recognition-core.js:14`(sharp) |
| git-push.js は GitHub REST API（kariumu/gcg-meta/main）、native のみ | ✅ | `git-push.js:16-18,40-52,132-134` |
| generate_cards.js のパンくず（`?set=` `:907` / BreadcrumbList `:1080` / nav `:1097`）、依存 fs/path/ntc-rank-consolidator | ✅ | 同行＋require `:7-8,18` |
| 3スクリプト不在 / recognition-core は scripts/shared/ に在 | ✅ | find 全マウント探索で不在、recognition-core 実在 |
| **Stage 1 パス整合**: dev直下に git-push.js・cards/・images/cards/・index.html | ✅ | 4要素すべて存在。post-processing.js を scripts/ に置けば `../git-push.js`→dev直下、`__dirname/..`→Webルート（cards/等の層）に解決 |

### 追加で判明した精度情報（runbookに反映推奨）

- **`?set=` の突合**: cards.html はフィルタ箱の `data-value`（例 `data-value="PROMO"`、`cards.html:485-513`付近）と `?set=` 値を突合（`generate_cards.js:898` コメントが明記）。**URL 値＝package_set**。表示名 `PROMO→プロモ` は `generate_cards.js:904` の `SET_DISPLAY_NAMES`（表示ラベルのみ、URLは `PROMO` のまま：`:903-907`）。→ Stage 0-C残「正規化マップの所在」は、表示ラベル側は `generate_cards.js:904` に既存。**突合キー（data-value=package_set）は cards.html 側**で要確認（Cowork）。
- **create-card-pages.js は dev パイプラインから一切参照されない**（auto-news.js / manual-card-news.js / recognition-core.js に require もログも無し）→ runbook の「generate_cards.js に置換され不要の可能性」は支持される。

---

## 2. この環境では確認できない事項（§2B・要外部確認）

runbook §2B は **OneDrive 実ファイル `C:\Users\kariu\OneDrive\GCGSimulator\homepage\scripts\post-processing.js`** に基づく主張で、**dev側確認者の環境では未確認**（全マウント探索で post-processing.js 不在）。runbook はこれを2Bとして分離し「Stage 1 で取り込み dev 側で再確認」と明記しており、**出典分離は正しく行われています**（第2案レビューの主要指摘は解消）。

未確認のまま依存する具体値（Stage 1 で実検証すべき）:

- require が fs/path/`../git-push.js` のみ・sharp/dotenv 不要（§2B / 合格基準）
- `cards_preview.json` 読込（`:31`,`:278-281`）・`cards/{cn}/index.html` 出力（`:150-165`）・webp は jpg コピー（`:195`）
- カードテンプレにパンくず無し（戻り導線 `:137`）
- パス基準 `path.resolve(__dirname,'..','git-push.js')`（§2B）

> 補足（事実）: 上記が真であれば、Stage 1 のパス整合は dev 側で満たせます（§1の最終行）。OneDrive も dev も「scripts/ の直上が Webルート」という同じ層構造のため、`__dirname/..` 方式は移植で崩れにくい。ただしこれは **2B が真である前提**なので、コピー直後の実検証（runbook Stage 1 合格基準）で確定すること。

---

## 3. 指摘事項（実行前に対応）

### 指摘①【要修正・事実】Stage 0-D の理由付け

runbook §2C Stage 0-D は「preview に `_pendingReview` が実在するため、手動補完後の再生成（regenerate-article.js）は移植が必要寄り」とします。検証結果:

- `_pendingReview` フィールドは **29件に存在**するが、**`_pendingReview===true` は現在0件**（全件 false）。独立確認者も同結論。
- regenerate-article.js は auto-news.js から **`require` されていない**。言及はコメント/ログのみ（`auto-news.js:846,2281,2286,2299,2514`）＝**手動リカバリ用ツール**（起動には不要）。

→ つまり「フィールドが在る」ことは移植要否の直接根拠になりません（事実と可能性の混同）。正しい根拠は「**auto-news.js の保留時フロー（保留検知→停止→手動補完→`node scripts/regenerate-article.js --date …` で再生成）が、このスクリプトの存在を前提にしている**」点。
→ **対応案**: 理由文を上記に差し替え。要否判断は「保留カード（`_pendingReview===true`）が実際に発生する運用局面で必要になる手動ツール」と位置づけ、起動ブロッカーではないことを明記。移植は「運用完全性のため先行移植」か「初回保留発生時に後追い」のどちらかを選択（runbookで明示）。create-card-pages.js は§1のとおり不要寄りで妥当。

### 指摘②【要補足・実務】Stage 1 のコピー元アクセス

Stage 1 は Cowork が「OneDrive `scripts/post-processing.js` を dev `scripts/` に配置」とします。しかし **dev のみを開いた環境では OneDrive パスは参照不可**（マウントは gcg-meta / outputs / uploads のみ）。

→ **対応案**: Stage 1 の前提に「実行する Cowork セッションが `C:\Users\kariu\OneDrive\GCGSimulator\homepage\scripts\post-processing.js` を読めること（OneDrive を含むフォルダを開く）。困難な場合は松岡さんが当該ファイルを先に dev へ配置（またはアップロード）」を追記。これが無いと Stage 1 が着手できない可能性。

### 指摘③【軽微・精度】Stage 2 の set 値

- `?set=` の値は **package_set 値そのもの**（`GD04`/`EB01`/`PROMO`/`β` 等）。**表示ラベル `プロモ` を URL に入れない**（`generate_cards.js:903-907`）。
- preview カードは package_set が無く接頭辞導出になるが、**PROMO/β は接頭辞≠package_set の恐れ**。Stage 2 はこの2値を個別処理（接頭辞→正しい package_set へのマップ）として明記。
- （軽微）`_articleDate` は 42件中 **1件で欠落**。Stage 3 / 再生成系で日付参照する場合のエッジケースとして留意。

---

## 4. 指摘反映状況（第2案レビュー比）

- §2 出典分離（dev確認済 / OneDrive・dev未確認）→ ✅ 2A/2B に分離、出典パス明記。
- post-processing.js 具体値は Stage 1 でコピー後 dev 検証 → ✅ Stage 1 合格基準に反映。
- Stage 0-C（set フィールド無し→接頭辞導出）→ ✅ 決着を反映。
- homepage 旧版を指さない → ✅ Stage 4・リスクに明記。
- 責任分担・コマンド安全性 → ✅ CLAUDE.md と整合（Cowork は git/scheduler/.env/npm/切替を行わない）。

---

## 5. 進行可否

dev側の事実は堅牢で、runbook 構造（段階ゲート・合格基準・ロールバック）も妥当です。次を満たせば **Stage 0 →（二次確認）→ Stage 1** に進めます。

1. 指摘①: Stage 0-D の理由を「auto-news.js の保留時フロー前提（require ではない手動ツール）」に修正。
2. 指摘②: Stage 1 のコピー元（OneDrive）アクセス前提を明記、または松岡さんが先行配置。
3. 指摘③: Stage 2 の set 値仕様（URL=package_set、PROMO/β特例）を明記。

外部確認が必須の事項（松岡さん／OneDrive側）は従来どおり: 日次18:00タスクの実体、実行される auto-news.js の実パス、post-processing.js 現物、Stage 0-A の sharp/dotenv 導入。
