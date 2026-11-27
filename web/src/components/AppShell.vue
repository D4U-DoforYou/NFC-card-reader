<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BlePill from '@/components/BlePill.vue'
import siteLogo from '@/assets/startup-icon.png'

/**
 * 桌面工作台外壳。
 *
 * 左侧是常驻导航（品牌 + 功能入口 + 蓝牙状态），右侧是内容区。
 * 只在 PC 上用，所以导航栏一直竖着占一列，不做移动端抽屉。
 */
const route = useRoute()
const router = useRouter()

interface NavItem {
  key: string
  to: string
  title: string
  sub: string
  icon: string
}

/**
 * 侧栏一级入口。
 *
 * 只列真正的工作模式。画板和火车票是「墨水屏刷图」下面的子工具，
 * 跟小程序一致，从墨水屏页里的「图片制作」面板进入，不占一级导航。
 */
const items: NavItem[] = [
  {
    key: 'index',
    to: '/',
    title: '首页',
    sub: 'WORKSPACE',
    icon: 'M4 11.5 12 4l8 7.5M6.5 10v9.5h11V10',
  },
  {
    key: 'connect',
    to: '/connect',
    title: '连接设备',
    sub: 'BLUETOOTH / USB',
    icon: 'M8.5 8.5a5 5 0 0 1 7 0M5.5 5.5a9 9 0 0 1 12 0M12 12.5v3.5',
  },
  {
    key: 'eink',
    to: '/eink',
    title: '墨水屏刷图',
    sub: 'E-PAPER',
    icon: 'M6 4h12v16H6zM9 8h6M9 11.5h6M9 15h4',
  },
  {
    key: 'nfc',
    to: '/nfc',
    title: '通用 NFC',
    sub: 'NFC WORKBENCH',
    icon: 'M4 8.5h16v8H4zM7.5 8.5v8M11 8.5v8',
  },
  { key: 'info', to: '/info', title: 'INFO', sub: 'ABOUT', icon: 'M12 11v6M12 7v1' },
]

/**
 * 当前高亮的一级入口。
 *
 * 画板与火车票归到「墨水屏刷图」下，所以在这两个页面上侧栏也高亮墨水屏。
 */
const activeKey = computed(() => {
  const path = route.path
  if (path === '/') {
    return 'index'
  }
  if (path.startsWith('/info')) return 'info'
  if (path.startsWith('/connect')) {
    return 'connect'
  }
  if (path.startsWith('/nfc')) {
    return 'nfc'
  }
  if (path.startsWith('/eink') || path.startsWith('/draw') || path.startsWith('/ticket')) {
    return 'eink'
  }
  return 'index'
})
</script>

<template>
  <div class="app-frame">
    <aside class="sidebar">
      <div class="side-brand">
        <img class="brand-mark" :src="siteLogo" alt="D4U NFC Tools" />
        <div class="brand-text">
          <div class="brand-name">D4U<span> · NFC Tools</span></div>
          <div class="brand-sub">DO FOR YOU</div>
        </div>
      </div>

      <nav class="side-nav" aria-label="主导航">
        <RouterLink
          v-for="item in items"
          :key="item.key"
          :data-section="item.key"
          :to="item.to"
          class="side-item"
          :class="{ active: activeKey === item.key }"
        >
          <span class="side-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path :d="item.icon" />
            </svg>
          </span>
          <span class="side-text">
            <span class="side-title">{{ item.title }}</span>
            <span class="side-sub">{{ item.sub }}</span>
          </span>
        </RouterLink>
      </nav>

      <div class="side-foot">
        <BlePill @click="router.push('/connect')" />
        <div class="side-hint">PC 工作台 · 蓝牙 / USB</div>
      </div>
    </aside>

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
  </div>
</template>

<style scoped>
.side-brand { display: flex; align-items: center; gap: 10px; padding: 26px 20px 34px; }
.brand-mark { display: block; width: 34px; height: 34px; flex: none; border-radius: 9px; object-fit: cover; }
.brand-sub, .side-icon, .side-sub, .side-hint { display: none; }
.brand-name { font-size: 15px; font-weight: 650; letter-spacing: -.6px; white-space: nowrap; }
.brand-name span { font-size: 12px; font-weight: 400; letter-spacing: -.2px; color: var(--ink-70); }
.side-nav { display: flex; flex-direction: column; gap: 6px; flex: 1; padding: 0 16px; }
.side-item { display: block; padding: 9px 12px; border-radius: 10px; color: #888; text-decoration: none; font-size: 12px; line-height: 1.5; transition: background .2s, color .2s; }
.side-item:hover { color: #333; background: #eeeee9; }
.side-item.active { color: #486252; background: #e8eee8; }
.side-item[data-section="nfc"].active { color: #506a88; background: #e8edf4; }
.side-item[data-section="info"].active { color: #94745c; background: #f2eae3; }
.side-item.active .side-title { font-weight: 500; }
.side-foot { padding: 24px 22px; }
.side-foot :deep(.ble-pill) { width: 100%; height: auto; padding: 12px 0; border: 0; border-top: 1px solid var(--line); background: transparent; gap: 6px; border-radius: 0; }
.side-foot :deep(.ble-label) { font-size: 11px; max-width: none; flex: 1; text-align: left; }
.side-foot :deep(.connection-icon) { width: 13px; height: 13px; }
.side-foot :deep(.ble-chevron) { font-size: 15px; }
</style>
