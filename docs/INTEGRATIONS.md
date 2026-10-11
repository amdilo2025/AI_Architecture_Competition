# 外部服务接入

## 已实现的真实地图链路

- Leaflet 1.9.4 浏览器地图，无密钥。瓦片默认为 https://tile.openstreetmap.org/{z}/{x}/{y}.png ，通过 MAP_TILE_URL 与 MAP_ATTRIBUTION 切换。
- Photon：PHOTON_BASE_URL 默认 https://photon.komoot.io 。后端手动查询 `/api/?q=...&limit=6&lat=...&lon=...`，映射 OSM公共地点。用户必须选中结果，查询不会自动创建订单。
- OSRM：OSRM_BASE_URL 默认 https://routing.openstreetmap.de/routed-car 。`/table/v1/driving/lon,lat;...` 获取距离和时间，`/route/v1/driving/...` 获取完整 GeoJSON 坐标。请求最多每秒一次，全局串行，SQLite缓存24小时；道路吸附半径300米。

客户端只发送公开地点名称和规划所需坐标，不发送账号、密码、收货人电话。地图保留归属，OSRM来源及纠正地图链接。坐标均为WGS84；接入其他坐标系的地图平台需在适配层转换。

公开端点无可用性保证，较大业务应自建或使用适合的服务。公共瓦片不能下载为离线包，不能批量预加载或自动化扫描；自动化浏览器测试拦截瓦片请求。Photon公开演示允许适量使用；本应用不做系统化POI抓取或批量地址搜索。

参考：[Leaflet](https://leafletjs.com/examples/quick-start/)、[OSM瓦片政策](https://operations.osmfoundation.org/policies/tiles/)、[Photon仓库及使用说明](https://github.com/komoot/photon)、[OSRM接口](https://project-osrm.org/docs/v5.24.0/api/)、[道路公共服务限速](https://routing.openstreetmap.de/about.html)。

## 本地大模型（可选）

默认本地分类模型已可使用。若已有免费本地大模型服务器，设置 LLM_BASE_URL（含服务需要的 `/v1`）、LLM_MODEL、可选 LLM_API_KEY。

后端调用 `/chat/completions`，输入订单和可用车辆上下文，期望 `{text,disable_vehicle_ids:null|[已有编号]}`。响应严格检查编号存在且至少保留一辆车；任意代码、未知参数和直接下发指令不执行。模型失败保留本地分类与诊断功能并说明。

例如 Ollama 的 OpenAI-compatible 服务可配置 `http://127.0.0.1:11434/v1` 和本机已下载的模型名。此项目没有代用户下载通用大模型，也没有声明已连接大模型；本地意图分类器和 OR-Tools 调度已实际运行。

## 车辆平台

VEHICLE_BASE_URL / VEHICLE_API_KEY 配置服务端统一网关，backend/integrations.py 中 VehicleGateway 支持 GET `/vehicles`、GET `/vehicles/{id}/telemetry` 和内部 `/missions` 协议适配。

本版仅暴露受登录保护的车辆列表读取；真实任务下发没有公开调用入口。地图车辆动画是方案预演。实际无人车禁行、限速、车辆位置与剩余电量须由供应商接口导入并转换，不能把普通驾车OSRM路线直接当成无人车道路许可。

## 部署

服务URL和凭证只在后端 .env 保存，不随前端构建打包。部署HTTPS时设 COOKIE_SECURE=true 与 PUBLIC_APP_URL。压缩包排除 .env、账号数据库、运行数据和缓存。
