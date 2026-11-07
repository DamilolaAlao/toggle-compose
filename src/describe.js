const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

export async function describeImage(storage, name, ref) {
  const manifest = await storage.getManifest(name, ref);
  if (!manifest) return null;

  let doc;
  try {
    doc = JSON.parse(manifest.bytes.toString("utf8"));
  } catch {
    return base(manifest, name, ref, { note: "Manifest is not JSON." });
  }

  const mediaType = manifest.mediaType || doc.mediaType || "";
  if (isIndex(mediaType, doc)) {
    const platforms = (doc.manifests || []).map(descriptorPlatform);
    const preferred = prefer(platforms);
    let config = null;
    let layers = [];
    if (preferred?.digest) {
      const child = await readManifest(storage, name, preferred.digest);
      if (child) {
        config = child.config;
        layers = child.layers;
      }
    }
    return {
      ...base(manifest, name, ref),
      kind: "index",
      config,
      platforms,
      layers,
      selected: preferred?.digest || null,
    };
  }

  const image = await imageFromDoc(storage, doc);
  return {
    ...base(manifest, name, ref),
    kind: "image",
    config: image.config,
    layers: image.layers,
    platforms: image.config
      ? [{
          os: image.config.os,
          architecture: image.config.architecture,
          variant: image.config.variant,
          digest: manifest.digest,
          size: manifest.size,
          mediaType,
        }]
      : [],
    selected: manifest.digest,
  };
}

function base(manifest, name, ref, extra = {}) {
  return {
    name,
    ref,
    digest: manifest.digest,
    mediaType: manifest.mediaType,
    size: manifest.size,
    updatedAt: manifest.updatedAt,
    ...extra,
  };
}

function isIndex(mediaType, doc) {
  if (INDEX_TYPES.has(mediaType)) return true;
  return Array.isArray(doc.manifests) && !doc.config && !doc.layers;
}

async function readManifest(storage, name, digest) {
  const stored = await storage.getManifest(name, digest);
  const bytes = stored?.bytes || await storage.getBlobBytes(digest);
  if (!bytes) return null;
  try {
    return imageFromDoc(storage, JSON.parse(bytes.toString("utf8")));
  } catch {
    return null;
  }
}

async function imageFromDoc(storage, doc) {
  const layers = (doc.layers || []).map((layer) => ({
    digest: layer.digest,
    size: layer.size ?? null,
    mediaType: layer.mediaType || null,
  }));
  let config = null;
  if (doc.config?.digest) {
    const bytes = await storage.getBlobBytes(doc.config.digest);
    if (bytes) {
      try {
        config = readConfig(JSON.parse(bytes.toString("utf8")));
      } catch {
        config = null;
      }
    }
  }
  return { config, layers };
}

function descriptorPlatform(item) {
  return {
    os: item.platform?.os || null,
    architecture: item.platform?.architecture || null,
    variant: item.platform?.variant || null,
    digest: item.digest,
    size: item.size ?? null,
    mediaType: item.mediaType || null,
  };
}

function prefer(platforms) {
  return platforms.find((item) => item.os === "linux" && item.architecture === "amd64")
    || platforms.find((item) => item.os === "linux")
    || platforms[0]
    || null;
}

function readConfig(doc) {
  const inner = doc.config || {};
  return {
    architecture: doc.architecture || null,
    os: doc.os || null,
    variant: doc.variant || null,
    created: doc.created || null,
    author: doc.author || null,
    env: inner.Env || [],
    cmd: inner.Cmd || [],
    entrypoint: inner.Entrypoint || [],
    user: inner.User || "",
    workingDir: inner.WorkingDir || "",
    exposedPorts: Object.keys(inner.ExposedPorts || {}),
    labels: inner.Labels || {},
  };
}
