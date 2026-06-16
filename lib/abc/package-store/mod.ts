export interface PackageEntry {
  name: string;
  versions: string[];
  description?: string;
}

export interface PackageVersion {
  name: string;
  version: string;
  files: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface PackageStore {
  list(): Promise<PackageEntry[]>;
  get(name: string, version: string): Promise<PackageVersion | null>;
}
