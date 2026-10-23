# 桌面宿主 API v1

桌面在 `hostAccess.configure {enabled:true}` 后创建独立的 loopback 监听；`hostAccess.status` 返回实际基础 URL，例如 `http://127.0.0.1:PORT/host/v1`。启动默认关闭，关闭监听、退出和备份恢复会清除尚未使用的配对码。备份恢复同时撤销所有设备。后续手机端通过用户配置的安全隧道连接此接口，监听不会绑定局域网或公网地址。

桌面调用 `hostAccess.pairing {conversationIds,scopes}` 明确会话及 `read`、`send`、`stop` 能力，返回五分钟有效、最多五次尝试的一次性代码。客户端 `POST /pair`，JSON `{code,name}` 换取 `{apiVersion,device,token}`。token 只返回一次；宿主只保存 SHA256。后续每个请求使用 `Authorization: Bearer TOKEN`。接口拒绝浏览器 Origin、Fetch Metadata 和不匹配的 Host，不使用浏览器 Cookie。

| 路由 | 方法 | 授权与返回 |
| --- | --- | --- |
| `/status` | GET | 已配对；宿主标识、版本、平台、能力和活动任务数 |
| `/conversations` | GET | read；当前仍有效的已授权会话 id/name/kind |
| `/conversations/:id/messages?limit=50&before=ID` | GET | read；最近消息，向前分页，单页最多 100 条 |
| `/conversations/:id/tasks` | GET | read；当前会话任务 id/goal/botId/status/active |
| `/conversations/:id/messages` | POST | send；`{content,requestId}`，由 Core 正常消息流程执行，同一设备请求 ID 幂等 |
| `/conversations/:id/stop` | POST | stop；`{taskId}`，Core 停止此会话任务 |

普通返回为 `{apiVersion:'1',result:...}`，错误为 `{error}`；配对和状态使用上述直接对象。POST 必须是 application/json，正文最多 512 KiB。接口没有通用 RPC、模型配置、系统命令、凭据及全局快照入口。消息只返回已发表用户和成员内容、原产出附件 ID；附件正文接口后续按会话授权扩展。

桌面管理接口：`hostAccess.devices`、`hostAccess.revoke {id}`。常驻设置使用 `hostAccess.resident.get/set`，set 参数 `{openAtLogin,keepAwake}`；对应 Electron 主进程方法 `resident.get/set`。主进程退出释放保持唤醒，登录启动由系统维护。
