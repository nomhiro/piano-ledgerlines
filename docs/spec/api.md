# API仕様 — Ledger Lines

| 項目 | 内容 |
|---|---|
| ドキュメントID | SPEC-API |
| バージョン | 0.2（教室基盤層） |
| 最終更新 | 2026-08-14 |
| ベースURL | `https://api.ledgerlines.app/api` |

---

## 1. 設計原則

| # | 原則 | 理由 |
|---|---|---|
| P1 | **リソース指向の REST** | クライアントは Next.js のみ。GraphQL の柔軟性は不要で、キャッシュとデバッグの容易さを取る |
| P2 | **重い処理は 202 + ポーリング/SSE** | 解析は数十秒〜数分。同期レスポンスにしない |
| P3 | **大きなペイロードは Blob へ逃がす** | ピアノロール・音声・楽譜は SAS 経由。API のレスポンスに含めない |
| P4 | **`null` と欠損を区別する** | `score: null` は「測定不能（N/A）」を意味する。フィールドの省略とは別物 |
| P5 | **べき等性を明示する** | `POST /takes` は `Idempotency-Key` ヘッダに対応。ネットワーク再送で二重作成しない |
| P6 | **エラーは機械可読なコードを返す** | UI がコードごとに適切な案内を出せるようにする |

スコアが `null` の場合は `evaluation` / `metricEvaluations` も返し、
`withheld`（信頼度・較正不足による判定保留）と `unavailable`
（楽譜記号がない等の測定対象外）を区別する。未較正値を 0 点や欠損として扱わない。

`reference` は録音条件への頑健性を確認済みだが教師較正前の参考値を表す。
総合点、テイク比較、指摘、AI講評には `status: "scored"` の値だけを使用する。

### 1.1 共通ヘッダ

| ヘッダ | 方向 | 内容 |
|---|---|---|
| `Authorization: Bearer <token>` | Req | Entra External ID のアクセストークン（本番） |
| `Idempotency-Key: <uuid>` | Req | 作成系の一部で任意 |
| `X-Request-Id: <uuid>` | Req/Res | トレース相関。省略時はサーバーが採番 |
| `X-Api-Version: 1` | Res | 破壊的変更時にインクリメント |

### 1.2 共通の慣習

| 項目 | 規約 |
|---|---|
| 日時 | ISO 8601、タイムゾーン付き（`2026-07-25T13:40:00+09:00`） |
| 小節番号 | 1始まり。`measure`（演奏順）と `scoreMeasure`（楽譜上）を区別する |
| スコア | `0-100` の整数、または `null`（N/A） |
| ページング | カーソル方式。`?limit=20&cursor=<opaque>` → `{ items, nextCursor }` |
| 部分更新 | `PATCH` + 変更したいフィールドのみ |

---

## 2. エラー

### 2.1 レスポンス形式

```json
{
  "error": {
    "code": "TAKE_NOT_READY",
    "message": "解析が完了していません。",
    "details": { "status": "scoring" },
    "requestId": "0f8c...",
    "retryable": true
  }
}
```

### 2.2 エラーコード一覧

| コード | HTTP | 意味 | UI の扱い |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | トークンが無効／期限切れ | 再ログインへ誘導 |
| `FORBIDDEN` | 403 | 他ユーザーのリソース | 一覧へ戻す |
| `NOT_FOUND` | 404 | リソースが存在しない | 一覧へ戻す |
| `VALIDATION_FAILED` | 400 | 入力が不正 | フィールド単位でエラー表示 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同一キーで異なるボディ | 開発時のみ発生。汎用エラー |
| `TAKE_NOT_READY` | 409 | 解析未完了のリソースを要求 | 進捗表示に切り替え |
| `QUOTA_EXCEEDED` | 402 | 月間テイク数の上限 | プラン案内 |
| `RATE_LIMITED` | 429 | レート制限 | `Retry-After` 秒後に再試行 |
| `UPSTREAM_UNAVAILABLE` | 503 | Foundry 等の一時障害 | 再試行ボタン |
| `INTERNAL` | 500 | 想定外 | 汎用エラー |

### 2.3 解析失敗コード（`FailureCode`）

これらは HTTP エラーではない。テイクは `status: "failed"` で取得でき、`failure.code` に入る。

| コード | 原因 | UI メッセージの方針 |
|---|---|---|
| `AUDIO_TOO_QUIET` | 音量が閾値未満 | マイク位置・入力レベルの確認を促す |
| `NOT_PIANO` | ピアノ音が検出されない | 録音対象の確認を促す |
| `ALIGN_FAILED` | 楽譜と対応付けられない | 曲・小節範囲の指定ミスを疑うよう案内 |
| `TOO_MANY_ERRORS` | 一致率が閾値未満 | 「別の曲を弾いていませんか」と確認 |
| `INVALID_LENGTH` | 5秒未満 / 15分超 | 録音長の制限を説明 |
| `INTERNAL` | 想定外 | 再試行ボタンを出す |

> **設計判断**: 解析失敗を HTTP エラーにしないのは、**失敗も履歴として残す**ため。
> ユーザーは「なぜ失敗したか」を後から見返せる必要がある。

---

## 3. 認証

### 3.1 通常の認証

Entra External ID の OIDC。ブラウザは Authorization Code + PKCE で ID/アクセストークンを取得し、
API へは `Authorization: Bearer` で送る。

ローカル開発では `LEDGERLINES_AUTH_MODE=development` を明示した場合のみ、
環境変数 `LEDGERLINES_DEV_USER_ID`（既定値 `usr_local_dev`）へフォールバックする。
本番では `LEDGERLINES_AUTH_MODE=entra`、issuer・audience・JWKS URL の設定が必須であり、
署名、issuer、audience、期限を検証する。API はリソース所有者のIDを必ずクエリ条件に含める。

Google Easy Auth は `x-ms-client-principal` をサーバー側で検証済みのprincipalとして読み、
`sub`/nameidentifier/objectidentifier、`email`/emailaddress、`name` の許可済みclaimから
ユーザーID・確認可能なメール・表示名を取得する。必須claimが欠落または不正なprincipalは
401で明示的に拒否する。初回ログインとprovider情報の変更時には `users` をupsertし、
`normalizedEmail` と同期時刻を更新する。PIIやprincipalの内容はログへ出力しない。

### 3.2 無料プランの利用上限

無料プランは、UTC基準の暦月ごとにテイク作成を5件まで許可する。6件目の
`POST /songs/{songId}/takes` は `402 QUOTA_EXCEEDED` を返し、既存のテイクや
解析結果は読み取り可能なまま維持する。有料プランはJWTの `plan` /
`extension_plan` claim または `paid` / `premium` ロールで判定し、この上限を適用しない。

### 3.3 共有トークン

共有ビュー `/s/{token}` は未認証でアクセスできる。API 側は以下のように扱う。

```
GET /api/shares/{token}
GET /api/shares/{token}/takes/{takeId}
POST /api/shares/{token}/comments
```

| ルール | 内容 |
|---|---|
| トークンの検証 | `enabled === true` かつ `expiresAt > now` |
| スコープ | 共有対象のテイク（または曲配下の全テイク）に限定 |
| 書き込み | コメントの投稿のみ許可。他は全て 403 |
| 投稿者名 | 共有リンクの初回アクセス時に名前を入力させ、Cookie に保持 |

### 3.4 Account context

`GET /api/account` は認証ユーザー自身のprofileと教室membership要約を返す。
教室membershipがない場合は `mode: "individual"` とし、教室名や教室権限を表示しない。
レスポンスの `permissions` と `entitlement` は後続UI/APIが共通利用するサーバー導出値であり、
クライアント入力を権限判定に使わない。契約未作成の教室は `contractStatus: "none"` とする。

---

## 4. エンドポイント一覧

| # | メソッド | パス | 概要 |
|---|---|---|---|
| 1 | GET | `/me` | プロフィール・プラン・利用量 |
| 2 | PATCH | `/me` | 設定更新 |
| 3 | GET | `/dashboard` | ダッシュボード集約 |
| 4 | GET | `/songs` | 曲一覧 |
| 5 | POST | `/songs` | 曲作成（楽譜アップロードURL発行） |
| 6 | GET | `/songs/{songId}` | 曲詳細 |
| 7 | PATCH | `/songs/{songId}` | 曲更新 |
| 8 | DELETE | `/songs/{songId}` | 曲削除 |
| 9 | POST | `/songs/{songId}/score` | 楽譜の登録完了通知 |
| 10 | GET | `/songs/{songId}/heatmap` | 小節ヒートマップ |
| 11 | GET | `/songs/{songId}/trend` | 指標の時系列 |
| 12 | GET | `/songs/{songId}/stubborn` | 停滞小節 |
| 13 | GET | `/songs/{songId}/takes` | テイク一覧 |
| 14 | POST | `/songs/{songId}/takes` | テイク作成（アップロードURL発行） |
| 15 | GET | `/takes/{takeId}` | テイク詳細 |
| 16 | POST | `/takes/{takeId}/submit` | 解析キューへ投入 |
| 17 | GET | `/takes/{takeId}/events` | 進捗（SSE） |
| 18 | PATCH | `/takes/{takeId}` | ラベル・メモ更新 |
| 19 | DELETE | `/takes/{takeId}` | テイク削除 |
| 20 | GET | `/takes/{takeId}/roll` | ピアノロール |
| 21 | GET | `/takes/{takeId}/audio` | 音声の読み取りSAS |
| 22 | POST | `/takes/{takeId}/retry` | 解析の再実行 |
| 23 | POST | `/takes/{takeId}/coach` | 構造化AI講評の生成（失敗時はフォールバック） |
| 24 | GET | `/takes/{takeId}/compare` | 他テイクとの比較 |
| 25 | POST | `/takes/{takeId}/chat` | AIコーチとの対話（ストリーミング） |
| 26 | GET | `/takes/{takeId}/comments` | コメント一覧 |
| 27 | POST | `/takes/{takeId}/comments` | コメント投稿 |
| 28 | DELETE | `/comments/{commentId}` | コメント削除 |
| 29 | GET | `/songs/{songId}/assignments` | 課題一覧 |
| 30 | POST | `/songs/{songId}/assignments` | 課題作成 |
| 31 | PATCH | `/assignments/{id}` | 課題の状態更新 |
| 32 | GET | `/shares` | 共有リンク一覧 |
| 33 | POST | `/shares` | 共有リンク発行 |
| 34 | PATCH | `/shares/{id}` | 有効/無効の切替 |
| 35 | GET | `/shares/{token}` | 共有ビューのデータ（未認証） |
| 36 | GET | `/practice-plan` | 今日の練習メニュー |

---

## 5. 主要エンドポイントの詳細

### 5.1 曲の作成と楽譜アップロード

楽譜のアップロードはテイクと同じ **SAS 直接アップロード方式**を取る。
API サーバーを経由させないことで、大きなファイルでもサーバーのメモリを消費しない。

PDF（`application/pdf`、最大10MB）は印刷譜だけを受け付ける。ファイル先頭の
`%PDF-`署名を検証し、Audiverisジョブへ投入する。ジョブは生成したMusicXMLを保存して
曲を`reviewing_score`に更新する。ただし、この出力は原本との比較用ドラフトであり、
参照譜生成・演奏分析には使用しない。利用者は正しいMusicXML、MXL、またはMIDIを
差し替えてから分析を開始する。

承認済みの曲では、`GET /songs/{songId}/score/file` が描画用のMusicXMLを、
`GET /songs/{songId}/score/file?format=midi` がブラウザ再生用MIDIを返す。いずれも
曲の所有者だけが取得できる。

#### `POST /songs`

```jsonc
// Request
{
  "title": "ワルツ 第7番 嬰ハ短調 Op.64-2",
  "composer": "F. Chopin",
  "targetTempo": 132,
  "targetDate": "2026-11-03",
  "scoreFileName": "chopin-waltz-64-2.musicxml",
  "scoreFileSize": 184320
}
```

```jsonc
// 201 Created
{
  "songId": "song_01J8...",
  "status": "awaiting_score",
  "upload": {
    "url": "https://st.blob.core.windows.net/scores/usr_.../song_.../source.musicxml?sv=...",
    "method": "PUT",
    "headers": { "x-ms-blob-type": "BlockBlob" },
    "expiresAt": "2026-07-25T14:10:00+09:00"
  }
}
```

| バリデーション | 制約 |
|---|---|
| `title` | 1-200文字 |
| `scoreFileName` | 拡張子 `.musicxml` / `.xml` / `.mxl` / `.mid` / `.midi` |
| `scoreFileSize` | 10 MB 以下 |
| `targetTempo` | 20-300、省略可 |

#### `PATCH /songs/{songId}`

曲の `title`、`composer`、`targetTempo`、`targetDate` を部分更新する。少なくとも1項目を指定する。

#### `DELETE /songs/{songId}`

所有者だけが削除できる。曲ドキュメント、配下のテイク、譜面・録音・派生データのBlobを削除し、操作は元に戻せない。

#### `POST /songs/{songId}/score`

アップロード完了をサーバーに通知する。サーバーは MusicXML を解析し、
繰り返しを展開して `reference.json` を生成する（同期処理、通常 1-3秒）。

```jsonc
// 200 OK
{
  "songId": "song_01J8...",
  "status": "ready",
  "measureCount": 96,
  "scoreMeasureCount": 64,      // 繰り返し展開前
  "keySignature": "c# minor",
  "timeSignature": "3/4",
  "detectedTempo": 132,
  "hasRepeats": true,
  "warnings": [
    { "code": "UNSUPPORTED_ORNAMENT", "message": "装飾音の一部を単純化しました。", "measures": [17, 41] }
  ]
}
```

> `warnings` は失敗ではない。**楽譜の解釈で妥協した箇所をユーザーに開示する**。
> 分析結果への信頼を保つために重要。

パースに失敗した場合は `400 VALIDATION_FAILED` を返し、曲は `awaiting_score` のまま残る。

---

### 5.2 テイクの作成 → アップロード → 投入

これが最も重要なフロー。3ステップに分ける理由は、
**アップロード中にネットワークが切れても、テイクの存在が失われないようにする**ため。

#### `POST /songs/{songId}/takes`

```jsonc
// Request
{
  "label": "通し 3回目",
  "recordedAt": "2026-07-25T13:35:00+09:00",
  "durationSec": 178,
  "requestedMeasureRange": [1, 96],
  "requestedTempo": 120,
  "inputKind": "audio",          // "audio" | "midi"
  "contentType": "audio/webm;codecs=opus",
  "fileSize": 2841600,
  "recordingHints": {
    "metronomeUsed": false,
    "deviceLabel": "MacBook Pro Microphone",
    "agcDisabled": true,
    "sampleRate": 48000
  }
}
```

```jsonc
// 201 Created
{
  "takeId": "take_01J8...",
  "status": "uploading",
  "upload": {
    "url": "https://st.blob.core.windows.net/audio/usr_.../take_.../raw.webm?sv=...",
    "method": "PUT",
    "headers": { "x-ms-blob-type": "BlockBlob" },
    "expiresAt": "2026-07-25T14:10:00+09:00",
    "maxBytes": 104857600
  }
}
```

| バリデーション | 制約 |
|---|---|
| `durationSec` | 5-900 |
| `fileSize` | 100 MB 以下 |
| `requestedMeasureRange` | 曲の小節数の範囲内、`[start, end]` で `start <= end` |
| 月間クォータ | プラン上限を超えると `402 QUOTA_EXCEEDED` |

> `recordingHints.agcDisabled` は**ダイナミクス指標の信頼度に直結する**。
> ブラウザで AGC を無効化できなかった場合、サーバーは dynamics の
> `confidence` を下げ、講評でも言及を控える。

#### `POST /takes/{takeId}/submit`

```jsonc
// 202 Accepted
{
  "takeId": "take_01J8...",
  "status": "queued",
  "estimatedSeconds": 75,
  "queuePosition": 2
}
```

`estimatedSeconds` は「録音長 × 係数 + キュー待ち」の推定値。
UI のプログレス表示に使う。**正確である必要はないが、桁が外れないこと**が重要。

呼び出し時に Blob が存在しない場合は `400 VALIDATION_FAILED`（`details.reason: "blob_missing"`）。

---

### 5.3 進捗の取得

#### `GET /takes/{takeId}/events`（SSE）

```
event: status
data: {"status":"transcribing","progress":0.25,"estimatedSeconds":55}

event: status
data: {"status":"aligning","progress":0.55,"estimatedSeconds":30}

event: status
data: {"status":"reviewing","progress":0.9,"scoresReady":true}

event: done
data: {"status":"completed"}
```

| フィールド | 意味 |
|---|---|
| `progress` | 0-1 の概算。ステージごとの固定重みから算出 |
| `scoresReady` | `true` なら講評を待たずに結果画面へ遷移してよい |

接続は最大10分で切る。SSE が使えない環境では `GET /takes/{takeId}` を3秒間隔でポーリングする。

---

### 5.4 テイク詳細

#### `GET /takes/{takeId}`

```jsonc
// 200 OK（完了時、抜粋）
{
  "id": "take_01J8...",
  "songId": "song_01J8...",
  "label": "通し 3回目",
  "recordedAt": "2026-07-25T13:35:00+09:00",
  "durationSec": 178,
  "requestedMeasureRange": [1, 96],
  "playedMeasureRange": [1, 94],
  "requestedTempo": 120,
  "inputKind": "audio",
  "status": "completed",
  "failure": null,

  "overallScore": 78,
  "metrics": {
    "pitch": 91, "rhythm": 74, "tempo": 68,
    "dynamics": 80, "pedal": null
  },
  "metricsNAReason": {
    "pedal": "録音からペダル操作を十分な確度で検出できませんでした。"
  },

  "measureScores": [
    { "measure": 1, "scoreMeasure": 1, "score": 88, "confidence": 0.93,
      "metrics": { "pitch": 96, "rhythm": 84, "tempo": 79, "dynamics": 85,"pedal": null }, "noteCount": 12 }
    // ... 小節数分
  ],

  "issues": [
    { "id": "iss_1", "kind": "rushing", "severity": "high",
      "measures": [19, 20],
      "summary": "2小節にわたり平均 14 BPM 速くなっています。",
      "metric": "tempo" }
  ],

  "curves": {
    "tempo": [{ "measure": 1, "bpm": 118, "target": 120, "excluded": false }],
    "dynamics": [{ "measure": 1, "actual": 0.62, "target": 0.58 }]
  },

  "comparison": {
    "baseTakeId": "take_01J7...",
    "overallDelta": 6,
    "metricDeltas": { "pitch": 3, "rhythm": 9, "tempo": -2,
                      "dynamics": 4, "pedal": null },
    "improvedMeasures": [7, 8, 33],
    "regressedMeasures": [51]
  },

  "aiReview": {
    "promptVersion": "review-1.0",
    "generatedAt": "2026-07-25T13:38:12+09:00",
    "summary": "...",
    "strengths": [{ "text": "...", "measures": [1, 2, 3] }],
    "improvements": [{ "text": "...", "measures": [19, 20], "metric": "tempo" }],
    "practicePlan": [
      { "order": 1, "measures": [19, 20], "tempo": 84,
        "method": "片手ずつ", "durationMin": 10, "reason": "..." }
    ]
  },

  "analysis": {
    "pipelineVersion": "0.3.0",
    "metricsVersion": "1.0",
    "transcriptionModel": "bytedance-piano-v2",
    "alignmentConfidence": 0.88,
    "matchRate": 0.94,
    "processedAt": "2026-07-25T13:37:40+09:00",
    "durationMs": 61240
  },

  "memo": "左手のバランスを意識した",
  "links": {
    "roll": "/api/takes/take_01J8.../roll",
    "audio": "/api/takes/take_01J8.../audio",
    "score": "/api/songs/song_01J8.../score-file"
  }
}
```

**未完了時**は `overallScore`, `metrics`, `measureScores`, `issues`, `curves`, `aiReview` が
`null` または空配列で返り、`status` が進行中の値になる。
クライアントは `status` で分岐する。

**`links` を返す理由**: クライアントが URL を組み立てないで済むようにする。
将来 Blob の直接 URL に切り替えても、クライアントの変更が不要になる。

---

### 5.5 大きなデータ

#### `GET /takes/{takeId}/audio`

```jsonc
// 200 OK
{
  "url": "https://st.blob.core.windows.net/audio/...?sv=...",
  "contentType": "audio/webm",
  "expiresAt": "2026-07-25T13:55:00+09:00"
}
```

有効期限は15分。UI は期限が近づいたら再取得する。

#### `GET /takes/{takeId}/roll`

ピアノロール（音符イベント列）。数千件になりうるので独立エンドポイントにしている。

```
GET /takes/{takeId}/roll?fromMeasure=17&toMeasure=24
```

```jsonc
// 200 OK
{
  "measureRange": [17, 24],
  "performed": [
    { "pitch": 61, "onset": 34.21, "offset": 34.58, "velocity": 0.72,
      "measure": 17, "beat": 1.0, "match": "correct", "refIndex": 204 }
  ],
  "reference": [
    { "pitch": 61, "measure": 17, "beat": 1.0, "durationBeats": 0.5,
      "expectedVelocity": 0.7, "index": 204 }
  ],
  "beatMap": [{ "time": 34.10, "beat": 48.0 }],
  "pedal": [{ "start": 34.10, "end": 35.95, "confidence": 0.41 }]
}
```

| `match` の値 | 意味 |
|---|---|
| `correct` | 参照音符と対応した |
| `extra` | 余分な音（参照になし） |
| `wrongPitch` | 音程違い |

参照側で対応する演奏音がないものは `performed` に現れず、`issues` の `missed` として報告される。

Cache-Control: `private, max-age=3600`（テイクは不変なので長めにキャッシュしてよい）。

---

### 5.6 比較

#### `GET /takes/{takeId}/compare?with={otherTakeId}`

`with` を省略すると直前のテイクと比較する。

```jsonc
// 200 OK
{
  "a": { "takeId": "take_01J7...", "label": "通し 2回目", "recordedAt": "...", "overallScore": 72 },
  "b": { "takeId": "take_01J8...", "label": "通し 3回目", "recordedAt": "...", "overallScore": 78 },
  "overallDelta": 6,
  "metricDeltas": { "pitch": 3, "rhythm": 9, "tempo": -2, "dynamics": 4, "pedal": null },
  "measureDeltas": [
    { "measure": 19, "a": 48, "b": 47, "delta": -1, "confidence": 0.86 }
  ],
  "improved": [{ "measure": 7, "delta": 18 }],
  "regressed": [{ "measure": 51, "delta": -12 }],
  "note": "小節 62-70 は片方のテイクで演奏されていないため比較対象外です。"
}
```

**両方のテイクで演奏され、かつ両方の `confidence >= 0.5` を満たす小節のみ**を比較する。
除外した理由は `note` で開示する。

---

### 5.7 AIコーチ

#### `POST /takes/{takeId}/review`

講評の再生成。

```jsonc
// Request
{ "focus": "tempo" }     // 省略可。指定すると特定指標に絞った講評
```

| ルール | 内容 |
|---|---|
| レート制限 | 同一テイクにつき 1日3回 |
| 課金 | 無料プランでは 1テイク1回のみ |
| 失敗時 | 既存の `aiReview` は保持したまま `503 UPSTREAM_UNAVAILABLE` |

#### `POST /takes/{takeId}/chat`

```jsonc
// Request
{
  "messages": [
    { "role": "user", "content": "19小節が速くなるのはなぜですか？" }
  ]
}
```

レスポンスは `text/event-stream`。

```
event: delta
data: {"text":"19小節は"}

event: delta
data: {"text":"跳躍を含むため"}

event: citation
data: {"measures":[19,20],"metric":"tempo"}

event: done
data: {"tokens":412}
```

| 制約 | 値 |
|---|---|
| 履歴の保持 | サーバー側で直近20往復。それ以前は要約 |
| レート制限 | 20メッセージ / 時 / ユーザー |
| コンテキスト | サーバーが分析結果を自動注入する。クライアントは送らない |

> **クライアントに分析結果を送らせない理由**: 改竄の防止と、
> プロンプトの構成をサーバー側だけで変更できるようにするため。

---

### 5.8 停滞小節と練習メニュー

#### `GET /songs/{songId}/stubborn`

```jsonc
// 200 OK
{
  "songId": "song_01J8...",
  "windowTakes": 5,
  "items": [
    {
      "measure": 19,
      "scoreMeasure": 19,
      "recentScores": [46, 49, 47, 48, 47],
      "slope": 0.2,
      "songSlope": 3.4,
      "takeCount": 5,
      "diagnosis": {
        "promptVersion": "stubborn-1.0",
        "generatedAt": "2026-07-24T21:02:00+09:00",
        "hypothesis": "...",
        "suggestion": "...",
        "differsFromPrevious": true
      }
    }
  ]
}
```

判定条件は [評価指標定義 6.2](./metrics.md#62-停滞小節の検出) に従う。
`diagnosis` は同一小節につき7日に1回しか再生成しない（生成済みならそれを返す）。

#### `GET /practice-plan`

ダッシュボードの「今日の練習メニュー」。全曲を横断して優先度順に返す。

```jsonc
// 200 OK
{
  "generatedAt": "2026-07-25T07:00:00+09:00",
  "totalMinutes": 35,
  "items": [
    { "order": 1, "songId": "song_01J8...", "songTitle": "ワルツ 第7番",
      "measures": [19, 20], "tempo": 84, "method": "片手ずつ",
      "durationMin": 10, "reason": "5テイク連続で停滞しています。" }
  ]
}
```

---

### 5.9 共有とコメント

#### `POST /shares`

```jsonc
// Request
{
  "scope": "song",              // "song" | "take"
  "songId": "song_01J8...",
  "takeId": null,
  "expiresInDays": 90,
  "allowComments": true,
  "label": "○○先生"
}
```

```jsonc
// 201 Created
{
  "id": "share_01J8...",
  "token": "8fJ2n...",
  "url": "https://ledgerlines.app/s/8fJ2n...",
  "expiresAt": "2026-10-23T13:40:00+09:00",
  "enabled": true
}
```

**トークンは発行時のみ全体を返す。**一覧では先頭6文字＋マスクで返す。

#### `POST /takes/{takeId}/comments`

```jsonc
// Request
{
  "measure": 19,               // null なら全体コメント
  "body": "ここは左手を先に置くつもりで。",
  "replyTo": null
}
```

| ルール | 内容 |
|---|---|
| 本文 | 1-2000文字 |
| `measure` | 演奏済みの小節範囲内 |
| 共有経由 | `POST /shares/{token}/comments` を使う。`allowComments` が false なら 403 |
| 通知 | 曲の所有者にメール通知（設定でオフ可） |

---

### 5.10 ダッシュボード

#### `GET /dashboard`

複数リソースを1回で返す集約エンドポイント。**画面の初期表示を1リクエストで済ませる**。

```jsonc
// 200 OK
{
  "streakDays": 12,
  "thisWeek": { "takeCount": 9, "practiceMinutes": 214 },
  "songs": [
    {
      "songId": "song_01J8...",
      "title": "ワルツ 第7番 嬰ハ短調 Op.64-2",
      "composer": "F. Chopin",
      "targetDate": "2026-11-03",
      "daysLeft": 101,
      "takeCount": 14,
      "latestScore": 78,
      "scoreDelta": 6,
      "trend": [62, 65, 64, 70, 72, 78],
      "weakMeasures": [19, 20, 51],
      "lastPracticedAt": "2026-07-25T13:35:00+09:00"
    }
  ],
  "practicePlan": { /* GET /practice-plan と同形式（上位3件） */ },
  "quota": { "plan": "free", "usedTakes": 3, "limitTakes": 5, "resetsAt": "2026-08-01T00:00:00+09:00" }
}
```

> REST の純度より**初期表示の速さ**を優先した数少ない例外。
> 各フィールドは `songs.summary`（非正規化済み）から取れるため、Cosmos への問い合わせは1回で済む。

---

## 6. レート制限

| 対象 | 制限 | 単位 |
|---|---|---|
| 全 API | 300 req / 分 | ユーザー |
| `POST /takes` | プランの月間上限 | ユーザー |
| `POST /takes/{id}/review` | 3 / 日 | テイク |
| `POST /takes/{id}/chat` | 20 / 時 | ユーザー |
| `GET /shares/{token}` | 60 / 分 | トークン + IP |
| `POST /shares/{token}/comments` | 10 / 時 | トークン |

超過時は `429` と以下のヘッダを返す。

```
Retry-After: 42
X-RateLimit-Limit: 20
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1785308400
```

---

## 7. バージョニング

| 方針 | 内容 |
|---|---|
| 破壊的変更 | パスに含める（`/api/v2/...`）。MVP 中は `v1` 固定で、パス上は省略 |
| 非破壊的追加 | フィールド追加は随時。クライアントは未知フィールドを無視する |
| 廃止 | `Deprecation` / `Sunset` ヘッダで最低90日前に予告 |
| 分析ロジックの変更 | API のバージョンとは独立。`analysis.metricsVersion` で識別する |

> **`metricsVersion` を分けるのが重要。**
> 指標の定義を改訂すると過去テイクとスコアが比較できなくなるため、
> UI は異なるバージョン間の比較で警告を出す（[評価指標定義 8章](./metrics.md#8-較正計画m4)）。

---

## 8. PoVモックとの対応

PoVモックは `src/lib/mock/generate.ts` でデータを生成しているが、
本仕様の型と一致させておくと本実装への移行が容易になる。

| モック | 本 API | 差分 |
|---|---|---|
| `getSong(id)` | `GET /songs/{id}` | ほぼ同じ |
| `getTake(id)` | `GET /takes/{id}` | `status` / `failure` / `confidence` / `links` が追加 |
| `getTakes(songId)` | `GET /songs/{id}/takes` | ページングが追加 |
| （なし） | `GET /takes/{id}/roll` | モックは take に同梱している。本実装では分離 |
| （なし） | `POST /takes/{id}/submit` | モックに解析フローがない |
| （なし） | `GET /takes/{id}/events` | 同上 |

**移行方針**: `src/lib/api/` に本仕様のクライアントを作り、
モックはその実装差し替え（MSW など）で残す。画面側のコードは変えない。

---

## 9. 未決事項

| # | 論点 | 決定時期 |
|---|---|---|
| Q1 | ピアノロールの転送形式（JSON か、バイナリか） | M4。音符数が1万を超えると JSON が重い |
| Q2 | チャット履歴を永続化するか（現状はセッション内のみ） | M5。コストとプライバシーの兼ね合い |
| Q3 | 課題（assignment）を先生が作れるようにするか | MVP 後。現状は共有ビューは読み取り＋コメントのみ |
| Q4 | Webhook（解析完了通知）の提供 | 将来。教室向け機能として |

---

## 10. 関連ドキュメント

- [機能仕様](./functional.md)
- [評価指標定義](./metrics.md)
- [データモデル設計](../design/data-model.md)
- [分析パイプライン設計](../design/analysis-pipeline.md)
- [AIプロンプト設計](../design/ai-prompts.md)
- [Azureアーキテクチャ設計](../design/architecture.md)
