import { describeImage } from "./describe.js";
import { sendJson } from "./http.js";
import { isDigest, isTag, isValidName } from "./storage.js";

export async function handleConsole(req, res, url, storage) {
  try {
    await route(req, res, url, storage);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return sendJson(req, res, status, { error: status >= 500 || !error.expose ? "internal error" : error.message });
  }
}

async function route(req, res, url, storage) {
  const path = url.pathname;
  if (path === "/api/overview") {
    if (req.method !== "GET") return methodNotAllowed(req, res);
    return sendJson(req, res, 200, await storage.overview());
  }
  if (path === "/api/repository") {
    const name = requiredName(url);
    if (req.method === "GET") {
      const repository = await storage.getRepository(name);
      if (!repository) throw clientError(404, "repository not found");
      return sendJson(req, res, 200, repository);
    }
    if (req.method === "DELETE") {
      const removed = await storage.deleteRepository(name);
      if (!removed) throw clientError(404, "repository not found");
      return sendEmpty(res);
    }
    return methodNotAllowed(req, res);
  }
  if (path === "/api/image") {
    const name = requiredName(url);
    const ref = requiredRef(url);
    if (req.method === "GET") {
      const image = await describeImage(storage, name, ref);
      if (!image) throw clientError(404, "image not found");
      return sendJson(req, res, 200, image);
    }
    if (req.method === "DELETE") {
      const removed = await storage.deleteRef(name, ref);
      if (!removed) throw clientError(404, "image not found");
      return sendEmpty(res);
    }
    return methodNotAllowed(req, res);
  }
  if (path === "/api/storage") {
    if (req.method !== "GET") return methodNotAllowed(req, res);
    return sendJson(req, res, 200, await storage.stats());
  }
  if (path === "/api/gc") {
    if (req.method !== "POST") return methodNotAllowed(req, res);
    return sendJson(req, res, 200, await storage.gc());
  }
  return sendJson(req, res, 404, { error: "not found" });
}

function requiredName(url) {
  const name = url.searchParams.get("name") || "";
  if (!name) throw clientError(400, "name is required");
  if (!isValidName(name)) throw clientError(400, "repository name is invalid");
  return name;
}

function requiredRef(url) {
  const ref = url.searchParams.get("ref") || "";
  if (!ref) throw clientError(400, "ref is required");
  if (!isDigest(ref) && !isTag(ref)) throw clientError(400, "ref is invalid");
  return ref;
}

function clientError(status, message) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

function methodNotAllowed(req, res) {
  return sendJson(req, res, 405, { error: "method not allowed" });
}

function sendEmpty(res) {
  res.writeHead(204);
  res.end();
}
