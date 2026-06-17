import type { PackageEntry, PackageStore, PackageVersion } from "@publicdomainrelay/hono-jsr-package-store-abc";

export interface CompositeStoreOptions {
  stores: PackageStore[];
}

export function createCompositeStore(opts: CompositeStoreOptions): PackageStore {
  const { stores } = opts;

  return {
    async list(): Promise<PackageEntry[]> {
      const merged = new Map<string, Set<string>>();
      for (const store of stores) {
        try {
          const entries = await store.list();
          for (const entry of entries) {
            const existing = merged.get(entry.name);
            if (existing) {
              for (const v of entry.versions) existing.add(v);
            } else {
              merged.set(entry.name, new Set(entry.versions));
            }
          }
        } catch {
        }
      }
      return [...merged.entries()].map(([name, versions]) => ({
        name,
        versions: [...versions].sort(),
      }));
    },

    async get(name: string, version: string): Promise<PackageVersion | null> {
      for (const store of stores) {
        try {
          const pkg = await store.get(name, version);
          if (pkg) return pkg;
        } catch {
        }
      }
      return null;
    },
  };
}
