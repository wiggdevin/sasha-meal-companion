import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Surface from "@/components/ui/Surface";
import Button from "@/components/ui/Button";
import Field from "@/components/ui/Field";
import Chip from "@/components/ui/Chip";
import ListRow from "@/components/ui/ListRow";
import EmptyState from "@/components/ui/EmptyState";
import Toast from "@/components/ui/Toast";
import Segmented from "@/components/ui/Segmented";

/** The design-system primitives (2026-09-22): every one reads tokens through a class, never an
 *  inline size, weight or radius, so a theme edits globals.css and nothing else. */
describe("ui primitives", () => {
  it("Surface: a card is the hairline shell around liquid glass", () => {
    const markup = renderToStaticMarkup(<Surface><p>hi</p></Surface>);
    expect(markup).toContain('class="shell');
    expect(markup).toContain('class="surface');
    expect(markup).toContain("<p>hi</p>");
  });

  it("Surface: a panel and a sheet use their own recipes", () => {
    expect(renderToStaticMarkup(<Surface variant="panel">x</Surface>)).toContain("olive-panel");
    expect(renderToStaticMarkup(<Surface variant="sheet">x</Surface>)).toContain("sheet-surface");
  });

  it("Button: five variants (legacy names mapped), three fixed sizes", () => {
    const primary = renderToStaticMarkup(<Button variant="primary">Go</Button>);
    expect(primary).toContain("btn-primary");
    expect(primary).toContain("btn-md");
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain("btn-secondary");
    expect(renderToStaticMarkup(<Button variant="outline">Go</Button>)).toContain("btn-secondary");
    expect(renderToStaticMarkup(<Button variant="quiet">Go</Button>)).toContain("btn-tertiary");
    expect(renderToStaticMarkup(<Button variant="ghost">Go</Button>)).toContain("btn-ghost");
    expect(renderToStaticMarkup(<Button variant="danger">Go</Button>)).toContain("btn-danger");
    expect(renderToStaticMarkup(<Button variant="icon" aria-label="Send">*</Button>)).toContain("btn-circle");
    expect(renderToStaticMarkup(<Button size="lg">Go</Button>)).toContain("btn-lg");
    expect(renderToStaticMarkup(<Button size="sm">Go</Button>)).toContain("btn-sm");
  });

  it("Button: confirms in place — pending dots, then the tick and verb, with a live region beside it", () => {
    const pending = renderToStaticMarkup(<Button status="pending">Save</Button>);
    expect(pending).toContain('data-status="pending"');
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("btn-dots");
    const done = renderToStaticMarkup(<Button status="success" confirmLabel="Saved">Save</Button>);
    expect(done).toContain('data-status="success"');
    expect(done).toContain("btn-confirm");
    expect(done).toMatch(/role="status"[^>]*>Saved</);
    expect(renderToStaticMarkup(<Button data-feedback-state="failed" errorLabel="Try again">Send</Button>))
      .toContain('data-status="error"');
    // A button with no outcome renders no hidden confirmation (its width is its label's).
    expect(renderToStaticMarkup(<Button>Plan</Button>)).not.toContain("btn-confirm");
  });

  it("Button: type defaults to button so a form never submits by accident", () => {
    expect(renderToStaticMarkup(<Button>Go</Button>)).toContain('type="button"');
  });

  it("Field: a visible label wired to the input, with a hint and an error line", () => {
    const markup = renderToStaticMarkup(
      <Field id="w" label="Pounds" hint="Whole numbers" error="Too low" inputMode="numeric" />);
    expect(markup).toContain('for="w"');
    expect(markup).toContain(">Pounds<");
    expect(markup).toContain('id="w"');
    expect(markup).toContain("well");
    expect(markup).toContain("Whole numbers");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain("Too low");
  });

  it("Chip: a selected chip is the white fill with aria-pressed", () => {
    const on = renderToStaticMarkup(<Chip selected onClick={() => {}}>lb</Chip>);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("chip-on");
    expect(renderToStaticMarkup(<Chip onClick={() => {}}>kg</Chip>)).toContain('aria-pressed="false"');
  });

  it("ListRow: title, meta and a trailing slot; a button when it has onClick", () => {
    const markup = renderToStaticMarkup(
      <ListRow title="Chicken" meta="165 kcal" trailing={<span>→</span>} onClick={() => {}} />);
    expect(markup).toContain("<button");
    expect(markup).toContain("list-row");
    expect(markup).toContain("Chicken");
    expect(markup).toContain("165 kcal");
    expect(markup).toContain("→");
    expect(renderToStaticMarkup(<ListRow title="Static" />)).not.toContain("<button");
  });

  it("EmptyState: icon, title, body and one action on a card", () => {
    const markup = renderToStaticMarkup(
      <EmptyState title="No health data yet" body="Connect a source." action={<Button>Connect</Button>} />);
    expect(markup).toContain("shell");
    expect(markup).toContain("No health data yet");
    expect(markup).toContain("Connect a source.");
    expect(markup).toContain("Connect");
  });

  it("Toast: a status region on glass", () => {
    const markup = renderToStaticMarkup(<Toast>Saved</Toast>);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("toast");
    expect(markup).toContain("Saved");
  });

  it("Segmented: re-exported from ui so screens import one place", () => {
    const markup = renderToStaticMarkup(
      <Segmented label="Unit" panel="p" value="lb" onChange={() => {}}
        options={[{ value: "lb", label: "lb" }, { value: "kg", label: "kg" }]} />);
    expect(markup).toContain('role="tablist"');
  });
});
