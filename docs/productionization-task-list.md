# 本番化タスクリスト（ホスティング/デプロイ除外）

## 目的と範囲

ローカル縦串で使用しているJSONファイル、固定モックユーザー、直接multipart
アップロード、`child_process.spawn`ワーカーを、本番で安全に利用できるデータ・認証・
API・非同期処理へ置き換える。

**このタスクリストに含めないもの**

- Next.jsアプリ、解析ワーカー、Azureリソースのデプロイ/ホスティング
- 本番ドメイン、CDN、DNS、WAF、CI/CDの稼働設定
- 実環境での性能測定。ただし、実行可能な計測・監視コードは実装する

## 現在の実装と置換先

| 現在 | 本番化後 | 対象 |
|---|---|---|
| `.data/` JSON | Azure Cosmos DB for NoSQL | 曲、テイク、結果、会話、共有 |
| ローカル音声/譜面ファイル | Azure Blob Storage | 音声、MusicXML、MIDI、alignment、派生データ |
| 固定`usr_local_dev` | Microsoft Entra External ID / Entra ID JWT | ユーザー識別、認可 |
| 直接multipart API | 短期SASアップロード + Blobイベント/キュー | 音声・譜面の安全な大容量アップロード |
| `child_process.spawn` | Azure Storage Queue + Container Apps Jobワーカー | 非同期解析 |
| take.jsonのポーリングSSE | Cosmos状態 + キュー/イベント駆動の状態更新 | 解析進捗と完了通知 |
| `aiReview: null` | Microsoft Foundry SDK呼び出し | 講評・練習メニュー |

## 実装前の決定事項

- [ ] **認証テナントと利用者モデルを確定する。** 個人利用者のみならEntra External ID、
      組織内利用のみならEntra IDを採用する。教師/学習者のロール、教師との共有・
      割当の認可ルールを`docs/spec/api.md`と`docs/design/data-model.md`へ反映する。
- [ ] **Azureリソース名・リージョン・環境分離を決める。** dev/staging/prodごとに
      Cosmos、Storage、Key Vault、Application Insights、Foundryプロジェクトを分離する。
- [ ] **コンテナとキューの責務を決める。** API側は曲・テイク状態を作成するだけとし、
      解析、参照譜生成、AI講評はワーカーJobに限定する。
- [ ] **データ保持・削除ポリシーを決める。** 録音、派生MIDI、分析結果、ユーザーアカウント、
      共有URL、監査ログの保持期間とユーザー削除時のカスケード削除を定義する。

## P0: 設定・SDK・シークレット基盤

- [ ] `@azure/identity`、`@azure/cosmos`、`@azure/storage-blob`、Azure Monitor/
      OpenTelemetry関連SDKを追加する。バージョンは実装時点の安定最新版を使う。
- [ ] `src/lib/server/config.ts`を作成する。環境変数を起動時に型検証し、必須値不足時は
      明示的に失敗させる。機密値をクライアントバンドルへ公開しない。
- [ ] Azure上は`DefaultAzureCredential`とManaged Identityを使う。ローカル開発は
      Azure CLI/Visual Studio認証を許容し、キーや接続文字列をコードに埋め込まない。
- [ ] Key Vault参照を設定する。接続文字列方式を使う必要がある値、Foundry設定、
      外部サービス設定をKey Vaultに格納する。ローテーション手順も文書化する。
- [ ] feature flagまたは依存性注入で`local`/`azure`実装を切り替える。
      テスト時にローカル実装を維持できるようにする。
- [ ] 機密情報を含まない`.env.example`と設定手順を追加する。

**完了条件:** Azure SDK実装がManaged Identityで認証し、設定不備は起動時に検出される。

## P1: Microsoft Entra認証と認可

- [ ] Next.js用のOIDC/OAuthライブラリを選定し、Authorization Code + PKCEフローを実装する。
      Cookieは`HttpOnly`、`Secure`、`SameSite`を適切に設定する。
- [ ] API Route Handlerに共通の認証ミドルウェア/ヘルパーを作成する。JWTのissuer、
      audience、署名、期限、nonce/stateを検証する。
- [ ] `MOCK_USER_ID`を廃止し、トークンsubject/object IDから正規化したユーザーIDを取得する。
- [ ] Cosmosの全リポジトリ操作へ`userId`境界を適用する。他ユーザーのsong/takeへ
      IDを推測してアクセスできないことを確認する。
- [ ] 教師、学習者、管理者のアプリケーションロール/claimを定義する。共有・コメント・
      割当APIには所有者または明示的共有者のみを許可する。
- [ ] 未認証(401)、権限不足(403)、存在しない/非公開リソース(404)を
      `docs/spec/api.md`のエラー形式で返す。
- [ ] ログにアクセストークン、Cookie、認証ヘッダー、個人情報を出力しない。

**完了条件:** 固定ユーザーを使わず、認証済みユーザーごとのデータ分離とロール認可が
APIテストで確認できる。

## P2: Cosmos DBリポジトリ

- [ ] `docs/design/data-model.md`に従い、users、songs、takes、conversations、
      comments、assignments、sharesのコンテナとパーティションキーを実装する。
- [ ] 現在の`src/lib/server/repository.ts`をインターフェースと
      `LocalRepository`/`CosmosRepository`へ分割する。ルートハンドラは抽象にのみ依存する。
- [ ] song/takeの読み取り・更新で必ず`userId`または共有スコープを条件にする。
      パーティションを跨ぐクエリは必要最小限にする。
- [ ] 曲一覧、テイク一覧、最新テイク、比較、進捗表示に必要な複合インデックスを
      定義する。クエリのRU消費を計測可能にする。
- [ ] 楽観的同時実行（ETag）を導入する。ワーカーとAPIが同時にtake状態を更新しても
      更新が失われないようにする。
- [ ] 解析状態遷移を単一の状態遷移関数に集約する。
      `uploading → uploaded → queued → transcribing → aligning → scoring → reviewing → completed`
      と`failed`の遷移以外を拒否する。
- [ ] シリアライズ形式、ページネーション継続トークン、TTL/削除フラグを
      API仕様へ追記する。

**完了条件:** 既存の曲登録・テイク投入・結果取得APIがCosmos実装に切り替わり、
ユーザー境界・状態遷移・同時更新を統合テストで確認できる。

## P3: Blob Storageと安全なアップロード

- [ ] Blobコンテナを用途別に設計する（例: `scores`、`audio`、`derived`）。
      パブリック匿名アクセスは無効化する。
- [ ] 既存のローカルファイルパスをBlob名へ移行する。Blob名にユーザーIDと
      song/take IDを含め、衝突と越境アクセスを防ぐ。
- [ ] `POST /songs`と`POST /takes`を短期・書き込み限定SAS発行フローに変更する。
      SASは対象Blob、HTTPメソッド、Content-Type、最大サイズ、短い有効期限に制限する。
- [ ] `POST /songs/{id}/score/complete`、`POST /takes/{id}/upload-complete`などの
      完了確認APIを追加する。サーバー側でBlobの存在、サイズ、Content-Type、所有者を
      検証してから次状態へ遷移させる。
- [ ] アップロード対象をMusicXML/MXL/MIDIと安全な音声形式へ限定する。
      ファイルサイズ、Content-Type、拡張子、マジックバイトを検証する。
- [ ] 音声/譜面のダウンロードはユーザー認可後の短期読み取りSASか、
      サーバーストリーミングに限定する。
- [ ] ライフサイクル管理を定義する。元音声・一時前処理ファイル・派生MIDIの
      保持期間をコンテナポリシーへ反映できるようにする。

**完了条件:** APIサーバーが大容量ファイルを中継せず、認可済みユーザーだけが
限定されたBlobへアップロード/取得できる。

## P4: 非同期解析ワーカーと信頼性

- [ ] Queueメッセージのスキーマを定義する（job ID、take ID、song ID、attempt、
      correlation ID、schema version）。音声や認証情報をメッセージに含めない。
- [ ] `src/lib/server/worker.ts`をキュー投入クライアントに置き換える。
      `child_process.spawn`はローカル実装に隔離し、本番実装から除去する。
- [ ] PythonワーカーをJob入力（Queue）→Blob読み取り→Cosmos状態更新→Blob派生物保存の
      構造に変換する。Managed IdentityでStorage/Cosmos/Key Vaultへアクセスする。
- [ ] 可視性タイムアウト、再試行、指数バックオフ、最大試行回数、poison queueを設ける。
      恒久失敗はtakeを`failed`にし、ユーザー向け失敗理由と運用者向け詳細を分離する。
- [ ] 重複メッセージを安全に処理できるよう、take ID + pipeline version + attemptで
      冪等性を実装する。
- [ ] 参照譜生成、採譜、アライメント、指標、AI講評を個別の進捗ステージとして記録する。
      Worker停止/再実行時に安全に再開または再実行できるようにする。
- [ ] 音声前処理時に非ピアノ音、無音、クリッピング、短すぎる録音を検出し、
      解析前にユーザーへ意味のあるエラー/警告を返す。
- [ ] ONNX推論を本番ワーカーで有効化する。モデルのバージョン、ハッシュ、実行環境を
      analysis metadataに記録する。

**完了条件:** Queueの重複・失敗・再試行を含め、解析ジョブが冪等に完了または明示的失敗へ
遷移し、UIが進捗を取得できる。

## P5: API堅牢化と進捗通知

- [ ] 全Route Handlerを入力スキーマ（Zod等）で検証し、未知フィールド、サイズ上限、
      不正なID、範囲外の値を一貫した400で拒否する。
- [ ] APIごとに認可、レート制限、リクエストサイズ上限、タイムアウト、相関IDを設定する。
      高コストなsubmit/chat/review APIを特に保護する。
- [ ] エラーコードを`docs/spec/api.md`と一致させる。
      内部スタックトレース、Blob URL、SDKエラー本文をレスポンスに漏らさない。
- [ ] `GET /takes/{id}/events`をCosmosの状態を基にしたSSEへ置換する。
      接続切断、再接続、Last-Event-ID、最大接続時間を定義する。
- [ ] SSEをスケールアウト構成で維持できない場合は、短周期ポーリングAPIを正式仕様化する。
      どちらを正とするかを決め、UIを実装する。
- [ ] 監査対象操作（共有作成、削除、教師コメント、課題割当）の監査ログ形式を追加する。
- [ ] API契約テストを追加する。認証、認可、検証、ページネーション、失敗状態、
      SSE/ポーリングの主要ケースを対象にする。

**完了条件:** APIが認証済み・入力検証済み・監視可能な状態で、クライアントが
失敗と非同期進捗を安定して扱える。

## P6: AIコーチ（Microsoft Foundry）

- [ ] `docs/design/ai-prompts.md`をベースに、構造化入力（指標、issues、曲コンテキスト、
      練習履歴）とJSON出力スキーマを定義する。
- [ ] Foundry SDKクライアントをManaged Identityで初期化する。
      モデル名、デプロイ名、APIバージョンを設定化する。
- [ ] モデル出力をスキーマ検証し、不正な出力は保存しない。再試行または
      `aiReview`なしで結果を完了できるようにする。
- [ ] プロンプトインジェクション対策として、ユーザー入力とシステム指示を分離し、
      譜面/メモ/会話由来の文字列を信頼しない。
- [ ] 分析結果とAI講評の関係を`pipelineVersion`、prompt version、model version、
      generatedAtと共に保存する。
- [ ] 危険・不適切な生成を制御するため、Content Safety/ガードレールと
      ユーザーに見せるフォールバック文を設ける。

**完了条件:** AI講評が構造化・検証済みのデータとして非同期に保存され、失敗しても
解析スコアの取得を妨げない。

## P7: 観測性・セキュリティ・品質

- [ ] OpenTelemetry + Application InsightsをAPIとワーカーへ組み込む。
      correlation ID、take ID、job ID、ステージ時間、失敗分類、RU、キュー遅延を記録する。
- [ ] 録音データ、譜面本文、アクセストークン、SAS、個人情報をテレメトリへ送らない
      redactionルールを実装する。
- [ ] メトリクスとアラート候補を定義する（解析失敗率、poison queue、キュー遅延、
      95パーセンタイル処理時間、Cosmos RUスロットリング、Blob失敗、Foundry失敗）。
- [ ] 依存性スキャン、シークレットスキャン、SDKの脆弱性更新をCIで実行できるようにする
      （CIのホスティング設定は別作業）。
- [ ] プライバシー観点のテストを追加する。ユーザー削除時のBlob/Cosmos派生物削除、
      ログ非含有、別ユーザーアクセス拒否を対象にする。
- [ ] 解析品質回帰テストを用意する。実ピアノ録音の固定評価セットで
      音程/リズム/テンポ/ダイナミクス/ペダルの期待範囲を確認する。

**完了条件:** 障害の原因と影響を個人情報を漏らさず追跡でき、主要な
データ境界・解析品質・失敗回復が自動テストで保護される。

## 実装順序と依存関係

1. P0（設定/SDK）と「実装前の決定事項」を確定する。
2. P1（認証）を先に完了し、以後すべてのデータ操作を実ユーザーに紐付ける。
3. P2（Cosmos）とP3（Blob）を実装し、ローカル実装と契約テストで互換性を保つ。
4. P4（Queue/ワーカー）で非同期処理を置換する。
5. P5（API/SSE）を新しいデータ・ジョブモデルへ接続する。
6. P6（Foundry）を解析完了後の任意ステージとして追加する。
7. P7（観測性/品質）を各Pと並行して追加し、最終的に全体を検証する。

## 別セッション開始時の確認コマンド

```powershell
git status --short
npm install
npx tsc --noEmit
npm run lint
```

Pythonワーカーの依存関係は`worker/README.md`を参照すること。既存のローカル縦串は
`WORKER_PYTHON`または既存のPoC venvに依存するため、Azureワーカー実装へ移行する際は
ローカル開発用フォールバックを明示的なfeature flagとして残す。
