# AIプロンプト設計 — Ledger Lines

| 項目 | 内容 |
|---|---|
| ドキュメントID | DESIGN-AI |
| バージョン | 0.1（M3 ドラフト） |
| 最終更新 | 2026-07-25 |
| 基盤 | Microsoft Foundry (Azure AI Foundry) |

---

## 1. 設計方針

### 1.1 最大のリスク

> **分析結果と矛盾する講評を、自信を持って提示すること。**

「19小節のテンポが不安定」と分析が出しているのに、講評が「テンポは終始安定していました」と言えば、
ユーザーは即座にプロダクト全体を信用しなくなる。**1回の矛盾が全体の信頼を破壊する。**

したがって、LLM の役割を厳密に限定する。

| LLM がやること | LLM がやらないこと |
|---|---|
| 数値を**言葉に翻訳**する | 数値を**判断**する（良い/悪いの閾値判定は決定的なコードが行う） |
| 原因の**仮説**を立てる | 事実を作る |
| 練習法を**提案**する | スコアを付ける |
| 音楽的文脈を補う | データにない小節に言及する |

### 1.2 3つの防御層

```
第1層: 入力の制約  … 信頼度の低いデータを渡さない。判断済みのラベルを渡す
第2層: 出力の構造化 … JSON Schema による Structured Outputs で形式を保証
第3層: 出力の検証  … 生成後に機械的に事実照合し、違反したフィールドを除去/再生成
```

第3層は [パイプライン設計 9.4](./analysis-pipeline.md#94-出力の自動検証) に対応する。

### 1.3 モデル選定

| 用途 | 要件 | 選定 |
|---|---|---|
| 講評生成 (A) | 構造化出力、日本語の自然さ、音楽知識、1回/テイク | 高性能モデル（GPT-5系相当）。品質優先 |
| 指摘の詳細文 (B) | 短文を多数生成。低レイテンシ | 中位モデル。講評と同一呼び出しに統合してコスト削減 |
| チャット (C) | 対話、低レイテンシ、ストリーミング | 中位モデル |
| 停滞小節の診断 (D) | 深い推論 | 高性能モデル（頻度が低いので許容） |

> モデル名を仕様に固定しない。`promptVersion` と `model` をテイクに記録し、
> 差し替え可能にする。評価セット（[6章](#6-評価)）で品質を継続測定する。

---

## 2. コンテキスト設計

### 2.1 渡すデータの構造

LLM に渡すのは**要約された構造化データ**であり、生の分析結果ではない。

```jsonc
{
  "song": {
    "title": "ワルツ 第7番 嬰ハ短調 Op.64-2",
    "composer": "F. Chopin",
    "period": "romantic",
    "keySignature": "cis minor",
    "timeSignature": "3/4",
    "targetTempo": 132,
    "status": "practicing",
    "goal": { "date": "2026-09-13", "daysLeft": 51, "description": "発表会で演奏する" }
  },

  "take": {
    "label": "テイク4（通し）",
    "recordedAt": "2026-07-24",
    "playedMeasureRange": [1, 32],
    "actualTempo": 126,
    "overallScore": 81.4,
    "metrics": {
      "pitch": 81.2, "rhythm": 81.2, "tempo": 82.2,
      "dynamics": 78.3, "articulation": 79.6
    },
    "metricsNotEvaluated": { "pedal": "楽譜にペダル記号がないため評価対象外" },
    "dynamicRangeRatio": 0.62
  },

  // ── 判断済みのラベル（LLMに判断させない）─────────────
  "assessment": {
    "overallLevel": "good",              // excellent|good|fair|needs-work
    "strongestMetric": "tempo",
    "weakestMetric": "dynamics",
    "trend": "improving"                 // improving|stable|declining
  },

  "weakestMeasures": [                   // 上位5小節のみ
    { "measure": 19, "scoreMeasure": 19, "score": 48.2,
      "worstMetric": "rhythm",
      "metrics": { "pitch": 62, "rhythm": 41, "tempo": 55, "dynamics": 52, "articulation": 58 } },
    { "measure": 20, "score": 49.6, "worstMetric": "rhythm", "metrics": { ... } }
  ],

  "issues": [                            // severity high/medium のみ、最大10件
    { "id": "iss_1", "measures": [19, 20], "beat": 2, "type": "timing",
      "severity": "high",
      "title": "19-20小節：右手が左手より平均38ms遅れています",
      "evidence": { "meanOnsetErrorSec": 0.038, "affectedNotes": 6 } }
  ],

  "history": {
    "takeCount": 4,
    "scoreTrend": [62.9, 70.7, 76.1, 81.4],
    "metricTrends": { "pitch": [61,69,75,81], "dynamics": [57,63,71,78], ... },
    "improvedMeasures": [3, 7, 12, 25],
    "stagnantMeasures": [
      { "measure": 19, "scores": [46.1, 47.0, 47.8, 48.2], "worstMetric": "rhythm" },
      { "measure": 20, "scores": [47.2, 48.0, 49.1, 49.6], "worstMetric": "rhythm" }
    ],
    "regressedMeasures": []
  },

  "previousMenu": [                      // 前回提案した練習メニューの消化状況
    { "title": "19-20小節をゆっくり", "measures": [19,20], "completed": true }
  ],

  "constraints": {
    "dailyPracticeMinutes": 30,
    "excludedMeasures": [28, 29]         // 信頼度が低く評価保留した小節
  }
}
```

### 2.2 設計上の要点

| 要点 | 理由 |
|---|---|
| **`assessment` で判断済みのラベルを渡す** | 「81点は良いのか」の判断をLLMにさせない。閾値はコードが持つ |
| **`weakestMeasures` は上位5件だけ** | 全300小節を渡すとトークンを浪費し、注意が散る |
| **`excludedMeasures` を明示** | 「この小節には言及するな」を明示的に伝える |
| **`stagnantMeasures` にスコア履歴を含める** | 「4回やっても48点のまま」という事実を数値で示すことで、通常と違う提案を促す |
| **`previousMenu` の消化状況を渡す** | 「前回の練習が効いた/効かなかった」を踏まえた提案ができる |
| **生のピアノロールや全小節スコアは渡さない** | トークン効率と、ハルシネーションの温床を減らすため |

### 2.3 トークン見積もり

| 項目 | トークン |
|---|---|
| システムプロンプト | 約 700 |
| コンテキストJSON | 約 1,200 |
| 出力 | 約 1,000 |
| **合計** | **約 2,900 / テイク** |

1,000MAU × 月20テイク = 20,000回/月 → 約 5,800万トークン/月。
コスト試算は [アーキテクチャ設計](./architecture.md) 参照。

---

## 3. プロンプト A: テイク講評

### 3.1 システムプロンプト

```
あなたは経験豊富なピアノ指導者です。生徒が録音した演奏の自動分析結果を受け取り、
次の練習につながるフィードバックを日本語で作成します。

## あなたの立場
- 生徒は真剣に練習しています。点数を告げる採点者ではなく、隣で見ている指導者として話してください。
- 分析は自動処理によるものです。あなたの役割は数値を音楽的な言葉に翻訳し、
  原因の仮説を立て、次にやるべきことを示すことです。

## 絶対に守るルール
1. 入力データに存在しない事実を述べてはいけません。
   - 指定された小節番号以外に言及しない
   - excludedMeasures に含まれる小節には一切言及しない
   - metricsNotEvaluated にある指標について評価しない
2. 数値を書くときは、入力データの値をそのまま使ってください。丸める場合は小数第1位までです。
3. assessment の判断（overallLevel, trend）と矛盾する評価をしないでください。
   例: trend が "improving" のとき「進歩が見られません」とは書かない。
4. 断定できないことは「〜と考えられます」「〜の可能性があります」と書いてください。
   原因の推定は仮説であり、事実ではありません。
5. 演奏者の人格や才能について述べないでください。演奏という行為だけを扱います。

## 文体
- 敬体（です・ます）。
- 専門用語は使ってよいですが、初めて出るときは短く補足してください。
- 褒めるときも具体的に。「良かったです」ではなく「17-24小節の左手のワルツ伴奏が、
  前回より均等になっています」のように、どこが何が良いのかを書いてください。
- 一文を長くしすぎないでください。

## 練習メニューの作り方
- 「もう一度通す」は提案しないでください。それは生徒が既にやっていることです。
- 対象小節を必ず絞ってください。曲全体を対象にしないでください。
- 練習テンポは、その箇所の弱さに応じて目標テンポの 50〜90% の範囲で指定してください。
- 練習法は手順として書いてください。何をどう弾くかが分かるように。
- 合計時間が constraints.dailyPracticeMinutes に収まるようにしてください。
- stagnantMeasures がある場合、その小節には
  「これまでと違うアプローチ」を必ず1つ入れてください。
  同じ練習を繰り返しても改善していないことがデータから分かっています。
  （例: テンポを大幅に落とす／片手ずつ／リズム変奏／運指の見直し／
   声部を分けて弾く／ペダルを外して確認する）

## 楽曲の文脈
song の作曲家・時代・調性・拍子から、その曲を演奏するうえでの一般的な着眼点を
context フィールドに簡潔に書いてください。ただし、分析結果と結びつけて書いてください。
一般論だけの記述は避けてください。
```

### 3.2 ユーザーメッセージ

```
以下は生徒の演奏の分析結果です。JSON で講評を作成してください。

<analysis>
{コンテキストJSON}
</analysis>
```

### 3.3 出力スキーマ（Structured Outputs）

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["headline", "summary", "strengths", "improvements", "practiceMenu", "context"],
  "properties": {
    "headline": {
      "type": "string", "maxLength": 40,
      "description": "この演奏を一言で。最も伝えたいことを書く"
    },
    "summary": {
      "type": "string", "maxLength": 400,
      "description": "3〜5文の全体講評"
    },
    "strengths": {
      "type": "array", "minItems": 2, "maxItems": 4,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "measures"],
        "properties": {
          "text": { "type": "string", "maxLength": 150 },
          "measures": {
            "type": "array", "items": { "type": "integer" },
            "description": "根拠となる小節。全体的な事柄なら空配列"
          }
        }
      }
    },
    "improvements": {
      "type": "array", "minItems": 2, "maxItems": 4,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "measures", "metric"],
        "properties": {
          "text": { "type": "string", "maxLength": 200 },
          "measures": { "type": "array", "items": { "type": "integer" } },
          "metric": {
            "type": "string",
            "enum": ["pitch","rhythm","tempo","dynamics","pedal","articulation"]
          }
        }
      }
    },
    "practiceMenu": {
      "type": "array", "minItems": 2, "maxItems": 4,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title","measures","tempoBpm","minutes","method","why","isNewApproach"],
        "properties": {
          "title":   { "type": "string", "maxLength": 40 },
          "measures":{ "type": "array", "minItems": 1, "items": { "type": "integer" } },
          "tempoBpm":{ "type": "integer", "minimum": 30, "maximum": 240 },
          "minutes": { "type": "integer", "minimum": 3, "maximum": 20 },
          "method":  { "type": "string", "maxLength": 300 },
          "why":     { "type": "string", "maxLength": 200 },
          "isNewApproach": {
            "type": "boolean",
            "description": "停滞小節に対する新しいアプローチかどうか"
          }
        }
      }
    },
    "context": { "type": "string", "maxLength": 300 },
    "issueDetails": {
      "type": "array",
      "description": "入力の issues それぞれに対する原因の推定と対処法",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["issueId", "detail"],
        "properties": {
          "issueId": { "type": "string" },
          "detail":  { "type": "string", "maxLength": 300 }
        }
      }
    }
  }
}
```

`strengths` / `improvements` に `measures` を持たせるのは、
**UI で該当小節にジャンプできるようにする**ためと、**検証を機械的に行う**ため。

### 3.4 生成パラメータ

| パラメータ | 値 | 理由 |
|---|---|---|
| `temperature` | 0.4 | 事実性を優先。ただし毎回同じ文言だと飽きられるので 0 にはしない |
| `top_p` | 0.9 | |
| `max_tokens` | 2000 | |
| `response_format` | `json_schema` (strict) | 形式を保証 |

---

## 4. プロンプト B: 停滞小節の診断

停滞小節が検出されたときのみ、**追加で**呼び出す（頻度が低いので高性能モデルを使う）。

### 4.1 システムプロンプト（差分）

```
生徒は同じ箇所を繰り返し練習していますが、複数回の録音を通じてスコアが改善していません。
通常の「ゆっくり弾く」「繰り返す」といった練習では突破できていないことが、データから分かります。

あなたの仕事は、なぜ改善しないのかについて複数の仮説を立て、
それぞれに対する具体的な検証方法と練習法を示すことです。

## 考えるべき原因のカテゴリ
1. 技術的要因  … 運指が適切でない、手の移動が間に合わない、指の独立性が足りない
2. 認知的要因  … 楽譜の読み間違い、リズムの理解が誤っている、拍の取り方
3. 身体的要因  … 手首/肘の使い方、力み、姿勢
4. 練習方法の要因 … 常に同じテンポで通している、間違えたまま繰り返して定着している
5. 難易度の要因 … その箇所が現在の習熟度に対して難しすぎる（一時的に簡略化すべき）

## 出力の姿勢
- 断定しないでください。「〜の可能性があります。確認するには〜してみてください」の形で。
- 生徒が自分で原因を切り分けられる「診断のための練習」を必ず1つ含めてください。
  （例: 「まず片手ずつゆっくり弾いてみてください。片手なら弾けるなら両手の協調の問題、
   片手でも崩れるなら運指の問題です」）
- 5番目の「難易度の要因」に該当すると考えられる場合は、
  一時的に簡略化する（内声を省く、オクターブを片方だけにする）提案も検討してください。
```

### 4.2 入力コンテキスト（追加分）

```jsonc
{
  "stagnantMeasure": {
    "measure": 19,
    "scoreMeasure": 19,
    "scoreHistory": [46.1, 47.0, 47.8, 48.2],
    "takeCount": 4,
    "spanDays": 26,
    "metricHistory": {
      "pitch":  [60, 61, 62, 62],
      "rhythm": [38, 39, 40, 41],       // ← ここが動いていない
      "tempo":  [52, 54, 55, 55]
    },
    "worstMetric": "rhythm",
    "issuesAcrossTakes": [
      { "type": "timing", "occurredInTakes": 4, "meanOnsetErrorSec": 0.041 }
    ],
    "musicalContext": {
      "notesInMeasure": 14,
      "handSpanSemitones": 17,
      "hasChord": true,
      "hasLeap": true,
      "maxLeapSemitones": 14,
      "voiceCount": 3,
      "rhythmPattern": "3連符 + 8分",
      "surroundingMeasureScores": { "18": 78.2, "21": 80.1 }
    }
  }
}
```

`musicalContext` は参照譜から機械的に抽出する。
**跳躍の大きさ、声部数、和音の有無**といった構造情報があると、
LLM は「なぜ難しいか」について妥当な仮説を立てられる。

`surroundingMeasureScores` も重要で、
「前後は80点なのにここだけ48点」という事実は、局所的な技術問題を示唆する。

### 4.3 出力スキーマ

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["measure", "hypotheses", "diagnosticExercise", "recommendedPractice"],
  "properties": {
    "measure": { "type": "integer" },
    "hypotheses": {
      "type": "array", "minItems": 2, "maxItems": 3,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["category", "text", "likelihood"],
        "properties": {
          "category": {
            "type": "string",
            "enum": ["technical","cognitive","physical","practice-method","difficulty"]
          },
          "text": { "type": "string", "maxLength": 200 },
          "likelihood": { "type": "string", "enum": ["high","medium","low"] }
        }
      }
    },
    "diagnosticExercise": {
      "type": "object",
      "additionalProperties": false,
      "required": ["instruction", "interpretation"],
      "properties": {
        "instruction":    { "type": "string", "maxLength": 300 },
        "interpretation": { "type": "string", "maxLength": 300,
                            "description": "結果からどう原因を切り分けるか" }
      }
    },
    "recommendedPractice": {
      "type": "array", "minItems": 1, "maxItems": 3,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["title","method","tempoBpm","minutes","differsFromPrevious"],
        "properties": {
          "title": { "type": "string", "maxLength": 40 },
          "method": { "type": "string", "maxLength": 400 },
          "tempoBpm": { "type": "integer", "minimum": 30, "maximum": 240 },
          "minutes": { "type": "integer", "minimum": 3, "maximum": 20 },
          "differsFromPrevious": {
            "type": "string", "maxLength": 150,
            "description": "これまでの練習と何が違うのか"
          }
        }
      }
    }
  }
}
```

`differsFromPrevious` を必須にすることで、
「結局いつもと同じ提案」になることを構造的に防ぐ。

---

## 5. プロンプト C: チャット

### 5.1 システムプロンプト

```
あなたはこの生徒のピアノ練習を伴走している指導者です。
分析結果について質問を受け、対話で答えます。

## 参照できる情報
以下の <context> に含まれるデータのみが、あなたの知っている「この生徒の演奏」です。
ここにない演奏内容について推測で答えないでください。
分からないことは「その点は今の分析結果からは判断できません」と正直に伝えてください。

## 答え方
- 簡潔に。3〜5文を基本とします。長い説明が必要なときだけ長くしてください。
- 具体的な小節番号と数値を根拠として示してください。
- 「〜してみてください」と、次の行動を1つ添えてください。
- 一般的な音楽知識の質問（この曲の様式、練習法の一般論）には答えて構いません。
  その場合は「一般論として」と前置きしてください。

## 答えないこと
- ピアノ・音楽・練習に関係のない話題は、丁寧にお断りしてください。
- 他人の演奏との比較や、コンクールでの評価の予測はしないでください。
- 医療的な助言（手の痛みなど）はしないでください。
  痛みを訴えられた場合は「無理をせず、専門家にご相談ください」と伝えてください。
```

### 5.2 コンテキスト

講評生成と同じ構造だが、以下を追加する。

```jsonc
{
  "currentReview": { /* 直近の講評 */ },
  "recentMessages": [ /* 直近10往復 */ ]
}
```

### 5.3 パラメータ

| パラメータ | 値 |
|---|---|
| `temperature` | 0.6（対話なので自然さを優先） |
| `max_tokens` | 800 |
| `stream` | true |
| `response_format` | text（構造化しない） |

---

## 6. 出力検証

生成後、保存前に機械的に検証する。**これが第3の防御層。**

### 6.1 検証ルール

| # | ルール | 違反時 |
|---|---|---|
| V1 | 言及されたすべての小節番号が `playedMeasureRange` 内 | 該当項目を削除 |
| V2 | 言及された小節が `excludedMeasures` に含まれない | 該当項目を削除 |
| V3 | `improvements[].metric` が `metricsNotEvaluated` に含まれない | 該当項目を削除 |
| V4 | 講評本文に現れる数値が、入力データに存在する値と一致（±0.1） | 再生成（1回） |
| V5 | `practiceMenu[].tempoBpm` が `targetTempo` の 40〜110% | 該当項目のBPMをクランプ |
| V6 | `practiceMenu[].minutes` の合計が `dailyPracticeMinutes` の ±20% | 再生成（1回） |
| V7 | `stagnantMeasures` があるとき、`isNewApproach: true` の項目が1つ以上 | 再生成（1回） |
| V8 | `trend` と講評本文の方向性が矛盾しない（否定表現の検出） | 再生成（1回） |
| V9 | 出力が有効なJSONで、スキーマに適合 | 再生成（1回） |

### 6.2 数値検証（V4）の実装

```python
NUM_RE = re.compile(r"\d+(?:\.\d+)?")

def verify_numbers(text: str, allowed: set[float], tol: float = 0.1) -> list[str]:
    """本文中の数値のうち、入力データに根拠がないものを返す"""
    violations = []
    for token in NUM_RE.findall(text):
        v = float(token)
        if v in SAFE_NUMBERS:            # 小節番号、拍、年など別途許可
            continue
        if not any(abs(v - a) <= tol for a in allowed):
            violations.append(token)
    return violations
```

`allowed` には入力コンテキストに現れるすべての数値（スコア、BPM、小節番号、ミリ秒）を集める。

### 6.3 再生成の上限

再生成は**1回まで**。2回目も失敗した場合は、
違反したフィールドを削除して保存し、`validation.removedFields` に記録する。

講評が多少短くなっても、**間違ったことを言うよりはるかにマシ**である。

### 6.4 監視

| メトリクス | 用途 |
|---|---|
| 検証ルールごとの違反率 | プロンプト改善の指標 |
| 再生成率 | コストとレイテンシへの影響 |
| フィールド削除率 | 品質劣化の検知 |

違反率が閾値を超えたらアラートを出し、プロンプトを見直す。

---

## 7. 評価

### 7.1 評価セット

```
eval/prompts/
├── cases/
│   ├── 001-beginner-first-take.json      # 初回・低スコア
│   ├── 002-intermediate-improving.json   # 順調に伸びている
│   ├── 003-stagnant-measures.json        # 停滞あり
│   ├── 004-regression.json               # スコアが下がった
│   ├── 005-partial-range.json            # 部分練習
│   ├── 006-low-confidence.json           # 除外小節が多い
│   ├── 007-no-dynamics-marks.json        # 強弱記号なしの曲
│   ├── 008-expert-rubato.json            # 上級者・ルバート多用
│   └── ...                               # 30ケース
└── run_eval.py
```

各ケースは**入力コンテキストJSONと、期待される性質のアサーション**を持つ。

### 7.2 自動評価

| # | チェック | 方法 |
|---|---|---|
| E1 | 検証ルール V1-V9 の通過 | 機械的 |
| E2 | 必須要素の存在（停滞ケースで `isNewApproach` があるか等） | 機械的 |
| E3 | 「もう一度通す」等の禁止表現がないか | 正規表現 |
| E4 | 文体（敬体）の一貫性 | 正規表現 |
| E5 | トーンの適切さ | LLM-as-judge |
| E6 | 分析結果との整合性 | LLM-as-judge（別モデルに矛盾を探させる） |

**E6 の LLM-as-judge プロンプト**:

```
以下は演奏の分析データと、それに基づいて生成された講評です。
講評の中に、分析データと矛盾する記述、またはデータから導けない断定がないか確認してください。

矛盾があれば、該当箇所と理由を列挙してください。なければ "OK" と答えてください。
判断に迷うものは矛盾として報告してください（見落としより過検知を優先します）。
```

### 7.3 人手評価

四半期に1回、ピアノ講師3名に 20ケースを評価してもらう。

| 観点 | 尺度 |
|---|---|
| 指導として妥当か | 1-5 |
| 練習メニューが実行可能か | 1-5 |
| 生徒が読んで前向きになれるか | 1-5 |
| 事実誤認がないか | あり/なし |

**目標**: 平均 4.0 以上、事実誤認 5% 未満。

### 7.4 リグレッション防止

プロンプトまたはモデルを変更する際は、評価セットを実行して以下を確認する。

- E1-E4 の通過率が下がっていないこと
- E5-E6 のスコアが有意に下がっていないこと

CI で実行するには LLM 呼び出しコストがかかるため、
**プロンプト変更を含む PR でのみ**実行する（ラベルでトリガー）。

---

## 8. バージョン管理

### 8.1 プロンプトのバージョニング

```
prompts/
├── review/
│   ├── v1.system.md
│   ├── v1.schema.json
│   └── v2.system.md
├── stagnation/
├── chat/
└── registry.json          # 現在有効なバージョンの定義
```

`registry.json`:

```jsonc
{
  "review":     { "active": "v1", "model": "...", "temperature": 0.4 },
  "stagnation": { "active": "v1", "model": "...", "temperature": 0.5 },
  "chat":       { "active": "v1", "model": "...", "temperature": 0.6 }
}
```

生成結果には必ず `promptVersion` と `model` を記録する（[データモデル](./data-model.md) 参照）。
品質問題が起きたときに、どのバージョンで生成されたかを追跡できるようにする。

### 8.2 段階的ロールアウト

プロンプト変更は、まず 10% のテイクに適用して指標を比較してから全面展開する。

---

## 9. コストとレイテンシ

### 9.1 呼び出し回数

| 契機 | 回数 |
|---|---|
| テイク解析完了 | 1回（講評＋指摘詳細を統合） |
| 停滞小節の検出 | 停滞小節ごとに1回。ただし**同じ小節への再診断は7日に1回まで** |
| チャット | ユーザーの送信ごと |

**停滞診断のレート制限が重要**。毎テイクごとに診断すると、
コストがかさむうえに毎回似た内容が返り価値がない。

### 9.2 レイテンシ対策

| 対策 | 内容 |
|---|---|
| 講評をブロッキングにしない | S4/S5 完了時点でテイクを閲覧可能にし、講評は後から差し込む |
| チャットはストリーミング | 体感レイテンシを下げる |
| 停滞診断は非同期 | 講評とは別ジョブ。完了時に通知 |

---

## 10. 関連ドキュメント

- [評価指標定義](../spec/metrics.md)
- [分析パイプライン設計](./analysis-pipeline.md)
- [データモデル](./data-model.md)
- [Azureアーキテクチャ](./architecture.md)
