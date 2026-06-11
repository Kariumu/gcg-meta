# 第2案 点検結果（二次確認者レビュー）

対象文書: `pipeline-migration-plan-v2-2026-05-30.md`（第2案）
点検日: 2026-05-30
点検者: Claude（新セッション ＝ 第2案の作成者とは別の確認者）
点検方法: **読み取り専用**（grep / find / cat / Read のみ）
独立再確認: 別エージェント（Explore）が同じ主張をゼロから再検証 → dev側主張は全項目で私の判定と一致

---

## 0. 結論（先に要点）

第2案は第1案レビューの指摘を適切に反映しており、**核心の論理は正しく、devの実ファイルで裏が取れました**。特に、私が第1案で出した指摘②（「dev既存の `generate_cards.js` で代替できないか」）に対し、第2案は追加検証で「**代替不可**」を正しく結論づけています。これはdevで確認でき、妥当です。

ただし、実行前に直す（または明示する）べき点が **2つ** あります。

1. 【表示の修正・重要】第2案 §2 の見出しは「独立検証で file:line 確認済み」ですが、その中の **`post-processing.js` の行番号主張（OneDrive側ファイル）は、この dev 環境では検証できません**（dev に当該ファイルが存在しないため）。確認済みの dev 側事実と、未確認の OneDrive 側主張を分離表記すべきです。
2. 【精度の補足】Stage 0-C は私の検証で**先に回答が出せます**。`cards_preview.json` にセット識別フィールドは無く、`?set=` 値はカード番号接頭辞から導出が必要。その**参照実装は既に `generate_cards.js:897-907` にあり**流用可能。ただし `PROMO`／`β` で接頭辞≠package_set となる注意点と、「PROMO→プロモ」は**表示ラベルで URL 値は `PROMO` のまま**という点を明記すべき。

総合: **方向性・主要ロジックは承認できる水準**。上記1の表記修正と、`post-processing.js` 実物の確認（後述）を満たせば Stage 0 実行に進めます。

---

## 1. 第2案の主張の検証結果

凡例: ✅ devで確認 / ❓ この環境では確認不能（OneDrive側・要外部確認） / ⚠️ 要修正・要補足

### dev側で検証できた主張（すべて✅、独立確認者も一致）

| 主張（第2案） | 判定 | 根拠（file:line） |
|--------------|------|-------------------|
| `generate_cards.js` の生成対象は card_ranking ＋ cards_master の和集合 | ✅ | `generate_cards.js:371-374`（`new Set([...cardRanking.map(c=>c.card_id), ...Object.keys(cardsMaster)])`）、summary読込 `:353,356`、master読込 `:52` |
| `generate_cards.js` は `cards_preview.json` を読まない | ✅ | 同ファイルに `cards_preview` 参照なし（grep 0件） |
| `generate_cards.js` は単票/ターゲット引数を持たず一括生成型 | ✅ | 唯一の分岐は `process.env.DEBUG`（4枚固定）`:381-382`。`process.argv` の対象指定なし |
| ⇒ preview のみの当日新カード（master未収録）は generate_cards.js では生成不可 | ✅（妥当） | 上記より、preview-only カードは `allCardIds` に入らない |
| 日次は新カードを `cards_preview.json` に保存（master未収録） | ✅ | `auto-news.js:822-852` `saveCardPreview()`→`fs.writeFileSync(CARDS_PREVIEW_FILE…)`、ログ `[Preview]…保存`（`:852`）、`NOT in master`（`:1105`）。呼出 `:2239`。定義 `recognition-core.js:20,729-733` |
| dev git remote=kariumu/gcg-meta・main 追跡 | ✅ | `.git/HEAD=ref: refs/heads/main`、remote origin = github.com/kariumu/gcg-meta（第1案レビューで確認済） |
| 3スクリプト不在 / recognition-core は scripts/shared/ に在 | ✅ | find で再確認 |
| ルート auto-news.js が現行（Phase3＋recognition-core import）、homepage版は旧 | ✅ | 第1案レビューで確認済 |
| Phase3 が post-processing を try/catch で呼び失敗時ログのみ継続 | ✅ | `auto-news.js:2479-2491` |
| auto-news.js 冒頭で sharp(:17)・dotenv(:20) を require、依存は sharp/dotenv | ✅ | 同行＋依存チェーン（recognition-core:14 が sharp） |
| git-push.js は GitHub REST API（kariumu/gcg-meta/main）、ローカルpush不使用 | ✅ | `git-push.js:16-18,40-52,132-134` |
| `generate_cards.js` がパンくず（cards.html?set=, package_set基準）を生成、依存は fs/path/ntc-rank-consolidator のみ | ✅ | `:899-907`(set値), `:1097-1105`(nav), `:1077-1088`(JSON-LD), require `:7-8,18` |

### この環境では検証できない主張（❓ ＝ OneDrive側ファイル、要外部確認）

第2案 §0・§2・Stage 0-B が引用する **`post-processing.js` の行番号**はいずれも **dev に存在しないファイル**を指します。全マウント（gcg-meta / outputs / uploads 等）を探索しても `post-processing.js`・`regenerate-article.js`・`create-card-pages.js` は**不在**でした。したがって次は **この環境では未確認**です（誤りという意味ではなく、確認手段が無い）。

- 「post-processing.js の require は fs/path/../git-push.js のみ、sharp/dotenv 不要」（§2）
- 「webp は jpg のコピーで真変換なし（`:195`）」（§2）
- 「`cards_preview.json` を読む（`:31`,`:278-281`）」「`cards/{cn}/index.html` を出力（`:150-165`）」（§2）
- 「カードテンプレにパンくず無し（戻り導線 `:137` のみ）」（§2）
- 「DRY_RUN 分岐あり（`:157`,`:188`）」（Stage 3）
- 「`HOMEPAGE_ROOT` 等が `__dirname` 基準」（Stage 0-B）

→ **対応案**: (a) 第2案 §2 を「dev で確認済み」と「OneDrive側ファイルに基づく（dev未確認）」に節を分ける。(b) これらの具体値に依存する判断（Stage 1 のパス整合、Stage 2 のテンプレ位置、Stage 3 の DRY_RUN 分岐）は、**post-processing.js を dev/scripts/ にコピーした直後（Stage 1 の最初）に dev 上で行番号を実検証**してから先へ進む、という順序を Stage 1 に明記する。

---

## 2. Stage 0-C への先行回答（devで判明）

第2案 Stage 0-C「preview に `?set=` 用フィールドがあるか、無ければ接頭辞から導出」について、**この環境で答えが出ます**。

- `data/cards_preview.json`（dev、34,781B）は card_number をキーにした新カード情報を持つが、**`set`／`package_set`／`series`／`expansion` 等のセット識別フィールドは無い**（フィールドは card_number, card_name, color, card_type, level, cost, ap, hp, terrain, traits, link, rarity, effect, source_url, created_at, preview, _articleDate）。→ **接頭辞からの導出が必須**で確定。
- その**導出ロジックは既に `generate_cards.js:897-907` に実装済み**: `masterCard.package_set` を正とし、欠落時は ID 由来 `setPrefix`（`_pN`・末尾連番除去済み）へフォールバック。preview カードは master 未収録＝package_set 無し → 自動的に setPrefix が使われる構造。**Stage 2 はこのブロックをそのまま流用すれば整合する**。

注意点（Stage 2 で明示すべき）:

- **「PROMO→プロモ」は表示ラベルのみ**。URL の `?set=` 値は `setLinkValue`（＝`PROMO`）で、日本語ラベル `プロモ` は `setLinkLabel`（表示テキスト）側（`generate_cards.js:903-905`）。**URL に「プロモ」を入れない**こと。
- **`PROMO`／`β` は接頭辞 ≠ package_set になり得る**。通常の番号制セット（GD04・EB01・ST10 等）は「接頭辞＝package_set」で一致するが、プロモ等は card_number 接頭辞が `PROMO` と異なる可能性があり、preview カードの接頭辞フォールバックが将来 master 収録時の package_set と食い違う恐れ。→ Stage 0-C/Stage 2 で、プロモ・βの扱いを個別確認。

---

## 3. 第1案レビュー指摘の反映状況

- 指摘①（リスク表現）→ ✅ 反映。§7 が「依存未導入で起動不能（即時 throw）」と「静かな失敗（カードページのみ欠落）」の**2段階に分離**された。
- 指摘②（generate_cards.js で代替できないかの再検討）→ ✅ 反映＆解決。追加検証で「代替不可（preview を読まない／一括生成のみ）」と正しく結論。**devで裏取り済み**。
- 指摘③（dev内確認可能／外部確認の分離）→ △ 一部のみ。dev側事実は明確化されたが、**§2 が OneDrive側 post-processing.js の行番号を「確認済み」扱いで混在**させている（本レビュー §1の指摘）。
- 提案2（Stage 0-C を依存ブロッカー化）→ ✅ Stage 0-A（sharp/dotenv 確認）＋ §7 に反映。
- 提案6（homepage 旧版を指さない明文化）→ ✅ Stage 4 に「homepage 配下の旧 auto-news.js を絶対に指さない」と明記。
- 提案4（起動ゲート）→ △ Stage 3 の dry-run に内包されるが、「require 全通過で起動できること」を**最初の単独ゲート**として独立させると、より早期に依存不足を検知できる。

---

## 4. 独立確認者（別エージェント）の所見

dev側の5主張すべて VERIFIED。`post-processing.js` 不在のため行番号主張は「この環境では検証不可」と独立に指摘（本レビュー §1と一致）。追加で「preview カードはセット識別フィールドを持たないため、`cards.html?set=` フィルタページとの紐付けに導出ロジックが要る」点を指摘（本レビュー §2と整合）。

---

## 5. 進行可否

第2案は**主要ロジックが正しく、承認できる水準**です。次を満たせば Stage 0 実行に進めます。

1. §2 を「dev確認済み」と「OneDrive側・dev未確認」に分離表記（§1の対応案 a）。
2. `post-processing.js` の具体値（パス・DRY_RUN分岐・テンプレ位置）は、Stage 1 で dev にコピー直後に**dev上で行番号を実検証**してから依存（§1の対応案 b）。
3. なお dev の `cards_preview.json` は 5-28 付で、OneDrive の日次更新版とは内容が異なる**可能性**あり。Stage 3 検証時は最新の preview を使う点に留意（要松岡さん／実データ確認）。

依然として OneDrive・スケジューラ側でしか確認できない事項（日次タスクの実体、実行 auto-news.js パス、post-processing.js 現物）は松岡さんの確認が必須です。
