import { NextRequest } from "next/server";

import { proxyAuthRequest } from "../_proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return proxyAuthRequest("/auth/login", request);
}
