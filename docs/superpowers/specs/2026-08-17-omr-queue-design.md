# PDF の OMR をキュー経由でデプロイ環境で実行する（Issue #45）

## 1. 何を直すのか

`src/app/api/songs/[songId]/score/route.ts:52-53` は、azure バックエンド（本番・
エミュレータ）で PDF を受け取ると 202 を返して終わる。**OMR を実行する主体が
いない。**

```ts
if (getConfig().storageBackend === "azure") {
  return jsonResponse({ songId, status: "converting_score", uploadComplete: true }, request, { status: 202 });
}
const result = await runOmrWorker(songId);   // ローカルの .data バックエンドだけ
```

結果として曲は `converting_score` のまま永久に留まり、SSE は `converting_score` を
非終端扱い（`src/lib/score-progress.ts:20-27`）なので10分の時間上限まで Cosmos を
毎秒読み続けた末に「解析が完了しませんでした」と表示する。

これは #33（参照譜生成）と同一の構造で、ローカルに Python があることを前提にした
経路が唯一の実装になっている。#33 は `score-jobs` キューで解いた。同じ形で解く。

## 2. この変更で得られるもの／得られないもの

**得られる**: 本番でも PDF から OMR ドラフトが生成され、ブラウザに描画される。
利用者は手元の原本と見比べられる。

**得られない**: そのドラフトで録音・分析はできない。これは欠落ではなく**意図した
仕様**である（`docs/spec/api.md:262-264`）。前へ進む道は正しい MusicXML / MXL /
MIDI への差し替えのみ（`VerifiedScoreReplacement`）。

- `POST /songs/{songId}/takes` は `scoreSource === "pdf"` の録音を拒否する
  （`src/app/api/songs/[songId]/takes/route.ts:41`）
- `POST /songs/{songId}/score/approve` は何も承認せず、PDF なら差し替えを促す
  文言で `ValidationError` を返すだけの案内窓口（クライアントからの呼び出しは無い）

**`docs/spec/api.md:278` の status 表は「OMR結果をユーザーが承認するまで待機中の
ドラフト」と書いており、同じ節の本文と食い違っている。** 承認して採用する経路は
存在しない。この文言は古い想定の残りなので、本文と一致させる。

## 3. コスト（着手判断の前提として記録する）

- **Audiveris は AGPL-3.0。** 公開イメージ（GHCR）に同梱してネットワーク越しに
  サービス提供する形になるため、**§13 の義務が関わるかの確認が必要**。本設計は
  法的判断を行わない。実装側では「同梱物のバージョン・ライセンス・ソース入手元」を
  追跡できる形で記録する
- ワーカーイメージに Java（headless JRE）＋ Audiveris ＋ tessdata が増える
- 新しいキュー・IaC・runbook の追加

## 4. 設計

### 4.1 キューは分ける（`omr-jobs`）

Audiveris は既定タイムアウト300秒（`worker_main.py:218` の
`AUDIVERIS_TIMEOUT_SECONDS`）。`score-jobs` に混ぜると参照譜生成（数秒、利用者が
SSE のスピナーで見ている）がその後ろで待たされる。

- 環境変数 `AZURE_OMR_QUEUE`。**未設定・空文字のとき既定値 `omr-jobs` へ
  フォールバックする**（`cloud_worker.py:44-51` の `score_queue_name()` と同じ形）。
  CD は `az containerapp update --image` だけを行い Bicep を流さないため、
  `required()` にするとワーカーが再起動ループに入り、動いている解析パイプラインまで
  落とす（#33 で踏んだ Critical と同型）
- `infra/main.bicep` の `queues` に `omr-jobs` を追加
- `docs/operations/iac-runbook.md` §5.1 に「アプリより先に `azd provision`」を追記

### 4.2 ワーカーのループ

現在の `main()`（`cloud_worker.py:333-357`）は「score を見る → analysis を見る →
無ければ sleep」の形。OMR を足すため、解析側の処理も真偽を返すヘルパーへ抽出して
優先順位を明示する。

```
while True:
    if _drain_score_queue(...):    continue   # 参照譜生成（数秒、利用者が待っている）
    if _drain_analysis_queue(...): continue   # 演奏分析（数分、このアプリの中心価値）
    if _drain_omr_queue(...):      continue   # OMR（数分、プレビューの下書き）
    time.sleep(polling_seconds)
```

**OMR を最後に置く。** OMR はプレビューの下書きであり、採点を遅らせてはいけない。
解析が続けて届く間 OMR が待たされるのは受け入れる（レプリカ1・ループ1本という
既知の制約は設計 §4.2 に既記載）。

抽出は**挙動を変えない**こと。現在の解析分岐は「メッセージが無ければ sleep して
continue」なので、そのまま移すと OMR に制御が届かない。

- `WORKER_OMR_VISIBILITY_TIMEOUT_SECONDS`（既定 900）。Audiveris 300 秒に
  ダウンロード・アップロードとプレビュー生成を足した余裕を取る

### 4.3 OMR ジョブの純ロジック

`worker/ledgerlines_worker/omr_job.py`（新規）。`score_job.py` と同じ方針で
**azure.\* を import しない**ため、ワーカーイメージ外でも単体テストが動く。

```python
process_omr_job(store, job, dequeue_count, work_dir, run_omr) -> str
```

- 戻り値の意味は `process_score_job` と同一（`"completed"` / `"failed"` /
  `"skipped"` / `"exhausted"` は削除してよい。再配信させたい失敗は例外で送出）
- 曲が取得できない、または **`converting_score` 以外なら `"skipped"`**（再配信の
  重複、利用者が差し替えて別ジョブが処理済み）
- PDF を `work_dir` にローカル配置と同じ形で materialize し、**既存の
  `run_omr(work_dir, song_id)` をそのまま呼ぶ**。OMR のアルゴリズムを再実装しない
  （`poc` の複製で踏んだ失敗を繰り返さない）
- 成功: `run_omr` が書いた `score.{ext}` とプレビュー（`previewScoreFileName` /
  `previewMidiFileName`）をアップロードし、曲を **`reviewing_score`** ＋
  `scoreFileName` / `scoreSource: "pdf"` / `omrEngine` / `omrError: null` /
  `previewScoreFileName` / `previewMidiFileName` / `warnings` で確定する。
  **プレビューのファイル名は `run_omr` の出力から読む**（決め打ちしない。
  `process_score_job` と同じ理由）
- 失敗: **`omr_failed` ＋ `omrError`** に落として終端する。`awaiting_score` では
  ない——`omr_failed` が仕様上の OMR の終端状態（`api.md:278`）で、SSE も終端として
  扱う
- 試行上限は `score_job.MAX_ATTEMPTS` と同じ 3。上限到達時も `omr_failed`。
  `songId` / `userId` が取れないときは `"skipped"`（`process_score_job` と同じ理由）

### 4.4 Web 側

- `score/route.ts` の PDF 分岐: azure バックエンドで **OMR ジョブを enqueue する**。
  `getScoreQueue()` と同じ形の `getOmrQueue()`（`LocalOmrQueue` は既存の
  `runOmrWorker` を spawn、`AzureOmrQueue` は `omr-jobs` に送信）。ローカル
  バックエンドの同期実行の挙動は変えない
- `scoreReplacementReason`（`src/app/songs/[id]/page.tsx`）が `converting_score` で
  `null` を返すため、**変換中に止まった曲には差し替え導線が出ない**。削除以外の
  復旧手段が無い状態なので、`converting_score` を差し替え可能として扱う

### 4.5 ライセンスの追跡

- `worker/README.md` に Audiveris の**バージョン・AGPL-3.0・ソース入手元**を記載
- イメージ内にライセンス本文を置き、置き場所を README に書く

## 5. 検証

### 5.1 できること

- イメージをローカルでビルドし、`audiveris` が起動することを確認する
- **失敗経路の実走**: 楽譜でない最小の PDF を入力に与え、Audiveris が譜表を
  見つけられずに失敗し、曲が `omr_failed` ＋ `omrError` に落ちることを確認する
- `process_omr_job` の分岐（skipped / completed / failed / exhausted）をフェイク
  ストアで単体テスト
- ワーカーのループ抽出が挙動を変えていないことをテストで固定

### 5.2 できないこと

**リポジトリに楽譜 PDF のフィクスチャが無く**、MusicXML から PDF を作る手段
（MuseScore / LilyPond）もこの環境に無い。したがって**成功経路（実際の楽譜 PDF が
MusicXML に変換される）は未検証のまま残る。**

楽譜 PDF が提供されれば同じ手順で成功経路まで確認できる。**未検証であることを
結果に明記し、検証済みのように書かない。**

## 6. スコープ外

- 承認フロー（`reviewing_score → ready`）の実装。仕様上、OMR ドラフトを採用する
  経路は存在しない（§2）
- PDF 由来の曲での録音許可（`takes/route.ts:41` の拒否は意図した仕様）
- OMR 専用のワーカーイメージ・Container App への分離。3つ目のデプロイ対象を
  作らない判断（既存イメージは torch ＋164MB チェックポイントで既に大きく、
  増分は相対的に小さい）
- Audiveris の変換品質の改善
