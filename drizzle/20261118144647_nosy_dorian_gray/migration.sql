CREATE TYPE "job_status_enum" AS ENUM('SUBMITTED', 'PENDING', 'RUNNING', 'STOPPED', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"image" text NOT NULL,
	"cmd" text,
	"state" "job_status_enum" DEFAULT 'SUBMITTED'::"job_status_enum" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
