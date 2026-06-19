import { assertEquals, assertExists, assertStringIncludes, assertNotEquals } from "@std/assert";
import { createLocalFsStore } from "@publicdomainrelay/package-store-local-fs";
import { createCompositeStore } from "@publicdomainrelay/package-store-composite";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-factory-package-registry";
import { join, fromFileUrl } from "@std/path";

const TEST_DIR = join(fromFileUrl(import.meta.resolve("../test-packages")!));

Deno.test("local-fs store: list packages", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const packages = await store.list();

  assertEquals(packages.length, 2);

  const myPkg = packages.find((p) => p.name === "my-pkg")!;
  assertExists(myPkg);
  assertEquals(myPkg.versions.length, 2);
  assertEquals(myPkg.versions.includes("1.0.0"), true);
  assertEquals(myPkg.versions.includes("1.1.0"), true);

  const scoped = packages.find((p) => p.name === "@scope/scoped-pkg")!;
  assertExists(scoped);
  assertEquals(scoped.versions, ["1.0.0"]);
});

Deno.test("local-fs store: get package version", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const pkg = await store.get("my-pkg", "1.0.0");

  assertExists(pkg);
  assertEquals(pkg!.name, "my-pkg");
  assertEquals(pkg!.version, "1.0.0");
  assertEquals("mod.ts" in pkg!.files, true);
  assertEquals("cli.ts" in pkg!.files, true);
  assertEquals("README.md" in pkg!.files, true);
  assertStringIncludes(pkg!.files["mod.ts"], "Hello from my-pkg@1.0.0");
});

Deno.test("local-fs store: returns null for unknown package", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const pkg = await store.get("nonexistent", "1.0.0");
  assertEquals(pkg, null);
});

Deno.test("registry HTTP: meta.json for unscoped package", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/my-pkg/meta.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.name, "my-pkg");
  assertEquals(body.latest, "1.1.0");
  assertEquals("1.0.0" in body.versions, true);
  assertEquals("1.1.0" in body.versions, true);
});

Deno.test("registry HTTP: meta.json for scoped package", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/@scope/scoped-pkg/meta.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.scope, "scope");
  assertEquals(body.name, "scoped-pkg");
  assertEquals(body.latest, "1.0.0");
});

Deno.test("registry HTTP: _meta.json for version", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/my-pkg/1.0.0_meta.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.exports, "object");
  assertEquals(typeof body.manifest, "object");
  assertExists(body.manifest["/mod.ts"]);
  assertEquals(typeof body.manifest["/mod.ts"].checksum, "string");
});

Deno.test("registry HTTP: serve file via at-style URL", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/my-pkg@1.0.0/mod.ts");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type")?.startsWith("text/typescript"),
    true,
  );
  const body = await res.text();
  assertStringIncludes(body, "Hello from my-pkg@1.0.0");
});

Deno.test("registry HTTP: serve scoped package file", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/@scope/scoped-pkg@1.0.0/mod.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "Hello from @scope/scoped-pkg@1.0.0");
});

Deno.test("registry HTTP: serve file via JSR-style URL", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/my-pkg/1.0.0/mod.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "Hello from my-pkg@1.0.0");
});

Deno.test("registry HTTP: missing file returns 404 with available files", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/my-pkg@1.0.0/nonexistent.ts");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "FileNotFound");
  assertEquals(Array.isArray(body.availableFiles), true);
});

Deno.test("registry HTTP: CORS headers present", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/my-pkg@1.0.0/mod.ts");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("registry HTTP: import-map.json", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/import-map.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.imports, "object");
});

Deno.test("registry HTTP: unknown package meta.json returns 404", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/nonexistent/meta.json");
  assertEquals(res.status, 404);
});

// -- composite store tests --

Deno.test("composite store: list merges packages from multiple stores", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "composite-test-" });
  try {
    await Deno.mkdir(join(tmpDir, "pkg-a", "1.0.0"), { recursive: true });
    await Deno.writeTextFile(join(tmpDir, "pkg-a", "1.0.0", "mod.ts"), "export const a = 1;");
    await Deno.mkdir(join(tmpDir, "pkg-b", "2.0.0"), { recursive: true });
    await Deno.writeTextFile(join(tmpDir, "pkg-b", "2.0.0", "mod.ts"), "export const b = 1;");

    const storeA = createLocalFsStore({ baseDir: tmpDir });
    const storeB = createLocalFsStore({ baseDir: TEST_DIR });
    const composite = createCompositeStore({ stores: [storeA, storeB] });

    const packages = await composite.list();
    const names = packages.map((p) => p.name);
    assertEquals(names.includes("pkg-a"), true);
    assertEquals(names.includes("pkg-b"), true);
    assertEquals(names.includes("my-pkg"), true);
    assertEquals(names.includes("@scope/scoped-pkg"), true);
  } finally {
    try { await Deno.remove(tmpDir, { recursive: true }); } catch { /* ok */ }
  }
});

Deno.test("composite store: get tries stores in order", async () => {
  const missingStore = createLocalFsStore({ baseDir: join(TEST_DIR, "empty-dir") });
  const realStore = createLocalFsStore({ baseDir: TEST_DIR });
  const composite = createCompositeStore({ stores: [missingStore, realStore] });

  const pkg = await composite.get("my-pkg", "1.0.0");
  assertExists(pkg);
  assertEquals(pkg!.name, "my-pkg");
});

Deno.test("composite store: get returns null when no store has package", async () => {
  const storeA = createLocalFsStore({ baseDir: join(TEST_DIR, "my-pkg") });
  const storeB = createLocalFsStore({ baseDir: join(TEST_DIR, "@scope") });
  const composite = createCompositeStore({ stores: [storeA, storeB] });

  const pkg = await composite.get("nonexistent", "1.0.0");
  assertEquals(pkg, null);
});

Deno.test("composite store: list deduplicates versions across stores", async () => {
  const storeA = createLocalFsStore({ baseDir: TEST_DIR });
  const storeB = createLocalFsStore({ baseDir: TEST_DIR });
  const composite = createCompositeStore({ stores: [storeA, storeB] });

  const packages = await composite.list();
  const myPkg = packages.find((p) => p.name === "my-pkg");
  assertExists(myPkg);
  assertEquals(myPkg!.versions.length, 2);
});

Deno.test("composite store: tolerates failed store", async () => {
  const badStore = {
    async list() { throw new Error("boom"); },
    async get(_name: string, _version: string) { throw new Error("boom"); },
  };
  const realStore = createLocalFsStore({ baseDir: TEST_DIR });
  const composite = createCompositeStore({ stores: [badStore, realStore] });

  const packages = await composite.list();
  assertEquals(packages.length, 2);

  const pkg = await composite.get("my-pkg", "1.0.0");
  assertExists(pkg);
});

Deno.test("composite store: first store wins for get", async () => {
  const storeA = createLocalFsStore({ baseDir: TEST_DIR });
  const storeB = {
    async list() { return [] as { name: string; versions: string[] }[]; },
    async get(name: string, _version: string) {
      throw new Error(`should not be called for ${name}`);
    },
  };
  const composite = createCompositeStore({ stores: [storeA, storeB] });

  const pkg = await composite.get("my-pkg", "1.0.0");
  assertExists(pkg);
  assertEquals(pkg!.name, "my-pkg");
});

Deno.test("composite store: empty stores returns empty list and null get", async () => {
  const composite = createCompositeStore({ stores: [] });

  const packages = await composite.list();
  assertEquals(packages.length, 0);

  const pkg = await composite.get("anything", "1.0.0");
  assertEquals(pkg, null);
});

// -- passthrough tests --

Deno.test("registry HTTP: passthrough disabled returns 404 without network", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const start = performance.now();
  const res = await app.request("/@nonexistent/nope/meta.json");
  const durationMs = performance.now() - start;

  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "PackageNotFound");
  // passthrough disabled means no network round-trip: should be fast
  assertEquals(durationMs < 50, true);
});

Deno.test("registry HTTP: passthrough disabled for file serving returns 404", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/nonexistent@1.0.0/mod.ts");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "PackageNotFound");
});

Deno.test("registry HTTP: passthrough disabled for _meta.json returns 404", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/nonexistent/1.0.0_meta.json");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "PackageNotFound");
});

Deno.test("registry HTTP: passthrough enabled defaults to true", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  // known-existent package still served locally
  const res = await app.request("/my-pkg@1.0.0/mod.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "Hello from my-pkg@1.0.0");
});

Deno.test("registry HTTP: passthrough proxies to jsr.io for known scoped package", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/@std/assert/meta.json");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "*",
  );
  const body = await res.json();
  assertEquals(body.scope, "std");
  assertEquals(body.name, "assert");
});

Deno.test("registry HTTP: passthrough adds CORS headers to proxied response", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/@std/assert/meta.json");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "*",
  );
  assertEquals(
    res.headers.get("cross-origin-resource-policy"),
    "cross-origin",
  );
});

Deno.test("registry HTTP: passthrough serves file via JSR-style URL from jsr.io", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const metaRes = await app.request("/@std/assert/meta.json");
  assertEquals(metaRes.status, 200);
  const meta = await metaRes.json();
  const latest = meta.latest as string;

  const fileRes = await app.request(`/@std/assert/${latest}/mod.ts`);
  assertEquals(fileRes.status, 200);
  assertEquals(
    fileRes.headers.get("access-control-allow-origin"),
    "*",
  );
  const body = await fileRes.text();
  assertNotEquals(body.length, 0);
});

Deno.test("registry HTTP: passthrough for _meta.json from jsr.io", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const metaRes = await app.request("/@std/assert/meta.json");
  assertEquals(metaRes.status, 200);
  const meta = await metaRes.json();
  const latest = meta.latest as string;

  const res = await app.request(`/@std/assert/${latest}_meta.json`);
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "*",
  );
  const body = await res.json();
  assertEquals(typeof body.exports, "object");
  assertEquals(typeof body.manifest, "object");
});

// -- composite store with passthrough --

Deno.test("composite + passthrough: tries composite first then jsr.io", async () => {
  const localStore = createLocalFsStore({ baseDir: TEST_DIR });
  const composite = createCompositeStore({ stores: [localStore] });
  const app = createPackageRegistryFactory({ store: composite });

  // local package resolves from composite store
  const localRes = await app.request("/my-pkg@1.0.0/mod.ts");
  assertEquals(localRes.status, 200);
  const localBody = await localRes.text();
  assertStringIncludes(localBody, "Hello from my-pkg@1.0.0");

  // unknown package falls through to jsr.io passthrough
  const proxiedRes = await app.request("/@std/assert/meta.json");
  assertEquals(proxiedRes.status, 200);
  assertEquals(
    proxiedRes.headers.get("access-control-allow-origin"),
    "*",
  );
  const body = await proxiedRes.json();
  assertEquals(body.scope, "std");
  assertEquals(body.name, "assert");
});

Deno.test("composite + passthrough disabled: no fallback to jsr.io", async () => {
  const localStore = createLocalFsStore({ baseDir: TEST_DIR });
  const composite = createCompositeStore({ stores: [localStore] });
  const app = createPackageRegistryFactory({ store: composite, passthrough: false });

  const res = await app.request("/@std/assert/meta.json");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "PackageNotFound");
});

// -- fallback version: deno.json auto-detect in local-fs --

const PROJECT_ROOT = fromFileUrl(import.meta.resolve("../")!);

Deno.test("local-fs fallback: deno.json scan discovers workspace packages", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });

  const packages = await store.list();
  const names = packages.map((p) => p.name);

  // lib/abc/package-store/deno.json -> @publicdomainrelay/package-store-abc
  assertEquals(names.includes("@publicdomainrelay/package-store-abc"), true);

  // lib/hono-factory-package-registry/deno.json -> @publicdomainrelay/hono-factory-package-registry
  assertEquals(names.includes("@publicdomainrelay/hono-factory-package-registry"), true);

  // lib/package-store-local-fs/deno.json -> @publicdomainrelay/package-store-local-fs
  assertEquals(names.includes("@publicdomainrelay/package-store-local-fs"), true);

  // lib/package-store-remote-git/deno.json -> @publicdomainrelay/package-store-remote-git
  assertEquals(names.includes("@publicdomainrelay/package-store-remote-git"), true);

  // lib/package-store-composite/deno.json -> @publicdomainrelay/package-store-composite
  assertEquals(names.includes("@publicdomainrelay/package-store-composite"), true);

  // all deno.json packages have version 0.0.0 (fallback)
  for (const pkg of packages) {
    if (pkg.name.startsWith("@publicdomainrelay/")) {
      assertEquals(pkg.versions, ["0.0.0"]);
    }
  }
});

Deno.test("local-fs fallback: get serves files from deno.json directory", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });

  const pkg = await store.get("@publicdomainrelay/package-store-abc", "0.0.0");
  assertExists(pkg);
  assertEquals(pkg!.name, "@publicdomainrelay/package-store-abc");
  assertEquals(pkg!.version, "0.0.0");
  assertEquals("mod.ts" in pkg!.files, true);
  assertEquals("deno.json" in pkg!.files, true);
  assertStringIncludes(pkg!.files["mod.ts"], "export interface PackageEntry");
});

Deno.test("local-fs fallback: get with wrong version returns null", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });

  const pkg = await store.get("@publicdomainrelay/package-store-abc", "9.9.9");
  assertEquals(pkg, null);
});

Deno.test("local-fs fallback: get with non-fallback version returns null for deno-json pkg", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });

  const pkg = await store.get("@publicdomainrelay/package-store-abc", "1.0.0");
  assertEquals(pkg, null);
});

Deno.test("local-fs fallback: custom fallback version", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT, fallbackVersion: "5.5.5" });

  const packages = await store.list();
  const abcPkg = packages.find((p) => p.name === "@publicdomainrelay/package-store-abc");
  assertExists(abcPkg);
  assertEquals(abcPkg!.versions, ["5.5.5"]);

  const pkg = await store.get("@publicdomainrelay/package-store-abc", "5.5.5");
  assertExists(pkg);
  assertEquals(pkg!.version, "5.5.5");
});

Deno.test("local-fs fallback: deno.json pkg has metadata with exports", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });

  const pkg = await store.get("@publicdomainrelay/hono-factory-package-registry", "0.0.0");
  assertExists(pkg);
  assertEquals(typeof pkg!.metadata, "object");
  assertEquals(typeof (pkg!.metadata as Record<string, unknown>).exports, "object");
});

Deno.test("local-fs fallback: dir-structure packages still work alongside deno.json", async () => {
  // TEST_DIR has my-pkg/1.0.0/ and @scope/scoped-pkg/1.0.0/ (dir-structure)
  const store = createLocalFsStore({ baseDir: TEST_DIR });

  // version-dir packages resolved via directory structure
  const pkg = await store.get("my-pkg", "1.0.0");
  assertExists(pkg);
  assertEquals(pkg!.name, "my-pkg");
  assertEquals(pkg!.version, "1.0.0");
  assertStringIncludes(pkg!.files["mod.ts"], "Hello from my-pkg@1.0.0");

  const scopedPkg = await store.get("@scope/scoped-pkg", "1.0.0");
  assertExists(scopedPkg);
  assertEquals(scopedPkg!.name, "@scope/scoped-pkg");
});

// -- HTTP tests with fallback --

Deno.test("registry HTTP: fallback packages appear in meta.json", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/@publicdomainrelay/package-store-abc/meta.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.scope, "publicdomainrelay");
  assertEquals(body.name, "package-store-abc");
  assertEquals(body.latest, "0.0.0");
});

Deno.test("registry HTTP: fallback packages serve via at-style URL", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/@publicdomainrelay/package-store-abc@0.0.0/mod.ts");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type")?.startsWith("text/typescript"),
    true,
  );
  const body = await res.text();
  assertStringIncludes(body, "export interface PackageEntry");
});

Deno.test("registry HTTP: fallback packages serve via JSR-style URL", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/@publicdomainrelay/package-store-abc/0.0.0/mod.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "export interface PackageEntry");
});

Deno.test("registry HTTP: fallback _meta.json for deno.json package", async () => {
  const store = createLocalFsStore({ baseDir: PROJECT_ROOT });
  const app = createPackageRegistryFactory({ store, passthrough: false });

  const res = await app.request("/@publicdomainrelay/package-store-abc/0.0.0_meta.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.exports, "object");
  assertEquals(typeof body.manifest, "object");
});

Deno.test("local-fs fallback: get survives bad deno.json without name field in scan path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "bad-deno-json-test-" });
  try {
    await Deno.mkdir(join(tmpDir, "aaa-no-name"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, "aaa-no-name", "deno.json"),
      JSON.stringify({ version: "1.0.0" }),
    );

    await Deno.mkdir(join(tmpDir, "bbb-real"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, "bbb-real", "deno.json"),
      JSON.stringify({ name: "@test/real-pkg", version: "2.0.0", exports: "./mod.ts" }),
    );
    await Deno.writeTextFile(
      join(tmpDir, "bbb-real", "mod.ts"),
      "export const x = 1;",
    );

    const store = createLocalFsStore({ baseDir: tmpDir });

    const packages = await store.list();
    const names = packages.map((p) => p.name);
    assertEquals(names.includes("@test/real-pkg"), true);

    const pkg = await store.get("@test/real-pkg", "0.0.0");
    assertExists(pkg);
    assertEquals(pkg!.name, "@test/real-pkg");
    assertEquals("mod.ts" in pkg!.files, true);
    assertEquals(pkg!.files["mod.ts"], "export const x = 1;");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("local-fs fallback: get survives malformed JSON deno.json in scan path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "bad-json-test-" });
  try {
    await Deno.mkdir(join(tmpDir, "aaa-broken"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, "aaa-broken", "deno.json"),
      "not valid json {{{",
    );

    await Deno.mkdir(join(tmpDir, "bbb-real"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, "bbb-real", "deno.json"),
      JSON.stringify({ name: "@test/real-pkg", exports: "./mod.ts" }),
    );
    await Deno.writeTextFile(
      join(tmpDir, "bbb-real", "mod.ts"),
      "export const y = 2;",
    );

    const store = createLocalFsStore({ baseDir: tmpDir });

    const pkg = await store.get("@test/real-pkg", "0.0.0");
    assertExists(pkg);
    assertEquals(pkg!.name, "@test/real-pkg");
    assertEquals(pkg!.files["mod.ts"], "export const y = 2;");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("local-fs fallback: get survives unreadable deno.json in scan path", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "bad-read-test-" });
  try {
    const subDir = join(tmpDir, "aaa-dir-not-file");
    await Deno.mkdir(subDir, { recursive: true });
    await Deno.mkdir(join(subDir, "deno.json"), { recursive: true });

    await Deno.mkdir(join(tmpDir, "bbb-real"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, "bbb-real", "deno.json"),
      JSON.stringify({ name: "@test/real-pkg", exports: "./mod.ts" }),
    );
    await Deno.writeTextFile(
      join(tmpDir, "bbb-real", "mod.ts"),
      "export const z = 3;",
    );

    const store = createLocalFsStore({ baseDir: tmpDir });

    const pkg = await store.get("@test/real-pkg", "0.0.0");
    assertExists(pkg);
    assertEquals(pkg!.name, "@test/real-pkg");
    assertEquals(pkg!.files["mod.ts"], "export const z = 3;");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
