import { loadConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import { SqliteRuntimeRepository } from "./sqlite-runtime-repository.js";

const config = loadConfig();
let repository: SqliteRuntimeRepository | undefined;

try {
  repository = new SqliteRuntimeRepository(config.database);
  await repository.verify();
  console.info(`SQLite 数据库迁移完成：${config.database.path}`);
} catch (error) {
  console.error(`SQLite 数据库迁移失败：${errorMessage(error)}`);
  process.exitCode = 1;
} finally {
  await repository?.close();
}
