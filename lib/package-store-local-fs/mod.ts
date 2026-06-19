import type { PackageEntry, PackageStore, PackageVersion } from "@publicdomainrelay/package-store-abc";
import { basename, dirname, join, normalize, sep } from "node:path";

function syntheticCliName(
  parsed: Record<string, unknown>,
  entries: Deno.DirEntry[],
  dir: string,
): string | undefined {
  if ("workspace" in parsed) return undefined;
  if (!entries.some((e) => e.name === "cli-args-env.json")) return undefined;
  return `@publicdomainrelay/${basename(dir)}`;
}

export interface LocalFsStoreOptions {
  baseDir: string;
  fallbackVersion?: string;
}

interface PkgDir {
  dir: string;
  name: string;
  version: string;
}

interface RewriteContext {
  map: Record<string, string>;
  pkgDir: string;
  fileDir: string;
  pkgDirs: PkgDir[];
}

const VALID_SEMVER = /^\d+\.\d+\.\d+/;
const MODULE_EXT = /\.(?:ts|tsx|js|jsx|mjs|mts|cts)$/;
const SPEC_SCHEME = /^(?:\.\.?\/|\/|[a-z][a-z0-9+.-]*:)/i;
const REMOTE_TARGET = /^(?:jsr:|npm:|node:|https?:|data:)/;

function resolveSpecifier(spec: string, ctx: RewriteContext): string {
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const abs = normalize(join(ctx.fileDir, spec));
    if (abs === ctx.pkgDir || abs.startsWith(ctx.pkgDir + sep)) return spec;
    const owner = ctx.pkgDirs.find((p) => abs === p.dir || abs.startsWith(p.dir + sep));
    if (owner) {
      const sub = abs.slice(owner.dir.length).split(sep).join("/").replace(/^\//, "");
      return `jsr:${owner.name}@${owner.version}${sub ? `/${sub}` : ""}`;
    }
    return spec;
  }
  if (SPEC_SCHEME.test(spec)) return spec;
  const map = ctx.map;
  let bestKey = "";
  for (const k of Object.keys(map)) {
    const isPrefix = k.endsWith("/") ? spec.startsWith(k) : spec === k || spec.startsWith(`${k}/`);
    if (isPrefix && k.length > bestKey.length) bestKey = k;
  }
  if (bestKey && REMOTE_TARGET.test(map[bestKey])) {
    return map[bestKey] + spec.slice(bestKey.length);
  }
  if (spec.startsWith("@publicdomainrelay/")) {
    const pkg = spec.split("/").slice(0, 2).join("/");
    return `jsr:${pkg}@^0${spec.slice(pkg.length)}`;
  }
  return spec;
}

function rewriteSource(src: string, ctx: RewriteContext): string {
  return src
    .replace(/\bfrom\s*(["'])([^"']+)\1/g, (_m, q, s) => `from ${q}${resolveSpecifier(s, ctx)}${q}`)
    .replace(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g, (_m, q, s) => `import(${q}${resolveSpecifier(s, ctx)}${q})`)
    .replace(/(^|[\n;])(\s*import\s*)(["'])([^"']+)\3/g, (_m, p, imp, q, s) => `${p}${imp}${q}${resolveSpecifier(s, ctx)}${q}`);
}

export function createLocalFsStore(opts: LocalFsStoreOptions): PackageStore {
  const { baseDir, fallbackVersion = "0.0.0" } = opts;

  async function readDir(path: string): Promise<Deno.DirEntry[]> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(path)) {
        entries.push(e);
      }
    } catch {
    }
    return entries;
  }

  async function readTextFile(path: string): Promise<string | null> {
    try {
      return await Deno.readTextFile(path);
    } catch {
      return null;
    }
  }

  async function walkDir(root: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    async function walk(current: string, prefix: string) {
      for (const entry of await readDir(current)) {
        const full = join(current, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          await walk(full, rel);
        } else if (entry.isFile) {
          const content = await readTextFile(full);
          if (content !== null) files[rel] = content;
        }
      }
    }
    await walk(root, "");
    return files;
  }

  async function discoverPackages(): Promise<Map<string, string[]>> {
    const pkgs = new Map<string, string[]>();

    const top = await readDir(baseDir);
    for (const entry of top) {
      if (!entry.isDirectory) continue;

      if (entry.name.startsWith("@")) {
        const scopeDir = join(baseDir, entry.name);
        const scopeEntries = await readDir(scopeDir);
        for (const se of scopeEntries) {
          if (!se.isDirectory) continue;
          const fullName = `${entry.name}/${se.name}`;
          const pkgDir = join(scopeDir, se.name);
          const versions = (await readDir(pkgDir))
            .filter((v) => v.isDirectory && VALID_SEMVER.test(v.name))
            .map((v) => v.name);
          if (versions.length > 0) pkgs.set(fullName, versions);
        }
      } else {
        const pkgDir = join(baseDir, entry.name);
        const subEntries = await readDir(pkgDir);
        const versions = subEntries
          .filter((v) => v.isDirectory && VALID_SEMVER.test(v.name))
          .map((v) => v.name);
        if (versions.length > 0) pkgs.set(entry.name, versions);
      }
    }

    async function scanDir(current: string) {
      const entries = await readDir(current);
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === ".github" ||
            entry.name.startsWith(".")
          ) {
            continue;
          }
          await scanDir(full);
        } else if (entry.name === "deno.json" || entry.name === "deno.jsonc") {
          const content = await readTextFile(full);
          if (!content) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(content);
          } catch {
            continue;
          }
          const name = typeof parsed.name === "string"
            ? parsed.name
            : syntheticCliName(parsed, entries, current);
          if (!name) continue;

          if (pkgs.has(name)) continue;

          const ver = typeof parsed.version === "string" && VALID_SEMVER.test(parsed.version)
            ? parsed.version
            : fallbackVersion;
          pkgs.set(name, [ver]);
        }
      }
    }
    await scanDir(baseDir);

    return pkgs;
  }

  function pkgDir(name: string, version: string): string {
    return join(baseDir, name, version);
  }

  let _denoJsonIndex: Map<string, { dir: string; meta: Record<string, unknown> }> | null = null;
  let _allConfigs: { dir: string; imports: Record<string, string> }[] = [];

  async function realDir(path: string): Promise<string> {
    try {
      return await Deno.realPath(path);
    } catch {
      return path;
    }
  }

  async function getDenoJsonIndex(): Promise<Map<string, { dir: string; meta: Record<string, unknown> }>> {
    if (_denoJsonIndex) return _denoJsonIndex;
    _denoJsonIndex = new Map();
    _allConfigs = [];

    async function scanDir(current: string) {
      const entries = await readDir(current);
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory) {
          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === ".github" ||
            entry.name.startsWith(".")
          ) {
            continue;
          }
          await scanDir(full);
        } else if (entry.name === "deno.json" || entry.name === "deno.jsonc") {
          const content = await readTextFile(full);
          if (!content) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(content);
          } catch {
            continue;
          }
          const abs = await realDir(current);
          const imports = (parsed.imports as Record<string, string> | undefined) ?? {};
          _allConfigs.push({ dir: abs, imports });

          const name = typeof parsed.name === "string"
            ? parsed.name
            : syntheticCliName(parsed, entries, current);
          if (!name) continue;

          _denoJsonIndex!.set(name, { dir: abs, meta: parsed });
        }
      }
    }
    await scanDir(baseDir);
    return _denoJsonIndex;
  }

  async function pkgForPath(absFile: string): Promise<{ name: string; version: string } | null> {
    const index = await getDenoJsonIndex();
    let best: { name: string; version: string } | null = null;
    let bestLen = -1;
    for (const [name, e] of index) {
      if (absFile === e.dir || absFile.startsWith(e.dir + sep)) {
        if (e.dir.length > bestLen) {
          bestLen = e.dir.length;
          const v = e.meta.version;
          best = {
            name,
            version: typeof v === "string" && VALID_SEMVER.test(v) ? v : fallbackVersion,
          };
        }
      }
    }
    return best;
  }

  async function normalizeTarget(target: string, configDir: string): Promise<string> {
    if (REMOTE_TARGET.test(target)) return target;
    if (/^(?:\.\.?\/|\/)/.test(target)) {
      const abs = await realDir(join(configDir, target));
      const pkg = await pkgForPath(abs);
      if (pkg) return `jsr:${pkg.name}@${pkg.version}`;
    }
    return target;
  }

  async function collectImportMap(pkgDir: string): Promise<Record<string, string>> {
    await getDenoJsonIndex();
    const target = await realDir(pkgDir);
    const merged: Record<string, string> = {};
    for (
      const cfg of _allConfigs
        .filter((c) => target === c.dir || target.startsWith(c.dir + sep))
        .sort((a, b) => a.dir.length - b.dir.length)
    ) {
      for (const [k, v] of Object.entries(cfg.imports)) {
        merged[k] = await normalizeTarget(v, cfg.dir);
      }
    }
    return merged;
  }

  async function buildPkgDirs(): Promise<PkgDir[]> {
    const index = await getDenoJsonIndex();
    const arr: PkgDir[] = [];
    for (const [name, e] of index) {
      const v = e.meta.version;
      arr.push({
        dir: e.dir,
        name,
        version: typeof v === "string" && VALID_SEMVER.test(v) ? v : fallbackVersion,
      });
    }
    arr.sort((a, b) => b.dir.length - a.dir.length);
    return arr;
  }

  async function rewriteFiles(
    files: Record<string, string>,
    pkgDirRaw: string,
  ): Promise<Record<string, string>> {
    const pkgDir = await realDir(pkgDirRaw);
    const map = await collectImportMap(pkgDir);
    const pkgDirs = await buildPkgDirs();
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(files)) {
      if (MODULE_EXT.test(path)) {
        const fileDir = dirname(join(pkgDir, path));
        out[path] = rewriteSource(content, { map, pkgDir, fileDir, pkgDirs });
      } else {
        out[path] = content;
      }
    }
    return out;
  }

  function expandExports(
    files: Record<string, string>,
    base: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const ex: Record<string, unknown> = { ...(base ?? {}) };
    for (const p of Object.keys(files)) {
      if (MODULE_EXT.test(p)) ex[`./${p}`] = `./${p}`;
    }
    if (!ex["."]) {
      const entry = "mod.ts" in files
        ? "./mod.ts"
        : "main.ts" in files
        ? "./main.ts"
        : Object.keys(files).find((f) => MODULE_EXT.test(f));
      if (entry) ex["."] = entry.startsWith("./") ? entry : `./${entry}`;
    }
    return ex;
  }

  return {
    async list(): Promise<PackageEntry[]> {
      const pkgs = await discoverPackages();
      return [...pkgs.entries()].map(([name, versions]) => ({
        name,
        versions: versions.sort(),
      }));
    },

    async get(name: string, version: string): Promise<PackageVersion | null> {
      const dir = pkgDir(name, version);
      try {
        const stat = await Deno.stat(dir);
        if (stat.isDirectory) {
          const files = await rewriteFiles(await walkDir(dir), dir);
          return { name, version, files };
        }
      } catch {
      }

      const index = await getDenoJsonIndex();
      const entry = index.get(name);
      if (entry) {
        const realVersion = typeof entry.meta.version === "string" && VALID_SEMVER.test(entry.meta.version)
          ? entry.meta.version
          : fallbackVersion;
        if (version === realVersion || version === fallbackVersion) {
          const files = await rewriteFiles(await walkDir(entry.dir), entry.dir);
          const exports = entry.meta.exports;
          const baseExports = typeof exports === "string"
            ? { ".": exports }
            : (exports as Record<string, unknown> ?? undefined);
          return {
            name,
            version: realVersion,
            files,
            metadata: {
              exports: expandExports(files, baseExports),
              version: realVersion,
              dependencies: entry.meta.dependencies as Record<string, unknown> | undefined,
              imports: entry.meta.imports as Record<string, unknown> | undefined,
            },
          };
        }
      }

      return null;
    },
  };
}
