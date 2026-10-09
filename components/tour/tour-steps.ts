import type { MascotPose } from "@/components/today/island/mascots";
import { APP_NAME, ASSISTANT_NAME } from "@/lib/brand";
import type { TourIconName } from "@/components/tour/TourIcons";

/**
 * The first-run overview's content (owner, 2026-10-08: "nothing explains what the app is, how the cards
 * work, how to change a card, or the gestures"). Five short steps; each names one animated demo
 * (TourDemos.tsx) drawn in code over a simplified meal card. The card behaviour taught here is the
 * meal-cards-v2 contract: keep the two in step when the card changes.
 */
export type TourDemoKind = "meet" | "glance" | "taps" | "gestures" | "coach";

export type TourPoint = string | { icon: TourIconName; text: string };

export type TourStep = {
  id: TourDemoKind;
  title: string;
  /** One or two short sentences under the title. */
  lead: string;
  /** Short lines, each one thing the user can do; a line about a card icon shows that icon first. */
  points: TourPoint[];
  /** The companion's pose beside the title. */
  pose: MascotPose;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "meet",
    title: `Meet ${APP_NAME}`,
    lead: `${APP_NAME} tells you what to eat and when.`,
    points: [
      "Meals come from your own foods and targets.",
      "Tick each one off as you eat it.",
    ],
    pose: "wave",
  },
  {
    id: "glance",
    title: "Your meal card",
    lead: "Each card shows one meal.",
    points: [
      "The chip says Next, Now or Eaten.",
      { icon: "heart", text: "Tap the heart to save this meal and favor its foods." },
    ],
    pose: "pointing",
  },
  {
    id: "taps",
    title: "Change a meal",
    lead: "Each icon does one thing.",
    points: [
      { icon: "check", text: "Mark eaten. Tap again to undo." },
      { icon: "swap", text: "Swap for another meal." },
      { icon: "expand", text: "Expand to change portions and foods." },
      "Daily share: how much of today's calories and macros this meal covers.",
    ],
    pose: "pointing",
  },
  {
    id: "gestures",
    title: "Shortcuts",
    lead: "Quicker ways to do the same.",
    points: [
      "Swipe right: swap.",
      "Swipe left: Clear, then Delete.",
      "Hold and drag: move it in 15-minute steps.",
    ],
    pose: "joyful",
  },
  {
    id: "coach",
    title: `Ask ${ASSISTANT_NAME} anything`,
    lead: `Type or talk to ${ASSISTANT_NAME} to change anything.`,
    points: [
      "“Move lunch to 1 PM.”",
      `An empty slot offers Plan with ${ASSISTANT_NAME} and Log what you ate.`,
    ],
    pose: "listening",
  },
];
