import Stepper from "@/components/Stepper";
import { ALERT, CAPTION } from "./settings-styles";

const KCAL_STEP = 50;

/**
 * The training/rest calorie steppers. The page keeps the state and the floor rules
 * (`setTrainingKcal`/`setRestKcal` refuse a step that would change nothing); this card
 * only renders what it is handed.
 */
export default function CaloriesCard({
  trainingKcal, restKcal, trainingCaption, restCaption, trainingAlert, restAlert,
  onTrainingChange, onRestChange,
}: {
  trainingKcal: number;
  restKcal: number;
  trainingCaption: string | null;
  restCaption: string | null;
  trainingAlert: string | null;
  restAlert: string | null;
  onTrainingChange: (value: number) => void;
  onRestChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="well p-3">
        <Stepper
          label="Training day calories"
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
          label="Rest day calories"
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
