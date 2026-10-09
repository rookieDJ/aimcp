import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from "jsonc-parser";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";

const DEFAULT_THRESHOLD = 0.5;
const settingsDirectory = (): string => join(homedir(), ".gemini");
const settingsPath = (): string => join(settingsDirectory(), "settings.json");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const owned = (uid: number): boolean => !process.getuid || uid === process.getuid();

function checkDirectory(): void {
    try {
        const info = lstatSync(settingsDirectory());
        if (!info.isDirectory() || info.isSymbolicLink() || !owned(info.uid)) throw new Error("unsafe");
    } catch (error) {
        if (!missing(error)) throw new Error("Gemini 配置目录必须是当前用户拥有的真实目录，不能使用链接。");
    }
}

function readSettings(): { text: string; revision: string; threshold?: number } {
    checkDirectory();
    let text = "";
    let exists = false;
    let fd: number | undefined;
    try {
        const info = lstatSync(settingsPath());
        if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || info.nlink !== 1) throw new Error("unsafe");
        fd = openSync(settingsPath(), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const actual = fstatSync(fd);
        if (actual.ino !== info.ino || actual.dev !== info.dev || !owned(actual.uid) || actual.size > 1024 * 1024) throw new Error("unsafe");
        text = readFileSync(fd, "utf8");
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("oversized");
        exists = true;
    } catch (error) {
        if (!missing(error)) throw new Error("Gemini 配置无法安全读取，请检查文件类型、所有权及大小（最多 1 MB）。");
    } finally { if (fd !== undefined) closeSync(fd); }
    const errors: ParseError[] = [];
    const tree = parseTree(exists ? text : "{}", errors, { allowTrailingComma: true, disallowComments: false });
    const nodes: Node[] = tree ? [tree] : [];
    let duplicate = false;
    while (nodes.length) {
        const node = nodes.pop()!;
        if (node.type === "object") {
            const keys = new Set<string>();
            for (const property of node.children ?? []) {
                const key = property.children?.[0]?.value as string;
                if (keys.has(key)) duplicate = true;
                keys.add(key);
            }
        }
        nodes.push(...(node.children ?? []));
    }
    if (duplicate) throw new Error("Gemini settings.json 存在重复字段，请先修复原文件；aimcp 不会覆盖它。");
    const config: unknown = tree ? getNodeValue(tree) : undefined;
    if (errors.length || !config || typeof config !== "object" || Array.isArray(config)) throw new Error("Gemini settings.json 格式无效，请先修复原文件；aimcp 不会覆盖它。");
    const model = (config as Record<string, unknown>).model;
    if (model !== undefined && (!model || typeof model !== "object" || Array.isArray(model))) throw new Error("Gemini model 配置必须是对象，请先修复原文件。");
    const threshold = (model as Record<string, unknown> | undefined)?.compressionThreshold;
    if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)) throw new Error("Gemini 压缩阈值无效，必须大于 0 且不超过 1。");
    return { text: exists ? text : "{}\n", revision: createHash("sha256").update(exists ? `file:${text}` : "missing").digest("hex"), threshold: threshold as number | undefined };
}

/** User-level setting only: never expose other settings (which may contain secrets). */
export function inspectGeminiCompression() {
    const settings = readSettings();
    return { threshold: settings.threshold ?? DEFAULT_THRESHOLD, source: settings.threshold === undefined ? "default" as const : "user" as const,
        revision: settings.revision, requiresRestart: true as const };
}

export function configureGeminiCompression(input: { threshold: number | null; revision: string }) {
    if (!/^[a-f0-9]{64}$/.test(input.revision ?? "")) throw new Error("请先读取 Gemini 配置后再保存。");
    if (input.threshold !== null && (typeof input.threshold !== "number" || !Number.isFinite(input.threshold) || input.threshold < 0.1 || input.threshold > 0.9)) throw new Error("压缩阈值应在 10% 到 90% 之间。");
    const settings = readSettings();
    if (settings.revision !== input.revision) throw new Error("Gemini 配置已被其他程序修改，请刷新后重新保存；你的编辑尚未写入。");
    const edits = modify(settings.text, ["model", "compressionThreshold"], input.threshold ?? undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } });
    const next = applyEdits(settings.text, edits);
    // Synchronous compare/write: preserve unrelated settings and JSONC comments.
    mkdirSync(settingsDirectory(), { recursive: true, mode: 0o700 });
    checkDirectory();
    if (readSettings().revision !== settings.revision) throw new Error("Gemini 配置已变化，请刷新后重试。");
    writePrivateFileAtomic(settingsPath(), next);
    return inspectGeminiCompression();
}
