CREATE TABLE tncord.inputoutput (
	`name` varchar(255) NOT NULL,
	`value` varchar(500) NOT NULL,
	`guildId` varchar(50) NOT NULL,
	`userId` varchar(50),
	`lastUpdated` timestamp NOT NULL DEFAULT current_timestamp(),
	CONSTRAINT io_PK PRIMARY KEY (`name`,`guildId`)
)
ENGINE=InnoDB
DEFAULT CHARSET=utf8mb4
COLLATE=utf8mb4_general_ci;
