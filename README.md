# 工业过程数字孪生与异常根因推理服务

纯后端 Node.js + TypeScript + Fastify 项目，使用内存状态运行，不依赖 Docker、数据库或消息队列。

## 运行

```bash
npm install
npm test
npm start
```

## 业务闭环

设备拓扑版本 → 遥测接入 → 时间序列重放 → 阈值异常检测 → 拓扑影响分析 → 根因候选 → 工单状态机 → 审计追踪。

关键不变量：拓扑版本连续且按生效时间选择；遥测事件按业务时间和序列号重放；工单只能沿合法状态机迁移；所有重要操作产生审计记录。

## 根因分析的拓扑快照不变量

拓扑发布与根因分析并发时，必须保证一次分析回溯到一个完整、可解释的设备结构：

1. **开始即捕获，全程只读快照**：`RootCauseService.analyze` 在任何 `await` 之前同步调用
   `TopologyService.captureSnapshot`，得到唯一的 `TopologySnapshot`；随后的上游遍历只读取
   快照内的节点/边索引，不再回查 store。发布是 append-only，只追加新版本，
   不能改写进行中分析已捕获的输入。
2. **版本自包含且不可变**：每个 `TopologyVersion` 同时携带该版本的 `nodes` 与 `edges`，
   发布时深拷贝并 `deepFreeze`；边 id、路径 traceId 均含版本号且确定性生成
   （`edge_v{n}_from__to`、`trace_v{n}_...`），杜绝"节点旧版本 + 边新版本"的混合路径。
3. **结果四要素相互对应**：分析结果中的 `nodes` / `edges` / `version`（含 `snapshotId`、
   `effectiveAt`）/ `audit` 必须同源；`snapshotId` 由版本完整内容 FNV 哈希导出，
   结果另有 `fingerprint`，相同输入的重复分析逐字段一致、可解释、可追溯。
4. **失败重试携带明确版本上下文**：重试通过 `analysisId` 恢复运行记录（attempts 追加），
   钉死的 `version` 不可更改（冲突抛 `VERSION_CONTEXT_MISMATCH`）；审计链为
   `root-cause.start -> root-cause.failed* -> root-cause.complete`，每条记录都带版本与快照标识。
5. **历史版本回看**：`GET /topology/versions/:n` 与分析参数 `?version=n` 钉住任意历史版本，
   历史版本内容不随后续发布变化。

发布在互斥区内原子完成（版本号连续校验、悬空边/重复边/未知节点校验、落库、审计）。
