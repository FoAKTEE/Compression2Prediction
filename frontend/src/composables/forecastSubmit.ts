import { ref, type Ref } from "vue";
import { normalizeError } from "../api/client";
import { getRun, runForecast } from "../api/forecast";
import { pollTask } from "../api/tasks";
import type { ForecastRequest, ForecastResult } from "../api/types";
import { exampleRunFor } from "../components/forecast/examples";
import { errorNotice, type ErrorNoticeContent } from "./errorNotice";
import type { ForecastContext } from "./forecastContext";

/** A rejected forecast request, shown inline with the server's own message. */
export interface SubmitProblem {
  title: string;
  detail: string;
  code: string;
}

export interface ForecastSubmit {
  submitting: Ref<boolean>;
  problem: Ref<SubmitProblem | null>;
  notice: Ref<ErrorNoticeContent | null>;
  /** Offline, a request that matches no bundled run has no result. */
  demoMiss: Ref<boolean>;
  submit: (request: ForecastRequest) => Promise<ForecastResult | null>;
}

/** A run executing as a task is polled once a second for up to ten minutes. */
const RUN_POLL = { intervalMs: 1_000, maxAttempts: 600 } as const;

/**
 * Posts a forecast request and records the run in the context. A 409
 * (`model_not_compiled`), 422 (bad target, horizon, window, or value), or 501
 * (a non-hard intervention) is explained inline; other failures become a notice.
 */
export function useForecastSubmit(
  ctx: ForecastContext,
  options: { projectId: () => string | null; t: (key: string) => string },
): ForecastSubmit {
  const submitting = ref(false);
  const problem = ref<SubmitProblem | null>(null);
  const notice = ref<ErrorNoticeContent | null>(null);
  const demoMiss = ref(false);
  const { t } = options;

  async function submit(request: ForecastRequest): Promise<ForecastResult | null> {
    problem.value = null;
    notice.value = null;
    demoMiss.value = false;
    if (ctx.isDemo) {
      const bundled = exampleRunFor(request);
      if (bundled === null) demoMiss.value = true;
      else ctx.addRun(bundled);
      return bundled;
    }
    const id = options.projectId();
    if (id === null || submitting.value) return null;
    submitting.value = true;
    try {
      let result = await runForecast(id, request);
      if ((result.status === "pending" || result.status === "running") && result.task_id) {
        await pollTask(result.task_id, RUN_POLL);
        result = await getRun(id, result.run_id);
      }
      ctx.addRun(result);
      return result;
    } catch (caught) {
      const e = normalizeError(caught);
      if (e.code === "model_not_compiled") problem.value = { title: t("forecast.errors.notCompiled"), detail: e.message, code: e.code };
      else if (e.status === 422) problem.value = { title: t("forecast.errors.rejected"), detail: e.message, code: e.code };
      else if (e.status === 501) problem.value = { title: t("forecast.errors.notImplemented"), detail: e.message, code: e.code };
      else if (e.status === 409) problem.value = { title: t("forecast.errors.conflict"), detail: e.message, code: e.code };
      else notice.value = errorNotice(e, t);
      return null;
    } finally {
      submitting.value = false;
    }
  }

  return { submitting, problem, notice, demoMiss, submit };
}
