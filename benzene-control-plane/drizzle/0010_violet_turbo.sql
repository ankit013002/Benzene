ALTER TABLE "replicas" ADD COLUMN "encryption" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "replicas" ALTER COLUMN "encryption" SET DEFAULT 'none';--> statement-breakpoint
ALTER TABLE "replicas" ADD CONSTRAINT "replicas_encryption_check" CHECK ("replicas"."encryption" in ('unknown', 'none', 'benzene-encrypted-object-v1'));
