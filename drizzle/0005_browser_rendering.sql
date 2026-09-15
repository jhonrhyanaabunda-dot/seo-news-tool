ALTER TABLE "dealerships" ADD COLUMN "render_mode" varchar(20) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_pages" ADD COLUMN "fetch_method" varchar(10);