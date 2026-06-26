import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './assets/styles.css'
import { setupMonacoEnvironment } from './utils/monaco'

setupMonacoEnvironment()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
