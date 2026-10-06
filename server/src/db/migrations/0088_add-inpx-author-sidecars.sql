CREATE TABLE "inpx_author_sidecars" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"author_key" varchar(64) NOT NULL,
	"library_root" varchar(4096) NOT NULL,
	"bio_shard_name" varchar(512),
	"bio_entry_path" varchar(4096),
	"portrait_shard_name" varchar(512),
	"portrait_entry_path" varchar(4096),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inpx_author_sidecars" ADD CONSTRAINT "inpx_author_sidecars_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inpx_author_sidecars_library_key_uidx" ON "inpx_author_sidecars" USING btree ("library_id","author_key");--> statement-breakpoint
CREATE INDEX "inpx_author_sidecars_library_id_idx" ON "inpx_author_sidecars" USING btree ("library_id");