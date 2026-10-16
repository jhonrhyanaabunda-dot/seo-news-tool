CREATE TYPE "public"."issue_status" AS ENUM('open', 'in_progress', 'fixed', 'ignored');--> statement-breakpoint
ALTER TYPE "public"."email_kind" ADD VALUE 'monthly_report';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'performance_snapshot';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'gsc_sync';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'places_sync';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'competitor_audit';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'monthly_report';--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_user_id" integer,
	"actor_email" varchar(320),
	"action" varchar(80) NOT NULL,
	"target_type" varchar(40),
	"target_id" varchar(64),
	"summary" text NOT NULL,
	"details" jsonb,
	"ip" varchar(64),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"competitor_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(20) NOT NULL,
	"error" text,
	"metrics" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"name" varchar(200) NOT NULL,
	"website_url" varchar(500) NOT NULL,
	"host" varchar(255) NOT NULL,
	"google_place_id" varchar(300),
	"last_audit_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealership_integrations" (
	"dealership_id" integer NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"config_key" varchar(300),
	"last_scheduled_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"data_through" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dealership_integrations_dealership_id_kind_pk" PRIMARY KEY("dealership_id","kind")
);
--> statement-breakpoint
CREATE TABLE "gsc_daily" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"property" varchar(300) NOT NULL,
	"date" date NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"ctr" double precision DEFAULT 0 NOT NULL,
	"position" double precision
);
--> statement-breakpoint
CREATE TABLE "gsc_top_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"kind" varchar(10) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"key" text NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"ctr" double precision DEFAULT 0 NOT NULL,
	"position" double precision
);
--> statement-breakpoint
CREATE TABLE "issue_states" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"check_key" varchar(80) NOT NULL,
	"url" varchar(2000) NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"assigned_to" integer,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fixed_marked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"reopened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performance_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"scan_id" bigint,
	"url" varchar(2000) NOT NULL,
	"page_kind" varchar(20) NOT NULL,
	"strategy" varchar(10) DEFAULT 'mobile' NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"performance" integer,
	"lcp_ms" integer,
	"cls" real,
	"tbt_ms" integer,
	"fcp_ms" integer,
	"field" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "place_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rating" double precision,
	"review_count" integer,
	"business_status" varchar(40),
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_monthly_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"month" varchar(7) NOT NULL,
	"scan_id" bigint NOT NULL,
	"scan_completed_at" timestamp with time zone NOT NULL,
	"score" integer,
	"category_scores" jsonb,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"info_count" integer DEFAULT 0 NOT NULL,
	"pages_scanned" integer DEFAULT 0 NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "gsc_property" varchar(300);--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "google_place_id" varchar(300);--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "logo_url" varchar(500);--> statement-breakpoint
ALTER TABLE "dealerships" ADD COLUMN "brand_color" varchar(7);--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "period_month" varchar(7);--> statement-breakpoint
ALTER TABLE "scan_links" ADD COLUMN "final_url" varchar(2000);--> statement-breakpoint
ALTER TABLE "scan_links" ADD COLUMN "redirect_hops" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret_enc" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_snapshots" ADD CONSTRAINT "competitor_snapshots_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dealership_integrations" ADD CONSTRAINT "dealership_integrations_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_daily" ADD CONSTRAINT "gsc_daily_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gsc_top_items" ADD CONSTRAINT "gsc_top_items_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_states" ADD CONSTRAINT "issue_states_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_states" ADD CONSTRAINT "issue_states_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_states" ADD CONSTRAINT "issue_states_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_snapshots" ADD CONSTRAINT "performance_snapshots_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_snapshots" ADD CONSTRAINT "place_snapshots_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_monthly_snapshots" ADD CONSTRAINT "seo_monthly_snapshots_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "competitor_snapshots_competitor_idx" ON "competitor_snapshots" USING btree ("competitor_id","captured_at");--> statement-breakpoint
CREATE INDEX "competitors_dealership_idx" ON "competitors" USING btree ("dealership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_dealer_host_idx" ON "competitors" USING btree ("dealership_id","host");--> statement-breakpoint
CREATE UNIQUE INDEX "gsc_daily_dealer_date_idx" ON "gsc_daily" USING btree ("dealership_id","date");--> statement-breakpoint
CREATE INDEX "gsc_top_items_dealer_idx" ON "gsc_top_items" USING btree ("dealership_id","kind","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_states_dealer_fingerprint_idx" ON "issue_states" USING btree ("dealership_id","fingerprint");--> statement-breakpoint
CREATE INDEX "issue_states_dealer_status_idx" ON "issue_states" USING btree ("dealership_id","status");--> statement-breakpoint
CREATE INDEX "performance_snapshots_dealership_idx" ON "performance_snapshots" USING btree ("dealership_id","captured_at");--> statement-breakpoint
CREATE INDEX "place_snapshots_dealer_idx" ON "place_snapshots" USING btree ("dealership_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_monthly_snapshots_dealer_month_idx" ON "seo_monthly_snapshots" USING btree ("dealership_id","month");