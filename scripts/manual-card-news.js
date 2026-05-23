#!/usr/bin/env node
/**
 * scripts/manual-card-news.js
 *
 * 手動でカード画像から記事を生成するスクリプト。
 * イベント時公開等、auto-news.js の自動取得で拾えない場合に使用。
 *
 * Usage:
 *   node scripts/manual-card-news.js --image <path> [--output-dir <dir>] [--no-article] [--dry-run]
 *
 * Examples:
 *   # 認識のみ実施 (Vision/色判定/マージ → recognition.json)
 *   node scripts/manual-card-news.js --image ./samples/card.png --no-article
 *
 *   # 認識 + 記事生成 (Anthropic API 呼び出し有り、Opus 1〜2回)
 *   node scripts/manual-card-news.js --image ./samples/card.png
 *
 *   # 出力先を指定 (デフォルトは ./tmp/manual-news/)
 *   node scripts/manual-card-news.js --image ./samples/card.png --output-dir C:\temp\mnews
 *
 * 設計原則:
 * - X 投稿関連 (postSurvey/postTweet) は呼ばない (記事生成のみ)
 * - GitHub push (pushFiles/git-push.js) は呼ばない (本番反映しない)
 * - 出力先は本番デプロイされない場所 (デフォルト ./tmp/manual-news/)
 *
 * 関連: auto-news.js の module.exports (2793-2814行) 経由で関数を再利用
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const https = require('https');

// 共通モジュールから関数を再利用(指示書34 で auto-news.js → shared/recognition-core.js に変更、循環依存解消)
// 注: 指示書21により step1A_visionOCR は本スクリプトでは使用しない (callVisionAIv2 で置換)
const {
  step1A_visionOCR, // eslint-disable-line no-unused-vars
  step1B_pixelColorDetection,
  step1C_merge,
  loadCardsMaster,
  loadSummary,
  loadCardsPreview,
  buildUnifiedCardDB,
  generateIntroText,
  generateCardAnalyses,
  log,
  callClaude,
} = require('./shared/recognition-core.js');

// === 独自 Vision API 関数 (指示書21 Step 1) ===
// 改良点:
//   1. DOCUMENT_TEXT_DETECTION: 文書構造を考慮、改行処理改善、小文字精度向上
//   2. languageHints: ['ja']: 日本語特化で誤認識減少
// auto-news.js の callVisionAI / step1A_visionOCR は無変更 (本番影響なし)
function callVisionAIv2(base64Image, useDocumentDetection = true) {
  const apiKey = process.env.GOOGLE_CLOUD_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_CLOUD_API_KEY が設定されていません');

  const featureType = useDocumentDetection ? 'DOCUMENT_TEXT_DETECTION' : 'TEXT_DETECTION';
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const payload = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: featureType, maxResults: 1 }],
        imageContext: {
          languageHints: ['ja'],
        },
      },
    ],
  };
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (res.statusCode === 200) resolve(data);
            else
              reject(
                new Error(
                  `Vision API ${res.statusCode}: ${JSON.stringify(data).slice(0, 300)}`
                )
              );
          } catch (e) {
            reject(new Error(`Vision API JSON parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// === Step 2: 後処理ルール (指示書22) ===
// _rawText から正規表現でフィールドを抽出・補完。
// terrain は記事生成で使用しないため抽出対象外(松岡さんの判断、2026-05-10)。
// auto-news.js は無変更、すべて scripts 配下に閉じ込める。
function postProcessVisionResultV2(rawText, visionResult) {
  if (!rawText || !visionResult) return visionResult;

  const result = { ...visionResult }; // 元オブジェクトを変更しない

  // ─────────────────────────────────
  // 1. card_number 抽出
  //    パターン: EB01-009, GD04-117, ST01-001, P-001 等
  // ─────────────────────────────────
  const cardNumberMatch = rawText.match(/\b([A-Z]{1,3}\d{2}-\d{3}|P-\d{3})\b/);
  if (cardNumberMatch) {
    result.card_number = cardNumberMatch[1];
  }

  // ─────────────────────────────────
  // 2. rarity 抽出
  //    card_number の直後の英字 (LR/SR/R/U/C)
  // ─────────────────────────────────
  if (result.card_number) {
    const escaped = result.card_number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rarityMatch = rawText.match(new RegExp(`${escaped}\\s+([LSCRU]R?)\\b`));
    if (rarityMatch) {
      const rawRarity = rarityMatch[1];
      const validRarities = ['LR', 'SR', 'R', 'U', 'C'];
      if (validRarities.includes(rawRarity)) {
        result.rarity = rawRarity;
      }
    }
  }

  // ─────────────────────────────────
  // 3. card_type 抽出
  //    UNIT / PILOT / COMMAND / BASE のいずれか、独立行で検出
  // ─────────────────────────────────
  const validTypes = ['UNIT', 'PILOT', 'COMMAND', 'BASE'];
  for (const type of validTypes) {
    const re = new RegExp(`(?:^|\\n)\\s*${type}\\s*(?:\\n|$)`);
    if (re.test(rawText)) {
      result.card_type = type;
      break;
    }
  }

  // ─────────────────────────────────
  // 4. level 抽出
  //    パターン: "Lv.5" / "Lv. 5" / "v. 5" (誤認識) / "レベル5"
  // ─────────────────────────────────
  const levelMatch = rawText.match(/Lv\.?\s*(\d+)|レベル\s*(\d+)|(?:^|\n)v\.\s*(\d+)/);
  if (levelMatch) {
    const lv = parseInt(levelMatch[1] || levelMatch[2] || levelMatch[3]);
    if (!isNaN(lv) && lv >= 1 && lv <= 12) {
      result.level = lv;
    }
  }

  // ─────────────────────────────────
  // 5. cost 抽出 [改善E 適用 — 2 段階フォールバック]
  //    パターン1: "4 COST" / "4 l COST" (誤認識) / "4COST"(同一/近接行)
  //    パターン2: 数字と COST が離れた行 (例: "5\nUNIT\nCOST")
  //               → COST の前 50 文字以内の独立行 1-2 桁数字のうち、最も近いものを採用
  // ─────────────────────────────────
  const costMatchInline = rawText.match(/(\d+)\s*[lI|]?\s*COST/i);
  if (costMatchInline) {
    const cost = parseInt(costMatchInline[1]);
    if (!isNaN(cost) && cost >= 0 && cost <= 12) {
      result.cost = cost;
    }
  }
  // パターン1 で未取得の場合、フォールバック (COST 前の独立行数字を探す)
  if (result.cost === null || result.cost === undefined) {
    const costIdx = rawText.search(/(?:^|\n)COST/i);
    if (costIdx >= 0) {
      const before = rawText.slice(Math.max(0, costIdx - 50), costIdx);
      const numCandidates = [...before.matchAll(/(?:^|\n)\s*(\d{1,2})\s*(?:\n|$)/g)];
      if (numCandidates.length > 0) {
        // 最後 (COST に最も近い) の数字を採用
        const lastNum = numCandidates[numCandidates.length - 1][1];
        const cost = parseInt(lastNum);
        if (!isNaN(cost) && cost >= 0 && cost <= 12) {
          result.cost = cost;
        }
      }
    }
  }

  // ─────────────────────────────────
  // 6. ap, hp 抽出 (UNIT のみ) [改善A 適用]
  //    戦略:
  //      機体型番を広く検出 (英大文字1-5字 + ハイフン + 英数字混在)。
  //      例: FA-78, MS-06, RX-78-2, ZGMF-X09A, GAT-X105, AGE-1, GN-001 等
  //      card_number(EB01-009 等) は除外。
  //      機体型番直後の「独立行 2桁数字」を全列挙し、最後の値を採用。
  //      ぞろ目以外は警告フラグを立てる(手動確認用)。
  // ─────────────────────────────────
  if (result.card_type === 'UNIT') {
    // 独立行の機体型番候補を全列挙
    const modelPattern = /(?:^|\n)([A-Z]{1,5}-[A-Z]?\d+(?:-?[A-Z]?\d*)?)\s*(?:\n|$)/g;
    const modelMatches = [...rawText.matchAll(modelPattern)];
    // card_number と同形式は除外 (EB01-009 等)
    const filteredModels = modelMatches.filter((m) => m[1] !== result.card_number);
    if (filteredModels.length > 0) {
      const modelStr = filteredModels[0][1];
      const modelEndIdx = rawText.indexOf(modelStr) + modelStr.length;
      const afterModel = rawText.slice(modelEndIdx);

      // 改行で囲まれた独立2桁数字を全て抽出
      const candidateMatches = afterModel.match(/(?:^|\n)\s*(\d{2})\s*(?:\n|$)/g) || [];
      const candidates = candidateMatches.map((m) => m.match(/(\d{2})/)[1]);
      if (candidates.length > 0) {
        // 最後の独立2桁数字を AP/HP とみなす(著作権記号の直前と推定)
        const num = candidates[candidates.length - 1];
        result.ap = parseInt(num[0]);
        result.hp = parseInt(num[1]);
        if (num[0] !== num[1]) {
          result._warning_ap_hp = `AP/HP分離: ${num} → ${num[0]}/${num[1]} (要確認)`;
        }
      }
    }
  }

  // ─────────────────────────────────
  // 6b. ap, hp 抽出 (PILOT のみ、補正値) [2026-05-24 PILOT認識改修で追加]
  //    背景:
  //      指示書37e(2026-05-17)で PILOT も補正 AP/HP 必須化されたが、
  //      Step 2 の抽出ロジックが UNIT のみで PILOT 未対応のまま残っていた
  //      → 過去事例で PILOT の ap/hp 100% null となる原因。
  //    戦略:
  //      PILOT カードはセット時の補正値 "+X+Y" 形式 (0-9 の1桁、0 含む)。
  //      OCR テキストから "+1+1" / "+1 +1" / "+1\n+1" 等のパターンを抽出。
  // ─────────────────────────────────
  if (result.card_type === 'PILOT') {
    // パターン1: 標準形式 "+X+Y" (空白・改行を許容、1桁限定)
    const pilotApHpMatch = rawText.match(/\+\s*(\d)\s*\+\s*(\d)/);
    if (pilotApHpMatch) {
      const ap = parseInt(pilotApHpMatch[1]);
      const hp = parseInt(pilotApHpMatch[2]);
      if (!isNaN(ap) && !isNaN(hp) && ap >= 0 && ap <= 9 && hp >= 0 && hp <= 9) {
        result.ap = ap;
        result.hp = hp;
      }
    }
  }

  // ─────────────────────────────────
  // 6c. ap, hp 抽出 (BASE のみ) [2026-05-24 BASE認識改修で追加]
  //    背景:
  //      指示書37c(2026-05-17、松岡さん視認 EB01-090: AP=0, HP=4)で BASE も AP 必須化
  //      しかし Step 2 抽出ロジックが UNIT/PILOT のみで BASE 未対応のまま残っていた
  //      → 過去事例で BASE の ap 100% null、hp 66.7% null となる原因。
  //    戦略:
  //      BASE には機体型番が無いため、「最後の trait () の後ろにある独立2桁数字」を抽出。
  //      著作権マーク (©SOTSU / OSOTSU) 直前が AP/HP の位置(2桁、AP+HP 連結)。
  //      実証(2026-05-24): EB01-090 rawText の "(艦船) 04" → 04 → AP=0,HP=4 で正解一致。
  //                       ST10-016 rawText の "(艦船)\n05" → 05 → AP=0,HP=5 で正解一致。
  // ─────────────────────────────────
  if (result.card_type === 'BASE') {
    // 最後の "(〇〇)" trait を探す
    const traitPattern = /\(([^()]+)\)/g;
    const traitMatches = [...rawText.matchAll(traitPattern)];
    if (traitMatches.length > 0) {
      const lastTrait = traitMatches[traitMatches.length - 1];
      const afterLastTrait = rawText.slice(lastTrait.index + lastTrait[0].length);
      // 著作権マーク (©SOTSU / OSOTSU / ©ST / OST) 直前までを対象範囲とする
      const copyrightMatch = afterLastTrait.match(/[©O](?:SOTSU|ST)/);
      const searchArea = copyrightMatch ? afterLastTrait.slice(0, copyrightMatch.index) : afterLastTrait;
      // searchArea 内の2桁数字 (AP+HP 連結) を抽出
      const numMatch = searchArea.match(/(\d{2})/);
      if (numMatch) {
        const num = numMatch[1];
        const ap = parseInt(num[0]);
        const hp = parseInt(num[1]);
        if (!isNaN(ap) && !isNaN(hp) && ap >= 0 && ap <= 9 && hp >= 0 && hp <= 9) {
          result.ap = ap;
          result.hp = hp;
        }
      }
    }
  }

  // ─────────────────────────────────
  // 7+8. link / traits 抽出 [改善D 適用 — 順序: link 先行で動的除外リスト構築]
  //    link パターン1: 「特徴 (XX)」 / 「特徴(XX)」(特徴指定リンク、EB01-044 等)
  //    link パターン2: 「カード名」(かぎ括弧、EB01-009 等)
  //    動的除外リスト: パターン1 でマッチした括弧内文字列を traits 除外に追加
  // ─────────────────────────────────
  const excludeTraits = ['EX', 'LR', 'SR', 'サンダーボルト版', '原作版', 'OVA版'];
  const dynamicExcludeTraits = [...excludeTraits];

  // link パターン1: 「特徴 (XX)」 / 「特徴(XX)」
  const characterLinkMatch = rawText.match(/特徴\s*\(([^()]+?)\)/);
  if (characterLinkMatch) {
    const inner = characterLinkMatch[1].trim();
    result.link = `特徴(${inner})`;
    // 「(耐久型)」のような括弧内文字列を traits 除外リストに追加
    dynamicExcludeTraits.push(inner);
  }

  // link パターン2: 「カード名」 形式 (パターン1 で未確定の場合)
  if (!result.link) {
    const linkMatch = rawText.match(/「([^」]+)」/);
    if (linkMatch) {
      result.link = `「${linkMatch[1]}」`;
    }
  }

  // traits 抽出: 動的除外リスト適用
  const allTraitsMatch = rawText.match(/\(([^()]+?)\)/g);
  if (allTraitsMatch) {
    const traitsList = [];
    for (const match of allTraitsMatch) {
      const inner = match.replace(/^\(|\)$/g, '').trim();
      if (
        !dynamicExcludeTraits.includes(inner) &&
        inner.length >= 1 &&
        inner.length <= 10 &&
        // 数字のみ・拡張パック名等の明らかなノイズを除外
        !/^\d+$/.test(inner)
      ) {
        traitsList.push(`〔${inner}〕`);
      }
    }
    if (traitsList.length > 0) {
      result.traits = traitsList;
    }
  }

  // ─────────────────────────────────
  // 9. card_name 抽出
  //    優先1: 「(EX)」「(LR)」等の特殊サフィックスを含む独立行
  //    優先2: 機体型番(FA-/MS-/RX-/RGM-/MSN-)直前の独立行
  // ─────────────────────────────────
  const noiseList = [
    'GUNDAM',
    'GUNDAM™',
    'CARD GAME',
    'Extra Booster Pack',
    'Eternal Nexus',
    'エターナル ネクサス',
  ];
  const nameWithSuffixMatch = rawText.match(
    /(?:^|\n)([^\n]+?\((?:EX|LR|SR|サンダーボルト版|原作版|OVA版)\)[^\n]*)(?:\n|$)/
  );
  if (nameWithSuffixMatch) {
    result.card_name = nameWithSuffixMatch[1].trim();
  } else {
    const nameBeforeModelMatch = rawText.match(
      /(?:^|\n)([^\n]+)\n(?:FA-\d+|MS-\d+|RX-\d+|RGM-\d+|MSN-\d+)/
    );
    if (nameBeforeModelMatch) {
      const candidate = nameBeforeModelMatch[1].trim();
      if (!noiseList.includes(candidate) && candidate.length >= 2) {
        result.card_name = candidate;
      }
    }
  }

  // ─────────────────────────────────
  // 10. effect 抽出 [改善C 適用]
  //     タイミングキーワード + キーワード能力を全て候補に。
  //     最も早く出現するキーワードから effect を抽出 (《ブロッカー》誤認識で消失するケース対応)。
  //     終端: 全XX / 地球 / 宇宙 / 著作権記号 / 括弧 / 数字 / 「 / 特徴 のいずれかで始まる行
  // ─────────────────────────────────
  // effectKeywords 配列(GCG 公式準拠、2026-05-11 松岡さん教示で確定、指示書28-Rev1)
  // タイミング10個 + キーワード能力7個 = 合計17要素
  // 注: 以下は GCG に存在しないため絶対に含めない: 配備(時なし)、ターン1回、ペアリング、クイック
  const effectKeywords = [
    // === タイミングキーワード(10個、GCG 公式) ===
    '配備時',     // 配備された瞬間に発動
    '起動',       // 起動条件で発動
    'アタック時', // アタックを行った時に発動
    'アタック中', // アタック中継続発動
    '破壊時',     // 破壊された時に発動
    'セット時',   // パイロットセット時に発動
    'セット中',   // パイロットセット中継続発動
    'リンク時',   // リンク条件を満たしてセットされた時に発動
    'リンク中',   // リンク条件を満たしてセット中継続発動
    'バースト',   // シールド破壊時の追加効果
    // === キーワード効果(7個、GCG 公式) ===
    'ブロッカー', // アタック対象を自身に変更
    '制圧',       // シールドエリア2枚破壊(ベースがあればベースのみ)
    '突破',       // バトル勝利時にシールドへ数値ダメージ
    '援護',       // アクティブをレストで指定ユニットのAP上昇
    'リペア',     // ターン終了時に数値分回復
    '先制攻撃',   // 相手より先にダメージ計算
    '高機動',     // シールドエリアアタック時のブロッカー無効化
  ];
  let effectText = null;
  let earliestPos = Infinity;
  for (const kw of effectKeywords) {
    const re = new RegExp(
      `(?:^|\\n)(${kw}[\\s\\S]*?)(?=\\n(?:全\\d+|地球|宇宙|©|ⓒ|\\(|\\d+|「|特徴)|$)`
    );
    const m = rawText.match(re);
    if (m) {
      const pos = rawText.indexOf(m[0]);
      if (pos < earliestPos) {
        earliestPos = pos;
        effectText = m[1].replace(/\n+/g, '').replace(/\s+/g, ' ').trim();
      }
    }
  }
  if (effectText) {
    result.effect = effectText;
  }

  // ─────────────────────────────────
  // 11. expansion 抽出
  //     パターン: EB01 / GD04 / ST01 等
  // ─────────────────────────────────
  const expansionMatch = rawText.match(/\b(EB\d{2}|GD\d{2}|ST\d{2})\b/);
  if (expansionMatch) {
    result.expansion = expansionMatch[1];
  }

  // ─────────────────────────────────
  // 12. release_date 抽出 [改善B 適用]
  //     パターン: "2026.6.27 on sale" / "2026.6.27 onosale"(誤認識) /
  //               単独 "2026.6.27" でも対応。
  //     年は 20XX 始まり(2020-2099)に限定 → "2.6.27" 等の短縮形誤認識を除外。
  //     月日の妥当性チェック (1-12 / 1-31) も実施。
  // ─────────────────────────────────
  const releaseDateMatch = rawText.match(/(20\d{2})\.(\d{1,2})\.(\d{1,2})/);
  if (releaseDateMatch) {
    const yyyy = releaseDateMatch[1];
    const mm = releaseDateMatch[2].padStart(2, '0');
    const dd = releaseDateMatch[3].padStart(2, '0');
    const m = parseInt(mm),
      d = parseInt(dd);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      result.release_date = `${yyyy}-${mm}-${dd}`;
    }
  }

  return result;
}

// === Step 3: Claude API による構造化 (指示書24) ===
// Step 2 の結果(正規表現抽出済) + _rawText を渡し、
// OCR 誤認識・数字連結問題・null フィールドを Claude の文脈理解で補正する。
//
// 重要な前提:
// - 2026-05-24 マルチモーダル化(認識精度改修 案件1): 画像も Claude に渡し
//   OCR で読めない Lv 等を画像から直接抽出可能にした(imageBase64 オプション)
// - color は Claude が触らない (改善F の領域、Step 1-B のみが管轄)
// - エラー時は step2Result をそのまま返す (品質保証)
function detectImageMediaType(base64) {
  // base64 先頭から magic bytes を検出して media_type を決定
  // 失敗時は image/jpeg をフォールバック
  try {
    const buf = Buffer.from(base64.slice(0, 24), 'base64');
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  } catch (_) { /* fallthrough */ }
  return 'image/jpeg';
}

async function structureCardWithClaude(rawText, step2Result, imageBase64 = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[Step 3] ANTHROPIC_API_KEY 未設定、スキップ');
    return step2Result;
  }

  const hasImage = !!imageBase64 && typeof imageBase64 === 'string' && imageBase64.length > 0;

  const systemPrompt = `あなたはガンダムカードゲーム(GCG)のカード画像から OCR で抽出したテキストを、構造化された JSON データに変換する専門家です。

**重要な前提**:
${hasImage
  ? '- カード画像と OCR テキスト(_rawText)の両方が渡されます\n- OCR テキストで読み取れない値(特に PILOT カードの Lv、薄い数字、小さい文字)は **画像から直接抽出** してください\n- ただし画像認識の捏造は厳禁。画像で明確に読み取れない場合は null とし、_corrections に「画像でも読取不能」と記載'
  : '- 画像は見えません。OCR テキスト(_rawText)のみが渡されます'}
- Step 2 で正規表現抽出した結果(step2Result)が渡されます
- あなたの役割は OCR 誤認識・数字連結問題・抽出漏れを補正することです

**OCR 誤認識の典型例**:
- "RO" は "LR"(レジェンドレア)の誤認識(L→? R→O)
- "Lv.5" の後の独立 "23" は "2 3"(Lv2 + 3 COST? いや Lv5 だから 3 COST のみ)の誤連結
- "Lv6 + 5 COST" → "15" のように連結
- "ニッ\\nト" → "ニット" のような行分割
- 中黒「・」が消失することがある

**カードの構造**:
- card_number: EB01-044, ST10-006 等
- card_name: ガンダム名 + (バリアント) + (EX/LR等のサフィックス)
- rarity: LR / SR / R / U / C のいずれか
- card_type: UNIT / PILOT / COMMAND / BASE
- level: 1-12 の整数
- cost: 0-12 の整数
- ap: UNIT は通常 AP(0-9)、PILOT は補正AP(セット時の増分、0 含む 0-9)、BASE は通常 AP(0 含む 0-9、指示書37c により BASE も AP 必須化)、COMMAND は null
- hp: UNIT は通常 HP(0-9)、PILOT は補正HP(セット時の増分、0 含む 0-9)、BASE は通常 HP(0-9)、COMMAND は null
- traits: 〔ジージェネ〕等。card_name 内の括弧(能力解放、サンダーボルト版等)は traits ではない
- link: 「カード名」または 特徴(XX) 形式
- effect: 効果テキスト全文(改行除去、整形済)
- **terrain: 出力対象外**(松岡さんの判断により、記事生成で使用しないため Step 3 では補完しない)

**GCG カードタイプ(5種類、公式定義)**:
- UNIT(ユニット): バトルエリアに配備、AP/HP を持つ
- PILOT(パイロット): ユニットにセットして強化
- COMMAND(コマンド): 一時的効果を発動、使い切り
- BASE(ベース): シールド前に配置、守りの要
- リソース: リソースデッキで使用、配備コスト

**GCG キーワード効果(7種類、正式定義、これ以外は GCG に存在しない)**:
カードの effect テキスト内に以下のキーワード効果が出現する場合があります。これらは GCG 公式で定義された効果であり、効果の意味を正確に保持してください。
- 《ブロッカー》: アタック対象を自身に変更可能(身代わり)
- 《制圧》: シールドエリアへのアタック時、通常1枚破壊のところを2枚破壊できる。ただしベースがある場合はベースのみ通常アタック(シールドには影響なし)
- 《突破(数値)》: バトル勝利時に相手シールドへ数値分ダメージ
- 《援護(数値)》: このユニットがアクティブの時、レストにすることで自分のターン中に指定ユニットの AP を数値分上昇
- 《リペア(数値)》: 自分のターン終了時にユニットを数値分回復
- 《先制攻撃》: 相手より先にダメージ計算
- 《高機動》: シールドエリアアタック時に相手のブロッカー発動を無効化
**重要**: 上記以外のキーワード効果(例: 「クイック」「ペアリング」)は GCG に存在しません。effect テキスト内に存在しないキーワードが現れても、それは OCR 誤認識として扱い、捏造しないでください。

**GCG タイミングキーワード(10種類、正式定義、2026-05-11 松岡さん教示)**:
effect テキスト内に【〇〇】の形式で発動タイミングが指定される場合があります。GCG 公式で定義されたタイミングキーワードは以下の10種類のみです。
- 【配備時】: 配備された瞬間
- 【起動】: 起動条件で発動
- 【アタック時】: アタックを行った時
- 【アタック中】: アタック中継続発動
- 【破壊時】: 破壊された時
- 【セット時】: パイロットセット時
- 【セット中】: パイロットセット中継続
- 【リンク時】: リンク条件を満たしてセットされた時
- 【リンク中】: リンク条件を満たしてセット中継続
- 【バースト】: シールド破壊時の追加効果
**注意事項**:
- 「リンク時/中」は「セット時/中」と関連します。リンク条件を満たすパイロットをセットすると、通常の「セット」が「リンク」に名称変更されます
- 「ターン1回」「ターン2回」等は発動回数の指定であり、タイミングキーワードではありません
- 「配備」(時なし)、「ペアリング」は GCG に存在しません

**GCG 戦闘フォーマット(4種類)**:
GCG には複数の対戦形式が存在します。効果テキストの解釈時に必要に応じて考慮してください。
- 通常戦(2人): デッキ50枚、シールド6枚
- チーム戦(2対2): シールドはチーム共有、デッキは各自50枚
- バトルロワイヤル(3人以上): 全員が対戦相手、勝ち抜け/負け抜けの2ルール
- シールド戦(2人): パック開封のみで構築、特殊フォーマット
**重要**: 「相手プレイヤーすべて」のような表記は多人数戦(チーム戦・バトロワ)を想定しています。1対1戦のみを前提とした解釈を行わないでください。

**GCG 効果テキスト記号(原文の通り保持してください)**:
effect テキスト内に以下の記号が出現します。これらは特定の意味を持つため、構造化処理で省略・変更しないでください。
- 〔〇〇〕: 特徴(ジージェネ、地球連邦軍等)
- 『〇〇』: カード名指定
- 《〇〇》: キーワード効果(本指示書の7種類のみ)
- 【〇〇】: 発動タイミング(本指示書の10種類のみ)
- (): 注釈文(キーワード効果の解説等)

**GCG 用語の正誤(誤用厳禁)**:
- 「捨て札」→ 正しくは「トラッシュ」
- 「シールドゾーン」→ 正しくは「シールドエリア」
- 「キャラクター」「モビルスーツ」→ カードゲームの文脈では「UNIT」
- 「クイック」「ペアリング」「配備」(時なし)「ターン1回」(タイミング扱い) → 存在しない、使用禁止

**出力形式(必ず JSON のみ、コード ブロック不要)**:
{
  "card_number": "...",
  "card_name": "...",
  "rarity": "...",
  "card_type": "...",
  "level": 5,
  "cost": 3,
  "ap": 4,
  "hp": 4,
  "traits": ["〔ジージェネ〕"],
  "link": "「マーク・ギルダー」",
  "effect": "...",
  "expansion": "...",
  "release_date": "2026-06-27",
  "_corrections": ["LR を RO 誤認識から補正", "level=5(OCR連結 23 から分離)"]
}

**ルール**:
1. step2Result で取得済の値は基本的にそのまま使用
2. null フィールドのみ補完(_rawText から読み取れる場合)
3. 明らかな誤抽出(traits に card_name 内括弧が含まれる等)は修正
4. 不明なフィールドは null のまま
5. _corrections に補正内容を簡潔に記載(デバッグ用)
6. 推測で値を捏造しない(根拠が _rawText にない場合は null)
7. **terrain フィールドは出力に含めない**(対象外、step2Result の terrain[] は維持される)`;

  const userPrompt = `${hasImage ? 'カード画像と ' : ''}OCR 認識テキストと Step 2 結果から、構造化された JSON を出力してください。

## _rawText (Vision AI 認識テキスト)
\`\`\`
${rawText}
\`\`\`

## Step 2 結果(正規表現抽出)
\`\`\`json
${JSON.stringify(step2Result, null, 2)}
\`\`\`

${hasImage ? '画像で明確に確認できる値(特に level, cost, ap, hp 等の数値)は画像を優先してください。\n' : ''}JSON のみで回答してください(マークダウンコードブロック等は不要)。`;

  // マルチモーダル: imageBase64 があれば画像 block + テキスト block の配列で渡す
  const userContent = hasImage
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: detectImageMediaType(imageBase64),
            data: imageBase64,
          },
        },
        { type: 'text', text: userPrompt },
      ]
    : userPrompt;

  const data = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (res.statusCode !== 200) {
              console.warn('[Step 3] Anthropic API エラー:', res.statusCode, JSON.stringify(body).slice(0, 300));
              resolve(step2Result);
              return;
            }
            const content = body.content?.[0]?.text || '';
            const cleanedContent = content.replace(/```json|```/g, '').trim();
            let structured;
            try {
              structured = JSON.parse(cleanedContent);
            } catch (e) {
              console.warn('[Step 3] Claude のレスポンスを JSON パースできず:', e.message);
              console.warn('[Step 3] Content preview:', cleanedContent.slice(0, 500));
              resolve(step2Result);
              return;
            }
            // step2Result の _rawText / _blocks / color / _warning_ap_hp は維持
            const merged = {
              ...step2Result,
              ...structured,
              _rawText: step2Result._rawText,
              _blocks: step2Result._blocks,
              color: step2Result.color, // 色は Step 1-B のみが管轄
            };
            if (step2Result._warning_ap_hp) merged._warning_ap_hp = step2Result._warning_ap_hp;
            // Step 3 の補正内容ログ
            if (structured._corrections && structured._corrections.length > 0) {
              console.log('[Step 3] 補正内容:');
              structured._corrections.forEach((c) => console.log(`  - ${c}`));
            }
            // usage 情報も簡易ログ(課金監視)
            if (body.usage) {
              console.log(`[Step 3] usage: input=${body.usage.input_tokens} / output=${body.usage.output_tokens}`);
            }
            resolve(merged);
          } catch (e) {
            console.warn('[Step 3] レスポンス処理エラー:', e.message);
            resolve(step2Result);
          }
        });
      }
    );
    req.on('error', (e) => {
      console.warn('[Step 3] HTTPS エラー:', e.message);
      resolve(step2Result);
    });
    req.write(data);
    req.end();
  });
}

// === 引数解析 ===
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const imagePath = getArg('--image');
const fromRecognition = getArg('--from-recognition'); // 指示書27 Phase 2: 既存 recognition.json から記事生成
const outputDir = getArg('--output-dir') || path.resolve(__dirname, '..', 'tmp', 'manual-news');
const isDryRun = hasFlag('--dry-run');
const noArticle = hasFlag('--no-article');

// 注: 引数バリデーションは指示書30 (batch-recognize.js) との連携のため、
// ファイル末尾の `if (require.main === module)` ガード内に移動済(2026-05-14)。
// このセクションのトップレベル const 宣言は require 時にも評価されるが、
// バリデーションは CLI 直接実行時のみ走る。

// === ユーティリティ ===
function logSection(title) {
  console.log(`\n[${title}]`);
}

function safeStringify(obj, maxLen = 2000) {
  try {
    const s = JSON.stringify(obj, null, 2);
    return s.length > maxLen ? s.slice(0, maxLen) + '\n...(truncated)' : s;
  } catch (e) {
    return `(stringify failed: ${e.message})`;
  }
}

// === メイン処理 ===
async function main() {
  const startTime = Date.now();
  console.log('=== manual-card-news 開始 ===');

  // === モード判定 (指示書27 Phase 2) ===
  if (fromRecognition) {
    console.log(`モード: 既存 recognition.json から記事生成`);
    console.log(`入力: ${fromRecognition}`);
  } else {
    console.log(`モード: 画像から認識 + 記事生成`);
    console.log(`画像: ${imagePath}`);
  }
  console.log(`出力先: ${outputDir}`);
  console.log(`Dry-run: ${isDryRun}`);
  console.log(`記事生成: ${noArticle ? 'スキップ (--no-article)' : '実施'}`);

  // 出力ディレクトリ準備
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`出力ディレクトリを作成: ${outputDir}`);
  }

  // 記事生成への入力データ (両モード共通の最終形)
  //   - モードA: 既存 recognition.json の cards をそのまま使用
  //   - モードB: 画像認識 (Step 1-A〜Step 3) を経た finalList を使用
  let finalCardsForArticle;
  let recognitionPath;
  let sourceImagePath; // article-data.json に記録するソース情報

  if (fromRecognition) {
    // === モードA: 既存 recognition.json から読み込み (記事生成のみ実施) ===
    logSection('Step 0: 既存 recognition.json 読み込み');
    let recognitionData;
    try {
      recognitionData = JSON.parse(fs.readFileSync(fromRecognition, 'utf-8'));
    } catch (e) {
      console.error(`ERROR: recognition.json のパースに失敗: ${e.message}`);
      process.exit(2);
    }
    finalCardsForArticle = recognitionData.cards || [];
    recognitionPath = fromRecognition;
    sourceImagePath = recognitionData.sourceImage || '(unknown)';
    console.log(`  読み込み完了: ${finalCardsForArticle.length} 件`);
    console.log(`  元画像: ${sourceImagePath}`);
    if (finalCardsForArticle[0]?._corrections) {
      console.log(`  補正履歴: ${finalCardsForArticle[0]._corrections.length} 件`);
      finalCardsForArticle[0]._corrections.forEach((c) => console.log(`    - ${c}`));
    }
    // モードA では記事生成セクションへ直行 (画像認識フローはスキップ)
  } else {
    // === モードB: 画像から認識 (従来通り Step 1-A〜Step 3) ===
    sourceImagePath = imagePath;

    // 画像を base64 化
    const imageBuffer = fs.readFileSync(imagePath);
    const imageBase64 = imageBuffer.toString('base64');
    console.log(`画像サイズ: ${imageBuffer.length} bytes (base64長: ${imageBase64.length})`);

  // auto-news.js の関数は { base64: string } オブジェクトの配列を期待する
  const imageBase64List = [{ base64: imageBase64 }];

  // === Step 1-A v2: Vision AI 文字認識 (DOCUMENT_TEXT_DETECTION + 日本語ヒント) ===
  // 指示書21: auto-news.js の step1A_visionOCR は使用せず、callVisionAIv2 を独自呼び出し
  logSection('Step 1-A v2: DOCUMENT_TEXT_DETECTION で認識中');
  const visionResults = [];
  for (const { base64 } of imageBase64List) {
    const visionResponse = await callVisionAIv2(base64, true);
    const fta = visionResponse.responses?.[0]?.fullTextAnnotation;

    if (!fta) {
      console.warn('  [警告] fullTextAnnotation が空');
      visionResults.push(null);
      continue;
    }

    const fullText = fta.text || '';
    const blockCount = fta.pages?.[0]?.blocks?.length || 0;
    console.log(`  [Step 1-A v2] 認識テキスト長: ${fullText.length}文字 / ブロック数: ${blockCount}`);

    // Step 2 (postProcessVisionResultV2) で _rawText から正規表現で補正抽出する想定。
    // 既存 step1A_visionOCR の出力形式(card_number 等)に合わせて空オブジェクトを構築。
    visionResults.push({
      _rawText: fullText,
      _blocks: blockCount,
      card_number: null,
      card_name: null,
      rarity: null,
      card_type: null,
      level: null,
      cost: null,
      ap: null,
      hp: null,
      terrain: [],
      traits: [],
      link: null,
      effect: null,
    });
  }
  console.log('Vision結果 (1件目):', safeStringify(visionResults[0], 1500));

  // === Step 1-B: ピクセル色判定 (sharp) ===
  logSection('Step 1-B: ピクセル色判定');
  const colorResults = await step1B_pixelColorDetection(imageBase64List);
  console.log('色判定結果:', colorResults);

  // === Step 1-C: マージ (Vision text + 色) ===
  logSection('Step 1-C: マージ');
  const mergedList = [];
  for (let i = 0; i < imageBase64List.length; i++) {
    const merged = step1C_merge(visionResults[i], colorResults[i]);
    mergedList.push(merged);
    console.log(`画像 ${i + 1} マージ結果:`, safeStringify(merged, 2000));
  }

  // === Step 2: 後処理 (postProcessVisionResultV2) ===
  // _rawText から正規表現で各フィールドを抽出・補完。terrain は対象外。
  logSection('Step 2: 後処理 (postProcessVisionResultV2)');
  const postProcessedList = mergedList.map((merged, i) => {
    if (!merged) return merged;
    const rawText = visionResults[i]?._rawText || '';
    const processed = postProcessVisionResultV2(rawText, merged);
    console.log(`画像 ${i + 1} 後処理結果:`, safeStringify(processed, 2500));
    return processed;
  });

  // === Step 3: Claude API による構造化 (指示書24) ===
  // Step 2 結果 + _rawText を Anthropic API に渡し、文脈理解で OCR 誤認識・null を補正。
  // Claude には画像を渡さない (Vision AI の役割を尊重)。color は Claude が触らない。
  logSection('Step 3: Claude API 構造化');
  const finalList = [];
  for (let i = 0; i < postProcessedList.length; i++) {
    const step2Result = postProcessedList[i];
    if (!step2Result) {
      finalList.push(step2Result);
      continue;
    }
    const rawText = visionResults[i]?._rawText || '';
    console.log(`画像 ${i + 1} Step 3 構造化中 (Claude API, マルチモーダル)...`);
    // 2026-05-24 マルチモーダル化: 画像も Claude に渡し、OCR で読めない Lv 等を補完
    const step3Result = await structureCardWithClaude(rawText, step2Result, imageBase64List[i]?.base64);
    console.log(`画像 ${i + 1} Step 3 結果:`, safeStringify(step3Result, 2500));
    finalList.push(step3Result);
  }

    // 認識結果を JSON 出力 (常に実施)
    recognitionPath = path.join(outputDir, 'recognition.json');
    fs.writeFileSync(
      recognitionPath,
      JSON.stringify(
        {
          sourceImage: imagePath,
          recognizedAt: new Date().toISOString(),
          cards: finalList,
        },
        null,
        2
      ),
      'utf-8'
    );
    console.log(`\n認識結果を保存: ${recognitionPath}`);

    // モードB の最終結果を共通変数へ
    finalCardsForArticle = finalList;

    if (noArticle) {
      console.log('\n--no-article 指定のため、記事生成はスキップして終了します');
      console.log(`認識結果ファイル: ${recognitionPath}`);
      console.log(`実行時間: ${(Date.now() - startTime) / 1000}秒`);
      return;
    }
  } // === モードB 終了 ===

  // === ここから両モード共通: 記事生成 ===
  // 認識結果が空なら記事生成を中止
  const validCards = finalCardsForArticle.filter((c) => c && c.card_number);
  if (validCards.length === 0) {
    console.error('\nERROR: 認識結果に有効な card_number がありません。記事生成を中止します。');
    console.error('対処: 認識精度を確認するか、--no-article で再実行してください。');
    process.exit(2);
  }

  // === Step 1.5: cards_master 読込 (照合に使用) ===
  logSection('Step 1.5: cards_master.json 照合');
  const cardsMaster = loadCardsMaster();
  const summary = loadSummary();
  const cardsPreview = loadCardsPreview();
  const unifiedDB = buildUnifiedCardDB(cardsMaster);
  console.log(
    `cards_master: ${Object.keys(cardsMaster).length} 件 / summary: ${
      summary && summary.card_ranking ? summary.card_ranking.length : 0
    } 件 / cards_preview: ${Object.keys(cardsPreview).length} 件 / unified: ${
      Object.keys(unifiedDB).length
    } 件`
  );

  // === Step 2: 記事生成 (Anthropic API: Sonnet + Opus) ===
  logSection('Step 2: 記事生成 (Anthropic API)');

  // cardInfoList は merged をそのまま使う (card_name/card_number/color/card_type を持つ)
  const cardInfoList = validCards;

  // 記事日付 (JST)
  const now = new Date();
  const jstStr = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let introText = null;
  let cardAnalyses = null;
  let errors = [];

  try {
    console.log('  リード文生成中 (Sonnet)...');
    introText = await generateIntroText(cardInfoList, [], jstStr);
    console.log('  ✓ リード文生成完了');
  } catch (e) {
    console.error('  ✗ リード文生成エラー:', e.message);
    errors.push({ step: 'generateIntroText', error: e.message });
  }

  try {
    console.log('  カード分析生成中 (Opus)...');
    cardAnalyses = await generateCardAnalyses(cardInfoList, []);
    console.log('  ✓ カード分析生成完了');
  } catch (e) {
    console.error('  ✗ カード分析生成エラー:', e.message);
    errors.push({ step: 'generateCardAnalyses', error: e.message });
  }

  // === 結果を JSON 出力 ===
  const articleData = {
    sourceImage: sourceImagePath, // 指示書27: モードA は recognition.sourceImage、モードB は imagePath
    sourceRecognition: fromRecognition || null, // モードAのみセット
    generatedAt: new Date().toISOString(),
    articleDate: jstStr,
    cards: cardInfoList,
    introText,
    cardAnalyses,
    errors: errors.length > 0 ? errors : undefined,
  };

  const articlePath = path.join(outputDir, 'article-data.json');
  fs.writeFileSync(articlePath, JSON.stringify(articleData, null, 2), 'utf-8');
  console.log(`\n記事データを保存: ${articlePath}`);

  if (errors.length > 0) {
    console.warn(`\n⚠ ${errors.length} 件のエラーが発生しました (記事データ内 errors フィールド参照)`);
  }

  console.log('\n=== manual-card-news 完了 ===');
  console.log(`実行時間: ${(Date.now() - startTime) / 1000}秒`);
  console.log(`出力先: ${outputDir}`);
  console.log(`  - recognition.json: ${recognitionPath}`);
  console.log(`  - article-data.json: ${articlePath}`);
}

// === Module exports for reuse (指示書30 batch-recognize.js から再利用するため、2026-05-14 追加) ===
// 直接実行時(CLI)は main() が走るが、require 時はガード内をスキップして関数のみ export
module.exports = {
  callVisionAIv2,
  postProcessVisionResultV2,
  structureCardWithClaude,
  detectImageMediaType,
};


// === CLI 直接実行時のみ バリデーション + main 起動 ===
if (require.main === module) {
  // --image または --from-recognition のいずれかが必須
  if (!imagePath && !fromRecognition) {
    console.error('ERROR: --image <path> または --from-recognition <path> が必要です');
    console.error('Usage:');
    console.error('  認識から記事生成:     node scripts/manual-card-news.js --image <path>');
    console.error('  認識のみ:             node scripts/manual-card-news.js --image <path> --no-article');
    console.error('  既存認識から記事生成: node scripts/manual-card-news.js --from-recognition <path>');
    process.exit(1);
  }

  // --image と --from-recognition の同時指定は不可
  if (imagePath && fromRecognition) {
    console.error('ERROR: --image と --from-recognition は同時に指定できません');
    process.exit(1);
  }

  // --from-recognition と --no-article の同時指定は無意味
  if (fromRecognition && noArticle) {
    console.error('ERROR: --from-recognition は記事生成のための専用オプションです(--no-article は不要)');
    process.exit(1);
  }

  // 入力ファイルの存在チェック
  if (imagePath && !fs.existsSync(imagePath)) {
    console.error(`ERROR: 画像ファイルが見つかりません: ${imagePath}`);
    process.exit(1);
  }

  if (fromRecognition && !fs.existsSync(fromRecognition)) {
    console.error(`ERROR: recognition.json が見つかりません: ${fromRecognition}`);
    process.exit(1);
  }

  main().catch((e) => {
    console.error('\n致命的エラー:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
