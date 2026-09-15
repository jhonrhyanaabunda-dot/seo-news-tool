CREATE TYPE "public"."scan_outcome" AS ENUM('completed', 'completed_with_warnings', 'partially_blocked', 'blocked', 'failed');--> statement-breakpoint
CREATE TABLE "crawler_workers" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"region" varchar(40) NOT NULL,
	"kind" varchar(20) DEFAULT 'worker' NOT NULL,
	"hostname" varchar(200),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_job_id" bigint,
	"jobs_processed" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_cache" (
	"host" varchar(255) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "preferred_region" varchar(40);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "region" varchar(40);--> statement-breakpoint
ALTER TABLE "seo_scans" ADD COLUMN "outcome" "scan_outcome";--> statement-breakpoint
ALTER TABLE "seo_scans" ADD COLUMN "region" varchar(40);--> statement-breakpoint
ALTER TABLE "seo_scans" ADD COLUMN "crawler_id" varchar(120);--> statement-breakpoint
ALTER TABLE "seo_scans" ADD COLUMN "pages_blocked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_scans" ADD COLUMN "pages_not_evaluated" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "crawler_workers_region_idx" ON "crawler_workers" USING btree ("region","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "site_cache_host_kind_idx" ON "site_cache" USING btree ("host","kind");--> statement-breakpoint
-- Backfill outcomes for scans made before scan outcomes existed.
UPDATE "seo_scans" SET "outcome" = CASE WHEN "status" = 'failed' THEN 'failed'::scan_outcome WHEN "site_checks"->>'blockedReason' IS NOT NULL THEN 'blocked'::scan_outcome ELSE 'completed'::scan_outcome END WHERE "outcome" IS NULL AND "status" IN ('completed', 'failed');
