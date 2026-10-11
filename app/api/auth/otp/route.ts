/** Send the sign-in or create-account email (link and code) (W052): IP-limited in lib/server/sign-in.ts before Supabase Auth sees it. */
import { handleOtp } from "@/lib/server/sign-in";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request): Promise<Response> {
  return handleOtp(req);
}
