<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { EvidenceObservation, ForecastRequest, Intervention, PrimaryKind, QueryKind, VariableDef } from "../../api/types";
import type { EntityOption } from "./examples";

/**
 * A forecast request: a target (an entity whose kind has a registered
 * variable, and one of those variables), a horizon, a scenario label, hard
 * interventions, and evidence. Each intervention holds an input variable at a
 * value from its kind's domain over a half-open window [start, end). Each
 * evidence observation fixes one variable of one entity at one time index to
 * a value from its kind's domain; it conditions every scenario and changes no
 * mechanism. Everything the server would reject for shape is checked here
 * first, so a bad request is never sent; the server still validates it (for
 * example, whether a key exists at that tick, or whether the evidence is
 * possible in the model).
 */
const props = withDefaults(
  defineProps<{
    entities: EntityOption[];
    variables: VariableDef[];
    /** The model's horizon; `null` when unknown (the server bounds it). */
    horizonMax: number | null;
    /** A request to start from (a selected run, or the offline example). */
    initial?: ForecastRequest | null;
    busy?: boolean;
    disabled?: boolean;
    compact?: boolean;
    submitLabel?: string | null;
  }>(),
  { initial: null, busy: false, disabled: false, compact: false, submitLabel: null },
);
const emit = defineEmits<{ submit: [request: ForecastRequest] }>();
const { t } = useI18n();
const uid = useId();

/** The server's scenario-name rule: one safe path component. */
const SCENARIO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_INTERVENTIONS = 16;
const MAX_EVIDENCE = 32;

/** A variable of one entity with a value from its domain: what both builders choose. */
interface Selection {
  variable: string;
  entityId: string;
  value: string;
}

interface Draft extends Selection {
  key: number;
  start: number | string;
  end: number | string;
}

interface EvidenceDraft extends Selection {
  key: number;
  time: number | string;
}

let nextKey = 1;

const targetEntityId = ref("");
const targetVariable = ref("");
const horizon = ref<number | string>(1);
const scenarioId = ref("");
const drafts = ref<Draft[]>([]);
const evidenceDrafts = ref<EvidenceDraft[]>([]);
const attempted = ref(false);
/** The user typed a horizon; the model's horizon no longer replaces it when it arrives. */
const horizonEdited = ref(false);
/** Fields the form carries through unchanged from `initial`. */
const passThrough = ref<Pick<ForecastRequest, "initial_belief_ref" | "step_minutes" | "particles">>({});
/** Interventions of `initial` that are not hard assignments; they cannot be edited or sent. */
const droppedKinds = ref<string[]>([]);

// ---------------------------------------------------------------- options

function kindOf(entityId: string): PrimaryKind | null {
  return props.entities.find((e) => e.entity_id === entityId)?.primary_kind ?? null;
}

function variableDef(id: string): VariableDef | null {
  return props.variables.find((v) => v.variable_id === id) ?? null;
}

function domainFor(variableId: string, entityId: string): string[] | null {
  const kind = kindOf(entityId);
  const def = variableDef(variableId);
  if (kind === null || def === null) return null;
  return def.domain_by_kind[kind]?.values ?? null;
}

/** World entities that have at least one registered variable for their kind. */
const targetEntities = computed(() =>
  props.entities.filter((e) => props.variables.some((v) => v.domain_by_kind[e.primary_kind] !== undefined)),
);

/** Variables registered for the target entity's kind; outcome-like (endogenous) ones first. */
const targetVariables = computed(() => {
  const kind = kindOf(targetEntityId.value);
  if (kind === null) return [];
  return props.variables
    .filter((v) => v.domain_by_kind[kind] !== undefined)
    .sort((a, b) => Number(a.ownership !== "endogenous") - Number(b.ownership !== "endogenous"));
});

/** Entities an intervention on `variableId` can address: those whose kind the variable is registered for. */
function entitiesFor(variableId: string): EntityOption[] {
  const def = variableDef(variableId);
  if (def === null) return [];
  return props.entities.filter((e) => def.domain_by_kind[e.primary_kind] !== undefined);
}

const horizonNumber = computed(() => (typeof horizon.value === "number" ? horizon.value : Number.NaN));

// ---------------------------------------------------------------- state

function defaultDraft(): Draft {
  const candidates = props.variables.filter((v) => v.variable_id !== targetVariable.value && entitiesFor(v.variable_id).length > 0);
  const variable = (candidates.find((v) => v.ownership === "exogenous") ?? candidates[0] ?? props.variables[0])?.variable_id ?? "";
  const entityId = entitiesFor(variable)[0]?.entity_id ?? "";
  const value = domainFor(variable, entityId)?.[0] ?? "";
  const end = Number.isInteger(horizonNumber.value) && horizonNumber.value > 0 ? horizonNumber.value : 1;
  return { key: nextKey++, variable, entityId, value, start: 0, end };
}

function draftFrom(iv: Intervention): Draft {
  return {
    key: nextKey++,
    variable: iv.target_variable,
    entityId: iv.target_entity_id ?? entitiesFor(iv.target_variable)[0]?.entity_id ?? "",
    value: iv.value ?? "",
    start: iv.start_step,
    end: iv.end_step_exclusive,
  };
}

/** A new observation: a variable other than the target where one exists, at time index 0, with its first domain value. */
function defaultEvidence(): EvidenceDraft {
  const candidates = props.variables.filter((v) => entitiesFor(v.variable_id).length > 0);
  const variable = (candidates.find((v) => v.variable_id !== targetVariable.value) ?? candidates[0] ?? props.variables[0])?.variable_id ?? "";
  const entityId = entitiesFor(variable)[0]?.entity_id ?? "";
  return { key: nextKey++, variable, entityId, value: domainFor(variable, entityId)?.[0] ?? "", time: 0 };
}

function evidenceFrom(e: EvidenceObservation): EvidenceDraft {
  return { key: nextKey++, variable: e.variable, entityId: e.entity_id, value: e.value, time: e.time_index };
}

/** Picks a valid target when the current one is not among the options (once the options are known). */
function ensureTarget(): void {
  if (targetEntities.value.length && !targetEntities.value.some((e) => e.entity_id === targetEntityId.value)) {
    targetEntityId.value = targetEntities.value[0]!.entity_id;
  }
  if (targetVariables.value.length && !targetVariables.value.some((v) => v.variable_id === targetVariable.value)) {
    targetVariable.value = targetVariables.value[0]!.variable_id;
  }
}

function reset(): void {
  const init = props.initial;
  attempted.value = false;
  horizonEdited.value = false;
  if (init) {
    targetEntityId.value = init.target_entity_id;
    targetVariable.value = init.target_variable;
    horizon.value = init.horizon_steps;
    scenarioId.value = init.scenario_id ?? "";
    drafts.value = init.interventions.filter((iv) => iv.kind === "hard").map(draftFrom);
    evidenceDrafts.value = (init.evidence ?? []).map(evidenceFrom);
    droppedKinds.value = init.interventions.filter((iv) => iv.kind !== "hard").map((iv) => iv.kind);
    passThrough.value = {
      ...(init.initial_belief_ref !== undefined ? { initial_belief_ref: init.initial_belief_ref } : {}),
      ...(init.step_minutes !== undefined ? { step_minutes: init.step_minutes } : {}),
      ...(init.particles !== undefined ? { particles: init.particles } : {}),
    };
  } else {
    targetEntityId.value = "";
    targetVariable.value = "";
    horizon.value = props.horizonMax ?? 1;
    scenarioId.value = "";
    drafts.value = [];
    evidenceDrafts.value = [];
    droppedKinds.value = [];
    passThrough.value = {};
  }
  ensureTarget();
}

reset();
watch(() => props.initial, reset);
watch([() => props.entities, () => props.variables], () => {
  // Options arrive after mount: keep a prefilled target if it is valid, otherwise choose one.
  ensureTarget();
});
watch(targetEntityId, () => {
  if (!targetVariables.value.some((v) => v.variable_id === targetVariable.value)) {
    targetVariable.value = targetVariables.value[0]?.variable_id ?? "";
  }
});
/** Without a starting request, the horizon defaults to the model's, once that is known. */
watch(
  () => props.horizonMax,
  (max) => {
    if (props.initial === null && max !== null && !horizonEdited.value) horizon.value = max;
  },
);

function addIntervention(): void {
  if (drafts.value.length >= MAX_INTERVENTIONS) return;
  drafts.value = [...drafts.value, defaultDraft()];
}

function removeIntervention(key: number): void {
  drafts.value = drafts.value.filter((d) => d.key !== key);
}

function addEvidence(): void {
  if (evidenceDrafts.value.length >= MAX_EVIDENCE) return;
  evidenceDrafts.value = [...evidenceDrafts.value, defaultEvidence()];
}

function removeEvidence(key: number): void {
  evidenceDrafts.value = evidenceDrafts.value.filter((d) => d.key !== key);
}

/** A new variable or entity: keep the value only if it is in the new domain, else take the domain's first value. */
function onVariableChange(draft: Selection): void {
  if (!entitiesFor(draft.variable).some((e) => e.entity_id === draft.entityId)) {
    draft.entityId = entitiesFor(draft.variable)[0]?.entity_id ?? "";
  }
  onEntityChange(draft);
}

function onEntityChange(draft: Selection): void {
  const domain = domainFor(draft.variable, draft.entityId) ?? [];
  if (!domain.includes(draft.value)) draft.value = domain[0] ?? "";
}

// ---------------------------------------------------------------- validation

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const horizonError = computed(() => {
  const h = horizon.value;
  if (!isInt(h) || h < 1) return t("forecast.form.errors.horizon");
  if (props.horizonMax !== null && h > props.horizonMax) return t("forecast.form.errors.horizonMax", { max: props.horizonMax });
  return null;
});

const targetError = computed(() => {
  if (!targetEntityId.value || !targetVariable.value) return t("forecast.form.errors.target");
  if (domainFor(targetVariable.value, targetEntityId.value) === null) return t("forecast.form.errors.targetKind");
  return null;
});

const scenarioError = computed(() => {
  const s = scenarioId.value.trim();
  return s === "" || SCENARIO_RE.test(s) ? null : t("forecast.form.errors.scenario");
});

interface DraftErrors {
  variable: string | null;
  entity: string | null;
  value: string | null;
  window: string | null;
}

function draftErrors(d: Draft): DraftErrors {
  const out: DraftErrors = { variable: null, entity: null, value: null, window: null };
  if (variableDef(d.variable) === null) out.variable = t("forecast.form.errors.variable");
  else if (d.variable === targetVariable.value && d.entityId === targetEntityId.value) out.variable = t("forecast.form.errors.outcome");
  const domain = domainFor(d.variable, d.entityId);
  if (!d.entityId || domain === null) out.entity = t("forecast.form.errors.entity");
  else if (d.value === "") out.value = t("forecast.form.errors.value");
  else if (!domain.includes(d.value)) out.value = t("forecast.form.errors.outOfDomain", { value: d.value });
  const h = horizonNumber.value;
  if (!isInt(d.start) || !isInt(d.end) || d.start < 0) out.window = t("forecast.form.errors.windowInteger");
  else if (d.end <= d.start) out.window = t("forecast.form.errors.windowInverted", { start: d.start, end: d.end });
  else if (Number.isInteger(h) && d.end > h) out.window = t("forecast.form.errors.windowHorizon", { end: d.end, horizon: h });
  return out;
}

const errorsByDraft = computed(() => new Map(drafts.value.map((d) => [d.key, draftErrors(d)])));

interface EvidenceErrors {
  variable: string | null;
  entity: string | null;
  value: string | null;
  time: string | null;
  key: string | null;
}

/** Same key as an earlier observation: the server rejects duplicates. */
const duplicateEvidence = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<number>();
  for (const d of evidenceDrafts.value) {
    const id = JSON.stringify([d.variable, d.entityId, d.time]);
    if (seen.has(id)) dup.add(d.key);
    seen.add(id);
  }
  return dup;
});

function evidenceErrors(d: EvidenceDraft): EvidenceErrors {
  const out: EvidenceErrors = { variable: null, entity: null, value: null, time: null, key: null };
  if (variableDef(d.variable) === null) out.variable = t("forecast.form.errors.variable");
  const domain = domainFor(d.variable, d.entityId);
  if (!d.entityId || domain === null) out.entity = t("forecast.form.errors.entity");
  else if (d.value === "") out.value = t("forecast.form.errors.value");
  else if (!domain.includes(d.value)) out.value = t("forecast.form.errors.outOfDomain", { value: d.value });
  const h = horizonNumber.value;
  if (!isInt(d.time) || d.time < 0) out.time = t("forecast.form.errors.evidenceTime");
  else if (props.horizonMax !== null && d.time > props.horizonMax) out.time = t("forecast.form.errors.evidenceTimeMax", { max: props.horizonMax });
  else if (d.variable === targetVariable.value && d.entityId === targetEntityId.value && d.time >= 1 && Number.isInteger(h) && d.time <= h) {
    out.key = t("forecast.form.errors.evidenceTarget", { time: d.time, horizon: h });
  } else if (duplicateEvidence.value.has(d.key)) out.key = t("forecast.form.errors.evidenceDuplicate");
  return out;
}

const errorsByEvidence = computed(() => new Map(evidenceDrafts.value.map((d) => [d.key, evidenceErrors(d)])));

const hasErrors = computed(
  () =>
    horizonError.value !== null ||
    targetError.value !== null ||
    scenarioError.value !== null ||
    [...errorsByDraft.value.values()].some((e) => e.variable || e.entity || e.value || e.window) ||
    [...errorsByEvidence.value.values()].some((e) => e.variable || e.entity || e.value || e.time || e.key),
);

/** Interventions make it interventional (conditioned too, under evidence); evidence alone makes it conditional. */
const queryKind = computed<QueryKind>(() =>
  drafts.value.length ? "interventional" : evidenceDrafts.value.length ? "conditional" : "observational",
);

const queryKindLabel = computed(() =>
  queryKind.value === "interventional" && evidenceDrafts.value.length
    ? `${t("forecast.queryKind.interventional")} · ${t("forecast.queryKind.conditional")}`
    : t(`forecast.queryKind.${queryKind.value}`),
);

const canSubmit = computed(() => !props.disabled && !props.busy && !hasErrors.value);

/** `[0, 2)` → `0→1, 1→2`: the transitions a valid window holds the input for. */
function transitions(d: Draft): string | null {
  if (!isInt(d.start) || !isInt(d.end) || d.start < 0 || d.end <= d.start) return null;
  const parts: string[] = [];
  for (let k = d.start; k < d.end && parts.length < 6; k += 1) parts.push(`${k}→${k + 1}`);
  if (d.end - d.start > 6) parts.push("…");
  return parts.join(", ");
}

function buildRequest(): ForecastRequest {
  const scenario = scenarioId.value.trim();
  return {
    ...(scenario ? { scenario_id: scenario } : {}),
    query_kind: queryKind.value,
    target_entity_id: targetEntityId.value,
    target_variable: targetVariable.value,
    horizon_steps: horizon.value as number,
    ...passThrough.value,
    interventions: drafts.value.map((d) => ({
      kind: "hard",
      target_variable: d.variable,
      target_entity_id: d.entityId,
      value: d.value,
      start_step: d.start as number,
      end_step_exclusive: d.end as number,
    })),
    ...(evidenceDrafts.value.length
      ? {
          evidence: evidenceDrafts.value.map((d) => ({
            variable: d.variable,
            entity_id: d.entityId,
            time_index: d.time as number,
            value: d.value,
          })),
        }
      : {}),
  };
}

function submit(): void {
  attempted.value = true;
  if (!canSubmit.value) return;
  emit("submit", buildRequest());
}

const fid = (name: string) => `${uid}-${name}`;
</script>

<template>
  <form class="fc-form" :class="{ 'fc-form--compact': compact }" data-testid="forecast-form" novalidate @submit.prevent="submit">
    <div class="fc-form__row">
      <div class="field">
        <label class="field__label" :for="fid('entity')">{{ t("forecast.form.targetEntity") }}</label>
        <select
          :id="fid('entity')"
          v-model="targetEntityId"
          class="field__input"
          data-testid="target-entity"
          :disabled="disabled || !targetEntities.length"
        >
          <option v-for="e in targetEntities" :key="e.entity_id" :value="e.entity_id">
            {{ e.display_name }} · {{ e.primary_kind }}
          </option>
        </select>
      </div>
      <div class="field">
        <label class="field__label" :for="fid('variable')">{{ t("forecast.form.targetVariable") }}</label>
        <select
          :id="fid('variable')"
          v-model="targetVariable"
          class="field__input"
          data-testid="target-variable"
          :disabled="disabled || !targetVariables.length"
          :aria-invalid="targetError ? 'true' : undefined"
          :aria-describedby="targetError ? fid('target-error') : undefined"
        >
          <option v-for="v in targetVariables" :key="v.variable_id" :value="v.variable_id">
            {{ v.variable_id }} · {{ t(`forecast.form.ownership.${v.ownership}`) }}
          </option>
        </select>
      </div>
      <div class="field fc-form__narrow">
        <label class="field__label" :for="fid('horizon')">{{ t("forecast.form.horizon") }}</label>
        <input
          :id="fid('horizon')"
          v-model.number="horizon"
          class="field__input mono"
          type="number"
          min="1"
          :max="horizonMax ?? undefined"
          step="1"
          inputmode="numeric"
          data-testid="horizon"
          :disabled="disabled"
          @input="horizonEdited = true"
          :aria-invalid="horizonError ? 'true' : undefined"
          :aria-describedby="fid('horizon-hint')"
        />
        <p :id="fid('horizon-hint')" class="fc-form__hint">
          {{ horizonMax !== null ? t("forecast.form.horizonRange", { max: horizonMax }) : t("forecast.form.horizonUnknown") }}
        </p>
      </div>
      <div class="field">
        <label class="field__label" :for="fid('scenario')">{{ t("forecast.form.scenario") }}</label>
        <input
          :id="fid('scenario')"
          v-model="scenarioId"
          class="field__input mono"
          type="text"
          maxlength="128"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('forecast.form.scenarioPlaceholder')"
          data-testid="scenario-id"
          :disabled="disabled"
          :aria-invalid="scenarioError ? 'true' : undefined"
          :aria-describedby="scenarioError ? fid('scenario-error') : undefined"
        />
      </div>
    </div>
    <p v-if="targetError" :id="fid('target-error')" class="field__error" data-testid="target-error">{{ targetError }}</p>
    <p v-if="horizonError" class="field__error" data-testid="horizon-error">{{ horizonError }}</p>
    <p v-if="scenarioError" :id="fid('scenario-error')" class="field__error" data-testid="scenario-error">{{ scenarioError }}</p>

    <div class="fc-form__builders">
      <fieldset class="fc-form__interventions" data-testid="intervention-builder">
        <legend class="eyebrow">{{ t("forecast.form.interventions") }}</legend>
        <div class="fc-form__rules" data-testid="intervention-rules">
          <p>{{ t("forecast.form.rules.input") }}</p>
          <p>{{ t("forecast.form.rules.window") }}</p>
          <p class="fc-form__unavailable" data-testid="mechanism-unavailable">{{ t("forecast.form.rules.unavailable") }}</p>
        </div>
        <p v-if="droppedKinds.length" class="field__error" data-testid="dropped-interventions">
          {{ t("forecast.form.dropped", { kinds: droppedKinds.join(", ") }) }}
        </p>

        <ol v-if="drafts.length" class="fc-form__drafts">
          <li
            v-for="(draft, index) in drafts"
            :key="draft.key"
            class="fc-draft"
            data-testid="intervention-row"
            :data-index="index"
          >
            <div class="fc-draft__head">
              <span class="mono fc-draft__kind">{{ t("forecast.form.hard", { n: index + 1 }) }}</span>
              <button
                type="button"
                class="btn btn--quiet fc-draft__remove"
                data-testid="remove-intervention"
                :disabled="disabled"
                @click="removeIntervention(draft.key)"
              >
                {{ t("forecast.form.remove") }}
              </button>
            </div>
            <div class="fc-draft__fields">
              <div class="field">
                <label class="field__label" :for="fid(`iv-${draft.key}-variable`)">{{ t("forecast.form.ivVariable") }}</label>
                <select
                  :id="fid(`iv-${draft.key}-variable`)"
                  v-model="draft.variable"
                  class="field__input"
                  data-testid="iv-variable"
                  :disabled="disabled"
                  :aria-invalid="errorsByDraft.get(draft.key)?.variable ? 'true' : undefined"
                  @change="onVariableChange(draft)"
                >
                  <option v-for="v in variables" :key="v.variable_id" :value="v.variable_id">{{ v.variable_id }}</option>
                </select>
              </div>
              <div class="field">
                <label class="field__label" :for="fid(`iv-${draft.key}-entity`)">{{ t("forecast.form.ivEntity") }}</label>
                <select
                  :id="fid(`iv-${draft.key}-entity`)"
                  v-model="draft.entityId"
                  class="field__input"
                  data-testid="iv-entity"
                  :disabled="disabled"
                  @change="onEntityChange(draft)"
                >
                  <option v-for="e in entitiesFor(draft.variable)" :key="e.entity_id" :value="e.entity_id">
                    {{ e.display_name }} · {{ e.primary_kind }}
                  </option>
                </select>
              </div>
              <div class="field">
                <label class="field__label" :for="fid(`iv-${draft.key}-value`)">{{ t("forecast.form.ivValue") }}</label>
                <select
                  :id="fid(`iv-${draft.key}-value`)"
                  v-model="draft.value"
                  class="field__input mono"
                  data-testid="iv-value"
                  :disabled="disabled"
                  :aria-invalid="errorsByDraft.get(draft.key)?.value ? 'true' : undefined"
                >
                  <option value="" disabled>{{ t("forecast.form.chooseValue") }}</option>
                  <option
                    v-if="draft.value !== '' && !(domainFor(draft.variable, draft.entityId) ?? []).includes(draft.value)"
                    :value="draft.value"
                    disabled
                    data-testid="iv-value-invalid"
                  >
                    {{ t("forecast.form.notInDomain", { value: draft.value }) }}
                  </option>
                  <option
                    v-for="value in domainFor(draft.variable, draft.entityId) ?? []"
                    :key="value"
                    :value="value"
                    data-testid="iv-value-option"
                  >
                    {{ value }}
                  </option>
                </select>
              </div>
              <div class="field fc-form__narrow">
                <label class="field__label" :for="fid(`iv-${draft.key}-start`)">{{ t("forecast.form.start") }}</label>
                <input
                  :id="fid(`iv-${draft.key}-start`)"
                  v-model.number="draft.start"
                  class="field__input mono"
                  type="number"
                  min="0"
                  step="1"
                  inputmode="numeric"
                  data-testid="iv-start"
                  :disabled="disabled"
                  :aria-invalid="errorsByDraft.get(draft.key)?.window ? 'true' : undefined"
                  :aria-describedby="fid(`iv-${draft.key}-window`)"
                />
              </div>
              <div class="field fc-form__narrow">
                <label class="field__label" :for="fid(`iv-${draft.key}-end`)">{{ t("forecast.form.end") }}</label>
                <input
                  :id="fid(`iv-${draft.key}-end`)"
                  v-model.number="draft.end"
                  class="field__input mono"
                  type="number"
                  min="1"
                  :max="Number.isInteger(horizonNumber) ? horizonNumber : undefined"
                  step="1"
                  inputmode="numeric"
                  data-testid="iv-end"
                  :disabled="disabled"
                  :aria-invalid="errorsByDraft.get(draft.key)?.window ? 'true' : undefined"
                  :aria-describedby="fid(`iv-${draft.key}-window`)"
                />
              </div>
            </div>
            <p :id="fid(`iv-${draft.key}-window`)" class="fc-draft__window mono" data-testid="iv-window">
              <template v-if="transitions(draft)">
                [{{ draft.start }}, {{ draft.end }}) · {{ t("forecast.form.transitions", { list: transitions(draft) }) }}
              </template>
            </p>
            <ul class="fc-draft__errors">
              <li v-for="(message, field) in errorsByDraft.get(draft.key)" v-show="message" :key="field" class="field__error" :data-testid="`iv-error-${field}`">
                {{ message }}
              </li>
            </ul>
          </li>
        </ol>
        <p v-else class="step-hint" data-testid="no-interventions">
          {{ evidenceDrafts.length ? t("forecast.form.noInterventionsConditional") : t("forecast.form.noInterventions") }}
        </p>
        <div>
          <button
            type="button"
            class="btn"
            data-testid="add-intervention"
            :disabled="disabled || !variables.length || drafts.length >= MAX_INTERVENTIONS"
            @click="addIntervention"
          >
            {{ t("forecast.form.add") }}
          </button>
        </div>
      </fieldset>

      <fieldset class="fc-form__interventions fc-form__evidence" data-testid="evidence-builder">
        <legend class="eyebrow">{{ t("forecast.form.evidence.heading") }}</legend>
        <div class="fc-form__rules" data-testid="evidence-rules">
          <p class="fc-form__principle" data-testid="evidence-principle">{{ t("forecast.form.evidence.rule") }}</p>
          <p>{{ t("forecast.form.evidence.detail") }}</p>
        </div>

        <ol v-if="evidenceDrafts.length" class="fc-form__drafts">
          <li
            v-for="(draft, index) in evidenceDrafts"
            :key="draft.key"
            class="fc-draft fc-draft--evidence"
            data-testid="evidence-row"
            :data-index="index"
          >
            <div class="fc-draft__head">
              <span class="mono fc-draft__kind">{{ t("forecast.form.evidence.row", { n: index + 1 }) }}</span>
              <button
                type="button"
                class="btn btn--quiet fc-draft__remove"
                data-testid="remove-evidence"
                :disabled="disabled"
                @click="removeEvidence(draft.key)"
              >
                {{ t("forecast.form.remove") }}
              </button>
            </div>
            <div class="fc-draft__fields">
              <div class="field">
                <label class="field__label" :for="fid(`ev-${draft.key}-variable`)">{{ t("forecast.form.ivVariable") }}</label>
                <select
                  :id="fid(`ev-${draft.key}-variable`)"
                  v-model="draft.variable"
                  class="field__input"
                  data-testid="ev-variable"
                  :disabled="disabled"
                  :aria-invalid="errorsByEvidence.get(draft.key)?.variable ? 'true' : undefined"
                  @change="onVariableChange(draft)"
                >
                  <option v-for="v in variables" :key="v.variable_id" :value="v.variable_id">{{ v.variable_id }}</option>
                </select>
              </div>
              <div class="field">
                <label class="field__label" :for="fid(`ev-${draft.key}-entity`)">{{ t("forecast.form.ivEntity") }}</label>
                <select
                  :id="fid(`ev-${draft.key}-entity`)"
                  v-model="draft.entityId"
                  class="field__input"
                  data-testid="ev-entity"
                  :disabled="disabled"
                  @change="onEntityChange(draft)"
                >
                  <option v-for="e in entitiesFor(draft.variable)" :key="e.entity_id" :value="e.entity_id">
                    {{ e.display_name }} · {{ e.primary_kind }}
                  </option>
                </select>
              </div>
              <div class="field fc-form__narrow">
                <label class="field__label" :for="fid(`ev-${draft.key}-time`)">{{ t("forecast.form.evidence.time") }}</label>
                <input
                  :id="fid(`ev-${draft.key}-time`)"
                  v-model.number="draft.time"
                  class="field__input mono"
                  type="number"
                  min="0"
                  :max="horizonMax ?? undefined"
                  step="1"
                  inputmode="numeric"
                  data-testid="ev-time"
                  :disabled="disabled"
                  :aria-invalid="errorsByEvidence.get(draft.key)?.time || errorsByEvidence.get(draft.key)?.key ? 'true' : undefined"
                />
              </div>
              <div class="field">
                <label class="field__label" :for="fid(`ev-${draft.key}-value`)">{{ t("forecast.form.evidence.value") }}</label>
                <select
                  :id="fid(`ev-${draft.key}-value`)"
                  v-model="draft.value"
                  class="field__input mono"
                  data-testid="ev-value"
                  :disabled="disabled"
                  :aria-invalid="errorsByEvidence.get(draft.key)?.value ? 'true' : undefined"
                >
                  <option value="" disabled>{{ t("forecast.form.chooseValue") }}</option>
                  <option
                    v-if="draft.value !== '' && !(domainFor(draft.variable, draft.entityId) ?? []).includes(draft.value)"
                    :value="draft.value"
                    disabled
                    data-testid="ev-value-invalid"
                  >
                    {{ t("forecast.form.notInDomain", { value: draft.value }) }}
                  </option>
                  <option
                    v-for="value in domainFor(draft.variable, draft.entityId) ?? []"
                    :key="value"
                    :value="value"
                    data-testid="ev-value-option"
                  >
                    {{ value }}
                  </option>
                </select>
              </div>
            </div>
            <ul class="fc-draft__errors">
              <li v-for="(message, field) in errorsByEvidence.get(draft.key)" v-show="message" :key="field" class="field__error" :data-testid="`ev-error-${field}`">
                {{ message }}
              </li>
            </ul>
          </li>
        </ol>
        <p v-else class="step-hint" data-testid="no-evidence">{{ t("forecast.form.evidence.none") }}</p>
        <div>
          <button
            type="button"
            class="btn"
            data-testid="add-evidence"
            :disabled="disabled || !variables.length || evidenceDrafts.length >= MAX_EVIDENCE"
            @click="addEvidence"
          >
            {{ t("forecast.form.evidence.add") }}
          </button>
        </div>
      </fieldset>
    </div>

    <div class="fc-form__submit">
      <button type="submit" class="btn btn--primary" data-testid="submit-forecast" :disabled="!canSubmit">
        {{ busy ? t("forecast.form.running") : (submitLabel ?? t("forecast.form.submit")) }}
      </button>
      <span class="step-hint mono" data-testid="query-kind">{{ queryKindLabel }}</span>
      <p v-if="attempted && hasErrors" class="field__error" role="alert" data-testid="form-blocked">
        {{ t("forecast.form.errors.blocked") }}
      </p>
    </div>
  </form>
</template>

<style scoped>
.fc-form {
  display: grid;
  gap: var(--c2p-space-4);
  min-width: 0;
}

.fc-form__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
  gap: var(--c2p-space-3) var(--c2p-space-4);
  align-items: start;
}

.fc-form--compact {
  gap: var(--c2p-space-3);
}

.fc-form__hint {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.fc-form .field__input {
  padding: var(--c2p-space-2) var(--c2p-space-3);
}

.fc-form__interventions {
  display: grid;
  gap: var(--c2p-space-3);
  min-width: 0;
  margin: 0;
  padding: var(--c2p-space-3) var(--c2p-space-4) var(--c2p-space-4);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
}

.fc-form__interventions legend {
  padding: 0 var(--c2p-space-2);
}

/* The intervention and evidence builders sit side by side when there is room. */
.fc-form__builders {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 30rem), 1fr));
  gap: var(--c2p-space-4);
  align-items: start;
  min-width: 0;
}

.fc-form__principle {
  padding-left: var(--c2p-space-2);
  border-left: 2px solid var(--c2p-series-baseline);
  color: var(--c2p-text);
}

.fc-form__rules {
  display: grid;
  gap: var(--c2p-space-1);
  max-width: 48rem;
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.fc-form__unavailable {
  padding-left: var(--c2p-space-2);
  border-left: 2px solid var(--c2p-warning);
}

.fc-form__drafts {
  display: grid;
  gap: var(--c2p-space-3);
}

.fc-draft {
  display: grid;
  gap: var(--c2p-space-2);
  padding: var(--c2p-space-3);
  border-left: 2px solid var(--c2p-series-intervention);
  background: var(--c2p-surface);
}

.fc-draft--evidence {
  border-left-color: var(--c2p-series-baseline);
}

.fc-draft__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--c2p-space-2);
}

.fc-draft__kind {
  font-size: var(--c2p-text-xs);
  font-weight: 600;
}

.fc-draft__remove {
  min-height: 2rem;
}

.fc-draft__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr));
  gap: var(--c2p-space-2) var(--c2p-space-3);
  align-items: end;
}

.fc-draft__window {
  min-height: 1.2em;
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.fc-draft__errors {
  display: grid;
  gap: var(--c2p-space-1);
}

.fc-form__submit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-2) var(--c2p-space-4);
}

.fc-form__submit .field__error {
  flex-basis: 100%;
}
</style>
