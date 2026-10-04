<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { normalizeError } from "../../api/client";
import { getExample } from "../../api/examples";
import { pollTask } from "../../api/tasks";
import type { Task, WorldImport } from "../../api/types";
import { getProject, getWorld, importWorld, listProjectTasks, startExtraction } from "../../api/world";
import { errorNotice, type ErrorNoticeContent } from "../../composables/errorNotice";
import { exampleRequested, useGraphSource } from "../../composables/graphSource";
import { importFailure, readJsonObject, type ImportFailure } from "../../composables/importFailure";
import { htmlLang, isLocale } from "../../i18n";
import { projectStore } from "../../store/project";
import GraphPanel from "../graph/GraphPanel.vue";
import { exampleWorld } from "../graph/examples";
import StateNotice from "../StateNotice.vue";
import ExamplePicker from "./ExamplePicker.vue";
import StepPanel from "./StepPanel.vue";

const props = defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: []; "refresh-project": [] }>();
const { t, locale } = useI18n();
const route = useRoute();

/** `?example=1`: an offline walkthrough on the bundled example, with no server. */
const demo = exampleRequested(route?.query);

/** Extraction can take minutes: poll once a second for up to ten minutes. */
const EXTRACTION_POLL = { intervalMs: 1_000, maxAttempts: 600 } as const;
/** The server's task kind for world extraction. */
const EXTRACTION_TASK_KIND = "world_extraction";

const { data, loading, error, isExample, projectId, loadExample, reload } = useGraphSource({
  projectId: () => props.projectId,
  fetch: getWorld,
  example: exampleWorld,
});

const project = computed(() => {
  const current = projectStore.state.project;
  return current !== null && current.project_id === props.projectId ? current : null;
});
const files = computed(() => project.value?.files ?? []);

type Action = "extraction" | "import" | "example";
const busy = ref<Action | null>(null);
const task = ref<Task | null>(null);
const extractionUnavailable = ref(false);
const importProblem = ref<ImportFailure | null>(null);
const actionNotice = ref<ErrorNoticeContent | null>(null);
const pickerOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const canAct = computed(() => projectId.value !== null && busy.value === null);

let poller: AbortController | null = null;
let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
  poller?.abort();
});

function clearMessages(): void {
  extractionUnavailable.value = false;
  importProblem.value = null;
  actionNotice.value = null;
}

/** A world exists for the project once the server returns one; in the offline demo the bundled example stands in. */
const worldExists = computed(() => {
  const world = data.value;
  if (world === null || world.world_version === null) return false;
  return !isExample.value || demo;
});

watch(
  worldExists,
  (exists) => {
    if (exists && !props.completed) emit("complete");
  },
  { immediate: true },
);

/** After any success: fetch the world again, and refresh the project (status, world version). */
async function refresh(id: string): Promise<void> {
  await reload();
  try {
    const fresh = await getProject(id);
    if (!unmounted && projectStore.state.project?.project_id === fresh.project_id) projectStore.setProject(fresh);
  } catch {
    // The world is already shown; the project header refreshes on the next load.
  }
}

function onExtractionError(caught: unknown): void {
  const failure = normalizeError(caught);
  if (failure.code === "canceled") return;
  if (failure.status === 501 || failure.code === "not_implemented") extractionUnavailable.value = true;
  else actionNotice.value = errorNotice(failure, t);
}

/** Polls an extraction task to its end, then shows the new world or the failure. */
async function followExtraction(id: string, started: Task): Promise<void> {
  busy.value = "extraction";
  task.value = started;
  try {
    poller = new AbortController();
    const finished = await pollTask(started.task_id, {
      ...EXTRACTION_POLL,
      signal: poller.signal,
      onUpdate: (snapshot) => {
        if (!unmounted) task.value = snapshot;
      },
    });
    if (unmounted) return;
    if (finished.status === "completed") {
      await refresh(id);
    } else {
      actionNotice.value = {
        variant: "error",
        title: t("step1.extraction.failed"),
        body: finished.error ?? finished.message ?? "",
      };
    }
  } catch (caught) {
    if (!unmounted) onExtractionError(caught);
  } finally {
    poller = null;
    if (!unmounted) busy.value = null;
  }
}

async function runExtraction(): Promise<void> {
  const id = projectId.value;
  if (id === null || busy.value !== null) return;
  clearMessages();
  busy.value = "extraction";
  task.value = null;
  let started: Task;
  try {
    started = await startExtraction(id);
  } catch (caught) {
    if (!unmounted) {
      onExtractionError(caught);
      busy.value = null;
    }
    return;
  }
  if (unmounted) return;
  await followExtraction(id, started);
}

/**
 * After a reload, an extraction may still be pending or running on the
 * server: find it in the project's task listing and keep polling it. A server
 * without the listing (or any failure) just leaves the step idle.
 */
async function resumeExtraction(id: string): Promise<void> {
  if (demo) return;
  let tasks: Task[] | undefined;
  try {
    tasks = await listProjectTasks(id, { kind: EXTRACTION_TASK_KIND, status: ["pending", "running"] });
  } catch {
    return;
  }
  if (unmounted || projectId.value !== id || busy.value !== null) return;
  const active = (tasks ?? []).find(
    (candidate) => candidate.kind === EXTRACTION_TASK_KIND && (candidate.status === "pending" || candidate.status === "running"),
  );
  if (active) await followExtraction(id, active);
}

watch(
  projectId,
  (id) => {
    if (id !== null) void resumeExtraction(id);
  },
  { immediate: true },
);

/** PUTs a world bundle; the server's 422/409/413 messages are shown inline. Returns whether it was stored. */
async function putWorld(body: WorldImport, action: Action, exampleName: string | null): Promise<boolean> {
  const id = projectId.value;
  if (id === null) {
    busy.value = null;
    return false;
  }
  busy.value = action;
  try {
    await importWorld(id, body);
    if (unmounted) return true;
    projectStore.setExampleName(exampleName);
    await refresh(id);
    return true;
  } catch (caught) {
    if (unmounted) return false;
    const inline = importFailure(caught, t);
    if (inline) importProblem.value = inline;
    else actionNotice.value = errorNotice(caught, t);
    return false;
  } finally {
    if (!unmounted) busy.value = null;
  }
}

function chooseFile(): void {
  fileInput.value?.click();
}

async function onFileChosen(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value !== null) return;
  clearMessages();
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(file, t);
  } catch (caught) {
    importProblem.value = { title: t("imports.unreadable"), detail: (caught as Error).message, code: "invalid_json" };
    return;
  }
  await putWorld(body as unknown as WorldImport, "import", null);
}

async function loadServerExample(name: string): Promise<void> {
  if (busy.value !== null) return;
  clearMessages();
  busy.value = "example";
  let world: WorldImport;
  try {
    world = (await getExample(name)).world;
  } catch (caught) {
    if (!unmounted) {
      actionNotice.value = errorNotice(caught, t);
      busy.value = null;
    }
    return;
  }
  if (unmounted) return;
  if (await putWorld(world, "example", name)) pickerOpen.value = false;
}

const progressPercent = computed(() => {
  const p = task.value?.progress;
  return typeof p === "number" && Number.isFinite(p) ? Math.round(Math.min(1, Math.max(0, p)) * 100) : null;
});

const counts = computed(() => data.value?.counts ?? null);

function formatSize(bytes: number): string {
  const tag = isLocale(locale.value) ? htmlLang(locale.value) : undefined;
  const kilobytes = bytes / 1024;
  const unit = kilobytes >= 1024 ? "megabyte" : "kilobyte";
  const value = unit === "megabyte" ? kilobytes / 1024 : kilobytes;
  return new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(
    value,
  );
}

const notice = computed(() => {
  if (error.value !== null) {
    if (normalizeError(error.value).code === "world_not_ready") {
      return { variant: "empty" as const, title: t("step1.noWorld.title"), body: t("step1.noWorld.body") };
    }
    return errorNotice(error.value, t);
  }
  if (projectId.value === null && !data.value && !loading.value) {
    return { variant: "empty" as const, title: t("process.graph.noWorld.title"), body: t("process.graph.noWorld.body") };
  }
  return null;
});
</script>

<template>
  <StepPanel :step="1" :completed="completed" wired>
    <section class="step-section" data-testid="project-files" :aria-label="t('step1.files.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step1.files.heading") }}</h3>
        <span v-if="files.length" class="step-section__aside">
          {{ t("step1.files.count", { count: files.length }, files.length) }}
        </span>
      </div>
      <ul v-if="files.length" class="files">
        <li v-for="file in files" :key="file.file_id" class="files__item" data-testid="project-file">
          <span class="mono files__name">{{ file.filename }}</span>
          <span class="files__meta">{{ formatSize(file.size_bytes) }}</span>
          <span class="mono files__hash" :title="file.content_hash">{{ file.content_hash.slice(0, 12) }}</span>
        </li>
      </ul>
      <p v-else class="step-hint" data-testid="no-files">
        {{ project ? t("step1.files.empty") : t("step1.files.noProject") }}
      </p>
    </section>

    <section class="step-section" data-testid="world-actions" :aria-label="t('step1.actions.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step1.actions.heading") }}</h3>
      </div>
      <div class="step-actions">
        <button
          type="button"
          class="btn btn--primary"
          data-testid="run-extraction"
          :disabled="!canAct"
          @click="runExtraction"
        >
          {{ busy === "extraction" ? t("step1.actions.extracting") : t("step1.actions.runExtraction") }}
        </button>
        <button type="button" class="btn" data-testid="import-world" :disabled="!canAct" @click="chooseFile">
          {{ busy === "import" ? t("step1.actions.importing") : t("step1.actions.importWorld") }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          data-testid="world-file"
          @change="onFileChosen"
        />
        <button
          type="button"
          class="btn"
          data-testid="open-example-picker"
          :aria-expanded="pickerOpen"
          :disabled="!canAct && !pickerOpen"
          @click="pickerOpen = !pickerOpen"
        >
          {{ t("step1.actions.loadExample") }}
        </button>
      </div>
      <p v-if="projectId === null" class="step-hint" data-testid="actions-need-project">
        {{ t("step1.actions.needsProject") }}
      </p>

      <ExamplePicker
        v-if="pickerOpen"
        :busy="busy === 'example'"
        :confirm-label="t('examples.picker.loadWorld')"
        @choose="loadServerExample"
        @cancel="pickerOpen = false"
      />

      <div v-if="busy === 'extraction' && task" class="progress" data-testid="extraction-progress" aria-live="polite">
        <div class="progress__row">
          <span class="mono progress__status">{{ t(`step1.extraction.status.${task.status}`) }}</span>
          <span v-if="progressPercent !== null" class="mono progress__percent">{{ progressPercent }}%</span>
        </div>
        <progress
          class="progress__bar"
          max="100"
          :value="progressPercent ?? undefined"
          :aria-label="t('step1.extraction.progress')"
        ></progress>
        <p v-if="task.message" class="progress__message" data-testid="extraction-message">{{ task.message }}</p>
      </div>

      <StateNotice
        v-if="extractionUnavailable"
        compact
        data-testid="extraction-unavailable"
        variant="unavailable"
        :title="t('step1.extraction.unavailable.title')"
        :body="t('step1.extraction.unavailable.body')"
      />
      <div v-if="importProblem" class="inline-error" role="alert" data-testid="world-import-error">
        <p class="inline-error__title">{{ importProblem.title }}</p>
        <p class="inline-error__detail">{{ importProblem.detail }}</p>
      </div>
      <StateNotice
        v-if="actionNotice"
        compact
        data-testid="world-action-error"
        :variant="actionNotice.variant"
        :title="actionNotice.title"
        :body="actionNotice.body"
      />
    </section>

    <section class="graph-region" data-testid="graph-region" :aria-label="t('process.graph.label')">
      <header class="graph-region__bar">
        <h3 class="eyebrow">{{ t("process.graph.label") }}</h3>
        <span v-if="isExample" class="badge" data-testid="example-badge" :title="t('graph.example.note')">
          {{ t("graph.example.badge") }}
        </span>
        <button type="button" class="btn btn--quiet graph-region__action" data-testid="load-example" @click="loadExample">
          {{ t("graph.example.load") }}
        </button>
      </header>

      <div v-if="counts" class="world-summary" data-testid="world-summary">
        <div class="stat-pair">
          <p class="stat" data-testid="summary-entity-count">
            <span class="stat__value">{{ counts.world_entity_count }}</span>
            <span class="stat__label">{{ t("step1.summary.entities") }}</span>
            <span class="stat__note">{{ t("step1.summary.entitiesNote") }}</span>
          </p>
          <p class="stat" data-testid="summary-agent-count">
            <span class="stat__value">{{ counts.agent_candidate_count }}</span>
            <span class="stat__label">{{ t("step1.summary.agents") }}</span>
            <span class="stat__note">{{ t("step1.summary.agentsNote") }}</span>
          </p>
        </div>
        <dl class="world-summary__minor">
          <div>
            <dt>{{ t("step1.summary.events") }}</dt>
            <dd class="mono">{{ counts.event_count }}</dd>
          </div>
          <div>
            <dt>{{ t("step1.summary.roles") }}</dt>
            <dd class="mono">{{ counts.role_count }}</dd>
          </div>
          <div>
            <dt>{{ t("step1.summary.claims") }}</dt>
            <dd class="mono">{{ counts.claim_count }}</dd>
          </div>
        </dl>
      </div>

      <StateNotice
        v-if="notice"
        compact
        data-testid="world-notice"
        :variant="notice.variant"
        :title="notice.title"
        :body="notice.body"
      />
      <GraphPanel v-if="data || loading" :world="data" initial-mode="world" :loading="loading" />
    </section>
  </StepPanel>
</template>

<style scoped>
.files {
  display: grid;
  gap: var(--c2p-space-1);
}

.files__item {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--c2p-space-1) var(--c2p-space-3);
  font-size: var(--c2p-text-sm);
}

.files__name {
  font-size: var(--c2p-text-sm);
  overflow-wrap: anywhere;
}

.files__meta,
.files__hash {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.progress {
  display: grid;
  gap: var(--c2p-space-1);
  max-width: 32rem;
}

.progress__row {
  display: flex;
  justify-content: space-between;
  gap: var(--c2p-space-3);
  font-size: var(--c2p-text-xs);
}

.progress__bar {
  width: 100%;
  height: 0.5rem;
  accent-color: var(--c2p-ink);
}

.progress__message {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.graph-region {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

.graph-region__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3);
  padding-top: var(--c2p-space-3);
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.graph-region__action {
  margin-left: auto;
}

.world-summary {
  display: grid;
  grid-template-columns: minmax(0, 28rem) auto;
  gap: var(--c2p-space-3) var(--c2p-space-6);
  align-items: center;
}

@media (max-width: 40rem) {
  .world-summary {
    grid-template-columns: minmax(0, 1fr);
  }
}

.world-summary__minor {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-2) var(--c2p-space-5);
  margin: 0;
}

.world-summary__minor div {
  display: flex;
  align-items: baseline;
  gap: var(--c2p-space-2);
}

.world-summary__minor dt {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.world-summary__minor dd {
  margin: 0;
  font-size: var(--c2p-text-sm);
}
</style>
