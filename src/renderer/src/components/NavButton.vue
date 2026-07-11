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
  top: 4px;
  right: 4px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #f97316;
  box-shadow: 0 0 6px 2px #f97316aa;
  animation: nav-pulse 0.75s ease-in-out infinite;
}

@keyframes nav-pulse {
  0%, 100% { opacity: 1; transform: scale(1);    box-shadow: 0 0 6px 2px #f97316aa; }
  50%       { opacity: 0.7; transform: scale(1.25); box-shadow: 0 0 10px 4px #f97316cc; }
}
</style>
