import { feedbackStateProps, type ActionFeedbackPhase } from "@/components/ui/ActionFeedback";

/** Glass card: `.shell` + `.surface`, 20 px padding. Shared by the settings screen's cards. A card
 *  whose fields write through the shared ActionFeedback carries that phase (glow, busy). */
export default function Card({ children, feedback }: {
  children: React.ReactNode;
  feedback?: ActionFeedbackPhase;
}) {
  const state = feedbackStateProps(feedback);
  return (
    <section className={feedback === undefined ? "shell" : `shell ${state.className}`}
      data-feedback-state={state["data-feedback-state"]}
      aria-busy={state["aria-busy"]}>
      <div className="surface flex flex-col gap-6 p-5">{children}</div>
    </section>
  );
}
