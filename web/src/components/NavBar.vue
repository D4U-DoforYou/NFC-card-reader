<script setup lang="ts">
import { useRouter } from 'vue-router'

/**
 * 页头。
 *
 * 网页版左侧已经有常驻导航，这里只负责给当前页面一个标题，
 * 外加可选的返回键与右侧插槽（传输方式切换、蓝牙状态等）。
 */
const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    /** 显示返回按钮。 */
    back?: boolean
    /**
     * 没有浏览历史可退时回到哪里。
     * 画板、火车票是墨水屏刷图下的子工具，回退目标应该是墨水屏页。
     */
    fallback?: string
  }>(),
  { subtitle: '', back: true, fallback: '/' },
)

const router = useRouter()

function goBack(): void {
  if (window.history.length > 1) {
    router.back()
  } else {
    router.replace(props.fallback)
  }
}
</script>

<template>
  <header class="navbar">
    <div class="navbar-row" :class="{ tight: !subtitle }">
      <button v-if="back" class="nav-back" aria-label="返回" @click="goBack">‹</button>
      <div class="nav-text">
        <div class="nav-title">{{ title }}</div>
        <div v-if="subtitle" class="nav-sub">{{ subtitle }}</div>
      </div>
      <div class="nav-spacer" />
      <slot name="right" />
    </div>
  </header>
</template>

<style scoped>
.nav-text {
  min-width: 0;
}

.nav-title {
  font-size: 24px;
  font-weight: 400;
  line-height: 1.25;
  letter-spacing: -0.4px;
}

.nav-sub {
  font-size: 10px;
  color: var(--ink-45);
  letter-spacing: .5px;
  margin-top: 2px;
}
</style>
