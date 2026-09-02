CREATE TABLE "inpx_archives" (
	"id" serial PRIMARY KEY NOT NULL,
	"library_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"absolute_path" varchar(4096) NOT NULL,
	"size_bytes" bigint,
	"mtime_ms" bigint,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"total_books" integer DEFAULT 0 NOT NULL,
	"imported_books" integer DEFAULT 0 NOT NULL,
	"enriched_books" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"last_imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inpx_archives_status_chk" CHECK ("inpx_archives"."status" in ('pending', 'importing', 'complete', 'failed')),
	CONSTRAINT "inpx_archives_counts_nonnegative_chk" CHECK ("inpx_archives"."total_books" >= 0 and "inpx_archives"."imported_books" >= 0 and "inpx_archives"."enriched_books" >= 0)
);
--> statement-breakpoint
ALTER TABLE "book_files" ALTER COLUMN "ino" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "storage_kind" varchar(20) DEFAULT 'filesystem' NOT NULL;--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "archive_entry_path" varchar(4096);--> statement-breakpoint
ALTER TABLE "book_files" ADD COLUMN "inpx_archive_id" integer;--> statement-breakpoint
ALTER TABLE "inpx_archives" ADD CONSTRAINT "inpx_archives_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inpx_archives_library_path_uidx" ON "inpx_archives" USING btree ("library_id","absolute_path");--> statement-breakpoint
CREATE INDEX "inpx_archives_library_id_idx" ON "inpx_archives" USING btree ("library_id");--> statement-breakpoint
ALTER TABLE "book_files" ADD CONSTRAINT "book_files_inpx_archive_id_inpx_archives_id_fk" FOREIGN KEY ("inpx_archive_id") REFERENCES "public"."inpx_archives"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_files_inpx_archive_id_idx" ON "book_files" USING btree ("inpx_archive_id");--> statement-breakpoint
ALTER TABLE "book_files" ADD CONSTRAINT "book_files_storage_kind_chk" CHECK ("book_files"."storage_kind" in ('filesystem', 'inpx'));--> statement-breakpoint
ALTER TABLE "book_files" ADD CONSTRAINT "book_files_inpx_entry_chk" CHECK (("book_files"."storage_kind" <> 'inpx') or ("book_files"."archive_entry_path" is not null and "book_files"."inpx_archive_id" is not null));