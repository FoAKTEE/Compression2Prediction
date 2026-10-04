import { createRouter, createWebHistory, type RouteRecordRaw, type RouterHistory } from "vue-router";
import Home from "../views/Home.vue";
import InteractionView from "../views/InteractionView.vue";
import NotFound from "../views/NotFound.vue";
import ProcessView from "../views/ProcessView.vue";
import ReportView from "../views/ReportView.vue";

export const routes: RouteRecordRaw[] = [
  { path: "/", name: "home", component: Home },
  { path: "/process/:projectId", name: "process", component: ProcessView, props: true },
  { path: "/report/:reportId", name: "report", component: ReportView, props: true },
  { path: "/interaction/:reportId", name: "interaction", component: InteractionView, props: true },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFound },
];

/** History mode by default; tests pass `createMemoryHistory()`. */
export function createAppRouter(history: RouterHistory = createWebHistory(import.meta.env.BASE_URL)) {
  return createRouter({
    history,
    routes,
    scrollBehavior: (_to, _from, savedPosition) => savedPosition ?? { top: 0 },
  });
}
