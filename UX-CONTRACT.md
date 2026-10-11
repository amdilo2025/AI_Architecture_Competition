# 路序交互契约

业务来源：本次用户明确要求白色主题、注册登录、公开真实道路与地点、订单和车辆由用户录入。领域与接口约束由 API.md、backend/models.py、backend/auth.py 定义。单站出发并返站，普通包裹，载重/续航/时间窗口硬约束；最大化按时完成订单，再降低录入计费费用与道路里程。

## Canonical UI Map
| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Form | frontend/src/ui.tsx Input | API.md | auth and delivery data | browser fields and errors |
| Select/Listbox | native select | UX-CONTRACT.md | browser-owned popup accepted | keyboard and open popup |
| Date | native date/time input through Input | API.md | browser-owned popup accepted, Asia/Shanghai data | browser input and formatted time |
| Scrollbar | frontend/src/style.css global | DESIGN.md | internal panels | computed style |
| Toast | inline status and shared error banner | UX-CONTRACT.md | info/error | live-region |
| CRUD | frontend/src/api.ts and task flow | API.md | task/scenario | end-to-end create/read/update |
| Splitter | frontend/src/ResizableDivider.tsx | DESIGN.md | desktop sidebar/chat widths | pointer, keyboard, persistence, narrow viewport |

## Workflow and state
新建任务明确创建持久任务（SQLite）；已创建任务的场景、消息、方案可恢复。注册/登录由后端验证并使用 HttpOnly 会话 cookie；服务端按任务 owner_id 隔离数据，跨账号ID查询返回404。旧版无归属任务不自动分配给任何账号。当前监听127.0.0.1。录入删除只修改草稿，在保存前可取消，任务本身无删除操作。
修改订单或车辆等待服务器确认。expected_revision 冲突返回409，保留表单和既有方案；旧方案显示版本过期。草稿以用户和任务为键保存在当前浏览器 sessionStorage；登录过期可重新登录恢复安全草稿，不保存密码。新任务/切换任务的异步结果不得覆盖当前任务。
计算状态 queued/running/succeeded/failed/cancelled；业务 outcome full/partial/infeasible。后台计算是线程池任务，保存固定输入快照。重复创建计算由 Idempotency-Key 去重。
取消求解设置标志，停止搜索回调，结果提交前再次检查。切换任务不会取消后台计算。
仿真绑定方案，时间由后端单调时钟推进。播放、暂停、重置、倍速、seek 为状态命令，seek 从原方案确定位置而非重新规划。没有分配订单的方案不能创建或播放预演，页面说明原因。完成后可重新播放。默认60倍速，播放前可选；暂停保留进度，重置归零。新控制命令使旧轮询失效，不得以旧状态覆盖暂停或跳转。
所有成本比较同时提供订单完成量；未分配订单进入分母，不对不等完成量宣称节约比例。

## Interaction
表单 noValidate；字段错误与输入关联，保留内容。Modal 用原生 dialog 的模态语义、焦点约束、Escape 和返回触发元素。选择器采用原生行为，不自定义系统弹出窗口。文本区域不允许拖拽调整，足够默认高度。
Enter发送，Shift+Enter换行，isComposing时不发送。手动向上滚动后不强制自动下滑。
各列表分页；筛选立即重置页码。错误显示具体修复操作，不用原生alert/confirm/prompt。
真实道路失败时保留录入内容并提示重试，不生成矩形路网或直线路线。Photon 搜索仅在用户点击搜索时请求，最多每秒一次且缓存；自动化浏览器测试拦截公共瓦片，避免批量请求。地图加载归属、OSRM来源与纠正地图链接持续可见。搜索清空与草稿编辑属于本地行为。
默认AI为本地字符TF-IDF+逻辑回归意图模型、事实约束诊断与OR-Tools求解。可选大模型失败时使用本地AI并说明。故障停用建议基于当前车辆ID，先显示可核对建议，再显式应用；建议本身不控制真实车辆。预演时间沿真实道路形状按长度插值，不表示实时遥测。

## Locale and accessibility
zh-CN, Asia/Shanghai; 24小时制。API秒/米/千克，界面分钟/公里。按钮名称与业务一致、可见焦点、文字状态、减少动画。图形节点为button语义并提供键盘操作。
Route document title policy: 当前任务名 — 路序。未知任务显示可恢复的错误。

全国地图提供全国视图和定位全部配送点两个独立动作；有数据时自动定位其范围。坐标使用 WGS84。数据说明通过共享 DataGuide 提供，编辑器可展开字段说明。桌面分隔线支持指针、方向键10px（Shift50px）、Home/End、Enter或双击恢复该栏；页面按钮恢复两栏。栏宽只在本机按账号保存，不存业务或敏感数据，窄屏隐藏拖动。
