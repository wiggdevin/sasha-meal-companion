import CardFrame from "@/components/ui/CardFrame";
import { feedbackStateProps, type ActionFeedbackPhase } from "@/components/ui/ActionFeedback";

/** The settings screen's card: a `CardFrame` at size md (16 px padding). A card whose fields write
 *  through the shared ActionFeedback carries that phase (glow, busy) on a wrapper around the frame. */
export default function Card({ children, feedback }: {
  children: React.ReactNode;
  feedback?: ActionFeedbackPhase;
}) {
  const frame = <CardFrame as="section" size="md">{children}</CardFrame>;
  if (feedback === undefined) return frame;
  const state = feedbackStateProps(feedback);
  return (
    <div className={`${state.className} rounded-3xl`}
      data-feedback-state={state["data-feedback-state"]} aria-busy={state["aria-busy"]}>
      {frame}
    </div>
  );
}
