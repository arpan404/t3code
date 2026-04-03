import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "queued_composer_messages_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN queued_composer_messages_json TEXT NOT NULL DEFAULT '[]'
    `;
  }

  if (!columns.some((column) => column.name === "queued_steer_request_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN queued_steer_request_json TEXT
    `;
  }
});
