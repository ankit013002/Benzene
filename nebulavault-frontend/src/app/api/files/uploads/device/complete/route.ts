import { NextRequest } from "next/server";

import { proxyToGateway } from "@/utils/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Commits device-backed versions after the agent has reported possession. */
export async function POST(req: NextRequest) {
  return proxyToGateway("/files/uploads/device/complete", {
    method: "POST",
    body: await req.text(),
  });
}
