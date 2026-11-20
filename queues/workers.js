import { Worker } from "bullmq";
import { db } from "../db/index.js";
import { jobsTable, jobStatusEnum, jobStatusEnumValues } from "../db/schema.js";
import { eq, sql, inArray } from "drizzle-orm";
import Docker from "dockerode";

const docker = new Docker({
  socketPath: "\\\\.\\pipe\\docker_engine",
});

function pullImage(image) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);

      docker.modem.followProgress(stream, (err, output) => {
        if (err) return reject(err);

        console.log(`Successfully pulled ${image}`);
        resolve(output);
      });
    });
  });
}
export const jobDispatchWorker = new Worker(
  "job-dispatcher",
  async () => {
    console.log("[JobDispatcher]: Checking for new Submitted job");
    await db.transaction(async (tx) => {
      const stmt = sql`
    SELECT
       id
    FROM ${jobsTable}
    WHERE ${jobsTable.state}=${jobStatusEnumValues[0]}
    ORDER BY ${jobsTable.createdAt} ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 5;
`;

      const result = await tx.execute(stmt);
      const jobIds = result.rows.map((e) => e.id);

      console.log(
        `[JobDispatcher]: Found ${jobIds.length} jobs in Submitted State`,
        jobIds,
      );

      //TODO: check if compute is available
      if (jobIds.length > 0) {
        //Move the submitted jobs to running
        console.log(
          `[JobDispatcher]: Moving ${jobIds.length} jobs to Runnable State`,
        );
        await tx
          .update(jobsTable)
          .set({ state: "RUNNABLE" })
          .where(inArray(jobsTable.id, jobIds));
      }
    });
  },
  {
    connection: {
      host: "127.0.0.1",
      port: 6379,
    },
  },
);

export const jobCriWorker = new Worker(
  "job-cri",
  async () => {
    try {
      console.log("[JobCRI]: Checking for new Runnable jobs");

      const [job] = await db.transaction(async (tx) => {
        const stmt = sql`
          SELECT id
          FROM ${jobsTable}
          WHERE ${jobsTable.state} = ${jobStatusEnumValues[1]}
          ORDER BY ${jobsTable.createdAt} ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1;
        `;

        const result = await tx.execute(stmt);
        const jobId = result.rows[0]?.id;

        if (!jobId) return [];

        const [job] = await tx
          .update(jobsTable)
          .set({ state: "RUNNING" })
          .where(eq(jobsTable.id, jobId))
          .returning();

        return [job];
      });

      if (!job) return;

      try {
        const imageName = job.image.includes(":")
          ? job.image
          : `${job.image}:latest`;

        const checkImageResult = await docker.listImages({
          filters: {
            reference: [imageName],
          },
        });

        if (!checkImageResult.length) {
          await pullImage(imageName);
        }

        const container = await docker.createContainer({
          Image: imageName,
          Tty: false,
          Cmd: ["sh", "-c", "while true; do sleep 1; done"],
          HostConfig: {
            AutoRemove: false,
          },
        });

        await db
          .update(jobsTable)
          .set({
            containerId: container.id,
          })
          .where(eq(jobsTable.id, job.id));

        await container.start();

        await db
          .update(jobsTable)
          .set({
            state: "RUNNING",
          })
          .where(eq(jobsTable.id, job.id));

        console.log(
          `[JobCRI]: Container started for job ${job.id}`,
          container.id,
        );
      } catch (error) {
        console.error(`[JobCRI]: Failed job ${job.id}`, error);

        await db
          .update(jobsTable)
          .set({
            state: "FAILED",
          })
          .where(eq(jobsTable.id, job.id));
      }
    } catch (error) {
      console.error("[JobCRI]: Error", error);
    }
  },
  {
    connection: {
      host: "127.0.0.1",
      port: 6379,
    },
  },
);

export const jobWatch = new Worker(
  "job-watch",
  async () => {
    try {
      console.log("[JobWatcher]: Checking for Running jobs");

      const runningJobs = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.state, "RUNNING"));

      console.log(
        `[JobWatcher]: Found ${runningJobs.length} Running jobs`,
      );

      for (const job of runningJobs) {
        if (!job.containerId) {
          console.log(`Job ${job.id} has no containerId`);
          continue;
        }

        try {
          const container = docker.getContainer(job.containerId);
          const containerStatus = await container.inspect();

          if (containerStatus.State.Status === "exited") {
            const exitCode = containerStatus.State.ExitCode;

            console.log(`Job ${job.id} exited with code ${exitCode}`);

            await db
              .update(jobsTable)
              .set({
                state: exitCode === 0 ? "SUCCEEDED" : "FAILED",
                containerId: null,
              })
              .where(eq(jobsTable.id, job.id));

            await container.remove();
          }
        } catch (error) {
          console.error(
            `[JobWatcher]: Error checking job ${job.id}`,
            error,
          );
        }
      }
    } catch (error) {
      console.error("[JobWatcher]: Error", error);
    }
  },
  {
    connection: {
      host: "127.0.0.1",
      port: 6379,
    },
  },
);
