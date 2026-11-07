# Security

## The model

Toggle Compose has no authentication. There are no users, tokens, or roles. Anyone who can open a TCP connection to the port can:

- pull any image,
- push to any repository, including overwriting existing tags,
- delete tags, manifests, and blobs,
- trigger garbage collection from the console.

This is a deliberate trade-off for simplicity. It means the network boundary is the only access control. The `auth: false` field in the startup log and the "Open registry" note in the console are reminders, not warnings of a misconfiguration.

## Running it safely

- Bind to a private interface, a VPN, or a service mesh. Do not publish port 8080 to the public internet.
- If you need remote access, put an authenticating reverse proxy, tunnel, or zero-trust gateway in front of it.
- Scope the R2 API token to Object Read & Write on a single bucket. Do not use an account-wide token.
- Keep `R2_SECRET_ACCESS_KEY` in the environment or a local `.env`. `.env` is gitignored and dockerignored.
- The registry serves plain HTTP. Terminate TLS at a proxy if traffic leaves the host.

## Reporting a vulnerability

If you find a flaw in the registry protocol handling, storage layer, or console, please report it privately. Use the repository's security advisory feature if the host offers one. Otherwise, open an issue that asks for a private contact and leave out exploit details, credentials, and bucket names.

You can expect an acknowledgement, a fix or mitigation plan, and credit in the release notes if you want it.
