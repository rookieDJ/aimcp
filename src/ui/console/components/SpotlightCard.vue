<script setup lang="ts">
// Adapted from @vue-bits/SpotlightCard: use console CSS instead of Tailwind utilities.
// Registry: https://vue-bits.dev/r/SpotlightCard.json
// Vue Bits copyright and license: THIRD_PARTY_NOTICES.md.
import { ref, useTemplateRef } from "vue";

const { className = "", spotlightColor = "rgba(160, 255, 188, 0.06)" } = defineProps<{
    className?: string;
    spotlightColor?: string;
}>();
const card = useTemplateRef<HTMLDivElement>("card");
const position = ref({ x: 0, y: 0 });
const opacity = ref(0);
const focused = ref(false);
function handleMouseMove(event: MouseEvent): void {
    if (!card.value || focused.value) return;
    const rect = card.value.getBoundingClientRect();
    position.value = { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function handleFocus(): void { focused.value = true; opacity.value = 0.6; }
function handleBlur(event: FocusEvent): void {
    if (event.relatedTarget instanceof Node && card.value?.contains(event.relatedTarget)) return;
    focused.value = false;
    opacity.value = 0;
}
</script>

<template>
    <div ref="card" class="vue-bits-spotlight-card" :class="className" @mousemove="handleMouseMove" @mouseenter="opacity = 0.6" @mouseleave="opacity = focused ? 0.6 : 0" @focusin="handleFocus" @focusout="handleBlur">
        <div class="spotlight-overlay" aria-hidden="true" :style="{ opacity, background: `radial-gradient(circle at ${position.x}px ${position.y}px, ${spotlightColor}, transparent 80%)` }" />
        <div class="spotlight-inner"><slot /></div>
    </div>
</template>

<style scoped>
.vue-bits-spotlight-card { position: relative; min-width: 0; border: 1px solid var(--border-light); border-radius: var(--radius-lg); background: var(--bg-surface); overflow: hidden; }
.spotlight-overlay { position: absolute; inset: 0; pointer-events: none; transition: opacity .3s; }
.spotlight-inner { position: relative; height: 100%; min-width: 0; }
@media (prefers-reduced-motion: reduce) { .spotlight-overlay { transition: none; } }
</style>
