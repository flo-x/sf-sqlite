import { createRouter, createWebHashHistory } from 'vue-router'
import ConnectionsView from './views/ConnectionsView.vue'
import JobsView from './views/JobsView.vue'
import ExplorerView from './views/ExplorerView.vue'
import QueryView from './views/QueryView.vue'
import ScriptsView from './views/ScriptsView.vue'
import SettingsView from './views/SettingsView.vue'
import SpreadsheetsView from './views/SpreadsheetsView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/connections' },
    { path: '/connections', component: ConnectionsView },
    { path: '/jobs', component: JobsView },
    { path: '/extract', redirect: '/jobs' },
    { path: '/writeback', redirect: '/jobs' },
    { path: '/explorer', component: ExplorerView },
    { path: '/query', component: QueryView },
    { path: '/scripts', component: ScriptsView },
    { path: '/spreadsheets', component: SpreadsheetsView },
    { path: '/settings', component: SettingsView }
  ]
})
