CREATE TABLE "calendar_coverage" (
	"market" text NOT NULL,
	"year" integer NOT NULL,
	CONSTRAINT "calendar_coverage_market_year_pk" PRIMARY KEY("market","year")
);
