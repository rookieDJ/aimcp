import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const home = mkdtempSync(join(tmpdir(), "aimcp-tunnel-recovery-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { CloudflaredSidecar, cloudflaredRunArgs } = await import("../dist/tunnel/sidecar.js");

async function until(predicate, timeout = 4000) {
    const end = Date.now() + timeout;
    while (!predicate()) { if (Date.now() > end) assert.fail("recovery condition timed out"); await delay(10); }
}

async function fixture(source, run) {
    const previous = process.cwd();
    const dir = mkdtempSync(join(home, "connector-"));
    writeFileSync(join(dir, "tunnel"), source);
    process.chdir(dir);
    const states = [];
    const sidecar = new CloudflaredSidecar({ bin: process.execPath, tunnelId: "test", configPath: "unused", autoRecover: true, maxRestarts: 1, readyTimeoutMs: 500, healthIntervalMs: 20, disconnectGraceMs: 100, restartDelayMs: 20, restartMaxDelayMs: 40, recoveryCooldownMs: 50, stableResetMs: 100, onStateChange: value => states.push(value) });
    try { await run(sidecar, states, dir); }
    finally { await sidecar.stop(); process.chdir(previous); }
}

test("connector metrics are explicitly restricted to an ephemeral loopback port", () => {
    const args = cloudflaredRunArgs("test.yml", "test");
    assert.equal(args[args.indexOf("--metrics") + 1], "127.0.0.1:0");
});

test("a lost edge connection updates state and natural reconnection needs no process restart", async () => {
    await fixture("process.stdout.write('Registered tunnel connection connIndex=0 protocol=http2\\n');setTimeout(()=>process.stdout.write('Connection terminated connIndex=0\\n'),40);setTimeout(()=>process.stdout.write('Registered tunnel connection connIndex=0 protocol=http2\\n'),90);setInterval(()=>{},1000);", async (sidecar, states) => {
        await sidecar.start();
        await until(() => states.some(s => s.state === "degraded" && s.running));
        await until(() => states.filter(s => s.state === "connected").length >= 2);
        assert.equal(states.at(-1).restartCount, 0);
    });
});

test("losing one of several edge connections does not report a complete disconnection", async () => {
    await fixture("process.stdout.write('Registered tunnel connection connIndex=0\\nRegistered tunnel connection connIndex=1\\n');setTimeout(()=>process.stdout.write('Connection terminated connIndex=0\\n'),40);setInterval(()=>{},1000);", async (sidecar, states) => {
        await sidecar.start(); await delay(150);
        assert.equal(states.at(-1).state, "connected");
        assert.equal(states.at(-1).restartCount, 0);
    });
});

test("a live connector with zero ready connections is recovered even without disconnect logs", async () => {
    await fixture("const http=require('node:http'),fs=require('node:fs');let n=fs.existsSync('attempt')?Number(fs.readFileSync('attempt'))+1:1;fs.writeFileSync('attempt',String(n));let ready=true;const server=http.createServer((req,res)=>{res.writeHead(ready?200:503);res.end(JSON.stringify({readyConnections:ready?1:0}));});server.listen(0,'127.0.0.1',()=>{console.log('Starting metrics server on 127.0.0.1:'+server.address().port+'/metrics');console.log('Registered tunnel connection connIndex=0');if(n===1)setTimeout(()=>ready=false,40);});", async (sidecar, states, dir) => {
        await sidecar.start();
        await until(() => Number(readFileSync(join(dir, "attempt"))) >= 2);
        await until(() => states.at(-1)?.state === "connected" && states.at(-1).restartCount >= 1);
        await sidecar.stop();
        const count = readFileSync(join(dir, "attempt"), "utf8");
        await delay(160);
        assert.equal(readFileSync(join(dir, "attempt"), "utf8"), count);
        assert.equal(states.at(-1).state, "off");
    });
});

test("daemon recovery continues after a failed retry and burst limit, without rewriting config", async () => {
    await fixture("const fs=require('node:fs');const n=fs.existsSync('attempt')?Number(fs.readFileSync('attempt'))+1:1;fs.writeFileSync('attempt',String(n));if(n===2)process.exit(1);console.log('Registered tunnel connection connIndex=0');if(n<4)setTimeout(()=>process.exit(1),40);else setInterval(()=>{},1000);", async (sidecar, states, dir) => {
        await sidecar.start();
        await until(() => existsSync(join(dir, "attempt")) && Number(readFileSync(join(dir, "attempt"))) >= 4);
        await until(() => states.at(-1)?.state === "connected");
        assert.equal(states.at(-1).restartCount, 3);
        assert.equal(existsSync(join(dir, "unused")), false);
    });
});

test("explicit stop cancels a pending delayed recovery", async () => {
    await fixture("console.log('Registered tunnel connection connIndex=0');setTimeout(()=>process.exit(1),40);", async (sidecar, states) => {
        await sidecar.start();
        await until(() => states.at(-1)?.state === "degraded");
        await sidecar.stop();
        const length = states.length;
        await delay(150);
        assert.equal(states.length, length);
        assert.equal(states.at(-1).state, "off");
    });
});

test("concurrent explicit recovery owns one new connector and stop cancels in-flight readiness", async () => {
    await fixture("const fs=require('node:fs');const n=fs.existsSync('attempt')?Number(fs.readFileSync('attempt'))+1:1;fs.writeFileSync('attempt',String(n));setTimeout(()=>console.log('Registered tunnel connection connIndex=0'),70);setInterval(()=>{},1000);", async (sidecar, states, dir) => {
        await sidecar.start();
        await Promise.all([sidecar.restart(), sidecar.restart()]);
        assert.equal(Number(readFileSync(join(dir, "attempt"))), 2);
        const recovering = sidecar.restart();
        const cancelled = assert.rejects(recovering, /取消|停止/);
        await until(() => states.at(-1)?.state === "starting");
        await sidecar.stop();
        await cancelled;
        const count = Number(readFileSync(join(dir, "attempt")));
        await delay(150);
        assert.equal(Number(readFileSync(join(dir, "attempt"))), count);
        assert.equal(states.at(-1).state, "off");
    });
});

test("failed explicit recovery resumes daemon retries instead of leaving recovery disabled", async () => {
    await fixture("const fs=require('node:fs');const n=fs.existsSync('attempt')?Number(fs.readFileSync('attempt'))+1:1;fs.writeFileSync('attempt',String(n));if(n===2)process.exit(1);console.log('Registered tunnel connection connIndex=0');setInterval(()=>{},1000);", async (sidecar, states, dir) => {
        await sidecar.start();
        await assert.rejects(sidecar.restart(), /退出/);
        await until(() => Number(readFileSync(join(dir, "attempt"))) === 3 && states.at(-1)?.state === "connected");
    });
});
