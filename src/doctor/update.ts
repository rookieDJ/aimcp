import { spawn } from "node:child_process";
import { printInfo } from "../lib/util/terminal.js";
import { terminateChildProcess } from "../lib/process/tree.js";

export interface UpdateNpmInvocation {
    file: string;
    args: string[];
}

export function getUpdateNpmInvocation(
    platform: NodeJS.Platform = process.platform,
): UpdateNpmInvocation {
    return {
        file: platform === "win32" ? "npm.cmd" : "npm",
        args: ["install", "--global", "@rookiedj/aimcp@latest"],
    };
}

export interface SelfUpdateOptions {
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
}

export async function runSelfUpdate(options: SelfUpdateOptions = {}): Promise<void> {
    const invocation = getUpdateNpmInvocation();
    options.signal?.throwIfAborted();
    printInfo("正在通过 npm 检查并安装最新版 aimcp…");
    const exitCode = await runNpm(invocation, options);
    if (exitCode !== 0) {
        throw new Error(`更新没有完成（退出码 ${exitCode}）`);
    }
}

async function runNpm(invocation: UpdateNpmInvocation, options: SelfUpdateOptions): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const captureOutput = options.onOutput !== undefined;
        const child = spawn(invocation.file, invocation.args, {
            env: {
                ...process.env,
                AIMCP_UPDATE: "1",
                CODEX_MCP_UPDATE: "1",
            },
            stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
            windowsHide: false,
            shell: process.platform === "win32",
        });
        let settled = false;
        const finishReject = (error: unknown): void => {
            if (settled) return;
            settled = true;
            reject(error);
        };
        const onAbort = (): void => {
            void terminateChildProcess(child, 5_000, 2_000).finally(() => {
                finishReject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("更新已取消"));
            });
        };
        if (captureOutput) {
            child.stdout?.on("data", (chunk) => options.onOutput?.(chunk.toString()));
            child.stderr?.on("data", (chunk) => options.onOutput?.(chunk.toString()));
        }
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
        child.once("error", finishReject);
        child.once("close", (code) => {
            options.signal?.removeEventListener("abort", onAbort);
            if (settled) return;
            settled = true;
            resolve(code ?? 1);
        });
    });
}
