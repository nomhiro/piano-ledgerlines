# データモデル設計 — Ledger Lines

| 項目 | 内容 |
|---|---|
| ドキュメントID | DESIGN-DATA |
| バージョン | 0.1（M3 ドラフト） |
| 最終更新 | 2026-07-25 |
| ストア | Azure Cosmos DB for NoSQL + Azure Blob Storage |

---

## 1. ストア選定

### 1.1 Cosmos DB for NoSQL を選ぶ理由

| 理由 | 内容 |
|---|---|
| アクセスパターンが単純 | ほぼすべての読み取りが「ユーザーの曲」「曲のテイク」に閉じる。パーティションキーで綺麗に分割できる |
| ドキュメント指向が適合 | テイクの分析結果は小節スコア・指摘・カーブを含む**入れ子の塊**であり、常に一括で読む |
| スキーマ進化 | 指標の追加・分析結果の構造変更が頻繁に起きる領域。マイグレーション不要な利点が大きい |
| サーバーレス課金 | MVP の負荷（1,000MAU）ではサーバーレスが安価。RU が読めるようになったら自動スケールへ移行 |

### 1.2 検討した代替案

| 選択肢 | 不採用の理由 |
|---|---|
| Azure SQL Database | 分析結果の入れ子構造を JSON カラムに入れることになり、Cosmos の利点を失いつつ運用が重い |
| PostgreSQL (Flexible Server) | 同上。ただし将来、講師の生徒管理など**関係が複雑な機能**が増えるなら再検討の価値あり |
| Blob のみ（DBなし） | 一覧・集計クエリができない |

> **リスク**: 集計クエリ（「全ユーザーの平均スコア推移」等の分析）は Cosmos が苦手。
> 必要になった時点で **Change Feed → Azure Data Explorer** への流し込みを追加する。

---

## 2. Blob Storage 設計

### 2.1 コンテナ構成

| コンテナ | 用途 | アクセス | ライフサイクル |
|---|---|---|---|
| `audio` | 録音の原本 | private | ユーザー削除まで。90日で Cool 層へ |
| `scores` | アップロードされた MusicXML/MIDI | private | 曲削除まで |
| `derived` | 採譜結果・アライメント結果・展開済み参照譜 | private | テイク/曲の削除まで |
| `work` | 前処理済み音声などの一時ファイル | private | **7日で自動削除** |

### 2.2 パス設計

```
audio/{userId}/{takeId}/original.{webm|mp4|wav}
scores/{userId}/{songId}/score.musicxml
derived/{userId}/{songId}/reference.json          # 展開済み参照譜（曲単位でキャッシュ）
derived/{userId}/{takeId}/transcription.json      # 採譜結果
derived/{userId}/{takeId}/alignment.json          # アライメント結果
work/{takeId}/preprocessed.wav
```

**`userId` を先頭に置く理由**: ユーザー削除時にプレフィックス指定で一括削除できる。
また、将来ユーザー単位でストレージを分ける場合の移行が容易。

### 2.3 アクセス方式

- クライアントは Blob に直接アクセスしない
- API が**短命の SAS URL**（読み取り 15分、書き込み 30分）を発行する
- アップロードはクライアント → Blob 直接（API を経由しない）。100MB の音声を API 経由にすると帯域とタイムアウトが問題になる

```
1. クライアント → API: POST /api/takes          （テイクを作成）
2. API → クライアント: { takeId, uploadUrl }     （書き込み SAS）
3. クライアント → Blob: PUT uploadUrl            （直接アップロード）
4. クライアント → API: POST /api/takes/{id}/submit
5. API → Queue: 解析ジョブを投入
```

---

## 3. Cosmos DB コンテナ設計

### 3.1 コンテナ一覧

| コンテナ | パーティションキー | 主なドキュメント種別 | 想定サイズ |
|---|---|---|---|
| `users` | `/id` | ユーザープロフィール、設定 | 小 |
| `songs` | `/userId` | 曲、練習ログ、課題、共有設定 | 中 |
| `takes` | `/songId` | テイク（分析結果を含む） | **大** |
| `conversations` | `/songId` | AIコーチのチャット履歴 | 中 |
| `shares` | `/token` | 共有リンク（トークン→曲の解決用） | 小 |

### 3.2 パーティションキーの根拠

| コンテナ | PK | 根拠 |
|---|---|---|
| `songs` | `/userId` | 「自分の曲一覧」が最頻クエリ。1ユーザーの曲数はたかだか数百なので 20GB 上限に十分収まる |
| `takes` | `/songId` | 「この曲のテイク一覧」「この曲の履歴比較」が最頻クエリ。**曲単位でクエリが閉じる**のが最大の利点。1曲あたり数百テイクでも数十MB |
| `conversations` | `/songId` | チャットは曲のコンテキストで行われる |
| `shares` | `/token` | トークンからの単一ポイントリードのみ |

> **`takes` を `/userId` にしなかった理由**: ヘビーユーザーが多数の曲 × 多数のテイクを持つと
> 論理パーティションが肥大化する。また履歴比較は常に単一曲内で完結するため、
> `/songId` のほうがクエリ効率が良い。
>
> **トレードオフ**: 「ユーザーの全テイクを横断」するクエリ（ダッシュボードの練習ログ等）が
> クロスパーティションになる。→ 集計値を `songs` コンテナの `practiceLog` に非正規化して解決する。

---

## 4. ドキュメントスキーマ

### 4.1 `users` コンテナ

```jsonc
{
  "id": "usr_01HQ...",              // Entra のオブジェクトIDから導出
  "type": "user",
  "displayName": "野村 大樹",
  "email": "...",
  "teacherName": "白鳥ピアノ教室",   // 任意
  "settings": {
    "dailyPracticeMinutes": 30,     // 練習メニュー生成の上限
    "locale": "ja-JP",
    "allowTrainingUse": false,      // 音声のモデル学習利用への同意
    "notifyOnAnalysisComplete": true
  },
  "stats": {                        // 非正規化。テイク完了時に更新
    "totalTakes": 42,
    "totalPracticeMinutes": 1280,
    "currentStreakDays": 7,
    "longestStreakDays": 21,
    "lastPracticedOn": "2026-07-25"
  },
  "createdAt": "2026-01-10T...",
  "updatedAt": "2026-07-25T..."
}
```

### 4.2 `songs` コンテナ

#### 4.2.1 曲ドキュメント

```jsonc
{
  "id": "sng_01HQ...",
  "userId": "usr_01HQ...",          // ★ パーティションキー
  "type": "song",

  "title": "ワルツ 第7番 嬰ハ短調 Op.64-2",
  "composer": "F. Chopin",
  "period": "romantic",             // baroque|classical|romantic|modern|other
  "keySignature": "cis",
  "timeSignature": "3/4",
  "difficulty": 7,                  // 1-10 ユーザー申告

  "score": {
    "blobPath": "scores/usr_.../sng_.../score.musicxml",
    "format": "musicxml",           // musicxml|midi
    "referencePath": "derived/usr_.../sng_.../reference.json",
    "scoreMeasureCount": 64,
    "expandedMeasureCount": 96,
    "hasDynamicMarks": true,
    "hasArticulationMarks": true,
    "hasPedalMarks": false,
    "parsedAt": "2026-06-20T...",
    "parserVersion": "ref-v1"
  },

  "status": "practicing",           // reading|practicing|polishing|ready
  "targetTempo": 132,
  "goal": {
    "date": "2026-09-13",
    "description": "発表会で演奏する"
  },

  // ── 非正規化された集計（テイク完了時に更新）────────────
  "summary": {
    "takeCount": 4,
    "latestTakeId": "tk_...",
    "latestScore": 81.4,
    "latestRecordedAt": "2026-07-24T...",
    "firstScore": 62.9,
    "bestScore": 81.4,
    "readiness": 74.2,
    "stagnantMeasures": [19, 20],
    "improvedMeasureCount": 30,
    "regressedMeasureCount": 0
  },

  "sharing": {
    "enabled": true,
    "token": "shr_7f3a9c...",       // shares コンテナへの参照
    "expiresAt": "2026-10-23T..."
  },

  "createdAt": "2026-06-20T...",
  "updatedAt": "2026-07-24T..."
}
```

> **`summary` を非正規化する理由**: 曲一覧画面で N 曲分のテイクを読むと N+1 問題になる。
> テイク完了時に1回書き込むことで、一覧が単一クエリで済む。
> 整合性は結果整合でよい（数秒遅れても実害がない）。

#### 4.2.2 課題ドキュメント

```jsonc
{
  "id": "asg_01HQ...",
  "userId": "usr_01HQ...",          // ★ PK
  "type": "assignment",
  "songId": "sng_01HQ...",
  "title": "19-20小節の内声を意識して",
  "detail": "...",
  "dueDate": "2026-08-01",
  "status": "todo",                 // todo|doing|done
  "createdBy": "teacher",           // teacher|student
  "createdByName": "白鳥先生",
  "createdAt": "...",
  "updatedAt": "..."
}
```

#### 4.2.3 練習ログドキュメント

日単位で1ドキュメント。

```jsonc
{
  "id": "log_usr_01HQ..._2026-07-25",   // 決定的ID（upsert しやすい）
  "userId": "usr_01HQ...",              // ★ PK
  "type": "practiceLog",
  "date": "2026-07-25",
  "minutes": 45,
  "takeCount": 3,
  "songIds": ["sng_...", "sng_..."],
  "updatedAt": "..."
}
```

### 4.3 `takes` コンテナ

**最も重要かつ最大のドキュメント。**

```jsonc
{
  "id": "tk_01HQ...",
  "songId": "sng_01HQ...",          // ★ パーティションキー
  "userId": "usr_01HQ...",
  "type": "take",

  // ── 録音メタ ────────────────────────────
  "label": "テイク4（通し）",
  "recordedAt": "2026-07-24T20:15:00+09:00",
  "durationSec": 118,
  "requestedMeasureRange": [1, 32],   // ユーザー指定
  "playedMeasureRange": [1, 32],      // アライメントが確定した実際の範囲
  "requestedTempo": 132,
  "inputKind": "audio",               // audio|midi
  "memo": "ペダルを浅めに意識した",

  "audio": {
    "blobPath": "audio/usr_.../tk_.../original.webm",
    "mimeType": "audio/webm;codecs=opus",
    "sizeBytes": 1843200,
    "sampleRate": 48000,
    "trimOffsetSec": 0.42,            // 前処理でトリムした先頭の長さ
    "rmsDbfs": -22.4,
    "clippingRate": 0.0001,
    "agcDetected": false,
    "metronomeDetected": false
  },

  // ── 解析ステータス ────────────────────────
  "status": "completed",              // uploading|queued|transcribing|aligning
                                      // |scoring|reviewing|completed|failed
  "statusDetail": null,
  "failure": null,                    // { code, message } when failed
  "progress": {
    "queuedAt": "...", "startedAt": "...", "completedAt": "...",
    "stageDurationsMs": { "s0": 2800, "s2": 24100, "s3": 7900,
                          "s4": 1600, "s5": 400, "s6": 11200 }
  },

  "analysis": {
    "version": "analysis-v1",         // 再解析の判定に使う
    "transcriptionModel": "bytedance-pt-v1.0",
    "alignerVersion": "align-v1",
    "metricsVersion": "metrics-v1",
    "transcriptionPath": "derived/usr_.../tk_.../transcription.json",
    "alignmentPath":     "derived/usr_.../tk_.../alignment.json",
    "confidence": 0.86,               // テイク全体
    "matchRate": 0.94
  },

  // ── スコア ───────────────────────────────
  "overallScore": 81.4,
  "metrics": {
    "pitch": 81.2, "rhythm": 81.2, "tempo": 82.2,
    "dynamics": 78.3, "pedal": null
  },
  "metricsNA": ["pedal"],             // 評価対象外だった指標とその理由
  "metricsNAReason": { "pedal": "NO_PEDAL_MARKS_IN_SCORE" },

  "measureScores": [                  // 演奏された小節数ぶん（〜数百）
    {
      "measure": 1,                   // 演奏順
      "scoreMeasure": 1,              // 楽譜上
      "score": 87.3,
      "confidence": 0.91,
      "metrics": { "pitch": 92.0, "rhythm": 88.1, "tempo": 90.4,
                   "dynamics": 81.2, "pedal": null },
      "noteCount": 9
    }
    // ...
  ],

  "issues": [
    {
      "id": "iss_1",
      "measures": [19, 20],           // 配列。グルーピング対応
      "beat": 2,
      "type": "timing",               // missed-note|extra-note|timing|dynamics|pedal|tempo
      "severity": "high",             // high|medium|low
      "title": "19-20小節：右手が左手より平均38ms遅れています",
      "detail": "（LLM生成の原因推定と対処法）",
      "refNoteIds": ["rn_412", "rn_413"],
      "evidence": { "meanOnsetErrorSec": 0.038, "affectedNotes": 6 }
    }
  ],

  "curves": {
    "tempo":    [ { "measure": 1, "bpm": 128.4, "target": 132, "excluded": false } ],
    "dynamics": [ { "measure": 1, "actual": 0.62, "target": 0.57 } ]
  },

  // ── 前テイクとの差分（非正規化）──────────────
  "comparison": {
    "baselineTakeId": "tk_prev...",
    "overallDelta": 5.3,
    "metricDeltas": { "pitch": 4.8, "rhythm": 5.1, ... },
    "improvedMeasures": [3, 7, 12],
    "regressedMeasures": [22]
  },

  "aiReview": {
    "generatedAt": "...",
    "model": "gpt-5.x",
    "promptVersion": "review-v1",
    "headline": "左手の安定感が明確に向上しています",
    "summary": "...",
    "strengths": ["..."],
    "improvements": ["..."],
    "context": "...",
    "practiceMenu": [
      {
        "id": "pm_1",
        "title": "19-20小節の内声を独立させる",
        "measures": [19, 20],
        "tempoBpm": 76,
        "minutes": 8,
        "method": "...",
        "why": "...",
        "completedAt": null
      }
    ],
    "validation": {                   // 自動検証の結果
      "passed": true,
      "removedFields": []
    }
  },

  "createdAt": "...",
  "updatedAt": "..."
}
```

#### 4.3.1 ドキュメントサイズの見積もりと上限

Cosmos DB のドキュメント上限は **2MB**。

| 要素 | 1件あたり | 件数 | 小計 |
|---|---|---|---|
| `measureScores` | 約 280 B | 300小節 | 84 KB |
| `issues` | 約 500 B | 30件 | 15 KB |
| `curves` | 約 90 B | 300 × 2 | 54 KB |
| `aiReview` | — | — | 8 KB |
| その他 | — | — | 3 KB |
| **合計** | | | **約 165 KB** |

300小節の曲でも 2MB の 10% 未満。**余裕がある。**

ただし以下は Blob に置き、ドキュメントには含めない。

| データ | 理由 |
|---|---|
| ピアノロール（全音符） | 数千音符 × 60B = 数百 KB。分析結果画面でのみ必要なので遅延ロードする |
| 採譜結果の生データ | 同上 |
| アライメントの全マッチ | 同上 |

ピアノロールは `derived/.../transcription.json` と `alignment.json` から
API がオンデマンドで組み立てて返す（`GET /api/takes/{id}/roll`）。

#### 4.3.2 インデックスポリシー

既定の「全プロパティにインデックス」は RU を浪費する。以下に限定する。

```jsonc
{
  "indexingMode": "consistent",
  "includedPaths": [
    { "path": "/songId/?" },
    { "path": "/userId/?" },
    { "path": "/type/?" },
    { "path": "/status/?" },
    { "path": "/recordedAt/?" },
    { "path": "/overallScore/?" }
  ],
  "excludedPaths": [
    { "path": "/measureScores/*" },   // ★ 最大の節約
    { "path": "/curves/*" },
    { "path": "/issues/*" },
    { "path": "/aiReview/*" },
    { "path": "/*" }
  ],
  "compositeIndexes": [
    [ { "path": "/songId", "order": "ascending" },
      { "path": "/recordedAt", "order": "descending" } ]
  ]
}
```

`measureScores` を除外することで書き込み RU が大幅に下がる。
これらは検索条件にならず、常にドキュメント全体で読むため、インデックスは不要。

### 4.4 `conversations` コンテナ

```jsonc
{
  "id": "cnv_sng_01HQ...",           // 曲ごとに1ドキュメント
  "songId": "sng_01HQ...",           // ★ PK
  "userId": "usr_01HQ...",
  "type": "conversation",
  "messages": [
    { "id": "m1", "role": "user",      "body": "...", "at": "...",
      "contextTakeId": "tk_..." },
    { "id": "m2", "role": "assistant", "body": "...", "at": "...",
      "model": "gpt-5.x", "promptVersion": "chat-v1" }
  ],
  "messageCount": 24,
  "updatedAt": "..."
}
```

直近40メッセージ（20往復）のみ保持し、古いものは切り捨てる。
2MB 上限に対して十分に安全。

### 4.5 `shares` コンテナ

```jsonc
{
  "id": "shr_7f3a9c...",             // = token（★ PK も同値）
  "token": "shr_7f3a9c...",
  "type": "share",
  "songId": "sng_01HQ...",
  "userId": "usr_01HQ...",
  "enabled": true,
  "expiresAt": "2026-10-23T...",
  "createdAt": "...",
  "accessLog": {                     // 軽量なアクセス記録
    "viewCount": 12,
    "lastViewedAt": "..."
  }
}
```

- `token` は 32バイトの暗号論的乱数を base64url した推測困難な文字列
- `ttl` フィールドを設定し、有効期限切れで自動削除する

### 4.6 コメント

コメントは `takes` コンテナに置く（`songId` パーティション）。

```jsonc
{
  "id": "cmt_01HQ...",
  "songId": "sng_01HQ...",           // ★ PK
  "type": "comment",
  "takeId": "tk_..." ,               // null 可
  "measure": 19,                     // null 可（曲全体へのコメント）
  "authorRole": "teacher",           // teacher|student
  "authorName": "白鳥先生",
  "body": "...",
  "parentId": null,                  // スレッド返信
  "createdAt": "..."
}
```

> **`takes` コンテナに置く理由**: 曲詳細・共有ビューで「テイクとコメントを一緒に読む」ため、
> 同一パーティション内にあると1クエリで済む。`type` で判別する。

---

## 5. 主要クエリとRU見積もり

| # | クエリ | 実装 | 想定RU |
|---|---|---|---|
| Q1 | 自分の曲一覧 | `SELECT * FROM c WHERE c.userId=@u AND c.type='song'`（単一パーティション） | 5-15 |
| Q2 | 曲のテイク一覧（軽量） | `SELECT c.id, c.label, c.recordedAt, c.overallScore, c.metrics, c.status FROM c WHERE c.songId=@s AND c.type='take' ORDER BY c.recordedAt DESC` | 5-10 |
| Q3 | テイク詳細 | ポイントリード `ReadItem(takeId, songId)` | 3-8 |
| Q4 | 履歴比較（全テイクの小節スコア） | `SELECT c.id, c.recordedAt, c.measureScores, c.playedMeasureRange FROM c WHERE c.songId=@s AND c.type='take'` | 20-60 |
| Q5 | 共有トークンの解決 | ポイントリード `ReadItem(token, token)` | 1 |
| Q6 | 曲のコメント | `SELECT * FROM c WHERE c.songId=@s AND c.type='comment'` | 3-8 |
| Q7 | 練習ログ（直近30日） | `SELECT * FROM c WHERE c.userId=@u AND c.type='practiceLog' AND c.date>=@d` | 5-10 |
| Q8 | 課題一覧 | `SELECT * FROM c WHERE c.userId=@u AND c.type='assignment'` | 3-8 |

**すべて単一パーティション内で完結する。** クロスパーティションクエリはゼロ。

### 5.1 Q4 の最適化

履歴比較は最も重いクエリ。テイクが増えると `measureScores` の総量が線形に増える。

| テイク数 | 転送量 | 対策 |
|---|---|---|
| 〜10 | 〜840 KB | そのまま |
| 10〜50 | 〜4 MB | 表示対象を直近10テイク＋初回に限定 |
| 50〜 | — | 曲ドキュメントに「小節別スコアの時系列」を圧縮して非正規化することを検討 |

MVP では「直近10テイク＋最初のテイク」に限定して取得する。

---

## 6. 整合性とトランザクション

### 6.1 非正規化の更新

テイクの解析完了時に、以下を更新する必要がある。

```
1. takes/{takeId}        … status, スコア, 講評
2. songs/{songId}.summary … 最新スコア, 停滞小節, readiness
3. songs/log_{userId}_{date} … 練習ログ
4. users/{userId}.stats   … 累計・ストリーク
```

**これらは異なるパーティション・異なるコンテナにまたがるため、
トランザクショナルバッチが使えない。**

方針：

| 対象 | 方式 |
|---|---|
| 1 (takes) | 直接書き込み。**これが正データ** |
| 2, 3, 4 | Change Feed で takes の変更を購読し、非同期に更新する |

Change Feed プロセッサ（Azure Functions）が失敗した場合も、
チェックポイントから再開されるため最終的に整合する。

> **原則: 非正規化された値は「表示用のキャッシュ」であり、正データではない。**
> 不整合が疑われる場合は takes から再計算できる仕組み（再集計ジョブ）を用意する。

### 6.2 楽観的並行制御

同時更新が起こりうる箇所（課題のステータス変更、練習メニューの完了チェック）は
ETag による楽観ロックを使う。

---

## 7. データライフサイクル

### 7.1 削除

| 操作 | 影響 |
|---|---|
| テイク削除 | takes ドキュメント削除 → Change Feed で音声・derived Blob を削除、songs.summary を再計算 |
| 曲削除 | 曲配下のテイク・コメント・会話・共有をすべて削除。scores/derived Blob も削除 |
| ユーザー削除 | 上記をすべて＋ Blob のプレフィックス一括削除 |

**猶予期間**: 削除は即座に UI から見えなくするが、
物理削除は 30日後に実行する（誤操作からの復旧のため）。
論理削除は `deletedAt` フィールドと Cosmos の `ttl` で実現する。

### 7.2 データ保持

| データ | 保持 |
|---|---|
| 音声 | ユーザーが削除するまで無期限 |
| 分析結果 | 同上 |
| `work/` の一時ファイル | 7日 |
| 共有リンク | 有効期限（既定90日）で自動削除 |
| チャット履歴 | 直近20往復のみ |

### 7.3 エクスポート

GDPR / 個人情報保護の観点から、ユーザーが自分のデータを一括ダウンロードできるようにする（Phase 2）。
形式：JSON（メタ＋分析結果）＋音声ファイルの ZIP。

---

## 8. スキーマ進化

### 8.1 バージョニング

各テイクは以下のバージョンを記録する。

| フィールド | 意味 |
|---|---|
| `analysis.version` | パイプライン全体のバージョン |
| `analysis.transcriptionModel` | 採譜モデル |
| `analysis.metricsVersion` | 指標定義のバージョン |

### 8.2 移行方針

| 変更の種類 | 対応 |
|---|---|
| フィールド追加 | 後方互換。読み取り側でデフォルト値を用意する |
| 指標の追加 | 過去テイクは `null`。UI で「この指標は新しく追加されました」と表示 |
| 指標定義の変更 | **曲単位で全テイクを再スコアリング**（[パイプライン設計 10.5](./analysis-pipeline.md#105-再解析)） |
| フィールド削除 | 即座に消さず、1リリース分は読み取り互換を維持してから削除 |

**破壊的なマイグレーションは行わない。** Cosmos の利点を活かし、
読み取り側で複数バージョンを吸収する。

---

## 9. TypeScript 型定義（抜粋）

アプリケーション層で共有する型。PoVモックの `src/lib/mock/types.ts` を拡張したもの。

```ts
export type MetricKey =
  | "pitch" | "rhythm" | "tempo" | "dynamics" | "pedal";

/** 評価対象外を表現できるスコア */
export type Score = number | null;

export interface MeasureScore {
  measure: number;          // 演奏順
  scoreMeasure: number;     // 楽譜上
  score: Score;
  confidence: number;       // 0-1
  metrics: Record<MetricKey, Score>;
  noteCount: number;
}

export type EvaluationStatus =
  | "scored" | "reference" | "withheld" | "unavailable";

export interface MetricEvaluation {
  status: EvaluationStatus;
  confidence: number | null; // 較正前は正答確率ではなく対応品質。null可
  reasonCode: string | null;
  reason: string | null;
  evidence: Record<string, unknown>;
}

export type TakeStatus =
  | "uploading" | "queued" | "transcribing" | "aligning"
  | "scoring" | "reviewing" | "completed" | "failed";

export type FailureCode =
  | "AUDIO_TOO_QUIET" | "NOT_PIANO" | "ALIGN_FAILED"
  | "TOO_MANY_ERRORS" | "INVALID_LENGTH" | "INTERNAL";

export interface Take {
  id: string;
  songId: string;
  userId: string;
  label: string;
  recordedAt: string;
  durationSec: number;
  requestedMeasureRange: [number, number];
  playedMeasureRange: [number, number] | null;
  requestedTempo: number;
  inputKind: "audio" | "midi";
  status: TakeStatus;
  failure: { code: FailureCode; message: string } | null;
  overallScore: Score;
  metrics: Record<MetricKey, Score>;
  metricConfidence: Record<MetricKey, number | null>;
  metricEvaluations: Partial<Record<MetricKey, MetricEvaluation>>;
  metricsNAReason: Partial<Record<MetricKey, string>>;
  measureScores: MeasureScore[];
  issues: Issue[];
  curves: {
    tempo: { measure: number; bpm: number; target: number; excluded: boolean }[];
    dynamics: { measure: number; actual: number; target: number }[];
  };
  comparison: Comparison | null;
  aiReview: AiReview | null;
  analysis: AnalysisMeta;
  memo: string;
}
```

> PoVモックとの主な差分：
> `Score` が `null` を取りうる（N/A 対応）、`confidence` の追加、
> `scoreMeasure` の追加（繰り返し対応）、`status`/`failure` の追加、
> `issues.measures` が配列（グルーピング対応）。

---

## 10. 関連ドキュメント

- [機能仕様](../spec/functional.md)
- [評価指標定義](../spec/metrics.md)
- [API仕様](../spec/api.md)
- [分析パイプライン設計](./analysis-pipeline.md)
- [Azureアーキテクチャ](./architecture.md)
