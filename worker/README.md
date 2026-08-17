# 解析ワーカー（M5 本実装）

`poc/scripts/` で検証したロジック（採譜・アライメント・指標算出）を
Web アプリから呼び出せる形に再構成したものです。

- `analysis-pipeline.md` の S0〜S5 を実装します（S6 AI講評は別コンポーネント、未実装）。
- アルゴリズム本体（`align()` / `compute()` / `build_reference()`）は
  `poc/scripts/align.py` / `compute_metrics.py` / `musicxml_reference.py` から
  **そのまま移植**しています（ゼロから書き直していません）。

## セットアップ（ローカル）

PoC検証済みの venv をそのまま使えます（このマシンに存在する場合）。

```powershell
# 既存の PoC venv を使う場合（推奨・追加インストール不要）
C:\llpoc\venv\Scripts\pip install -e .

# 新規に作る場合
python -m venv C:\llpoc\venv
C:\llpoc\venv\Scripts\pip install torch librosa mir_eval pretty_midi soundfile piano_transcription_inference music21
```

`ffmpeg` が PATH に必要です。採譜モデルのチェックポイントは
`%USERPROFILE%\piano_transcription_inference_data\note_F1=0.9677_pedal_F1=0.9186.pth`
に配置してください（`poc/README.md` 参照）。

> 本番（`Dockerfile`）ではモデルをコンテナイメージに同梱済みで、ローカルパス依存が
> 無い（下記「Azure 本番ワーカー」節、architecture.md 4.1 案A）。ここで手動配置が
> 必要なのはローカル検証時のみ。配置を忘れると `piano_transcription_inference` が
> 既定の wget 自動取得を試みて失敗し、`ledgerlines_worker/transcribe.py` は
> `TranscribeError("MODEL_CHECKPOINT_MISSING", ...)` を投げる（`worker_main.py` は
> これを `failure.code: "MODEL_CHECKPOINT_MISSING"` としてテイクへ記録する）。

## 実行（`LEDGERLINES_REPOSITORY=local` などローカルバックエンド、ローカル Web アプリから呼ばれる想定）

```powershell
C:\llpoc\venv\Scripts\python.exe worker_main.py --data-dir ..\.data --song-id <songId> --take-id <takeId>
```

`--data-dir` はNext.js側の `src/lib/server/paths.ts` が使うのと同じ
ローカルデータルート（既定 `<repo>/.data`、`LEDGERLINES_DATA_DIR` で上書き可）を指定する。
テイクの `status` フィールドを段階的に更新しながら、完了時に
`overallScore` / `metrics` / `measureScores` / `issues` を書き込む。
Next.js側は `src/lib/server/worker.ts` の `runReferenceWorkerAsync` / `runAnalyzeWorkerAsync`
から `child_process.spawn` でこのCLIを起動する（Pythonインタプリタは
`WORKER_PYTHON` 環境変数、未設定時は `C:\llpoc\venv\Scripts\python.exe` の存在確認、
それも無ければ `python` にフォールバック）。

## Azureエミュレータでのローカル実行（`LEDGERLINES_REPOSITORY=azure` + `LEDGERLINES_AZURE_EMULATOR=true`）

`npm run azure:up`（`docker-compose.azure-local.yml`）で Azurite・Cosmosエミュレータに加えて、
この `worker` サービス（`worker/Dockerfile` からビルド）も起動する。Next.js側は
Azurite/Cosmosエミュレータを本番同様のBlob/Queue/Cosmosとして使い、この節の
ワーカーコンテナが本番と**同じイメージ・同じコード**でQueueを消費するため、
「Azureで実行するときと同じ状態」をコード差異なしでローカル再現できる。
上のローカルバックエンド節（`worker_main.py` を venv から直接実行する方法）とは別経路で、
どちらもモデル推論自体は本物である。

- 認証: `cloud_worker.py` の `CloudStore.__init__` は `LEDGERLINES_AZURE_EMULATOR=true` のとき、
  `DefaultAzureCredential` の代わりに接続文字列／固定キー（Azurite・Cosmosエミュレータの
  公開されている既定資格情報）で各クライアントを構築する。フラグが立っていない限り
  本番パス（`DefaultAzureCredential`・通常のTLS検証）は変わらない。
- TLS: Cosmosエミュレータの証明書は `localhost` 向けの自己署名証明書のため、
  コンテナネットワーク越しに `cosmos` という別ホスト名で接続すると証明書検証に失敗する。
  そのため `CosmosClient(..., connection_verify=False)` でエミュレータ限定でTLS検証を無効化する
  （TS側 `cosmos-repository.ts` が `rejectUnauthorized: false` で行っているのと同じ対処）。
- `.env.local.azure.example` は `LEDGERLINES_DETERMINISTIC_ANALYSIS=false` が既定になっている。
  ワーカーコンテナが立っている前提であれば、解析結果はスタブ（固定値 overallScore 79）ではなく
  本物の採譜・アライメント・スコアリングになる。ワーカーコンテナを起動せずUI側だけを
  素早く触りたい場合や実推論の待ち時間を避けたい場合は `true` に戻せる
  （`src/lib/server/queue.ts` の `runDeterministicAnalysis`）。
- ローカルへのPythonインストールもモデルのダウンロードも不要 ── ワーカーはコンテナ内で
  動き、採譜モデルのチェックポイントは `worker/Dockerfile` がビルド時にイメージへ
  同梱する（下の「採譜モデルのチェックポイント」節）。初回の `npm run azure:up` は
  そのダウンロード（約164MiB）を含むため時間がかかるが、以降はレイヤーキャッシュに乗る。
- **`worker/Dockerfile` を更新した後は `--build` だけでは不十分**。ワーカーが
  `restart: on-failure` で再起動ループに入っていると、`docker compose up -d --build worker` が
  新しいイメージをビルドしても既存コンテナは古いイメージのまま動き続ける（実際にこれで
  「ビルドは通っているのにコンテナ内にチェックポイントが無い」状態に遭遇した）。
  `docker compose -f docker-compose.azure-local.yml up -d --force-recreate worker` を使うこと。
- **参照譜の生成は `score-jobs` キュー経由でワーカーが行う（Issue #33）。**
  `POST /api/songs/{songId}/score`（`.../score/complete` も同様）は保存後に曲を
  `parsing_score` にしてジョブを `score-jobs` へキュー投入し、202 を返すだけで
  ストレージバックエンドによる分岐は無い。参照譜の生成（music21 でのパース・
  `reference.json` の書き出し）は `cloud_worker.py`（下記「Azure 本番ワーカー」節）が
  Queue から受け取って実行し、完了すると曲を `ready` に更新する。ローカルPythonの
  spawn（`worker_main.py --mode reference` の手動実行）には依存しないため、
  デプロイ済みWebアプリ（ルートイメージの `Dockerfile` は `node:20-alpine` でPython
  を含まない）でもこの経路だけで完結する。
- Queueは `npm run azure:init` が作成する。それより前にワーカーが起動すると
  `QueueNotFound` で落ちるが、`restart: on-failure` によりQueue作成後に自力で復帰する
  （`cloud_worker.py` の `main()` はトップレベル例外を再試行しないため、プロセス単位で
  リトライさせている）。ログに `QueueNotFound` が数回出るのは異常ではない。

```powershell
copy .env.local.azure.example .env.local.azure   # 初回のみ。値は編集不要（既知の公開資格情報）
npm run azure:up                                  # azurite / cosmos / worker を起動（初回はworkerのビルドが走る）
npm run azure:start                               # 疎通確認・Cosmosコンテナ/Azuriteコンテナ作成・Next.js起動
```

`npm run azure:down` で停止する。ワーカーのログは `docker compose -f docker-compose.azure-local.yml logs -f worker` で確認できる。

## Azure 本番ワーカー

`Dockerfile` と `requirements.txt` は、Azure Container Apps で Storage Queue
(`analysis-jobs`) を消費する本番イメージです。`cloud_worker.py` は Queue のジョブを
受け取り、Blob の音声・参照譜を一時領域へ同期して既存の解析パイプラインを実行し、
進捗・結果を Cosmos DB、採譜結果を Blob Storage へ保存します。

`cloud_worker.py` の `main()` はこの `analysis-jobs` に加えて、参照譜生成の
`score-jobs`（`AppConfig.scoreQueueName`）も同じループ・同じプロセスで消費します
（`_drain_score_queue`）。ループの各巡回で `score-jobs` を先に見て、あれば1件処理して
巡回をやり直す ── 参照譜生成（数秒）は解析（数分）より短いため、待たせている登録画面の
体感を優先する。ただしレプリカは1つで待受ループも1本なので、**既に実行中の解析ジョブを
追い越して参照譜ジョブを割り込ませることはできない**（設計 §4.2 の既知の制約。待ち時間が
問題になれば専用 Container App へ分離する、設計 §3.2）。

採譜モデルのチェックポイント（`note_F1=0.9677_pedal_F1=0.9186.pth`、約164MiB）は
`Dockerfile` 内の独立した `RUN` レイヤーでビルド時に Zenodo から取得し、
`/root/piano_transcription_inference_data/` に配置してイメージへ同梱する
（`piano_transcription_inference` / `ledgerlines_worker/transcribe.py` の既定パスと
同じ場所）。ライブラリ既定の wget 自動取得は本番イメージ（`wget` 未インストール）では
必ず失敗するため、`urllib`（標準ライブラリ）で取得し、ダウンロード後にサイズ下限
（150MiB）とMD5（Zenodoの`oc-checksum`レスポンスヘッダーから取得した値と一致するか）
を検証してビルドを失敗させる。これはHTMLのエラー/リダイレクトページを本物の
チェックポイントとして誤ってイメージに焼き込む事故を防ぐためで、実際に初回デプロイで
チェックポイント未配置による解析全滅が発生した経緯がある。このレイヤーは
`requirements.txt` や `COPY worker/*` より前に置いてあるため、通常のコード変更で
170MB超の再ダウンロードは発生しない。

```powershell
docker login ghcr.io
docker build -f worker/Dockerfile `
  --tag ghcr.io/<owner>/<repository>-analysis-worker:<git-sha> .
docker push ghcr.io/<owner>/<repository>-analysis-worker:<git-sha>
```

`infra/main.bicep` の `enableWorkerHosting=true` と `workerImage` に公開済み
GHCR イメージを指定して `azd provision` を実行すると、Worker Managed Identity を割り当てた
Container App が認証なしでイメージを pull して Queue を監視します。Worker の起動と Queue
疎通を確認した後に Web の
解析有効化フラグを有効化してください。

## PDF楽譜のOMR

曲登録時にPDFを受け取ると、Next.js側はこのワーカーを
`--mode omr --data-dir <dir> --song-id <songId>` で実行します。ワーカーは
`scores/<songId>/score.pdf` をAudiverisで変換し、生成したMusicXMLを
`scores/<songId>/score.musicxml` に保存します。変換後の曲は
`reviewing_score` になり、ユーザーが承認するまで参照譜の生成・演奏分析は行いません。

`AUDIVERIS_COMMAND`（既定: `audiveris`）にAudiveris 5.10.2の実行コマンドを、
`AUDIVERIS_TIMEOUT_SECONDS`（既定: `300`）にタイムアウト秒数を設定できます。
印刷譜のみを対象とし、手書き譜・撮影画像は受け付けません。Audiverisは
AGPL-3.0のため、本番配備前にライセンス上の義務を確認してください。

### 同梱している Audiveris のライセンス

ワーカーイメージには **Audiveris 5.10.2** を同梱しています（`/opt/audiveris`、
`AUDIVERIS_COMMAND` が既定で `/opt/audiveris/bin/Audiveris` を指します）。

- ライセンス: **AGPL-3.0**
- 入手元: https://github.com/Audiveris/audiveris/releases/tag/5.10.2
  （Linux向け配布物は `.zip` ではなく Ubuntu 用の `.deb` のみが公開されているため、
  `worker/scripts/fetch_audiveris.py` はビルド時にこの `.deb` を取得し、
  `dpkg-deb -x` でファイルツリーだけを `/opt/audiveris` に展開しています。
  同梱の `.deb` は自前の JRE と Tesseract（JNI経由）を含むため、
  JDKやtesseract-ocrを別途 apt で入れる必要はありません）
- ソース: https://github.com/Audiveris/audiveris （上記タグ）
- ライセンス本文: https://github.com/Audiveris/audiveris/blob/5.10.2/LICENSE
  （配布用の `.deb` 自体には Audiveris 本体のライセンス本文は同梱されていません。
  同梱JREの各モジュールのライセンスは `/opt/audiveris/lib/runtime/legal/` 配下に
  あります）

このイメージは GHCR で公開され、ネットワーク越しにサービスを提供します。
**AGPL-3.0 §13（ネットワーク利用時のソース提供義務）が適用されるかの判断と対応は、
配備の責任者が行ってください。**

## 実装済みAPIエンドポイント（M5縦串, 2026-07時点）

api.md の36エンドポイントのうち、曲登録→録音→解析→結果表示の縦串に
必要な以下のみを実装済み（Next.js Route Handlers, `src/app/api/`）。
残りは未実装（roll/audio SAS/compare/chat/comments/assignments/shares/
practice-plan/me/dashboard 等、後続フェーズ）。

| 実装済み | api.md対応 | 差分 |
|---|---|---|
| `POST /api/songs` | 5.1 `POST /songs` | SAS発行なし。曲メタデータのみ作成し`awaiting_score`で返す |
| `POST /api/songs/{songId}/score` | 5.1 `POST /songs/{songId}/score` | SAS PUTの代わりに直接multipartでファイルを受け取り、保存後にキューへ投入し202を返す（参照譜はワーカーが生成） |
| `GET /api/songs`, `GET /api/songs/{songId}` | #4, #6 | ほぼ同一 |
| `POST /api/songs/{songId}/takes` | 5.2 `POST /songs/{songId}/takes` | SAS発行なし。テイクメタデータのみ作成（`status: uploading`） |
| `POST /api/takes/{takeId}/audio-upload` | （api.mdのSAS PUTに相当、パス名は簡略化） | 直接multipartで音声を受け取り`status: uploaded`に更新 |
| `POST /api/takes/{takeId}/submit` | 5.2 `POST /takes/{takeId}/submit` | ほぼ同一（202 + `estimatedSeconds`） |
| `GET /api/takes/{takeId}/events` | 5.3 SSE | take.jsonを1秒間隔でポーリングしてSSEに変換 |
| `GET /api/takes/{takeId}`, `PATCH /api/takes/{takeId}` | 5.4, #18 | `links.audio` / `links.score` は現時点でリンク先未実装（プレースホルダー） |

## 既知の制約（M5縦串時点）

- ONNX化（PoCで2倍速確認済み）は未適用。PyTorch CPU推論をそのまま使用（速度は後続課題）。
- MusicXMLの繰り返し記号展開は未実装（m5-prep-report.md 4.4で指摘済みの既知課題）。
- AI講評（S6, Microsoft Foundry）は未実装。`aiReview: null` を返す。
- 非ピアノ音混入対策（録音UIガイダンス）はUI側の別タスク。
- `reference.py` はMusicXMLからペダル記号を抽出し、`pedalIntervalsBeats`として
  参照譜に出力する（サステインペダルのみ。区間の終端は被覆音符の終了拍まで含める）。
  `worker_main.py`はこれを`ref_pedal_beats`として`metrics.compute()`に渡し、
  `pedal_ratio`の参照側として使う。**過去のバグ**: `reference.py`自体は以前から
  ペダル記号を抽出していたが、その値が参照譜の戻り値から欠落しており、
  `worker_main.py`側も`ref_pedal=[]`を固定で渡していたため、ペダル記号のある楽譜でも
  「ペダルを一切使わない演奏」と比較されていた（踏んだ分がそのまま誤りとして減点）。
  既存曲の`reference.json`は`pedalIntervalsBeats`追加前に生成されたものが多く、
  そのままでは`pedal`は`unavailable`（理由コード`PEDAL_REFERENCE_NOT_REGENERATED`、
  「測定対象外」表示）になる。`pedal`を測定するには楽譜を再登録し、
  `reference.json`を再生成する必要がある。
  再生成済み（キーが存在する）なのに区間が空の場合は別の状態である ──
  `capabilities.pedal`は`hasPedalMark`だけを見て種別を絞らないのに区間抽出はサステインのみ
  拾うため、楽譜のペダル記号が全てソステヌート/ソフトだとこうなる。ただし
  `reference.py`の`_pedal_intervals_beats`が空リストを返す原因はこれだけではなく、
  `getSpannedElements()`が空になる場合や終了拍が開始拍以下になる退化区間の場合も
  同じ空リストになる。後者2つは楽譜側にサステイン記号があり得るため、「サステイン以外」
  と断定する理由文は嘘になる。この場合は再登録しても結果が変わらないので、理由コードは
  `NO_MEASURABLE_PEDAL_INTERVALS`（「この楽譜のペダル記号から測定可能なサステイン区間を
  抽出できなかったため測定対象外です。」）を返し、再登録を案内しない。
- 教師評価・採譜正解による較正成果物は未作成で、採譜モデルの音符単位 confidence も
  MIDIへ保存されていない。かつては（Issue #8）これを理由に総合点と5指標すべてを
  一律で判定保留にしていたが、M4 5章で録音条件への指標別の頑健性を実測できたことを
  受けて、指標別の判断に置き換えた（`ledgerlines_worker/confidence.py`の
  `apply_fail_closed_policy`、`pipelineVersion: "0.3.0-m5-metric-policy"`）。
  現在は`pitch`だけが`withheld`（理由コード`PITCH_FORMULA_UNVALIDATED`。式が
  採譜ノイズ＝余剰音に支配されるため）で、`rhythm` / `tempo` / `dynamics` / `pedal`
  の4指標は採点する（`dynamics`はAGC検出時のみ`unavailable`）。`pitch`が常に
  `withheld`であるため、`overallScore`は現段階でも`null`のまま返す
  （`unavailable`は加重平均から除外して再配分するが、`withheld`が残っていれば
  総合点自体を出さない）。これは講師評価との較正が完了したという意味ではなく、
  録音条件への頑健性が実測で確認されたという、より狭い主張である
  （→ `docs/spec/metrics.md` 7.2 / 8.2）。
- `calibration.py`（release gate・アーティファクトの検証）は変更していない。
  release gateを通ったartifactのパスを`LEDGERLINES_CALIBRATION_FILE`に設定したうえで
  `LEDGERLINES_ENABLE_CALIBRATED_SCORES=true`を明示すると読み込まれ、
  `evaluation.calibrationVersion`や診断情報に記録される。**ただし、この段以降は
  どのartifactが読み込まれても指標の`scored`/`withheld`/`unavailable`判定は変わらない**
  （以前は`thresholds.tempo.minimumConfidence`が`tempo`を採点するかどうかのゲートだったが、
  M4の頑健性実測により無条件で`scored`にしたため、このゲートは外れている）。
  運用手順は`docs/operations/calibration-runbook.md`を参照。
- `status: reviewing`（architecture.md のシーケンス図にある、AI講評待ちの中間状態）は
  未導入。S6が無いため `scoring` → 直接 `completed` に遷移する。

## UI統合の範囲（M5縦串時点）

モックUI(`src/`)は`src/lib/mock/`のダミーデータで多数の画面（ダッシュボード、
進捗グラフ、AIコーチ、共有、曲/テイク詳細等）を動かしており、実APIより遥かに
リッチなスキーマ（`period`/`accent`/`difficulty`/`goalDate`/`sharedWithTeacher`、
非nullの`aiReview`、ピアノロール、テンポ/強弱カーブ、講師コメント等）に依存している。
縦串フェーズではこれらを全て実データに置き換えるのではなく、書き込み経路（曲登録・録音・
解析投入）を実APIに接続し、**読み取り側は「実データを表示できる画面」だけをモック
コンポーネントから切り離した**。切り離しの基準は、モック側の型が`null`（判定保留／測定対象外）を
表現できるかどうかである ── 表現できない画面はモックのまま据え置いてある。
以下は画面ごとの現状で、実データが通る／通らないの境界そのものである。

- `src/app/songs/new/page.tsx`: 実際に`POST /api/songs`→`POST /api/songs/{id}/score`
  を呼び出し、本物のMusicXML解析結果（小節数・拍子・調・警告）を表示する。
  登録後は実SongIDで`/record`へ遷移する。
- `src/app/record/page.tsx` + `src/components/RecordView.tsx`: URLの`song`パラメータが
  `song_`で始まる実IDの場合、`getUserMedia`+`MediaRecorder`で実際にマイク録音し、
  `POST /api/songs/{id}/takes`→`POST /api/takes/{id}/audio-upload`→
  `POST /api/takes/{id}/submit`→SSE購読（`GET /api/takes/{id}/events`）という
  実フローを通す。モックの曲IDが渡された場合は従来通り疑似シミュレーションのまま。
- `src/app/takes/real/[takeId]/page.tsx`: 実テイクの結果専用の新規最小ビュー。
  `GET /api/takes/{id}`のレスポンス（5指標・小節スコア・issues）を
  `src/components/TakeEvaluationPanel.tsx`で表示する。指標は値があれば数値バー、
  無ければ status（判定保留／測定対象外）と保存済みの理由文を出す。
  **総合スコア欄は現状つねに「判定保留」＋理由文**になる ── 「既知の制約」節の
  指標別ポリシーのとおり、`pitch`が`withheld`である限り`overallScore`は`null`のままである。
  既存のモック専用`takes/[id]/page.tsx`（ピアノロール・カーブ・
  AIコーチ講評込みの詳細画面）とは別ルートとして共存させている。
- `src/app/progress/page.tsx` と `src/app/share/page.tsx`: 実曲（`song_`で始まるID）を
  選んだ場合は`ProgressView` / `ShareView`ではなく`TakeEvaluationPanel`を描画する
  （テイク詳細と同じ正直な評価ビュー）。モックの曲IDを選んだ場合は従来どおり
  `ProgressView`のまま。理由は型である: モックの`Take.overallScore`は非nullの`number`、
  `Take.metrics`と`MeasureScore.metrics`は非nullの`Record<MetricKey, number>`（`src/lib/mock/types.ts`）で、
  `unavailable`／`withheld`を表現できない。実データをそのまま流すと数値を捏造することになる。
  - **代償**: 実曲では`/progress`のスコア推移グラフとテイクA/B比較が出なくなった。
    どちらも数値の`overallScore`に対する引き算・`toFixed`を前提としており、
    `pitch`が`withheld`である間`overallScore`は`null`だからである。
    テイクは新しい順の一覧として、各テイクの絶対値のみを表示する。
  - 解析方式（`analysis.pipelineVersion`）が異なるテイクが同一リストに混在する場合は、
    「テイク間の差は上達を意味しません」という注記を出す
    （calibration-runbook.md の「異なるversion間の差分を改善量として表示しない」規定）。
- `src/app/coach/page.tsx`: 実曲でも`CoachView`を使い続けるが、渡すテイクは
  `real-history.ts`の`toCoachTake`が作る`id` / `label` / `recordedAt` / `aiReview`の
  4フィールドのみで、スコア系のフィールドを一切含まない（`stagnant`も`[]`固定）。
- ダッシュボード（`src/app/page.tsx`）は**モック専用のまま**で、実データは通らない
  （`@/lib/mock/data`からのみimportしている）。スコアを`?? 0`で埋める箇所が残るが、
  到達するのはモックデータだけである。
- `songs/page.tsx` と `songs/[id]/page.tsx` は実曲を表示し、実テイクへの導線を提供する。
  実曲側は`overallScore`が`null`なら「未算出」と出す。同じ`songs/page.tsx`の下部にある
  モック曲セクションは引き続きモック専用（そちらは`?? 0`のまま）。
  `takes/[id]` は `take_` IDを `/takes/real/[takeId]` へリダイレクトする。
- 実データ画面から外したPoV版の共有UIについて（`src/components/ShareView.tsx`。
  コミット`50c038c`以前には存在し、この節を書いた時点では未使用のため後に削除した）:
  固定文字列の共有URLとコピーボタン、
  送信先を持たない公開範囲チェックボックス、固定の「閲覧済み」バッジ、
  `useState`のみでリロードすると消えるレッスンノートと課題リスト、
  そしてスコア表示で構成されていた。バックエンドを持たない飾りか、
  非nullスコアを要求する部分（＝上記の型の理由で実データを流せない部分）のいずれかであり、
  唯一の実機能だった曲セレクタは`/share`側に直接置き直してある。
  この経緯を踏まえずに「共有画面は実装済み」と読まないこと。
