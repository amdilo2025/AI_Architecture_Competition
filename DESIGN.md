---
version: alpha
colors:
  primary: "#20252b"
  background: "#ffffff"
  sidebar: "#f7f8fa"
  surface: "#f1f3f5"
  border: "#dce1e7"
  text: "#20252b"
  muted: "#606b78"
  success: "#167556"
  warning: "#93600a"
  danger: "#b42336"
typography:
  body:
    fontFamily: "Segoe UI, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: "1.6"
  utility:
    fontFamily: "Consolas, SFMono-Regular, monospace"
    fontSize: "12px"
rounded:
  control: "8px"
  panel: "14px"
  composer: "24px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
---

## Overview
路序是面向配送站调度员的城市无人车调度工作台。参考 Codex/ChatGPT 的侧栏、会话与工作区布局；保留自己的业务名称，不使用其标识。用户本次确认白色主题、中文、Asia/Shanghai。注册登录后录入配送站、订单与车辆，用公开真实道路规划方案。空工作台始终保持零业务数据。

## Colors
白色主背景与浅灰侧栏保持清晰层次，石墨色主按钮，绿色状态；真实地图占据工作区主视觉。路线使用编号与颜色共同区分。数据来源收纳在地图归属与数据详情中，删除无关环境文案。

## Typography
正文使用本地系统字体，无外部字体依赖；工具信息使用等宽字体。数字使用 tabular-nums。

## Layout
桌面默认 220px 侧栏、390px 对话区和弹性工作区；两个 8px 分隔线支持拖动与键盘调整。侧栏 180～360px、对话 260～720px，随可用宽度夹紧并为方案保留至少 320px；用户栏宽按账号保存在本机，可恢复默认。中屏侧栏可折叠；1000px及以下隐藏分隔线，对话与方案切换。页面框架是应用内容滚动器，会话、表格与对话框分别拥有滚动；表格高度不改变其他视图。地图默认全国视野，有配送数据时定位其范围，随面板缩放更新地图尺寸。

## Elevation & Depth
主区域无重阴影。仅弹层使用有限阴影，边界以细线表达。

## Shapes
按钮 8px、面板 14px、输入框 24px；没有宣传横幅、渐变或无关装饰。

## Components
Token ownership: DESIGN.md generates frontend/src/tokens.css via scripts/generate_tokens.py. No manual edits to generated tokens. 字体、圆角、间距和颜色经 CSS 变量供共享控件消费。路网与路线色板另在图形组件中定义为数据色。
Button、Field、Modal、消息与状态由共享组件管理。所有图标按钮有中文名称；状态不只靠颜色。

## Do's and Don'ts
计算阶段来自后端；真实道路不可用时明确失败，不切换虚构路网。地图使用 Leaflet、OpenStreetMap；地点搜索 Photon，路线 OSRM。界面支持键盘、窄屏、减少动画。区分本地意图分类模型、约束优化和可选大模型。订单与车辆只来自用户输入。路线预演不是实时车辆跟踪。
