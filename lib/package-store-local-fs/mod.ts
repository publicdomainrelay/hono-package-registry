import type { PackageEntry, PackageStore, PackageVersion } from "@hono-jsr/package-store-abc";
import { join } from "node:path";

export interface LocalFsStoreOptions {
  baseDir: string;
}

const VALID_SEMVER = /^\d+\.\d+\.\d+/;

export function createLocalFsStore(opts: LocalFsStoreOptions): PackageStore {
  const { baseDir } = opts;

  async function readDir(path: string): Promise<Deno.DirEntry[]> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(path)) {
        entries.push(e);
      }
    } catch {
      // directory does not exist
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

    return pkgs;
  }

  function pkgDir(name: string, version: string): string {
    return join(baseDir, name, version);
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
        if (!stat.isDirectory) return null;
      } catch {
        return null;
      }

      const files = await walkDir(dir);
      return { name, version, files };
    },
  };
}
