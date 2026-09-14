ALTER TABLE "replicas" ADD COLUMN "rebalance_assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "replicas" ADD COLUMN "rebalance_peer_device_id" uuid;--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "last_rebalanced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "replicas" ADD CONSTRAINT "replicas_rebalance_peer_device_id_devices_id_fk" FOREIGN KEY ("rebalance_peer_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;