# Azure リソース管理（Bicep + azd）

`infra/main.bicep` はリソースグループスコープの宣言型デプロイです。環境ごとに
Storage（Blob コンテナと Queue）、Cosmos DB Serverless、Log Analytics /
Application Insights、Key Vault、ユーザー割り当て Managed Identity と RBAC を作成します。
Azure OpenAI 互換の Foundry アカウントとモデルデプロイは、リージョンのクォータと
モデル提供状況を確認した後に `enableFoundry=true` で有効化します。

アプリケーションと Python ワーカーの Container Apps はまだ作成しません。イメージを
ビルドしてレジストリへ公開した後、`azure.yaml` のコメント済み `web` / `worker`
サービスを実際のイメージに置き換えるのが別作業です。

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
