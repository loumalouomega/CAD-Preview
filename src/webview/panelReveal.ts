/**
 * Expands a sidebar section (and the Advanced group above it, when it lives
 * there) and scrolls it into view — the one "go to this panel" action, shared by
 * the command search and the ribbon so the two can never disagree about what
 * opening a panel means. No DOM access at module scope.
 */
export function revealPanel(section: HTMLElement): void {
  const expand = (el: HTMLElement | null): void => {
    if (el?.classList.contains("collapsed")) el.querySelector<HTMLElement>(".panel-header .panel-chevron")?.click();
  };
  if (section.closest("#advanced-body")) expand(document.getElementById("advanced-group"));
  expand(section);
  section.scrollIntoView({ block: "nearest" });
  section.querySelector<HTMLElement>(".panel-header .panel-chevron")?.focus();
}
