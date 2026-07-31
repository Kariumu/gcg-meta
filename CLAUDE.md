# GCG STATS (gcg-meta) - CLAUDE.md

## プロジェクト概要

GCG STATS(`https://gcg-stats.com`)は、ガンダムカードゲーム(GCG)公式大会結果を自動収集・集計・公開する非公式ファンサイト。
収益は Google AdSense。デプロイは GitHub Pages(`kariumu/gcg-meta`)。

## auto-news.js の運用について

### ROOT定義(2026-05-09 修正)

`auto-news.js` の `ROOT` は環境変数 `NEWS_OUTPUT_ROOT` で切替可能。
デフォルトは `__dirname`(= `homepage/`)。

```javascript
// auto-news.js 31行目
const ROOT = process.env.NEWS_OUTPUT_ROOT || __dirname;
```

#### 修正の経緯

- 旧版(`_auto-news-manual.js`、2026-04-09 まで)では `ROOT = __dirname`(homepage/)であった
- 2026-04-16 の新版で `path.resolve(__dirname, '..')`(GCGSimulator/)に変更されたが、以下の不具合が発生していた:
  - `cards_master.json` / `summary.json` は homepage/data/ にしか存在しないため、`loadCardsMaster()` / `loadSummary()` が空フォールバックで動作していた(try/catch でエラーログは出ない)
  - 画像保存先と `git-push.js` の読み込み元の絶対パス解決が不安定で、ENOENT エラーが発生していた(2026-04-04〜04-06 に 3 件)
- 2026-05-09 に `process.env.NEWS_OUTPUT_ROOT || __dirname` に修正(指示書 18-auto-news-strict-verification.md の必須1)

### ローカル環境での副作用

`auto-news.js` を実行すると、生成された記事・画像が
ローカルの作業ツリー(`homepage/reports/news/`、`homepage/images/news/`、`homepage/data/`)に出力される。
このため、`git status` が常時 modified 状態になる。

ただし、本番反映は `git-push.js` が GitHub REST API 経由で行うため、
ローカルの作業ツリーがコミットされていなくても実害なし。

### 推奨運用フロー

1. `auto-news.js` 実行 → ローカルの `homepage/` 配下に記事生成
2. 生成記事の品質確認(ローカルプレビュー)
3. `git-push.js` が GitHub REST API で本番 push(`kariumu/gcg-meta` リポへ)
4. ローカルで `git pull` で同期(ローカルブランチを最新化)
5. `git status` が clean に戻る

### 環境変数 NEWS_OUTPUT_ROOT による切替

- 通常運用: 設定不要(デフォルトで `homepage/` を使う)
- 隔離出力(本番リポを汚したくない検証用): 別ディレクトリを指定可能

```bash
# 例: テスト用の隔離出力先を指定
NEWS_OUTPUT_ROOT=/tmp/auto-news-test node auto-news.js --dry-run
```

### TEST_MODE(2026-05-17 指示書32 で環境変数化、対応済)

`auto-news.js` の TEST_MODE は環境変数 / CLI フラグで制御可能。
新カード記事・速報記事の X 投稿スキップを切替えるフラグ。

#### 優先順位(`auto-news.js` line 124-132)

1. `--no-test-mode` CLI フラグ → 強制 `false`(X 投稿実行)
2. `--test-mode` CLI フラグ → 強制 `true`(X 投稿スキップ)
3. `AUTO_NEWS_TEST_MODE=false` 環境変数 → `false`
4. `AUTO_NEWS_TEST_MODE=true` 環境変数 → `true`
5. デフォルト → `true`(安全側、X 投稿スキップ)

#### postSurvey(アンケート投稿)の挙動

`postSurvey` は `TEST_MODE` を見ず、`ENABLE_SURVEY` 環境変数で別途制御される。
- `--enable-survey` CLI フラグ指定時のみ実行
- 未指定時はスキップ(デフォルト無効、`auto-news.js` line 133-135)

#### 本番運用切替例

```bash
# X 投稿実行(本番)
AUTO_NEWS_TEST_MODE=false node auto-news.js
# または
node auto-news.js --no-test-mode

# X 投稿実行 + アンケート投稿も実行
AUTO_NEWS_TEST_MODE=false node auto-news.js --enable-survey
```

## データソース

### 公式サイト

```
# イベント一覧
https://www.gundam-gcg.com/jp/tournament-results/

# 個別イベント結果
https://www.gundam-gcg.com/jp/tournament-results/event.php?series={series_id}&event={event_id}

# デッキ詳細
https://www.gundam-gcg.com/jp/tournament-results/players_deck.php?series={series_id}&event={event_id}&no={0〜7}
```

`series_id` は毎月変わる可能性あり。詳細は `gcg-meta-cowork-handoff.md` を参照。

## 新弾取り込み運用（TCG+トークン差分取得、指示書48）

新カードを `data/cards_master.json` に取り込んだ直後（フェッチ→マスター更新→ページ生成の後）に、
TCG+トークン変換表（`data/tcgplus_tokenmap.json`）の差分取得を実行する:

```bash
node scripts/scan-tcgplus-tokens.js --diff --dry-run   # 対象列挙と計画の確認（APIアクセスなし）
node scripts/scan-tcgplus-tokens.js --diff             # 差分取得（1.5秒間隔・既定上限500リクエスト）
```

- 差分0件なら即終了（冪等）。TCG+側未登録カードは card/list 登録ゲートで自動除外して報告
- 中断しても再実行で継続（diff用state: `tmp/tcgplus-scan-diff-state.json`。47の本stateとは分離）
- 想定リクエスト数が500を超える見込みの場合は実行前に松岡さんへ規模提示・承認（指示書48 §0）
- 非公式API（BANDAI TCG+）依存。仕様・制約はスクリプト冒頭コメントを参照
- 新弾を公式が発表したら `data/sets_meta.json` に1行追記する（`code` / `name_jp` / `release_date`(YYYY-MM-DD) / `kind`、任意で `pinned_articles`）。新弾情報ハブ `sets/`（指示書52）の最新弾判定・発売日表示・関連記事ピン留めに使用

## ページ再生成とサイトマップの順序(2026-07-29 追加)

`sitemap.xml` は複数のスクリプトが分担して書き出す。順序を守らないと記事が欠落する。

```bash
node generate_cards.js                 # カード個別ページ + sitemap(カード分)
node generate_cardlist.js              # cards.html
node generate_deckbuilder.js           # deck-builder.html
node generate-report.js --index-only   # reports/index.html + sitemap(reports/*.html 分)
node generate-sitemap-extra.js         # sitemap に series/sets/reports-news/events を追記(最後)
```

- `generate-report.js --index-only` は `data/articles.json` を唯一の正として `reports/index.html` と sitemap の reports 部分を書き出す(API不使用)
- `generate-sitemap-extra.js` は追記専用。必ず最後に回すこと
- `events/*.html`(780件)の sitemap 収載も `generate-sitemap-extra.js` の担当(指示書56 Task 2 で追加)。`generate-events.js` が書いた events URL は `generate_cards.js` の全再生成で必ず破棄されるため、最後の extra が毎回戻す構造になっている。events の lastmod は `data/events.json` の `events[<イベントID>].date`(イベント開催日)で、実行日ではない
- 実際に起きた事故(いずれも 2026-07-29):
  - `--index-only` の後に `generate-sitemap-extra.js` を回さず、sitemap から `reports/news/*.html` 62件が一時消失
  - 逆に `generate_cards.js` → `generate-sitemap-extra.js` だけを回していた期間があり、`reports/*.html` 41件(MSA記事・LR考察・NTC分析)が長期間 sitemap 未登録だった
  - `events/*.html` 780件が全コミット一貫して sitemap 未登録だった(generate-events.js が書く → generate_cards.js が破棄 → extra が戻さない構造。指示書56 Task 2 で解消)
- 再生成後は URL 数が実行前より減っていないことを必ず確認する

## 記事公開・整合性チェックのスクリプト(2026-07-29 追加)

| スクリプト | 用途 |
|---|---|
| `scripts/msa-publish.js <slug> --publish` | MSA環境レポートの 記事生成→検証→push→X投稿 を1コマンドで実行。入力は `tmp/<slug>.json`(PDFを読んだ Cowork が作成)。既定は DRY RUN、`--build` で生成のみ。サイトマップ順序も内部で固定済み |
| `scripts/check-official-cardlist-sync.js` | 公式カードリスト21カテゴリと `cards_master.json`・生成ページの整合性チェック。`run-auto-news-daily.bat` に組込済で毎日20:00に実行。要対応があれば終了コード1(タスクスケジューラ上で失敗表示) |
| `scripts/push-cardlist-update.js` | GitHubへの push。候補は `cards_master.json` のキー＋許可リストに限定(ディスク走査しない)。200件超で自動停止(`--force-count` で続行)。`--extra` は拡張子でテキスト/バイナリを振り分ける |

- `data/cards_preview.json`(auto-news が公式Xから自動蓄積)が「マスタ未登録だが正当なページ」の許可リストとして自動参照される。`data/preview_card_pages.json` は手動の例外リストで、通常は追記不要
- `translation-dictionary-v1.md` はデッキ名の対訳辞書。**MSA記事を書く前に必ず参照する**。新規訳語は記事公開時に追記する(`msa-publish.js` が自動実行)
- OGP画像は `images/ogp/<slug>.png`(1200x630)。`push-cardlist-update.js` の既定候補に含まれる

## 禁止・制限ページの更新運用(2026-07-30 追加・指示書57)

禁止・制限が改定されたら、`data/restrictions.json` を更新したうえで次を実行する。

```bash
node generate_restrictions.js   # restrictions.html を再生成(単体実行。夜間チェーンには非組込)
```

- `restrictions.html` の表示値はすべて `data/restrictions.json` から生成される。HTML を直接編集しないこと
- 生成後は `restrictions.html` と `sitemap.xml`(必要なら導線を変えた静的ページ)を push する
- sitemap の静的一覧は `generate-events.js` と `generate_cards.js` の**両方**にハードコードされている。URL を増減するときは両方に反映する(片方だけだと他方の実行で消える)

## デプロイ設定

- リポジトリ: `kariumu/gcg-meta`(Public)
- デプロイ: GitHub Pages
- `git-push.js` が `BRANCH = 'main'` に GitHub REST API で push
- ローカル `E:\GCGSTATS\.git\HEAD` は `refs/heads/main` を指す(2026-07-30 現物確認。旧記述の `refs/heads/master` は誤りだったため修正)。push 先も `main` で一致

## 関連ドキュメント

- `gcg-meta-cowork-handoff.md`: プロジェクト全体の引き継ぎ文書(歴史・経緯)
- `translation-dictionary-v1.md`: 翻訳辞書(英語名対応)

## AI への指示(共通ルール)

- `auto-news.js` を実行する前に `--dry-run` で動作確認すること(API 課金リスク回避)
- 修正前に必ず該当行のコードを松岡さんに提示し、修正方針を承認してから実装すること
- git 操作(add/commit/push)は Sandbox から実行できないため、コマンド文を提示して松岡さんに依頼するか、Cowork が必要に応じて代行する
- `.git/objects` 不在の OneDrive sparse mount による誤検出に注意(本リポでも発生)。CRLF/末尾切断/file 不在等の自己診断は原則として無視する
