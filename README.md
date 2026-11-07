# Toggle Compose

A self-hosted container registry with a console that feels like Docker Hub, backed by Cloudflare R2.

Toggle Compose is one Node.js process. It speaks the OCI Distribution API, so `docker push` and `docker pull` work as they do against any registry. It also serves a web console where you can search repositories, browse tags, inspect image config and layers, and reclaim space. Every layer and manifest lands in an R2 bucket, so the process itself holds no data and can be restarted or moved at will.

It is intentionally simple. There are no accounts, tokens, or permissions. Anyone who can reach the port can push, pull, and delete. Run it on a network you trust and read [SECURITY.md](SECURITY.md) before exposing it anywhere else.

Released under the [MIT License](LICENSE).

## Highlights

- **Standard registry.** Monolithic and chunked uploads, cross-repository blob mounts, manifest lists for multi-arch images, tag listing, and deletes.
- **Docker Hub-style console.** Searchable, sortable repository catalog with tag counts and last-push times. One click copies the pull command.
- **Image inspection.** See the command, entrypoint, environment, labels, platforms, and layer sizes for any tag or digest.
- **R2 storage.** Content-addressed blobs in a single bucket. Chunked pushes are assembled on completion, so Docker's small chunks are handled without S3 multipart.
- **Safe garbage collection.** Prune removes blobs no tag references, and leaves anything uploaded in the last ten minutes alone so an in-flight push is never broken.
- **Small footprint.** One dependency (`@aws-sdk/client-s3`), no build step, no database.

## Quick start

You need Node.js 22, a Cloudflare R2 bucket, and an R2 API token with Object Read & Write on that bucket.

```bash
git clone https://github.com/DamilolaAlao/toggle-compose
cd toggle-compose
cp .env.example .env   # add your R2 account id, key, secret, and bucket
npm install
npm start
```

Open <http://127.0.0.1:8080> for the console. The bucket is created on first start if the token allows it.

To push an image, tell Docker the registry is plain HTTP by adding `127.0.0.1:8080` to `insecure-registries` in the daemon config, then:

```bash
docker tag alpine:latest 127.0.0.1:8080/library/alpine:latest
docker push 127.0.0.1:8080/library/alpine:latest
docker pull 127.0.0.1:8080/library/alpine:latest
```

The repository appears in the console as soon as the push completes.

### Docker Compose

```bash
R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… docker compose up --build
```

Compose reads the same variables from your shell or a local `.env`. Keep `.env` out of version control; it is already gitignored.

## Configuration

Set these in the environment or in `.env`. Values already present in the environment win over the file.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `R2_ACCOUNT_ID` | | Cloudflare account id. |
| `R2_ACCESS_KEY_ID` | | R2 token access key. |
| `R2_SECRET_ACCESS_KEY` | | R2 token secret. |
| `R2_BUCKET` | | Bucket name. Compose defaults it to `toggle`. |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` | Override for jurisdiction buckets, such as `https://<account-id>.eu.r2.cloudflarestorage.com`. |
| `TOGGLE_R2_MEMORY` | unset | Set to `1` to keep blobs in process memory instead of R2. Everything is lost on exit. Useful for demos and tests. |
| `TOGGLE_GC_GRACE_MS` | `600000` | How long an unreferenced blob is protected from pruning. |
| `TOGGLE_MAX_BODY` | `536870912` | Largest accepted request body, in bytes. |
| `TOGGLE_BLOB_BUFFER` | `33554432` | Blobs at or under this size are buffered in memory; larger ones stream to R2. |

## How it works

### Request dispatch

1. `GET /healthz` and `GET /api/health` return `{ "ok": true, "service": "toggle" }`.
2. `/v2` and anything under it go to the registry. The `Authorization` header is ignored and the server never sends `WWW-Authenticate`.
3. Other `/api/…` routes serve JSON for the console.
4. Everything else is a static file. Unknown paths fall back to `index.html` so console routes survive a refresh.

### Registry endpoints

| Operation | Path | Methods |
|---|---|---|
| Base | `/v2` | GET, HEAD |
| Catalog | `/v2/_catalog` | GET |
| Tags | `/v2/{name}/tags/list` | GET |
| Blob | `/v2/{name}/blobs/{digest}` | GET, HEAD, DELETE |
| Start upload | `/v2/{name}/blobs/uploads` | POST |
| Upload session | `/v2/{name}/blobs/uploads/{uuid}` | PATCH, PUT, GET, DELETE |
| Manifest | `/v2/{name}/manifests/{tag or digest}` | GET, HEAD, PUT, DELETE |
| Referrers | `/v2/{name}/referrers/{digest}` | GET (returns an empty index) |

Catalog and tag listings paginate with `n`, `last`, and a `Link` header. Blob GETs honour `Range`.

### Console

| Page | Backed by |
|---|---|
| `/` repository catalog | `GET /api/overview` |
| `/repo?name=` tags | `GET` / `DELETE /api/repository` |
| `/image?name=&ref=` image detail | `GET` / `DELETE /api/image` |
| `/storage` usage and prune | `GET /api/storage`, `POST /api/gc` |

### Bucket layout

| Key | Contents |
|---|---|
| `blobs/sha256/{aa}/{hex}` | Content-addressed layers, configs, and manifests. |
| `repositories/{name}/tags/…` | Tag to digest records. |
| `repositories/{name}/manifests/…` | Manifest metadata per digest. |
| `uploads/{uuid}/meta.json`, `uploads/{uuid}/parts/…` | In-progress pushes. |
| `activity.jsonl` | Delete and prune events shown in the console. |

## Project layout

| Path | Role |
|---|---|
| `src/server.js` | Entry point. Loads `.env`, connects to R2, dispatches requests. |
| `src/registry.js` | OCI Distribution API. |
| `src/console.js` | JSON API for the console. |
| `src/describe.js` | Resolves a tag or digest into config, platforms, and layers. |
| `src/storage.js` | Blobs, manifests, tags, uploads, garbage collection, activity log. |
| `src/r2.js` | R2 client, bucket bootstrap, and the in-memory store. |
| `src/http.js` | Response helpers, registry error format, body limits. |
| `public/` | The console: `index.html`, `app.js`, `styles.css`. Plain ES modules, no build. |
| `scripts/smoke.js` | `npm test`. |

## Development

```bash
npm install
npm test
```

The test suite runs the full server against the in-memory store, exercises the registry protocol end to end, checks the console API, and, when Docker is available and allows HTTP registries, pushes and pulls a real image. No R2 credentials are needed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions.
