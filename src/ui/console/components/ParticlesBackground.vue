<script setup lang="ts">
// Adapted from @vue-bits/Particles. See THIRD_PARTY_NOTICES.md for the license.
// Adds bounded rendering, reduced-motion handling and complete GPU/listener cleanup.
import { Camera, Geometry, Mesh, Program, Renderer } from "ogl";
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";

const container = useTemplateRef<HTMLDivElement>("container");
const rendering = ref<"static" | "webgl">("static");
const animating = ref(false);
let renderer: Renderer | undefined;
let camera: Camera | undefined;
let geometry: Geometry | undefined;
let program: Program | undefined;
let mesh: Mesh | undefined;
let observer: ResizeObserver | undefined;
let motion: MediaQueryList | undefined;
let frame = 0, lastTime = 0, elapsed = 0;
let lost = false;
const pointer = { x: 0, y: 0 };

const vertex = `
attribute vec3 position;
attribute vec4 random;
attribute vec3 color;
uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
uniform float uTime, uSpread, uBaseSize, uAspect;
varying vec3 vColor;
varying float vAlpha;
void main() {
    vec3 pos = position * uSpread;
    pos.x *= uAspect;
    pos.z = -abs(pos.z) * 6.0;
    vec4 mPos = modelMatrix * vec4(pos, 1.0);
    mPos.x += sin(uTime * random.z + 6.28 * random.w) * mix(0.1, 1.5, random.x);
    mPos.y += sin(uTime * random.y + 6.28 * random.x) * mix(0.1, 1.5, random.w);
    vec4 mvPos = viewMatrix * mPos;
    gl_PointSize = clamp(uBaseSize * (0.6 + random.x) / length(mvPos.xyz), 2.0, 12.0);
    gl_Position = projectionMatrix * mvPos;
    vColor = color;
    vAlpha = (0.6 + 0.3 * random.y) * (0.85 + 0.15 * sin(uTime + random.w * 6.28));
}`;
const fragment = `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
    float d = length(gl_PointCoord.xy - vec2(0.5));
    float glow = exp(-d * d * 18.0) * smoothstep(0.5, 0.35, d);
    gl_FragColor = vec4(vColor, glow * vAlpha);
}`;

function stop(): void {
    cancelAnimationFrame(frame); frame = 0; lastTime = 0; animating.value = false;
}
function resize(): void {
    if (!container.value || !renderer || !camera || lost) return;
    const { clientWidth: width, clientHeight: height } = container.value;
    if (!width || !height) return;
    // Bound framebuffer memory on high-density or ultrawide monitors as well.
    renderer.dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(3_000_000 / (width * height)));
    renderer.setSize(width, height);
    camera.perspective({ aspect: width / height });
    if (program) { program.uniforms.uAspect.value = width / height; program.uniforms.uBaseSize.value = 210 * renderer.dpr; }
}
function draw(time: number): void {
    frame = 0;
    if (!renderer || !mesh || !camera || !program || document.hidden || motion?.matches || lost) { stop(); return; }
    frame = requestAnimationFrame(draw);
    if (lastTime && time - lastTime < 1000 / 30) return;
    elapsed += lastTime ? Math.min(time - lastTime, 100) * 0.18 : 0;
    lastTime = time;
    program.uniforms.uTime.value = elapsed * 0.001;
    mesh.position.x += (-pointer.x * 0.4 - mesh.position.x) * 0.025;
    mesh.position.y += (-pointer.y * 0.3 - mesh.position.y) * 0.025;
    mesh.rotation.x = Math.sin(elapsed * 0.0002) * 0.08;
    mesh.rotation.y = Math.cos(elapsed * 0.0005) * 0.12;
    mesh.rotation.z = elapsed * 0.000035;
    renderer.render({ scene: mesh, camera });
}
function resume(): void {
    if (!renderer || lost || document.hidden || motion?.matches || frame) return;
    animating.value = true;
    frame = requestAnimationFrame(draw);
}
function onVisibility(): void { if (document.hidden) stop(); else resume(); }
function onPointer(event: PointerEvent): void {
    if (!renderer || event.pointerType === "touch") return;
    pointer.x = Math.max(-1, Math.min(1, event.clientX / window.innerWidth * 2 - 1));
    pointer.y = Math.max(-1, Math.min(1, 1 - event.clientY / window.innerHeight * 2));
}
function onContextLost(event: Event): void {
    event.preventDefault(); lost = true; stop(); rendering.value = "static";
}
function dispose(releaseContext = true): void {
    stop();
    const gl = renderer?.gl;
    gl?.canvas.removeEventListener("webglcontextlost", onContextLost);
    gl?.canvas.removeEventListener("webglcontextrestored", onContextRestored);
    // A lost context already invalidated these GPU objects, including after
    // restoration; deleting the stale handles would generate WebGL errors.
    if (!lost) { geometry?.remove(); program?.remove(); }
    gl?.canvas.remove();
    if (releaseContext) gl?.getExtension("WEBGL_lose_context")?.loseContext();
    renderer = undefined; camera = undefined; geometry = undefined; program = undefined; mesh = undefined;
    lost = false; rendering.value = "static";
}
function initialize(): void {
    if (!container.value || renderer || motion?.matches) return;
    try {
        renderer = new Renderer({ alpha: true, depth: false, antialias: false, preserveDrawingBuffer: true, dpr: Math.min(window.devicePixelRatio || 1, 1.5) });
        const gl = renderer.gl;
        container.value.appendChild(gl.canvas);
        gl.canvas.setAttribute("aria-hidden", "true");
        gl.clearColor(0, 0, 0, 0);
        camera = new Camera(gl, { fov: 18 }); camera.position.set(0, 0, 22);
        const count = window.innerWidth < 720 ? 150 : 700;
        const positions = new Float32Array(count * 3), randoms = new Float32Array(count * 4), colors = new Float32Array(count * 3);
        const style = getComputedStyle(document.documentElement);
        const palette = ["--accent-green", "--accent-cyan", "--text-primary"].map(token => {
            const color = style.getPropertyValue(token).trim().replace("#", "");
            const rgb = parseInt(color, 16);
            return [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
        });
        for (let i = 0; i < count; i++) {
            let x: number, y: number, z: number, length: number;
            do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; length = x * x + y * y + z * z; } while (!length || length > 1);
            const radius = Math.cbrt(Math.random());
            positions.set([x * radius, y * radius, z * radius], i * 3);
            randoms.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
            colors.set(palette[i % palette.length], i * 3);
        }
        geometry = new Geometry(gl, { position: { size: 3, data: positions }, random: { size: 4, data: randoms }, color: { size: 3, data: colors } });
        program = new Program(gl, { vertex, fragment, transparent: true, depthTest: false,
            uniforms: { uTime: { value: 0 }, uSpread: { value: 8 }, uBaseSize: { value: 210 * renderer.dpr }, uAspect: { value: 1 } } });
        if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) throw new Error("Particle shader unavailable");
        mesh = new Mesh(gl, { mode: gl.POINTS, geometry, program });
        gl.canvas.addEventListener("webglcontextlost", onContextLost);
        gl.canvas.addEventListener("webglcontextrestored", onContextRestored);
        resize(); rendering.value = "webgl"; resume();
    } catch { dispose(); }
}
function onContextRestored(): void { dispose(false); initialize(); }
function onMotion(): void { if (motion?.matches) dispose(); else initialize(); }

onMounted(() => {
    motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointermove", onPointer, { passive: true });
    observer = new ResizeObserver(resize);
    if (container.value) observer.observe(container.value);
    initialize();
});
onBeforeUnmount(() => {
    motion?.removeEventListener("change", onMotion);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointermove", onPointer);
    observer?.disconnect(); dispose();
});
</script>

<template>
    <div ref="container" class="console-particles" aria-hidden="true" :data-renderer="rendering" :data-animation="animating ? 'running' : 'paused'">
        <div class="particle-ambient-glow" />
        <div v-if="rendering === 'static'" class="particle-static-stars" />
    </div>
</template>
