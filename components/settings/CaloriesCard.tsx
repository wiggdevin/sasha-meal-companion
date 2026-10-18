import Stepper from "@/components/Stepper";
import { ALERT, CAPTION, CARD_TITLE } from "./settings-styles";

const KCAL_STEP = 50;

/**
 * The training/rest calorie steppers. The page keeps the state and the floor rules
 * (`setTrainingKcal`/`setRestKcal` refuse a step that would change nothing); this card
 * only renders what it is handed. The labels are short under one "Calories" heading so the row
 * fits its well at 320 px (UI audit 2026-10-18 §3).
 */
export default function CaloriesCard({
  trainingKcal, restKcal, saving = false, trainingCaption, restCaption, trainingAlert, restAlert,
  onTrainingChange, onRestChange,
}: {
  trainingKcal: number;
  restKcal: number;
  /** A tapped number is still on its way to the server. */
  saving?: boolean;
  trainingCaption: string | null;
  restCaption: string | null;
  trainingAlert: string | null;
  restAlert: string | null;
  onTrainingChange: (value: number) => void;
  onRestChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-6" role="group" aria-label="Calories">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className={`m-0 ${CARD_TITLE}`}>Calories</h3>
        <span className={CAPTION} role="status" aria-live="polite">{saving ? "Saving…" : ""}</span>
      </div>
      <div className="well p-3">
        <Stepper
          label="Training day"
          value={trainingKcal}
          step={KCAL_STEP}
          unit="kcal"
          onChange={onTrainingChange}
        />
      </div>
      {trainingCaption && (
        <p className={`m-0 ${CAPTION}`}>
          {trainingCaption}
        </p>
      )}
      {trainingAlert && (
        <p className={`m-0 ${ALERT}`}>
          {trainingAlert}
        </p>
      )}

      <div className="border-t border-hairline" />

      <div className="well p-3">
        <Stepper
          label="Rest day"
          value={restKcal}
          step={KCAL_STEP}
          unit="kcal"
          onChange={onRestChange}
        />
      </div>
      {restCaption && (
        <p className={`m-0 ${CAPTION}`}>
          {restCaption}
        </p>
      )}
      {restAlert && (
        <p className={`m-0 ${ALERT}`}>
          {restAlert}
        </p>
      )}
    </div>
  );
}
