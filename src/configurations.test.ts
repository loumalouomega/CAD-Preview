import { describe, it, expect } from "vitest";
import {
  EMPTY_CONFIGURATION_STATE,
  activateConfiguration,
  addConfiguration,
  applyConfiguration,
  configurationFileSlug,
  configurationTable,
  effectiveVariables,
  evaluateEffective,
  removeConfiguration,
  renameConfiguration,
  renameVariableInConfigurations,
  setConfigurationCell,
  validateConfigurationState,
  validateConfigurations,
  type ConfigurationState,
} from "./configurations";
import type { ParamVariable } from "./editVariables";

const vars = (): ParamVariable[] => [
  { name: "D", expr: "6", value: 6 },
  { name: "L", expr: "D*2", value: 12 },
];

const state = (): ConfigurationState => ({
  configurations: [
    { name: "M6", overrides: {} },
    { name: "M8", overrides: { D: "8" } },
  ],
  activeConfiguration: "M8",
});

describe("validateConfigurations (tolerant)", () => {
  it("drops bad names, duplicates and bad overrides but keeps the good entries", () => {
    const out = validateConfigurations([
      { name: "ok", overrides: { D: "8", "9bad": "1", L: 5, X: "  ", Y: "x".repeat(300) } },
      { name: "ok", overrides: { D: "1" } }, // duplicate: first wins
      { name: "", overrides: {} },
      { name: "a".repeat(65), overrides: {} },
      { name: "ctl\u0001", overrides: {} },
      "nope",
      null,
      { name: "noOverrides" },
    ]);
    expect(out).toEqual([
      { name: "ok", overrides: { D: "8" } },
      { name: "noOverrides", overrides: {} },
    ]);
    expect(validateConfigurations("x")).toEqual([]);
  });

  it("an activeConfiguration that names nothing becomes null", () => {
    expect(validateConfigurationState([{ name: "A", overrides: {} }], "B").activeConfiguration).toBeNull();
    expect(validateConfigurationState([{ name: "A", overrides: {} }], "A").activeConfiguration).toBe("A");
    expect(validateConfigurationState(undefined, "A")).toEqual(EMPTY_CONFIGURATION_STATE);
  });
});

describe("overlay", () => {
  it("applyConfiguration clones: the base variables are never mutated by the overlay or its evaluation", () => {
    const base = vars();
    const eff = applyConfiguration(base, state().configurations[1]);
    expect(eff.map((v) => v.expr)).toEqual(["8", "D*2"]);
    expect(base.map((v) => v.expr)).toEqual(["6", "D*2"]);
    const { values } = evaluateEffective(base, state());
    expect(values).toMatchObject({ D: 8, L: 16 });
    expect(base[0].value).toBe(6); // untouched cache
  });

  it("effectiveVariables honours an explicit override without a stored change, and flags unknown names", () => {
    const s = state();
    expect(evaluateEffective(vars(), s, "M6").values.D).toBe(6);
    expect(evaluateEffective(vars(), s, null).values.D).toBe(6);
    expect(effectiveVariables(vars(), s, "nope")).toMatchObject({ unknown: true, configuration: null });
    expect(s.activeConfiguration).toBe("M8");
  });

  it("a failing cell freezes at the cached value and never throws", () => {
    const s: ConfigurationState = { configurations: [{ name: "bad", overrides: { D: "oops(" } }], activeConfiguration: "bad" };
    const r = evaluateEffective(vars(), s);
    expect(r.errors.has("D")).toBe(true);
    expect(r.values.D).toBe(6); // last-good cache
    expect(r.values.L).toBe(12);
  });
});

describe("mutations", () => {
  it("add/rename/remove/activate keep the active pointer coherent and refuse bad input", () => {
    let s = EMPTY_CONFIGURATION_STATE;
    s = addConfiguration(s, "  M6 ").state;
    expect(s.configurations.map((c) => c.name)).toEqual(["M6"]);
    expect(addConfiguration(s, "M6").error).toMatch(/already exists/);
    expect(addConfiguration(s, "").error).toBeTruthy();
    s = activateConfiguration(s, "M6").state;
    s = renameConfiguration(s, "M6", "Six").state;
    expect(s.activeConfiguration).toBe("Six");
    expect(activateConfiguration(s, "nope").error).toBeTruthy();
    s = removeConfiguration(s, "Six").state;
    expect(s).toEqual({ configurations: [], activeConfiguration: null });
  });

  it("copyFrom seeds overrides", () => {
    const s = addConfiguration(state(), "M10", "M8").state;
    expect(s.configurations[2].overrides).toEqual({ D: "8" });
  });

  it("setConfigurationCell stays sparse: blank or base-equal clears the override", () => {
    let s = state();
    s = setConfigurationCell(s, "M6", "D", "5", "6").state;
    expect(s.configurations[0].overrides).toEqual({ D: "5" });
    s = setConfigurationCell(s, "M6", "D", "6", "6").state;
    expect(s.configurations[0].overrides).toEqual({});
    s = setConfigurationCell(s, "M8", "D", "", "6").state;
    expect(s.configurations[1].overrides).toEqual({});
    expect(setConfigurationCell(s, "M8", "1bad", "2").error).toBeTruthy();
    expect(setConfigurationCell(s, "none", "D", "2").error).toBeTruthy();
  });

  it("renameVariableInConfigurations moves every override", () => {
    const s = renameVariableInConfigurations(state(), "D", "Dia");
    expect(s.configurations[1].overrides).toEqual({ Dia: "8" });
  });
});

describe("configurationTable", () => {
  it("has a Base row plus one row per configuration, evaluated independently", () => {
    const t = configurationTable(vars(), state());
    expect(t.map((r) => r.name)).toEqual([null, "M6", "M8"]);
    expect(t.find((r) => r.active)?.name).toBe("M8");
    const m8 = t[2].cells;
    expect(m8.map((c) => c.value)).toEqual([8, 16]);
    expect(m8[0].override).toBe("8");
    expect(m8[1].override).toBeNull();
    expect(t[0].cells.map((c) => c.value)).toEqual([6, 12]);
  });

  it("flags a failing cell on its own row only", () => {
    const s = state();
    s.configurations[0].overrides = { D: "1/" };
    const t = configurationTable(vars(), s);
    expect(t[1].cells[0].error).toBeTruthy();
    expect(t[2].cells[0].error).toBeUndefined();
  });
});

describe("configurationFileSlug", () => {
  it("makes a safe file-name fragment", () => {
    expect(configurationFileSlug("M8 coarse/fine")).toBe("M8_coarse_fine");
    expect(configurationFileSlug("../..")).toBe("config");
    expect(configurationFileSlug("  ")).toBe("config");
  });
});
