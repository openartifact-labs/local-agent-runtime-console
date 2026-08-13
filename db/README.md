# SQLite 数据库迁移

本目录保存本地 SQLite 数据库的可审计结构迁移。应用首次启动时会自动创建数据库并执行尚未应用的迁移，无需用户单独安装或启动数据库服务。

- `migrations/`：按版本保存 SQLite DDL，文件内容与 API 内嵌迁移保持一致。
- 数据库路径优先读取 `DATABASE_PATH`；未配置时，由调用方传入的本地数据目录决定。
- 开发模式未传入数据目录时，默认写入项目 `.runtime/data/runtime-console.sqlite`。
- 迁移版本记录在数据库内部的 `ai_schema_migrations` 表中。
- 数据库默认启用外键、WAL、合理的忙等待超时和 `NORMAL` 同步级别。

历史 MySQL DDL 不属于开源本地桌面版，已从本目录移除。
