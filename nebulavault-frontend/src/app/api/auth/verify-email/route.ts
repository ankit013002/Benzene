import { NextRequest, NextResponse } from "next/server";

import { gatewayOrigin } from "@/utils/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const VERIFICATION_STATUSES = new Set(["success", "missing", "invalid"]);

function invalidVerificationRedirect(request: NextRequest): NextResponse {
  return NextResponse.redirect(
    new URL("/verify-email?status=invalid", request.url),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token");
  const upstreamUrl = new URL(`${gatewayOrigin()}/auth/verify-email`);
  if (token !== null) upstreamUrl.searchParams.set("token", token);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return invalidVerificationRedirect(request);
  }

  const location = upstream.headers.get("location");
  if (!location || !REDIRECT_STATUSES.has(upstream.status)) {
    return invalidVerificationRedirect(request);
  }

  try {
    const upstreamLocation = new URL(location, request.url);
    const status = upstreamLocation.searchParams.get("status");
    if (
      upstreamLocation.pathname !== "/verify-email" ||
      !status ||
      !VERIFICATION_STATUSES.has(status)
    ) {
      return invalidVerificationRedirect(request);
    }

    // The gateway is allowed to choose the verification result, but not an
    // arbitrary browser destination. Rebuild the redirect on this app's
    // origin so a compromised or misconfigured upstream cannot create an
    // open redirect through the public verification endpoint.
    return NextResponse.redirect(
      new URL(`/verify-email?status=${status}`, request.url),
      upstream.status,
    );
  } catch {
    return invalidVerificationRedirect(request);
  }
}
