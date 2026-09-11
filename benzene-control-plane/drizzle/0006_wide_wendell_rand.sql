CREATE TABLE "device_request_replays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_request_replays" ADD CONSTRAINT "device_request_replays_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_request_replays_claim_idx" ON "device_request_replays" USING btree ("device_id","request_digest");--> statement-breakpoint
CREATE INDEX "device_request_replays_expiry_idx" ON "device_request_replays" USING btree ("expires_at");