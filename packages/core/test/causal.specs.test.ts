/** N4.1: mechanism.v1 specs, ports, variable keys, family keys (guide §5.2, memo §1.2, §4.1). */
import { describe, expect, it } from "vitest";
import {
  decodeMechanismSpec,
  encodeMechanismSpec,
  FamilyKey,
  MECHANISM_FIELDS,
  MechanismSpec,
  PARAMETER_ORIGINS,
  parseVariableKey,
  Port,
  variableKey,
  variableKeyString,
} from "../src/causal/index.js";
import { canonicalJson } from "../src/index.js";
import { GUIDE_MECHANISM_JSON, mechanism } from "./fixtures/causal.js";
import { raises } from "./support.js";

const guide = (): Record<string, unknown> => JSON.parse(GUIDE_MECHANISM_JSON) as Record<string, unknown>;
const HASH = "sha256:" + "0".repeat(63) + "1";

describe("mechanism.v1 (guide §5.2)", () => {
  it("test_mechanism_spec_roundtrip", () => {
    const parsed = guide();
    const spec = decodeMechanismSpec(parsed);
    expect(spec).toBeInstanceOf(MechanismSpec);
    expect(spec.mechanism_id).toBe("mechanism_incident_progress");
    expect(spec.inputs.map((p) => [p.port, p.variable, p.time_offset])).toStrictEqual([
      ["status", "incident_status", 0],
      ["crew", "crew_capacity", 0],
      ["supplies", "supply_status", 0],
    ]);
    expect(spec.outputs).toHaveLength(1);
    expect(spec.output.port).toBe("next_status");
    expect(spec.enabled).toBe(true);
    expect(spec.parameter_origin).toBe("hand_specified_illustration");
    // Re-encodes identically, including key order.
    const encoded = encodeMechanismSpec(spec);
    expect(encoded).toStrictEqual(parsed);
    expect(JSON.stringify(encoded)).toBe(JSON.stringify(parsed));
    expect(Object.keys(encoded)).toStrictEqual([...MECHANISM_FIELDS]);
    expect(canonicalJson(encoded)).toBe(canonicalJson(parsed));
    expect(decodeMechanismSpec(JSON.parse(JSON.stringify(encoded))).toJson()).toStrictEqual(parsed);

    // Unknown fields, two outputs, and the string "false" raise.
    raises(() => decodeMechanismSpec({ ...guide(), interface_hash: HASH }), /unknown field\(s\) 'interface_hash'/);
    const two = guide();
    two.outputs = [
      { port: "next_status", variable: "incident_status", time_offset: 1 },
      { port: "next_crew", variable: "crew_capacity", time_offset: 1 },
    ];
    raises(() => decodeMechanismSpec(two), /exactly one output port is required/);
    raises(() => decodeMechanismSpec({ ...guide(), enabled: "false" }), /enabled: expected a boolean, got 'false'/);
    raises(() => decodeMechanismSpec({ ...guide(), enabled: 0 }), /enabled: expected a boolean/);
  });

  it("rejects missing fields, wrong schema, and unknown vocabularies", () => {
    for (const field of MECHANISM_FIELDS) {
      const d = guide();
      delete d[field];
      raises(() => decodeMechanismSpec(d), new RegExp(`missing field\\(s\\) ${field}`));
    }
    raises(() => decodeMechanismSpec({ ...guide(), schema_version: "mechanism.v2" }), /schema_version/);
    raises(() => decodeMechanismSpec({ ...guide(), parameter_origin: "llm_proposed" }), /parameter_origin/);
    for (const origin of PARAMETER_ORIGINS) {
      expect(decodeMechanismSpec({ ...guide(), parameter_origin: origin }).parameter_origin).toBe(origin);
    }
    expect([...PARAMETER_ORIGINS].sort()).toStrictEqual([
      "empirically_fitted",
      "hand_specified",
      "hand_specified_illustration",
      "simulator_fitted",
    ]);
    raises(() => decodeMechanismSpec({ ...guide(), outputs: [] }), /exactly one output port is required.*got 0/);
    raises(() => decodeMechanismSpec({ ...guide(), mechanism_id: "" }), /mechanism_id/);
    raises(() => decodeMechanismSpec({ ...guide(), kernel_ref: null }), /kernel_ref/);
    raises(() => decodeMechanismSpec({ ...guide(), evidence_ids: ["e1", "e1"] }), /duplicate entries/);
    raises(() => decodeMechanismSpec({ ...guide(), evidence_ids: "e1" }), /evidence_ids/);
    raises(() => decodeMechanismSpec([]), /expected a JSON object/);
    raises(() => decodeMechanismSpec(GUIDE_MECHANISM_JSON), /expected a JSON object/);
  });

  it("ports are strict, ordered, and uniquely named", () => {
    const withInputs = (inputs: unknown): Record<string, unknown> => ({ ...guide(), inputs });
    raises(
      () => decodeMechanismSpec(withInputs([{ port: "status", variable: "incident_status", time_offset: 0, unit: "h" }])),
      /inputs\[0\]: unknown field\(s\) 'unit'/,
    );
    raises(() => decodeMechanismSpec(withInputs([{ port: "status", variable: "incident_status", time_offset: "0" }])), /time_offset/);
    raises(() => decodeMechanismSpec(withInputs([{ port: "status", variable: "incident_status", time_offset: 0.5 }])), /time_offset/);
    raises(() => decodeMechanismSpec(withInputs([{ port: "status", variable: "", time_offset: 0 }])), /variable/);
    raises(
      () =>
        decodeMechanismSpec(
          withInputs([
            { port: "status", variable: "incident_status", time_offset: 0 },
            { port: "status", variable: "crew_capacity", time_offset: 0 },
          ]),
        ),
      /duplicate port name 'status'/,
    );
    // The output port name is a binding name too.
    raises(
      () => decodeMechanismSpec(withInputs([{ port: "next_status", variable: "incident_status", time_offset: 0 }])),
      /duplicate port name 'next_status'/,
    );
    // Zero inputs are allowed (the kernel source is UNIT); order is preserved.
    expect(decodeMechanismSpec(withInputs([])).inputs).toStrictEqual([]);
    const reordered = decodeMechanismSpec(
      withInputs([
        { port: "crew", variable: "crew_capacity", time_offset: 0 },
        { port: "status", variable: "incident_status", time_offset: 0 },
      ]),
    );
    expect(reordered.inputs.map((p) => p.port)).toStrictEqual(["crew", "status"]);
    expect(reordered.ports.map((p) => p.port)).toStrictEqual(["crew", "status", "next_status"]);
  });

  it("time offsets: no future reads; same-tick reads only when declared", () => {
    const at = (inputOffset: number, outputOffset: number): Record<string, unknown> => ({
      ...guide(),
      inputs: [{ port: "status", variable: "incident_status", time_offset: inputOffset }],
      outputs: [{ port: "next_status", variable: "incident_status", time_offset: outputOffset }],
    });
    raises(() => decodeMechanismSpec(at(2, 1)), /reads after the output.*future read/);
    raises(() => decodeMechanismSpec(at(2, 1), { sameTickSubstep: true }), /future read/);
    raises(() => decodeMechanismSpec(at(1, 1)), /same-tick read needs a declared same-tick substep/);
    expect(decodeMechanismSpec(at(1, 1), { sameTickSubstep: true }).output.time_offset).toBe(1);
    expect(decodeMechanismSpec(at(-1, 1)).inputs[0]!.time_offset).toBe(-1);
    raises(() => decodeMechanismSpec(at(1, 1), { sameTickSubstep: "true" as never }), /sameTickSubstep: expected a boolean/);
    expect(() => decodeMechanismSpec(guide(), { sameTick: true } as never)).toThrow(TypeError);
  });

  it("constructors are frozen and reject misuse", () => {
    const spec = mechanism("m", [{ port: "a", variable: "x", offset: 0 }], { port: "b", variable: "x", offset: 1 });
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.inputs)).toBe(true);
    expect(Object.isFrozen(spec.inputs[0])).toBe(true);
    expect(() => new Port({ port: "a", variable: "x", time_offset: 0, extra: 1 } as never)).toThrow(TypeError);
    expect(() => new MechanismSpec({ ...spec, parameter_origin: "hand_specified", bogus: 1 } as never)).toThrow(TypeError);
    raises(() => new MechanismSpec({ ...spec.toJson(), inputs: spec.toJson().inputs } as never), /expected Port/);
    raises(() => new MechanismSpec({ ...spec, enabled: "true" } as never), /enabled: expected a boolean/);
    raises(() => new MechanismSpec({ ...spec, outputs: [spec.output, spec.output] }), /exactly one output/);
  });
});

describe("variable keys (guide §5.2)", () => {
  it("canonical string form round-trips; only the canonical form parses", () => {
    const key = variableKey("scn", "incident_status", "ent_incident_001", 3);
    expect(key).toStrictEqual(["scn", "incident_status", "ent_incident_001", 3]);
    expect(Object.isFrozen(key)).toBe(true);
    const text = variableKeyString(key);
    expect(text).toBe('["scn","incident_status","ent_incident_001",3]');
    expect(parseVariableKey(text)).toStrictEqual(key);
    const odd = variableKey('s"c|n', "x/y", "e,1", -2);
    expect(parseVariableKey(variableKeyString(odd))).toStrictEqual(odd);
    raises(() => parseVariableKey('[ "scn","x","e",3]'), /canonical form/);
    raises(() => parseVariableKey('["scn","x","e",3.0]'), /canonical form/);
    raises(() => parseVariableKey('["scn","x","e",3.5]'), /time_index/);
    raises(() => parseVariableKey('["scn","x","e"]'), /expected \(scenario_id/);
    raises(() => parseVariableKey('["scn","","e",1]'), /variable_id/);
    raises(() => parseVariableKey("scn/x/e@1"), /not JSON/);
    raises(() => variableKey("scn", "x", "e", true as never), /time_index/);
  });
});

describe("family keys (memo §1.8)", () => {
  it("has exactly six fields and a stable encoding", () => {
    const key = new FamilyKey({
      template: "t",
      kind: "Person",
      role: "Member",
      interface_hash: HASH,
      regime: "r",
      data_origin_partition: "observed",
    });
    expect(Object.keys(key)).toStrictEqual([
      "template",
      "kind",
      "role",
      "interface_hash",
      "regime",
      "data_origin_partition",
    ]);
    const text = key.toString();
    expect(text).toBe(`["t","Person","Member","${HASH}","r","observed"]`);
    expect(FamilyKey.parse(text)).toStrictEqual(key);
    expect(FamilyKey.parse(text).equals(key)).toBe(true);
    raises(() => FamilyKey.parse(text.replace(",", ", ")), /canonical form/);
    raises(() => new FamilyKey({ ...key, interface_hash: "abc" }), /interface_hash/);
    raises(() => new FamilyKey({ ...key, kind: "Operator" as never }), /kind/);
    expect(() => new FamilyKey({ ...key, entity_id: "ent_a" } as never)).toThrow(TypeError);
    expect(() => new FamilyKey({ ...key, tick: 0 } as never)).toThrow(TypeError);
  });
});
