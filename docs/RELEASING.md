# Releasing

All pipelines live in `.github/workflows/`.

| Workflow | Runs on | What it does |
|---|---|---|
| `ci.yml` | every pull request | Node build, typecheck, unit + e2e tests against Postgres and Redis; Python SDK smoke test (3.9, 3.12); builds all three Docker images without pushing |
| `release.yml` | push to `main` | Runs CI, then pushes `edge` and `sha-<commit>` images to GHCR |
| `release.yml` | tag `vX.Y.Z` | Runs CI, pushes `X.Y.Z`, `X.Y` and `latest` images (amd64 + arm64), creates a GitHub Release with generated notes |
| `publish-sdk.yml` | tag `sdk-vX.Y.Z` | Publishes `@tokenistt/sdk` to npm with provenance |
| `publish-cli.yml` | tag `cli-vX.Y.Z` | Typechecks, builds and tests the CLI on Node 22, then publishes `tokenistt-cli` to npm with provenance |
| `codeql.yml` | PRs, `main`, weekly | Security scanning |
| `cla.yml` | PRs | Contributor License Agreement check |

Images are published as:

```
ghcr.io/complete-tokenistt/tokenistt-gateway
ghcr.io/complete-tokenistt/tokenistt-dashboard
ghcr.io/complete-tokenistt/tokenistt-migrate
```

## Cut a release

```bash
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

Use a suffix such as `v0.2.0-rc.1` for a pre-release; it is marked as such on GitHub and does not move `latest`.

## Publish the TypeScript SDK

1. Bump `version` in `packages/sdk-ts/package.json` and merge it.
2. `git tag sdk-v0.2.0 && git push origin sdk-v0.2.0` — the tag must equal the package version or the job fails.

## Publish the CLI

The package is `tokenistt-cli` (the command it installs is `tokenistt`). Node 22.13+ is required by users.

1. Bump `version` in `cli/package.json` and merge it.
2. `git tag cli-v0.1.0 && git push origin cli-v0.1.0` — the tag must equal the package version or the job fails.
3. Check: `npx -p tokenistt-cli@latest tokenistt --version` in an empty directory.

First release by hand (no CI yet): `npm login`, then from `cli/`: `npm publish --access public`. `prepublishOnly` rebuilds.

## One-time setup

- **GHCR visibility:** after the first push, open each package under the organization's *Packages* tab → *Package settings* → *Change visibility* → Public, and link it to this repository.
- **npm:** create the `@tokenistt` scope on npmjs.com (the unscoped `tokenistt-cli` package needs no scope), generate an *Automation* token, and save it as the `NPM_TOKEN` repository secret.
- **Branch protection on `main`:** require the `CI` checks (`build-test`, `python-sdk`, `docker-build`), `CodeQL` and `CLA` to pass before merging.
