import { describe, expect, it } from "vitest";
import { COMMAND_TABLE } from "../opCommands";
import type { EditOp } from "../editOps";
import {
  LastCommandTracker,
  fuzzyScore,
  opSearchItems,
  panelIdForOp,
  rankItems,
  resolveKey,
  shortcutSections,
  singleKeyTable,
  type SearchItem,
} from "./commandSearch";
import { allCatalogEntries } from "./opCatalog";

const item = (id: string, label: string, extra: Partial<SearchItem> = {}): SearchItem => ({
  id, kind: "action", label, group: "Toolbar", keywords: [], ...extra,
});

describe("fuzzyScore", () => {
  it("matches a prefix, a substring and an in-order subsequence, and rejects the rest", () => {
    expect(fuzzyScore("fil", "Fillet")).not.toBeNull();
    expect(fuzzyScore("llet", "Fillet")).not.toBeNull();
    expect(fuzzyScore("flt", "Fillet")).not.toBeNull();
    expect(fuzzyScore("tlf", "Fillet")).toBeNull();
    expect(fuzzyScore("xyz", "Fillet")).toBeNull();
  });
  it("ranks prefix above word start above mid-word above subsequence", () => {
    const prefix = fuzzyScore("box", "Box")!;
    const wordStart = fuzzyScore("box", "Add Box")!;
    const mid = fuzzyScore("box", "Sandbox")!;
    const sub = fuzzyScore("bx", "Box")!;
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(mid);
    expect(prefix).toBeGreaterThan(sub);
  });
  it("needs every whitespace-separated token to match", () => {
    expect(fuzzyScore("lin pat", "Linear Pattern")).not.toBeNull();
    expect(fuzzyScore("lin zzz", "Linear Pattern")).toBeNull();
  });
  it("is case-insensitive and empty queries match with score 0", () => {
    expect(fuzzyScore("FILLET", "fillet")).not.toBeNull();
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });
  it("prefers the shorter text on an equal prefix", () => {
    expect(fuzzyScore("fil", "Fillet")!).toBeGreaterThan(fuzzyScore("fil", "Fill Surface")!);
  });
});

describe("rankItems", () => {
  const items = opSearchItems();
  it("puts Fillet first for 'fil'", () => {
    const top = rankItems(items, "fil");
    expect(top[0].id).toBe("fillet");
    expect(top.map((i) => i.id)).toContain("fillSurface");
  });
  it("finds an op by its typed command name, not just its label", () => {
    expect(rankItems(items, "union")[0].id).toBe("booleanUnion");
    expect(rankItems(items, "addBox")[0].id).toBe("addBox");
  });
  it("matches the group name, with lower weight than a label", () => {
    const hits = rankItems([item("a", "Zebra", { group: "Refine" }), item("b", "Refine now")], "refine");
    expect(hits.map((i) => i.id)).toEqual(["b", "a"]);
  });
  it("drops non-matches, honours the limit and keeps source order on ties", () => {
    const list = [item("1", "Same"), item("2", "Same"), item("3", "Other")];
    expect(rankItems(list, "same").map((i) => i.id)).toEqual(["1", "2"]);
    expect(rankItems(list, "same", { limit: 1 }).map((i) => i.id)).toEqual(["1"]);
    expect(rankItems(list, "qqq")).toEqual([]);
  });
  it("floats recents to the top of an empty query only", () => {
    const list = [item("1", "A", { group: "Z" }), item("2", "B", { group: "Z" }), item("3", "C", { group: "Z" })];
    expect(rankItems(list, "", { recent: ["3", "2"] }).map((i) => i.id)).toEqual(["3", "2", "1"]);
    expect(rankItems(list, "a", { recent: ["3"] }).map((i) => i.id)).toEqual(["1"]);
  });
});

describe("opSearchItems", () => {
  it("has one item per catalog button, carrying its COMMAND_TABLE name and shortcut", () => {
    const all = opSearchItems();
    expect(all.length).toBe(allCatalogEntries().length);
    expect(all.length).toBe(COMMAND_TABLE.length);
    const fillet = all.find((i) => i.id === "fillet")!;
    expect(fillet.shortcut).toBe("F");
    expect(fillet.group).toBe("Refine");
    expect(fillet.keywords).toContain("fillet");
    expect(all.find((i) => i.id === "booleanSubtract")!.keywords).toContain("subtract");
  });
});

describe("resolveKey", () => {
  const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, target: { tagName: "BODY" }, ...extra });
  it("opens the search on Ctrl/Cmd+K anywhere, even in a field, whatever the setting", () => {
    expect(resolveKey(key("k", { ctrlKey: true }), false)).toEqual({ type: "search" });
    expect(resolveKey(key("K", { metaKey: true, target: { tagName: "INPUT" } }), false)).toEqual({ type: "search" });
  });
  it("opens the search on '/' only outside a field", () => {
    expect(resolveKey(key("/"), false)).toEqual({ type: "search" });
    expect(resolveKey(key("/", { target: { tagName: "INPUT" } }), false)).toBeNull();
    expect(resolveKey(key("/", { target: { tagName: "DIV", isContentEditable: true } }), false)).toBeNull();
  });
  it("does nothing for letters while the setting is off", () => {
    for (const k of ["e", "r", "f", "q"]) expect(resolveKey(key(k), false)).toBeNull();
    expect(resolveKey(key("R", { shiftKey: true }), false)).toBeNull();
  });
  it("maps the roadmap letters to their commands when on", () => {
    expect(resolveKey(key("e"), true)).toEqual({ type: "op", id: "extrude" });
    expect(resolveKey(key("F"), true)).toEqual({ type: "op", id: "fillet" });
    expect(resolveKey(key("q"), true)).toEqual({ type: "action", elementId: "measure-toggle" });
    expect(resolveKey(key("R", { shiftKey: true }), true)).toEqual({ type: "repeat" });
    expect(resolveKey(key("r"), true)).toEqual({ type: "op", id: "revolve" });
  });
  it("never fires while typing, with Ctrl/Alt/Meta, on auto-repeat, or when already handled", () => {
    expect(resolveKey(key("e", { target: { tagName: "TEXTAREA" } }), true)).toBeNull();
    expect(resolveKey(key("e", { target: { tagName: "SELECT" } }), true)).toBeNull();
    expect(resolveKey(key("e", { ctrlKey: true }), true)).toBeNull();
    expect(resolveKey(key("e", { altKey: true }), true)).toBeNull();
    expect(resolveKey(key("e", { repeat: true }), true)).toBeNull();
    expect(resolveKey(key("e", { defaultPrevented: true }), true)).toBeNull();
    expect(resolveKey(key("E", { shiftKey: true }), true)).toBeNull();
  });
  it("leaves the view snaps (1-6, i) and unbound letters alone", () => {
    for (const k of ["1", "2", "3", "4", "5", "6", "i", "I", "z", "x"]) expect(resolveKey(key(k), true)).toBeNull();
  });
  it("keeps the view snaps even if a table were to bind their key", () => {
    const table = new Map<string, import("./commandSearch").KeyCommand>([["i", { type: "op", id: "fillet" }], ["3", { type: "op", id: "fillet" }], ["e", { type: "op", id: "extrude" }]]);
    expect(resolveKey(key("i"), true, table)).toBeNull();
    expect(resolveKey(key("3"), true, table)).toBeNull();
    expect(resolveKey(key("e"), true, table)).toEqual({ type: "op", id: "extrude" });
  });
  it("maps Ctrl/Cmd+Z to undo and Ctrl/Cmd+Shift+Z / Ctrl+Y to redo, whatever the setting", () => {
    expect(resolveKey(key("z", { ctrlKey: true }), false)).toEqual({ type: "undo" });
    expect(resolveKey(key("Z", { metaKey: true }), false)).toEqual({ type: "undo" });
    expect(resolveKey(key("z", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "redo" });
    expect(resolveKey(key("y", { ctrlKey: true }), false)).toEqual({ type: "redo" });
    // Control: a bare z, Alt+Ctrl+Z and Ctrl+Shift+Y are not history keys.
    expect(resolveKey(key("z"), true)).toBeNull();
    expect(resolveKey(key("z", { ctrlKey: true, altKey: true }), false)).toBeNull();
    expect(resolveKey(key("y", { ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });
  it("leaves Ctrl+Z to a text field's own undo", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(resolveKey(key("z", { ctrlKey: true, target: { tagName } }), false)).toBeNull();
      expect(resolveKey(key("y", { ctrlKey: true, target: { tagName } }), false)).toBeNull();
    }
    expect(resolveKey(key("z", { ctrlKey: true, target: { tagName: "DIV", isContentEditable: true } }), false)).toBeNull();
  });
  it("opens the shortcuts sheet on '?' outside a field only", () => {
    expect(resolveKey(key("?", { shiftKey: true }), false)).toEqual({ type: "help" });
    expect(resolveKey(key("?", { shiftKey: true, target: { tagName: "INPUT" } }), false)).toBeNull();
    expect(resolveKey(key("?", { shiftKey: true, ctrlKey: true }), false)).toBeNull();
  });
  it("binds every declared key to exactly one command", () => {
    expect(singleKeyTable().size).toBe(allCatalogEntries().filter((e) => e.key).length + 1);
  });
});

describe("LastCommandTracker and panelIdForOp", () => {
  it("maps an op back to its button, including the three boolean buttons", () => {
    expect(panelIdForOp({ op: "fillet", edges: ["edge-0"], radius: 2 })).toBe("fillet");
    expect(panelIdForOp({ op: "boolean", kind: "subtract", a: ["solid-0"], b: ["solid-1"] })).toBe("booleanSubtract");
  });
  it("repeats the last opened form, and keeps an applied op's values for it", () => {
    const t = new LastCommandTracker();
    expect(t.get()).toBeNull();
    t.opened("fillet");
    expect(t.get()).toEqual({ id: "fillet" });
    t.applied({ op: "fillet", edges: ["edge-3"], radius: 2.5 });
    expect(t.get()).toEqual({ id: "fillet", body: { op: "fillet", edges: ["edge-3"], radius: 2.5 } });
    t.opened("fillet"); // reopening the same form keeps its last values
    expect(t.get()?.body?.radius).toBe(2.5);
    t.opened("extrude"); // another form replaces it
    expect(t.get()).toEqual({ id: "extrude" });
    expect(t.recent()[0]).toBe("extrude");
  });
  it("copies the op, so a later edit of the original cannot change the remembered values", () => {
    const t = new LastCommandTracker();
    const op = { op: "fillet", edges: ["edge-0"], radius: 1 } as EditOp & { radius: number };
    t.applied(op);
    op.radius = 99;
    expect(t.get()?.body?.radius).toBe(1);
  });
});

describe("shortcutSections", () => {
  it("lists every bound single key, so the sheet cannot drift from the key handler", () => {
    const rows = shortcutSections().flatMap((s) => s.rows.map((r) => r.keys));
    for (const k of singleKeyTable().keys()) expect(rows).toContain(k.toUpperCase());
    for (const chord of ["Ctrl+K", "?", "Ctrl+Z", "Shift+R", "1 – 6", "I"]) expect(rows).toContain(chord);
  });
  it("marks only bare-letter rows as needing the setting", () => {
    const all = shortcutSections().flatMap((s) => s.rows);
    expect(all.find((r) => r.keys === "Ctrl+K")!.needsSetting).toBeUndefined();
    expect(all.find((r) => r.keys === "E")!.needsSetting).toBe(true);
  });
  it("names an action row through the supplied labeller and falls back to its id", () => {
    const named = shortcutSections(undefined, (id) => (id === "measure-toggle" ? "Measure" : undefined)).flatMap((s) => s.rows);
    expect(named.find((r) => r.keys === "Q")!.label).toBe("Measure");
    const bare = shortcutSections().flatMap((s) => s.rows);
    expect(bare.find((r) => r.keys === "Q")!.label).toBe("measure-toggle");
  });
});
