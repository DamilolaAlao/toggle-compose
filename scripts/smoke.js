import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

process.env.TOGGLE_R2_MEMORY = "1";
process.env.TOGGLE_GC_GRACE_MS = "600000";
process.env.TOGGLE_BLOB_BUFFER = String(32 * 1024 * 1024);

const exec = promisify(execFile);
const { createApp } = await import("../src/server.js");
const { backendConfig } = await import("../src/r2.js");

const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar";

let base = "";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function repoPath(name, suffix) {
  const head = name.split("/").map(encodeURIComponent).join("/");
  return `/v2/${head}${suffix}`;
}

async function call(method, requestPath, { body, headers } = {}) {
  const response = await fetch(`${base}${requestPath}`, { method, body, headers });
  const buf = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") || "";
  let json = null;
  if (type.includes("json") && buf.length) json = JSON.parse(buf.toString("utf8"));
  return { status: response.status, headers: response.headers, body: buf, text: buf.toString("utf8"), json };
}

function nextPath(link) {
  const match = /<([^>]+)>/.exec(link || "");
  return match ? match[1] : null;
}

async function putBlob(name, bytes, { headers } = {}) {
  const digest = sha256(bytes);
  const response = await call("POST", `${repoPath(name, "/blobs/uploads/")}?digest=${encodeURIComponent(digest)}`, {
    body: bytes,
    headers: { "content-type": "application/octet-stream", ...headers },
  });
  check(response.status === 201, `blob upload ${response.status} ${response.text}`);
  check(response.headers.get("docker-content-digest") === digest, "blob digest header");
  return { digest, size: bytes.length };
}

async function putManifest(name, ref, manifest, mediaType = OCI_MANIFEST) {
  const body = Buffer.from(JSON.stringify(manifest));
  const response = await call("PUT", repoPath(name, `/manifests/${encodeURIComponent(ref)}`), {
    body,
    headers: { "content-type": mediaType },
  });
  check(response.status === 201, `manifest upload ${response.status} ${response.text}`);
  check(response.headers.get("docker-content-digest") === sha256(body), "manifest digest");
  return { body, digest: sha256(body) };
}

function imageConfig(command) {
  const bytes = Buffer.from(JSON.stringify({
    architecture: "amd64",
    os: "linux",
    created: "2026-11-07T12:00:00Z",
    config: { Cmd: [command], Env: ["PATH=/"], User: "root", WorkingDir: "/" },
    rootfs: { type: "layers", diff_ids: [] },
  }));
  return bytes;
}

async function pushImage(name, tag, { command = "/hello", layer = "layer-bytes" } = {}) {
  const configBytes = imageConfig(command);
  const layerBytes = Buffer.from(layer);
  const config = await putBlob(name, configBytes);
  const blob = await putBlob(name, layerBytes);
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: OCI_CONFIG, digest: config.digest, size: config.size },
    layers: [{ mediaType: OCI_LAYER, digest: blob.digest, size: blob.size }],
  };
  const stored = await putManifest(name, tag, manifest);
  return { config, blob, manifest: stored, manifestDoc: manifest };
}

function assertR2Config() {
  const config = backendConfig({
    R2_ACCOUNT_ID: "abc123",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "toggle",
  });
  check(config.kind === "r2", "expected r2 backend");
  check(config.bucket === "toggle", "bucket");
  check(config.endpoint === "https://abc123.r2.cloudflarestorage.com", config.endpoint);
  check(!JSON.stringify(config).includes("secret-value-should-not-exist"), "config shape");

  const jurisdiction = backendConfig({
    R2_ACCOUNT_ID: "abc123",
    R2_ACCESS_KEY_ID: "key",
    R2_SECRET_ACCESS_KEY: "secret",
    R2_BUCKET: "toggle",
    R2_ENDPOINT: "https://abc123.eu.r2.cloudflarestorage.com/",
  });
  check(jurisdiction.endpoint === "https://abc123.eu.r2.cloudflarestorage.com", jurisdiction.endpoint);

  try {
    backendConfig({});
    throw new Error("missing R2 config should throw");
  } catch (error) {
    check(String(error.message).includes("R2_BUCKET"), error.message);
  }
  check(backendConfig({ TOGGLE_R2_MEMORY: "1" }).kind === "memory", "memory backend");
  console.log("ok r2 config");
}

async function run() {
  assertR2Config();

  const health = await call("GET", "/healthz");
  check(health.status === 200 && health.json.ok === true && health.json.service === "toggle", "healthz");
  const apiHealth = await call("GET", "/api/health");
  check(apiHealth.json.service === "toggle", "api health");
  console.log("ok health");

  const anonymous = await call("GET", "/v2/", {
    headers: { authorization: `Basic ${Buffer.from("anyone:nope").toString("base64")}` },
  });
  check(anonymous.status === 200, "anonymous /v2");
  check(anonymous.headers.get("docker-distribution-api-version") === "registry/2.0", "distribution header");
  check(!anonymous.headers.get("www-authenticate"), "no auth challenge");
  const headBase = await call("HEAD", "/v2/");
  check(headBase.status === 200 && headBase.body.length === 0, "head /v2");
  const wrongMethod = await call("POST", "/v2/");
  check(wrongMethod.status === 405, "method not allowed");
  const badName = await call("GET", "/v2/Bad_Name/tags/list");
  check(badName.status === 400 && badName.json.errors[0].code === "NAME_INVALID", "invalid name");
  const missingRepo = await call("GET", "/v2/missing/repo/tags/list");
  check(missingRepo.status === 404 && missingRepo.json.errors[0].code === "NAME_UNKNOWN", "missing repo");
  console.log("ok anonymous registry");

  const mismatch = await call("POST", `${repoPath("alpha/app", "/blobs/uploads/")}?digest=${encodeURIComponent(`sha256:${"ab".repeat(32)}`)}`, {
    body: Buffer.from("nope"),
    headers: { "content-type": "application/octet-stream" },
  });
  check(mismatch.status === 400 && mismatch.json.errors[0].code === "DIGEST_INVALID", "digest mismatch");

  const layer = await putBlob("alpha/app", Buffer.from("hello world"), {
    headers: { authorization: `Basic ${Buffer.from("ignored:ignored").toString("base64")}` },
  });
  const ranged = await call("GET", `${repoPath("alpha/app", `/blobs/${layer.digest}`)}`, {
    headers: { range: "bytes=0-4" },
  });
  check(ranged.status === 206 && ranged.body.toString() === "hello", `range body ${ranged.body.toString()}`);
  check(ranged.headers.get("content-range") === "bytes 0-4/11", ranged.headers.get("content-range"));
  const headBlob = await call("HEAD", repoPath("alpha/app", `/blobs/${layer.digest}`));
  check(headBlob.status === 200 && headBlob.headers.get("content-length") === "11", "head blob");
  const tooFar = await call("GET", repoPath("alpha/app", `/blobs/${layer.digest}`), {
    headers: { range: "bytes=100-200" },
  });
  check(tooFar.status === 416, "unsatisfiable range");
  console.log("ok blobs");

  const previousBuffer = process.env.TOGGLE_BLOB_BUFFER;
  process.env.TOGGLE_BLOB_BUFFER = "4";
  const hello = sha256(Buffer.from("hello"));
  try {
  const started = await call("POST", repoPath("alpha/app", "/blobs/uploads/"));
  check(started.status === 202, `start upload ${started.status} ${started.text}`);
  const uuid = started.headers.get("docker-upload-uuid");
  check(uuid, "upload uuid");
  check(started.headers.get("range") === "0-0", "empty range");
  const first = await call("PATCH", repoPath("alpha/app", `/blobs/uploads/${uuid}`), {
    body: Buffer.from("hel"),
    headers: { "content-type": "application/octet-stream", "content-range": "0-2" },
  });
  check(first.status === 202 && first.headers.get("range") === "0-2", "first patch");
  const badRange = await call("PATCH", repoPath("alpha/app", `/blobs/uploads/${uuid}`), {
    body: Buffer.from("NO"),
    headers: { "content-range": "0-1" },
  });
  check(badRange.status === 400, "bad content range");
  const second = await call("PATCH", repoPath("alpha/app", `/blobs/uploads/${uuid}`), {
    body: Buffer.from("lo"),
    headers: { "content-range": "3-4" },
  });
  check(second.status === 202 && second.headers.get("range") === "0-4", "second patch");
  const status = await call("GET", repoPath("alpha/app", `/blobs/uploads/${uuid}`));
  check(status.status === 204 && status.headers.get("range") === "0-4", "upload status");
  const done = await call("PUT", `${repoPath("alpha/app", `/blobs/uploads/${uuid}`)}?digest=${encodeURIComponent(hello)}`);
  check(done.status === 201 && done.headers.get("docker-content-digest") === hello, "complete upload");
  const fetched = await call("GET", repoPath("alpha/app", `/blobs/${hello}`));
  check(fetched.body.toString() === "hello", "chunked bytes");
  } finally {
    process.env.TOGGLE_BLOB_BUFFER = previousBuffer;
  }

  const cancelled = await call("POST", repoPath("alpha/app", "/blobs/uploads/"));
  const cancelId = cancelled.headers.get("docker-upload-uuid");
  const removedUpload = await call("DELETE", repoPath("alpha/app", `/blobs/uploads/${cancelId}`));
  check(removedUpload.status === 204, "delete upload");
  const gone = await call("GET", repoPath("alpha/app", `/blobs/uploads/${cancelId}`));
  check(gone.status === 404, "deleted upload");
  console.log("ok chunked upload");

  const mounted = await call("POST", `${repoPath("beta/app", "/blobs/uploads/")}?mount=${encodeURIComponent(hello)}&from=${encodeURIComponent("alpha/app")}`);
  check(mounted.status === 201 && mounted.headers.get("docker-content-digest") === hello, "mount");
  const missingMount = `sha256:${"cd".repeat(32)}`;
  const mountMiss = await call("POST", `${repoPath("beta/app", "/blobs/uploads/")}?mount=${encodeURIComponent(missingMount)}&from=alpha/app`);
  check(mountMiss.status === 202, "mount miss starts an upload");
  await call("DELETE", repoPath("beta/app", `/blobs/uploads/${mountMiss.headers.get("docker-upload-uuid")}`));
  console.log("ok mount");

  const pushed = await pushImage("library/demo", "latest", { command: "/hello", layer: "demo-layer" });
  const manifestGet = await call("GET", repoPath("library/demo", "/manifests/latest"), {
    headers: { accept: OCI_MANIFEST },
  });
  check(manifestGet.status === 200, "get manifest");
  check(manifestGet.headers.get("docker-content-digest") === pushed.manifest.digest, "get digest");
  check(manifestGet.body.equals(pushed.manifest.body), "manifest bytes");
  const byDigest = await call("HEAD", repoPath("library/demo", `/manifests/${pushed.manifest.digest}`), {
    headers: { accept: OCI_MANIFEST },
  });
  check(byDigest.status === 200 && byDigest.headers.get("content-length") === String(pushed.manifest.body.length), "head manifest");
  const rejected = await call("GET", repoPath("library/demo", "/manifests/latest"), {
    headers: { accept: "application/vnd.docker.distribution.manifest.v1+prettyjws" },
  });
  check(rejected.status === 404 && rejected.json.errors[0].code === "MANIFEST_UNKNOWN", "accept mismatch");
  const badRef = await call("PUT", repoPath("library/demo", `/manifests/${encodeURIComponent(`sha256:${"11".repeat(32)}`)}`), {
    body: pushed.manifest.body,
    headers: { "content-type": OCI_MANIFEST },
  });
  check(badRef.status === 400 && badRef.json.errors[0].code === "DIGEST_INVALID", "manifest digest mismatch");

  const amdConfig = imageConfig("/amd");
  const armConfig = Buffer.from(JSON.stringify({
    architecture: "arm64",
    os: "linux",
    config: { Cmd: ["/arm"] },
    rootfs: { type: "layers", diff_ids: [] },
  }));
  const amdLayer = Buffer.from("amd-layer");
  const armLayer = Buffer.from("arm-layer");
  const amdConfigBlob = await putBlob("library/multi", amdConfig);
  const armConfigBlob = await putBlob("library/multi", armConfig);
  const amdLayerBlob = await putBlob("library/multi", amdLayer);
  const armLayerBlob = await putBlob("library/multi", armLayer);
  const amdManifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: OCI_CONFIG, digest: amdConfigBlob.digest, size: amdConfigBlob.size },
    layers: [{ mediaType: OCI_LAYER, digest: amdLayerBlob.digest, size: amdLayerBlob.size }],
  };
  const armManifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: OCI_CONFIG, digest: armConfigBlob.digest, size: armConfigBlob.size },
    layers: [{ mediaType: OCI_LAYER, digest: armLayerBlob.digest, size: armLayerBlob.size }],
  };
  const amdStored = await putManifest("library/multi", sha256(Buffer.from(JSON.stringify(amdManifest))), amdManifest);
  const armStored = await putManifest("library/multi", sha256(Buffer.from(JSON.stringify(armManifest))), armManifest);
  const index = {
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [
      { mediaType: OCI_MANIFEST, digest: armStored.digest, size: armStored.body.length, platform: { os: "linux", architecture: "arm64" } },
      { mediaType: OCI_MANIFEST, digest: amdStored.digest, size: amdStored.body.length, platform: { os: "linux", architecture: "amd64" } },
    ],
  };
  await putManifest("library/multi", "latest", index, OCI_INDEX);
  console.log("ok manifests");

  await putManifest("aaa", "1.0", { schemaVersion: 2, mediaType: OCI_MANIFEST });
  await putManifest("mmm", "1.0", { schemaVersion: 2, mediaType: OCI_MANIFEST });
  await putManifest("zzz", "1.0", { schemaVersion: 2, mediaType: OCI_MANIFEST });
  await putManifest("library/demo", "1.0", pushed.manifestDoc);
  await putManifest("library/demo", "1.1", pushed.manifestDoc);
  const fullCatalog = await call("GET", "/v2/_catalog?n=1000");
  check(fullCatalog.status === 200 && fullCatalog.json.repositories.includes("library/demo"), "catalog");
  const walked = [];
  let cursor = "/v2/_catalog?n=1";
  for (let guard = 0; cursor && guard < 50; guard += 1) {
    const page = await call("GET", cursor);
    check(page.status === 200, `catalog page ${page.status}`);
    check(page.json.repositories.length <= 1, "page size");
    walked.push(...page.json.repositories);
    cursor = nextPath(page.headers.get("link"));
  }
  check(walked.join() === fullCatalog.json.repositories.join(), `catalog pages ${walked}`);
  const tagPage = await call("GET", "/v2/library/demo/tags/list?n=2");
  check(tagPage.json.tags.join() === "1.0,1.1", tagPage.json.tags.join());
  const tagNext = await call("GET", nextPath(tagPage.headers.get("link")));
  check(tagNext.json.tags.join() === "latest", tagNext.json.tags.join());
  const referrers = await call("GET", repoPath("library/demo", `/referrers/${pushed.manifest.digest}`));
  check(referrers.status === 200 && referrers.json.manifests.length === 0, "empty referrers");
  check(referrers.headers.get("content-type").includes("oci.image.index"), referrers.headers.get("content-type"));
  console.log("ok catalog");

  const overview = await call("GET", "/api/overview");
  check(overview.json.repositories.some((repo) => repo.name === "library/demo" && repo.tagCount === 3), "overview");
  const repository = await call("GET", "/api/repository?name=library/demo");
  check(repository.json.tags.length === 3, "repository tags");
  const described = await call("GET", "/api/image?name=library/demo&ref=latest");
  check(described.json.config.cmd[0] === "/hello", "describe command");
  check(described.json.layers[0].digest === pushed.blob.digest, "describe layer");
  const multi = await call("GET", "/api/image?name=library/multi&ref=latest");
  check(multi.json.platforms.length === 2, "platforms");
  check(multi.json.config.cmd[0] === "/amd", `selected config ${multi.json.config?.cmd}`);
  check(multi.json.layers[0].digest === amdLayerBlob.digest, "selected layer");
  check((await call("GET", "/api/login")).status === 404, "no login route");
  check((await call("GET", "/api/users")).status === 404, "no users route");
  check((await call("GET", "/api/session")).status === 404, "no session route");
  console.log("ok console");

  const deletedBlob = await call("DELETE", repoPath("alpha/app", `/blobs/${layer.digest}`));
  check(deletedBlob.status === 202, "delete blob");
  check((await call("GET", repoPath("alpha/app", `/blobs/${layer.digest}`))).status === 404, "blob gone");

  const orphan = await putBlob("gc/hold", Buffer.from("orphan-blob"));
  const kept = await pushImage("gc/keep", "v1", { layer: "keep-me" });
  const held = await call("POST", "/api/gc");
  check(held.json.keptRecent >= 1, `grace kept ${held.json.keptRecent}`);
  check((await call("HEAD", repoPath("gc/hold", `/blobs/${orphan.digest}`))).status === 200, "recent orphan kept");
  check((await call("HEAD", repoPath("gc/keep", `/blobs/${kept.blob.digest}`))).status === 200, "referenced kept");
  process.env.TOGGLE_GC_GRACE_MS = "0";
  const collected = await call("POST", "/api/gc");
  check(collected.json.deleted >= 1, "gc deleted");
  check((await call("HEAD", repoPath("gc/hold", `/blobs/${orphan.digest}`))).status === 404, "orphan collected");
  check((await call("HEAD", repoPath("gc/keep", `/blobs/${kept.blob.digest}`))).status === 200, "referenced survived gc");
  const storage = await call("GET", "/api/storage");
  check(storage.json.backend === "memory", storage.json.backend);
  check(storage.json.activity.some((event) => event.action === "prune"), "activity prune");
  console.log("ok gc");

  const deletedImage = await call("DELETE", "/api/image?name=library/demo&ref=1.0");
  check(deletedImage.status === 204, "delete tag");
  check((await call("GET", repoPath("library/demo", "/manifests/1.0"))).status === 404, "tag gone");
  const deletedRepo = await call("DELETE", "/api/repository?name=aaa");
  check(deletedRepo.status === 204, "delete repo");
  check((await call("GET", "/v2/aaa/tags/list")).status === 404, "repo gone");
  const after = await call("GET", "/api/storage");
  check(after.json.activity.some((event) => event.action === "delete" && event.name === "aaa"), "activity delete");
  console.log("ok delete");

  const stylesheet = await call("GET", "/styles.css");
  check(stylesheet.status === 200 && stylesheet.text.includes("--blue"), "css");
  const spa = await call("GET", "/repo?name=library/demo");
  check(spa.status === 200 && spa.text.includes('id="app"'), "spa fallback");
  check((await call("GET", "/missing.js")).status === 404, "missing asset");
  console.log("ok static");
}

async function dockerPushPull(port) {
  try {
    await exec("docker", ["info"], { timeout: 8000 });
  } catch {
    console.log("docker push/pull skipped: docker is not available");
    return;
  }

  const directory = await mkdtemp(path.join(tmpdir(), "toggle-smoke-"));
  const image = `127.0.0.1:${port}/toggle-smoke:v1`;
  try {
    await writeFile(path.join(directory, "hello"), "toggle\n");
    await writeFile(path.join(directory, "Dockerfile"), "FROM scratch\nCOPY hello /hello\n");
    await exec("docker", ["build", "-t", image, directory], { timeout: 60000 });
    await exec("docker", ["push", image], { timeout: 60000 });
    await exec("docker", ["rmi", image], { timeout: 20000 });
    await exec("docker", ["pull", image], { timeout: 60000 });
    const listed = await call("GET", "/v2/toggle-smoke/tags/list");
    check(listed.status === 200 && listed.json.tags.includes("v1"), "docker tag missing after push");
    console.log("ok docker push/pull");
  } catch (error) {
    const text = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
    if (/https|insecure|HTTP response|server gave HTTP/i.test(text)) {
      console.log("docker push/pull skipped: the daemon will not push to this HTTP registry");
      return;
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const { handler } = await createApp();
const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
  await run();
  await dockerPushPull(port);
  console.log("toggle smoke passed");
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
