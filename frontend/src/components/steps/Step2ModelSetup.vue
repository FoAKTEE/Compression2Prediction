<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { normalizeError } from "../../api/client";
import { getExample } from "../../api/examples";
import { compileModel, getEligibility, getMechanismGraph, importModel, listMechanisms, listVariables } from "../../api/model";
import type {
  EligibilityRecord,
  EligibilityResponse,
  ImportModelResponse,
  ListVariablesResponse,
  MechanismPort,
  MechanismSpec,
  ModelImport,
  PrimaryKind,
  SpaceSpec,
  VariableDef,
} from "../../api/types";
import { errorNotice, type ErrorNoticeContent } from "../../composables/errorNotice";
import { exampleRequested, useGraphSource } from "../../composables/graphSource";
import { importFailure, readJsonObject, type ImportFailure } from "../../composables/importFailure";
import { projectStore } from "../../store/project";
import GraphPanel from "../graph/GraphPanel.vue";
import { exampleEligibility, exampleMechanismGraph, exampleVariables } from "../graph/examples";
import { AGENT_KINDS, PRIMARY_KINDS } from "../graph/model";
import StateNotice from "../StateNotice.vue";
import ExamplePicker from "./ExamplePicker.vue";
import StepPanel from "./StepPanel.vue";

const props = defineProps<{ projectId: string; completed: boolean }>();
const emit = defineEmits<{ complete: []; incomplete: [] }>();
const { t } = useI18n();
const route = useRoute();

/** `?example=1`: an offline walkthrough on the bundled example, with no server. */
const demo = exampleRequested(route?.query);

const graph = useGraphSource({
  projectId: () => props.projectId,
  fetch: getMechanismGraph,
  example: exampleMechanismGraph,
});
const projectId = graph.projectId;

// ---------------------------------------------------------------- model lists and eligibility

const variables = shallowRef<ListVariablesResponse | null>(demo ? exampleVariables() : null);
const mechanisms = shallowRef<MechanismSpec[] | null>(demo ? exampleMechanismGraph().mechanisms : null);
const modelLoading = ref(false);
const modelError = ref<unknown>(null);

const eligibility = shallowRef<EligibilityResponse | null>(demo ? exampleEligibility() : null);
const eligibilityLoading = ref(false);
const eligibilityError = ref<unknown>(null);

let unmounted = false;
onBeforeUnmount(() => {
  unmounted = true;
});

async function loadModelLists(id: string): Promise<void> {
  modelLoading.value = true;
  modelError.value = null;
  try {
    const [vars, mechs] = await Promise.all([listVariables(id), listMechanisms(id)]);
    if (unmounted || projectId.value !== id) return;
    variables.value = vars;
    mechanisms.value = mechs;
  } catch (caught) {
    if (!unmounted && projectId.value === id) modelError.value = caught;
  } finally {
    if (!unmounted) modelLoading.value = false;
  }
}

async function loadEligibility(id: string): Promise<void> {
  eligibilityLoading.value = true;
  eligibilityError.value = null;
  try {
    const result = await getEligibility(id);
    if (!unmounted && projectId.value === id) eligibility.value = result;
  } catch (caught) {
    if (!unmounted && projectId.value === id) eligibilityError.value = caught;
  } finally {
    if (!unmounted) eligibilityLoading.value = false;
  }
}

watch(
  projectId,
  (id) => {
    if (id === null || demo) return;
    void loadModelLists(id);
    void loadEligibility(id);
  },
  { immediate: true },
);

// ---------------------------------------------------------------- actions

type Action = "example" | "import" | "compile";
const busy = ref<Action | null>(null);
const pickerOpen = ref(false);
const importProblem = ref<ImportFailure | null>(null);
const actionNotice = ref<ErrorNoticeContent | null>(null);
const imported = ref<ImportModelResponse | null>(null);
const compileProblem = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const canAct = computed(() => projectId.value !== null && busy.value === null);
const exampleName = computed(() => projectStore.state.exampleName);
const lastCompile = computed(() => projectStore.state.lastCompile);

function clearMessages(): void {
  importProblem.value = null;
  actionNotice.value = null;
  compileProblem.value = null;
}

/** A new model invalidates the last compile, so the step is incomplete until it compiles again. */
async function putModel(body: ModelImport, action: Action, fromExample: string | null): Promise<boolean> {
  const id = projectId.value;
  if (id === null) {
    busy.value = null;
    return false;
  }
  busy.value = action;
  try {
    const result = await importModel(id, body);
    if (unmounted) return true;
    imported.value = result;
    projectStore.setLastCompile(null);
    if (fromExample !== null) projectStore.setExampleName(fromExample);
    emit("incomplete");
    await Promise.all([loadModelLists(id), graph.reload()]);
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

async function loadExampleModel(name: string): Promise<void> {
  if (busy.value !== null) return;
  clearMessages();
  busy.value = "example";
  let model: ModelImport;
  try {
    model = (await getExample(name)).model;
  } catch (caught) {
    if (!unmounted) {
      actionNotice.value = errorNotice(caught, t);
      busy.value = null;
    }
    return;
  }
  if (unmounted) return;
  if (await putModel(model, "example", name)) pickerOpen.value = false;
}

/** With an example remembered from step 1, load its model directly; otherwise let the user pick one. */
function onLoadExampleModel(): void {
  if (exampleName.value !== null) void loadExampleModel(exampleName.value);
  else pickerOpen.value = !pickerOpen.value;
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
  await putModel(body as unknown as ModelImport, "import", null);
}

async function compile(): Promise<void> {
  const id = projectId.value;
  if (id === null || busy.value !== null) return;
  clearMessages();
  busy.value = "compile";
  try {
    const result = await compileModel(id);
    if (unmounted) return;
    // Completion follows the last compile (see `stepDone`); a failed compile withdraws it.
    projectStore.setLastCompile(result);
    if (!result.ok) emit("incomplete");
    await graph.reload();
  } catch (caught) {
    if (unmounted) return;
    const failure = normalizeError(caught);
    if (failure.code === "model_not_found") compileProblem.value = t("step2.compile.noModel");
    else if (failure.status === 422) compileProblem.value = failure.message;
    else actionNotice.value = errorNotice(failure, t);
  } finally {
    if (!unmounted) busy.value = null;
  }
}

/** The offline demo shows the bundled, already-compiled example plan, which stands in for a compile. */
const stepDone = computed(() => lastCompile.value?.ok === true || (demo && graph.isExample.value));

watch(
  stepDone,
  (done) => {
    if (done && !props.completed) emit("complete");
  },
  { immediate: true },
);

// ---------------------------------------------------------------- display helpers

function domainEntries(variable: VariableDef): { kind: PrimaryKind; space: SpaceSpec }[] {
  return PRIMARY_KINDS.flatMap((kind) => {
    const space = variable.domain_by_kind[kind];
    return space ? [{ kind, space }] : [];
  });
}

function timeLabel(offset: number): string {
  if (offset === 0) return "t";
  return offset > 0 ? `t+${offset}` : `t−${-offset}`;
}

function outputOf(spec: MechanismSpec): MechanismPort | null {
  return spec.outputs[0] ?? null;
}

/** Deterministic rule: Person, Organization, or Group AND the boolean `true`; the string "true" never counts. */
function isCandidate(record: EligibilityRecord): boolean {
  return (AGENT_KINDS as readonly string[]).includes(record.primary_kind) && record.agent_eligible === true;
}

/** Only world entities are listed; a record that is not one (a variable, a mechanism) never appears. */
const eligibilityRows = computed(() =>
  (eligibility.value?.entities ?? []).filter((e) => (PRIMARY_KINDS as readonly string[]).includes(e.primary_kind)),
);
const eligibilityCounts = computed(() => ({
  entities: eligibilityRows.value.length,
  candidates: eligibilityRows.value.filter(isCandidate).length,
}));

const errorCount = computed(() => lastCompile.value?.diagnostics.filter((d) => d.severity === "error").length ?? 0);

const modelNotice = computed(() => (modelError.value === null ? null : errorNotice(modelError.value, t)));

const eligibilityNotice = computed(() => {
  if (eligibilityError.value === null) return null;
  if (normalizeError(eligibilityError.value).code === "world_not_ready") {
    return {
      variant: "empty" as const,
      title: t("step2.eligibility.noWorld.title"),
      body: t("step2.eligibility.noWorld.body"),
    };
  }
  return errorNotice(eligibilityError.value, t);
});

const graphNotice = computed(() => {
  if (graph.error.value !== null) return errorNotice(graph.error.value, t);
  if (!graph.hasProject.value && !graph.data.value && !graph.loading.value) {
    return {
      variant: "empty" as const,
      title: t("process.mechanismGraph.noModel.title"),
      body: t("process.mechanismGraph.noModel.body"),
    };
  }
  return null;
});
</script>

<template>
  <StepPanel :step="2" :completed="completed" wired>
    <section class="step-section" data-testid="model-actions" :aria-label="t('step2.actions.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step2.actions.heading") }}</h3>
      </div>
      <div class="step-actions">
        <button
          type="button"
          class="btn"
          data-testid="load-example-model"
          :disabled="!canAct && !pickerOpen"
          :aria-expanded="exampleName === null ? pickerOpen : undefined"
          @click="onLoadExampleModel"
        >
          {{
            exampleName === null
              ? t("step2.actions.loadExampleModel")
              : t("step2.actions.loadNamedExampleModel", { name: exampleName })
          }}
        </button>
        <button type="button" class="btn" data-testid="import-model" :disabled="!canAct" @click="chooseFile">
          {{ busy === "import" ? t("step2.actions.importing") : t("step2.actions.importModel") }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept=".json,application/json"
          class="sr-only"
          tabindex="-1"
          aria-hidden="true"
          data-testid="model-file"
          @change="onFileChosen"
        />
        <button type="button" class="btn btn--primary" data-testid="compile" :disabled="!canAct" @click="compile">
          {{ busy === "compile" ? t("step2.actions.compiling") : t("step2.actions.compile") }}
        </button>
      </div>
      <p v-if="projectId === null" class="step-hint" data-testid="actions-need-project">
        {{ demo ? t("step2.actions.demo") : t("step2.actions.needsProject") }}
      </p>

      <ExamplePicker
        v-if="pickerOpen"
        :busy="busy === 'example'"
        :confirm-label="t('examples.picker.loadModel')"
        @choose="loadExampleModel"
        @cancel="pickerOpen = false"
      />

      <p v-if="imported" class="step-success" data-testid="model-imported">
        <span class="step-success__marker" aria-hidden="true">✓</span>
        <span>
          {{
            t("step2.imported", {
              variables: imported.counts.variables,
              templates: imported.counts.templates,
              kernels: imported.counts.kernels,
              sources: imported.counts.sources,
            })
          }}
        </span>
        <span class="mono">{{ imported.model_version }}</span>
      </p>
      <div v-if="importProblem" class="inline-error" role="alert" data-testid="model-import-error">
        <p class="inline-error__title">{{ importProblem.title }}</p>
        <p class="inline-error__detail">{{ importProblem.detail }}</p>
      </div>
      <StateNotice
        v-if="actionNotice"
        compact
        data-testid="model-action-error"
        :variant="actionNotice.variant"
        :title="actionNotice.title"
        :body="actionNotice.body"
      />
    </section>

    <section class="step-section" data-testid="variables-section" :aria-label="t('step2.variables.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step2.variables.heading") }}</h3>
        <span class="step-section__aside mono" data-testid="registry-version">
          {{
            variables?.registry_version
              ? t("step2.variables.registry", { version: variables.registry_version })
              : t("step2.variables.noRegistry")
          }}
        </span>
      </div>
      <StateNotice
        v-if="modelNotice"
        compact
        data-testid="model-notice"
        :variant="modelNotice.variant"
        :title="modelNotice.title"
        :body="modelNotice.body"
      />
      <p v-else-if="modelLoading && !variables" class="step-hint">{{ t("common.loading") }}</p>
      <div v-else-if="variables && variables.variables.length" class="table-scroll">
        <table class="data-table" data-testid="variables-table">
          <thead>
            <tr>
              <th scope="col">{{ t("step2.variables.columns.id") }}</th>
              <th scope="col">{{ t("step2.variables.columns.domains") }}</th>
              <th scope="col">{{ t("step2.variables.columns.units") }}</th>
              <th scope="col">{{ t("step2.variables.columns.ownership") }}</th>
              <th scope="col">{{ t("step2.variables.columns.missingness") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="variable in variables.variables"
              :key="variable.variable_id"
              data-testid="variable-row"
              :data-variable-id="variable.variable_id"
            >
              <td class="mono">{{ variable.variable_id }}</td>
              <td>
                <ul class="domains">
                  <li v-for="entry in domainEntries(variable)" :key="entry.kind" data-testid="variable-domain">
                    <span class="mono domains__kind">{{ entry.kind }}</span>
                    <span aria-hidden="true">→</span>
                    <span class="mono">{{ entry.space.name }}: {{ "{" + entry.space.values.join(", ") + "}" }}</span>
                  </li>
                </ul>
              </td>
              <td class="mono">{{ variable.units }}</td>
              <td class="mono">{{ variable.ownership }}</td>
              <td class="mono">{{ variable.missingness }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="step-hint" data-testid="no-variables">{{ t("step2.variables.empty") }}</p>
    </section>

    <section class="step-section" data-testid="mechanisms-section" :aria-label="t('step2.mechanisms.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step2.mechanisms.heading") }}</h3>
      </div>
      <ol v-if="mechanisms && mechanisms.length" class="mechanisms" data-testid="mechanisms-list">
        <li
          v-for="spec in mechanisms"
          :key="spec.mechanism_id"
          class="mechanism"
          data-testid="mechanism-row"
          :data-mechanism-id="spec.mechanism_id"
        >
          <header class="mechanism__header">
            <span class="mono mechanism__id">{{ spec.mechanism_id }}</span>
            <span class="badge" data-testid="mechanism-family">{{ spec.family }}</span>
            <span v-if="!spec.enabled" class="badge">{{ t("step2.mechanisms.disabled") }}</span>
          </header>
          <div class="mechanism__ports">
            <div>
              <p class="mechanism__sub">{{ t("step2.mechanisms.inputs") }}</p>
              <ol class="ports">
                <li
                  v-for="(port, index) in spec.inputs"
                  :key="port.port"
                  data-testid="mechanism-input"
                  :data-port="port.port"
                  :data-port-index="index"
                >
                  <span class="mono ports__name">{{ index }} · {{ port.port }}</span>
                  <span class="mono ports__var">{{ port.variable }} @ {{ timeLabel(port.time_offset) }}</span>
                </li>
              </ol>
            </div>
            <div>
              <p class="mechanism__sub">{{ t("step2.mechanisms.output") }}</p>
              <p v-if="outputOf(spec)" class="ports ports--single" data-testid="mechanism-output">
                <span class="mono ports__name">{{ outputOf(spec)!.port }}</span>
                <span class="mono ports__var">{{ outputOf(spec)!.variable }} @ {{ timeLabel(outputOf(spec)!.time_offset) }}</span>
              </p>
            </div>
          </div>
          <dl class="mechanism__meta">
            <div>
              <dt>{{ t("step2.mechanisms.kernelRef") }}</dt>
              <dd class="mono">{{ spec.kernel_ref }}</dd>
            </div>
            <div>
              <dt>{{ t("step2.mechanisms.parameterOrigin") }}</dt>
              <dd class="mono">{{ spec.parameter_origin }}</dd>
            </div>
            <div>
              <dt>{{ t("step2.mechanisms.validationStatus") }}</dt>
              <dd class="mono">{{ spec.validation_status }}</dd>
            </div>
          </dl>
        </li>
      </ol>
      <p v-else-if="!modelNotice" class="step-hint" data-testid="no-mechanisms">{{ t("step2.mechanisms.empty") }}</p>
    </section>

    <section class="step-section" data-testid="compile-panel" :aria-label="t('step2.compile.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step2.compile.heading") }}</h3>
      </div>
      <div aria-live="polite">
        <p v-if="compileProblem" class="inline-error" role="alert" data-testid="compile-error">
          <span class="inline-error__detail">{{ compileProblem }}</span>
        </p>
        <p v-else-if="!lastCompile" class="step-hint" data-testid="compile-idle">
          {{ demo ? t("step2.compile.demo") : t("step2.compile.idle") }}
        </p>
        <p v-else-if="lastCompile.ok" class="step-success" data-testid="compile-ok">
          <span class="step-success__marker" aria-hidden="true">✓</span>
          <span>{{ t("step2.compile.ok") }}</span>
          <span class="mono">{{ lastCompile.model_version }}</span>
        </p>
        <p v-else class="compile-failed" data-testid="compile-failed">
          {{ t("step2.compile.failed", { count: errorCount }, errorCount) }}
        </p>
      </div>
      <ul v-if="lastCompile && lastCompile.diagnostics.length" class="diagnostics" data-testid="diagnostics">
        <li
          v-for="(diagnostic, index) in lastCompile.diagnostics"
          :key="index"
          class="diagnostic"
          :class="`diagnostic--${diagnostic.severity}`"
          data-testid="diagnostic-row"
          :data-severity="diagnostic.severity"
        >
          <span class="diagnostic__severity mono">{{ t(`step2.compile.severity.${diagnostic.severity}`) }}</span>
          <span class="diagnostic__code mono" data-testid="diagnostic-code">{{ diagnostic.code }}</span>
          <span class="diagnostic__message">{{ diagnostic.message }}</span>
          <span
            v-if="diagnostic.mechanism_id || diagnostic.variable_id || diagnostic.port"
            class="diagnostic__chips"
          >
            <span v-if="diagnostic.mechanism_id" class="chip" data-testid="chip-mechanism">
              <span class="chip__key">{{ t("step2.compile.chips.mechanism") }}</span>{{ diagnostic.mechanism_id }}
            </span>
            <span v-if="diagnostic.variable_id" class="chip" data-testid="chip-variable">
              <span class="chip__key">{{ t("step2.compile.chips.variable") }}</span>{{ diagnostic.variable_id }}
            </span>
            <span v-if="diagnostic.port" class="chip" data-testid="chip-port">
              <span class="chip__key">{{ t("step2.compile.chips.port") }}</span>{{ diagnostic.port }}
            </span>
          </span>
        </li>
      </ul>
    </section>

    <section class="graph-region" data-testid="mechanism-region" :aria-label="t('process.mechanismGraph.label')">
      <header class="graph-region__bar">
        <h3 class="eyebrow">{{ t("process.mechanismGraph.label") }}</h3>
        <span v-if="graph.isExample.value" class="badge" data-testid="example-badge" :title="t('graph.example.note')">
          {{ t("graph.example.badge") }}
        </span>
        <button
          type="button"
          class="btn btn--quiet graph-region__action"
          data-testid="load-example"
          @click="graph.loadExample"
        >
          {{ t("graph.example.load") }}
        </button>
      </header>
      <StateNotice
        v-if="graphNotice"
        compact
        data-testid="mechanism-notice"
        :variant="graphNotice.variant"
        :title="graphNotice.title"
        :body="graphNotice.body"
      />
      <GraphPanel
        v-if="graph.data.value || graph.loading.value"
        :mechanism="graph.data.value"
        initial-mode="mechanism"
        :loading="graph.loading.value"
      />
    </section>

    <section class="step-section" data-testid="eligibility-panel" :aria-label="t('step2.eligibility.heading')">
      <div class="step-section__bar">
        <h3 class="eyebrow">{{ t("step2.eligibility.heading") }}</h3>
      </div>
      <StateNotice
        v-if="eligibilityNotice"
        compact
        data-testid="eligibility-notice"
        :variant="eligibilityNotice.variant"
        :title="eligibilityNotice.title"
        :body="eligibilityNotice.body"
      />
      <p v-else-if="eligibilityLoading && !eligibility" class="step-hint">{{ t("common.loading") }}</p>
      <template v-else-if="eligibility">
        <div class="stat-pair eligibility__counts">
          <p class="stat" data-testid="eligibility-entity-count">
            <span class="stat__value">{{ eligibilityCounts.entities }}</span>
            <span class="stat__label">{{ t("step1.summary.entities") }}</span>
          </p>
          <p class="stat" data-testid="eligibility-agent-count">
            <span class="stat__value">{{ eligibilityCounts.candidates }}</span>
            <span class="stat__label">{{ t("step1.summary.agents") }}</span>
          </p>
        </div>
        <div v-if="eligibilityRows.length" class="table-scroll">
          <table class="data-table" data-testid="eligibility-table">
            <thead>
              <tr>
                <th scope="col">{{ t("step2.eligibility.columns.entity") }}</th>
                <th scope="col">{{ t("step2.eligibility.columns.kind") }}</th>
                <th scope="col">{{ t("step2.eligibility.columns.eligible") }}</th>
                <th scope="col">{{ t("step2.eligibility.columns.basis") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="record in eligibilityRows"
                :key="record.entity_id"
                data-testid="eligibility-row"
                :data-entity-id="record.entity_id"
                :class="{ 'is-candidate': isCandidate(record) }"
              >
                <td>
                  <span class="eligibility__name">{{ record.display_name }}</span>
                  <span class="mono eligibility__id">{{ record.entity_id }}</span>
                </td>
                <td class="mono">{{ record.primary_kind }}</td>
                <td data-testid="eligibility-status">
                  {{ isCandidate(record) ? t("graph.detail.yes") : t("graph.detail.no") }}
                </td>
                <td class="mono">{{ record.agent_eligibility_basis ?? t("step2.eligibility.noBasis") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="step-hint">{{ t("step2.eligibility.empty") }}</p>
        <p class="step-hint eligibility__rule">{{ t("graph.agents.rule") }}</p>
      </template>
    </section>
  </StepPanel>
</template>

<style scoped>
.domains {
  display: grid;
  gap: 0.15rem;
}

.domains li {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--c2p-space-2);
  align-items: baseline;
}

.domains__kind {
  color: var(--c2p-text-muted);
}

.mechanisms {
  display: grid;
  gap: var(--c2p-space-3);
}

.mechanism {
  display: grid;
  gap: var(--c2p-space-3);
  padding: var(--c2p-space-3) var(--c2p-space-4);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
}

.mechanism__header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-2) var(--c2p-space-3);
}

.mechanism__id {
  font-size: var(--c2p-text-sm);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.mechanism__ports {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--c2p-space-3) var(--c2p-space-5);
}

@media (max-width: 40rem) {
  .mechanism__ports {
    grid-template-columns: minmax(0, 1fr);
  }
}

.mechanism__sub {
  margin-bottom: var(--c2p-space-1);
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.ports {
  display: grid;
  gap: var(--c2p-space-1);
}

.ports li,
.ports--single {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--c2p-space-3);
  padding-left: var(--c2p-space-2);
  border-left: 2px solid var(--c2p-rule);
  font-size: var(--c2p-text-xs);
}

.ports--single {
  border-left-color: var(--c2p-ink);
}

.ports__name {
  font-weight: 600;
}

.ports__var {
  color: var(--c2p-text-muted);
  overflow-wrap: anywhere;
}

.mechanism__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-1) var(--c2p-space-5);
  margin: 0;
}

.mechanism__meta div {
  display: grid;
  min-width: 0;
}

.mechanism__meta dt {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.mechanism__meta dd {
  margin: 0;
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
}

.compile-failed {
  padding: var(--c2p-space-2) var(--c2p-space-3);
  border-left: 3px solid var(--c2p-danger);
  color: var(--c2p-danger);
  font-size: var(--c2p-text-sm);
  font-weight: 600;
}

.diagnostics {
  display: grid;
  gap: var(--c2p-space-2);
}

.diagnostic {
  display: grid;
  grid-template-columns: 5rem minmax(8rem, auto) minmax(0, 1fr);
  gap: var(--c2p-space-1) var(--c2p-space-3);
  align-items: baseline;
  padding: var(--c2p-space-2) 0;
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
  font-size: var(--c2p-text-sm);
}

@media (max-width: 40rem) {
  .diagnostic {
    grid-template-columns: minmax(0, 1fr);
  }
}

.diagnostic__severity {
  font-size: var(--c2p-text-xs);
  text-transform: uppercase;
}

.diagnostic--error .diagnostic__severity {
  color: var(--c2p-danger);
  font-weight: 700;
}

.diagnostic--warning .diagnostic__severity {
  color: var(--c2p-warning);
}

.diagnostic__code {
  font-size: var(--c2p-text-xs);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.diagnostic__chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-1);
  grid-column: 3;
}

@media (max-width: 40rem) {
  .diagnostic__chips {
    grid-column: 1;
  }
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

.eligibility__counts {
  max-width: 28rem;
}

.eligibility__name {
  display: block;
}

.eligibility__id {
  color: var(--c2p-text-muted);
}

.is-candidate .eligibility__name {
  font-weight: 600;
}

.eligibility__rule {
  font-size: var(--c2p-text-xs);
}
</style>
