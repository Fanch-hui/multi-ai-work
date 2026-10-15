# 岗位运行验收

先生成本地资源包，再准备逐岗位模拟资料。运行器使用临时 Core、独立岗位成员和工作目录，以及 Qoder 官方本机登录；不会读取或复制凭据。

```sh
python3 scripts/presets/build.py --output release/presets
node --import tsx scripts/presets/run-acceptance.ts \
  --fixtures scripts/presets/fixtures.example.json \
  --preset legal-intake
```

上述命令只检查准备条件。加 `--run` 执行真实模型调用：

```sh
node --import tsx scripts/presets/run-acceptance.ts \
  --fixtures scripts/presets/fixtures.example.json \
  --preset legal-intake --preset student-course-tutor \
  --run --concurrency 2 --output release/preset-acceptance/review-batch
```

默认模型为 `qmodel_38max`，并发为 2，每岗位超时 8 分钟。`--preset` 可重复；省略时选择目录全部岗位，并要求每个岗位都有 fixture。`--skip-existing` 可恢复同一输出目录，只有岗位、模拟资料和模型匹配，真实运行完成、成功读取绑定技能且可读成果摘要一致时才跳过；原审阅状态保留。

fixture 文件以岗位 ID 为键，内容结构如下。文件路径相对于岗位临时工作目录；素材应全部为模拟数据。

```json
{
  "legal-intake": {
    "scenario": "模拟案件接待材料",
    "prompt": "依据案件材料生成接待记录和缺口清单。",
    "files": [{ "path": "materials.md", "content": "模拟资料正文" }],
    "reviewChecks": ["区分已核验事实和当事人陈述"]
  }
}
```

每个岗位保存 `run.json`、`fixture.json`、`response.md` 和实际登记的成果；`workspace` 保留模拟输入、计算脚本及结果文件，供审阅计算来源，总表为 `acceptance.json`。运行事实包括任务终态、成功读取绑定 Skill 的 Core 操作记录、成果可读性和摘要。等待补充资料、审批、超时及失败均保留证据，继续其他岗位。

所有新运行结果均标记 `pending_review`。审阅者需读取实际成果，逐项判断 `reviewChecks` 及岗位职责覆盖，确认素材来源和推理正确，才可标记通过。运行器不自动改动发布目录，也不根据模型自述或关键词决定通过。

类型检查：`pnpm exec tsc --noEmit -p scripts/presets/tsconfig.json`。

需要实际数据清理或数值核验的岗位，可显式加 `--compute` 授权验收成员使用 `load_workspace_dependencies` 与 `run_command`，在隔离工作目录执行计算。生产成员仍由用户独立选择权限，运行器不修改正式成员。
