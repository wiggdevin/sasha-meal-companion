export default function NewMessagePill({ onClick }: { onClick: () => void }) {
  // The fill is the inner `pill-in`, as on every coach pill, so it reads over any bubble.
  return (
    <button
      type="button"
      aria-label="New message"
      onClick={onClick}
      className="tap pill absolute bottom-3 left-1/2 z-10 min-h-11 -translate-x-1/2 elev-1"
    >
      <span className="pill-in flex min-h-11 items-center px-3.5 text-tiny text-charcoal">↓ New message</span>
    </button>
  );
}
