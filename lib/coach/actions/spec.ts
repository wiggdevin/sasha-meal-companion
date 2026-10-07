/**
 * The shape of one coach action kind, described once (lib/coach/actions/<kind>.ts) and registered
 * once (lib/coach/actions/index.ts). Everything that differs per kind is a field here; the
 * schemas, the prompt list, grounding, history, the fast path and the card are assembled from the
 * registry instead of from parallel switches. Apply/undo is bound per kind in
 * lib/coach/actions/apply.ts.
 *
 * Types only. A spec file imports from this module and from the pure helpers beside it — never
 * from the registry (so the registry has no import cycle) and never from the client write layer.
 */

import type { z } from "zod";
import type { ApplyContext, ApplyResult, UndoOutcome } from "@/lib/coach/apply-shared";
import type { FoodHit } from "@/lib/coach/executors";
import type { IntentArgInput, IntentArgOutput } from "@/lib/coach/intent-args";
import type { ConstraintProfile } from "@/lib/policy/constraints";
import type { GroundedActionItem } from "@/lib/coach/actions/fields";
import type { NamedWireKey } from "@/lib/coach/actions/wire-fields";

/** The type parameters of one kind, named so the registry can derive every union from them. */
export type SpecTypes = {
  kind: string;
  /** What the strict schema produces. */
  input: { kind: string };
  /** What a direct caller may still hand grounding (old aliases); defaults to `input`. */
  loose?: { kind: string };
  /** The grounded action the client applies and the history replays. */
  action: { kind: string; actionId: string; flagged: string[] };
  /** The undo token `apply` returns; its shape is stored in the phone's localStorage. */
  token: { kind: string };
  /** The Jev intent arguments, for a kind the intent pre-pass reads. */
  intentArgs?: object;
};

type Loose<D extends SpecTypes> = D["loose"] extends object ? D["loose"] : D["input"];

export type GroundActionPorts = {
  searchFoods: (userId: string, query: string, limit: number) => Promise<FoodHit[]>;
  newActionId: () => string;
  /**
   * The entries the user has logged on the date the action names, keyed by id (T6 §3). `delete_entry`
   * and `move_entry` take no grounding, but they must name an entry the user actually has — an id the
   * model invented, or one belonging to another day, drops the action.
   */
  knownEntries?: (userId: string) => Promise<Map<string, string>>;
  /**
   * Every `food_ref` id for the catalog rows that ARE this food, by base name (readiness pass
   * 2026-09-18). "Add watermelon to my avoid list" wrote one ref; the catalog holds six watermelon
   * rows, so the next grounding ranked a different, unmarked row first and returned it unflagged.
   *
   * It takes the CHOSEN ROW's description, not their word: "watermelon" grounds to "Watermelon, raw",
   * and it is that base name the other rows share. Absent on a client that cannot widen a mark, and
   * the mark then reaches the one row it always did.
   */
  sameNameRefIds?: (userId: string, catalogName: string) => Promise<string[]>;
};

/** What one grounding batch gives each kind. */
export type GroundKit = {
  userId: string;
  profile: ConstraintProfile;
  ports: GroundActionPorts;
  /** One read of the entry list per batch, shared by every kind that names an entry; null without the port. */
  knownEntries: () => Promise<Map<string, string>> | null;
};

/** Clarifications to ask, and the action to emit once its id is handed out in input order. */
export type GroundOutcome<A> = { clarifications: string[]; action?: (actionId: string) => A };

/** How a kind travels on the provider's one flat action object. */
export interface WireSpec {
  /** The shared named keys this kind reads (lib/coach/actions/wire-fields.ts). */
  named: readonly NamedWireKey[];
  /** Fields carried in `numericArgs`, by position; a 0 there is an empty placeholder. */
  numbers?: readonly string[];
  /** After the fixed positions, the rest of `numericArgs` is this list field. */
  numbersRest?: { field: string; max: number };
  /** Fields carried in `stringArgs`, by position; "" there is an empty placeholder. */
  strings?: readonly string[];
  /**
   * After the fixed `strings` positions, the rest of `stringArgs` is this list field — the string
   * twin of `numbersRest`. It spends no new provider property (`stringArgs` already exists on
   * every kind): a kind whose only field is a list of plain strings, like `add_to_shopping_list`'s
   * `names`, grows the shared array's bound instead of the fixed 30-property budget
   * (tests/coach/provider-schema.test.ts).
   */
  stringsRest?: { field: string; max: number };
  /** The lenient parse form of each positional field; a reply may also send it by name. */
  fields?: Readonly<Record<string, z.ZodType>>;
  /** How the positional docs name this kind; the kind itself when absent. Equal docs are merged. */
  docLabel?: string;
  numbersDoc?: string;
  stringsDoc?: string;
  /** Fields whose explicit null survives the empty-strip (a pin cleared on purpose). */
  keepNull?: readonly string[];
  /** A kind's own rule after the empty-strip and positional expansion; null refuses the reply. */
  candidate?(candidate: Record<string, unknown>, cleaned: Record<string, unknown>):
    Record<string, unknown> | null;
}

/** A block of the system prompt, placed by `rank` because the prompt predates the registry. */
export type PromptPart = { rank: number; lines: readonly string[] };
export interface ExamplePart { rank: number; lines(ctx: { today: string }): readonly string[] }

/*
 * Members are METHODS, not function-typed properties, on purpose: method parameters are checked
 * bivariantly, so every concrete spec is assignable to `ActionSpec<SpecTypes>` and the registry
 * can dispatch without a cast per kind.
 */
export interface CardPart<A> {
  title(action: A): string;
  /** The present-tense title while it applies; the title when absent. */
  pending?(action: A): string;
  /** The name and grams lines under the title. */
  lines?(action: A): { name: string; grams: number | null }[];
  /** The grounded items the macro strip totals. */
  macroItems?(action: A): GroundedActionItem[];
}

export interface ActionSpec<D extends SpecTypes> {
  kind: D["kind"];
  /** The strict model-to-server schema: one `z.object` with a `kind` literal. */
  input: z.ZodType<D["input"]>;
  /** Canonicalize an old direct-caller shape before the strict parse. */
  normalizeInput?(value: Record<string, unknown>): unknown;
  wire: WireSpec;
  /** The grounded shape, validated again when it crosses the database replay boundary. */
  replay: z.ZodType;
  /** Canonicalize an old stored row before the replay parse. */
  normalizeReplay?(value: Record<string, unknown>): unknown;
  /** Names and grams become real refs and verdicts. A missing food drops the action. */
  ground(input: Loose<D>, kit: GroundKit): Promise<GroundOutcome<D["action"]>>;
  /** After grounding: widen the action, or turn it into one clarification. */
  expand?(action: D["action"]): { action: D["action"] } | { clarification: string };
  /** What follows `[action: <kind>` in the thread memory line. */
  history(action: D["action"]): string;
  prompt?: PromptPart;
  example?: ExamplePart;
  /** The intent pre-pass's argument reader for this kind. */
  intent?: { extract(input: IntentArgInput): IntentArgOutput<NonNullable<D["intentArgs"]>> };
  /** The no-Gemini path: the classified arguments as a strict candidate, and its reply. */
  fastPath?: {
    candidate(args: NonNullable<D["intentArgs"]>, today: string): unknown;
    reply(action: D["action"]): string;
  };
  card: CardPart<D["action"]>;
}

/**
 * The client half of a kind: its write and its Undo. It is bound in lib/coach/actions/apply.ts,
 * not in the spec, because the write layer (store, outbox, target client) must stay out of every
 * graph that only needs the schemas — the server turn and the capture flow among them
 * (tests/speed/client-import-graph.test.ts, tests/coach/sanity-integration.test.ts).
 */
export interface ApplyBinding<D extends SpecTypes> {
  apply(action: D["action"], ctx: ApplyContext): Promise<ApplyResult>;
  undo(token: D["token"]): Promise<UndoOutcome>;
}

export type TypesOf<S> = S extends ActionSpec<infer D> ? D : never;
