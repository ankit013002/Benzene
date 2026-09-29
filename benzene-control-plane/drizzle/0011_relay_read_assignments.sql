CREATE TABLE "relay_read_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vault_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"object_hash" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"device_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"client_ticket" text NOT NULL,
	"node_ticket" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_read_assignments_size_check" CHECK ("relay_read_assignments"."size_bytes" > 0 and "relay_read_assignments"."size_bytes" <= 1073741824),
	CONSTRAINT "relay_read_assignments_status_check" CHECK ("relay_read_assignments"."status" in ('pending', 'claimed', 'completed', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "relay_read_assignments" ADD CONSTRAINT "relay_read_assignments_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_read_assignments" ADD CONSTRAINT "relay_read_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relay_read_assignments_vault_request_idx" ON "relay_read_assignments" USING btree ("vault_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_read_assignments_session_idx" ON "relay_read_assignments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "relay_read_assignments_device_queue_idx" ON "relay_read_assignments" USING btree ("device_id","status","created_at");--> statement-breakpoint
CREATE INDEX "relay_read_assignments_expiry_idx" ON "relay_read_assignments" USING btree ("expires_at");