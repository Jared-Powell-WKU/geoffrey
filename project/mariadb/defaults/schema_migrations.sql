CREATE TABLE tncord.schema_migrations (
	`name` varchar(255) NOT NULL,
	`appliedAt` datetime NOT NULL DEFAULT current_timestamp(),
	CONSTRAINT schema_migrations_PK PRIMARY KEY (`name`)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_general_ci;

-- The table definitions in this directory already have the shape these
-- migrations produce, so a fresh install must not run them.
INSERT INTO tncord.schema_migrations (`name`) VALUES
	('001_submission_columns.sql'),
	('002_backfill_created_at.sql'),
	('003_dedupe_media.sql'),
	('004_erase_person_removals.sql');
