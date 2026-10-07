/**
 * T7's own proof: the three sentences spoken by macOS, transcribed by the REAL model through the
 * real route, against the LOCAL stack.
 *
 * `say` renders each sentence to AIFF, `afconvert` makes the m4a the phone would record (and one
 * WAV, because `validateAudio` reads the two containers differently). Each clip then walks the
 * path the phone walks: POST /api/media/sign, PUT to the signed URL, POST /api/coach/transcribe —
 * the route handlers themselves, with a real session cookie, not a stub of them.
 *
 * It prints the transcript, the model's ms, the round trip, and a word error rate against the
 * sentence that was spoken.
 *
 * Local only. It refuses to run against the production project ref.
 *
 *   set -a; . ./.env.local; set +a
 *   pnpm tsx scripts/t7-transcribe-proof.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminClient } from "@/lib/server/admin";
import { cookieJar, createRequestClient } from "@/lib/supabase/server";
import { POST as signRoute } from "@/app/api/media/sign/route";
import { POST as transcribeRoute } from "@/app/api/coach/transcribe/route";

const PRODUCTION_REF = "fivatgdpuenszxxnijpc";
const EMAIL = "t7-proof@localhost.test";
const PASSWORD = "t7-proof-local-only";
const ORIGIN = "http://localhost:3000";

const SENTENCES = [
  "Add watermelon to my avoid list.",
  "Can you give me a recipe for a chicken wrap that fits my daily macros?",
  "Change my 4th meal to beef jerky and a Chobani yogurt.",
];

function admin(): SupabaseClient {
  // The key itself is read in lib/server/admin.ts, the one file allowed to name it.
  const url = process.env.SUPABASE_URL ?? "";
  if (url.includes(PRODUCTION_REF)) throw new Error("refusing to run against production");
  return adminClient();
}

async function testUser(db: SupabaseClient): Promise<string> {
  const { data: list } = await db.auth.admin.listUsers({ perPage: 200 });
  const found = list?.users.find((u) => u.email === EMAIL);
  if (found) {
    await db.auth.admin.updateUserById(found.id, { password: PASSWORD });
    return found.id;
  }
  const { data, error } = await db.auth.admin.createUser({
    email: EMAIL, password: PASSWORD, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create the test user: ${error?.message}`);
  return data.user.id;
}

/**
 * The `Cookie:` header a signed-in phone would send. It is built by the app's OWN request client
 * — `setSession` writes through the same jar a route writes through — so the route under test
 * resolves identity exactly as it does in the browser.
 */
async function sessionCookie(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!key) throw new Error("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set");
  const anon = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
  if (error || !data.session) throw new Error(`could not sign the test user in: ${error?.message}`);
  const jarRequest = new Request(`${ORIGIN}/`);
  const client = createRequestClient(jarRequest);
  await client.auth.setSession({
    access_token: data.session.access_token, refresh_token: data.session.refresh_token,
  });
  const jar = cookieJar(jarRequest);
  if (jar.length === 0) throw new Error("the request client wrote no session cookie");
  return jar.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
}

type Clip = { label: string; file: string; contentType: string; bytes: Uint8Array; seconds: number };

/**
 * macOS renders the sentence, then `afconvert` puts it in the container the phone would upload.
 *
 * `T7_PAD_MS` wraps the sentence in `say`'s own silence command, which is how the panel's 11 s
 * clips are shaped: the same words, held inside a longer recording. Set it to 3500 for one.
 */
function render(index: number, sentence: string, format: "m4a" | "wav"): Clip {
  const aiff = `/tmp/t7-${index}.aiff`;
  const out = `/tmp/t7-${index}.${format}`;
  const pad = Number(process.env.T7_PAD_MS ?? 0);
  const spoken = pad > 0 ? `[[slnc ${pad}]] ${sentence} [[slnc ${pad}]]` : sentence;
  execFileSync("say", ["-v", "Samantha", "-o", aiff, spoken]);
  const args = format === "m4a"
    ? ["-f", "m4af", "-d", "aac", aiff, out]
    : ["-f", "WAVE", "-d", "LEI16", aiff, out];
  execFileSync("afconvert", args);
  const raw = execFileSync("afinfo", [out]).toString();
  const seconds = Number(/estimated duration: ([\d.]+) sec/.exec(raw)?.[1] ?? 0);
  return {
    label: `${format} #${index}`, file: out, bytes: new Uint8Array(readFileSync(out)),
    contentType: format === "m4a" ? "audio/mp4" : "audio/wav", seconds,
  };
}

const post = (path: string, cookie: string, body: unknown): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

/** POST /api/media/sign, then PUT the bytes — the phone's two hops, through the real route. */
async function upload(cookie: string, clip: Clip): Promise<string> {
  const res = await signRoute(post("/api/media/sign", cookie,
    { kind: "audio", contentType: clip.contentType, bytes: clip.bytes.byteLength }));
  if (!res.ok) throw new Error(`sign ${res.status}: ${await res.text()}`);
  const signed = (await res.json()) as { path: string; uploadUrl: string };
  const put = await fetch(signed.uploadUrl, {
    method: "PUT", headers: { "content-type": clip.contentType },
    body: clip.bytes as unknown as BodyInit,
  });
  if (!put.ok) throw new Error(`upload ${put.status}: ${await put.text()}`);
  return signed.path;
}

const WORDS = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);

/**
 * Word error rate: (substitutions + deletions + insertions) / spoken words, by Levenshtein over
 * words. 0 is perfect; 1 means every word was wrong.
 */
export function wordErrorRate(spoken: string, heard: string): number {
  const a = WORDS(spoken);
  const b = WORDS(heard);
  if (a.length === 0) return b.length === 0 ? 0 : 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1]
        ? previous[j - 1]
        : 1 + Math.min(previous[j - 1], previous[j], row[j - 1]);
    }
    previous = row;
  }
  return previous[b.length] / a.length;
}

async function main(): Promise<void> {
  const db = admin();
  const userId = await testUser(db);
  const cookie = await sessionCookie();
  // The circuit breaker counts failures per PROVIDER over ten minutes, so a repeated run of this
  // script measures the breaker rather than the route. Local test rows only, and only this user's.
  await db.from("ai_calls").delete().eq("user_id", userId);
  console.log(`user ${userId} · local stack · ${SENTENCES.length} sentences`);
  console.log("");

  // One WAV among the m4a clips: `validateAudio` reads the two containers by different headers,
  // and the fallback must answer the same either way.
  const clips: { sentence: string; clip: Clip }[] = SENTENCES.map((sentence, i) => ({
    sentence, clip: render(i + 1, sentence, i === 1 ? "wav" : "m4a"),
  }));

  const rates: number[] = [];
  for (const { sentence, clip } of clips) {
    const size = statSync(clip.file).size;
    console.log(`SAID (${clip.label}, ${clip.seconds.toFixed(1)} s, ${size} bytes): ${sentence}`);
    const started = Date.now();
    try {
      const path = await upload(cookie, clip);
      const res = await transcribeRoute(post("/api/coach/transcribe", cookie, { path }));
      const roundTrip = Date.now() - started;
      if (!res.ok) { console.log(`  FAILED ${res.status}: ${await res.text()}`); console.log(""); continue; }
      const body = (await res.json()) as { text: string; ms: number };
      const wer = wordErrorRate(sentence, body.text);
      rates.push(wer);
      console.log(`HEARD (model ${body.ms} ms, round trip ${roundTrip} ms): ${body.text}`);
      console.log(`  WER ${(wer * 100).toFixed(1)} %`);
    } catch (e) {
      console.log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log("");
  }

  const rows = await db.from("ai_calls").select("purpose, status, latency_ms")
    .eq("user_id", userId).eq("purpose", "coach-transcribe")
    .order("created_at", { ascending: false }).limit(SENTENCES.length);
  console.log(`ai_calls purpose=coach-transcribe: ${(rows.data ?? []).length} rows ` +
    `(${(rows.data ?? []).map((r) => `${(r as { status: string }).status} ` +
      `${(r as { latency_ms: number }).latency_ms} ms`).join(", ")})`);
  if (rates.length > 0) {
    console.log(`worst WER ${(Math.max(...rates) * 100).toFixed(1)} %`);
  }
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
