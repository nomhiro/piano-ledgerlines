# OMR キューをエミュレータで実走させた結果

測定日: 2026-08-17
Issue: #45（PDF の OMR をデプロイ環境で実行できるようにする）
計画: `docs/superpowers/plans/2026-08-17-omr-queue.md` Task 7
ブリーフ: `.superpowers/sdd/2026-08-17-omr-queue/task-7-brief.md`

**この文書は実走の記録であり、Audiveris の採譜品質の評価ではない。** 確認したのは
「配線が通り、状態が終端し、成果物が置かれるか」であり、認識結果の正しさは対象外
（ブリーフの明示的な指示）。**測っていない値は測ったと書かない。**

---

## 0. 前提として直した設定の抜け（Task 7 の担当分）

Task 3〜5 が `AZURE_OMR_QUEUE` / `WORKER_OMR_VISIBILITY_TIMEOUT_SECONDS` をコード側の
既定値に頼ったまま、兄弟の設定が明示されている場所で明示していなかった2箇所。両方とも
コード既定値で動くためブロッキングではないが、ファイル自身の流儀と揃えた。

1. **`docker-compose.azure-local.yml`（worker サービスの environment）**: 既に
   `AZURE_ANALYSIS_QUEUE: analysis-jobs` / `AZURE_SCORE_QUEUE: score-jobs` が明示されていたので、
   同じ形で `AZURE_OMR_QUEUE: omr-jobs` を追加した。
2. **`infra/modules/analysis-worker.bicep`**: 既に
   `{ name: 'WORKER_SCORE_VISIBILITY_TIMEOUT_SECONDS', value: '300' }` が明示されていたので、
   同じ形で `{ name: 'WORKER_OMR_VISIBILITY_TIMEOUT_SECONDS', value: '900' }` を追加した
   （`AZURE_OMR_QUEUE` 自体は既に65行目にあり、抜けていたのはタイムアウトの方だけだった）。

`az bicep build --file infra/main.bicep --stdout` は成功した（既存の `monitoring.bicep` の
`sku` 警告のみで、今回の変更に起因するエラー・警告は無し）。

---

## 1. イメージサイズの増分（Task 1 の実測値、引用）

```
$ docker images ledgerlines-worker --format '{{.Tag}} {{.Size}}'
omr        3.49GB
omr-before 3.24GB
```

**増分: 約0.25GB（約250MB）。** Task 1 の担当者が自分の手で実測した値（`task-1-report.md`）。
本タスクでは再実測していない。

## 2. Audiveris の起動確認

Task 1 の報告にある `-help` の出力に加え、本タスクでも稼働中のワーカーコンテナ
（`restore-performance-scores-worker-1`、Task 1〜6 のコードを含めて `--build` で再ビルドした
イメージ）で実機再確認した。

```
$ docker exec restore-performance-scores-worker-1 sh -c '"$AUDIVERIS_COMMAND" -help; echo "exit=$?"'
Syntax:
    audiveris [OPTIONS] [--] [INPUT_FILES]
...
Options:
 -batch                      : Run with no graphic user interface
 -constant key=value         : Define an application constant
 -export                     : Export MusicXML
 -force                      : Force step/transcribe re-processing
 -help                       : Display general help then stop
 -output <output-folder>     : Define base output folder
 ...
exit=0
```

`worker_main.py` の `run_omr` が実際に使う `-batch` / `-export` / `-output` の3つとも一覧に
存在し、`exit=0`。`command not found` やクラスロードエラーは発生していない。

---

## 3. 実走環境

- ワーカーは `docker compose -f docker-compose.azure-local.yml up -d --build worker` で
  `worker/Dockerfile` から再ビルドしたイメージ（3.49GB、Audiveris 同梱後）で起動した。
  **`npm run azure:up` だけでは Task 1〜6 のコードを含む新イメージは拾わない**ことを確認済み
  （再ビルド前のコンテナは `restore-performance-scores-worker:latest` = 3.24GB のままで、
  Audiveris 未同梱の状態だった）。
- `npm run azure:init` を先に実行し、`omr-jobs` / `analysis-jobs` / `score-jobs` の3キューが
  Azurite に作られていることを `@azure/storage-queue` の `listQueues()` で直接確認した。
  ワーカー起動後のログでも3キュー全てへの `GET .../messages` ポーリングを確認した。
- Web は既存の `npm run azure:start`（ポート3002、Cosmos/Azurite 実機、development 認証）で
  稼働していた既存プロセスをそのまま使った。`GET /api/songs` の応答に `_rid` / `_self` /
  `_etag`（Cosmos 特有のフィールド）が入っていることで azure プロファイルであることを確認済み。

---

## 4. 失敗経路の実走結果（ブリーフ Step 1〜3）

**PDF**: スクラッチ領域に作った最小PDF（`%PDF-1.4` 署名、`Catalog`/`Pages`/`Page` オブジェクトのみ、
楽譜要素なし）。リポジトリにはコミットしていない。

**曲**: `song_031875b1532b44db96b2`

| 時刻 (UTC) | 事象 |
|---|---|
| 12:45:15.901 | `POST /api/songs/{id}/score` に PDF を送信、202 応答、`status: "converting_score"` |
| 12:45:40〜 | ワーカーが `omr-jobs` からジョブをデキュー、Audiveris 実行 |
| 12:45:46 | `RuntimeError: Audiveris exited with code 1`（`worker_main.py:229`） |
| 12:45:46.692 | ワーカーログ: `OMR job 221ec2d4-e80c-4011-a181-5aeb73d757a1 outcome=failed song=song_031875b1532b44db96b2` |
| 12:45:46 | 曲の `updatedAt` が更新、`status: "omr_failed"` |

最終状態（`GET /api/songs/{id}`）:

```json
{
  "status": "omr_failed",
  "scoreFileName": "not-a-score.pdf",
  "omrEngine": "audiveris",
  "omrError": "Audiveris exited with code 1"
}
```

`omrError` の実際の文言は **`"Audiveris exited with code 1"`**。ワーカーログの
`result.stderr.strip() or f"Audiveris exited with code {result.returncode}"`
(`worker_main.py:229`) を確認したところ、この PDF に対する Audiveris の stderr は空文字列
だったため、後者（フォールバック文言）が採用されている。

**確認できたこと**:
- `converting_score` → `omr_failed` へ遷移した。永久に `converting_score` に留まる挙動は
  再現しなかった。
- `omrError` に文字列が入り、`null` ではなかった。
- `GET /api/songs/{id}/events`（SSE）に接続したところ、`status` イベント1件と `done` イベント
  1件のみを送って即座に接続を終えた（`event: done`, `data: {"status":"omr_failed"}`）。
  10分（`MAX_DURATION_MS`）待つ挙動には**ならなかった**。曲が既に終端状態だったため、
  SSE ルートの `isScoreProgressTerminal("omr_failed") === true` の分岐が最初のポーリングで
  即座に `done` を送ったことを確認した。

処理時間: アップロード受理（12:45:15.901）から失敗確定（12:45:46）まで**約31秒**。

---

## 5. 成功経路の実走結果（ブリーフ Step 3b）

**PDF**: `.data/summer-joe-hisaishi.pdf`（久石譲「Summer」の楽譜、著作物）。この場所から直接
アップロードし、移動・コピーはしていない。事前確認:

```
$ file .data/summer-joe-hisaishi.pdf
.data/summer-joe-hisaishi.pdf: PDF document, version 1.7, 4 page(s)
```
（68062バイト。ブリーフの記述「PDF 1.7、4ページ、68KB」と一致。）

**曲**: `song_6d0f2dcb47fa4e6ea7cb`

| 時刻 (UTC) | 事象 |
|---|---|
| 12:46:56 | `POST /api/songs/{id}/score` に PDF を送信、202 応答、`status: "converting_score"` |
| 12:46:57.095 | ワーカーが Azurite から `score.pdf`（68062バイト）をダウンロード |
| 12:46:57〜12:48:44 | Audiveris 実行（`-batch -export -output ...`、実プロセスを `docker exec` で
  `/proc` から確認、PID固有のコマンドラインを取得済み） |
| 12:48:44.149 | `score.mxl` を Blob へアップロード開始 |
| 12:48:44.233 | ワーカーログ: `OMR job 151617d6-5a9c-485a-a83d-6cead45f55e1 outcome=completed song=song_6d0f2dcb47fa4e6ea7cb` |

最終状態（`GET /api/songs/{id}`）:

```json
{
  "status": "reviewing_score",
  "scoreFileName": "score.mxl",
  "sourceScoreFileName": "summer-joe-hisaishi.pdf",
  "scoreSource": "pdf",
  "omrEngine": "audiveris",
  "previewScoreFileName": "preview.musicxml",
  "previewMidiFileName": "preview.mid",
  "omrError": null
}
```

**確認できたこと**:

- `converting_score` → `reviewing_score` へ遷移した。
- `scoreFileName` の拡張子は **`.mxl`**（`.musicxml` でも `.xml` でもなかった。Audiveris の
  `-export` はデフォルトで圧縮MusicXML(`.mxl`)を書き出す）。
- `previewScoreFileName` = `preview.musicxml`、`previewMidiFileName` = `preview.mid` が
  入っていた。
- `omrError` は `null`。
- Blob（`scores` コンテナ、`users/{userId}/songs/{songId}/scores/` 配下）に4ファイルが揃っていた
  （`@azure/storage-blob` の `listBlobsFlat` で直接確認）:

  | blob | サイズ | 更新時刻(UTC) |
  |---|---|---|
  | `score.pdf` | 68062 | 12:46:55 |
  | `score.mxl` | 17643 | 12:48:44 |
  | `preview.musicxml` | 473736 | 12:48:44 |
  | `preview.mid` | 10327 | 12:48:44 |

- `GET /api/songs/{id}/score/file` は `200 OK`、`Content-Type:
  application/vnd.recordare.musicxml+xml` を返した。本文は473736バイトで、Blob上の
  `preview.musicxml` と同じサイズ。中身は非圧縮の MusicXML（`<score-partwise version="4.0.3">`、
  `<software>Audiveris 5.10.2</software>`）だった。**このルートは `scoreFileName`
  （圧縮された `score.mxl`）ではなく `previewScoreFileName`（非圧縮の `preview.musicxml`）を
  返す実装**（`src/app/api/songs/[songId]/score/file/route.ts:35-37`）。ブリーフが期待した
  「変換後のMusicXMLを返す」は満たしているが、正確には *プレビュー用* のMusicXMLである。
- SSE（`GET /api/songs/{id}/events`）も失敗経路と同様に `status` 1件 + `done` 1件のみで
  即座に終了した。

**Audiveris の認識結果について（事実として記録、品質評価ではない）**: 返された
`preview.musicxml` に `<measure ` は48個、`<score-part>` は1個（単一パート）だった。4ページの
ピアノ譜として明らかに極端な数値ではない（1ページあたり平均12小節）。音符・拍子・調号の
正しさは確認していない。

**処理時間**:
- Audiveris のサブプロセス実行時間（PDFダウンロード完了 12:46:57.095 〜 `score.mxl`
  アップロード開始 12:48:44.149）: **約107秒**。`AUDIVERIS_TIMEOUT_SECONDS` の既定300秒に対し
  約193秒（約64%)の余裕があった。
- エンドツーエンド（アップロード受理 12:46:56 〜 ジョブ完了ログ 12:48:44.233）: **約108秒**。
  `WORKER_OMR_VISIBILITY_TIMEOUT_SECONDS` の既定900秒に対し約792秒（約88%）の余裕があった。
- **これは4ページ・68KBのPDF1件のみの実測である。** ページ数や画像解像度が異なる楽譜での
  時間は測っていない。この1点のサンプルから「常に余裕がある」と結論づけることはできない。

---

## 6. OCR言語データについて判明した事実

Task 1 の担当者が「`.traineddata` が `.deb` に同梱されておらず、実行時にネットワーク取得している
可能性がある」と報告していた点（`task-1-report.md` の懸念事項）を、成功経路の実走中に確認した。

**確認した事実**:

1. `.deb` 展開後のイメージ内に `.traineddata` は存在しない
   （`find /opt/audiveris -iname '*.jar' | 57件` を Python の `zipfile` でスキャンし、
   `traineddata` を含むエントリは0件。ファイルシステム全体の `find / -iname '*.traineddata'`
   も0件）。
2. Audiveris は実行時に `/root/.config/AudiverisLtd/audiveris/tessdata` ディレクトリを作成する
   （失敗経路・成功経路のどちらの実行でも作成された）。**このディレクトリは成功経路の実行が
   完了した後も空のままだった。**
3. Audiveris のサブプロセスが実行中（`docker exec` で `/proc/101/cmdline` が
   `/opt/audiveris/bin/Audiveris -batch -export ...` であることを確認した時点）に
   `/proc/net/tcp` と `/proc/net/udp` を1回スナップショットしたところ、確立していた接続は
   すべて docker compose のコンテナ内ネットワーク（`azurite` / `cosmos` 宛、`172.21.0.x`）のみで、
   外部IPへの接続や、DNSクエリらしき使用中のUDPソケットは見られなかった。

**判定**: 上記から、**この1回の実行では Audiveris が `.traineddata` を取得した痕跡は見られなかった**
（同梱もされておらず、実行後もディレクトリが空で、確認できた瞬間のネットワーク状態にも外部接続は
無かった）。ただし、これは実行中を継続的にパケットキャプチャしたわけではなく、1回のスナップショット
に基づく。ごく短時間の取得試行（成功または失敗)を見逃している可能性は排除できない。また、この
4ページの楽譜が偶然OCRを要する要素（歌詞・タイトルの光学文字認識対象など）を含んでいなかった
だけで、他の楽譜では挙動が異なる可能性もある。**「取得を試みない」と検証済みとは書けない。**
判明したのは「同梱されていない」「今回は取得された痕跡が残っていない」の2点のみ。

---

## 7. follow-up 候補（#45 のスコープ外、直していない）

`src/lib/server/config.ts:140-145`:

```ts
analysisQueueName: process.env.AZURE_ANALYSIS_QUEUE ?? "analysis-jobs",
scoreQueueName: process.env.AZURE_SCORE_QUEUE ?? "score-jobs",
// 空文字も既定値へ落とす。ワーカー側（cloud_worker.omr_queue_name）と挙動を
// 揃えるため
omrQueueName: process.env.AZURE_OMR_QUEUE?.trim() || "omr-jobs",
```

`scoreQueueName` は `??` なので `AZURE_SCORE_QUEUE=""` のとき**空文字列のまま**フォールバックしない。
一方ワーカー側の `cloud_worker.score_queue_name()`（`worker/cloud_worker.py:51-55`）は
`os.environ.get("AZURE_SCORE_QUEUE", "").strip() or DEFAULT_SCORE_QUEUE` で空文字を確実に
`score-jobs` へ落とす。`omrQueueName` は今回のTask群で `?.trim() || `（`scoreQueueName` とは非対称な
書き方）で追加されており、ワーカー側と揃っている。つまり `AZURE_SCORE_QUEUE=""` を設定した場合、
Web は名前の無いキューへ enqueue し、ワーカーは `score-jobs` を読むという食い違いが起こる
（`AZURE_OMR_QUEUE=""` では起こらない）。#45 のスコープ外として本タスクでは直していない。

## 8. Task 1 で配布アーカイブの想定が違っていた点（引用）

`task-1-report.md` より:

1. 想定していた `Audiveris-5.10.2-linux-x86_64.zip` の配布URLは存在せず（404）、GitHub Releases
   上の実際の配布物は Ubuntu 向け `.deb`（`Audiveris-5.10.2-ubuntu22.04-x86_64.deb` 等）のみだった。
2. `.deb` の `data.tar` が `zstd` 圧縮で、Python標準ライブラリでは展開できないため、
   `dpkg-deb -x` をサブプロセス呼び出しする方式に変更した。
3. `.deb` は自前のJRE（`/opt/audiveris/lib/runtime/`）とTesseract（javacpp経由のネイティブ
   ライブラリ）を同梱していたため、`openjdk-17-jre-headless` / `tesseract-ocr` 等の apt
   インストールは不要と判断し、`.deb` の実際の `Depends` パッケージ群に差し替えた。
4. 展開後のレイアウトはブリーフの想定（`AUDIVERIS_HOME=/opt/audiveris`）と一致した。

本タスクでは再検証していないが、成功経路の実走で `AUDIVERIS_COMMAND=/opt/audiveris/bin/Audiveris`
が実際に動作したことから、上記の変更が機能していることは間接的に確認できた。

---

## 9. まとめ

| 項目 | 結果 |
|---|---|
| イメージサイズ増分 | 約250MB（Task 1実測の引用、本タスクで再実測はしていない） |
| Audiveris起動 | `-help` exit=0（Task 1 および本タスクで再確認） |
| 失敗経路 | `converting_score` → `omr_failed`、`omrError="Audiveris exited with code 1"`、約31秒、SSEは即終端 |
| 成功経路 | `converting_score` → `reviewing_score`、`scoreFileName`拡張子は`.mxl`、プレビュー2件あり、Blob4件確認、`/score/file`は200でpreview.musicxmlを返す、約108秒、SSEは即終端 |
| Audivierisの認識結果 | 48小節・1パート。極端な異常値ではない（品質は未評価） |
| OCR言語データ | 同梱されておらず、今回の1回の実行では取得の痕跡も見られなかった（継続監視はしていない） |
| follow-up | `config.ts`の`scoreQueueName`空文字フォールバックの非対称（#45スコープ外） |

**測っていないこと（この文書の範囲外）**:
- 4ページ以外のページ数・解像度のPDFでの処理時間
- Audiveris の採譜結果の音楽的な正しさ（音高・拍・調号）
- OCRデータ取得の継続的なネットワーク監視（1回のスナップショットのみ）
- AGPL-3.0 §13のソース提供義務の判断（Task 1の懸念事項、配備責任者側の作業として残る）
