/**
 * Small exact DAG fixtures for slicing, particles, ranking, and influence.
 *
 * A model lists source priors and writers with exact rational rows; ``modelPlan``
 * builds a Plan directly from PlanNodes (float kernels from the same rows), and
 * ``exactRational`` marginalizes the model exactly, with optional clamps.
 */
import { FamilyKey, graphHash, MechanismInstance, Plan, PlanNode, variableKey, variableKeyString } from "../../src/causal/index.js";
import type { VariableKey } from "../../src/causal/index.js";
import type { Prior } from "../../src/inference/index.js";
import { contentHash, Kernel, productAll, Rational, Space } from "../../src/index.js";

export const BIT = new Space("Bit", ["0", "1"]);
export const SCENARIO = "scn_rank";
export const ENTITY = "ent_rank";

export const R = (n: number, d = 1): Rational => Rational.of(n, d);
export const ONE = Rational.ONE;
export const ZERO = Rational.ZERO;

export const key = (name: string, tick: number, entity = ENTITY): VariableKey => variableKey(SCENARIO, name, entity, tick);

export interface RootSpec {
  readonly name: string;
  readonly tick: number;
  readonly prior: readonly Rational[];
  readonly space?: Space;
}

export interface WriterSpec {
  readonly name: string;
  readonly tick: number;
  /** Ordered input ports: (variable name, tick). */
  readonly inputs: readonly (readonly [string, number])[];
  /** Exact rows over the left-folded input product, right factor fastest. */
  readonly rows: readonly (readonly Rational[])[];
  readonly space?: Space;
  readonly kernelRef?: string;
}

export interface ExactModel {
  readonly roots: readonly RootSpec[];
  /** Topological order. */
  readonly writers: readonly WriterSpec[];
}

const IFACE = contentHash({ schema: "fixture.interface.v1" });

export function fixtureFamily(name: string): FamilyKey {
  return new FamilyKey({
    template: `t_${name}`,
    kind: "Person",
    role: "Member",
    interface_hash: IFACE,
    regime: "default",
    data_origin_partition: "hand_specified",
  });
}

function spaceOf(model: ExactModel, name: string): Space {
  const root = model.roots.find((r) => r.name === name);
  if (root !== undefined) return root.space ?? BIT;
  const writer = model.writers.find((w) => w.name === name);
  if (writer === undefined) throw new Error(`unknown variable ${name}`);
  return writer.space ?? BIT;
}

export const floats = (row: readonly Rational[]): number[] => row.map((p) => p.toNumber());

export function writerNode(model: ExactModel, spec: WriterSpec): PlanNode {
  const inputSpaces = spec.inputs.map(([name]) => spaceOf(model, name));
  const output_space = spec.space ?? BIT;
  return new PlanNode({
    mechanism_id: `m_${spec.name}`,
    family_key: fixtureFamily(spec.name),
    kernel_ref: spec.kernelRef ?? `kernel_${spec.name}.v1`,
    inputs: spec.inputs.map(([name, tick]) => key(name, tick)),
    input_spaces: inputSpaces,
    output: key(spec.name, spec.tick),
    output_space,
    operator: new Kernel(productAll(inputSpaces), output_space, spec.rows.map(floats)),
  });
}

/** Plan over ``nodes`` in the given (topological) order. */
export function planOf(nodes: readonly PlanNode[]): Plan {
  const graph_hash = graphHash(
    nodes.map(
      (n) =>
        new MechanismInstance({ mechanism_id: n.mechanism_id, family_key: n.family_key, inputs: n.inputs, output: n.output, kernel_ref: n.kernel_ref }),
    ),
  );
  const model_hash = contentHash({
    schema: "fixture.plan.v1",
    graph_hash,
    kernels: [...nodes]
      .sort((a, b) => (variableKeyString(a.output) < variableKeyString(b.output) ? -1 : 1))
      .map((n) => ({ output: [...n.output], rows: n.operator.rows.map((r) => [...r]) })),
  });
  return new Plan({ nodes, graph_hash, model_hash });
}

export function modelPlan(model: ExactModel): Plan {
  return planOf(model.writers.map((w) => writerNode(model, w)));
}

export function priors(model: ExactModel): Prior[] {
  return model.roots.map((r) => [key(r.name, r.tick), floats(r.prior)] as const);
}

/** Exact distribution of ``target``; ``clamps`` maps a variable name to a value index (a point mass). */
export function exactRational(model: ExactModel, target: string, clamps: ReadonlyMap<string, number> = new Map()): Rational[] {
  type State = Map<string, number>;
  let law: [State, Rational][] = [[new Map(), ONE]];
  const point = (size: number, v: number): Rational[] => Array.from({ length: size }, (_, i) => (i === v ? ONE : ZERO));
  const step = (name: string, size: number, rowOf: (s: State) => readonly Rational[]): void => {
    const next: [State, Rational][] = [];
    for (const [state, mass] of law) {
      const row = clamps.has(name) ? point(size, clamps.get(name)!) : rowOf(state);
      row.forEach((p, v) => {
        if (!p.isZero()) next.push([new Map(state).set(name, v), mass.mul(p)]);
      });
    }
    law = next;
  };
  for (const root of model.roots) step(root.name, (root.space ?? BIT).values.length, () => root.prior);
  for (const w of model.writers) {
    const sizes = w.inputs.map(([name]) => spaceOf(model, name).values.length);
    step(w.name, (w.space ?? BIT).values.length, (state) => {
      let c = 0;
      w.inputs.forEach(([name], p) => {
        c = c * sizes[p]! + state.get(name)!;
      });
      return w.rows[c]!;
    });
  }
  const size = spaceOf(model, target).values.length;
  const out = Array.from({ length: size }, () => ZERO);
  for (const [state, mass] of law) out[state.get(target)!] = out[state.get(target)!]!.add(mass);
  return out;
}

export const tvRational = (a: readonly Rational[], b: readonly Rational[]): Rational =>
  a.reduce((acc, p, i) => acc.add(p.sub(b[i]!).abs()), ZERO).div(R(2));

/** Binary row [1 - p, p]. */
export const bern = (p: Rational): Rational[] => [ONE.sub(p), p];
const IDENTITY_ROWS = [bern(ZERO), bern(ONE)];
const FAIR = bern(R(1, 2));

/** Rows of a binary child over binary parents with P(child = 1 | x) = f(x), x in left-folded order. */
export function binaryRows(arity: number, f: (...x: number[]) => Rational): Rational[][] {
  const rows: Rational[][] = [];
  for (let c = 0; c < 2 ** arity; c++) {
    const x = Array.from({ length: arity }, (_, i) => (c >> (arity - 1 - i)) & 1);
    rows.push(bern(f(...x)));
  }
  return rows;
}

/** Memo §5.2: fair roots H, S; U = H, V = H; P(T = 1 | u, v, s) = 0.1 + 0.8 s. */
export function hubModel(tRow: (u: number, v: number, s: number) => Rational = (_u, _v, s) => R(1, 10).add(R(4, 5).mul(R(s)))): ExactModel {
  return {
    roots: [
      { name: "H", tick: 0, prior: FAIR },
      { name: "S", tick: 0, prior: FAIR },
    ],
    writers: [
      { name: "U", tick: 1, inputs: [["H", 0]], rows: IDENTITY_ROWS },
      { name: "V", tick: 1, inputs: [["H", 0]], rows: IDENTITY_ROWS },
      { name: "T", tick: 2, inputs: [["U", 1], ["V", 1], ["S", 0]], rows: binaryRows(3, tRow) },
    ],
  };
}

/** Memo §5.2 second check: shared root R, A = B = R, P(T = 1 | a, b) = 0.1 + 0.2 a + 0.3 b. */
export function diamondModel(): ExactModel {
  return {
    roots: [{ name: "R", tick: 0, prior: FAIR }],
    writers: [
      { name: "A", tick: 1, inputs: [["R", 0]], rows: IDENTITY_ROWS },
      { name: "B", tick: 1, inputs: [["R", 0]], rows: IDENTITY_ROWS },
      { name: "T", tick: 2, inputs: [["A", 1], ["B", 1]], rows: binaryRows(2, (a, b) => R(1, 10).add(R(a, 5)).add(R(3 * b, 10))) },
    ],
  };
}

export const NOISY_ROWS = [bern(R(1, 10)), bern(R(4, 5))];

/**
 * Two branches under a shared initial cause Z, plus unrelated and downstream writers:
 * A1 = noisy(Z), A2 = noisy(A1) (target branch); B1 = noisy(Z), B2 = f(B1, W) (evidence branch);
 * C1 = noisy(Q) (unrelated); D = f(A2, C1) (a barren descendant).
 */
export function branchModel(): ExactModel {
  return {
    roots: [
      { name: "Z", tick: 0, prior: bern(R(3, 10)) },
      { name: "W", tick: 0, prior: bern(R(1, 4)) },
      { name: "Q", tick: 0, prior: FAIR },
    ],
    writers: [
      { name: "A1", tick: 1, inputs: [["Z", 0]], rows: NOISY_ROWS },
      { name: "B1", tick: 1, inputs: [["Z", 0]], rows: [bern(R(1, 5)), bern(R(7, 10))] },
      { name: "C1", tick: 1, inputs: [["Q", 0]], rows: NOISY_ROWS },
      { name: "A2", tick: 2, inputs: [["A1", 1]], rows: [bern(R(1, 4)), bern(R(9, 10))] },
      { name: "B2", tick: 2, inputs: [["B1", 1], ["W", 0]], rows: binaryRows(2, (b, w) => R(1, 10).add(R(3 * b, 5)).add(R(w, 5))) },
      { name: "D", tick: 3, inputs: [["A2", 2], ["C1", 1]], rows: binaryRows(2, (a, c) => R(a + c + 1, 4)) },
    ],
  };
}

/** Shared cause Z read by A and B through ``rows``, and an identity pair node P = (A, B) over Bit*Bit. */
export function pairModel(rows: readonly (readonly Rational[])[] = IDENTITY_ROWS, prior: readonly Rational[] = FAIR): ExactModel {
  const pair = productAll([BIT, BIT]);
  const identity4 = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => (i === j ? ONE : ZERO)));
  return {
    roots: [{ name: "Z", tick: 0, prior }],
    writers: [
      { name: "A", tick: 1, inputs: [["Z", 0]], rows },
      { name: "B", tick: 1, inputs: [["Z", 0]], rows },
      { name: "P", tick: 1, inputs: [["A", 1], ["B", 1]], rows: identity4, space: pair },
    ],
  };
}
