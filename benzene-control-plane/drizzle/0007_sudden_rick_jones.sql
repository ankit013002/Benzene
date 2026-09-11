CREATE TABLE "enrollment_creation_attempts" (
	"client_key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "enrollment_creation_attempts_window_idx" ON "enrollment_creation_attempts" USING btree ("window_started_at");