# hono-package-registry

JSR-compatible package registry. Serve TypeScript packages from directories, git repos, or jsr.io passthrough. Built with Hono + Deno. Multi-store capable.

## Serve directory

Point at any directory. Registry discovers packages two ways:

**1. Version-directory layout** -- `baseDir/name/version/files`:

```
pkg-dir/
  my-lib/
    1.0.0/
      mod.ts
    2.0.0/
      mod.ts
  @scope/
    other-lib/
      0.5.0/
        mod.ts
```

**2. Auto-detect `deno.json`** -- recursive scan. Any `deno.json` with `name` field = package. No version dirs? Served at fallback version (default `0.0.0`).

```bash
# Serve current project -- all workspace packages auto-discovered
deno run -A hono-package-registry/main.ts --store=local --base-dir=.. --port=8080

# Serve test fixtures
deno run -A hono-package-registry/main.ts --store=local --base-dir=./test-packages --port=8080
```

Packages discovered from `../`:
```
@publicdomainrelay/hono-jsr-package-store-abc                -> lib/abc/package-store/
@publicdomainrelay/hono-jsr-package-store-local-fs           -> lib/package-store-local-fs/
@publicdomainrelay/hono-jsr-package-store-remote-git         -> lib/package-store-remote-git/
@publicdomainrelay/hono-jsr-package-store-composite          -> lib/package-store-composite/
@publicdomainrelay/hono-jsr-factory-package-registry    -> lib/hono-factory-package-registry/
@publicdomainrelay/hono-jsr-package-registry            -> hono-package-registry/
```

All at version `0.0.0`, served straight from source.

## Consume packages

Set `DENO_REGISTRY_URL` to use local registry:

```bash
# Start registry
deno run -A hono-package-registry/main.ts --store=local --base-dir=./packages --port=8080 &

# Point deno at it
export DENO_REGISTRY_URL=http://localhost:8080

# Import map style -- reference packages from local registry
cat > deno.json << 'EOF'
{
  "imports": {
    "my-pkg": "http://localhost:8080/@my-pkg@1.0.0/mod.ts",
    "@scope/other": "http://localhost:8080/@scope/other@0.5.0/mod.ts"
  }
}
EOF

deno run -A main.ts
```

Or use generated import map:

```bash
curl http://localhost:8080/import-map.json
```

## gh CLI: scan org, build multi-store config

Serve every repo in GitHub org as packages. One command builds config.

```bash
gh repo list MY-ORG --limit 200 --json name,url --jq '
  {
    stores: [
      .[] | { type: "git", url: (.url + ".git") }
    ]
  }
' > org-stores.json
```

Result:

```json
{
  "stores": [
    { "type": "git", "url": "https://github.com/my-org/repo-a.git" },
    { "type": "git", "url": "https://github.com/my-org/repo-b.git" },
    { "type": "git", "url": "https://github.com/my-org/repo-c.git" }
  ]
}
```

Start registry with all org repos:

```bash
deno run -A hono-package-registry/main.ts --stores-config=./org-stores.json --port=8080
```

Mix local dir + org repos:

```json
{
  "stores": [
    { "type": "local", "baseDir": "./packages" },
    { "type": "git", "url": "https://github.com/my-org/repo-a.git" },
    { "type": "git", "url": "https://github.com/my-org/repo-b.git" }
  ]
}
```

Filter org by topic:

```bash
gh repo list MY-ORG --topic deno-package --limit 100 --json name,url --jq '
  { stores: [ .[] | { type: "git", url: (.url + ".git") } ] }
' > deno-pkg-stores.json
```

## Passthrough to jsr.io

Package not found locally? Proxy to jsr.io. Default on. Disable with `--no-passthrough`.

```bash
# Serve local packages + fall through to jsr.io for rest
deno run -A hono-package-registry/main.ts --store=local --base-dir=./packages --port=8080

# Local packages only, no upstream
deno run -A hono-package-registry/main.ts --store=local --base-dir=./packages --no-passthrough --port=8080

# Pure jsr.io proxy -- empty composite store + passthrough
deno run -A hono-package-registry/main.ts --store=local --base-dir=/tmp/empty --port=8080
```

## Fallback version

When package source has no tagged versions, use fallback version. Default `0.0.0`. Works for both local-fs and git stores.

```bash
deno run -A hono-package-registry/main.ts --store=local --base-dir=.. --fallback-version=0.0.0 --port=8080
```

Local-fs: deno.json packages without version dirs get fallback version.
Git: repos without tags get fallback version (resolved to main/master branch).

## Git store

Tags = versions. Branch heads = `0.1.0-{branch}` versions. `deno.json` in repo = discovered packages.

```bash
# Remote repo
deno run -A hono-package-registry/main.ts --store=git --git-url=https://github.com/user/repo.git --port=8080

# Local bare repo
deno run -A hono-package-registry/main.ts --store=git --git-url=file:///path/to/bare.git --port=8080
```

Repo with no tags: fallback version added automatically (resolves to main/master branch).

## Install package using env var

```bash
# Start registry
deno run -A hono-package-registry/main.ts --store=local --base-dir=./packages --port=8080 &

# Set registry URL
export DENO_REGISTRY_URL=http://localhost:8080

# Use in deno.json
cat > deno.json << 'EOF'
{ "imports": { "mylib": "http://localhost:8080/@mylib@1.0.0/mod.ts" } }
EOF

deno run -A main.ts
```

## HTTP API

| Endpoint | Description |
|----------|------------|
| `GET /@scope/name/meta.json` | Package metadata (versions, latest) |
| `GET /name/meta.json` | Unscoped package metadata |
| `GET /scope/name/version_meta.json` | Version manifest (exports, checksums) |
| `GET /@scope/name@version/path` | File serving (at-style) |
| `GET /scope/name/version/path` | File serving (JSR-style) |
| `GET /import-map.json` | Auto-generated import map |

```bash
# Package metadata
curl http://localhost:8080/my-pkg/meta.json
# -> {"name":"my-pkg","latest":"1.1.0","versions":{"1.0.0":{},"1.1.0":{}}}

# Scoped package
curl http://localhost:8080/@scope/other/meta.json
# -> {"scope":"scope","name":"other","latest":"0.5.0","versions":{"0.5.0":{}}}

# Version metadata
curl http://localhost:8080/my-pkg/1.0.0_meta.json
# -> {"exports":{".":"./mod.ts"},"manifest":{"/mod.ts":{"size":42,"checksum":"sha256-..."}}, ...}

# Fetch file (at-style)
curl http://localhost:8080/my-pkg@1.0.0/mod.ts

# Fetch file (JSR-style)
curl http://localhost:8080/my-pkg/1.0.0/mod.ts

# Import map
curl http://localhost:8080/import-map.json
```

## CLI options

| Flag | Env | Default | Description |
|------|-----|---------|-------------|
| `--store` | `PACKAGE_REGISTRY_STORE` | `local` | `git` or `local` |
| `--git-url` | `PACKAGE_REGISTRY_GIT_URL` | -- | Git repo URL |
| `--base-dir` | `PACKAGE_REGISTRY_BASE_DIR` | `./packages` | Package directory |
| `--stores-config` | `PACKAGE_REGISTRY_STORES_CONFIG` | -- | JSON file with stores array |
| `--port` | `PORT` | `8080` | HTTP port |
| `--passthrough` | -- | `true` | Proxy to jsr.io (use `--no-passthrough` to disable) |
| `--fallback-version` | `PACKAGE_REGISTRY_FALLBACK_VERSION` | `0.0.0` | Version when source has no versions |

## Structure

```
lib/abc/package-store/              ABC: PackageStore interface
lib/package-store-local-fs/         Local directory store (deno.json auto-detect)
lib/package-store-remote-git/       Git repository store
lib/package-store-composite/        Multi-store aggregator
lib/hono-factory-package-registry/  Hono HTTP factory (passthrough to jsr.io)
hono-package-registry/              CLI entry point
```

Deps flow one way: `abc -> impl -> factory -> CLI`.

## Run from source

```bash
git clone https://github.com/publicdomainrelay/hono-jsr.git
cd hono-jsr
deno run -A hono-package-registry/main.ts --store=local --base-dir=./test-packages --port=8080
```

## Tests

```bash
deno test -A hono-package-registry/test.ts
deno test -A --no-check hono-package-registry/integration_test.ts
deno check hono-package-registry/main.ts
```

## License

Unlicense -- public domain.
