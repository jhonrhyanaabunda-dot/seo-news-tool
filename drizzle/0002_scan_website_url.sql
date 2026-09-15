ALTER TABLE "seo_scans" ADD COLUMN "website_url" varchar(500);--> statement-breakpoint
-- Backfill: record which website each existing scan actually crawled.
UPDATE "seo_scans" s SET "website_url" = COALESCE(s."crawl_state"->>'baseUrl', d."website_url") FROM "dealerships" d WHERE d."id" = s."dealership_id" AND s."website_url" IS NULL;
