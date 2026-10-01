import { NextRequest } from "next/server";

import { proxyToGateway } from "@/utils/gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return proxyToGateway("/files/uploads/device/v1/encrypted", {
    method: "POST",
    body: await req.text(),
  });
}
