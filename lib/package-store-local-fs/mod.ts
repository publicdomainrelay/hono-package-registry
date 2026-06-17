import type { PackageEntry, PackageStore, PackageVersion } from "@publicdomainrelay/hono-jsr-package-store-abc";
import { join } from "node:path";

export interface LocalFsStoreOptions {
  baseDir: string;
  fallbackVersion?: string;
}

const VALID_SEMVER = /^\d+\.\d+\.\d+/;

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
      for (const entry of await readDir(current)) {
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
          const name = typeof parsed.name === "string" ? parsed.name : undefined;
          if (!name) continue;

          if (pkgs.has(name)) continue;

          pkgs.set(name, [fallbackVersion]);
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

  async function getDenoJsonIndex(): Promise<Map<string, { dir: string; meta: Record<string, unknown> }>> {
    if (_denoJsonIndex) return _denoJsonIndex;
    _denoJsonIndex = new Map();

    async function scanDir(current: string) {
      for (const entry of await readDir(current)) {
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
          const name = typeof parsed.name === "string" ? parsed.name : undefined;
          if (!name) continue;

          _denoJsonIndex!.set(name, { dir: current, meta: parsed });
        }
      }
    }
    await scanDir(baseDir);
    return _denoJsonIndex;
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
          const files = await walkDir(dir);
          return { name, version, files };
        }
      } catch {
      }

      if (version === fallbackVersion) {
        const index = await getDenoJsonIndex();
        const entry = index.get(name);
        if (entry) {
          const files = await walkDir(entry.dir);
          const exports = entry.meta.exports;
          return {
            name,
            version,
            files,
            metadata: {
              exports: typeof exports === "string"
                ? { ".": exports }
                : (exports as Record<string, unknown> ?? undefined),
              version: typeof entry.meta.version === "string"
                ? entry.meta.version
                : fallbackVersion,
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
