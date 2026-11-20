ALTER TABLE "jobs" ALTER COLUMN "state" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
DROP TYPE "job_status_enum";--> statement-breakpoint
CREATE TYPE "job_status_enum" AS ENUM('SUBMITTED', 'RUNNING', 'STOPPED', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "state" SET DATA TYPE "job_status_enum" USING "state"::"job_status_enum";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "state" SET DEFAULT 'SUBMITTED'::"job_status_enum";