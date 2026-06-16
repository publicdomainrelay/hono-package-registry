# hono-package-registry

JSR-compatible package registry. Serve TypeScript packages from git repos or local directories. Built with Hono + Deno.

## Install

```bash
deno run -A jsr:@publicdomainrelay/hono-package-registry --store=local --base-dir=./packages --port=8080
```

Or clone and run direct:

```bash
git clone https://github.com/publicdomainrelay/hono-package-registry.git
cd hono-package-registry
deno run -A hono-package-registry/main.ts --store=local --base-dir=./test-packages --port=8080
```

## Quick start

### Local directory store

Packages on disk as `baseDir/name/version/files`:

```
packages/
  my-pkg/
    1.0.0/
      mod.ts
      deno.json
      README.md
    1.1.0/
      mod.ts
  @scope/
    scoped-pkg/
      1.0.0/
        mod.ts
```

Start registry:

```bash
deno run -A hono-package-registry/main.ts --store=local --base-dir=./packages --port=8080
```

Consume from deno project:

```json
{
  "imports": {
    "my-pkg": "http://localhost:8080/@my-pkg@1.1.0/mod.ts",
    "@scope/scoped-pkg": "http://localhost:8080/@scope/scoped-pkg@1.0.0/mod.ts"
  }
}
```

```bash
deno run -A main.ts
```

### Git store

Registry reads git repo tags as versions. Each `deno.json` in repo = discovered package.

```bash
# Tag commits with semver
git tag v1.0.0
git push --tags

# Start registry pointing at repo
deno run -A hono-package-registry/main.ts --store=git --git-url=https://github.com/user/repo.git --port=8080
```

Supports `file://` for local repos:

```bash
deno run -A hono-package-registry/main.ts --store=git --git-url=file:///path/to/bare.git --port=8080
```

## HTTP API

| Endpoint | Description |
|----------|------------|
| `GET /@scope/name/meta.json` | Package metadata (versions, latest) |
| `GET /@scope/name/version_meta.json` | Version manifest (exports, checksums) |
| `GET /@scope/name@version/path/file.ts` | File serving (at-style) |
| `GET /@scope/name/version/path/file.ts` | File serving (JSR-style) |
| `GET /import-map.json` | Auto-generated import map for all packages |

### Examples

```bash
# Package metadata
curl http://localhost:8080/my-pkg/meta.json
# {"name":"my-pkg","latest":"1.1.0","versions":{"1.0.0":{},"1.1.0":{}}}

# Version metadata
curl http://localhost:8080/my-pkg/1.0.0_meta.json
# {"exports":{".":"./mod.ts"},"manifest":{"/mod.ts":{"size":42,"checksum":"sha256-..."}}, ...}

# Fetch file
curl http://localhost:8080/my-pkg@1.0.0/mod.ts

# Import map
curl http://localhost:8080/import-map.json
```

## CLI options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--store` | `PACKAGE_REGISTRY_STORE` | `local` | `git` or `local` |
| `--git-url` | `PACKAGE_REGISTRY_GIT_URL` | — | Git repo URL (git store) |
| `--base-dir` | `PACKAGE_REGISTRY_BASE_DIR` | `./packages` | Package directory (local store) |
| `--port` | `PORT` | `8080` | HTTP port |

## Development

```bash
# Run tests
deno test -A hono-package-registry/test.ts

# Run integration tests (needs git)
deno test -A hono-package-registry/integration_test.ts

# Type-check
deno check hono-package-registry/main.ts
```

## Structure

```
lib/abc/package-store/              ABC: PackageStore interface
lib/package-store-local-fs/         Local directory store
lib/package-store-remote-git/       Git repository store
lib/hono-factory-package-registry/  Hono HTTP factory
hono-package-registry/              CLI entry point
```

Deps flow one way: `abc -> impl -> factory -> CLI`.

## License

Unlicense — public domain.
