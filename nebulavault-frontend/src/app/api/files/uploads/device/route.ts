import { NextRequest } from "next/server";

import { proxyToGateway } from "@/utils/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reserves logical metadata and device placement without creating an S3 object. */
export async function POST(req: NextRequest) {
  return proxyToGateway("/files/uploads/device", {
    method: "POST",
    body: await req.text(),
  });
}
