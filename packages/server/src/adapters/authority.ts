/**
 * Single-authority rule (guide §10.6): each state variable has exactly one
 * owner. The simulator adapter writes only simulator-owned variables; a
 * kernel-owned or undeclared variable is refused.
 */
import { asStrTuple, compareCodePoints, requireFields, ValueError } from "@c2p/core";

export type StateOwner = "simulator" | "kernel";

export interface StateAuthorityJson {
  readonly simulator: readonly string[];
  readonly kernel: readonly string[];
}

export class StateAuthority {
  private readonly owners: ReadonlyMap<string, StateOwner>;

  constructor(spec: { readonly simulator?: readonly string[]; readonly kernel?: readonly string[] }) {
    const owners = new Map<string, StateOwner>();
    for (const owner of ["simulator", "kernel"] as const) {
      for (const variable of asStrTuple(spec[owner] ?? [], owner)) {
        const prior = owners.get(variable);
        if (prior === owner) throw new ValueError(`state authority: ${JSON.stringify(variable)} listed twice under ${owner}`);
        if (prior !== undefined) {
          throw new ValueError(`state authority: ${JSON.stringify(variable)} is assigned to both simulator and kernel`);
        }
        owners.set(variable, owner);
      }
    }
    this.owners = owners;
    Object.freeze(this);
  }

  static fromJson(json: unknown): StateAuthority {
    const o = requireFields(json, ["simulator", "kernel"], [], { name: "state authority" });
    return new StateAuthority({ simulator: asStrTuple(o.simulator, "simulator"), kernel: asStrTuple(o.kernel, "kernel") });
  }

  owner(variable: string): StateOwner | null {
    return this.owners.get(variable) ?? null;
  }

  /** Throw unless every variable is declared and simulator-owned. */
  assertSimulatorOwned(variables: Iterable<string>, where: string): void {
    for (const variable of variables) {
      const owner = this.owners.get(variable);
      if (owner === "kernel") {
        throw new ValueError(
          `${where}: state variable ${JSON.stringify(variable)} is owned by the kernel; the simulator adapter may not write it`,
        );
      }
      if (owner === undefined) throw new ValueError(`${where}: state variable ${JSON.stringify(variable)} has no declared owner`);
    }
  }

  toJson(): StateAuthorityJson {
    const of = (owner: StateOwner) =>
      [...this.owners].filter(([, o]) => o === owner).map(([v]) => v).sort(compareCodePoints);
    return { simulator: of("simulator"), kernel: of("kernel") };
  }
}
