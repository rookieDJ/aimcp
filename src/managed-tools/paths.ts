import { getUserConfigDir } from "../config/user-config.js";
import { join } from "node:path";

export type ManagedToolName = "ripgrep" | "cloudflared";

export function getManagedBinDir(): string {
    return join(getUserConfigDir(), "bin");
}

export function getManagedToolPath(tool: ManagedToolName): string {
    const base = tool === "ripgrep" ? "rg" : "cloudflared";
    const fileName = process.platform === "win32" ? `${base}.exe` : base;
    return join(getManagedBinDir(), fileName);
}
