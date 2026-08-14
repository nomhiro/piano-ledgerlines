# Azure リソース管理（Bicep + azd）

`infra/main.bicep` はリソースグループスコープの宣言型デプロイです。環境ごとに
Storage（Blob コンテナと Queue）、Cosmos DB Serverless、Log Analytics /
Application Insights、Key Vault、ユーザー割り当て Managed Identity と RBAC を作成します。
Azure OpenAI 互換の Foundry アカウントとモデルデプロイは、リージョンのクォータと
モデル提供状況を確認した後に `enableFoundry=true` で有効化します。

Next.js の Web Container App と Python 解析ワーカーは、既存の Container Apps managed
environment を利用して配備します。Python ワーカーの公開 GHCR イメージを指定して、
`enableWorkerHosting=true` と `workerImage` を指定して `azd provision` を実行します。
Worker は Storage Queue を常時監視し、Managed Identity で Blob / Cosmos / Queue に接続します。

## 前提

- Azure CLI (`az`) と Azure Developer CLI (`azd`)
- `az login` または `azd auth login` 済みの、対象サブスクリプションへの権限
- リソース作成時の認証情報はリポジトリへ保存しない

## azd 環境を作成して Provision

環境はサブスクリプション、リージョン、リソースグループを分離します。次の例は
dev 環境です（実行すると Azure リソースが作成されます）。

```powershell
azd auth login
azd env new ledgerlines-dev
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION japaneast
azd env set AZURE_RESOURCE_GROUP ledgerlines-dev-rg
azd provision
```

`infra/main.parameters.json` は安全な dev の例です。stg / prod の値を使う場合は、
`infra/main.parameters.stg.json` または `infra/main.parameters.prod.json` を
`infra/main.parameters.json` にコピーしてから `azd provision` を実行するか、
下記の Azure CLI の明示的なデプロイを使います。パラメータファイルにはシークレットを
入れません。

```powershell
azd env select ledgerlines-stg
azd provision
```

Foundry を有効にする場合は、モデルのリージョン提供状況とクォータを確認してから、
対象環境のパラメータ例で `enableFoundry` を `true` に変更します。デプロイ名、モデル名、
バージョンも同じファイルで明示できます。API キーは不要です（Managed Identity + RBAC）。

## What-if（変更内容の確認）

Azure CLI で、対象リソースグループに対する差分だけを確認できます。これはリソースを
作成・変更しません。

```powershell
az deployment group what-if `
  --resource-group ledgerlines-dev-rg `
  --template-file infra/main.bicep `
  --parameters @infra/main.parameters.dev.json
```

`azd provision --preview` も利用できますが、最終的な差分確認には上記の
`az deployment group what-if` を使います。

## 出力とアプリ設定

Provision 後は `azd show` または `az deployment group show` で、Cosmos endpoint、
Storage URL、Queue 名、Key Vault URI、Managed Identity の principal ID、
Application Insights 名を確認できます。アプリは接続文字列やキーではなく
`DefaultAzureCredential` / Managed Identity を使います。ローカルで実 Azure を使う場合は
[`local-azure-cloud.md`](./local-azure-cloud.md) の `azure:cloud:check` が `azd env` /
deployment outputs から Cosmos、Blob、Queue、Foundry の Endpoint を解決します。
必要な値は Key Vault に
RBAC で登録し、ログやパラメータファイルへコピーしません。

既定では Storage / Cosmos / Key Vault は Azure サービス用の公開エンドポイントです。
Private Endpoint と VNet 統合は、本番ネットワーク設計が確定した段階で追加します。
`allowSharedKeyAccess=false`、Blob の匿名公開無効、TLS 1.2、Key Vault RBAC、
Cosmos のローカル認証無効が既定の安全策です。

## Classroom invitation email

`infra/main.bicep` は既定では ACS Email を作成しません。環境ごとに
`enableCommunicationEmail=true` を指定して What-if を確認してから Provision します。
このオプションは Communication Service、Email Service、Azure-managed domain を作成し、
Web の user-assigned identity に `Communication and Email Service Owner` RBAC を付与します。

```json
{
  "enableCommunicationEmail": { "value": true },
  "emailDataLocation": { "value": "Japan" }
}
```

Provision 後の `communicationEmailEndpoint` を
`AZURE_COMMUNICATION_EMAIL_ENDPOINT` に設定し、Azure-managed domain または検証済み
customer-managed domain の送信元を `AZURE_COMMUNICATION_EMAIL_SENDER_ADDRESS` に設定します。
アプリは接続文字列・アクセスキーを使わず `DefaultAzureCredential`（本番は Managed Identity）
で認証します。`LEDGERLINES_EMAIL_BACKEND=azure` が本番の必須設定です。開発では
`memory`（既定）または本文・宛先を出力しない `console` を明示的に選択できます。
招待URL、トークン、宛先アドレス、本文をログや telemetry に出力しないでください。
`LEDGERLINES_INVITATION_TOKEN_SECRET` はランダムな32バイト以上の値をKey Vaultまたは
Container App secretから注入し、ローテーション時は旧versionとの段階移行を行います。
`LEDGERLINES_INVITE_RATE_LIMIT` と `LEDGERLINES_INVITE_RATE_WINDOW_MINUTES` は
repository-backedの教室単位制限であり、プロセスメモリのrate limiterではありません。

customer-managed domainを使う場合、email domainの検証を先に完了し、DNSへ指定された
SPF、DKIM、DMARCレコードを登録してから `AZURE_COMMUNICATION_EMAIL_SENDER_ADDRESS`
を切り替えます。BicepのAzure-managed domain作成を、未検証domainの自動置換に使わない
でください。prodではデプロイ後にACSの送信成功statusとbounce監視を確認します。

## 環境の更新・削除

```powershell
azd env list
azd env select ledgerlines-prod
azd provision

# リソースを削除する場合（データも失われるため明示的に実行）
azd down
```

同じ環境で `azd provision` を再実行すれば差分だけが適用されます。prod の Key Vault
は purge protection を有効にするため、削除・再作成の前に保持ポリシーを確認します。

## 5. 解析ワーカーの配備

GitHub Actions が Web とワーカーのイメージを GHCR に公開します。手動で作成する場合は、
GHCR にログインしてワーカーイメージをビルド・pushします。

```powershell
docker login ghcr.io
docker build -f worker/Dockerfile `
  --tag ghcr.io/<owner>/<repository>-analysis-worker:<git-sha> .
docker push ghcr.io/<owner>/<repository>-analysis-worker:<git-sha>
```

次に、対象環境のパラメータへ次を設定して Provision します。

```json
{
  "enableWorkerHosting": { "value": true },
  "containerEnvironmentName": { "value": "<managed-environment-name>" },
  "workerImage": { "value": "ghcr.io/<owner>/<repository>-analysis-worker:<git-sha>" }
}
```

`az containerapp show` で Worker が `Running` になり、ログに `Analysis worker started`
が出ることを確認します。Queue の滞留が減り、テイクが
`queued → transcribing → aligning → scoring → completed` と遷移してから Web の
`LEDGERLINES_ANALYSIS_ENABLED` を有効化します。Worker が停止している状態で Web だけを
有効化しないでください。

## Web の Google 認証

本番 Web は Azure Container Apps の Easy Auth（Google）で認証します。Container App の
認証設定では `/api/health` を除外し、未認証リクエストは `AllowAnonymous` にします。
ページ側の `src/proxy.ts` が未認証アクセスを `/.auth/login/google` へリダイレクトし、
Easy Auth が `x-ms-client-principal` を付与します。

Google Cloud OAuth クライアントには、次の Authorized redirect URI を登録します。

```text
https://<container-app-fqdn>/.auth/login/google/callback
```

`RedirectToLoginPage` を Easy Auth 側で指定すると、認証設定によってはページの
Server Component に到達する前に 401 となるため、アプリ側のリダイレクトを使用します。

## Stripe secrets and billing configuration

本番のStripe値はContainer Appのsecret参照またはKey Vault連携で注入し、
リポジトリ、Bicep parameter、イメージ、ログへコピーしません。必要なserver-only設定は
次の5つです。

| Name | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Node SDK secret key |
| `STRIPE_WEBHOOK_SECRET` | `/api/stripe/webhook` の署名検証 |
| `STRIPE_CLASSROOM_BASE_PRICE_ID` | 教室基本料金のrecurring Price |
| `STRIPE_CLASSROOM_STUDENT_PRICE_ID` | 有効学生1人のrecurring Price |
| `LEDGERLINES_APP_BASE_URL` | 検証済みsuccess/cancel/Portal return URLの基底 |

Priceは月額recurringとしてStripe Dashboardで作成し、税・クーポン・返金・年額・
請求書払いはこの層では設定しません。`LEDGERLINES_APP_BASE_URL` は本番ではHTTPSのみ
受け付け、Checkout URLのパスやqueryはサーバーが固定生成します。

Webhook endpointは `https://<container-app-fqdn>/api/stripe/webhook` に登録し、
`checkout.session.completed`、`customer.subscription.created|updated|deleted`、
`invoice.paid`、`invoice.payment_failed`、`invoice.payment_action_required` を送ります。
Stripeのdelivery retryと順序逆転は実装が吸収するため、失敗時はDashboardの再送を優先し、
SubscriptionをStripeから再取得するreconciliationを実行します。
