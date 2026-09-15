ALTER TABLE "seo_feeds" ADD COLUMN "etag" varchar(500);--> statement-breakpoint
ALTER TABLE "seo_feeds" ADD COLUMN "last_modified" varchar(100);--> statement-breakpoint
ALTER TABLE "seo_feeds" ADD COLUMN "next_fetch_after" timestamp with time zone;