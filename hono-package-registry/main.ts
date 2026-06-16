import { Command } from "@cliffy/command";
import type { PackageStore } from "@hono-jsr/package-store-abc";
import { createLocalFsStore } from "@hono-jsr/package-store-local-fs";
import { createRemoteGitStore } from "@hono-jsr/package-store-remote-git";
import { createPackageRegistryFactory } from "@hono-jsr/hono-factory-package-registry";

type StoreMode = "git" | "local";

if (import.meta.main) {
  const { options } = await new Command()
    .name("hono-package-registry")
    .version("0.0.0")
    .description("JSR-compatible package registry backed by git or local directory")
    .option("--store <mode>", 'Backing store: "git" or "local"', {
      default: "local",
    })
    .option("--git-url <url>", "Remote git repository URL (required for git store)")
    .option("--base-dir <path>", "Local filesystem directory (required for local store)")
    .option("--port <port:number>", "HTTP port to listen on", {
      default: 8080,
    })
    .parse(Deno.args);

  const storeMode = options.store as StoreMode;
  const port = options.port;

  let store: PackageStore;

  if (storeMode === "git") {
    const gitUrl = options.gitUrl;
    if (!gitUrl) {
      console.error("Error: --git-url is required when --store=git");
      Deno.exit(1);
    }
    store = createRemoteGitStore({ url: gitUrl });
  } else {
    const baseDir = options.baseDir ?? "./packages";
    store = createLocalFsStore({ baseDir });
  }

  const app = createPackageRegistryFactory({
    store,
    label: "hono-package-registry",
  });

  console.log(JSON.stringify({
    event: "registry_starting",
    storeMode,
    port,
  }));

  Deno.serve({ port }, app.fetch);
}
