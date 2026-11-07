import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handleConsole } from "./console.js";
import { sendJson } from "./http.js";
import { handleRegistry } from "./registry.js";
import { initStorage } from "./storage.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export async function createApp() {
  await loadEnv(path.join(rootDir, ".env"));
  const storage = await initStorage();
  return { storage, handler: createHandler(storage) };
}

export function createHandler(storage) {
  return async function handler(req, res) {
    const host = req.headers.host || "localhost";
    let url;
    try {
      url = new URL(req.url || "/", `http://${host}`);
    } catch {
      return sendJson(req, res, 400, { error: "bad request" });
    }

    try {
      if (req.method === "GET" || req.method === "HEAD") {
        if (url.pathname === "/healthz" || url.pathname === "/api/health") {
          return sendJson(req, res, 200, { ok: true, service: "toggle" });
        }
      }
      if (url.pathname === "/v2" || url.pathname.startsWith("/v2/")) {
        return handleRegistry(req, res, url, storage);
      }
      if (url.pathname.startsWith("/api/")) {
        return handleConsole(req, res, url, storage);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        return serveStatic(req, res, url.pathname);
      }
      return sendJson(req, res, 405, { error: "method not allowed" });
    } catch (error) {
      console.error(error);
      if (res.headersSent) {
        res.destroy(error);
        return;
      }
      return sendJson(req, res, 500, { error: "internal error" });
    }
  };
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = safeFile(requested);
  if (file && await isFile(file)) return sendFile(req, res, file);
  if (path.extname(requested)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : "not found");
    return;
  }
  return sendFile(req, res, path.join(publicDir, "index.html"));
}

function safeFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = path.resolve(publicDir, `.${decoded}`);
  if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) return null;
  return file;
}

async function isFile(file) {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

async function sendFile(req, res, file) {
  const info = await stat(file);
  const type = TYPES[path.extname(file)] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

async function loadEnv(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  createApp().then(({ storage, handler }) => {
    const port = Number(process.env.PORT || 8080);
    const host = process.env.HOST || "0.0.0.0";
    http.createServer((req, res) => {
      handler(req, res).catch((error) => {
        console.error(error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else {
          res.destroy(error);
        }
      });
    }).listen(port, host, () => {
      console.log(JSON.stringify({
        msg: "listening",
        port,
        host,
        service: "toggle",
        auth: false,
        backend: storage.backend,
        bucket: storage.bucket,
        endpoint: storage.endpoint,
      }));
    });
  }).catch((error) => {
    console.error(JSON.stringify({ msg: "startup failed", error: error.message }));
    process.exit(1);
  });
}
