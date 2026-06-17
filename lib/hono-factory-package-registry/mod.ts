import { Hono } from "hono";
import type { PackageStore } from "@publicdomainrelay/hono-jsr-package-store-abc";
import { rawStructuredLogger } from "@publicdomainrelay/logger";
import { registerErrorMiddleware } from "@publicdomainrelay/hono-error-middleware";
import type { LoggerInterface } from "@publicdomainrelay/logger";

export interface PackageRegistryOptions {
  store: PackageStore;
  label?: string;
  passthrough?: boolean;
}

interface ParsedPackageUrl {
  scope?: string;
  name: string;
  version: string;
  filePath: string;
}

function parsePackageUrl(pathname: string): ParsedPackageUrl | null {
  const path = pathname.replace(/^\/+/, "");
  const m = path.match(/^(?:@([^/]+)\/)?([^/@]+)@([^/]+)(?:\/(.*))?$/);
  if (!m) return null;

  const [, scope, pkgName, version, filePath] = m;
  const fullName = scope ? `@${scope}/${pkgName}` : pkgName;

  return { scope, name: fullName, version, filePath: filePath ?? "" };
}

function parseJsrUrl(pathname: string): ParsedPackageUrl | null {
  const path = pathname.replace(/^\/+/, "");
  const m = path.match(
    /^(?:@([^/]+)\/)?([^/@]+)\/([^/]+)(?:\/(.*))?$/,
  );
  if (!m) return null;

  const [, scope, pkgName, version, filePath] = m;
  const fullName = scope ? `@${scope}/${pkgName}` : pkgName;

  return { scope, name: fullName, version, filePath: filePath ?? "" };
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
    return "text/typescript; charset=utf-8";
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function serveFile(filePath: string, content: string): Response {
  return new Response(content, {
    status: 200,
    headers: {
      "content-type": contentType(filePath),
      "cache-control": "public, max-age=31536000, immutable",
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function buildManifest(
  files: Record<string, string>,
): Promise<Record<string, { size: number; checksum: string }>> {
  const manifest: Record<string, { size: number; checksum: string }> = {};
  for (const [path, content] of Object.entries(files)) {
    manifest[`/${path}`] = {
      size: new TextEncoder().encode(content).length,
      checksum: `sha256-${await sha256Hex(content)}`,
    };
  }
  return manifest;
}

function autoDetectEntry(files: Record<string, string>): string {
  if ("mod.ts" in files) return "./mod.ts";
  if ("mod.js" in files) return "./mod.js";
  const ts = Object.keys(files).find((f) =>
    f.endsWith(".ts") || f.endsWith(".js")
  );
  return ts ? `./${ts}` : "./mod.ts";
}

function fullName(scope: string | undefined, name: string): string {
  return scope ? `@${scope}/${name}` : name;
}

const JSR_ORIGIN = "https://jsr.io";

async function tryPassthrough(
  pathname: string,
  passthrough: boolean,
): Promise<Response | null> {
  if (!passthrough) return null;
  try {
    const upstream = await fetch(`${JSR_ORIGIN}${pathname}`, {
      redirect: "follow",
    });
    const headers = new Headers(upstream.headers);
    headers.set("access-control-allow-origin", "*");
    headers.set("cross-origin-resource-policy", "cross-origin");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return null;
  }
}

export function createPackageRegistryFactory(
  opts: PackageRegistryOptions,
): Hono {
  const { store, label, passthrough = true } = opts;
  const LABEL = label ?? "pkg-registry";
  const app = new Hono();

  const log = rawStructuredLogger(LABEL);
  const logger: LoggerInterface = {
    info: (msg, meta) => log("info", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    debug: (msg, meta) => log("debug", msg, meta),
  };
  registerErrorMiddleware(app, logger);

  app.use("*", async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    const start = performance.now();
    log("info", "request", { event: "request", method, path });
    await next();
    const durationMs = Math.round(performance.now() - start);
    const status = c.res.status;
    if (status >= 400) {
      log("error", `response ${status}`, {
        event: "response",
        method,
        path,
        status,
        durationMs,
      });
    } else {
      log("info", `response ${status}`, {
        event: "response",
        method,
        path,
        status,
        durationMs,
      });
    }
  });

  // -- import map: resolve bare specifiers to this registry --

  const SEMVER_RE = /^\d+\.\d+\.\d+/;

  app.get("/import-map.json", async (c) => {
    const imports: Record<string, string> = {};
    const host = new URL(c.req.url).host;
    const base = `http://${host}`;

    try {
      const packages = await store.list();
      for (const pkg of packages) {
        let version: string | null = null;
        let pkgData: { name: string; version: string; files: Record<string, string>; metadata?: Record<string, unknown> } | null = null;

        for (const branchVer of ["0.1.0-main", "0.1.0-master"]) {
          if (pkg.versions.includes(branchVer)) {
            version = branchVer;
            pkgData = await store.get(pkg.name, version);
            if (pkgData) break;
          }
        }

        if (!pkgData) {
          version = [...pkg.versions].reverse().find((v) =>
            SEMVER_RE.test(v) && !v.startsWith("0.1.0-")
          ) ?? null;
          if (version) {
            pkgData = await store.get(pkg.name, version);
          }
        }

        if (!pkgData) {
          for (const branch of ["main", "master"]) {
            version = `$${branch}`;
            pkgData = await store.get(pkg.name, version);
            if (pkgData) break;
          }
        }

        if (!pkgData) continue;

        const exports = pkgData.metadata?.exports as Record<string, string> | undefined;
        const entry = exports?.["."] ?? autoDetectEntry(pkgData.files);

        imports[pkg.name] = `${base}/@${pkg.name.replace(/^@/, "")}@${version}/${entry.replace(/^\.\//, "")}`;
        imports[`${pkg.name}/`] = `${base}/@${pkg.name.replace(/^@/, "")}@${version}/`;
      }
    } catch (err) {
      log("error", "import-map generation error", { error: String(err) });
    }

    return c.json({ imports });
  });

  // -- JSR: package metadata (meta.json) --

  app.get("/@:scope/:name/meta.json", async (c) => {
    const scope = c.req.param("scope");
    const pkgName = c.req.param("name");
    const fqn = fullName(scope, pkgName);

    try {
      const packages = await store.list();
      const entry = packages.find((p) => p.name === fqn);

      if (!entry) {
        const proxied = await tryPassthrough(c.req.path, passthrough);
        if (proxied) return proxied;
        return c.json({ error: "PackageNotFound", message: `${fqn} not found` }, 404);
      }

      const versions: Record<string, Record<string, unknown>> = {};
      for (const v of entry.versions) {
        versions[v] = {};
      }

      const latest = entry.versions[entry.versions.length - 1];

      return c.json({ scope, name: pkgName, latest, versions });
    } catch (err) {
      log("error", "meta.json error", { package: fqn, error: String(err) });
      return c.json({ error: "InternalError", message: String(err) }, 500);
    }
  });

  app.get("/:name/meta.json", async (c) => {
    const pkgName = c.req.param("name");
    if (pkgName === "xrpc" || pkgName === "import-map") {
      return c.json({ error: "NotFound" }, 404);
    }

    try {
      const packages = await store.list();
      const entry = packages.find((p) => p.name === pkgName);

      if (!entry) {
        const proxied = await tryPassthrough(c.req.path, passthrough);
        if (proxied) return proxied;
        return c.json({ error: "PackageNotFound", message: `${pkgName} not found` }, 404);
      }

      const versions: Record<string, Record<string, unknown>> = {};
      for (const v of entry.versions) {
        versions[v] = {};
      }

      const latest = entry.versions[entry.versions.length - 1];

      return c.json({ name: pkgName, latest, versions });
    } catch (err) {
      log("error", "meta.json error", { package: pkgName, error: String(err) });
      return c.json({ error: "InternalError", message: String(err) }, 500);
    }
  });

  // -- JSR: well-known discovery --

  app.get("/.well-known/jsr", (c) => {
    const host = new URL(c.req.url).host;
    const base = c.req.url.startsWith("https") ? `https://${host}` : `http://${host}`;
    return c.json({
      registry: base,
      modules: base,
      api: `${base}/api`,
    });
  });

  // -- JSR: version metadata (_meta.json) + file serving (catch-all) --

  app.get("/*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;

    // -- _meta.json: version metadata --
    const metaVersionMatch = pathname.match(
      /^\/(?:@([^/]+)\/)?([^/@]+)\/([^/]+)_meta\.json$/,
    );
    if (metaVersionMatch) {
      const [, scope, pkgName, version] = metaVersionMatch;
      const fqn = fullName(scope, pkgName);

      try {
        const pkg = await store.get(fqn, version);
        if (!pkg) {
          const proxied = await tryPassthrough(pathname, passthrough);
          if (proxied) return proxied;
          return c.json(
            { error: "PackageNotFound", message: `${fqn}@${version} not found` },
            404,
          );
        }

        const exportsMap =
          (pkg.metadata?.exports as Record<string, string>) ??
          { ".": autoDetectEntry(pkg.files) };

        const manifest = await buildManifest(pkg.files);

        const dependencies = pkg.metadata?.dependencies as
          | Record<string, string>
          | undefined;
        const imports = pkg.metadata?.imports as
          | Record<string, string>
          | undefined;

        return c.json({
          exports: exportsMap,
          manifest,
          ...(dependencies ? { dependencies } : {}),
          ...(imports ? { imports } : {}),
        });
      } catch (err) {
        log("error", "_meta.json error", { package: fqn, version, error: String(err) });
        return c.json({ error: "InternalError", message: String(err) }, 500);
      }
    }

    // -- meta.json: package metadata (fallback for scoped packages) --
    const metaPkgMatch = pathname.match(
      /^\/(?:@([^/]+)\/)?([^/@]+)\/meta\.json$/,
    );
    if (metaPkgMatch) {
      const [, scope, pkgName] = metaPkgMatch;
      const fqn = fullName(scope, pkgName);

      try {
        const packages = await store.list();
        const entry = packages.find((p) => p.name === fqn);

        if (entry) {
          const versions: Record<string, Record<string, unknown>> = {};
          for (const v of entry.versions) versions[v] = {};
          const latest = entry.versions[entry.versions.length - 1];
          return c.json(
            scope
              ? { scope, name: pkgName, latest, versions }
              : { name: pkgName, latest, versions },
          );
        }
      } catch {
        // fall through to 404
      }
      const proxied = await tryPassthrough(pathname, passthrough);
      if (proxied) return proxied;
      return c.json({ error: "PackageNotFound", message: `${fqn} not found` }, 404);
    }

    // -- file serving --
    let parsed = parsePackageUrl(pathname) ?? parseJsrUrl(pathname);

    if (!parsed) {
      if (pathname === "/.well-known/jsr") {
        const host = new URL(c.req.url).host;
        const base = c.req.url.startsWith("https") ? `https://${host}` : `http://${host}`;
        return c.json({
          registry: base,
          modules: base,
          api: `${base}/api`,
        });
      }
      const proxied = await tryPassthrough(pathname, passthrough);
      if (proxied) return proxied;
      return c.json({ error: "NotFound", message: `Cannot parse URL: ${pathname}` }, 404);
    }

    try {
      const pkg = await store.get(parsed.name, parsed.version);
      if (!pkg) {
        const proxied = await tryPassthrough(pathname, passthrough);
        if (proxied) return proxied;
        return c.json({
          error: "PackageNotFound",
          message: `${parsed.name}@${parsed.version} not found`,
        }, 404);
      }

      let filePath = parsed.filePath;
      if (!filePath) {
        filePath = "mod.ts" in pkg.files
          ? "mod.ts"
          : Object.keys(pkg.files).find((f) =>
            f.endsWith(".ts") || f.endsWith(".js")
          ) ?? "";
      }

      const extensions = [
        ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cts",
        "/index.ts", "/index.js", "/mod.ts", "/mod.js",
      ];
      let resolvedPath: string | null = null;
      let content: string | undefined;

      if (pkg.files[filePath] !== undefined) {
        resolvedPath = filePath;
        content = pkg.files[filePath];
      } else {
        for (const ext of extensions) {
          const candidate = filePath + ext;
          if (pkg.files[candidate] !== undefined) {
            resolvedPath = candidate;
            content = pkg.files[candidate];
            break;
          }
        }
      }

      if (content === undefined) {
        return c.json({
          error: "FileNotFound",
          message: `${filePath} not found in ${parsed.name}@${parsed.version}`,
          availableFiles: Object.keys(pkg.files).sort(),
        }, 404);
      }

      return serveFile(resolvedPath ?? filePath, content);
    } catch (err) {
      log("error", "serve error", { error: String(err) });
      return c.json({ error: "InternalError", message: String(err) }, 500);
    }
  });

  return app;
}
