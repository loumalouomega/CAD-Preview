import { describe, it, expect } from "vitest";
import { validateEditOp, type EditOp } from "./editOps";
import { AGENT_ONLY_OPS, allCatalogEntries } from "./webview/opCatalog";
import {
  COMMAND_TABLE, OP_PARAM_DOCS, allOpKinds, findCommand, parseCommandLine, buildCommandOp, quoteSelTokens,
  completeCommands, nearestCommand, commandForOp, echoCommandText, completeEntityId, commandIsBrepOnly,
  type SelectionIds,
} from "./opCommands";

const NO_SEL: SelectionIds = { solid: [], face: [], edge: [], point: [] };
const sel = (over: Partial<SelectionIds>): SelectionIds => ({ ...NO_SEL, ...over });

describe("command table", () => {
  it("has exactly one command per panel button (57), in catalog order", () => {
    const entries = allCatalogEntries();
    expect(COMMAND_TABLE).toHaveLength(entries.length);
    expect(COMMAND_TABLE.map((r) => r.panelId)).toEqual(entries.map((e) => e.id));
    expect(entries.length).toBe(57);
  });

  it("every command maps to a documented op kind and is reachable by its own name", () => {
    for (const row of COMMAND_TABLE) {
      expect(OP_PARAM_DOCS[row.kind], `docs for ${row.command}`).toBeTruthy();
      expect(findCommand(row.command)?.panelId, row.command).toBe(row.panelId);
      expect(findCommand(row.command.toUpperCase())?.panelId, `${row.command} is case-insensitive`).toBe(row.panelId);
      expect(findCommand(row.panelId)?.panelId, `${row.panelId} by panel id`).toBe(row.panelId);
    }
  });

  it("covers every op kind the catalog can emit", () => {
    const covered = new Set(COMMAND_TABLE.map((r) => r.kind));
    for (const kind of allOpKinds()) if (!AGENT_ONLY_OPS.has(kind)) expect(covered.has(kind), kind).toBe(true);
  });

  it("types the three booleans as union / subtract / intersect over the one boolean kind", () => {
    for (const name of ["union", "subtract", "intersect"]) {
      const row = findCommand(name);
      expect(row?.kind).toBe("boolean");
      expect(row?.fixed).toEqual({ kind: name });
    }
    // `boolean` alone names three buttons, so it is NOT an accepted command.
    expect(findCommand("boolean")).toBeNull();
  });

  it("accepts the roadmap aliases", () => {
    expect(findCommand("surface")?.kind).toBe("addSurfaceFromLines");
    expect(findCommand("slot")?.kind).toBe("addEdgeSlot");
    expect(findCommand("volume")?.kind).toBe("addVolumeFromSurfaces");
    expect(findCommand("addSurfaceFromLines")?.panelId).toBe("buildSurface");
  });

  it("greys B-rep-only commands exactly like the panel", () => {
    expect(commandIsBrepOnly(findCommand("fillet")!)).toBe(true);
    expect(commandIsBrepOnly(findCommand("translate")!)).toBe(false);
    expect(commandIsBrepOnly(findCommand("addBox")!)).toBe(false);
  });
});

describe("parseCommandLine", () => {
  it("splits a command from its JSON body, and treats a bare command as 'open the form'", () => {
    const r = parseCommandLine('addBox {"center":[0,0,0],"size":[1,2,3]}');
    expect(r).toMatchObject({ ok: true, body: '{"center":[0,0,0],"size":[1,2,3]}' });
    expect(parseCommandLine("extrude")).toMatchObject({ ok: true, body: null });
    expect(parseCommandLine("  EXTRUDE  ")).toMatchObject({ ok: true, body: null });
  });

  it("suggests the nearest command for a typo, and nothing for noise", () => {
    expect(parseCommandLine("extrdue")).toEqual({ ok: false, error: expect.stringContaining('Did you mean "extrude"?') });
    expect(parseCommandLine("xyzzyplugh")).toEqual({ ok: false, error: expect.not.stringContaining("Did you mean") });
    expect(parseCommandLine("   ")).toMatchObject({ ok: false, empty: true });
    expect(nearestCommand("fillt")).toBe("fillet");
  });

  it("completes by prefix, alphabetically", () => {
    expect(completeCommands("add").length).toBeGreaterThan(20);
    expect(completeCommands("fil")).toEqual(["fillet"]);
    expect(completeCommands("sub")).toEqual(["subtract"]);
  });
});

describe("buildCommandOp", () => {
  const build = (cmd: string, sel_: SelectionIds = NO_SEL) => {
    const parsed = parseCommandLine(cmd);
    if (!parsed.ok) throw new Error(parsed.error);
    return buildCommandOp(parsed.row, parsed.body, sel_);
  };

  it("stamps the op kind and yields something validateEditOp accepts", () => {
    const r = build('addBox {"center":[0,0,0],"size":[10,5,3]}');
    expect("op" in r && validateEditOp(r.op)).toMatchObject({ op: "addBox", size: [10, 5, 3] });
  });

  it("applies a boolean alias's fixed kind", () => {
    const r = build('subtract {"a":["solid-1"],"b":["solid-2"]}');
    expect("op" in r && validateEditOp(r.op)).toMatchObject({ op: "boolean", kind: "subtract", a: ["solid-1"], b: ["solid-2"] });
    // the alias wins over a contradicting body kind
    const r2 = build('union {"kind":"subtract","a":["solid-1"],"b":["solid-2"]}');
    expect("op" in r2 && r2.op.kind).toBe("union");
  });

  it("expands a bare $sel by the field's entity kind, so a mixed selection is unambiguous", () => {
    const s = sel({ solid: ["solid-1", "solid-2"], face: ["face-6"], edge: ["edge-4", "edge-5"] });
    expect(build('translate {"targets":$sel,"vec":[5,0,0]}', s)).toMatchObject({ op: { targets: ["solid-1", "solid-2"] } });
    expect(build('fillet {"edges":$sel,"radius":2}', s)).toMatchObject({ op: { edges: ["edge-4", "edge-5"] } });
    expect(build('extrude {"profile":$sel,"dir":[0,0,1],"length":3}', s)).toMatchObject({ op: { profile: "face-6" } });
  });

  it("splices $sel into a list and leaves a quoted '$sel' string alone only when it is data", () => {
    expect(build('translate {"targets":["solid-9",$sel],"vec":[1,0,0]}', sel({ solid: ["solid-1"] })))
      .toMatchObject({ op: { targets: ["solid-9", "solid-1"] } });
    expect(quoteSelTokens('{"a":"$sel","b":$sel,"c":"x$sely"}')).toBe('{"a":"$sel","b":"$sel","c":"x$sely"}');
    expect(quoteSelTokens("{\"a\":$selection}")).toBe("{\"a\":$selection}");
  });

  it("takes picked points for the curve ops' point slots", () => {
    const s = sel({ point: ["point-3", "point-7"] });
    expect(build('addPolyline {"points":$sel,"closed":false}', s)).toMatchObject({ op: { points: ["point-3", "point-7"] } });
    const line = build('addLine {"start":"point-3","end":"point-7"}', s);
    expect("op" in line && validateEditOp(line.op)).toMatchObject({ op: "addLine", pointRefs: { start: { id: "point-3" }, end: { id: "point-7" } } });
    expect(build('addArc {"center":$sel,"normal":[0,0,1],"radius":2,"startAngleDeg":0,"endAngleDeg":90}', sel({ point: ["point-1"] })))
      .toMatchObject({ op: { center: "point-1" } });
  });

  it("refuses an empty selection, a wrong-arity single slot and a non-id field, naming the cause", () => {
    expect(build('translate {"targets":$sel,"vec":[1,0,0]}')).toMatchObject({ error: expect.stringMatching(/needs selected volumes \(Vol mode\)/) });
    expect(build('extrude {"profile":$sel,"dir":[0,0,1],"length":1}', sel({ face: ["face-1", "face-2"] })))
      .toMatchObject({ error: expect.stringMatching(/takes one id but 2/) });
    expect(build('addBox {"center":$sel,"size":[1,1,1]}', sel({ point: ["point-1"] }))).toMatchObject({ error: expect.stringMatching(/cannot be used for "center"/) });
  });

  it("reports bad JSON and non-object bodies with the expected shape", () => {
    expect(build('addBox {"center":')).toMatchObject({ error: expect.stringMatching(/not valid JSON.*Expected: \{center/s) });
    expect(build("addBox [1,2]")).toMatchObject({ error: expect.stringMatching(/must be a JSON object/) });
  });

  it("a bare command yields just the kind (the caller opens the form)", () => {
    expect(build("addBox")).toEqual({ op: { op: "addBox" } });
  });
});

describe("echoCommandText / commandForOp", () => {
  it("round-trips: the echoed text rebuilds the same persisted op", () => {
    const cases: unknown[] = [
      { op: "addBox", center: [0, 0, 0], size: [10, 5, 3] },
      { op: "boolean", kind: "subtract", a: ["solid-1"], b: ["solid-2"] },
      { op: "extrude", profile: "face-6", dir: [0, 0, 1], length: 10 },
      { op: "addSurfaceFromLines", edges: ["edge-0", "edge-1", "edge-2"] },
      { op: "addLine", start: "point-3", end: "point-7" },
    ];
    for (const raw of cases) {
      const op = validateEditOp(raw) as EditOp;
      expect(op).not.toBeNull();
      const text = echoCommandText(op);
      const parsed = parseCommandLine(text);
      expect(parsed.ok, text).toBe(true);
      if (!parsed.ok) continue;
      const rebuilt = buildCommandOp(parsed.row, parsed.body, NO_SEL);
      expect("op" in rebuilt && validateEditOp(rebuilt.op), text).toEqual(op);
    }
  });

  it("names a boolean by its kind and a body-less op by the bare command", () => {
    expect(echoCommandText(validateEditOp({ op: "boolean", kind: "union", a: ["solid-1"], b: ["solid-2"] }) as EditOp))
      .toBe('union {"a":["solid-1"],"b":["solid-2"]}');
    expect(commandForOp({ op: "boolean", kind: "intersect" })?.command).toBe("intersect");
    expect(commandForOp({ op: "boolean", kind: "bogus" })).toBeNull();
    expect(echoCommandText({ op: "explode", factor: 1 } as EditOp)).toBe('explode {"factor":1}');
  });
});

describe("completeEntityId", () => {
  it("filters the inventory by prefix across kinds", () => {
    const inv: SelectionIds = { solid: ["solid-0"], face: ["face-0", "face-1"], edge: ["edge-0"], point: ["point-0"] };
    expect(completeEntityId("face", inv)).toEqual(["face-0", "face-1"]);
    expect(completeEntityId("s", inv)).toEqual(["solid-0"]);
    expect(completeEntityId("zzz", inv)).toEqual([]);
  });
});
