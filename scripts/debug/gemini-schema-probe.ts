import { GoogleGenAI } from "@google/genai";
import { geminiConfig } from "@/lib/ai/gemini-config";
import { toGeminiSchema } from "@/lib/ai/json-schema";
import { GEMINI_COACH } from "@/lib/ai/models";
import { COACH_TEMPERATURE, TURN_LIMITS, turnStepProviderSchema } from "@/lib/coach/turn";

type SchemaNode = Record<string, unknown>;

function schemaMetrics(schema: SchemaNode): { bytes: number; properties: number; maxDepth: number } {
  let properties = 0;
  let maxDepth = 0;
  function visit(node: unknown, depth: number): void {
    maxDepth = Math.max(maxDepth, depth);
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const record = node as SchemaNode;
    if (typeof record.properties === "object" && record.properties !== null) {
      properties += Object.keys(record.properties).length;
    }
    for (const value of Object.values(record)) visit(value, depth + 1);
  }
  visit(schema, 0);
  return { bytes: Buffer.byteLength(JSON.stringify(schema)), properties, maxDepth };
}

function fullError(error: unknown, key: string): string {
  if (!(error instanceof Error)) return String(error).replaceAll(key, "[redacted]");
  const own = Object.fromEntries(Object.getOwnPropertyNames(error).map((name) => [
    name,
    (error as unknown as SchemaNode)[name],
  ]));
  return JSON.stringify(own, null, 2).replaceAll(key, "[redacted]");
}

async function probe(key: string): Promise<boolean> {
  const schema = toGeminiSchema(turnStepProviderSchema);
  console.log(JSON.stringify(schemaMetrics(schema)));
  const ai = new GoogleGenAI({ apiKey: key });
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_COACH,
      contents: [{ role: "user", parts: [{ text: "reply with kind final and text ok" }] }],
      config: geminiConfig({
        model: GEMINI_COACH,
        jsonSchema: schema,
        temperature: COACH_TEMPERATURE,
        maxOutputTokens: TURN_LIMITS.maxOutputTokens,
      }),
    });
    console.log(`status=200 text=${JSON.stringify(response.text ?? "")}`);
    return true;
  } catch (error) {
    console.error("status=error");
    console.error(fullError(error, key));
    return false;
  }
}

async function main(): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  if (!await probe(key)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
