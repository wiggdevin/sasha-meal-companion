/**
 * Makes everything outside `keep` inert, and returns the undo. The chat overlay keeps two things
 * live: itself and the dock, which stays its composer. Walking down from <body>, a branch that holds
 * neither is set inert (out of the tab order, the accessibility tree and taps); a branch that holds
 * one is entered and its other children are set inert. So the page underneath keeps its scroll and
 * state but cannot be reached, without `aria-modal` hiding the dock from a screen reader as well.
 *
 * Only the elements this call made inert are released again; one that was inert already stays so.
 */
const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"]);

export function inertOutside(keep: readonly (Element | null | undefined)[], root: Element = document.body): () => void {
  const kept = keep.filter((element): element is Element => !!element);
  const changed: Element[] = [];
  const visit = (parent: Element) => {
    for (const child of Array.from(parent.children)) {
      if (SKIP.has(child.tagName) || kept.includes(child)) continue;
      if (kept.some((element) => child.contains(element))) { visit(child); continue; }
      if (!child.hasAttribute("inert")) {
        child.setAttribute("inert", "");
        changed.push(child);
      }
    }
  };
  if (kept.length) visit(root);
  return () => { for (const element of changed) element.removeAttribute("inert"); };
}
