// Fixture for tests/design/buttons.test.ts: one of each hand-made button recipe the guard rejects.
// Never rendered; it exists so the guard proves it still sees what it is meant to see.
const TALL = { height: 52 };
const INK = "btn-primary flex items-center";

export function LegacyButtons() {
  return (
    <>
      <button type="button" className="btn-ink tap w-full" style={TALL}>Save</button>
      <button type="button" className="pill-in tap">Remove</button>
      <button type="button" className="well tap h-[52px]">Back</button>
      <span className={INK}>Profile</span>
    </>
  );
}
