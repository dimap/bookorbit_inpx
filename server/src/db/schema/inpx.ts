import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, pgTable, serial, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/pg-core';

import { libraries } from './libraries';

export const inpxArchives = pgTable(
  'inpx_archives',
  {
    id: serial('id').primaryKey(),
    libraryId: integer('library_id')
      .notNull()
      .references(() => libraries.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    absolutePath: varchar('absolute_path', { length: 4096 }).notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    totalBooks: integer('total_books').notNull().default(0),
    importedBooks: integer('imported_books').notNull().default(0),
    enrichedBooks: integer('enriched_books').notNull().default(0),
    errorMessage: text('error_message'),
    lastImportedAt: timestamp('last_imported_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('inpx_archives_library_path_uidx').on(t.libraryId, t.absolutePath),
    index('inpx_archives_library_id_idx').on(t.libraryId),
    check('inpx_archives_status_chk', sql`${t.status} in ('pending', 'importing', 'complete', 'failed')`),
    check('inpx_archives_counts_nonnegative_chk', sql`${t.totalBooks} >= 0 and ${t.importedBooks} >= 0 and ${t.enrichedBooks} >= 0`),
  ],
);

export type InpxArchive = typeof inpxArchives.$inferSelect;
export type NewInpxArchive = typeof inpxArchives.$inferInsert;
