import { Command } from "@publicdomainrelay/cli-args-env";
import type { PackageStore } from "@publicdomainrelay/package-store-abc";
import { createLocalFsStore } from "@publicdomainrelay/package-store-local-fs";
import { createRemoteGitStore } from "@publicdomainrelay/package-store-remote-git";
import { createCompositeStore } from "@publicdomainrelay/package-store-composite";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-factory-package-registry";
import { createServe, type ServeHandle } from "@publicdomainrelay/serve";
import { createStructuredLogger, type LogLevel } from "@publicdomainrelay/logger";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

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

export interface PackageRegistryCliOptions {
  store?: StoreMode;
  gitUrl?: string;
  baseDir?: string;
  storesConfig?: string;
  port?: number;
  passthrough?: boolean;
  fallbackVersion?: string;
  logLevel?: LogLevel;
}

function buildStore(config: StoreConfig, fallbackVersion: string): PackageStore {
  if (config.type === "git") {
    if (!config.url) {
      throw new Error("--git-url is required when --store=git");
    }
    return createRemoteGitStore({ url: config.url, cacheDir: config.cacheDir, fallbackVersion });
  }
  return createLocalFsStore({ baseDir: config.baseDir as string, fallbackVersion });
}

export async function runPackageRegistry(
  options: PackageRegistryCliOptions,
): Promise<ServeHandle> {
  const port = options.port ?? 8080;
  const passthrough = options.passthrough ?? true;
  const fallbackVersion = options.fallbackVersion ?? "0.0.0";

  let store: PackageStore;

  if (options.storesConfig) {
    const configJson = JSON.parse(
      await Deno.readTextFile(options.storesConfig),
    ) as StoresConfigFile;
    if (!configJson.stores || configJson.stores.length === 0) {
      throw new Error("--stores-config file must define a non-empty stores array");
    }
    const stores = configJson.stores.map((s) => buildStore(s, fallbackVersion));
    store = createCompositeStore({ stores });
  } else {
    const storeMode = options.store ?? "local";
    store = buildStore(
      { type: storeMode, baseDir: options.baseDir ?? "./packages", url: options.gitUrl },
      fallbackVersion,
    );
  }

  const app = createPackageRegistryFactory({
    store,
    label: "hono-package-registry",
    passthrough,
  });

  const logger = createStructuredLogger("hono-package-registry", options.logLevel ?? "info");
  logger.info("registry_starting", {
    event: "registry_starting",
    storeMode: options.storesConfig ? "composite" : (options.store ?? "local"),
    port,
    passthrough,
    fallbackVersion,
  });

  const serve = createServe({ logger, tcp: { port } });
  serve.app.route("/", app as never);
  await serve.beginServe();
  return serve;
}

if (import.meta.main) {
  let runtimeConfig = null;
  try {
    const mod = await import("./config.json", { with: { type: "json" } });
    runtimeConfig = mod.default;
  } catch { /* optional */ }

  const { options } = await new Command(
    "CONFIG_PATH_HONO_PACKAGE_REGISTRY",
    cliArgsEnv,
    runtimeConfig,
  ).resolve();

  const serve = await runPackageRegistry(options as PackageRegistryCliOptions);

  function shutdown() {
    serve.shutdown();
    Deno.exit();
  }
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}
