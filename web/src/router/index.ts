import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * 路由。
 *
 * 用 hash 模式：静态托管（甚至直接打开文件）都不用配服务端重写，
 * 正好符合「不要后端」的要求。
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'index', component: () => import('@/views/HomeView.vue') },
    { path: '/info', name: 'info', component: () => import('@/views/InfoView.vue') },
    { path: '/connect', name: 'connect', component: () => import('@/views/ConnectView.vue') },
    { path: '/eink', name: 'eink', component: () => import('@/views/EinkView.vue') },
    { path: '/nfc', name: 'nfc', component: () => import('@/views/NfcView.vue') },
    { path: '/draw', name: 'draw', component: () => import('@/views/DrawView.vue') },
    { path: '/ticket', name: 'ticket', component: () => import('@/views/TicketView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})
