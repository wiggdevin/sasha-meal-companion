import Stepper from "@/components/Stepper";
import Button from "@/components/ui/Button";
import { CAPTION, PANEL_TEXT, ROW_TITLE } from "./settings-styles";

const PROTEIN_STEP = 5;

/**
 * The protein lock and its stepper. Protein never scales with calories
 * (lib/scaling.ts) — unlocking it is a deliberate act, which is why the panel says so.
 */
export default function ProteinLockCard({
  proteinLocked, proteinG, proteinCaption, onToggleLock, onProteinChange,
}: {
  proteinLocked: boolean;
  proteinG: number;
  proteinCaption: string | null;
  onToggleLock: () => void;
  onProteinChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className={`m-0 ${ROW_TITLE}`}>
            Protein target
          </p>
          <p className={`m-0 ${CAPTION}`}>
            {proteinLocked
              ? "Locked — based on your body weight, not your calories."
              : "Unlocked"}
          </p>
        </div>
        {/* One button for both states, so it keeps its place and size as it flips. */}
        <Button variant="secondary" size="sm" role="switch" aria-checked={!proteinLocked}
          onClick={onToggleLock} className="shrink-0">
          {proteinLocked ? "Unlock" : "Lock"}
        </Button>
      </div>

      {!proteinLocked && (
        <p
          className={`olive-panel m-0 p-4 ${PANEL_TEXT}`}
        >
          Your protein target comes from your body weight, not your calories. It normally
          should not move. Unlock it only when you mean to set a manual target.
        </p>
      )}

      <div className="well p-3">
        <Stepper
          label="Protein"
          value={proteinG}
          step={PROTEIN_STEP}
          unit="g"
          disabled={proteinLocked}
          onChange={onProteinChange}
        />
      </div>
      {proteinCaption && (
        <p className={`m-0 ${CAPTION}`}>
          {proteinCaption}
        </p>
      )}
    </div>
  );
}
