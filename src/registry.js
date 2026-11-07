import {
  externalUrl,
  parseByteRange,
  problem,
  readBody,
  registryHeaders,
  reply,
  sendRegistryError,
  pipeStream,
} from "./http.js";
import { isDigest, isValidName } from "./storage.js";

const ROUTES = [
  { op: "base", re: /^\/v2$/ },
  { op: "catalog", re: /^\/v2\/_catalog$/ },
  { op: "tags", re: /^\/v2\/(.+)\/tags\/list$/ },
  { op: "referrers", re: /^\/v2\/(.+)\/referrers\/([^/]+)$/ },
  { op: "manifest", re: /^\/v2\/(.+)\/manifests\/([^/]+)$/ },
  { op: "upload", re: /^\/v2\/(.+)\/blobs\/uploads\/([^/]+)$/ },
  { op: "uploads", re: /^\/v2\/(.+)\/blobs\/uploads$/ },
  { op: "blob", re: /^\/v2\/(.+)\/blobs\/([^/]+)$/ },
];

export async function handleRegistry(req, res, url, storage) {
  try {
    await route(req, res, url, storage);
  } catch (error) {
    if (res.headersSent) {
      console.error(JSON.stringify({ msg: "registry error after headers", error: error.message }));
      res.destroy(error);
      return;
    }
    if (error.status && error.code) {
      return sendRegistryError(req, res, error.status, error.code, error.message, error.detail);
    }
    console.error(JSON.stringify({ msg: "registry error", error: error.message }));
    return sendRegistryError(req, res, 500, "UNKNOWN", "internal error");
  }
}

async function route(req, res, url, storage) {
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);

  let match = null;
  for (const route of ROUTES) {
    const found = route.re.exec(pathname);
    if (found) {
      match = { op: route.op, groups: found.slice(1) };
      break;
    }
  }
  if (!match) throw problem(404, "NAME_UNKNOWN", "route not found");

  if (match.op === "base") return base(req, res);
  if (match.op === "catalog") return catalog(req, res, url, storage);

  const name = decodeName(match.groups[0]);
  if (!isValidName(name)) throw problem(400, "NAME_INVALID", "repository name is invalid");
  if (match.op === "tags") return tags(req, res, url, storage, name);
  if (match.op === "referrers") return referrers(req, res, match.groups[1]);
  if (match.op === "blob") return blob(req, res, storage, match.groups[1]);
  if (match.op === "uploads") return uploads(req, res, url, storage, name);
  if (match.op === "upload") return upload(req, res, url, storage, name, match.groups[1]);
  if (match.op === "manifest") return manifest(req, res, storage, name, decodeURIComponent(match.groups[1]));
  throw problem(404, "NAME_UNKNOWN", "route not found");
}

function base(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return unsupported(req, res, "GET, HEAD");
  return reply(req, res, 200, "{}", {
    ...registryHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  });
}

async function catalog(req, res, url, storage) {
  if (req.method !== "GET") return unsupported(req, res, "GET");
  const result = await storage.catalog({ n: url.searchParams.get("n"), last: url.searchParams.get("last") });
  const headers = { ...registryHeaders(), "Content-Type": "application/json; charset=utf-8" };
  if (result.more && result.next) headers.Link = linkHeader("/v2/_catalog", result.limit, result.next);
  return reply(req, res, 200, JSON.stringify({ repositories: result.repositories }), headers);
}

async function tags(req, res, url, storage, name) {
  if (req.method !== "GET") return unsupported(req, res, "GET");
  const result = await storage.listTags(name, { n: url.searchParams.get("n"), last: url.searchParams.get("last") });
  if (!result) throw problem(404, "NAME_UNKNOWN", "repository not found", name);
  const headers = { ...registryHeaders(), "Content-Type": "application/json; charset=utf-8" };
  if (result.more && result.next) {
    headers.Link = linkHeader(`/v2/${name}/tags/list`, result.limit, result.next);
  }
  return reply(req, res, 200, JSON.stringify({ name, tags: result.tags }), headers);
}

function referrers(req, res, digest) {
  if (req.method !== "GET") return unsupported(req, res, "GET");
  if (!isDigest(digest)) throw problem(400, "DIGEST_INVALID", "digest is invalid");
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [],
  };
  return reply(req, res, 200, JSON.stringify(index), {
    ...registryHeaders(),
    "Content-Type": "application/vnd.oci.image.index.v1+json",
  });
}

async function blob(req, res, storage, digest) {
  if (!isDigest(digest)) throw problem(400, "DIGEST_INVALID", "digest is invalid");
  if (req.method === "DELETE") {
    const removed = await storage.deleteBlob(digest);
    if (!removed) throw problem(404, "BLOB_UNKNOWN", "blob unknown to registry", digest);
    return empty(req, res, 202, registryHeaders({ "Docker-Content-Digest": digest }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return unsupported(req, res, "GET, HEAD, DELETE");

  const stat = await storage.statBlob(digest);
  if (!stat) throw problem(404, "BLOB_UNKNOWN", "blob unknown to registry", digest);
  const range = parseByteRange(req.headers.range, stat.size);
  if (range?.invalid) throw problem(400, "BLOB_UNKNOWN", "invalid range", digest);
  if (range?.unsatisfiable) {
    return empty(req, res, 416, registryHeaders({
      "Content-Range": `bytes */${stat.size}`,
      "Docker-Content-Digest": digest,
    }));
  }

  const headers = registryHeaders({
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Docker-Content-Digest": digest,
    "Content-Length": String(range ? range.end - range.start + 1 : stat.size),
  });
  if (range) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
  }
  if (req.method === "HEAD") return empty(req, res, range ? 206 : 200, headers);

  const opened = await storage.openBlob(digest, range);
  if (!opened) throw problem(404, "BLOB_UNKNOWN", "blob unknown to registry", digest);
  res.writeHead(range ? 206 : 200, headers);
  res.on("close", () => {
    if (!res.writableEnded && opened.stream?.destroy) opened.stream.destroy();
  });
  await pipeStream(res, opened.stream);
  return undefined;
}

async function uploads(req, res, url, storage, name) {
  if (req.method !== "POST") return unsupported(req, res, "POST");
  const mount = url.searchParams.get("mount");
  const digest = url.searchParams.get("digest");
  const body = await readBody(req);

  if (mount && body.length === 0) {
    if (!isDigest(mount)) throw problem(400, "DIGEST_INVALID", "mount digest is invalid");
    if (await storage.hasBlob(mount)) return createdBlob(req, res, name, mount);
  }

  if (digest) {
    if (!body.length) throw problem(400, "BLOB_UPLOAD_INVALID", "monolithic upload requires a body");
    const stored = await storage.monolithicUpload(body, digest);
    return createdBlob(req, res, name, stored.digest);
  }

  const session = await storage.startUpload(name);
  let offset = 0;
  if (body.length) {
    const patched = await storage.patchUpload(name, session.uuid, body);
    offset = patched.offset;
  }
  return acceptedUpload(req, res, name, session.uuid, offset);
}

async function upload(req, res, url, storage, name, uuid) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(uuid)) throw problem(404, "BLOB_UPLOAD_UNKNOWN", "upload unknown");
  if (req.method === "GET" || req.method === "HEAD") {
    const status = await storage.uploadStatus(name, uuid);
    if (!status) throw problem(404, "BLOB_UPLOAD_UNKNOWN", "upload unknown");
    return empty(req, res, 204, uploadHeaders(req, name, uuid, status.offset));
  }
  if (req.method === "DELETE") {
    const removed = await storage.deleteUpload(name, uuid);
    if (!removed) throw problem(404, "BLOB_UPLOAD_UNKNOWN", "upload unknown");
    return empty(req, res, 204, registryHeaders());
  }
  if (req.method === "PATCH") {
    const chunk = await readBody(req);
    const status = await storage.patchUpload(name, uuid, chunk, req.headers["content-range"]);
    if (!status) throw problem(404, "BLOB_UPLOAD_UNKNOWN", "upload unknown");
    return acceptedUpload(req, res, name, uuid, status.offset);
  }
  if (req.method === "PUT") {
    const digest = url.searchParams.get("digest");
    const chunk = await readBody(req);
    const stored = await storage.completeUpload(name, uuid, digest, chunk);
    if (!stored) throw problem(404, "BLOB_UPLOAD_UNKNOWN", "upload unknown");
    return createdBlob(req, res, name, stored.digest);
  }
  return unsupported(req, res, "GET, HEAD, PATCH, PUT, DELETE");
}

async function manifest(req, res, storage, name, reference) {
  if (req.method === "PUT") {
    const bytes = await readBody(req);
    const mediaType = String(req.headers["content-type"] || "").split(";")[0].trim();
    const stored = await storage.putManifest(name, reference, bytes, mediaType);
    return empty(req, res, 201, registryHeaders({
      "Docker-Content-Digest": stored.digest,
      Location: externalUrl(req, `/v2/${name}/manifests/${stored.digest}`),
      "Content-Type": mediaType,
    }));
  }
  if (req.method === "DELETE") {
    const removed = await storage.deleteRef(name, reference);
    if (!removed) throw problem(404, "MANIFEST_UNKNOWN", "manifest unknown", reference);
    return empty(req, res, 202, registryHeaders());
  }
  if (req.method !== "GET" && req.method !== "HEAD") return unsupported(req, res, "GET, HEAD, PUT, DELETE");

  const stored = await storage.getManifest(name, reference);
  if (!stored) throw problem(404, "MANIFEST_UNKNOWN", "manifest unknown", reference);
  if (!acceptable(req.headers.accept, stored.mediaType)) {
    throw problem(404, "MANIFEST_UNKNOWN", "manifest unknown", reference);
  }
  return reply(req, res, 200, stored.bytes, registryHeaders({
    "Content-Type": stored.mediaType,
    "Docker-Content-Digest": stored.digest,
  }));
}

function createdBlob(req, res, name, digest) {
  return empty(req, res, 201, registryHeaders({
    Location: externalUrl(req, `/v2/${name}/blobs/${digest}`),
    "Docker-Content-Digest": digest,
  }));
}

function acceptedUpload(req, res, name, uuid, offset) {
  return empty(req, res, 202, uploadHeaders(req, name, uuid, offset));
}

function uploadHeaders(req, name, uuid, offset) {
  return registryHeaders({
    Location: externalUrl(req, `/v2/${name}/blobs/uploads/${uuid}`),
    Range: offset ? `0-${offset - 1}` : "0-0",
    "Docker-Upload-UUID": uuid,
  });
}

function empty(req, res, status, headers) {
  return reply(req, res, status, null, headers);
}

function unsupported(req, res, allow) {
  return sendRegistryError(req, res, 405, "UNSUPPORTED", "method not allowed", undefined, { Allow: allow });
}

function linkHeader(pathname, limit, last) {
  const query = new URLSearchParams({ n: String(limit), last });
  return `<${pathname}?${query.toString()}>; rel="next"`;
}

function decodeName(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function acceptable(header, mediaType) {
  if (!header) return true;
  const types = header.split(",").map((part) => part.split(";")[0].trim().toLowerCase());
  if (types.includes("*/*") || types.includes("application/*") || types.includes("application/json")) return true;
  return types.includes(String(mediaType || "").toLowerCase());
}
