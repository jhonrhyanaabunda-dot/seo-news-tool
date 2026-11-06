CREATE INDEX "email_reports_created_idx" ON "email_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_started_idx" ON "jobs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "seo_articles_recent_idx" ON "seo_articles" USING btree (coalesce("published_at", "detected_at") desc,"id" desc);