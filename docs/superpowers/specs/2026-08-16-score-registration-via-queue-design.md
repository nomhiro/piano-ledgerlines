# 楽譜登録を Queue 経由に寄せる — 設計

- 日付: 2026-08-16
- 対象: `src/app/api/songs/[songId]/score/route.ts`、`.../score/complete/route.ts`、`src/lib/server/queue.ts`、`worker/cloud_worker.py`、`infra/`、`src/app/songs/new/page.tsx`、`src/components/VerifiedScoreReplacement.tsx`
- 関連: Issue #33（本設計の対象）、#41（ゴール、本件が第1ブロッカー）、#3（本番化の傘。#33 の所有はこちら）
- 参照: `docs/spec/api.md` 5.1、`worker/README.md`「既知の限界」

## 1. 目的

MusicXML / MXL / MIDI をアップロードした曲が `ready` になり、その曲で録音の解析が
できる状態にする。デプロイ済み Web アプリとローカルのエミュレータプロファイルの
両方で成立させる。

## 2. 現状の問題

参照譜（`reference.json`）を生成する経路が、**Node.js のプロセスからローカルの
Python を spawn できること**を前提にしている。

### 2.1 生成経路が開発用フラグ専用になっている

`src/app/api/songs/[songId]/score/route.ts:70-83`

```ts
if (getConfig().storageBackend === "azure") {
  if (process.env.LEDGERLINES_AZURE_CLOUD === "true") {
    const updated = await processCloudScoreLocally(savedSong);   // 参照譜を生成する唯一の経路
    ...
  }
  return jsonResponse({ songId, status: "awaiting_score", uploadComplete: true }, request, { status: 202 });
}
```

`LEDGERLINES_AZURE_CLOUD === "true"` 以外はすべて 202 を返して終わる。曲は
`awaiting_score` のまま残り、`reference.json` が無いため録音の解析も開始できない。

### 2.2 そのフラグは本番・エミュレータのどちらでも立てられない

| 制約 | 箇所 |
|---|---|
| `NODE_ENV === "production"` では `LEDGERLINES_AZURE_CLOUD=true` を拒否 | `src/lib/server/config.ts:162-163` |
| エミュレータ系フラグとの同時指定を拒否 | `src/lib/server/config.ts:165-178` |

デプロイイメージは `ENV NODE_ENV=production` なので、本番では立てられない。
エミュレータプロファイルとも排他である。したがって到達できるのは
`azure:cloud` プロファイル（ローカルの Next.js → 実 Azure ストレージ）だけで、
dev 環境の既存の曲もこの経路で登録されたものと考えられる。

### 2.3 Web イメージに Python が無い

`processCloudScoreLocally` は `runReferenceWorker`（`python worker_main.py --mode reference`
の spawn）に依存する。ルートの `Dockerfile` は `node:20-alpine` で Python も music21 も
含まない。フラグ判定を通したとしても、デプロイ環境では spawn が失敗する。

### 2.4 エミュレータは小節数を捏造して `ready` にしている

`src/app/api/songs/[songId]/score/complete/route.ts:29-38` は、エミュレータのとき
`measureCount: 16` / `detectedTempo: 96` を書いて `ready` にする。参照譜は生成されて
いないため、その曲で録音すると解析が `reference.json` の取得で失敗する。
`ready` という状態の意味（＝分析に使える）が壊れている。

## 3. 方針

参照譜生成を **「API が enqueue → ワーカーが生成 → SSE で UI に反映」の1本**に統合する。
音声解析が既に採っている構造（`analysis-jobs` + `cloud_worker.py`）に揃える。
ワーカーイメージには music21 が入っており、`worker_main.py --mode reference` はそのまま使える。

| 経路 | 現在 | 変更後 |
|---|---|---|
| ローカル（`.data` バックエンド） | API 内で同期 spawn → 200 `ready` | enqueue（`LocalScoreQueue` が非同期 spawn） |
| azure:cloud プロファイル | `processCloudScoreLocally` | **削除**（Queue に一本化） |
| エミュレータ / 本番 | 到達不能（202 `awaiting_score`） | enqueue → ワーカーが生成 |

### 3.1 ローカルバックエンドも非同期に揃える

同期のまま残すと「ローカルでしか通らない参照譜生成の経路」が再び生まれ、#33 と同じ
構造が残る。UI の待ち処理を本番と同じコードで検証できることが、この修正の主目的である。
`LEDGERLINES_STORAGE=local` でも Python の spawn は `LocalScoreQueue` の内部に閉じ、
API から見た契約は本番と同一になる。

### 3.2 却下した案

**Web イメージに Python + music21 を同梱する。** イメージが数百MB増え、Node と Python の
2言語ランタイムを Web に抱えることになる。解析が既に Queue 経由である以上、楽譜処理だけ
Web プロセス内に残す理由が無い。

**既存 `analysis-jobs` にジョブ種別を足して1本のキューで運ぶ。** infra 差分は最小だが、
FIFO のため解析が n 件溜まっていると登録がその全部の後ろに回り、登録画面での待ち時間が
読めなくなる。

**専用キュー＋専用 Container App。** 登録が解析負荷と完全に独立し、常に数秒で `ready` に
なる。ただしデプロイ対象が2つに増え（#12 の CD にも影響）、ワーカーイメージは torch と
164MB のチェックポイントを含むためスケール0からのコールドスタートが遅い。速くするには
music21 だけの軽量イメージを別に作ることになり、ビルド対象が2つになる。
**キューを分けておけば consumer を切り出すだけで後から移行できる**ため、今は採らない。

## 4. 設計

### 4.1 キューとジョブ

新キュー **`score-jobs`** を追加する。

| 変更対象 | 内容 |
|---|---|
| `infra/main.bicep` | `queues` 配列に `score-jobs` を追加 |
| `infra/modules/analysis-worker.bicep` | env に `AZURE_SCORE_QUEUE`、`AZURE_COSMOS_SONGS_CONTAINER`、`AZURE_STORAGE_SCORES_CONTAINER` を追加 |
| `scripts/azure-local.ts` | `createIfNotExists` の対象に追加 |
| `docker-compose.azure-local.yml` | worker の env に追加 |
| `scripts/azure-cloud.ts` | 疎通確認の対象に追加 |

`src/lib/server/queue.ts` に既存 `AnalysisJob` / `AnalysisQueue` と同じ形で追加する。

```ts
export interface ScoreJob {
  schemaVersion: 1;
  jobId: string;
  songId: string;
  userId: string;
  attempt: number;
  correlationId: string;
}
```

`AzureScoreQueue` は `score-jobs` へ送信する。`LocalScoreQueue` は
`runReferenceWorkerAsync` を呼ぶ（既存 `LocalAnalysisQueue` が
`runAnalyzeWorkerAsync` を呼ぶのと同じ構造。プロセス spawn の実装は
ローカルバックエンドの内側に閉じる）。

キューのメッセージは識別子のみを載せる。音声・トークン・SAS URL を載せないという
既存の約束（`queue.ts:45` のコメント）を踏襲する。

### 4.2 ワーカーのポーリング順と単一レプリカの制約

`cloud_worker.py` の `main()` は **`score-jobs` を先に受信し、無ければ `analysis-jobs`**
を見る。両方空なら従来どおり `WORKER_POLLING_SECONDS` だけ待つ。

ワーカー Container App は `minReplicas: 1 / maxReplicas: 1`
（`infra/modules/analysis-worker.bicep:73-76`）の単一レプリカ・単一ループである。
**優先ポーリングは「キューに溜まった解析ジョブ」を追い越せるが、「実行中の解析ジョブ」は
追い越せない。** したがって解析中に登録した曲は、その解析が終わるまで（最長で解析1件ぶん、
数分）`parsing_score` のまま待つ。これは本設計の既知の性質であり、解消するには
§3.2 の「専用 Container App」へ移行する。

visibility timeout は参照譜生成用に **300秒**（`WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS`、
既定 300）。解析の 1800 秒とは別に持つ。

### 4.3 リトライ上限

既存の解析ジョブは「失敗したらメッセージを削除しない」だけで、再配信に任せている。
参照譜生成では**これだけでは不十分**である。壊れた MusicXML は決定論的に失敗するため、
曲が永久に `parsing_score` のまま再配信され続ける。

Azure Storage Queue のメッセージが持つ `dequeue_count` を見て、**`dequeue_count >= 3`
（3回目の受信）で `awaiting_score` + `lastScoreError` を書いてメッセージを削除する**。
つまり試行は最大3回。ユーザーには「解析できなかったので差し替えてほしい」という
終端状態が見える。

### 4.4 ワーカーの参照譜処理

`cloud_worker.py` に `process_score_job` を追加する。処理内容は
`src/lib/server/cloud-score-processing.ts` (`processCloudScoreLocally`) と同一で、移植である。

1. Cosmos から曲を読む。**status が `parsing_score` でなければスキップ**して削除
   （冪等性。既存 `process_job` が `completed` のテイクをスキップするのと同じ形）
2. 一時領域に `songs/{songId}.json` と `scores/{songId}/score.<ext>` を用意する
3. `run_reference(data_dir, song_id)` を実行する
4. 成功: derived コンテナへ `users/{userId}/songs/{songId}/reference.json`、scores コンテナへ
   `users/{userId}/songs/{songId}/scores/preview.musicxml` と同 `/preview.mid` を
   アップロードし（Blob 名は `cloud-score-processing.ts:40-57` と同一）、Cosmos の曲を
   `ready` と各メタデータ（`measureCount` / `scoreMeasureCount` / `keySignature` /
   `timeSignature` / `detectedTempo` / `hasRepeats` / `warnings` /
   `previewScoreFileName` / `previewMidiFileName`）で更新する
5. 失敗: Cosmos の曲を `awaiting_score` + `lastScoreError` で更新する
   （`run_reference` は既にこの形をローカル JSON へ書いているので、それを Cosmos へ写す）

`CloudStore` には **songs コンテナ**（Cosmos）と `get_song` / `update_song`、および
`score_queue` を追加する。現在 worker の env には songs コンテナが渡っていないため、
Bicep 側の追加が前提になる（§4.1）。

### 4.5 API 契約

| エンドポイント | 変更 |
|---|---|
| `POST /api/songs/{songId}/score` | 保存 → `status: "parsing_score"` → enqueue → **202 `{songId, status: "parsing_score"}`**。`storageBackend` と `LEDGERLINES_AZURE_CLOUD` の分岐を廃止 |
| `POST /api/songs/{songId}/score/complete` | 同じ形。**エミュレータの `measureCount: 16` 捏造（§2.4）を削除** |
| `GET /api/songs/{songId}/events` | **新設**（SSE） |

`SongDocStatus`（`src/lib/server/types.ts:9`）と `ApiSong["status"]`
（`src/lib/api/client.ts:10`）に **`parsing_score`** を追加する。`awaiting_score` の
流用は採らない ——「まだ楽譜が無い曲」と「解析中の曲」が同値になり、曲ライブラリ側でも
状態が読めなくなる。

`GET /api/songs/{songId}/events` は `src/app/api/takes/[takeId]/events/route.ts` と
同じ形で実装する（サーバー側で1秒ごとに読み、SSE で流す。上限に達したら打ち切る）。

`done` を送って閉じる条件は **`ready` / `awaiting_score`（失敗）/ `omr_failed` /
`reviewing_score`**。`reviewing_score` は PDF のドラフトをユーザーが承認するまで
進まない状態なので、待ち続けても意味が無く終端として扱う。`converting_score`（PDF の
OMR 実行中）は本設計のスコープ外で、azure バックエンドでは誰も処理しないため進まない ——
待機を続けて上限で打ち切られる。PDF を Queue 化する別 issue でここも終端条件に加わる。

**この SSE は真の push ではない。** サーバー側の1秒ポーリングを SSE として配信している
だけであり、Cosmos の読み取り回数はクライアントポーリングと変わらない。真の push には
Cosmos change feed に加えてブラウザへの配信経路（Web PubSub / SignalR）が必要になる。
誤解を防ぐため、この事実をルートのコメントに明記する。今の規模（登録は1回数秒〜数分、
同時待機はごく少数）では不要と判断する。

`docs/spec/api.md` 5.1 を非同期契約に更新する。現在は「サーバーは MusicXML を解析し …
（同期処理、通常 1-3秒）」「200 OK で `status: "ready"`」と書かれており、実装と契約の
両方が変わる。

### 4.6 UI

待ち処理は2箇所で必要になる。`VerifiedScoreReplacement.tsx:18` は
`result.status !== "ready"` で例外を投げており、非同期化でそのまま壊れる。

- **共有フック `useSongScoreProgress(songId)`** を切り出し、`songs/new` と
  `VerifiedScoreReplacement` の両方から使う。EventSource の開閉と、`ready` / 失敗の
  判定をここに閉じる
- `songs/new`: `parsing_score` を受けたら SSE で待ち、`ready` で現在の
  「N小節 / 拍子 / 調 を認識しました」を表示する（`page.tsx:192-212` の表示はそのまま使える）。
  失敗時は `lastScoreError` を表示して再アップロードへ誘導する

### 4.7 削除するもの

| 対象 | 理由 |
|---|---|
| `src/lib/server/cloud-score-processing.ts`（ファイルごと） | Queue に一本化するため経路自体が不要 |
| score ルートの `LEDGERLINES_AZURE_CLOUD` 分岐 | 同上。**フラグ自体は残す**（`azure-credential.ts:10`、`config.ts` のガード、`scripts/azure-cloud.ts` で使用中） |
| `score/complete/route.ts:29-38` のエミュレータ捏造 | §2.4 |

`scripts/azure-local-smoke.ts` の HTTP スモークは捏造の削除で壊れる
（`POST /songs/{songId}/takes` は `song.status === "ready"` を要求する。
`src/app/api/songs/[songId]/takes/route.ts:44-46`）。**実在の MusicXML
（`public/scores/etude-in-a-minor.musicxml`）をアップロードし、`ready` になるまで待つ形に
変更する。** これによりスモークが #33 の再発を検出できるようになる。

## 5. テストと検証

### 5.1 ワーカー

`process_score_job` の単体テスト（Blob / Cosmos をフェイクに差し替え）。

1. 成功 — `reference.json` と preview 2種がアップロードされ、曲が `ready` と各メタデータで更新される
2. パース失敗 — 曲が `awaiting_score` + `lastScoreError` になる
3. `dequeue_count` 超過 — `awaiting_score` にしてメッセージを削除する（§4.3）
4. status が `parsing_score` 以外 — 何もせずスキップする（§4.4-1）

### 5.2 TypeScript

1. `POST /score` が 202 + `parsing_score` を返し、`ScoreQueue` に enqueue する
2. `POST /score/complete` が同じ形になり、`measureCount` を書かない
3. SSE ルートが `ready` / 失敗 / 上限で閉じる

### 5.3 手動検証（#33 の完了条件）

**エミュレータプロファイル（`npm run azure:up` / `azure:start`）で、`worker/README.md` の
回避策を使わずに mxl をアップロードして `ready` になり、その曲で録音して解析が完走すること。**

併せて `npm run test:production` / `npx tsc --noEmit` / `npm run lint` / `npm run build`、
ワーカーの pytest。

## 6. スコープ外

**PDF / OMR。** `runOmrWorker` も同じ構造の問題を抱えている（`score/route.ts:51-53` が
azure バックエンドで 202 を返して終わる）。ワーカーイメージに Audiveris が入っておらず、
AGPL-3.0 の義務確認も別途必要なため、別 issue として起票する。

**真の push（Web PubSub / Cosmos change feed）。** §4.5 の判断による。教室で先生が生徒の
解析をリアルタイムに見るような、レプリカ間ブロードキャストが要る要件が実際に出た時点で起票する。

**繰り返し展開。** `hasRepeats: False` 固定のままとする（#37）。

**総合スコアが数値にならない問題。** 参照譜が生成できても `overallScore` は `null` のまま
である（#40）。#41 の完了条件2はそちらで解く。
