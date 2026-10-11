import { HttpError } from "@/lib/server/auth";
import type { ScopeResolver, TokenScope, TokenUser } from "@/lib/server/privileged";
import { hasScope } from "@/lib/server/tokens";

export type ScopeLog = { required: TokenScope[][] };

/**
 * A stand-in for withTokenUser with the real scope rule: a resolver runs after the token is known,
 * an empty answer means "read", and every named scope must be on the token. `log.required` records
 * what each call asked for.
 */
export function emulateTokenUser(token: Omit<TokenUser, "scopes"> & { scopes: string[] },
  log: ScopeLog) {
  return async <T>(_req: Request, scope: TokenScope | ScopeResolver,
    fn: (ctx: TokenUser, admin: never) => Promise<T>): Promise<T> => {
    const ctx: TokenUser = { ...token };
    const asked = typeof scope === "function" ? [...await scope(ctx)] : [scope];
    const required = asked.length > 0 ? asked : ["read" as const];
    log.required.push(required);
    for (const each of required) {
      if (!hasScope(ctx.scopes, each)) {
        throw new HttpError(403, "forbidden", `Token lacks the "${each}" scope.`);
      }
    }
    return fn(ctx, {} as never);
  };
}
