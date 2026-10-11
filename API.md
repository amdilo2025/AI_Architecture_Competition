# 路序 API v2

前缀 `/api/v1`。JSON；业务错误：`{"error":{"code":"...","message":"...","fields":[],"request_id":"..."}}`。422参数错误；409版本/重复冲突；401未登录；404不存在或非本人数据；502真实服务失败。HTTP客户端提交 mutation 时 Origin 必须为当前应用或 PUBLIC_APP_URL（无Origin的CLI允许）。

## 注册登录

| 方法 | 路径 | 数据 |
|---|---|---|
| POST | /auth/register | username, display_name, password；返回公开用户并设置会话 cookie |
| POST | /auth/login | username, password；返回公开用户并设置 cookie |
| GET | /auth/me | 当前公开用户 id / username / display_name |
| POST | /auth/logout | 注销当前会话 |
| GET | /health | 服务状态与版本 |

用户名3～40位中文、字母、数字或下划线；密码10～128位。除认证/健康外 API 必须有会话。任务与其场景、作业、建议、方案、对比和预演均按任务归属核验。

## 任务与真实数据

| 方法 | 路径 | 用途 |
|---|---|---|
| POST / GET | /tasks | 新建任务 / 本人任务列表 |
| GET | /tasks/{id} | 消息与场景、方案、作业索引 |
| POST | /tasks/{id}/scenarios | 用户输入与真实道路矩阵 |
| GET | /scenarios/{id} | 当前数据与原始输入、道路来源 |
| PATCH | /scenarios/{id} | `{expected_revision,data}` 更新 |
| POST | /scenarios/{id}/refresh-roads | `{expected_revision}` 强制刷新道路与路线缓存并生成新版本 |
| GET | /scenarios/{id}/orders | page/page_size/query 搜索分页 |
| GET | /places/search | query（2～160字）、lat、lon；Photon公共地点 |
| GET | /map/config | 瓦片配置、归属、最大缩放 |

`RealScenarioInput`：city、含时区的 start_time、horizon_seconds（600～86400）、depot、orders（1～50）、vehicles（1～15）。

位置：`{name,address,lat,lon,source}`，坐标 WGS84；source 为 map_pick/photon/user_coordinates。地址不自动搜索。

订单：`{id,location,weight_kg,window_start,window_end,service_seconds}`；秒数相对于 start_time，结束须在工作时段内且能完成交付，编号唯一。重量内部转换为克。

车辆：`{id,name,capacity_kg,range_km,fixed_cost_cents,cost_per_km_cents,available}`；available 默认 true，至少一辆可用；编号唯一。计费单位为分。不创建默认车辆。

响应包含 source=user_input_osm、coordinate_system=WGS84、input原始数据、nodes、orders、可用vehicles、road_matrix（非对称米/秒矩阵、OSRM来源、真实获取时间、道路吸附位置）。相同坐标编辑复用原道路快照。保存后旧方案保留快照，界面显示过期。

## 调度与 AI

POST `/optimization-jobs` 或 `/comparison-jobs`：`{scenario_id,expected_revision,algorithm:"optimized",time_limit_seconds:4}`，202作业。支持 Idempotency-Key，按任务隔离；同键不同参数409。

GET `/jobs/{id}`；POST `/jobs/{id}/cancel`。作业阶段包括求解、校验与真实道路几何获取；取消不发布结果。GET `/plans/{id}`、GET `/comparisons/{id}`。

方案：routes、unassigned、validation、metrics、snapshot。每个 used 路线的 legs.geometry 是 WGS84 `[lon,lat]` 完整道路形状，无法获取时作业失败，不发布直线路线。metrics 里程含返站；cost_cents按用户费用估算；solve_seconds为求解时间，不含后续网络几何获取。

POST `/tasks/{id}/messages`：`{content,scenario_revision}`。响应含 source=local_ai/model、ai的意图与置信度、说明、actions、可选proposal。故障建议只停用现有车辆，不凭空创建车辆或订单。POST `/proposals/{id}/apply`：`{expected_revision}`，需要版本一致，更新场景；已应用建议幂等返回。

## 路线预演与外部服务

POST `/simulations`：`{plan_id}`，无已分配订单或无有效路线时返回409与修复提示。POST `/simulations/{id}/commands`：`{command:"play|pause|reset|speed|seek",speed:60,elapsed_seconds:120}`；GET `/simulations/{id}/state`。speed范围1～120，仅speed命令改变倍速；seek必须提供elapsed_seconds（0～86400秒），超出路线总时长夹紧至结束。暂停状态跳转仍保持暂停；完成后先reset再play。状态含车辆沿实际道路的位置、交付数和事件。这些是方案预演，不是真实车辆遥测。

GET `/integrations/status`；POST `/integrations/{kind}/check`（llm/vehicle）；GET `/integrations/vehicle/vehicles` 为已配置车辆网关读取，尚需用户确认并录入到任务。没有真实任务下发 API。

完整字段、范围和响应文档可在应用 `/docs` 查阅。
