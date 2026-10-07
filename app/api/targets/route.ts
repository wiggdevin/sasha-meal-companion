/** GET/POST /api/targets — JWT, 8 KB, 30/min/user. The floor sequence is re-applied server-side
 *  in `authorTargets`; a 422 names the minimum percentage that satisfies the floor. */
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { jsonError, readJson } from "@/lib/server/http";
import { enforceRateLimit } from "@/lib/server/ratelimit";
import { requestIp } from "@/lib/server/request-ip";
import {
  activeTargets, authorTargets, FloorViolationError, restoreTargetRevision,
  writeTargetRevisionSet,
} from "@/lib/server/targets";
import { BODY_FAT_SOURCES, type Settings, type TargetRevision } from "@/lib/types";
import { validateRate } from "@/lib/profile/rate-goal";
import { accountDay } from "@/lib/server/account-day";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024;

const authoredSchema = z.object({
  mode: z.enum(["grams", "percent"]),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kcalTrain: z.number().int().min(800).max(6000),
  kcalRest: z.number().int().min(800).max(6000),
  grams: z.object({ proteinG: z.number().min(0).max(500), fatG: z.number().min(0).max(400),
    carbG: z.number().min(0).max(900) }).optional(),
  percent: z.object({ proteinPct: z.number().min(5).max(70), fatPct: z.number().min(5).max(70),
    carbPct: z.number().min(5).max(70) }).optional(),
  goalRateBpWeek: z.number().int().min(-200).max(200).optional(),
  maxWeeklyKcalStep: z.number().int().min(0).max(1000).optional(),
});

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const settingsSchema = z.object({
  sex: z.enum(["female", "male", "unspecified"]),
  birthYear: z.number().int().min(1900).max(2100),
  heightCm: z.number().min(50).max(260),
  weightKg: z.number().min(20).max(400),
  bodyFatPct: z.number().min(3).max(70).nullable(),
  // Optional: a revision queued on a phone before step C carries neither, and derives as unverified.
  bodyFatSource: z.enum(BODY_FAT_SOURCES).nullable().optional(),
  bodyFatMeasuredOn: dateSchema.nullable().optional(),
  activityLevel: z.enum(["sedentary", "light", "moderate", "active", "very_active"]),
  goal: z.enum(["lose_fat", "recomp", "maintain", "gain_muscle"]),
  // Optional so a phone on an older bundle still derives; then it derives at maintenance.
  goalRateBpWeek: z.number().int().nullable().optional(),
  trainingKcal: z.number().int().min(800).max(6000).nullable(),
  restKcal: z.number().int().min(800).max(6000).nullable(),
  proteinG: z.number().min(0).max(500).nullable(),
});
// 0 is the stored "not confirmed" value and derives at maintenance, so it is always accepted.
const settingsWithRateSchema = settingsSchema.refine(
  (value) => value.goalRateBpWeek == null || value.goalRateBpWeek === 0
    || validateRate(value.goal, value.goalRateBpWeek),
  { message: "goalRateBpWeek is not a preset for the goal", path: ["goalRateBpWeek"] });
const authorityInputSchema = z.object({
  requestId: z.uuid().optional(),
  source: z.enum(["derived", "manual"]),
  effectiveFrom: dateSchema,
  latestWeighInKg: z.number().min(20).max(400).nullable(),
  trainingWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  settings: settingsWithRateSchema,
});
const predecessorSchema = authorityInputSchema.extend({
  operation: z.literal("derive"),
});
const deriveSchema = authorityInputSchema.extend({
  operation: z.literal("derive"),
  predecessor: predecessorSchema.optional(),
});
const restoreSchema = z.object({
  operation: z.literal("restore"),
  revisionId: z.uuid(),
  effectiveFrom: dateSchema,
});
const bodySchema = z.union([authoredSchema, deriveSchema, restoreSchema]);

function responseForRevision(revision: TargetRevision) {
  return { id: revision.id ?? "target-revision", mode: "grams" as const,
    raisedToFloor: false, resolved: { training: revision.training, rest: revision.rest }, revision };
}

type AuthorityBody = z.infer<typeof predecessorSchema>;

function revisionInput(body: AuthorityBody): Parameters<typeof writeTargetRevisionSet>[2] {
  const settings: Settings = {
    ...body.settings,
    goalRateBpWeek: body.settings.goalRateBpWeek ?? null,
    proteinLocked: true,
    slotTimes: {},
    shiftMinutes: 0,
    changedAt: null,
    trainingWeekdays: body.trainingWeekdays,
  };
  return {
    operation: body.operation,
    requestId: body.requestId,
    input: {
      settings,
      latestWeighInKg: body.latestWeighInKg,
      today: body.effectiveFrom,
      trainingWeekdays: body.trainingWeekdays,
      source: body.source,
    },
  };
}

async function limits(req: Request): Promise<{ userId: string; client: Parameters<typeof activeTargets>[0] }> {
  const ip = requestIp(req);
  await enforceRateLimit(`targets:ip:${ip}`, 30, 60);
  const { userId, client } = await requireUser(req);
  await enforceRateLimit(`targets:user:${userId}`, 30, 60);
  return { userId, client };
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { userId, client } = await limits(req);
    // t24b: the phone sends its own local day (`?date=`); without one, the account's day.
    const day = await accountDay(client, userId, { purpose: "GET /api/targets",
      clientDay: new URL(req.url).searchParams.get("date") });
    const target = await activeTargets(client, userId, day.date);
    return Response.json(target
      ? { status: "ready", target }
      : { status: "needs_profile", target: null });
  } catch (e) {
    return jsonError(e);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { userId, client } = await limits(req);
    const body = await readJson(req, bodySchema, MAX_BYTES);
    if ("operation" in body && body.operation === "derive") {
      const result = await writeTargetRevisionSet(
        client,
        userId,
        revisionInput(body),
        body.predecessor ? revisionInput(body.predecessor) : undefined,
      );
      return Response.json({
        ...responseForRevision(result.revision),
        ...(result.predecessor ? { predecessor: result.predecessor } : {}),
      });
    }
    if ("operation" in body && body.operation === "restore") {
      const revision = await restoreTargetRevision(
        client, userId, body.revisionId, body.effectiveFrom);
      return Response.json(responseForRevision(revision));
    }
    return Response.json(await authorTargets(client, userId, body));
  } catch (e) {
    if (e instanceof FloorViolationError) {
      return Response.json({ error: e.code, message: e.message,
        minProteinPct: e.minProteinPct, minFatPct: e.minFatPct }, { status: 422 });
    }
    return jsonError(e);
  }
}
