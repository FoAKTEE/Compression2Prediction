<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { Project } from "../api/types";
import { createProject } from "../api/world";
import { errorNotice } from "../composables/errorNotice";
import { htmlLang, isLocale } from "../i18n";
import StateNotice from "./StateNotice.vue";

const ACCEPT = ".txt,.md,.markdown,.json,.csv,text/plain,text/markdown,application/json,text/csv";
const NAME_MAX = 200;
const QUESTION_MAX = 2000;

const emit = defineEmits<{ created: [project: Project] }>();
const { t, locale } = useI18n();

const name = ref("");
const question = ref("");
const files = ref<File[]>([]);
const submitting = ref(false);
const attempted = ref(false);
const failure = ref<unknown>(null);
const dragging = ref(false);

type Field = "name" | "question" | "files";

const errors = computed<Record<Field, string | null>>(() => ({
  name: name.value.trim() ? null : "home.newProject.errors.nameRequired",
  question: question.value.trim() ? null : "home.newProject.errors.questionRequired",
  files: files.value.length > 0 ? null : "home.newProject.errors.filesRequired",
}));

const isValid = computed(() => Object.values(errors.value).every((error) => error === null));
const notice = computed(() => (failure.value === null ? null : errorNotice(failure.value, t)));

function shownError(field: Field): string | null {
  const key = errors.value[field];
  return attempted.value && key ? t(key) : null;
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function addFiles(list: FileList | null | undefined): void {
  if (!list) return;
  const known = new Set(files.value.map(fileKey));
  const added = Array.from(list).filter((file) => !known.has(fileKey(file)));
  files.value = [...files.value, ...added];
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  addFiles(input.files);
  input.value = "";
}

function onDrop(event: DragEvent): void {
  dragging.value = false;
  addFiles(event.dataTransfer?.files);
}

function removeFile(index: number): void {
  files.value = files.value.filter((_, i) => i !== index);
}

function formatSize(bytes: number): string {
  const tag = isLocale(locale.value) ? htmlLang(locale.value) : undefined;
  const kilobytes = bytes / 1024;
  const unit = kilobytes >= 1024 ? "megabyte" : "kilobyte";
  const value = unit === "megabyte" ? kilobytes / 1024 : kilobytes;
  return new Intl.NumberFormat(tag, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: 1 }).format(
    value,
  );
}

async function submit(): Promise<void> {
  attempted.value = true;
  if (!isValid.value || submitting.value) return;
  submitting.value = true;
  failure.value = null;
  try {
    const project = await createProject({
      name: name.value.trim(),
      prediction_question: question.value.trim(),
      files: files.value,
    });
    name.value = "";
    question.value = "";
    files.value = [];
    attempted.value = false;
    emit("created", project);
  } catch (error) {
    failure.value = error;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form class="new-project" novalidate data-testid="new-project-form" @submit.prevent="submit">
    <p class="new-project__intro">{{ t("home.newProject.intro") }}</p>

    <div class="field">
      <label class="field__label" for="np-name">{{ t("home.newProject.name") }}</label>
      <input
        id="np-name"
        v-model="name"
        class="field__input"
        type="text"
        name="name"
        autocomplete="off"
        :maxlength="NAME_MAX"
        :placeholder="t('home.newProject.namePlaceholder')"
        :aria-invalid="shownError('name') ? 'true' : undefined"
        :aria-describedby="shownError('name') ? 'np-name-error' : undefined"
      />
      <p v-if="shownError('name')" id="np-name-error" class="field__error">{{ shownError("name") }}</p>
    </div>

    <div class="field">
      <label class="field__label" for="np-question">{{ t("home.newProject.question") }}</label>
      <textarea
        id="np-question"
        v-model="question"
        class="field__input new-project__question"
        name="prediction_question"
        rows="3"
        :maxlength="QUESTION_MAX"
        :placeholder="t('home.newProject.questionPlaceholder')"
        :aria-invalid="shownError('question') ? 'true' : undefined"
        :aria-describedby="shownError('question') ? 'np-question-error' : undefined"
      ></textarea>
      <p v-if="shownError('question')" id="np-question-error" class="field__error">{{ shownError("question") }}</p>
    </div>

    <div class="field">
      <span id="np-files-label" class="field__label">{{ t("home.newProject.files") }}</span>
      <div
        class="dropzone"
        :class="{ 'is-dragging': dragging }"
        @dragenter.prevent="dragging = true"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <p class="dropzone__hint">{{ t("home.newProject.filesHint") }}</p>
        <div class="dropzone__row">
          <input
            id="np-files"
            class="sr-only"
            type="file"
            name="files"
            multiple
            :accept="ACCEPT"
            aria-labelledby="np-files-label np-files-browse"
            :aria-describedby="shownError('files') ? 'np-files-error' : undefined"
            @change="onFileChange"
          />
          <label id="np-files-browse" class="btn" for="np-files">{{ t("home.newProject.browse") }}</label>
          <span class="dropzone__count mono" aria-live="polite">
            {{ t("home.newProject.selected", files.length) }}
          </span>
        </div>
      </div>
      <ul v-if="files.length" class="file-list">
        <li v-for="(file, index) in files" :key="fileKey(file)" class="file-list__item">
          <span class="file-list__name">{{ file.name }}</span>
          <span class="file-list__size mono">{{ formatSize(file.size) }}</span>
          <button
            type="button"
            class="btn btn--quiet file-list__remove"
            :aria-label="t('common.remove', { name: file.name })"
            @click="removeFile(index)"
          >
            <span aria-hidden="true">×</span>
          </button>
        </li>
      </ul>
      <p v-if="shownError('files')" id="np-files-error" class="field__error">{{ shownError("files") }}</p>
    </div>

    <StateNotice
      v-if="notice"
      compact
      data-testid="create-error"
      :variant="notice.variant"
      :title="notice.title"
      :body="notice.body"
    />

    <div class="new-project__actions">
      <button type="submit" class="btn btn--primary" :disabled="submitting" data-testid="create-project">
        {{ submitting ? t("home.newProject.submitting") : t("home.newProject.submit") }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.new-project {
  display: grid;
  gap: var(--c2p-space-5);
  min-width: 0;
}

.new-project__intro {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.new-project__question {
  resize: vertical;
  min-height: 5.5rem;
}

.dropzone {
  display: grid;
  gap: var(--c2p-space-3);
  padding: var(--c2p-space-4);
  border: var(--c2p-rule-width) dashed var(--c2p-rule);
  border-radius: var(--c2p-radius);
  transition:
    border-color var(--c2p-transition),
    background var(--c2p-transition);
}

.dropzone.is-dragging {
  border-color: var(--c2p-rule-strong);
  background: var(--c2p-surface);
}

.dropzone__hint {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-sm);
}

.dropzone__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--c2p-space-3);
}

.dropzone__row input:focus-visible + label {
  outline: 2px solid var(--c2p-focus);
  outline-offset: 2px;
}

.dropzone__count {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.file-list {
  display: grid;
  border-top: var(--c2p-rule-width) solid var(--c2p-rule);
}

.file-list__item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: var(--c2p-space-3);
  align-items: center;
  padding: var(--c2p-space-1) 0;
  border-bottom: var(--c2p-rule-width) solid var(--c2p-rule);
}

.file-list__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--c2p-text-sm);
}

.file-list__size {
  color: var(--c2p-text-muted);
  font-size: var(--c2p-text-xs);
}

.file-list__remove {
  min-height: 2rem;
  padding: 0 var(--c2p-space-2);
}

.new-project__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
