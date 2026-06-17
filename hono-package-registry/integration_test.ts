import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createLocalFsStore } from "@publicdomainrelay/hono-jsr-package-store-local-fs";
import { createRemoteGitStore } from "@publicdomainrelay/hono-jsr-package-store-remote-git";
import { createPackageRegistryFactory } from "@publicdomainrelay/hono-jsr-factory-package-registry";
import { join, fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(import.meta.resolve("../")!);

// -- helpers --

interface ServerHandle {
  url: string;
  controller: AbortController;
}

function allocatePort(): number {
  const listener = Deno.listen({ port: 0 });
  const port = listener.addr.port;
  try { listener.close(); } catch { /* ok */ }
  return port;
}

function startRegistry(store: ReturnType<typeof createLocalFsStore | typeof createRemoteGitStore>): ServerHandle {
  const controller = new AbortController();
  const app = createPackageRegistryFactory({ store, label: "integration-test" });
  const port = allocatePort();
  const url = `http://localhost:${port}`;
  Deno.serve({ port, signal: controller.signal }, app.fetch);
  return { url, controller };
}

function runDeno(args: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(async (resolve) => {
    const cmd = new Deno.Command("deno", {
      args,
      cwd,
      stdout: "piped",
      stderr: "piped",
      env: { ...Deno.env.toObject(), ...env },
    });
    const { code, stdout, stderr } = await cmd.output();
    resolve({
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    });
  });
}

function stopServer(h: ServerHandle): void {
  h.controller.abort();
}

// -- git helpers --

interface GitRepo {
  tmp: string;
  workDir: string;
  bareDir: string;
}

async function git(args: string[], cwd: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`git ${args[0]} failed (${code}): ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
}

async function createGitRepo(): Promise<GitRepo> {
  const tmp = Deno.makeTempDirSync({ prefix: "int-git-" });
  const workDir = join(tmp, "work");
  const bareDir = join(tmp, "bare.git");
  await Deno.mkdir(workDir, { recursive: true });
  await git(["init"], workDir);
  await git(["config", "user.email", "test@test.com"], workDir);
  await git(["config", "user.name", "Integration Test"], workDir);
  await git(["clone", "--bare", workDir, bareDir]);
  return { tmp, workDir, bareDir };
}

function addPackageToGit(repo: GitRepo, name: string, version: string, files: Record<string, string>): Promise<void> {
  const pkgDir = join(repo.workDir, name);
  return (async () => {
    await Deno.mkdir(pkgDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(pkgDir, relPath);
      await Deno.mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(fullPath, content);
    }
    await git(["add", "."], repo.workDir);
    await git(["commit", "-m", `${name} v${version}`], repo.workDir);
    await git(["tag", `v${version}`], repo.workDir);
    await git(["push", "--all", repo.bareDir], repo.workDir);
    await git(["push", "--tags", repo.bareDir], repo.workDir);
  })();
}

function cleanupGitRepo(repo: GitRepo): void {
  Deno.remove(repo.tmp, { recursive: true }).catch(() => {});
}

function makePackage(name: string, version: string): Record<string, string> {
  return {
    "mod.ts": `export function hello(): string { return "Hello from ${name}@${version}"; }\nexport const VERSION = "${version}";\n`,
    "deno.json": JSON.stringify({ name, version, exports: "./mod.ts" }, null, 2),
    "README.md": `# ${name}\n\nVersion ${version}\n`,
  };
}

function writeDenoJsonWithImport(dir: string, pkgName: string, registryUrl: string, version: string): void {
  const cleanName = pkgName.replace(/^@/, "").replace(/\//, "-");
  Deno.writeTextFileSync(join(dir, "deno.json"), JSON.stringify({
    name: "@test/consumer",
    version: "0.0.0",
    imports: {
      [pkgName]: `${registryUrl}/@${pkgName.replace(/^@/, "")}@${version}/mod.ts`,
    },
  }, null, 2) + "\n");
}

// -- git http-backend server (binary-safe) --

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function startGitHttpBackend(projectRoot: string): ServerHandle {
  const controller = new AbortController();
  const port = allocatePort();
  const url = `http://localhost:${port}`;

  Deno.serve(
    { port, signal: controller.signal },
    async (req: Request): Promise<Response> => {
      const u = new URL(req.url);

      const env: Record<string, string> = {
        REQUEST_METHOD: req.method,
        GIT_PROJECT_ROOT: projectRoot,
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.replace(/^\?/, ""),
        CONTENT_TYPE: req.headers.get("content-type") ?? "",
        CONTENT_LENGTH: req.headers.get("content-length") ?? "",
        GIT_HTTP_EXPORT_ALL: "1",
        HOME: Deno.env.get("HOME") ?? "/tmp",
        REMOTE_ADDR: "127.0.0.1",
      };

      const body = req.body ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);

      const cmd = new Deno.Command("git", {
        args: ["http-backend"],
        env,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });

      const child = cmd.spawn();
      const writer = child.stdin.getWriter();
      if (body.length > 0) await writer.write(body);
      await writer.close();

      const { stdout, stderr, code } = await child.output();

      if (code !== 0) {
        const errText = new TextDecoder().decode(stderr);
        return new Response(`git http-backend error: ${errText}`, { status: 500 });
      }

      const CRLFCRLF = new TextEncoder().encode("\r\n\r\n");
      const headerEnd = indexOfBytes(stdout, CRLFCRLF);

      if (headerEnd === -1) {
        return new Response(stdout, {
          headers: { "content-type": "application/x-git-http-backend" },
        });
      }

      const headerBytes = stdout.slice(0, headerEnd);
      const bodyBytes = stdout.slice(headerEnd + 4);
      const headerText = new TextDecoder().decode(headerBytes);

      const responseHeaders = new Headers();
      let status = 200;
      for (const line of headerText.split("\r\n")) {
        if (!line) continue;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        if (key.toLowerCase() === "status") {
          status = parseInt(value.split(" ")[0]) || 200;
        } else {
          responseHeaders.set(key, value);
        }
      }

      return new Response(bodyBytes, { status, headers: responseHeaders });
    },
  );

  return { url, controller };
}

// -- tests --

Deno.test("integration: local-fs store -> deno resolves and runs package", async () => {
  const tmp = Deno.makeTempDirSync({ prefix: "int-pkg-" });
  const pkgDir = join(tmp, "@test", "hello", "1.0.0");
  await Deno.mkdir(pkgDir, { recursive: true });

  const files = makePackage("@test/hello", "1.0.0");
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(pkgDir, relPath);
    await Deno.mkdir(fullPath.substring(0, fullPath.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(fullPath, content);
  }

  const store = createLocalFsStore({ baseDir: tmp });
  const registry = startRegistry(store);

  const projectDir = Deno.makeTempDirSync({ prefix: "int-project-" });
  writeDenoJsonWithImport(projectDir, "@test/hello", registry.url, "1.0.0");
  await Deno.writeTextFile(join(projectDir, "main.ts"), `
import { hello, VERSION } from "@test/hello";
console.log(hello());
console.log("VERSION:", VERSION);
`);

  try {
    const result = await runDeno(
      ["run", "-A", "main.ts"],
      projectDir,
    );

    console.log("stdout:", result.stdout.slice(0, 500));
    if (result.code !== 0) console.log("stderr:", result.stderr.slice(0, 1000));
    assertEquals(result.code, 0, `deno run failed: ${result.stderr}`);
    assertStringIncludes(result.stdout, "Hello from @test/hello@1.0.0");
    assertStringIncludes(result.stdout, "VERSION: 1.0.0");
  } finally {
    stopServer(registry);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    await Deno.remove(projectDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration: git store file:// -> deno resolves and runs package", async () => {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const repo = await createGitRepo();
  try {
    const pkg = makePackage("@test/gitpkg", "2.0.0");
    await addPackageToGit(repo, "@test/gitpkg", "2.0.0", pkg);

    const store = createRemoteGitStore({ url: `file://${repo.bareDir}` });
    const registry = startRegistry(store);

    // Verify registry discovers the package
    const packages = await store.list();
    console.log("Registry packages:", JSON.stringify(packages));
    assertEquals(packages.length >= 1, true);
    const found = packages.find((p) => p.name === "@test/gitpkg");
    assertExists(found);
    assertEquals(found.versions.includes("2.0.0"), true);

    const projectDir = Deno.makeTempDirSync({ prefix: "int-gitproject-" });
    writeDenoJsonWithImport(projectDir, "@test/gitpkg", registry.url, "2.0.0");
    await Deno.writeTextFile(join(projectDir, "main.ts"), `
import { hello, VERSION } from "@test/gitpkg";
console.log(hello());
console.log("VERSION:", VERSION);
`);

    try {
      const result = await runDeno(
        ["run", "-A", "main.ts"],
        projectDir,
      );

      console.log("stdout:", result.stdout.slice(0, 500));
      if (result.code !== 0) console.log("stderr:", result.stderr.slice(0, 1000));
      assertEquals(result.code, 0, `deno run failed: ${result.stderr}`);
      assertStringIncludes(result.stdout, "Hello from @test/gitpkg@2.0.0");
      assertStringIncludes(result.stdout, "VERSION: 2.0.0");
    } finally {
      stopServer(registry);
      await Deno.remove(projectDir, { recursive: true }).catch(() => {});
    }
  } finally {
    cleanupGitRepo(repo);
  }
});

Deno.test("integration: git http-backend clone -> git store -> deno resolves package", async () => {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const repo = await createGitRepo();
  try {
    const pkg = makePackage("@test/httppkg", "1.0.0");
    await addPackageToGit(repo, "@test/httppkg", "1.0.0", pkg);

    const gitRoot = Deno.makeTempDirSync({ prefix: "int-http-" });
    const bareDest = join(gitRoot, "repo.git");
    await Deno.rename(repo.bareDir, bareDest);

    const gitServer = startGitHttpBackend(gitRoot);
    const gitUrl = `${gitServer.url}/repo.git`;

    // Verify git clone over HTTP works
    const cloneDir = Deno.makeTempDirSync({ prefix: "int-httpclone-" });
    try {
      const cloneCmd = new Deno.Command("git", {
        args: ["clone", gitUrl, cloneDir],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stderr } = await cloneCmd.output();
      if (code !== 0) console.log("clone stderr:", new TextDecoder().decode(stderr));
      assertEquals(code, 0, "git clone over HTTP should succeed");

      // List what was cloned
      const topFiles: string[] = [];
      for await (const e of Deno.readDir(cloneDir)) topFiles.push(e.name);
      console.log("Cloned top-level:", topFiles);
      assertEquals(topFiles.includes("@test"), true, "clone should contain @test directory");
    } finally {
      await Deno.remove(cloneDir, { recursive: true }).catch(() => {});
    }

    // Now use our git store against the HTTP URL
    const store = createRemoteGitStore({ url: gitUrl });
    const registry = startRegistry(store);

    const packages = await store.list();
    console.log("Registry packages:", JSON.stringify(packages));
    assertEquals(packages.length >= 1, true);
    const found = packages.find((p) => p.name === "@test/httppkg");
    assertExists(found, "Package should be discovered via HTTP git store");
    assertEquals(found.versions.includes("1.0.0"), true);

    const projectDir = Deno.makeTempDirSync({ prefix: "int-httpproject-" });
    writeDenoJsonWithImport(projectDir, "@test/httppkg", registry.url, "1.0.0");
    await Deno.writeTextFile(join(projectDir, "main.ts"), `
import { hello, VERSION } from "@test/httppkg";
console.log(hello());
console.log("VERSION:", VERSION);
`);

    try {
      const result = await runDeno(
        ["run", "-A", "main.ts"],
        projectDir,
      );

      console.log("stdout:", result.stdout.slice(0, 500));
      if (result.code !== 0) console.log("stderr:", result.stderr.slice(0, 1000));
      assertEquals(result.code, 0, `deno run failed: ${result.stderr}`);
      assertStringIncludes(result.stdout, "Hello from @test/httppkg@1.0.0");
      assertStringIncludes(result.stdout, "VERSION: 1.0.0");
    } finally {
      stopServer(registry);
      await Deno.remove(projectDir, { recursive: true }).catch(() => {});
    }

    gitServer.controller.abort();
    await Deno.remove(gitRoot, { recursive: true }).catch(() => {});
  } finally {
    cleanupGitRepo(repo);
  }
});

Deno.test("integration: self-host -- this repo via git store -> deno uses ABC package", async () => {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const tmp = Deno.makeTempDirSync({ prefix: "int-self-" });
  const bareDir = join(tmp, "repo.git");

  const cloneResult = await new Deno.Command("git", {
    args: ["clone", "--bare", REPO_ROOT, bareDir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (cloneResult.code !== 0) {
    console.log("git clone stderr:", new TextDecoder().decode(cloneResult.stderr));
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    return;
  }

  const runGit = async (args: string[]) => {
    const cmd = new Deno.Command("git", {
      args,
      cwd: bareDir,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) console.log(`git ${args[0]} stderr:`, new TextDecoder().decode(stderr));
    return new TextDecoder().decode(stdout);
  };

  await runGit(["tag", "v0.0.0"]);

  const store = createRemoteGitStore({ url: `file://${bareDir}` });
  const registry = startRegistry(store);

  const packages = await store.list();
  console.log("Discovered:", packages.map((p) => `${p.name} [${p.versions.join(", ")}]`).join(" | "));
  assertEquals(packages.length >= 1, true);

  const abcPkg = packages.find((p) => p.name === "@publicdomainrelay/hono-jsr-package-store-abc");
  assertExists(abcPkg, "ABC package should be discovered");
  const abcVersion = abcPkg.versions.find((v) => v === "0.0.0");
  assertExists(abcVersion, "ABC package should have version 0.0.0");

  const projectDir = Deno.makeTempDirSync({ prefix: "int-selfproject-" });
  writeDenoJsonWithImport(projectDir, "@publicdomainrelay/hono-jsr-package-store-abc", registry.url, abcVersion!);
  await Deno.writeTextFile(join(projectDir, "main.ts"), `
import type { PackageStore, PackageEntry, PackageVersion } from "@publicdomainrelay/hono-jsr-package-store-abc";

const store: PackageStore = {
  async list(): Promise<PackageEntry[]> { return []; },
  async get(_name: string, _version: string): Promise<PackageVersion | null> { return null; },
};

console.log("PackageStore type imported successfully");
console.log("list returns:", JSON.stringify(await store.list()));
`);

  try {
    const result = await runDeno(
      ["run", "-A", "main.ts"],
      projectDir,
    );

    console.log("stdout:", result.stdout.slice(0, 500));
    if (result.code !== 0) console.log("stderr:", result.stderr.slice(0, 2000));
    assertEquals(result.code, 0, `deno run failed: ${result.stderr}`);
    assertStringIncludes(result.stdout, "PackageStore type imported successfully");
    assertStringIncludes(result.stdout, "list returns: []");
  } finally {
    stopServer(registry);
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    await Deno.remove(projectDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("integration: full pipeline -- git http-backend -> registry -> deno resolves + runs", async () => {
  try {
    await new Deno.Command("git", { args: ["--version"], stdout: "null" }).output();
  } catch {
    console.log("SKIP: git not available");
    return;
  }

  const repo = await createGitRepo();
  try {
    const pkg = makePackage("@test/fullpipe", "3.0.0");
    await addPackageToGit(repo, "@test/fullpipe", "3.0.0", pkg);

    const gitRoot = Deno.makeTempDirSync({ prefix: "int-gitroot-" });
    const bareDest = join(gitRoot, "repo.git");
    await Deno.rename(repo.bareDir, bareDest);

    const gitServer = startGitHttpBackend(gitRoot);
    const gitUrl = `${gitServer.url}/repo.git`;

    // Verify git clone works
    const cloneDir = Deno.makeTempDirSync({ prefix: "int-pipeclone-" });
    try {
      const cloneResult = await new Deno.Command("git", {
        args: ["clone", gitUrl, cloneDir],
        stdout: "piped",
        stderr: "piped",
      }).output();
      if (cloneResult.code !== 0) console.log("Clone stderr:", new TextDecoder().decode(cloneResult.stderr));
      assertEquals(cloneResult.code, 0, "git clone over HTTP should succeed");
    } finally {
      await Deno.remove(cloneDir, { recursive: true }).catch(() => {});
    }

    // Registry reads from HTTP git
    const store = createRemoteGitStore({ url: gitUrl });
    const registry = startRegistry(store);

    const packages = await store.list();
    console.log("Registry packages:", JSON.stringify(packages));
    assertEquals(packages.length >= 1, true);
    const found = packages.find((p) => p.name === "@test/fullpipe");
    assertExists(found, "Package should be in registry");
    assertEquals(found.versions.includes("3.0.0"), true);

    // Deno resolves and runs
    const projectDir = Deno.makeTempDirSync({ prefix: "int-pipeproject-" });
    writeDenoJsonWithImport(projectDir, "@test/fullpipe", registry.url, "3.0.0");
    await Deno.writeTextFile(join(projectDir, "main.ts"), `
import { hello, VERSION } from "@test/fullpipe";
console.log(hello());
console.log("VERSION:", VERSION);
`);

    try {
      const result = await runDeno(
        ["run", "-A", "main.ts"],
        projectDir,
      );

      console.log("stdout:", result.stdout.slice(0, 500));
      if (result.code !== 0) console.log("stderr:", result.stderr.slice(0, 1000));
      assertEquals(result.code, 0, `deno run failed: ${result.stderr}`);
      assertStringIncludes(result.stdout, "Hello from @test/fullpipe@3.0.0");
      assertStringIncludes(result.stdout, "VERSION: 3.0.0");
    } finally {
      stopServer(registry);
      await Deno.remove(projectDir, { recursive: true }).catch(() => {});
    }

    gitServer.controller.abort();
    await Deno.remove(gitRoot, { recursive: true }).catch(() => {});
  } finally {
    cleanupGitRepo(repo);
  }
});
