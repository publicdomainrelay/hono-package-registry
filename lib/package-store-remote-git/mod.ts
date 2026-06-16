import type { PackageEntry, PackageStore, PackageVersion } from "@hono-jsr/package-store-abc";

export interface RemoteGitStoreOptions {
  url: string;
  cacheDir?: string;
}

const VERSION_TAG_RE = /^v?\d+\.\d+\.\d+/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;

function derivePackageName(url: string): string {
  let name = url.replace(/\.git$/, "");
  const match = name.match(/[:/]([^/:]+\/[^/:]+?)(?:\.git)?$/);
  if (match) return `@${match[1]}`;
  const parts = name.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "unknown";
}

function tagToVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

async function git(args: string[], cwd?: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`git ${args[0]} failed (exit ${code}): ${err.trim()}`);
  }
  return new TextDecoder().decode(stdout);
}

async function readFileAtTag(
  repoDir: string,
  tag: string,
  path: string,
): Promise<string | null> {
  try {
    return await git(["show", `${tag}:${path}`], repoDir);
  } catch {
    return null;
  }
}

interface PackageMeta {
  subdir: string;
  denoJson: {
    name?: string;
    version?: string;
    exports?: string | Record<string, string>;
    description?: string;
    [key: string]: unknown;
  };
}

async function discoverPackages(
  repoDir: string,
  tag: string,
  defaultOwner?: string,
): Promise<Map<string, PackageMeta>> {
  const pkgs = new Map<string, PackageMeta>();

  const fileList = await git(
    ["ls-tree", "-r", "--name-only", tag],
    repoDir,
  );
  const paths = fileList.trim().split("\n").filter(Boolean);

  const denoJsonPaths = paths.filter((p) =>
    p.endsWith("deno.json") || p.endsWith("deno.jsonc")
  );

  for (const denoPath of denoJsonPaths) {
    const content = await readFileAtTag(repoDir, tag, denoPath);
    if (!content) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const subdir = denoPath.replace(/\/?deno\.jsonc?$/, "");

    const explicitName = typeof parsed.name === "string" ? parsed.name : undefined;
    const dirName = subdir.split("/").pop() || subdir;
    const fallbackPkgName = defaultOwner ? `@${defaultOwner}/${dirName}` : undefined;
    const name = explicitName ?? fallbackPkgName;
    if (!name) continue;

    let exports: string | Record<string, string> | undefined;
    if (typeof parsed.exports === "string") {
      exports = parsed.exports;
    } else if (parsed.exports && typeof parsed.exports === "object") {
      exports = parsed.exports as Record<string, string>;
    }

    let imports: Record<string, string> | undefined;
    if (parsed.imports && typeof parsed.imports === "object") {
      imports = parsed.imports as Record<string, string>;
    }

    pkgs.set(name, {
      subdir,
      denoJson: {
        name,
        version: typeof parsed.version === "string" ? parsed.version : undefined,
        exports,
        imports,
        description: typeof parsed.description === "string"
          ? parsed.description
          : undefined,
      },
    });
  }

  return pkgs;
}

export function createRemoteGitStore(opts: RemoteGitStoreOptions): PackageStore {
  const { url } = opts;
  const cacheDir = opts.cacheDir ?? Deno.makeTempDirSync({ prefix: "pkg-git-" });
  const fallbackName = derivePackageName(url);
  const defaultOwner = fallbackName.replace(/^@/, "").split("/")[0];

  let initialized = false;
  const discoveryCache = new Map<string, Map<string, PackageMeta>>();

  async function ensureClone(): Promise<string> {
    const repoDir = `${cacheDir}/repo.git`;
    if (!initialized) {
      let cloneError: string | undefined;
      try {
        await git(["clone", "--bare", url, repoDir]);
      } catch (e) {
        cloneError = e instanceof Error ? e.message : String(e);
        try {
          const stat = await Deno.stat(repoDir);
          if (stat.isDirectory) {
            await git(["fetch", "--tags"], repoDir);
          }
        } catch {
          // dir does not exist either
        }
      }
      initialized = true;
      try {
        const stat = await Deno.stat(repoDir);
        if (!stat.isDirectory) throw new Error("not a directory");
      } catch {
        const cause = cloneError ? `: ${cloneError}` : "";
        throw new Error(
          `Git clone/fetch failed. Repo dir does not exist: ${repoDir}${cause}`,
        );
      }
    } else {
      try {
        await git(["fetch", "--tags"], repoDir);
      } catch {
        // fetch failure is non-fatal for read operations
      }
    }
    return repoDir;
  }

  async function listTags(repoDir: string): Promise<string[]> {
    const out = await git(["tag"], repoDir);
    return out.trim().split("\n").filter(Boolean).filter((t) =>
      VERSION_TAG_RE.test(t)
    );
  }

  async function listBranches(repoDir: string): Promise<string[]> {
    const out = await git(["branch"], repoDir);
    return out.trim().split("\n").filter(Boolean).map((b) =>
      b.trim().replace(/^\*?\s*/, "")
    ).filter((b) => b && b !== "HEAD" && !b.includes(" -> "));
  }

  async function getDiscovery(
    repoDir: string,
    tag: string,
    defaultOwner?: string,
  ): Promise<Map<string, PackageMeta>> {
    const cached = discoveryCache.get(tag);
    if (cached) return cached;
    const pkgs = await discoverPackages(repoDir, tag, defaultOwner);
    discoveryCache.set(tag, pkgs);
    return pkgs;
  }

  async function findPackage(
    repoDir: string,
    tag: string,
    packageName: string,
  ): Promise<PackageMeta | null> {
    const pkgs = await getDiscovery(repoDir, tag, defaultOwner);
    const found = pkgs.get(packageName);
    if (found) return found;

    if (packageName === fallbackName && pkgs.size === 0) {
      return {
        subdir: "",
        denoJson: { name: fallbackName },
      };
    }

    return null;
  }

  function isBinaryPath(path: string): boolean {
    return /\.(png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|eot|wasm|gz|zip|tar|bz2|xz|7z)$/i
      .test(path);
  }

  async function resolveRef(repoDir: string, version: string): Promise<string | null> {
    const ref = version.startsWith("$") ? version.slice(1) : version;

    const isShaLike = /^[0-9a-f]{7,40}$/i.test(ref);

    if (isShaLike) {
      try {
        await git(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
        return ref;
      } catch {
        return null;
      }
    }

    try {
      await git(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
      return ref;
    } catch {
      // not local
    }
    try {
      await git(
        ["fetch", "origin", `refs/heads/${ref}:refs/heads/${ref}`],
        repoDir,
      );
      await git(["rev-parse", "--verify", `${ref}^{commit}`], repoDir);
      return ref;
    } catch {
      return null;
    }
  }

  async function buildPackageVersion(
    repoDir: string,
    ref: string,
    pkgMeta: PackageMeta,
    requestedName: string,
    requestedVersion: string,
  ): Promise<PackageVersion> {
    const fileList = await git(
      ["ls-tree", "-r", "--name-only", ref],
      repoDir,
    );
    let paths = fileList.trim().split("\n").filter(Boolean);

    if (pkgMeta.subdir) {
      const prefix = pkgMeta.subdir + "/";
      paths = paths
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
    }

    const files: Record<string, string> = {};
    for (const relPath of paths) {
      if (isBinaryPath(relPath)) continue;

      const gitPath = pkgMeta.subdir
        ? `${pkgMeta.subdir}/${relPath}`
        : relPath;

      try {
        const content = await git(["show", `${ref}:${gitPath}`], repoDir);
        files[relPath] = content;
      } catch {
        // skip unreadable files
      }
    }

    let exports: Record<string, string>;
    const denoExports = pkgMeta.denoJson.exports;
    if (typeof denoExports === "string") {
      exports = { ".": denoExports };
    } else if (denoExports && typeof denoExports === "object") {
      exports = denoExports as Record<string, string>;
    } else {
      const entry = "mod.ts" in files
        ? "./mod.ts"
        : Object.keys(files).find((f) =>
          f.endsWith(".ts") || f.endsWith(".js")
        ) ?? "";
      exports = { ".": entry ? `./${entry}` : "./mod.ts" };
    }

    return {
      name: requestedName,
      version: requestedVersion,
      files,
      metadata: {
        exports,
        denoJson: pkgMeta.denoJson,
      },
    };
  }

  return {
    async list(): Promise<PackageEntry[]> {
      const repoDir = await ensureClone();
      const tags = await listTags(repoDir);
      const branches = await listBranches(repoDir);

      const pkgVersions = new Map<string, { versions: string[]; description?: string }>();

      for (const tag of tags) {
        const version = tagToVersion(tag);
        const pkgs = await getDiscovery(repoDir, tag, defaultOwner);

        if (pkgs.size === 0) {
          const existing = pkgVersions.get(fallbackName);
          if (existing) {
            existing.versions.push(version);
          } else {
            pkgVersions.set(fallbackName, { versions: [version] });
          }
        } else {
          for (const [name, meta] of pkgs) {
            const existing = pkgVersions.get(name);
            if (existing) {
              existing.versions.push(version);
              existing.description = existing.description ??
                meta.denoJson.description;
            } else {
              pkgVersions.set(name, {
                versions: [version],
                description: meta.denoJson.description,
              });
            }
          }
        }
      }

      const DEV_BRANCH_RE = /^(main|master)$/;
      const SAFE_BRANCH_RE = /^[0-9A-Za-z-]+$/;
      for (const branch of branches) {
        if (!DEV_BRANCH_RE.test(branch) && !SAFE_BRANCH_RE.test(branch)) continue;
        const version = `0.1.0-${branch}`;
        let pkgs: Map<string, PackageMeta>;
        try {
          pkgs = await getDiscovery(repoDir, branch, defaultOwner);
        } catch {
          continue;
        }

        if (pkgs.size === 0) {
          const existing = pkgVersions.get(fallbackName);
          if (existing) {
            if (!existing.versions.includes(version)) {
              existing.versions.push(version);
            }
          } else {
            pkgVersions.set(fallbackName, { versions: [version] });
          }
        } else {
          for (const [name, meta] of pkgs) {
            const existing = pkgVersions.get(name);
            if (existing) {
              if (!existing.versions.includes(version)) {
                existing.versions.push(version);
              }
              existing.description = existing.description ??
                meta.denoJson.description;
            } else {
              pkgVersions.set(name, {
                versions: [version],
                description: meta.denoJson.description,
              });
            }
          }
        }
      }

      return [...pkgVersions.entries()].map(([name, info]) => ({
        name,
        versions: info.versions.sort(),
        description: info.description,
      }));
    },

    async get(name: string, version: string): Promise<PackageVersion | null> {
      const repoDir = await ensureClone();
      let tags = await listTags(repoDir);

      let tag = tags.find((t) =>
        tagToVersion(t) === version || t === version
      );

      let ref: string | null = null;

      if (tag) {
        ref = tag;
      } else if (SEMVER_RE.test(version)) {
        try {
          await git(["fetch", "--tags"], repoDir);
        } catch {
          // non-fatal
        }
        tags = await listTags(repoDir);
        tag = tags.find((t) =>
          tagToVersion(t) === version || t === version
        );
        if (tag) {
          discoveryCache.delete(tag);
          ref = tag;
        } else {
          const pseudoMatch = version.match(/^0\.[01]\.0-(.+)$/);
          if (pseudoMatch) {
            ref = await resolveRef(repoDir, `$${pseudoMatch[1]}`);
          }
        }
      } else {
        const pseudoMatch = version.match(/^0\.[01]\.0-(.+)$/);
        if (pseudoMatch) {
          ref = await resolveRef(repoDir, `$${pseudoMatch[1]}`);
        } else {
          ref = await resolveRef(repoDir, version);
        }
      }

      if (!ref) return null;

      const pkgMeta = await findPackage(repoDir, ref, name);
      if (!pkgMeta) return null;

      return await buildPackageVersion(repoDir, ref, pkgMeta, name, version);
    },
  };
}
