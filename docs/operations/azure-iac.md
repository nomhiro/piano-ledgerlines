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
