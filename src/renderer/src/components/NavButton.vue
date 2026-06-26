<template>
  <button
    class="nav-btn"
    :class="{ active: isActive, disabled: props.disabled }"
    :title="tooltip"
    @click="navigate"
  >
    <slot />
    <span class="nav-tooltip">{{ tooltip }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const props = defineProps<{ to: string; tooltip: string; disabled?: boolean }>()
const route = useRoute()
const router = useRouter()
const isActive = computed(() => route.path === props.to)
function navigate(): void {
  if (!props.disabled) router.push(props.to)
}
</script>

<style scoped>
.nav-btn.disabled { opacity: 0.4; cursor: not-allowed; }
</style>
