/** Email and password sign-in; sets the session cookies (W052): IP-limited in lib/server/sign-in.ts before Supabase Auth sees it. */
import { handlePassword } from "@/lib/server/sign-in";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handlePassword(req);
}
