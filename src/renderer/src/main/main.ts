import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { initPageIdStore } from '@renderer/composables/usePageRegistry'

// 加载 page-id-store.json 固化映射（弹窗 ID 跨会话稳定）；不阻塞首屏
void initPageIdStore()

createApp(App).use(ElementPlus).mount('#app')
