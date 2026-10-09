ALTER TYPE "public"."user_role" ADD VALUE 'client';--> statement-breakpoint
CREATE TABLE "user_dealerships" (
	"user_id" integer NOT NULL,
	"dealership_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_dealerships_user_id_dealership_id_pk" PRIMARY KEY("user_id","dealership_id")
);
--> statement-breakpoint
ALTER TABLE "user_dealerships" ADD CONSTRAINT "user_dealerships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_dealerships" ADD CONSTRAINT "user_dealerships_dealership_id_dealerships_id_fk" FOREIGN KEY ("dealership_id") REFERENCES "public"."dealerships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_dealerships_dealership_idx" ON "user_dealerships" USING btree ("dealership_id");