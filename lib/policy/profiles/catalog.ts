/**
 * Phase 13 §9 R5: the one place docs/research/dietary-profiles.draft.json is imported at runtime.
 * The build-time check is scripts/check-dietary-profiles.ts, which `pnpm build` runs before
 * `next build`; this module repeats the validation at load, so no module that imports it
 * (directly or transitively) can run from an invalid document either.
 */
import rawDietaryProfilesDoc from "@/docs/research/dietary-profiles.draft.json";
import { loadProfileCatalog, type ProfileDefinition } from "@/lib/policy/profiles/loader";
import { validateDietaryProfilesDocument } from "@/lib/policy/profiles/schema";

const validated = validateDietaryProfilesDocument(rawDietaryProfilesDoc);
if (!validated.valid) {
  const first = validated.issues.slice(0, 5)
    .map((issue) => `${issue.path}: ${issue.message}`).join("; ");
  throw new Error(
    `docs/research/dietary-profiles.draft.json failed schema validation `
    + `(${validated.issues.length} issue(s)): ${first}`,
  );
}

export const DIETARY_PROFILES_DOCUMENT = validated.data;

export const PROFILE_DEFINITIONS: ReadonlyMap<string, ProfileDefinition> =
  loadProfileCatalog(validated.data.profiles);

export function profileDefinition(id: string): ProfileDefinition | undefined {
  return PROFILE_DEFINITIONS.get(id);
}
