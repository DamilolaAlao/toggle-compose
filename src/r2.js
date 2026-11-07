import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const REQUIRED = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];

export function backendConfig(env = process.env) {
  if (env.TOGGLE_R2_MEMORY === "1") {
    return { kind: "memory", bucket: "memory", endpoint: null };
  }

  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(
      `Cloudflare R2 is required. Set ${missing.join(", ")}, or TOGGLE_R2_MEMORY=1 for a temporary process store.`,
    );
  }

  const accountId = env.R2_ACCOUNT_ID;
  const endpoint = (env.R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, "");
  return {
    kind: "r2",
    bucket: env.R2_BUCKET,
    endpoint,
    accountId,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

export async function openStore() {
  const config = backendConfig();
  if (config.kind === "memory") return memoryStore();
  return r2Store(config);
}

function memoryStore() {
  const objects = new Map();
  return {
    kind: "memory",
    bucket: "memory",
    endpoint: null,
    async put(key, body, options = {}) {
      const buf = Buffer.from(body);
      objects.set(key, {
        body: buf,
        contentType: options.contentType || "application/octet-stream",
        uploadedAt: new Date().toISOString(),
      });
    },
    async putStream(key, stream, size, contentType) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (body.length !== size) {
        throw new Error(`upload size mismatch: expected ${size}, wrote ${body.length}`);
      }
      await this.put(key, body, { contentType });
    },
    async get(key) {
      const found = objects.get(key);
      return found ? Buffer.from(found.body) : null;
    },
    async head(key) {
      const found = objects.get(key);
      if (!found) return null;
      return {
        size: found.body.length,
        contentType: found.contentType,
        uploadedAt: found.uploadedAt,
      };
    },
    async open(key, range) {
      const found = objects.get(key);
      if (!found) return null;
      const total = found.body.length;
      const start = range ? range.start : 0;
      const end = range ? range.end : Math.max(0, total - 1);
      const slice = total === 0 ? Buffer.alloc(0) : found.body.subarray(start, end + 1);
      return {
        stream: [slice],
        size: slice.length,
        total,
        start,
        end: total === 0 ? 0 : end,
        contentType: found.contentType,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      const items = [];
      for (const [key, found] of objects) {
        if (!key.startsWith(prefix)) continue;
        items.push({ key, size: found.body.length, uploadedAt: found.uploadedAt });
      }
      items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return items;
    },
    async deletePrefix(prefix) {
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) objects.delete(key);
      }
    },
  };
}

function r2Store(config) {
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Keep the configured account or jurisdiction host. Virtual-hosted
    // addressing would rewrite it to a per-bucket hostname.
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = config.bucket;

  return {
    kind: "r2",
    bucket: config.bucket,
    endpoint: config.endpoint,
    async ready() {
      await ensureBucket(client, Bucket);
    },
    async put(key, body, options = {}) {
      await client.send(new PutObjectCommand({
        Bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: options.contentType || "application/octet-stream",
      }));
    },
    async putStream(key, stream, size, contentType) {
      await client.send(new PutObjectCommand({
        Bucket,
        Key: key,
        Body: stream,
        ContentLength: size,
        ContentType: contentType || "application/octet-stream",
      }));
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async head(key) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return {
          size: Number(out.ContentLength || 0),
          contentType: out.ContentType || "application/octet-stream",
          uploadedAt: out.LastModified ? new Date(out.LastModified).toISOString() : null,
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async open(key, range) {
      try {
        const input = { Bucket, Key: key };
        if (range) input.Range = `bytes=${range.start}-${range.end}`;
        const out = await client.send(new GetObjectCommand(input));
        const size = Number(out.ContentLength || 0);
        const total = totalSize(out, size, range);
        return {
          stream: out.Body,
          size,
          total,
          start: range ? range.start : 0,
          end: range ? range.end : Math.max(0, total - 1),
          contentType: out.ContentType || "application/octet-stream",
        };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async list(prefix) {
      const items = [];
      let token;
      do {
        const out = await client.send(new ListObjectsV2Command({
          Bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        for (const object of out.Contents || []) {
          items.push({
            key: object.Key,
            size: Number(object.Size || 0),
            uploadedAt: object.LastModified ? new Date(object.LastModified).toISOString() : null,
          });
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return items;
    },
    async deletePrefix(prefix) {
      const items = await this.list(prefix);
      for (let index = 0; index < items.length; index += 1000) {
        const Objects = items.slice(index, index + 1000).map((item) => ({ Key: item.key }));
        if (!Objects.length) continue;
        try {
          const out = await client.send(new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects, Quiet: true },
          }));
          if (out.Errors?.length) {
            throw new Error(out.Errors.map((error) => `${error.Key}: ${error.Message}`).join("; "));
          }
        } catch {
          for (const object of Objects) {
            await client.send(new DeleteObjectCommand({ Bucket, Key: object.Key }));
          }
        }
      }
    },
  };
}

function totalSize(out, size, range) {
  const header = out.ContentRange || "";
  const match = /\/(\d+)$/.exec(header);
  if (match) return Number(match[1]);
  if (!range) return size;
  return range.end + 1;
}

async function ensureBucket(client, bucket) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (error) {
    if (!isMissingBucket(error)) {
      if (isForbidden(error)) {
        console.log(JSON.stringify({ msg: "bucket head was forbidden; continuing", bucket }));
        return;
      }
      throw error;
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log(JSON.stringify({ msg: "created r2 bucket", bucket }));
    } catch (createError) {
      if (["BucketAlreadyExists", "BucketAlreadyOwnedByYou"].includes(createError.name)) return;
      throw createError;
    }
  }
}

function statusOf(error) {
  return error?.$metadata?.httpStatusCode;
}

function isNotFound(error) {
  return statusOf(error) === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey";
}

function isMissingBucket(error) {
  return isNotFound(error) || error?.name === "NoSuchBucket";
}

function isForbidden(error) {
  return statusOf(error) === 403 || error?.name === "Forbidden";
}

export async function initR2() {
  const store = await openStore();
  if (store.ready) await store.ready();
  return store;
}
