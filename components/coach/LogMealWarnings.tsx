import SanityNotices from "@/components/coach/editors/SanityNotices";
import { labelCheckNeeded } from "@/components/coach/editors/not-verified";
import type { CoachAction } from "@/lib/coach/actions";

/** Each logged item's portion and policy notices on the coach's action card. */
export default function LogMealWarnings({ action }: { action: CoachAction }) {
  if (action.kind !== "log_meal") return null;
  return <div className="flex flex-col gap-2">
    {action.items.map((item, index) => {
      const policy = { verdict: item.verdict, marks: item.marks };
      return <div key={`${item.foodRefId}-${index}`} className="flex flex-col items-start gap-2">
        <SanityNotices sanity={item.sanity} policy={policy}
          typicalServing={item.typicalServing} grams={item.grams} />
        {labelCheckNeeded(policy) && <span className="pill inline-flex">
          <span className="pill-in px-3 py-2 text-tiny font-normal text-amber">
            {item.name}: not verified. Check the label.
          </span>
        </span>}
      </div>;
    })}
  </div>;
}
