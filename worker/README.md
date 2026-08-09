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

> 本番実装ではモデルをコンテナイメージに同梱し、ローカルパス依存を解消する
> （architecture.md 4.1 案A）。ここではローカル検証用にこのパスを既定値にしている。

## 実行（ローカル Web アプリから呼ばれる想定）

```powershell
C:\llpoc\venv\Scripts\python.exe worker_main.py --data-dir ..\.data --song-id <songId> --take-id <takeId>
```

`--data-dir` はNext.js側の `src/lib/server/paths.ts` が使うのと同じ
ローカルデータルート（既定 `<repo>/.data`、`LEDGERLINES_DATA_DIR` で上書き可）を指定する。
テイクの `status` フィールドを段階的に更新しながら、完了時に
`overallScore` / `metrics` / `measureScores` / `issues` を書き込む。
Next.js側は `src/lib/server/worker.ts` の `runReferenceWorker` / `runAnalyzeWorkerAsync`
から `child_process.spawn` でこのCLIを起動する（Pythonインタプリタは
`WORKER_PYTHON` 環境変数、未設定時は `C:\llpoc\venv\Scripts\python.exe` の存在確認、
それも無ければ `python` にフォールバック）。

## Azure 本番ワーカー

`Dockerfile` と `requirements.txt` は、Azure Container Apps で Storage Queue
(`analysis-jobs`) を消費する本番イメージです。`cloud_worker.py` は Queue のジョブを
受け取り、Blob の音声・参照譜を一時領域へ同期して既存の解析パイプラインを実行し、
進捗・結果を Cosmos DB、採譜結果を Blob Storage へ保存します。
採譜モデルはビルド時にZenodoから取得してチェックサムを検証し、
`PIANO_TRANSCRIPTION_CHECKPOINT` で指定したイメージ内のパスから読み込みます。

```powershell
az acr build --registry <registry> `
  --image ledgerlines/analysis-worker:<git-sha> `
  --file worker/Dockerfile .
```

`infra/main.bicep` の `enableWorkerHosting=true` と `workerImage` に公開済み
イメージを指定して `azd provision` を実行すると、Worker Managed Identity を割り当てた
Container App が Queue を監視します。Worker の起動と Queue 疎通を確認した後に Web の
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

## 実装済みAPIエンドポイント（M5縦串, 2026-07時点）

api.md の36エンドポイントのうち、曲登録→録音→解析→結果表示の縦串に
必要な以下のみを実装済み（Next.js Route Handlers, `src/app/api/`）。
残りは未実装（roll/audio SAS/compare/chat/comments/assignments/shares/
practice-plan/me/dashboard 等、後続フェーズ）。

| 実装済み | api.md対応 | 差分 |
|---|---|---|
| `POST /api/songs` | 5.1 `POST /songs` | SAS発行なし。曲メタデータのみ作成し`awaiting_score`で返す |
| `POST /api/songs/{songId}/score` | 5.1 `POST /songs/{songId}/score` | SAS PUTの代わりに直接multipartでファイルを受け取り、保存後に本エンドポイント内で同期的にreferenceワーカーを実行 |
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
- `reference.py` はMusicXMLからペダル記号を抽出していないため、`pedal`指標は常に
  `null`（`metricsNAReason.pedal`に理由を記載）として加重平均から除外している
  （`worker_main.py`の`mask_unavailable_pedal`）。ペダル記号抽出が実装されるまでの暫定対応。
- `status: reviewing`（architecture.md のシーケンス図にある、AI講評待ちの中間状態）は
  未導入。S6が無いため `scoring` → 直接 `completed` に遷移する。

## UI統合の範囲（M5縦串時点）

モックUI(`src/`)は`src/lib/mock/`のダミーデータで多数の画面（ダッシュボード、
進捗グラフ、AIコーチ、共有、曲/テイク詳細等）を動かしており、実APIより遥かに
リッチなスキーマ（`period`/`accent`/`difficulty`/`goalDate`/`sharedWithTeacher`、
非nullの`aiReview`、ピアノロール、テンポ/強弱カーブ、講師コメント等）に依存している。
縦串フェーズではこれらを全て実データに置き換えるのではなく、**書き込み経路のみ**を
実APIに接続した。

- `src/app/songs/new/page.tsx`: 実際に`POST /api/songs`→`POST /api/songs/{id}/score`
  を呼び出し、本物のMusicXML解析結果（小節数・拍子・調・警告）を表示する。
  登録後は実SongIDで`/record`へ遷移する。
- `src/app/record/page.tsx` + `src/components/RecordView.tsx`: URLの`song`パラメータが
  `song_`で始まる実IDの場合、`getUserMedia`+`MediaRecorder`で実際にマイク録音し、
  `POST /api/songs/{id}/takes`→`POST /api/takes/{id}/audio-upload`→
  `POST /api/takes/{id}/submit`→SSE購読（`GET /api/takes/{id}/events`）という
  実フローを通す。モックの曲IDが渡された場合は従来通り疑似シミュレーションのまま。
- `src/app/takes/real/[takeId]/page.tsx`: 実テイクの結果専用の新規最小ビュー。
  `GET /api/takes/{id}`のレスポンス（総合スコア・5指標・小節スコア・issues）を
  そのまま表示する。既存のモック専用`takes/[id]/page.tsx`（ピアノロール・カーブ・
  AIコーチ講評込みの詳細画面）とは別ルートとして共存させている。
- ダッシュボード・進捗・コーチ・共有は**意図的に据え置き**（モックデータのまま）。
  実スキーマがこれらの機能をまだ満たせないため、フル書き換えは後続フェーズの
  スコープとする。
- `songs/page.tsx` と `songs/[id]/page.tsx` は実曲を表示し、実テイクへの導線を提供する。
  `takes/[id]` は `take_` IDを `/takes/real/[takeId]` へリダイレクトする。
