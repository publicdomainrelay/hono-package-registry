import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createLocalFsStore } from "@hono-jsr/package-store-local-fs";
import { createPackageRegistryFactory } from "@hono-jsr/hono-factory-package-registry";
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
  const app = createPackageRegistryFactory({ store });

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
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/@scope/scoped-pkg/meta.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.scope, "scope");
  assertEquals(body.name, "scoped-pkg");
  assertEquals(body.latest, "1.0.0");
});

Deno.test("registry HTTP: _meta.json for version", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

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
  const app = createPackageRegistryFactory({ store });

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
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/@scope/scoped-pkg@1.0.0/mod.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "Hello from @scope/scoped-pkg@1.0.0");
});

Deno.test("registry HTTP: serve file via JSR-style URL", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/my-pkg/1.0.0/mod.ts");
  assertEquals(res.status, 200);
  const body = await res.text();
  assertStringIncludes(body, "Hello from my-pkg@1.0.0");
});

Deno.test("registry HTTP: missing file returns 404 with available files", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/my-pkg@1.0.0/nonexistent.ts");
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "FileNotFound");
  assertEquals(Array.isArray(body.availableFiles), true);
});

Deno.test("registry HTTP: CORS headers present", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/my-pkg@1.0.0/mod.ts");
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("registry HTTP: import-map.json", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/import-map.json");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(typeof body.imports, "object");
});

Deno.test("registry HTTP: unknown package meta.json returns 404", async () => {
  const store = createLocalFsStore({ baseDir: TEST_DIR });
  const app = createPackageRegistryFactory({ store });

  const res = await app.request("/nonexistent/meta.json");
  assertEquals(res.status, 404);
});
