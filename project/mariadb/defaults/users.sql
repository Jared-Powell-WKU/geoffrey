CREATE TABLE tncord.users (
	id varchar(100) NOT NULL,
	guildId varchar(100) NOT NULL,
	CONSTRAINT users_PK PRIMARY KEY (id,guildId)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_general_ci;