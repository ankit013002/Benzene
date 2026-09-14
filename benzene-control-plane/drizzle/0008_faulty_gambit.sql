CREATE TABLE "object_references" (
	"version_id" text PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"object_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "replicas" ADD COLUMN "garbage_collection_assignment_id" uuid;--> statement-breakpoint
ALTER TABLE "replicas" ADD COLUMN "garbage_collection_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "object_references" ADD CONSTRAINT "object_references_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_references_object_idx" ON "object_references" USING btree ("vault_id","object_hash");