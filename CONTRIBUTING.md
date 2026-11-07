# Contributing

Thanks for taking an interest. Bug reports, fixes, and focused features are all welcome.

## Getting set up

```bash
npm install
npm test
```

`npm test` starts the server with `TOGGLE_R2_MEMORY=1`, so it needs no R2 credentials. It checks the registry protocol, the console API, static serving, and garbage collection. When Docker is running and `127.0.0.1` is listed in the daemon's `insecure-registries`, it also pushes and pulls a scratch image; otherwise that step is skipped.

To run the console against the in-memory store:

```bash
TOGGLE_R2_MEMORY=1 npm start
```

Node.js 22 is the target. Container images and the Zerops config pin it.

## Making changes

- Keep it plain Node.js ESM. No TypeScript, bundler, or framework.
- `@aws-sdk/client-s3` is the only runtime dependency. Propose new ones in an issue first.
- Registry behaviour must stay compatible with Docker and the OCI Distribution spec. If you change a response, add a check to `scripts/smoke.js`.
- The console is vanilla JS that renders the JSON from `src/console.js`. Keep the two in step.
- Do not add authentication. The project is built around not having it; wrap it with a proxy instead.
- Run `npm test` before opening a pull request.

## Pull requests

Describe what changed and why. Link the issue if there is one. Small, single-purpose PRs are easier to review and land faster.

## Reporting bugs

Include the Node.js version, how the registry was started, the `docker` or `curl` command that failed, and the response. Leave out R2 credentials and bucket names.
