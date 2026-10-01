import { NextRequest } from "next/server";

import { proxyToGateway } from "@/utils/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Requests a scoped encrypted-read ticket; file bytes never pass through Next or the gateway. */
export async function POST(req: NextRequest) {
  return proxyToGateway("/placement/relay-read", {
    method: "POST",
    body: await req.text(),
  });
}
