CREATE TYPE "public"."alert_type" AS ENUM('site_unavailable', 'new_critical_issues', 'score_drop', 'score_gain', 'issues_resolved', 'site_recovered', 'new_relevant_news', 'scan_failed');--> statement-breakpoint
CREATE TYPE "public"."check_status" AS ENUM('pass', 'warn', 'fail', 'na');--> statement-breakpoint
CREATE TYPE "public"."email_kind" AS ENUM('daily_digest', 'weekly_digest', 'alert', 'test');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('seo_scan', 'news_scan', 'digest', 'alert', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."keyword_kind" AS ENUM('dealership', 'group', 'brand', 'local', 'custom');--> statement-breakpoint
CREATE TYPE "public"."log_level" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."page_status" AS ENUM('pending', 'fetched', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."news_relevance" AS ENUM('new', 'relevant', 'not_relevant', 'reviewed');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('queued', 'crawling', 'finalizing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."scan_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('critical', 'warning', 'info');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"scan_id" bigint,
	"type" "alert_type" NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"title" varchar(300) NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"dedupe_key" varchar(200) NOT NULL,
	"notified_at" timestamp with time zone,
	"included_in_digest_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dealerships" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(200) NOT NULL,
	"website_url" varchar(500) NOT NULL,
	"host" varchar(255) NOT NULL,
	"brand" varchar(100) NOT NULL,
	"dealer_group" varchar(200),
	"city" varchar(120),
	"state" varchar(60),
	"notification_emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seo_enabled" boolean DEFAULT true NOT NULL,
	"news_enabled" boolean DEFAULT true NOT NULL,
	"instant_alerts_enabled" boolean DEFAULT true NOT NULL,
	"scan_interval_hours" integer,
	"max_pages" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"last_seo_scan_id" bigint,
	"last_seo_scan_at" timestamp with time zone,
	"last_news_scan_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" "email_kind" NOT NULL,
	"dealership_id" integer,
	"recipients" jsonb NOT NULL,
	"subject" varchar(500) NOT NULL,
	"dedupe_key" varchar(200) NOT NULL,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"provider_message_id" varchar(200),
	"error" text,
	"payload" jsonb,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" "job_type" NOT NULL,
	"dealership_id" integer,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(100),
	"last_error" text,
	"dedupe_key" varchar(200),
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "news_articles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"title" text NOT NULL,
	"url" varchar(2000) NOT NULL,
	"url_hash" varchar(64) NOT NULL,
	"title_hash" varchar(64) NOT NULL,
	"source" varchar(200),
	"provider" varchar(40) NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"matched_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"relevance_score" integer DEFAULT 0 NOT NULL,
	"relevance" "news_relevance" DEFAULT 'new' NOT NULL,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "news_keywords" (
	"id" serial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"keyword" varchar(200) NOT NULL,
	"kind" "keyword_kind" DEFAULT 'custom' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" varchar(200) PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" bigint NOT NULL,
	"level" "log_level" DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" bigint NOT NULL,
	"url" varchar(2000) NOT NULL,
	"is_internal" boolean NOT NULL,
	"http_status" integer,
	"error_code" varchar(60),
	"checked" boolean DEFAULT false NOT NULL,
	"is_broken" boolean DEFAULT false NOT NULL,
	"found_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"anchor_text" varchar(300)
);
--> statement-breakpoint
CREATE TABLE "scan_pages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" bigint NOT NULL,
	"dealership_id" integer NOT NULL,
	"url" varchar(2000) NOT NULL,
	"normalized_url" varchar(2000) NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"status" "page_status" DEFAULT 'pending' NOT NULL,
	"page_type" varchar(40),
	"is_important" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"http_status" integer,
	"final_url" varchar(2000),
	"redirected" boolean DEFAULT false NOT NULL,
	"response_time_ms" integer,
	"ttfb_ms" integer,
	"content_type" varchar(120),
	"html_bytes" integer,
	"title" text,
	"meta_description" text,
	"h1" jsonb,
	"h2" jsonb,
	"canonical" text,
	"robots_meta" varchar(200),
	"x_robots_tag" varchar(200),
	"indexable" boolean,
	"lang" varchar(20),
	"has_viewport" boolean,
	"word_count" integer,
	"internal_links_count" integer,
	"external_links_count" integer,
	"images_count" integer,
	"images_missing_alt" integer,
	"scripts_count" integer,
	"blocking_scripts_count" integer,
	"stylesheets_count" integer,
	"schema_types" jsonb,
	"schema_errors" integer,
	"open_graph" jsonb,
	"details" jsonb,
	"error_code" varchar(60),
	"error_message" text,
	"issue_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_checks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" bigint NOT NULL,
	"check_key" varchar(80) NOT NULL,
	"category" varchar(40) NOT NULL,
	"label" varchar(200) NOT NULL,
	"status" "check_status" NOT NULL,
	"pass_count" integer DEFAULT 0 NOT NULL,
	"warn_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"points_deducted" integer DEFAULT 0 NOT NULL,
	"max_points" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"scan_id" bigint NOT NULL,
	"dealership_id" integer NOT NULL,
	"page_id" bigint,
	"url" varchar(2000) NOT NULL,
	"check_key" varchar(80) NOT NULL,
	"category" varchar(40) NOT NULL,
	"severity" "issue_severity" NOT NULL,
	"message" text NOT NULL,
	"recommendation" text NOT NULL,
	"details" jsonb,
	"fingerprint" varchar(64) NOT NULL,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_new" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_scans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"dealership_id" integer NOT NULL,
	"status" "scan_status" DEFAULT 'queued' NOT NULL,
	"trigger" "scan_trigger" DEFAULT 'scheduled' NOT NULL,
	"max_pages" integer DEFAULT 40 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"pages_scanned" integer DEFAULT 0 NOT NULL,
	"pages_failed" integer DEFAULT 0 NOT NULL,
	"score" integer,
	"category_scores" jsonb,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"passed_count" integer DEFAULT 0 NOT NULL,
	"site_checks" jsonb,
	"change_summary" jsonb,
	"issue_fingerprints" jsonb,
	"info_count" integer DEFAULT 0 NOT NULL,
	"previous_scan_id" bigint,
	"error_message" text,
	"site_available" boolean,
	"details_retained" boolean DEFAULT true NOT NULL,
	"crawl_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" varchar(500),
	"ip_address" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"level" "log_level" NOT NULL,
	"source" varchar(80) NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"dealership_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(200) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_reports" ADD CONSTRAINT "email_reports_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_articles" ADD CONSTRAINT "news_articles_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_keywords" ADD CONSTRAINT "news_keywords_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_links" ADD CONSTRAINT "scan_links_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_pages" ADD CONSTRAINT "scan_pages_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_checks" ADD CONSTRAINT "seo_checks_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD CONSTRAINT "seo_issues_scan_id_seo_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."seo_scans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_scans" ADD CONSTRAINT "seo_scans_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_dedupe_idx" ON "alerts" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "alerts_dealership_idx" ON "alerts" USING btree ("dealership_id","created_at");--> statement-breakpoint
CREATE INDEX "dealerships_host_idx" ON "dealerships" USING btree ("host");--> statement-breakpoint
CREATE INDEX "dealerships_active_idx" ON "dealerships" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "email_reports_dedupe_idx" ON "email_reports" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "email_reports_dealership_idx" ON "email_reports" USING btree ("dealership_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_pick_idx" ON "jobs" USING btree ("status","run_after","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active_idx" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "news_articles_dealer_url_idx" ON "news_articles" USING btree ("dealership_id","url_hash");--> statement-breakpoint
CREATE INDEX "news_articles_dealer_title_idx" ON "news_articles" USING btree ("dealership_id","title_hash");--> statement-breakpoint
CREATE INDEX "news_articles_dealer_detected_idx" ON "news_articles" USING btree ("dealership_id","detected_at");--> statement-breakpoint
CREATE INDEX "news_articles_relevance_idx" ON "news_articles" USING btree ("relevance","detected_at");--> statement-breakpoint
CREATE INDEX "news_keywords_dealership_idx" ON "news_keywords" USING btree ("dealership_id");--> statement-breakpoint
CREATE UNIQUE INDEX "news_keywords_unique_idx" ON "news_keywords" USING btree ("dealership_id",lower("keyword"));--> statement-breakpoint
CREATE INDEX "scan_events_scan_idx" ON "scan_events" USING btree ("scan_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_links_scan_url_idx" ON "scan_links" USING btree ("scan_id","url");--> statement-breakpoint
CREATE INDEX "scan_links_scan_broken_idx" ON "scan_links" USING btree ("scan_id","is_broken");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_pages_scan_url_idx" ON "scan_pages" USING btree ("scan_id","normalized_url");--> statement-breakpoint
CREATE INDEX "scan_pages_scan_status_idx" ON "scan_pages" USING btree ("scan_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_checks_scan_key_idx" ON "seo_checks" USING btree ("scan_id","check_key");--> statement-breakpoint
CREATE INDEX "seo_issues_scan_idx" ON "seo_issues" USING btree ("scan_id","severity");--> statement-breakpoint
CREATE INDEX "seo_issues_dealership_idx" ON "seo_issues" USING btree ("dealership_id","created_at");--> statement-breakpoint
CREATE INDEX "seo_issues_fingerprint_idx" ON "seo_issues" USING btree ("scan_id","fingerprint");--> statement-breakpoint
CREATE INDEX "seo_scans_dealership_idx" ON "seo_scans" USING btree ("dealership_id","created_at");--> statement-breakpoint
CREATE INDEX "seo_scans_status_idx" ON "seo_scans" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_scans_one_active_idx" ON "seo_scans" USING btree ("dealership_id") WHERE "seo_scans"."status" in ('queued', 'crawling', 'finalizing');--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "system_logs_created_idx" ON "system_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "system_logs_level_idx" ON "system_logs" USING btree ("level","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email"));