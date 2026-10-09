import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTarball } from "./check-package.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageVersion = packageMetadata.version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const scratch = mkdtempSync(join(tmpdir(), "aimcp-package-smoke-"));
const home = join(scratch, "home");
const installRoot = join(scratch, "install");
const project = join(scratch, "project");
const packDir = join(scratch, "pack");
const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: join(scratch, "npm-cache"),
};

mkdirSync(join(home, ".ai-mcp"), { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(packDir, { recursive: true });
writeFileSync(
    join(home, ".ai-mcp", "config.json"),
    JSON.stringify({
        port: 0,
        capabilities: {
            sources: {
                codex: { enabled: false },
                agents: { enabled: false },
                claude: { enabled: false },
            },
        },
    }),
);

function run(file, args, options = {}) {
    try {
        return execFileSync(file, args, {
            cwd: options.cwd ?? root,
            env,
            encoding: "utf8",
            stdio: "pipe",
            timeout: options.timeout ?? 180_000,
            shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file),
        });
    } catch (error) {
        const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
        throw new Error(`${file} ${args.join(" ")} failed\n${output}`, { cause: error });
    }
}

function buildTarball() {
    const output = run(npm, ["pack", "--json", "--pack-destination", packDir]);
    const packed = JSON.parse(output);
    if (!Array.isArray(packed) || typeof packed[0]?.filename !== "string") {
        throw new Error(`npm pack returned an unexpected payload: ${output}`);
    }
    return join(packDir, packed[0].filename);
}

const tarball = process.argv[2] ? resolve(process.argv[2]) : buildTarball();
if (!existsSync(tarball)) throw new Error(`package tarball does not exist: ${tarball}`);
await checkTarball(tarball);

run(npm, ["install", "--global", "--prefix", installRoot, tarball, "--omit=dev", "--registry=https://registry.npmjs.org"]);
const globalModules = process.platform === "win32"
    ? join(installRoot, "node_modules")
    : join(installRoot, "lib", "node_modules");
const cli = join(globalModules, ...packageMetadata.name.split("/"), "dist", "cli.js");
const binShim = process.platform === "win32"
    ? join(installRoot, "aimcp.cmd")
    : join(installRoot, "bin", "aimcp");
assert.equal(existsSync(cli), true, `packaged CLI is missing: ${cli}`);
assert.equal(existsSync(binShim), true, `npm bin shim is missing: ${binShim}`);
assert.equal(run(binShim, ["--version"], { cwd: project }).trim(), packageVersion);

let started = false;
try {
    run(binShim, ["start", "--local"], { cwd: project });
    started = true;
    const status = JSON.parse(run(binShim, ["status", "--json"], { cwd: project }));
    assert.equal(status.running, true);
    assert.equal(status.daemon.mode, "local");
    assert.equal(status.daemon.controlApiVersion, 1);
    assert.match(status.daemon.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.match(status.controller.panelUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(status.projects.length, 1);
    assert.equal(status.projects[0].active, true);
    run(binShim, ["stop"], { cwd: project });
    started = false;
    const stopped = JSON.parse(run(binShim, ["status", "--json"], { cwd: project }));
    assert.equal(stopped.running, false);
    assert.equal(existsSync(join(home, ".ai-mcp", "daemon.json")), false);
    assert.equal(stopped.controller.pid, status.controller.pid);
    const panel = await fetch(stopped.controller.panelUrl);
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /aimcp 本机工作区/);
    const consoleScript = await fetch(new URL("/console/app.js", stopped.controller.panelUrl));
    const consoleStyle = await fetch(new URL("/console/app.css", stopped.controller.panelUrl));
    assert.equal(consoleScript.status, 200);
    assert.equal(consoleStyle.status, 200);
    assert.match(consoleScript.headers.get("content-type") ?? "", /javascript/);
    assert.match(consoleStyle.headers.get("content-type") ?? "", /text\/css/);
    const controllerStatePath = join(home, ".ai-mcp", "controller.json");
    const controllerState = JSON.parse(readFileSync(controllerStatePath, "utf8"));
    const shutdown = await fetch(`http://127.0.0.1:${controllerState.port}/api/controller/shutdown`, {
        method: "POST",
        headers: { "x-codex-controller-token": controllerState.controlToken },
    });
    assert.equal(shutdown.status, 200);
    const deadline = Date.now() + 10_000;
    while (existsSync(controllerStatePath) && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.equal(existsSync(controllerStatePath), false, "Controller state should be removed after explicit smoke cleanup");
    process.stdout.write(`package_smoke=PASS version=${packageVersion}\n`);
} finally {
    if (started) {
        try { run(binShim, ["stop"], { cwd: project, timeout: 30_000 }); }
        catch { /* best-effort cleanup for a failed smoke */ }
    }
    const controllerStatePath = join(home, ".ai-mcp", "controller.json");
    if (existsSync(controllerStatePath)) {
        try {
            const controllerState = JSON.parse(readFileSync(controllerStatePath, "utf8"));
            await fetch(`http://127.0.0.1:${controllerState.port}/api/controller/shutdown`, {
                method: "POST",
                headers: { "x-codex-controller-token": controllerState.controlToken },
            });
        } catch { /* best-effort cleanup for a failed smoke */ }
    }
    if (process.env.CODEX_MCP_KEEP_PACKAGE_SMOKE !== "1") {
        rmSync(scratch, { recursive: true, force: true });
    } else {
        process.stdout.write(`package_smoke_dir=${scratch}\n`);
    }
}
