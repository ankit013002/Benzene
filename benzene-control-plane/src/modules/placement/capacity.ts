import { sql } from "drizzle-orm";

import { replicas } from "../../db/schema.js";

/**
 * Bytes that must be treated as occupied until the next usage report.
 *
 * The node's reported usage is the baseline. Reservations made after that
 * report are added, as are replicas whose possession was confirmed after the
 * report (including copies later marked corrupt while their bytes may remain
 * on disk). Healthy rows confirmed before the watermark are already included
 * in the report and are deliberately not counted twice.
 */
export function occupiedBytesSql(
  allocationAlias: string
) {
  const allocation = (column: string) =>
    sql`${sql.identifier(allocationAlias)}.${sql.identifier(column)}`;
  const replica = (column: string) =>
    sql`${sql.identifier("occupied_replica")}.${sql.identifier(column)}`;
  return sql<number>`
    ${allocation("used_bytes")}
    + coalesce((
      select sum(${replica("size_bytes")})
      from ${replicas} as ${sql.identifier("occupied_replica")}
      where ${replica("device_id")} = ${allocation("device_id")}
        and ${replica("status")} = 'placing'
    ), 0)
    + coalesce((
      select sum(${replica("size_bytes")})
      from ${replicas} as ${sql.identifier("occupied_replica")}
      where ${replica("device_id")} = ${allocation("device_id")}
        and ${replica("status")} in ('healthy', 'corrupt', 'degraded')
        and ${replica("verified_at")} is not null
        and (
          ${allocation("usage_reported_at")} is null
          or ${replica("verified_at")} > ${allocation("usage_reported_at")}
        )
    ), 0)
  `;
}
