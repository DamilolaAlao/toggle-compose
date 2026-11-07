import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { problem } from "./http.js";
import { initR2 } from "./r2.js";

const DEFAULT_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_BUFFER = 32 * 1024 * 1024;
const ACTIVITY_KEY = "activity.jsonl";
const ACTIVITY_LIMIT = 1000;

const NAME_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export function isValidName(name) {
  return NAME_RE.test(name);
}

export function isDigest(value) {
  return DIGEST_RE.test(value);
}

export function isTag(value) {
  return TAG_RE.test(value);
}

export async function initStorage() {
  const store = await initR2();
  return createStorage(store);
}

export function createStorage(store) {
  const locks = new Map();

  function withLock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    locks.set(key, tail);
    tail.finally(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  function graceMs() {
    const raw = process.env.TOGGLE_GC_GRACE_MS;
    if (raw == null || raw === "") return DEFAULT_GRACE_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return DEFAULT_GRACE_MS;
    return value;
  }

  function bufferLimit() {
    const raw = process.env.TOGGLE_BLOB_BUFFER;
    if (raw == null || raw === "") return DEFAULT_BUFFER;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return DEFAULT_BUFFER;
    return value;
  }

  async function readJson(key) {
    const bytes = await store.get(key);
    if (!bytes) return null;
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
  }

  async function writeJson(key, value) {
    await store.put(key, Buffer.from(JSON.stringify(value)), { contentType: "application/json" });
  }

  async function log(event) {
    try {
      await withLock(ACTIVITY_KEY, async () => {
        const existing = await store.get(ACTIVITY_KEY);
        const entry = { at: new Date().toISOString() };
        for (const field of ["action", "target", "name", "ref", "digest", "deleted", "bytes", "keptRecent"]) {
          if (event[field] !== undefined) entry[field] = event[field];
        }
        const lines = existing ? existing.toString("utf8").split("\n").filter(Boolean) : [];
        lines.push(JSON.stringify(entry));
        const body = `${lines.slice(-ACTIVITY_LIMIT).join("\n")}\n`;
        await store.put(ACTIVITY_KEY, Buffer.from(body), { contentType: "application/x-ndjson" });
      });
    } catch (error) {
      console.error(JSON.stringify({ msg: "activity log failed", error: error.message }));
    }
  }

  async function activity(limit = 40) {
    const bytes = await store.get(ACTIVITY_KEY);
    if (!bytes) return [];
    const lines = bytes.toString("utf8").split("\n").filter(Boolean);
    const events = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip a torn line rather than failing the storage page.
      }
    }
    return events;
  }

  function parseRepoKey(key) {
    if (!key.startsWith("repositories/")) return null;
    const rest = key.slice("repositories/".length);
    const slash = rest.indexOf("/");
    if (slash < 1) return null;
    let name;
    try {
      name = decodeURIComponent(rest.slice(0, slash));
    } catch {
      return null;
    }
    const tail = rest.slice(slash + 1);
    if (tail.startsWith("tags/") && tail.endsWith(".json")) {
      try {
        return { name, kind: "tag", id: decodeURIComponent(tail.slice("tags/".length, -".json".length)) };
      } catch {
        return null;
      }
    }
    if (tail.startsWith("manifests/") && tail.endsWith(".json")) return { name, kind: "manifest" };
    return { name, kind: "other" };
  }

  async function groupedRepos() {
    const items = await store.list("repositories/");
    const repos = new Map();
    for (const item of items) {
      const parsed = parseRepoKey(item.key);
      if (!parsed) continue;
      if (!repos.has(parsed.name)) repos.set(parsed.name, { name: parsed.name, tagKeys: [] });
      if (parsed.kind === "tag") repos.get(parsed.name).tagKeys.push(item.key);
    }
    return repos;
  }

  async function repoExists(name) {
    const items = await store.list(repoPrefix(name));
    return items.some((item) => parseRepoKey(item.key)?.name === name);
  }

  async function allTags(name) {
    const items = await store.list(`${repoPrefix(name)}tags/`);
    const tags = [];
    for (const item of items) {
      if (!item.key.endsWith(".json")) continue;
      const record = await readJson(item.key);
      if (record?.name && record.digest) tags.push(record);
    }
    tags.sort((a, b) => a.name.localeCompare(b.name));
    return tags;
  }

  async function writeBlob(digest, bytes, contentType) {
    await store.put(blobKey(digest), bytes, { contentType: contentType || "application/octet-stream" });
  }

  async function hashParts(partKeys, finalChunk) {
    const hash = createHash("sha256");
    let size = 0;
    for (const key of partKeys) {
      const bytes = await store.get(key);
      if (!bytes) throw problem(400, "BLOB_UPLOAD_INVALID", "upload part is missing");
      hash.update(bytes);
      size += bytes.length;
    }
    if (finalChunk?.length) {
      hash.update(finalChunk);
      size += finalChunk.length;
    }
    return { digest: `sha256:${hash.digest("hex")}`, size };
  }

  function partStream(partKeys, finalChunk) {
    return Readable.from((async function* () {
      for (const key of partKeys) {
        const bytes = await store.get(key);
        if (!bytes) throw problem(400, "BLOB_UPLOAD_INVALID", "upload part is missing");
        yield bytes;
      }
      if (finalChunk?.length) yield finalChunk;
    })());
  }

  async function finishBlob(digest, partKeys, finalChunk, size) {
    if (size <= bufferLimit()) {
      const chunks = [];
      for (const key of partKeys) chunks.push(await store.get(key));
      if (finalChunk?.length) chunks.push(finalChunk);
      await writeBlob(digest, Buffer.concat(chunks), "application/octet-stream");
      return;
    }
    await store.putStream(blobKey(digest), partStream(partKeys, finalChunk), size, "application/octet-stream");
  }

  function page(items, query) {
    const limit = clampLimit(query.n);
    let start = 0;
    if (query.last) {
      const exact = items.indexOf(query.last);
      if (exact >= 0) start = exact + 1;
      else start = items.findIndex((item) => item > query.last);
      if (start < 0) start = items.length;
    }
    const slice = items.slice(start, start + limit);
    return {
      items: slice,
      limit,
      more: start + limit < items.length,
      next: slice.length ? slice[slice.length - 1] : null,
    };
  }

  async function blobUsage() {
    const items = await store.list("blobs/");
    let blobs = 0;
    let bytes = 0;
    for (const item of items) {
      if (!digestFromKey(item.key)) continue;
      blobs += 1;
      bytes += item.size || 0;
    }
    return { blobs, bytes };
  }

  async function walk(digest, seen, hintedType = "") {
    if (!isDigest(digest) || seen.has(digest)) return;
    seen.add(digest);
    const key = blobKey(digest);
    const stat = await store.head(key);
    if (!stat) return;
    const type = `${stat.contentType || ""} ${hintedType}`;
    if (!/json|manifest/i.test(type)) return;
    const bytes = await store.get(key);
    if (!bytes) return;
    let doc;
    try {
      doc = JSON.parse(bytes.toString("utf8"));
    } catch {
      return;
    }
    for (const link of manifestLinks(doc)) {
      await walk(link.digest, seen, link.mediaType || "");
    }
  }

  return {
    backend: store.kind,
    bucket: store.bucket,
    endpoint: store.endpoint,

    async overview() {
      const repos = await groupedRepos();
      const repositories = [];
      for (const repo of [...repos.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const tags = await allTags(repo.name);
        let updatedAt = null;
        for (const tag of tags) {
          if (!updatedAt || tag.updatedAt > updatedAt) updatedAt = tag.updatedAt;
        }
        repositories.push({ name: repo.name, tagCount: tags.length, updatedAt });
      }
      return { repositories, ...(await blobUsage()) };
    },

    async stats() {
      const repos = await groupedRepos();
      const uploads = (await store.list("uploads/")).filter((item) => item.key.endsWith("/meta.json"));
      return {
        backend: store.kind,
        bucket: store.bucket,
        endpoint: store.endpoint,
        ...(await blobUsage()),
        repositories: repos.size,
        uploads: uploads.length,
        graceMs: graceMs(),
        activity: await activity(40),
      };
    },

    async getRepository(name) {
      if (!isValidName(name) || !(await repoExists(name))) return null;
      const tags = await allTags(name);
      return {
        name,
        tags: [...tags].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      };
    },

    async deleteRepository(name) {
      if (!isValidName(name) || !(await repoExists(name))) return false;
      await store.deletePrefix(repoPrefix(name));
      await log({ action: "delete", target: "repository", name });
      return true;
    },

    async catalog(query) {
      const names = [...(await groupedRepos()).keys()].sort((a, b) => a.localeCompare(b));
      const result = page(names, query);
      return { repositories: result.items, ...result };
    },

    async listTags(name, query) {
      if (!isValidName(name) || !(await repoExists(name))) return null;
      const names = (await allTags(name)).map((tag) => tag.name);
      const result = page(names, query);
      return { name, tags: result.items, ...result };
    },

    async statBlob(digest) {
      if (!isDigest(digest)) return null;
      return store.head(blobKey(digest));
    },

    async openBlob(digest, range) {
      if (!isDigest(digest)) return null;
      return store.open(blobKey(digest), range);
    },

    async getBlobBytes(digest) {
      if (!isDigest(digest)) return null;
      return store.get(blobKey(digest));
    },

    async deleteBlob(digest) {
      if (!isDigest(digest)) return false;
      const stat = await store.head(blobKey(digest));
      if (!stat) return false;
      await store.delete(blobKey(digest));
      await log({ action: "delete", target: "blob", digest });
      return true;
    },

    async startUpload(name) {
      const uuid = randomUUID();
      const meta = { uuid, name, createdAt: new Date().toISOString(), offset: 0, parts: [] };
      await writeJson(uploadMeta(uuid), meta);
      return { uuid, offset: 0 };
    },

    async uploadStatus(name, uuid) {
      const meta = await readJson(uploadMeta(uuid));
      if (!meta || meta.name !== name) return null;
      return { uuid, offset: meta.offset || 0 };
    },

    async patchUpload(name, uuid, chunk, contentRange) {
      return withLock(`upload:${uuid}`, async () => {
        const meta = await readJson(uploadMeta(uuid));
        if (!meta || meta.name !== name) return null;
        const length = chunk?.length || 0;
        if (contentRange) checkContentRange(contentRange, meta.offset || 0, length);
        if (length) {
          const index = meta.parts.length;
          await store.put(partKey(uuid, index), chunk, { contentType: "application/octet-stream" });
          meta.parts.push({ index, size: length });
          meta.offset = (meta.offset || 0) + length;
        }
        await writeJson(uploadMeta(uuid), meta);
        return { uuid, offset: meta.offset || 0 };
      });
    },

    async deleteUpload(name, uuid) {
      const meta = await readJson(uploadMeta(uuid));
      if (!meta || meta.name !== name) return false;
      await store.deletePrefix(`uploads/${uuid}/`);
      return true;
    },

    async completeUpload(name, uuid, expectedDigest, finalChunk) {
      if (!isDigest(expectedDigest)) throw problem(400, "DIGEST_INVALID", "digest is required");
      return withLock(`upload:${uuid}`, async () => {
        const meta = await readJson(uploadMeta(uuid));
        if (!meta || meta.name !== name) {
          const existing = await store.head(blobKey(expectedDigest));
          return existing ? { digest: expectedDigest, size: existing.size, reused: true } : null;
        }
        const partKeys = meta.parts.map((part) => partKey(uuid, part.index));
        const hashed = await hashParts(partKeys, finalChunk);
        if (hashed.digest !== expectedDigest) {
          throw problem(400, "DIGEST_INVALID", "digest does not match uploaded content", {
            digest: hashed.digest,
          });
        }
        await finishBlob(hashed.digest, partKeys, finalChunk, hashed.size);
        await store.deletePrefix(`uploads/${uuid}/`);
        return { digest: hashed.digest, size: hashed.size };
      });
    },

    async monolithicUpload(bytes, expectedDigest) {
      if (!isDigest(expectedDigest)) throw problem(400, "DIGEST_INVALID", "digest is invalid");
      const digest = sha256(bytes);
      if (digest !== expectedDigest) {
        throw problem(400, "DIGEST_INVALID", "digest does not match content", { digest });
      }
      await writeBlob(digest, bytes, "application/octet-stream");
      return { digest, size: bytes.length };
    },

    async hasBlob(digest) {
      if (!isDigest(digest)) return false;
      return Boolean(await store.head(blobKey(digest)));
    },

    async putManifest(name, reference, bytes, mediaType) {
      if (!isValidName(name)) throw problem(400, "NAME_INVALID", "repository name is invalid");
      if (!mediaType) throw problem(400, "MANIFEST_INVALID", "content type is required");
      let doc;
      try {
        doc = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw problem(400, "MANIFEST_INVALID", "manifest is not json");
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        throw problem(400, "MANIFEST_INVALID", "manifest is not a json object");
      }
      const digest = sha256(bytes);
      if (reference.startsWith("sha256:")) {
        if (!isDigest(reference)) throw problem(400, "DIGEST_INVALID", "digest is invalid");
        if (reference !== digest) {
          throw problem(400, "DIGEST_INVALID", "digest does not match content", { digest });
        }
      } else if (!isTag(reference)) {
        throw problem(400, "TAG_INVALID", "tag is invalid");
      }
      const now = new Date().toISOString();
      const record = { digest, mediaType, size: bytes.length, updatedAt: now };
      await writeBlob(digest, bytes, mediaType);
      await writeJson(manifestKey(name, digest), record);
      if (!reference.startsWith("sha256:")) {
        await writeJson(tagKey(name, reference), { name: reference, ...record });
      }
      return record;
    },

    async getManifest(name, reference) {
      if (!isValidName(name)) return null;
      let record = null;
      if (isDigest(reference)) record = await readJson(manifestKey(name, reference));
      else if (isTag(reference)) record = await readJson(tagKey(name, reference));
      else return null;
      if (!record?.digest) return null;
      const bytes = await store.get(blobKey(record.digest));
      if (!bytes) return null;
      return {
        bytes,
        digest: record.digest,
        mediaType: record.mediaType,
        size: bytes.length,
        updatedAt: record.updatedAt || null,
      };
    },

    async deleteRef(name, reference) {
      if (!isValidName(name) || !(await repoExists(name))) return false;
      if (isDigest(reference)) {
        const record = await readJson(manifestKey(name, reference));
        const tags = (await allTags(name)).filter((tag) => tag.digest === reference);
        if (!record && tags.length === 0) return false;
        await store.delete(manifestKey(name, reference));
        for (const tag of tags) await store.delete(tagKey(name, tag.name));
        await log({ action: "delete", target: "manifest", name, ref: reference, digest: reference });
        return true;
      }
      if (!isTag(reference)) return false;
      const tag = await readJson(tagKey(name, reference));
      if (!tag) return false;
      await store.delete(tagKey(name, reference));
      await log({ action: "delete", target: "manifest", name, ref: reference, digest: tag.digest });
      return true;
    },

    async gc() {
      const grace = graceMs();
      const cutoff = Date.now() - grace;
      const seen = new Set();
      const repos = await groupedRepos();
      for (const repo of repos.values()) {
        for (const tag of await allTags(repo.name)) {
          await walk(tag.digest, seen, tag.mediaType || "");
        }
      }
      const items = await store.list("blobs/");
      let deleted = 0;
      let bytes = 0;
      let keptRecent = 0;
      for (const item of items) {
        const digest = digestFromKey(item.key);
        if (!digest || seen.has(digest)) continue;
        const uploaded = item.uploadedAt ? Date.parse(item.uploadedAt) : NaN;
        if (!Number.isFinite(uploaded) || uploaded > cutoff) {
          keptRecent += 1;
          continue;
        }
        await store.delete(item.key);
        deleted += 1;
        bytes += item.size || 0;
      }
      await log({ action: "prune", target: "blob", deleted, bytes, keptRecent });
      return { deleted, bytes, keptRecent };
    },
  };
}

function manifestLinks(doc) {
  if (!doc || typeof doc !== "object") return [];
  const links = [];
  if (typeof doc.config?.digest === "string") {
    links.push({ digest: doc.config.digest, mediaType: doc.config.mediaType });
  }
  for (const layer of doc.layers || []) {
    if (typeof layer?.digest === "string") links.push({ digest: layer.digest, mediaType: layer.mediaType });
  }
  for (const item of doc.manifests || []) {
    if (typeof item?.digest === "string") links.push({ digest: item.digest, mediaType: item.mediaType });
  }
  if (typeof doc.subject?.digest === "string") {
    links.push({ digest: doc.subject.digest, mediaType: doc.subject.mediaType });
  }
  return links;
}

function checkContentRange(header, offset, length) {
  const match = /^(?:bytes=)?(\d+)-(\d+)$/.exec(String(header).trim());
  if (!match) throw problem(400, "BLOB_UPLOAD_INVALID", "invalid content range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start !== offset || end - start + 1 !== length) {
    throw problem(400, "BLOB_UPLOAD_INVALID", "content range does not match the upload offset");
  }
}

function clampLimit(raw) {
  if (raw == null || raw === "") return 1000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1000;
  return Math.min(value, 1000);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function enc(value) {
  return encodeURIComponent(value);
}

function repoPrefix(name) {
  return `repositories/${enc(name)}/`;
}

function tagKey(name, tag) {
  return `${repoPrefix(name)}tags/${enc(tag)}.json`;
}

function manifestKey(name, digest) {
  return `${repoPrefix(name)}manifests/${digest.replace(":", "/")}.json`;
}

function blobKey(digest) {
  const [algo, hex] = digest.split(":");
  return `blobs/${algo}/${hex.slice(0, 2)}/${hex.slice(2)}`;
}

function digestFromKey(key) {
  const match = /^blobs\/(sha256)\/([a-f0-9]{2})\/([a-f0-9]+)$/.exec(key);
  if (!match) return null;
  const hex = match[2] + match[3];
  if (hex.length !== 64) return null;
  return `${match[1]}:${hex}`;
}

function uploadMeta(uuid) {
  return `uploads/${uuid}/meta.json`;
}

function partKey(uuid, index) {
  return `uploads/${uuid}/parts/${String(index).padStart(6, "0")}`;
}
