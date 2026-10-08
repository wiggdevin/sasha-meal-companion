import type { MascotPose } from "@/components/today/island/mascots";
import type { TourIconName } from "@/components/tour/TourIcons";

/**
 * The first-run overview's content (owner, 2026-10-08: "nothing explains what Sasha is, how the cards
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
    title: "Meet Sasha",
    lead: "Sasha tells you what to eat and when.",
    points: [
      "Every meal is built from your own foods and your targets.",
      "Tick each meal off as you eat it.",
    ],
    pose: "wave",
  },
  {
    id: "glance",
    title: "Your meal card",
    lead: "Each card shows one meal at a glance.",
    points: [
      "The photo chip says when: “Next · 12:30 PM”, “Now” or “Eaten”.",
      "The title and calories sit under the photo.",
      { icon: "heart", text: "Tap the heart to save this meal and favor its foods." },
      "The thin strip at the foot has three icons: Mark eaten, Swap and Expand.",
    ],
    pose: "pointing",
  },
  {
    id: "taps",
    title: "Change a meal",
    lead: "Each icon at the card's foot does one thing.",
    points: [
      { icon: "check", text: "Mark eaten: tap to tick it off, tap again to undo." },
      { icon: "swap", text: "Swap: other meals open inside the card." },
      { icon: "expand", text: "Expand, or tap the card: change a portion with − and +, remove a food with × (Undo for 5 seconds), or search to add one." },
      "Inside: Preparation (“Ask Sasha how to make it”), Daily share, Ask Sasha and Ate something else.",
      "An empty slot: Plan with Sasha or Log what you ate.",
    ],
    pose: "pointing",
  },
  {
    id: "gestures",
    title: "Shortcuts",
    lead: "Gestures are quick ways to do what the buttons do.",
    points: [
      "Swipe right to swap.",
      "Swipe left to show Clear, then Delete.",
      "Press and hold, then drag up or down to move the meal in 15-minute steps.",
    ],
    pose: "joyful",
  },
  {
    id: "coach",
    title: "Ask Sasha anything",
    lead: "Type or talk to Sasha to change anything.",
    points: [
      "“Move lunch to 1 PM.”",
      "“Swap dinner for something with fish.”",
      "“I had a banana at 3.”",
    ],
    pose: "listening",
  },
];
