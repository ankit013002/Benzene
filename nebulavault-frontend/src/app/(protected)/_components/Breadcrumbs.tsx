"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import { IoMdClose } from "react-icons/io";
import {
  dashboardHref,
  normalizeDashboardSegments,
} from "@/utils/dashboardPath";

export default function Breadcrumbs() {
  const router = useRouter();
  const params = useParams() as { path?: string[] };
  const segments = normalizeDashboardSegments(params?.path ?? []);

  return (
    <div className="breadcrumbs text-sm flex gap-2">
      {segments.length > 0 && (
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="btn rounded-full p-0 aspect-square btn-ghost hover:bg-primary"
          aria-label="Reset to root"
        >
          <IoMdClose />
        </button>
      )}
      <ul>
        {segments.map((seg, index) => {
          const href = dashboardHref(segments.slice(0, index + 1));
          return (
            <li key={href}>
              <button
                type="button"
                className="text-md hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                onClick={() => router.push(href)}
                aria-current={index === segments.length - 1 ? "page" : undefined}
              >
                {seg}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
