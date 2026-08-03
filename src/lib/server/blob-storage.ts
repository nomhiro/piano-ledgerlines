import fs from "node:fs/promises";
import path from "node:path";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from "@azure/storage-blob";
import { DefaultAzureCredential } from "@azure/identity";
import { getConfig } from "./config";
import { DATA_DIR } from "./paths";
import { createAzureCredential } from "./azure-credential";

export interface BlobUploadOptions {
  contentType: string;
  maxBytes: number;
  expiresInSeconds?: number;
}

export interface UploadGrant {
  url: string;
  blobName: string;
  expiresAt: string;
  maxBytes: number;
  contentType: string;
}

export interface BlobStore {
  upload(container: string, blobName: string, data: Buffer, contentType: string): Promise<void>;
  download(container: string, blobName: string): Promise<Buffer>;
  deletePrefix(container: string, prefix: string): Promise<void>;
  exists(container: string, blobName: string): Promise<{ size: number; contentType?: string } | null>;
  createWriteSas(container: string, blobName: string, options: BlobUploadOptions): Promise<UploadGrant>;
  createReadSas(container: string, blobName: string, expiresInSeconds?: number): Promise<string>;
}

function localPath(container: string, blobName: string): string {
  const normalized = blobName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error("invalid blob name");
  return path.join(DATA_DIR, "blobs", container, ...normalized.split("/"));
}

function encodedBlobPath(blobName: string): string {
  return blobName.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export class LocalBlobStore implements BlobStore {
  async upload(container: string, blobName: string, data: Buffer, contentType: string): Promise<void> {
    const target = localPath(container, blobName);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    await fs.writeFile(`${target}.meta.json`, JSON.stringify({ contentType }));
  }

  async download(container: string, blobName: string): Promise<Buffer> {
    return fs.readFile(localPath(container, blobName));
  }

  async deletePrefix(container: string, prefix: string): Promise<void> {
    await fs.rm(localPath(container, prefix), { recursive: true, force: true });
  }

  async exists(container: string, blobName: string): Promise<{ size: number; contentType?: string } | null> {
    try {
      const target = localPath(container, blobName);
      const [stat, meta] = await Promise.all([
        fs.stat(target),
        fs.readFile(`${target}.meta.json`, "utf-8").catch(() => "{}"),
      ]);
      return { size: stat.size, contentType: (JSON.parse(meta) as { contentType?: string }).contentType };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async createWriteSas(container: string, blobName: string, options: BlobUploadOptions): Promise<UploadGrant> {
    const expiresAt = new Date(Date.now() + (options.expiresInSeconds ?? 900) * 1000).toISOString();
    return {
      url: `/api/uploads/local/${encodeURIComponent(container)}/${blobName}`,
      blobName,
      expiresAt,
      maxBytes: options.maxBytes,
      contentType: options.contentType,
    };
  }

  async createReadSas(container: string, blobName: string): Promise<string> {
    return `/api/blobs/${encodeURIComponent(container)}/${blobName}`;
  }
}

export class AzureBlobStore implements BlobStore {
  private readonly service: BlobServiceClient;
  private readonly credential?: DefaultAzureCredential;
  private readonly sharedKey?: StorageSharedKeyCredential;
  private delegationKey?: UserDelegationKey & { cacheExpiresOn: Date };

  constructor() {
    const config = getConfig();
    if (config.azureEmulator) {
      this.service = BlobServiceClient.fromConnectionString(config.storageConnectionString!);
      this.sharedKey = new StorageSharedKeyCredential(config.storageAccountName!, config.storageAccountKey!);
    } else {
      this.credential = createAzureCredential();
      this.service = new BlobServiceClient(config.storageAccountUrl!, this.credential);
    }
  }

  async upload(container: string, blobName: string, data: Buffer, contentType: string): Promise<void> {
    const client = this.service.getContainerClient(container).getBlockBlobClient(blobName);
    await client.uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async download(container: string, blobName: string): Promise<Buffer> {
    return this.service.getContainerClient(container).getBlockBlobClient(blobName).downloadToBuffer();
  }

  async deletePrefix(container: string, prefix: string): Promise<void> {
    const containerClient = this.service.getContainerClient(container);
    for await (const blob of containerClient.listBlobsFlat({ prefix })) {
      await containerClient.deleteBlob(blob.name);
    }
  }

  async exists(container: string, blobName: string): Promise<{ size: number; contentType?: string } | null> {
    const client = this.service.getContainerClient(container).getBlobClient(blobName);
    try {
      const properties = await client.getProperties();
      return { size: properties.contentLength ?? 0, contentType: properties.contentType };
    } catch (error) {
      if (typeof error === "object" && error !== null && "statusCode" in error && (error as { statusCode?: number }).statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async createWriteSas(container: string, blobName: string, options: BlobUploadOptions): Promise<UploadGrant> {
    const config = getConfig();
    const expiresOn = new Date(Date.now() + (options.expiresInSeconds ?? config.sasLifetimeSeconds) * 1000);
    const startsOn = new Date(Date.now() - 60_000);
    const permissions = BlobSASPermissions.parse("cw");
    const token = config.azureEmulator
      ? generateBlobSASQueryParameters({
          containerName: container,
          blobName,
          permissions,
          startsOn,
          expiresOn,
          contentType: options.contentType,
        }, this.sharedKey!).toString()
      : generateBlobSASQueryParameters({
      containerName: container,
      blobName,
      permissions,
      startsOn,
      expiresOn,
      contentType: options.contentType,
        }, await this.getDelegationKey(expiresOn), config.storageAccountName!).toString();
    return {
      url: `${this.service.url.replace(/\/$/, "")}/${container}/${encodedBlobPath(blobName)}?${token}`,
      blobName,
      expiresAt: expiresOn.toISOString(),
      maxBytes: options.maxBytes,
      contentType: options.contentType,
    };
  }

  async createReadSas(container: string, blobName: string, expiresInSeconds = getConfig().sasLifetimeSeconds): Promise<string> {
    const expiresOn = new Date(Date.now() + expiresInSeconds * 1000);
    const config = getConfig();
    const token = config.azureEmulator
      ? generateBlobSASQueryParameters({
          containerName: container,
          blobName,
          permissions: BlobSASPermissions.parse("r"),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn,
        }, this.sharedKey!).toString()
      : generateBlobSASQueryParameters({
      containerName: container,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn: new Date(Date.now() - 60_000),
      expiresOn,
        }, await this.getDelegationKey(expiresOn), config.storageAccountName!).toString();
    return `${this.service.url.replace(/\/$/, "")}/${container}/${encodedBlobPath(blobName)}?${token}`;
  }

  private async getDelegationKey(expiresOn: Date): Promise<UserDelegationKey> {
    if (!this.delegationKey || this.delegationKey.cacheExpiresOn < expiresOn) {
      const response = await this.service.getUserDelegationKey(new Date(Date.now() - 60_000), expiresOn);
      this.delegationKey = Object.assign(response, { cacheExpiresOn: expiresOn }) as UserDelegationKey & { cacheExpiresOn: Date };
    }
    return this.delegationKey;
  }
}

let store: BlobStore | undefined;
export function getBlobStore(): BlobStore {
  store ??= getConfig().storageBackend === "azure" ? new AzureBlobStore() : new LocalBlobStore();
  return store;
}

export function resetBlobStoreForTests(): void {
  store = undefined;
}
