export default function NewMessagePill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="New message"
      onClick={onClick}
      className="tap pill absolute bottom-3 left-1/2 z-10 min-h-11 px-3.5 py-2 text-tiny text-charcoal -translate-x-1/2"
    >
      ↓ New message
    </button>
  );
}
