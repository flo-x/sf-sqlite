import { createRouter, createWebHashHistory } from 'vue-router'
import ConnectionsView from './views/ConnectionsView.vue'
import ExtractView from './views/ExtractView.vue'
import WritebackView from './views/WritebackView.vue'
import ExplorerView from './views/ExplorerView.vue'
import QueryView from './views/QueryView.vue'
import ScriptsView from './views/ScriptsView.vue'
import SettingsView from './views/SettingsView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/connections' },
    { path: '/connections', component: ConnectionsView },
    { path: '/extract', component: ExtractView },
    { path: '/writeback', component: WritebackView },
    { path: '/explorer', component: ExplorerView },
    { path: '/query', component: QueryView },
    { path: '/scripts', component: ScriptsView },
    { path: '/settings', component: SettingsView }
  ]
})
