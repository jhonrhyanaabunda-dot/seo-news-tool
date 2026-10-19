// Throwaway PostgreSQL for the browser tests: in-memory PGlite with the app's own
// migrations and one test admin. Never touches a real database.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_USER = { email: "e2e-admin@example.invalid", password: "E2E-test-password-123" };
export const E2E_CLIENT = { email: "e2e-client@example.invalid", password: "E2E-client-password-123" };
const port = Number(process.env.E2E_DB_PORT ?? 5499);

const db = new PGlite();
const journal = JSON.parse(readFileSync(path.join(repo, "drizzle/meta/_journal.json"), "utf8"));
for (const e of journal.entries)
  for (const stmt of readFileSync(path.join(repo, "drizzle", `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await db.exec(stmt);
await db.query("insert into users (email, name, password_hash, role) values ($1, $2, $3, 'admin')", [E2E_USER.email, "E2E Admin", await bcrypt.hash(E2E_USER.password, 10)]);
// Seed: one fictional dealership with two scans a month apart, so every screen has something to show.
await db.query("insert into users (email, name, password_hash, role) values ($1, $2, $3, 'client')", [E2E_CLIENT.email, "E2E Client", await bcrypt.hash(E2E_CLIENT.password, 10)]);
await db.exec(`
  insert into dealerships (id, name, website_url, host, brand, city, state, dealer_group, notification_emails, last_seo_scan_at, last_successful_scan_at, last_news_scan_at)
  values (1, 'Example Motors', 'https://www.example-motors.test/', 'example-motors.test', 'Subaru', 'Springfield', 'IL', 'Example Auto Group', '["gm@example.invalid"]'::jsonb, now() - interval '1 day', now() - interval '1 day', now() - interval '2 hours');
  select setval(pg_get_serial_sequence('dealerships', 'id'), 1);
  insert into user_dealerships (user_id, dealership_id) select id, 1 from users where email = '${E2E_CLIENT.email}';
  insert into seo_scans (id, dealership_id, status, outcome, trigger, website_url, region, pages_scanned, score, critical_count, warning_count, passed_count, info_count, site_available, details_retained, category_scores, started_at, completed_at, created_at)
  values
   (1, 1, 'completed', 'completed', 'scheduled', 'https://www.example-motors.test/', 'us-central', 3, 78, 1, 3, 30, 1, true, true, '{"technical":{"max":100,"score":80},"metadata":{"max":100,"score":70},"content":{"max":100,"score":75},"links":{"max":100,"score":100},"images":{"max":100,"score":80},"structured_data":{"max":100,"score":60},"crawlability":{"max":100,"score":90}}', now() - interval '31 days', now() - interval '31 days' + interval '10 minutes', now() - interval '31 days'),
   (2, 1, 'completed', 'completed', 'scheduled', 'https://www.example-motors.test/', 'us-central', 3, 84, 1, 1, 33, 1, true, true, '{"technical":{"max":100,"score":90},"metadata":{"max":100,"score":80},"content":{"max":100,"score":75},"links":{"max":100,"score":100},"images":{"max":100,"score":85},"structured_data":{"max":100,"score":70},"crawlability":{"max":100,"score":95}}', now() - interval '1 day', now() - interval '1 day' + interval '12 minutes', now() - interval '1 day');
  select setval(pg_get_serial_sequence('seo_scans', 'id'), 2);
  insert into scan_pages (scan_id, dealership_id, url, normalized_url, status, page_type, is_important, http_status, final_url, response_time_ms, title, meta_description, h1, word_count, fetch_method, result_class, fetched_at)
  values
   (2, 1, 'https://www.example-motors.test/', 'https://www.example-motors.test/', 'fetched', 'home', true, 200, 'https://www.example-motors.test/', 640, 'Example Motors | New and Used Subaru in Springfield', 'New and used Subaru vehicles, service and parts in Springfield, IL.', '["Example Motors"]'::jsonb, 820, 'browser', 'SUCCESS', now() - interval '1 day'),
   (2, 1, 'https://www.example-motors.test/service/', 'https://www.example-motors.test/service/', 'fetched', 'service', true, 200, 'https://www.example-motors.test/service/', 710, 'Service | Example Motors', null, '[]'::jsonb, 410, 'browser', 'SUCCESS', now() - interval '1 day'),
   (2, 1, 'https://www.example-motors.test/new-vehicles/', 'https://www.example-motors.test/new-vehicles/', 'fetched', 'new_inventory', true, 200, 'https://www.example-motors.test/new-vehicles/', 980, 'New Subaru Vehicles for Sale | Example Motors', 'Browse new Subaru models at Example Motors.', '["New vehicles"]'::jsonb, 300, 'browser', 'SUCCESS', now() - interval '1 day');
  insert into seo_issues (scan_id, dealership_id, url, check_key, category, severity, message, recommendation, fingerprint)
  values
   (2, 1, 'https://www.example-motors.test/service/', 'h1_missing', 'content', 'critical', 'The page has no H1 heading.', 'Add one H1 that says what the page is about.', 'fp-h1-service'),
   (2, 1, 'https://www.example-motors.test/service/', 'description_missing', 'metadata', 'warning', 'The page has no meta description.', 'Write a 50-165 character description.', 'fp-desc-service');
  insert into seo_checks (scan_id, check_key, category, label, status, pass_count, warn_count, fail_count, points_deducted, max_points)
  values (2, 'h1_missing', 'content', 'Missing H1', 'fail', 2, 0, 1, 4, 8), (2, 'description_missing', 'metadata', 'Missing meta description', 'warn', 2, 1, 0, 2, 6);
  insert into news_articles (dealership_id, title, url, url_hash, title_hash, provider, source, published_at, relevance_score, scope, relevance)
  values
   (1, 'Example Motors hosts community car show', 'https://news.example.invalid/car-show', 'h1', 't1', 'google_rss', 'Springfield Daily', now() - interval '3 days', 75, 'dealership', 'new'),
   (1, 'Subaru announces new Outback trim', 'https://news.example.invalid/outback', 'h2', 't2', 'google_rss', 'Auto News', now() - interval '5 days', 30, 'brand', 'new');
  insert into alerts (dealership_id, type, severity, title, message, dedupe_key)
  values (1, 'issues_resolved', 'info', 'Example Motors: 2 SEO issues resolved', 'Two issues from the previous check are fixed.', 'e2e-resolved-1');
`);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`READY: ${journal.entries.length} migrations, test admin created, listening on 127.0.0.1:${port}`);
