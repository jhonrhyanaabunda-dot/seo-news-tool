ALTER TYPE "public"."job_type" ADD VALUE 'report_pdf';--> statement-breakpoint
CREATE TABLE "report_renders" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"request_key" varchar(120) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"pdf" "bytea",
	"bytes" integer,
	"filename" varchar(300),
	"error" text,
	"requested_by" integer,
	"duration_ms" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "report_renders" ADD CONSTRAINT "report_renders_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_renders_request_idx" ON "report_renders" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "report_renders_expiry_idx" ON "report_renders" USING btree ("expires_at");