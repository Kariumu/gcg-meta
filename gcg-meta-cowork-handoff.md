# GCG META - Cowork引き継ぎドキュメント

---

## プロジェクト概要

ガンダムカードゲーム（GCG）の公式大会結果を自動収集・集計・公開する非公式ファンサイトを構築する。
収益はGoogle AdSense（無料公開＋広告）。運用はCoworkによる完全自動化を目指す。

---

## データソース

### 公式サイト（日本語版のみ結果掲載）

```
# イベント一覧
https://www.gundam-gcg.com/jp/tournament-results/

# 個別イベント結果（1〜8位）
https://www.gundam-gcg.com/jp/tournament-results/event.php?series={series_id}&event={event_id}

# デッキ詳細
https://www.gundam-gcg.com/jp/tournament-results/players_deck.php?series={series_id}&event={event_id}&no={0〜7}
```

### 現在のシリーズ情報

- series_id: `6226`
- 名称: ニュータイプチャレンジ 2026 MISSION2（3月開催）
- 開催期間: 2026年3月1日〜3月31日
- 現在掲載済み: 3月15日まで分（168件）
- 残り: 3月16日〜31日分は4月上旬にまとめて公開される見込み

### HTMLのクラス構造（重要）

```
# イベント一覧ページ
a.shopListDetailInner        → 各イベントへのリンク
  p（最初の要素）             → 開催日（例: 2026.03.15）
  h4                         → 店舗名

# 個別イベントページ
li.userListDetail            → 各プレイヤーの行
  span（最初の要素）          → 順位テキスト（"優勝" / "準優勝" / "3位"〜"8位"）
  h4.userInfoName            → プレイヤー名（ハンドルネーム）
  a[href*="players_deck"]    → デッキページへのリンク（no=0〜7）

# デッキページ
li > img[alt]                → カードID（例: GD01-024）
span.useCardsNum             → 枚数（例: 4）
img[src*="/cards/card/"]     → カード画像URL
  例: /jp/images/cards/card/GD01-024.webp
```

### robots.txt

存在しない（404）。スクレイピングを明示的に禁止するルールなし。

---

## 法的・権利関係の整理（確認済み）

| 要素 | リスク | 判断 |
|------|--------|------|
| 大会結果（順位・日付・店舗名） | なし | 事実情報 |
| プレイヤーのハンドルネーム | なし | 公式公開済み・著作権非該当 |
| カード名・ID（テキスト） | 限りなく低い | 識別子・事実情報 |
| デッキリスト（テキスト） | 限りなく低い | 他サイトも同様に運営中 |
| カード画像（ホットリンク） | 低い | 公式サーバーから直接配信 |
| カード画像（直接転載） | 高い | **使用しない** |

GCG専用のファンコンテンツポリシーは存在しない。
非公式wikiが画像直掲載で黙認されている状況のため、ホットリンクのリスクは実質低い。

**サイトに必ず明記する免責文:**
```
本サイトはガンダムカードゲームの非公式ファンサイトです。
バンダイ・サンライズの認可・許諾は得ていません。
掲載情報に問題がある場合はお問い合わせください。
©SOTSU･SUNRISE ©BANDAI
```

---

## スクレイパー（scraper.js）

### 実装済みのコード概要

- **言語**: Node.js
- **HTTPクライアント**: curl（axiosはリダイレクト問題あり）
- **HTMLパース**: cheerio
- **リクエスト間隔**: 3秒以上（サーバー負荷軽減）
- **User-Agent**: `GCG-META-FanSite/1.0 (非公式ファンサイト)`

### 実行方法

```bash
npm install cheerio
node scraper.js         # 差分のみ取得（通常実行）
node scraper.js --full  # 全件再取得
```

### 出力ファイル

```
data/
  events.json    # 全イベント・デッキデータ
  summary.json   # カード使用率集計データ
```

### events.jsonの構造

```json
{
  "series": {
    "6226": "ニュータイプチャレンジ 2026 MISSION2（3月開催）"
  },
  "events": {
    "5917993": {
      "series_id": "6226",
      "event_id": "5917993",
      "date": "2026-03-15",
      "store": "ゲームスペース鶴岡",
      "results": [
        {
          "rank": 1,
          "player": "ZERO",
          "deck_no": 0,
          "deck": [
            { "card_id": "GD01-024", "count": 4 },
            { "card_id": "GD03-018", "count": 3 }
          ]
        }
      ],
      "fetched_at": "2026-03-25T00:00:00.000Z"
    }
  }
}
```

### summary.jsonの構造

```json
{
  "total_events": 168,
  "total_decks": 1344,
  "card_ranking": [
    {
      "card_id": "GD01-024",
      "decks": 800,
      "usage_rate": 59.5,
      "wins": 120
    }
  ],
  "updated_at": "2026-03-25T00:00:00.000Z"
}
```

### 注意事項

- シリーズIDは毎月変わる可能性がある。ドロップダウンから動的に取得する実装済み
- 過去のシリーズはドロップダウンから消えるため、events.jsonが唯一の永続データになる
- 3月16日以降のデータは4月上旬に公開予定→その時点で `node scraper.js` を実行

---

## サイト構成

### ページ一覧

```
/                    トップ（最新イベント＋カード使用率ランキング）
/events/             イベント一覧
/events/{event_id}/  個別イベント結果（1〜8位＋デッキリスト）
/meta/               環境分析（カード使用率・デッキ傾向グラフ）
/cards/{card_id}/    カード別採用実績
```

### 技術スタック（推奨）

| 項目 | 選択 | 理由 |
|------|------|------|
| フレームワーク | 素のHTML/CSS/JS（静的） | サーバー不要・運用コストゼロ |
| データ読み込み | JSONファイル（fetch） | スクレイパーとの連携が簡単 |
| グラフ | Chart.js | 軽量・シンプル |
| ホスティング | GitHub Pages or Vercel | 無料・自動デプロイ対応 |
| ドメイン | 未決定 | |

### デザイン方針

- **テーマ**: ミリタリー×データダッシュボード
- **カラー**: ダークグリーン・チャコール・アンバーアクセント
- **雰囲気**: 作戦司令室でデータを分析しているイメージ
- カードIDクリックで公式カード検索ページへ遷移
- デッキリストにコピーボタン付き
- カード画像はホットリンク（公式サーバーから直接表示）

### カード画像のURL形式

```
https://www.gundam-gcg.com/jp/images/cards/card/{card_id}.webp
例: https://www.gundam-gcg.com/jp/images/cards/card/GD01-024.webp
```

### 公式カード検索ページへのリンク形式

```
https://www.gundam-gcg.com/jp/cards/{card_id}
```

---

## Cowork自動化フロー

```
[毎日 AM 9:00]
1. node scraper.js を実行
2. data/events.json・summary.json を更新
3. git add . && git commit -m "データ更新: $(date)"
4. git push origin main
5. GitHub Pages が自動デプロイ → サイト更新完了

[毎月末]
1. ドロップダウンに新シリーズが出現していないか確認
2. 新シリーズがあれば node scraper.js --full で全件取得
```

---

## 競合情報

- **非公式wiki**: `wikiwiki.jp/gget/` が先行して大会入賞デッキを掲載
  - 弱点: 手動更新・UIが古い・集計・分析機能なし
- **差別化ポイント**: カード使用率・デッキ傾向の集計・分析（自動更新）

---

## 収益化ロードマップ

| フェーズ | 期間 | 目標 |
|---------|------|------|
| 立ち上げ | 1〜2ヶ月 | サイト公開・データ蓄積 |
| 成長 | 3〜6ヶ月 | 500PV/日・SEO・X告知 |
| 収益化 | 6ヶ月〜 | AdSense申請・$3〜10/日 |

---

## 次にやること（優先順）

1. `node scraper.js --full` でローカルにデータを取得・確認
2. サイトのHTML/CSS/JS実装
3. GitHub Pages or Vercel にデプロイ
4. Coworkの自動実行スケジュール設定
5. 4月上旬に残りデータ（3/16〜3/31分）を追加取得
6. X（Twitter）アカウントを作成して大会結果を告知

---

*作成日: 2026-03-25*
*この会話の内容をもとにClaudeが作成*
