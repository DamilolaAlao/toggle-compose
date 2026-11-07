const DEFAULT_MAX_BODY = 512 * 1024 * 1024;

export function bodyLimit() {
  const raw = process.env.TOGGLE_MAX_BODY;
  if (raw == null || raw === "") return DEFAULT_MAX_BODY;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BODY;
  return value;
}

export function problem(status, code, message, detail) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.detail = detail;
  error.expose = status < 500;
  return error;
}

export function registryHeaders(extra = {}) {
  return {
    "Docker-Distribution-Api-Version": "registry/2.0",
    ...extra,
  };
}

export function reply(req, res, status, payload, headers = {}) {
  const body = payload == null ? null : Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const announced = body ? body.length : Number(headers["Content-Length"] ?? 0);
  res.writeHead(status, { ...headers, "Content-Length": String(announced) });
  if (req.method === "HEAD" || !body || body.length === 0) res.end();
  else res.end(body);
}

export function sendJson(req, res, status, value, headers = {}) {
  return reply(req, res, status, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
}

export function sendRegistryError(req, res, status, code, message, detail, headers = {}) {
  const error = { code, message };
  if (detail !== undefined) error.detail = detail;
  return sendJson(req, res, status, { errors: [error] }, { ...registryHeaders(), ...headers });
}

export function readBody(req) {
  const limit = bodyLimit();
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(problem(413, "SIZE_INVALID", "payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", (error) => finish(error));
  });
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const suffix = /^bytes=-(\d+)$/.exec(header.trim());
  if (suffix) {
    const length = Number(suffix[1]);
    if (!length || size === 0) return { unsatisfiable: true };
    const start = Math.max(0, size - length);
    return { start, end: size - 1 };
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return { invalid: true };
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Number(match[2]);
  if (size === 0 || start >= size || start > end) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

export function externalUrl(req, pathname) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${forwarded}://${host}${pathname}`;
}

export async function pipeStream(res, stream) {
  const iterator = stream[Symbol.asyncIterator] ? stream : streamIterator(stream);
  try {
    for await (const chunk of iterator) {
      if (res.destroyed) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (buf.length === 0) continue;
      if (!res.write(buf)) {
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
    throw error;
  }
}

async function* streamIterator(stream) {
  for await (const chunk of stream) yield chunk;
}
