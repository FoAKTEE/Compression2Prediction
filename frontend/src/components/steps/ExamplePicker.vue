<script setup lang="ts">
import { computed, onMounted, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { listExamples } from "../../api/examples";
import type { ExampleSummary } from "../../api/types";
import { errorNotice } from "../../composables/errorNotice";
import StateNotice from "../StateNotice.vue";

/** Lists `GET /api/examples` and lets the user pick one; the parent loads the chosen example. */
withDefaults(defineProps<{ confirmLabel: string; busy?: boolean }>(), { busy: false });
const emit = defineEmits<{ choose: [name: string]; cancel: [] }>();
const { t } = useI18n();
const groupName = `example-${useId()}`;

const examples = ref<ExampleSummary[]>([]);
const loading = ref(true);
const failure = ref<unknown>(null);
const selected = ref<string | null>(null);

const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));

async function load(): Promise<void> {
  loading.value = true;
  failure.value = null;
  try {
    examples.value = await listExamples();
    selected.value = examples.value[0]?.name ?? null;
  } catch (error) {
    failure.value = error;
  } finally {
    loading.value = false;
  }
}

function confirm(): void {
  if (selected.value !== null) emit("choose", selected.value);
}

onMounted(load);
</script>

<template>
  <section class="picker" data-testid="example-picker" :aria-label="t('examples.picker.label')">
    <h4 class="eyebrow">{{ t("examples.picker.heading") }}</h4>
    <p v-if="loading" class="picker__muted">{{ t("examples.picker.loading") }}</p>
    <StateNotice
      v-else-if="notice"
      compact
      data-testid="example-picker-error"
      :variant="notice.variant"
      :title="notice.title"
      :body="notice.body"
      :action-label="t('common.retry')"
      @action="load"
    />
    <p v-else-if="examples.length === 0" class="picker__muted" data-testid="example-picker-empty">
      {{ t("examples.picker.empty") }}
    </p>
    <ul v-else class="picker__list">
      <li v-for="example in examples" :key="example.name">
        <label class="picker__option" :class="{ 'is-selected': selected === example.name }">
          <input
            v-model="selected"
            type="radio"
            :name="groupName"
            :value="example.name"
            data-testid="example-option"
            :data-example="example.name"
          />
          <span class="picker__text">
            <span class="picker__title">{{ example.title }}</span>
            <span class="picker__description">{{ example.description }}</span>
            <span class="picker__name mono">{{ example.name }}</span>
          </span>
        </label>
      </li>
    </ul>
    <div class="picker__actions">
      <button
        type="button"
        class="btn btn--primary"
        data-testid="example-confirm"
        :disabled="selected === null || busy || loading"
        @click="confirm"
      >
        {{ busy ? t("examples.picker.loadingExample") : confirmLabel }}
      </button>
      <button type="button" class="btn btn--quiet" data-testid="example-cancel" @click="emit('cancel')">
        {{ t("common.cancel") }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.picker {
  display: grid;
  gap: var(--c2p-space-3);
  padding: var(--c2p-space-4);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  background: var(--c2p-bg);
}

.picker__muted {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.picker__list {
  display: grid;
  gap: var(--c2p-space-2);
}

.picker__option {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--c2p-space-3);
  align-items: start;
  padding: var(--c2p-space-3);
  border: var(--c2p-rule-width) solid var(--c2p-rule);
  border-radius: var(--c2p-radius);
  cursor: pointer;
}

.picker__option.is-selected {
  border-color: var(--c2p-rule-strong);
}

.picker__option input {
  margin: 0.2rem 0 0;
  accent-color: var(--c2p-ink);
}

.picker__text {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}

.picker__title {
  font-weight: 600;
}

.picker__description {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.picker__name {
  color: var(--c2p-text-faint);
  font-size: var(--c2p-text-xs);
  overflow-wrap: anywhere;
}

.picker__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--c2p-space-2);
}
</style>
