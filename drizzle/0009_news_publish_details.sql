ALTER TABLE "news_articles" ADD COLUMN "published_precision" varchar(10);--> statement-breakpoint
ALTER TABLE "news_articles" ADD COLUMN "enriched_at" timestamp with time zone;--> statement-breakpoint
-- Existing articles: a time of exactly midnight UTC, or Google News' 07:00/08:00 UTC placeholder, is a date without a time.
UPDATE "news_articles" SET "published_precision" = CASE
  WHEN "published_at" IS NULL THEN NULL
  WHEN to_char("published_at" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') = '00:00:00.000' THEN 'date'
  WHEN "provider" = 'google_rss' AND to_char("published_at" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') IN ('07:00:00.000', '08:00:00.000') THEN 'date'
  ELSE 'datetime'
END;
