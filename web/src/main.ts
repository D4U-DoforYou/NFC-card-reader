import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import './styles/tokens.css'
import './styles/components.css'
import './styles/minimal.css'
import { installTransport } from './platform'
import { appStore } from './core/store/index'

// 先装好传输层，再挂载界面：界面一上来就能读到正确的连接状态。
installTransport()

appStore.log('info', 'D4U · 为你而做，工作台已启动')

createApp(App).use(router).mount('#app')
