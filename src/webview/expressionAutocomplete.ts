import {
  applyCompletion,
  completeExpression,
  moveCompletionIndex,
  type CompletionResult,
} from "../expressionCompletion";

/**
 * Attaches the suggestion list to a text input that holds an expression. The
 * suggestion logic is the pure `expressionCompletion.ts`; this file is only the
 * popup: ArrowUp/ArrowDown move, Enter/Tab accept, Escape dismisses and leaves
 * the field's text untouched. While the list is closed every key behaves as
 * before (Enter still applies, Tab still moves focus). No DOM at module scope:
 * the popup element is created on first use.
 *
 * @param getNames the variable names legal in this field (called per keystroke,
 *   so the list follows the table without re-wiring).
 */
let popup: HTMLUListElement | null = null;
let owner: HTMLInputElement | null = null;

function popupEl(): HTMLUListElement {
  if (!popup) {
    popup = document.createElement("ul");
    popup.id = "expr-suggest";
    popup.setAttribute("role", "listbox");
    popup.hidden = true;
    document.body.appendChild(popup);
  }
  return popup;
}

export function attachExpressionAutocomplete(input: HTMLInputElement, getNames: () => readonly string[]): void {
  let result: CompletionResult | null = null;
  let index = 0;
  let accepting = false;

  const close = (): void => {
    result = null;
    if (owner === input && popup) popup.hidden = true;
    if (owner === input) owner = null;
    input.removeAttribute("aria-expanded");
  };

  const paint = (): void => {
    if (!result) return;
    const ul = popupEl();
    owner = input;
    ul.innerHTML = "";
    result.items.forEach((item, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.className = "expr-suggest-item" + (i === index ? " active" : "");
      li.setAttribute("aria-selected", i === index ? "true" : "false");
      li.dataset.kind = item.kind;
      const name = document.createElement("span");
      name.textContent = item.label;
      const kind = document.createElement("span");
      kind.className = "expr-suggest-kind";
      kind.textContent = item.kind;
      li.append(name, kind);
      // mousedown (not click) with preventDefault keeps focus in the field.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        index = i;
        accept();
      });
      ul.appendChild(li);
    });
    const r = input.getBoundingClientRect();
    ul.style.left = `${Math.max(0, r.left)}px`;
    ul.style.top = `${r.bottom + 1}px`;
    ul.style.minWidth = `${r.width}px`;
    ul.hidden = false;
    input.setAttribute("aria-expanded", "true");
    ul.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  };

  const refresh = (): void => {
    const caret = input.selectionStart ?? input.value.length;
    const next = completeExpression(input.value, caret, getNames());
    if (!next) {
      close();
      return;
    }
    result = next;
    index = 0;
    paint();
  };

  function accept(): void {
    if (!result) return;
    const item = result.items[index];
    const applied = applyCompletion(input.value, result, item);
    input.value = applied.text;
    input.setSelectionRange(applied.caret, applied.caret);
    close();
    // Other `input` listeners (live preview, validation) see the new text;
    // our own must not reopen the list on it.
    accepting = true;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    accepting = false;
  }

  input.setAttribute("aria-autocomplete", "list");
  input.addEventListener("input", () => {
    if (!accepting) refresh();
  });
  input.addEventListener("keydown", (e) => {
    if (!result) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      index = moveCompletionIndex(index, e.key === "ArrowDown" ? 1 : -1, result.items.length);
      paint();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      accept();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  input.addEventListener("blur", close);
}
