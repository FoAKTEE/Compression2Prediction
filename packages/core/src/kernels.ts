/**
 * Finite normalized kernels. Row convention: P[input_index][output_index].
 *
 * A kernel K: X -> Y stores P_K[x][y] = K(y | x); every row sums to one.
 * Beliefs are row vectors, b' = b P_K, and K.andThen(L) is L o K with matrix
 * P_K @ P_L (the oracle's K.then(L)). Normalization is validated, never
 * silently repaired.
 */
import { ValueError } from "./errors.js";
import { pythonJsonPair } from "./json.js";
import { fsum } from "./numeric/fsum.js";

export const TOL = 1e-12;

export type Vector = readonly number[];

/** Validate ``size`` finite probabilities in [0, 1] summing to one (abs tol TOL). */
export function probabilityVector(values: Iterable<number>, size: number): Vector {
  const result = Array.from(values, (value) => {
    if (typeof value !== "number") throw new TypeError("Probabilities must be numbers");
    return value;
  });
  if (result.length !== size || result.length === 0) {
    throw new ValueError("Probability vector has the wrong size");
  }
  if (result.some((value) => !Number.isFinite(value) || value < 0.0 || value > 1.0)) {
    throw new ValueError("Probabilities must be finite and between zero and one");
  }
  if (!(Math.abs(fsum(result) - 1.0) <= TOL)) {
    throw new ValueError("Probabilities must sum to one; normalization is not implicit");
  }
  return Object.freeze(result);
}

/** A finite nonempty state space with a nominal type name and ordered values. */
export class Space {
  readonly name: string;
  readonly values: readonly string[];

  constructor(name: string, values: Iterable<string>) {
    if (values == null || typeof (values as Partial<Iterable<string>>)[Symbol.iterator] !== "function") {
      throw new TypeError("Space values must be iterable");
    }
    const ordered = Object.freeze(Array.from(values));
    if (typeof name !== "string" || !name) {
      throw new ValueError("A space needs a nonempty nominal type name");
    }
    if (ordered.length === 0 || ordered.some((v) => typeof v !== "string")) {
      throw new ValueError("A space needs a nonempty tuple of string values");
    }
    if (new Set(ordered).size !== ordered.length) {
      throw new ValueError("State values must be unique");
    }
    this.name = name;
    this.values = ordered;
    Object.freeze(this);
  }
}

/** Structural equality: same name and same ordered values. */
export function spaceEquals(left: Space, right: Space): boolean {
  if (left === right) return true;
  if (!(left instanceof Space) || !(right instanceof Space)) return false;
  return (
    left.name === right.name &&
    left.values.length === right.values.length &&
    left.values.every((v, i) => v === right.values[i])
  );
}

/** Binary product space named ``(left*right)`` with JSON-encoded pair values. */
export function product(left: Space, right: Space): Space {
  // Lexicographic pair ordering, with the right factor varying fastest.
  const values: string[] = [];
  for (const a of left.values) for (const b of right.values) values.push(pythonJsonPair(a, b));
  return new Space(`(${left.name}*${right.name})`, values);
}

export const UNIT = new Space("Unit", ["*"]);

/**
 * Left fold of ``product``: [] -> UNIT, [A] -> A, [A, B, C] -> ((A*B)*C).
 *
 * Parenthesization is kept: other associations and permutations need explicit
 * reindexing maps, and equal-sized spaces are never identified.
 */
export function productAll(spaces: Iterable<Space>): Space {
  const all = Array.from(spaces);
  if (all.length === 0) return UNIT;
  let result = all[0]!;
  for (const space of all.slice(1)) result = product(result, space);
  return result;
}

/** A row-stochastic kernel source -> target with rows[x][y] = K(y | x). */
export class Kernel {
  readonly source: Space;
  readonly target: Space;
  readonly rows: readonly Vector[];

  constructor(source: Space, target: Space, rows: Iterable<Iterable<number>>) {
    if (!(source instanceof Space) || !(target instanceof Space)) {
      throw new TypeError("Kernel source and target must be spaces");
    }
    const size = target.values.length;
    const checked = Object.freeze(Array.from(rows, (row) => probabilityVector(row, size)));
    if (checked.length !== source.values.length) {
      throw new ValueError("Expected one probability row per input state");
    }
    this.source = source;
    this.target = target;
    this.rows = checked;
    Object.freeze(this);
  }

  /** Push a row-vector belief over the source forward: b P_this. */
  push(distribution: Iterable<number>): Vector {
    const p = probabilityVector(distribution, this.source.values.length);
    const out: number[] = [];
    for (let j = 0; j < this.target.values.length; j++) {
      out.push(fsum(p.map((pi, i) => pi * this.rows[i]![j]!)));
    }
    return Object.freeze(out);
  }

  /** Return following o this; the numeric matrix is P_this @ P_following. */
  // Not `then` (the oracle's name): a `then` method would make every Kernel a thenable that `await` hijacks.
  andThen(following: Kernel): Kernel {
    if (!(following instanceof Kernel)) {
      throw new TypeError("andThen composes a kernel with a Kernel");
    }
    if (!spaceEquals(this.target, following.source)) {
      throw new ValueError("Kernel interfaces do not match exactly");
    }
    return new Kernel(
      this.source,
      following.target,
      this.rows.map((row) => following.push(row)),
    );
  }

  /** Parallel product: K(y|x) H(v|u) on product spaces, right factor fastest. */
  tensor(other: Kernel): Kernel {
    const rows: number[][] = [];
    for (const left of this.rows) {
      for (const right of other.rows) {
        const row: number[] = [];
        for (const a of left) for (const b of right) row.push(a * b);
        rows.push(row);
      }
    }
    return new Kernel(product(this.source, other.source), product(this.target, other.target), rows);
  }
}

/** Structural equality: equal spaces and exactly equal rows. */
export function kernelEquals(left: Kernel, right: Kernel): boolean {
  if (left === right) return true;
  if (!(left instanceof Kernel) || !(right instanceof Kernel)) return false;
  return (
    spaceEquals(left.source, right.source) &&
    spaceEquals(left.target, right.target) &&
    left.rows.length === right.rows.length &&
    left.rows.every((row, i) => {
      const other = right.rows[i]!;
      return row.length === other.length && row.every((v, j) => v === other[j]);
    })
  );
}

/** The identity kernel on ``space``. */
export function identity(space: Space): Kernel {
  const n = space.values.length;
  return new Kernel(
    space,
    space,
    Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1.0 : 0.0))),
  );
}

/** Copy X -> X*X: duplicates one sampled value; it does not resample. */
export function copy(space: Space): Kernel {
  const n = space.values.length;
  const rows = Array.from({ length: n }, (_, i) => {
    const row: number[] = [];
    for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) row.push(i === j && j === k ? 1.0 : 0.0);
    return row;
  });
  return new Kernel(space, product(space, space), rows);
}

/** Discard X -> UNIT. */
export function discard(space: Space): Kernel {
  return new Kernel(space, UNIT, space.values.map(() => [1.0]));
}

/** A parent-independent replacement kernel, useful for a hard intervention. */
export function constant(parentSpace: Space, outputSpace: Space, value: string): Kernel {
  if (!outputSpace.values.includes(value)) {
    throw new ValueError("Intervention value is outside the output support");
  }
  const row = outputSpace.values.map((v) => (v === value ? 1.0 : 0.0));
  return new Kernel(parentSpace, outputSpace, parentSpace.values.map(() => row));
}

/** Bayesian update using an emission kernel State -> Observation. */
export function posterior(prior: Iterable<number>, emission: Kernel, observed: string): Vector {
  const p = probabilityVector(prior, emission.source.values.length);
  if (!emission.target.values.includes(observed)) {
    throw new ValueError("Observation is outside the emission support");
  }
  const j = emission.target.values.indexOf(observed);
  const weights = p.map((pi, i) => pi * emission.rows[i]![j]!);
  const evidence = fsum(weights);
  if (evidence <= 0.0) {
    throw new ValueError("Observation has zero probability under this model");
  }
  return Object.freeze(weights.map((weight) => weight / evidence));
}

/** Push ``initial`` through a transition X -> X for ``steps`` >= 0 steps. */
export function forecast(initial: Iterable<number>, transition: Kernel, steps: number): Vector {
  if (!spaceEquals(transition.source, transition.target)) {
    throw new ValueError("Forecasting requires a transition on one state space");
  }
  if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 0) {
    throw new ValueError("steps must be a nonnegative integer");
  }
  let result = probabilityVector(initial, transition.source.values.length);
  for (let step = 0; step < steps; step++) result = transition.push(result);
  return result;
}

/** Row-wise Dirichlet posterior means for observed discrete transitions. */
export function fitCounts(
  space: Space,
  counts: readonly (readonly number[])[],
  prior: Kernel,
  strength: number,
): Kernel {
  if (!spaceEquals(prior.source, space) || !spaceEquals(prior.target, space)) {
    throw new ValueError("The prior has the wrong state space");
  }
  if (typeof strength !== "number" || !Number.isFinite(strength) || strength <= 0) {
    throw new ValueError("Prior strength must be positive and finite");
  }
  const n = space.values.length;
  if (counts.length !== n || counts.some((row) => row.length !== n)) {
    throw new ValueError("Transition counts must form an n-by-n matrix");
  }
  const rows = counts.map((countRow, i) => {
    if (countRow.some((c) => typeof c !== "number" || !Number.isInteger(c) || c < 0)) {
      throw new ValueError("Counts must be nonnegative integers");
    }
    const priorRow = prior.rows[i]!;
    if (priorRow.some((q) => q <= 0)) {
      throw new ValueError("This simple Dirichlet reference requires a positive prior");
    }
    // Python sums the integer counts exactly, then converts once to float.
    const total = Number(countRow.reduce((acc, c) => acc + BigInt(c), 0n));
    const denominator = total + strength;
    return countRow.map((c, j) => (c + strength * priorRow[j]!) / denominator);
  });
  return new Kernel(space, space, rows);
}
