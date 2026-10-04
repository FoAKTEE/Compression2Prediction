/**
 * Query dispatch (guide §8): observational, conditional, and model-based
 * interventional queries. Conditioning never edits mechanisms; interventions
 * go through surgery. Individual counterfactuals are rejected (guide §8.4).
 */
import type { Budget, Plan } from "../causal/compiler.js";
import type { VariableKey } from "../causal/hypergraph.js";
import { ValueError } from "../errors.js";
import { asLiteral, isPlainObject, requireFields } from "../store/records.js";
import { repr } from "../store/repr.js";
import { exactQuery, QUERY_KINDS } from "./exact.js";
import type { EvidencePair, ExactResult, Prior, QueryKind } from "./exact.js";
import { applyInterventions } from "./interventions.js";
import type { Intervention } from "./interventions.js";
import { isInterventionNode } from "./plan.js";

export const UNSUPPORTED_COUNTERFACTUAL = "unsupported_counterfactual";

export interface QueryRequest {
  readonly query_kind: QueryKind | "counterfactual";
  readonly target: VariableKey;
  readonly evidence?: readonly EvidencePair[];
  readonly initial: readonly Prior[];
  readonly budget: Budget;
  readonly interventions?: readonly Intervention[];
}

export interface QueryResult extends ExactResult {
  /** Hash of the plan actually queried (the intervened plan for interventional queries). */
  readonly model_hash: string;
}

const REQUIRED = Object.freeze(["query_kind", "target", "initial", "budget"]);
const OPTIONAL = Object.freeze(["evidence", "interventions"]);

function list(value: unknown, field: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValueError(`${field}: expected an array, got ${repr(value)}`);
  return value;
}

/**
 * Run one query. Interventional results are ``model_based_intervention``,
 * never ``identified_causal_effect``: identification is out of scope. An
 * interventional query may also condition on evidence in the intervened model.
 */
export function runQuery(plan: Plan, request: QueryRequest): QueryResult {
  if (!isPlainObject(request)) throw new ValueError(`query request: expected an object, got ${repr(request)}`);
  // Before field checks, so a counterfactual request is never misreported.
  if (request.query_kind === "counterfactual") {
    throw new ValueError(
      `${UNSUPPORTED_COUNTERFACTUAL}: individual counterfactuals need structural equations, a joint law of the ` +
        "exogenous noise, and abduction from the factual evidence (guide §8.4); none is supported",
    );
  }
  const o = requireFields(request, REQUIRED, OPTIONAL, { name: "query request" });
  const kind = asLiteral(o.query_kind, "query_kind", QUERY_KINDS);
  const evidence = list(o.evidence, "evidence") as readonly EvidencePair[];
  const interventions = list(o.interventions, "interventions") as readonly Intervention[];
  if (kind !== "interventional") {
    if (interventions.length > 0) throw new ValueError(`a ${kind} query takes no interventions; use 'interventional'`);
    if (plan.nodes.some(isInterventionNode)) {
      throw new ValueError(`the plan carries interventions; a ${kind} query needs an unmodified plan`);
    }
  }
  if (kind === "observational" && evidence.length > 0) {
    throw new ValueError("an observational query takes no evidence; use 'conditional'");
  }
  if (kind === "conditional" && evidence.length === 0) throw new ValueError("a conditional query needs evidence");
  if (kind === "interventional" && interventions.length === 0) {
    throw new ValueError("an interventional query needs at least one intervention");
  }
  const queried = kind === "interventional" ? applyInterventions(plan, interventions) : plan;
  const result = exactQuery(queried, {
    target: o.target as VariableKey,
    evidence,
    initial: o.initial as readonly Prior[],
    budget: o.budget as Budget,
  });
  return Object.freeze({
    distribution: result.distribution,
    space: result.space,
    query_kind: kind,
    effect_status: kind === "interventional" ? "model_based_intervention" : "not_applicable",
    model_hash: queried.model_hash,
  });
}
