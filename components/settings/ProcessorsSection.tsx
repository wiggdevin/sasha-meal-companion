import Card from "@/components/settings/Card";
import SettingsSection from "@/components/settings/Section";
import { CAPTION, CARD_TITLE } from "@/components/settings/settings-styles";

/**
 * OD12 (docs/decisions/2026-10-12-owner-decisions.md): the privacy notice naming every third
 * party that processes what the user enters. Keep it in step with docs/ai-data-handling.md and
 * the call registry (lib/ai/call-registry.ts) when a provider is added or removed.
 */
export const PROCESSORS: readonly { name: string; what: string }[] = [
  { name: "Supabase", what: "Stores your account, logs, plans and settings." },
  { name: "Vercel", what: "Runs the app's servers." },
  { name: "Google Gemini", what: "Reads coach messages, meals you describe, voice notes, photos and plan documents, and writes the weekly review." },
  { name: "OpenRouter", what: "Reads meals you describe, meal and label photos and plan documents, and can answer the coach. It passes each request to the model it names." },
  { name: "TypeSafe (Jev)", what: "Sorts short text: what a coach message asks for, your likes and dislikes, food facts, the order of suggestions, and whether a coach reply matches what it did." },
  { name: "USDA FoodData Central and Open Food Facts", what: "Receive the barcode number when you scan a product." },
  { name: "OpenStreetMap", what: "The area and country you type, and rounded coordinates, go through our server. Map tiles load straight from OpenStreetMap, which sees your IP address and the part of the map you are looking at." },
  { name: "Oura", what: "Only if you connect it: the app reads your sleep and activity from your Oura account." },
];

export default function ProcessorsSection() {
  return (
    <SettingsSection title="Who handles your data">
      <Card>
        <p className={`m-0 ${CAPTION}`}>
          These services process what you enter so the app can work.
        </p>
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {PROCESSORS.map((processor) => (
            <li key={processor.name} className="flex flex-col gap-1">
              <span className={CARD_TITLE}>{processor.name}</span>
              <span className={CAPTION}>{processor.what}</span>
            </li>
          ))}
        </ul>
      </Card>
    </SettingsSection>
  );
}
