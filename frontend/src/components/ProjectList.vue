<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ProjectSummary } from "../api/types";
import { errorNotice } from "../composables/errorNotice";
import { htmlLang, isLocale } from "../i18n";
import { padStep } from "../process/steps";
import ProjectHistory from "./ProjectHistory.vue";
import StateNotice from "./StateNotice.vue";

const props = defineProps<{
  projects: ProjectSummary[];
  loading: boolean;
  /** The last load failure, or `null`. */
  error: unknown;
}>();

const emit = defineEmits<{ retry: [] }>();
const { t, te, locale } = useI18n();

/** Projects whose run and report history is expanded. */
const expanded = ref<Set<string>>(new Set());

function toggle(projectId: string): void {
  const next = new Set(expanded.value);
  if (next.has(projectId)) next.delete(projectId);
  else next.add(projectId);
  expanded.value = next;
}

const notice = computed(() => (props.error === null || props.error === undefined ? null : errorNotice(props.error, t)));

function statusLabel(status: string): string {
  const key = `home.projects.status.${status}`;
  return te(key) ? t(key) : status;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const tag = isLocale(locale.value) ? htmlLang(locale.value) : undefined;
  return new Intl.DateTimeFormat(tag, { dateStyle: "medium" }).format(date);
}
</script>

<template>
  <div class="project-list" :aria-busy="loading ? 'true' : 'false'">
    <StateNotice
      v-if="notice"
      data-testid="projects-error"
      :variant="notice.variant"
      :title="notice.title"
      :body="notice.body"
      :action-label="t('common.retry')"
      @action="emit('retry')"
    />
    <StateNotice
      v-else-if="loading && projects.length === 0"
      compact
      variant="loading"
      data-testid="projects-loading"
      :title="t('common.loading')"
    />
    <StateNotice
      v-else-if="projects.length === 0"
      variant="empty"
      data-testid="projects-empty"
      :title="t('home.projects.empty.title')"
      :body="t('home.projects.empty.body')"
    />

    <ol v-if="projects.length" class="project-list__items">
      <li v-for="(project, index) in projects" :key="project.project_id" class="project-row" data-testid="project-row">
        <RouterLink class="project-row__link" :to="{ name: 'process', params: { projectId: project.project_id } }">
          <span class="project-row__index mono" aria-hidden="true">{{ padStep(index + 1) }}</span>
          <span class="project-row__main">
            <span class="project-row__name">{{ project.name }}</span>
            <span class="project-row__question">{{ project.prediction_question }}</span>
          </span>
          <span class="project-row__meta">
            <span class="badge">{{ statusLabel(project.status) }}</span>
            <span class="project-row__date mono">
              {{ t("home.projects.createdOn", { date: formatDate(project.created_at) }) }}
            </span>
          </span>
        </RouterLink>
        <button
          type="button"
          class="btn btn--quiet project-row__toggle"
          data-testid="toggle-history"
          :aria-expanded="expanded.has(project.project_id)"
          :aria-controls="`history-${project.project_id}`"
          @click="toggle(project.project_id)"
        >
          <span aria-hidden="true">{{ expanded.has(project.project_id) ? "−" : "+" }}</span>
          {{ expanded.has(project.project_id) ? t("history.hide") : t("history.show") }}
          <span class="sr-only">({{ project.name }})</span>
        </button>
        <div v-if="expanded.has(project.project_id)" :id="`history-${project.project_id}`">
          <ProjectHistory :project-id="project.project_id" />
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.project-list {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

.project-list__items {
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.project-row {
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
}

.project-row__link {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--c2p-space-2) var(--c2p-space-4);
  padding: var(--c2p-space-4) var(--c2p-space-2);
  text-decoration: none;
  transition: background var(--c2p-transition);
}

.project-row__link:hover {
  background: var(--c2p-surface);
}

.project-row__index {
  padding-top: 0.15rem;
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
}

.project-row__main {
  display: grid;
  gap: var(--c2p-space-1);
  min-width: 0;
}

.project-row__name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.project-row__question {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.project-row__meta {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3);
}

.project-row__toggle {
  min-height: 2rem;
  margin: 0 0 var(--c2p-space-2) calc(var(--c2p-space-2) + 2.25rem);
  padding: 0 var(--c2p-space-2);
  font-size: var(--c2p-text-xs);
}

@media (max-width: 40rem) {
  .project-row__toggle {
    margin-left: var(--c2p-space-2);
  }
}

.project-row__date {
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
}
</style>
