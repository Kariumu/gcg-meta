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

## 公式ツイート取得のページング(2026-07-31 追加)

`auto-news.js` の `fetchOfficialTweets()` は、以前 `max_results: '10'` 固定でページング未実装だった。
そのため指定期間内の公式ポストが 10 件を超えると、古い側が**無言で切り捨て**られていた。

- 実際に起きた事故: 2026-07-24 20:32〜20:37 JST の【収録カード紹介】5 件が取り込まれず、`reports/news/2026-07-24.html` が生成されなかった
- 修正内容(2026-07-31): `TWEETS_PAGE_SIZE = 100`(X API v2 の上限)へ引き上げ、`meta.next_token` によるページングを実装。`TWEETS_MAX_PAGES = 5`(最大 500 件)を安全弁とし、上限到達時はログに `*** 警告 ***` を出す
- ページ間は 1 秒スリープ。同一 `pagination_token` が繰り返された場合は打ち切る
- `tools/check-uncovered-news.js` も同じ関数を使うため、掲載漏れ検知の取りこぼしも同時に解消される

### 復旧実行時の注意(期間は 1 日ずつ区切る)

記事日付は「窓内で最も古い新カード投稿の日付」で決まる(`auto-news.js` 2271 行)。
なおここで使うのは `created_at` の **UTC 日付**であり JST ではない(公式ポストは 20 時台 JST = 11 時台 UTC が通例なので通常は一致するが、00:00〜08:59 JST の投稿が最古になると記事日付が 1 日前にずれる)。
広い期間を指定すると複数日ぶんの新カードが 1 本の記事に統合され、`reports/news/<最も古い日付>.html` を上書きしてしまう。
上限が 10 件から 500 件に上がったことでこのリスクは顕在化しやすくなったため、**取りこぼし復旧は `--start-time` / `--end-time` で 1 日(できれば数十分)ずつ区切って実行する**こと。

### `--dry-run` の効果範囲(誤解しやすい点)

`--dry-run` がガードするのは **X への投稿(`uploadMediaToX` / `postTweet` / `postSurvey`)と `git-push` のみ**。
Google Vision / Anthropic API の呼び出しは `--dry-run` でも実行され、**課金は発生する**。
「`--dry-run` で API 課金リスク回避」という表現は X 投稿系についてのみ正しい。

### 旧コピーの残存

`homepage/auto-news.js`、`tmp/shijisho50-handover/` および `tmp/shijisho52-handover/` 配下の `auto-news.js` は `max_results: '10'` のままの旧版(`tmp/shijisho58-handover/auto-news.js` は本改修の引き渡し用コピーで修正版)。
現行の実行経路(`run-auto-news-daily.bat` → `E:\GCGSTATS\auto-news.js`、`tools/check-uncovered-news.js` の require)はいずれも修正版を通るため実害はないが、混同しないこと。

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

## トップページ高速化と data/top_stats.json(2026-07-31 追加・指示書60)

トップページ(`index.html`)の初期表示は `data/top_stats.json` だけで描画する。`data/events.json`(14.0MB)は
日付フィルタが操作されたときに初めて読み込む(初期転送量 15.9MB → 2.2MB を実測)。

- `data/top_stats.json` は `generate-events.js` が出力する(夜間チェーンで自動追随。bat は無変更)
- `data/card_colors.json` / `data/series.json` を手動更新したら `node generate-events.js` を手動再実行して top_stats.json を追随させる(集計値がこの2ファイルに依存するため)
- 集計ロジックは `index.html` の `refreshDashboard()` と1対1対応。片方だけ直すと表示が食い違うので必ず両方直し、パリティ照合をやり直すこと
- 出力は決定性が必須(同一 events.json で2回生成するとバイト一致)。実行時刻(`new Date()`/`Date.now()`)を混ぜないこと
- `top_stats.json` が取得できない場合は `events.json` から集計する従来経路へ自動フォールバックする(表示は退行しない)
- **警告**: `scraper.js --deploy` / `AUTO_DEPLOY=1` の経路は `generate-events.js` を呼ばず `top_stats.json` を更新も push もしない。この経路を使うときは `node generate-events.js` の併走が必須(怠ると events.json だけ新しくなり、トップの初期表示が**エラーも出さずに旧集計値を表示し続ける**。ファイルは200で取得できるためフォールバックも効かない)。scraper.js 本体の改修はバックログ
- `index.html` の `<noscript>` / `.seo-content` は `generate.js` が夜間に書き換える生成ブロック。`</main>` 直前という位置が置換アンカーになっているため、移動・削除しないこと

## X 毎日投稿の運用(2026-08-01 追加・指示書61)

`post-x-daily.js` が夜間バッチから 1 工程だけ呼ばれ、X(@gcg_stats) へ自動投稿する。

- **今日のカード**: 毎晩 1 件。既定レンジ(`data/top_stats.json` の `default_range`)の採用デッキ数上位 100 枚・採用 5 デッキ以上をプールとし、日付シードで決定論的に 1 枚選ぶ。直近 60 日に投稿したカードはスキップして次候補へ回る
- **週次ムーバー**: 月曜のみ。前週(月〜日)と前々週(月〜日)の採用デッキ数の増分 TOP3〜5。前々週窓が 20 デッキ未満なら「前週の採用TOP」へ自動切替、両窓とも 20 未満ならムーバー自体をスキップする
- `data/cards_preview.json` 収載のプレビューカードは常時プールから除外する(auto-news の新カード投稿との重複回避)

### 実行前の確認は必ず --dry-run

```bash
node post-x-daily.js --dry-run                  # 選定・文面・加重文字数・添付予定を表示するのみ
node post-x-daily.js --dry-run --date 2026-08-03  # 日付を偽装(曜日判定・窓・状態キー・ガード・文面日付が一括で追随)
node post-x-daily.js --dry-run --only mover
```

- `--dry-run` では **postTweet / メディアアップロード / 状態ファイル書き込みのいずれも実行しない**。状態ファイルの「読み」だけは行う(選定・ガードに必要)
- 書き込みを行う関数はすべて先頭に `assertNotDryRun()` があり、dry-run 中に到達したら例外を投げる
- `--dry-run=true` のような `=` 付きの書き方でも dry-run と判定される

### run-auto-news-daily.bat を手動で叩かないこと

bat を手で実行すると auto-news と post-x-daily の **X 投稿が発火する**。動作確認は上記の `--dry-run` で行い、実投稿は 20:00 のタスクスケジューラに任せる。
bat を書き換える場合は **20:00±15 分を避ける**(実行中の書き換えは破壊的挙動を起こす)。追記行は全 ASCII・LF 厳守。

### 状態ファイル .sched-run-tmp/x-daily-log.json

- **ローカル専用。git に入れない・push しない・deploy 候補にも入れない**(`.gitignore` に `.sched-run-tmp/` を登録済み)
- キーは `daily:<JST日付>` と `mover:<JST週の月曜日付>` に分離
- **起動時に当日(当週)キーが存在すれば status を問わず無条件でスキップする**(at-most-once)。同夜 2 回走行やクラッシュ再走で二重投稿しないための最重要ガード。「今日投稿済みのカードが 60 日ガードに引っかかって 2 枚目を選ぶ」実装にしてはいけない
- 投稿直前に `status:"attempting"` を原子的に記録(tmp 書き→rename)し、成功後に `posted` ＋ `tweet_id` へ更新する
- JSON が壊れていた場合は**当夜の投稿を中止**し(fail-close)、破損ファイルを `.corrupt-<時刻>` へ退避して空ファイルを作り直す。60 日ぶんの再登場ガード履歴は失われるのでログに残る
- 手で消すと再登場ガードがリセットされ、直近に投稿したカードが再び選ばれうる

### 投稿失敗はバッチの終了コードに伝播しない

`post-x-daily.js` は `process.exitCode` を常に 0 に固定する。bat 側も `XPOSTRC` に記録するだけで最終 exit には使わない(最終 exit は従来どおり `SYNCRC` / `FETCHRC` のみ)。X 投稿の失敗でタスクスケジューラが失敗表示になることはない。

### 画像の扱い

`images/cards/<id>.jpg` があればそれを、無ければ `<id>.webp` を **sharp で jpeg に変換**して添付する(一時ファイルは `.sched-run-tmp/x-media/`、投稿後に削除)。X は webp も受け付けるが、実績のある jpg で送るための措置。sharp は既存依存で追加インストールは不要。アップロードに失敗した場合は画像なしで投稿し、ログに残す。

### 既定レンジは top_stats.json 依存

`scraper.js --deploy` / `AUTO_DEPLOY=1` の経路で `top_stats.json` が古いまま取り残されると、post-x-daily も**エラーを出さずに旧期間で集計し続ける**。当該経路を使ったら `node generate-events.js` を必ず併走させること(トップページ側と同じ注意)。

## NTC公式集計の取込(2026-08-03 追加・指示書63 Step 1-N)

公式デッキログ(BANDAI TCG+ の `d.bandai-tcg-plus.com/gcgja`)が公開している
ニュータイプチャレンジの**集計値**を取り込み、`ntc-official.html` として公開する。

### データの所在と役割

| ファイル | 役割 |
|---|---|
| `data/ntc_dashboard.json` | 取込データ(シリーズ別に集計値・履歴・店舗行を累積) |
| `fetch-ntc-dashboard.js` | 取得・累積マージ |
| `generate-ntc-dashboard.js` | `ntc-official.html` を静的生成 |
| `deploy-ntc-dashboard.js` | 上記2つ+`sitemap.xml` の差分push |

### 既存のNTC統計とは混ぜない(重要)

`data/events.json` / `data/top_stats.json` / `data/series.json` などの**当サイト独自集計とは別系統**。
`ntc_dashboard.json` を既存統計の母集団に足さないこと。ページも独立(`ntc-official.html`)。
公式集計は「参加者全体の登録デッキ」が母数と推定され、当サイトの入賞デッキ集計とは分母が違う。

### 取得元の制約(指示書63 Step 0b の実測)

- 取得は **RSCヘッダ**(`RSC: 1` / `Accept: text/x-component`)。同じURLをHTMLで取ると14MB、RSCなら約37KB
- **集計値は累積**なので1日1回の取得で常に完全
- **店舗行は最新20件の窓**しか返らない(ページング無し)。毎晩取って差分を貯める設計。過去分は取り戻せない
  - 取得時に「店舗行が全件新規かつ20件」だった場合は**取りこぼしの疑い**として警告ログを出す。
    これが続くようなら取得頻度の見直しが必要(現状は毎晩1回・松岡さん了承済み)
- シリーズ一覧(`/gcgja/tournament` の `sanctionedTournamentList`)には**開催中のシリーズしか載らない**。
  一覧から消えても `data` に記録済みのIDは直接取得を続ける
- 存在しないIDは **HTTP 200 + `NEXT_HTTP_ERROR_FALLBACK;404`** を返す。これを404扱いにして `fetch_stopped: true` を立てる
- **JSチャンクの解析は禁止**(取得元の規約に配慮)。ページング手段の再探索もしない

### 対象シリーズは手動オプトイン(2026-08-03 松岡さん指示)

**新しいシリーズを見つけても自動では取り込まない。** 一覧に出てきたら夜間ログに

```
[ntc-dashboard] 新しいシリーズを検出(未取得): <ULID> ニュータイプチャレンジ …（9月開催） 2026/9/1〜2026/9/30
[ntc-dashboard]   → 取り込む場合は: node fetch-ntc-dashboard.js --add <ULID>
```

と出るだけ。**結果が出てから `--add` で1回追加する**。
(9月シリーズは結果がまだ無いため、意図的に取得対象外にしている)

あわせて、**結果が1件も公開されていないシリーズはページに表示しない**。
データには残るので、結果が出た日の生成から自動的に表示に切り替わる。

### 使い方

```powershell
# まず必ず dry-run(取得・解析はするが書き込み0件)
node fetch-ntc-dashboard.js --dry-run

# 本番取得(登録済みシリーズのみ。data/ntc_dashboard.json を原子書き込みで更新)
node fetch-ntc-dashboard.js

# 新しいシリーズを取り込む(手動オプトイン。結果が出てから実行する)
node fetch-ntc-dashboard.js --add <ULID>

# 登録済みシリーズだけ取り直す(未登録IDを渡すと拒否される)
node fetch-ntc-dashboard.js --once 01KYXTCZ5G4513GTX5E892G33Q

# ページ生成 → push(差分があるものだけ)
node generate-ntc-dashboard.js
node deploy-ntc-dashboard.js --dry-run
node deploy-ntc-dashboard.js
```

- 3スクリプトとも**終了コードは常に0**。異常は `auto-news-schtasks.log` のログで判別する
  (夜間バッチの最終exitを汚さないため。post-x-daily.js と同じ方針)
- 隔離検証用に `NTC_DASHBOARD_ROOT` で site ルートを差し替えられる

### 夜間バッチ

`run-auto-news-daily.bat` の post-x-daily 工程の直後に `ntc-dashboard` 工程を追加済み。
`NTCDASHRC` はログ記録専用で、バッチの最終 exit code には**使わない**(従来どおり SYNCRC / FETCHRC)。
3スクリプトが exit 0 固定のため、`NTCDASHRC` は設計上つねに 0 になる(飾りの記録)。

### sitemap

`ntc-official.html` の登録は **generate-sitemap-extra.js** 側で行う
(`generate-events.js` / `generate_cards.js` のハードコード一覧はNTC系のため触らない)。
削除正規表現は **loc完全一致**で書いてある(前方一致にすると同名前方一致のURLを巻き込む)。
lastmod は `data/ntc_dashboard.json` の全シリーズ `aggregates_latest.date` の最大値。
generate-sitemap-extra.js は「新イベントflagの夜」しか走らないため、
`ntc-official.html` の sitemap 収載は**初回だけ手動で1回**実行して入れておく。

### 色の扱い

先方は色を数値(1〜5)で返す。当サイトは **{1:青, 2:緑, 3:赤, 4:紫, 5:白}** で表示している。
これは指示書63 Step 0 の WCS 72デッキから**唯一解として逆算した対応**であり、公式定義の確認は取れていない。
ページには「色分類は当サイトの推定対応」と注記済み。
`tests/test-04-colors.js` がこの唯一性を毎回再証明するので、テストが落ちたら表示を止めて再調査すること。
`[]`(空配列)は「色情報なし」と表示する(単色は `[1]` のような1要素配列で来るため別物)。

### 注意

- `js/common.js` の `DECK_COLORS`(hex)は generate-ntc-dashboard.js 内に**写し**を持っている
  (common.js はブラウザ専用で require できないため)。common.js 側の色を変えたら生成器の写しも直すこと。
  `tests/test-03-generate.js` が両者の一致を機械照合する
- `_PAGE_MAP` に `'ntc-official'` を追加済み(主タブ「大会データ」が点灯)。
  `sub: null` だが `main: 'tournaments'` のため**大会データ系の共通サブナビ帯は表示される**
  (イベント/シリーズ/スケジュールが並び、どれもアクティブにならない)。この見え方でよいかは発行元判断
- **このページには AdSense タグを入れていない**(指示書63 Step 0b の方針変更「サイトはAdSense収益化を恒久的に行わない」に従う)。
  既存ページの AdSense タグ撤去と CLAUDE.md「デプロイ設定」節の収益記述の更新は 63 の範囲外。別途要対応

## 関連ドキュメント

- `gcg-meta-cowork-handoff.md`: プロジェクト全体の引き継ぎ文書(歴史・経緯)
- `translation-dictionary-v1.md`: 翻訳辞書(英語名対応)

## AI への指示(共通ルール)

- `auto-news.js` を実行する前に `--dry-run` で動作確認すること(API 課金リスク回避)
- 修正前に必ず該当行のコードを松岡さんに提示し、修正方針を承認してから実装すること
- git 操作(add/commit/push)は Sandbox から実行できないため、コマンド文を提示して松岡さんに依頼するか、Cowork が必要に応じて代行する
- `.git/objects` 不在の OneDrive sparse mount による誤検出に注意(本リポでも発生)。CRLF/末尾切断/file 不在等の自己診断は原則として無視する
