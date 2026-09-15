ALTER TYPE "public"."job_type" ADD VALUE 'industry_news';--> statement-breakpoint
CREATE TABLE "seo_articles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"feed_id" integer NOT NULL,
	"title" text NOT NULL,
	"url" varchar(2000) NOT NULL,
	"url_hash" varchar(64) NOT NULL,
	"source" varchar(200) NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"importance" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_feeds" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" varchar(200) NOT NULL,
	"url" varchar(1000) NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_status" varchar(20),
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seo_articles" ADD CONSTRAINT "seo_articles_feed_id_seo_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."seo_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seo_articles_url_idx" ON "seo_articles" USING btree ("url_hash");--> statement-breakpoint
CREATE INDEX "seo_articles_published_idx" ON "seo_articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "seo_articles_feed_idx" ON "seo_articles" USING btree ("feed_id");--> statement-breakpoint
CREATE UNIQUE INDEX "seo_feeds_url_idx" ON "seo_feeds" USING btree (lower("url"));--> statement-breakpoint
-- Default SEO publications (all verified to serve RSS to the A3SEOMonitor User-Agent, including from cloud IPs).
INSERT INTO "seo_feeds" ("label", "url", "priority", "is_enabled") VALUES
  ('Google Search Central Blog', 'https://developers.google.com/search/blog/feed.xml', 1, true),
  ('Bing Webmaster Blog', 'https://blogs.bing.com/webmaster/feed', 1, true),
  ('Search Engine Land', 'https://searchengineland.com/feed', 2, true),
  ('Search Engine Journal', 'https://www.searchenginejournal.com/feed/', 2, true),
  ('Search Engine Roundtable', 'https://www.seroundtable.com/index.xml', 2, true),
  ('Moz Blog', 'https://moz.com/posts/rss/blog', 3, true),
  ('Ahrefs Blog', 'https://ahrefs.com/blog/feed/', 3, true),
  ('Semrush Blog', 'https://www.semrush.com/blog/feed/', 3, true),
  ('Backlinko', 'https://backlinko.com/feed', 3, false),
  ('Yoast SEO Blog', 'https://yoast.com/feed/', 3, false)
ON CONFLICT DO NOTHING;
