/** Check the emailed code and set the session cookies (W052): IP-limited in lib/server/sign-in.ts before Supabase Auth sees it. */
import { handleVerify } from "@/lib/server/sign-in";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleVerify(req);
}
