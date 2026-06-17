import { Command } from "@cliffy/command";
import type { PackageStore } from "@publicdomainrelay/hono-jsr-package-store-abc";
import { createLocalFsStore } from "@publicdomainrelay/hono-jsr-package-store-local-fs";
import { createRemoteGitStore } from "@publicdomainrelay/hono-jsr-package-store-remote-git";
import { createCompositeStore } from "@publicdomainrelay/hono-jsr-package-store-composite";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-jsr-factory-package-registry";

type StoreMode = "git" | "local";

interface StoreConfig {
  type: StoreMode;
  baseDir?: string;
  url?: string;
  cacheDir?: string;
}

interface StoresConfigFile {
  stores: StoreConfig[];
}

function buildStore(config: StoreConfig, fallbackVersion: string): PackageStore {
  if (config.type === "git") {
    if (!config.url) {
      console.error("Error: --git-url is required when --store=git");
      Deno.exit(1);
    }
    return createRemoteGitStore({ url: config.url, cacheDir: config.cacheDir, fallbackVersion });
  }
  return createLocalFsStore({ baseDir: config.baseDir ?? "./packages", fallbackVersion });
}

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
    .option("--stores-config <path>", "JSON file defining multiple stores (overrides --store)")
    .option("--port <port:number>", "HTTP port to listen on", {
      default: 8080,
    })
    .option("--passthrough", "Pass through to jsr.io when package not found locally", {
      default: true,
    })
    .option("--fallback-version <version>", "Fallback version when no real version found", {
      default: "0.0.0",
    })
    .parse(Deno.args);

  const port = options.port;
  const passthrough = options.passthrough;
  const fallbackVersion = options.fallbackVersion;

  let store: PackageStore;

  if (options.storesConfig) {
    const configJson = JSON.parse(
      await Deno.readTextFile(options.storesConfig),
    ) as StoresConfigFile;
    if (!configJson.stores || configJson.stores.length === 0) {
      console.error("Error: --stores-config file must define a non-empty stores array");
      Deno.exit(1);
    }
    const stores = configJson.stores.map((s) => buildStore(s, fallbackVersion));
    store = createCompositeStore({ stores });
  } else {
    const storeMode = options.store as StoreMode;

    if (storeMode === "git") {
      const gitUrl = options.gitUrl;
      if (!gitUrl) {
        console.error("Error: --git-url is required when --store=git");
        Deno.exit(1);
      }
      store = createRemoteGitStore({ url: gitUrl, fallbackVersion });
    } else {
      const baseDir = options.baseDir ?? "./packages";
      store = createLocalFsStore({ baseDir, fallbackVersion });
    }
  }

  const app = createPackageRegistryFactory({
    store,
    label: "hono-package-registry",
    passthrough,
  });

  console.log(JSON.stringify({
    event: "registry_starting",
    storeMode: options.storesConfig ? "composite" : (options.store as string),
    port,
    passthrough,
    fallbackVersion,
  }));

  Deno.serve({ port, onListen: ({ port, hostname }) => {
    console.log(JSON.stringify({
      event: "listen",
      hostname,
      port,
    }));
  }, }, app.fetch);
}
