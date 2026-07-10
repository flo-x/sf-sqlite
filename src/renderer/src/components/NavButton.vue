<template>
  <button
    class="nav-btn"
    :class="{ active: isActive, disabled: props.disabled }"
    :title="tooltip"
    @click="navigate"
  >
    <slot />
    <span class="nav-tooltip">{{ tooltip }}</span>
    <span v-if="running" class="nav-running-dot" />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const props = defineProps<{ to: string; tooltip: string; disabled?: boolean; running?: boolean }>()
const route = useRoute()
const router = useRouter()
const isActive = computed(() => route.path === props.to)
function navigate(): void {
  if (!props.disabled) router.push(props.to)
}
</script>

<style scoped>
.nav-btn.disabled { opacity: 0.4; cursor: not-allowed; }

.nav-btn { position: relative; }

.nav-running-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary, #2563eb);
  animation: nav-pulse 1.2s ease-in-out infinite;
}

@keyframes nav-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.45; transform: scale(0.7); }
}
</style>
