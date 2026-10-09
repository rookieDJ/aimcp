import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadControllerState, CONTROLLER_API_VERSION } from "../control/state.js";
import { LocalControllerClient } from "../control/control.js";
import { loadDaemonState } from "../daemon/state.js";
import { DaemonControlClient, DAEMON_STOP_TIMEOUT_MS } from "../daemon/control.js";

/** Allow an upgraded CLI to stop the verified legacy installation before migration. */
export async function stopLegacyInstallation(command: string): Promise<boolean> {
    if (command !== "stop" && command !== "shutdown") return false;
    const directory = join(homedir(), ".codex-mcp");
    const target = join(homedir(), ".ai-mcp");
    if (!existsSync(directory)) return false;
    assertOwned(directory, true);
    if (existsSync(target)) {
        assertOwned(target, true);
        if (readdirSync(target).some(name => name !== "npm" && name !== "bin")) return false;
    }
    for (const name of ["controller.json", "daemon.json"]) if (existsSync(join(directory, name))) assertOwned(join(directory, name), false);
    const controller = loadControllerState(directory);
    const daemon = loadDaemonState(directory);
    let handled = false;
    if (controller && alive(controller.pid)) {
        const client = new LocalControllerClient(controller);
        const status = await client.status();
        if (status.pid !== controller.pid || status.apiVersion !== CONTROLLER_API_VERSION) throw new Error("旧版 Controller 身份不一致，已取消停止操作。");
        if (command === "shutdown") { await client.shutdown(); await waitForExit(controller.pid); }
        else await client.stop();
        handled = true;
    }
    if (daemon && alive(daemon.pid)) {
        const client = new DaemonControlClient(daemon.port, daemon.controlToken, 10_000, daemon.host);
        const status = await client.status();
        if (status.pid !== daemon.pid) throw new Error("旧版 Runtime 身份不一致，已取消停止操作。");
        await client.shutdown(); await waitForExit(daemon.pid); handled = true;
    }
    return handled;
}
function assertOwned(path: string, directory: boolean): void {
    const stat = lstatSync(path);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || (process.getuid && stat.uid !== process.getuid())) throw new Error("旧版保存目录必须是当前用户拥有的真实目录和普通文件。");
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
async function waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + DAEMON_STOP_TIMEOUT_MS;
    while (alive(pid)) {
        if (Date.now() >= deadline) throw new Error("旧版进程尚未退出；保存目录未迁移，请稍后重试。");
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}
