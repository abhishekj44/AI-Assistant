import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TOKEN_TTL_SECONDS = 60;
const DEEPGRAM_AUTH_URL = "https://api.deepgram.com/v1/auth/grant";

function noStoreJson(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
  if (!apiKey) {
    return noStoreJson(
      {
        error: "DEEPGRAM_API_KEY is not configured",
        code: "DEEPGRAM_NOT_CONFIGURED",
        help: "Set DEEPGRAM_API_KEY on the server before starting transcription.",
      },
      500,
    );
  }

  try {
    const response = await fetch(DEEPGRAM_AUTH_URL, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: TOKEN_TTL_SECONDS }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload?.access_token !== "string" || !payload.access_token) {
      const detail = typeof payload?.err_msg === "string" ? payload.err_msg : `Deepgram auth returned HTTP ${response.status}`;
      const insufficientPermissions = /insufficient permissions/i.test(detail);

      console.error("[deepgram] temporary token grant rejected", {
        status: response.status,
        errCode: payload?.err_code,
        detail,
      });

      return noStoreJson(
        {
          error: detail,
          code: insufficientPermissions ? "DEEPGRAM_INSUFFICIENT_PERMISSIONS" : "DEEPGRAM_TOKEN_GRANT_FAILED",
          help: insufficientPermissions
            ? "Create a Deepgram API key with Member-or-higher permission. The /v1/auth/grant endpoint requires that role to mint short-lived browser tokens."
            : "Verify the Deepgram API key, project access, and account/model permissions.",
        },
        response.status === 401 || response.status === 403 ? 502 : 503,
      );
    }

    return noStoreJson({
      accessToken: payload.access_token,
      expiresIn: Number(payload.expires_in) || TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deepgram token grant failed";
    console.error("[deepgram] temporary token grant failed", error);
    return noStoreJson(
      {
        error: message,
        code: "DEEPGRAM_TOKEN_GRANT_UNAVAILABLE",
        help: "Check network access to api.deepgram.com and retry.",
      },
      503,
    );
  }
}
