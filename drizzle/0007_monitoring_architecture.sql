ALTER TYPE "public"."job_type" ADD VALUE 'report';--> statement-breakpoint
CREATE TABLE "news_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"dealership_id" integer,
	"brand" varchar(100),
	"source_type" varchar(20) NOT NULL,
	"label" varchar(200) NOT NULL,
	"url" varchar(1000) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" varchar(20),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_id" bigint NOT NULL,
	"dealership_id" integer NOT NULL,
	"provider" varchar(20) NOT NULL,
	"model" varchar(60) NOT NULL,
	"status" varchar(20) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"scan_id" bigint,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"input_hash" varchar(64),
	"findings" jsonb,
	"narrative" jsonb,
	"generator" varchar(20),
	"generator_note" text,
	"requested_by" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "website_platform" varchar(60);--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "detected_platform" varchar(60);--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "sitemap_url" varchar(500);--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "last_successful_scan_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "news_articles" ADD COLUMN "source_type" varchar(20) DEFAULT 'search' NOT NULL;--> statement-breakpoint
ALTER TABLE "news_articles" ADD COLUMN "source_priority" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "news_articles" ADD COLUMN "news_source_id" integer;--> statement-breakpoint
ALTER TABLE "scan_pages" ADD COLUMN "result_class" varchar(24);--> statement-breakpoint
ALTER TABLE "news_sources" ADD CONSTRAINT "news_sources_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "news_sources_dealership_idx" ON "news_sources" USING btree ("dealership_id");--> statement-breakpoint
CREATE INDEX "news_sources_brand_idx" ON "news_sources" USING btree (lower("brand"));--> statement-breakpoint
CREATE UNIQUE INDEX "news_sources_unique_idx" ON "news_sources" USING btree (coalesce("dealership_id", 0),lower("url"));--> statement-breakpoint
CREATE INDEX "report_runs_created_idx" ON "report_runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "report_runs_report_idx" ON "report_runs" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "reports_dealership_idx" ON "reports" USING btree ("dealership_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_status_idx" ON "reports" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "reports_input_hash_idx" ON "reports" USING btree ("dealership_id","input_hash");--> statement-breakpoint
ALTER TABLE "news_articles" ADD CONSTRAINT "news_articles_news_source_id_news_sources_id_fk" FOREIGN KEY ("news_source_id") REFERENCES "public"."news_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scan_pages_scan_result_idx" ON "scan_pages" USING btree ("scan_id","result_class");