import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectProjectDisplayName } from "../dist/projects/identity.js";

test("project displayName overrides the npm package name", (t) => {
    const root = mkdtempSync(join(tmpdir(), "aimcp-project-name-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "@rookiedj/aimcp",
        displayName: "aimcp",
    }));

    assert.equal(detectProjectDisplayName(root), "aimcp");
});

test("project displayName falls back to package name when empty", (t) => {
    const root = mkdtempSync(join(tmpdir(), "aimcp-project-name-fallback-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "@example/tool",
        displayName: "  ",
    }));

    assert.equal(detectProjectDisplayName(root), "@example/tool");
});
