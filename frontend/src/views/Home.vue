<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { Project, ProjectSummary } from "../api/types";
import { listProjects } from "../api/world";
import NewProjectForm from "../components/NewProjectForm.vue";
import ProjectList from "../components/ProjectList.vue";
import { projectStore } from "../store/project";

const { t } = useI18n();
const router = useRouter();

const projects = ref<ProjectSummary[]>([]);
const loading = ref(false);
const listError = ref<unknown>(null);

async function loadProjects(): Promise<void> {
  loading.value = true;
  listError.value = null;
  try {
    projects.value = await listProjects();
  } catch (error) {
    listError.value = error;
  } finally {
    loading.value = false;
  }
}

function onCreated(project: Project): void {
  projectStore.setProject(project);
  void router.push({ name: "process", params: { projectId: project.project_id } });
}

onMounted(loadProjects);
</script>

<template>
  <div class="page home">
    <section class="hero">
      <p class="eyebrow">{{ t("home.eyebrow") }}</p>
      <h1 class="hero__title">{{ t("app.name") }}</h1>
      <p class="hero__lede">{{ t("home.description") }}</p>
    </section>

    <div class="home__grid">
      <section class="panel" aria-labelledby="new-project-heading">
        <header class="panel__header">
          <span class="badge badge--solid" aria-hidden="true">01</span>
          <h2 id="new-project-heading" class="panel__title">{{ t("home.newProject.heading") }}</h2>
        </header>
        <NewProjectForm @created="onCreated" />
      </section>

      <section class="panel" aria-labelledby="projects-heading">
        <header class="panel__header">
          <span class="badge" aria-hidden="true">02</span>
          <h2 id="projects-heading" class="panel__title">{{ t("home.projects.heading") }}</h2>
          <button
            type="button"
            class="btn btn--quiet panel__action"
            data-testid="refresh-projects"
            :disabled="loading"
            @click="loadProjects"
          >
            {{ t("common.refresh") }}
          </button>
        </header>
        <ProjectList :projects="projects" :loading="loading" :error="listError" @retry="loadProjects" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.hero {
  display: grid;
  gap: var(--c2p-space-4);
  max-width: 48rem;
  padding: var(--c2p-space-6) 0 var(--c2p-space-7);
}

.hero__title {
  font-size: var(--c2p-text-hero);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.05;
  overflow-wrap: anywhere;
}

.hero__lede {
  max-width: 40rem;
  color: var(--c2p-text-muted);
  font-size: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
}

.home__grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--c2p-space-7);
}

@media (min-width: 56rem) {
  .home__grid {
    grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
    gap: var(--c2p-space-7) var(--c2p-space-8);
  }
}
</style>
