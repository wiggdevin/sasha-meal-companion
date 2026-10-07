/**
 * TypeSafe System One question and answer shapes, and the pure helpers that make questions. No
 * runtime imports: the payload
 * builders (lib/ai/payloads.ts) name them from modules the browser also loads
 * (tests/speed/client-import-graph.test.ts). lib/ai/typesafe.ts re-exports all of them.
 */

export type NoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: Record<string, string>;
};

export type ChoiceQuestion<C extends Record<string, string> = Record<string, string>> = {
  type: "choice";
  instructions: string;
  criteria: C;
};

export type ScoreQuestion<L extends readonly string[] = readonly string[]> = {
  type: "score";
  instructions: string;
  criteria: L;
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer<C extends Record<string, string>> = {
  type: "choice";
  choice: keyof C & string;
  probabilities: Record<keyof C & string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};

type AnswerFor<Q extends Question> =
  Q extends NoulQuestion ? NoulAnswer
    : Q extends ChoiceQuestion<infer C> ? ChoiceAnswer<C>
      : Q extends ScoreQuestion ? ScoreAnswer
        : never;

export type Answers<Q extends Questions> = { [K in keyof Q]: AnswerFor<Q[K]> };


export function noul(
  instructions: string,
  criteria?: Record<string, string>,
): NoulQuestion {
  return { type: "noul", instructions, ...(criteria ? { criteria } : {}) };
}

export function choice<const C extends Record<string, string>>(
  instructions: string,
  criteria: C,
): ChoiceQuestion<C> {
  return { type: "choice", instructions, criteria };
}

export function score<const L extends readonly string[]>(
  instructions: string,
  levels: L,
): ScoreQuestion<L> {
  return { type: "score", instructions, criteria: levels };
}

