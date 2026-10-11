import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowUp,
  ArrowRight,
  ArrowLeft,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  MessageSquare,
  Map,
  Truck,
  Package,
  ChartNoAxesCombined,
  Plug,
  Play,
  Pause,
  RotateCcw,
  Check,
  LoaderCircle,
  X,
  Route as RouteIcon,
  SlidersHorizontal,
  Search,
  Download,
  LogOut,
  Info,
} from "lucide-react";
import { api, ApiError } from "./api";
import { Button, Modal } from "./ui";
import { AuthScreen } from "./AuthScreen";
import { ScenarioEditor } from "./ScenarioEditor";
import { RoadMap, ROUTE_COLORS } from "./RoadMap";
import { ResizableDivider } from "./ResizableDivider";
import { DataGuide } from "./DataGuide";
import {
  clock,
  km,
  type User,
  type Task,
  type Summary,
  type Scenario,
  type ScenarioInput,
  type Plan,
  type Job,
  type Comparison,
  type SimState,
  type Message,
  type Integration,
  type Order,
} from "./types";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  async function check() {
    setChecking(true);
    setError("");
    try {
      setUser(await api<User>("/auth/me"));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401))
        setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void check();
    const expired = () => setUser(null);
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  if (checking)
    return (
      <main className="loading-page">
        <LoaderCircle className="spin" size={24} />
        <p>正在连接工作台…</p>
      </main>
    );
  if (error)
    return (
      <main className="loading-page">
        <p role="alert">{error}</p>
        <Button onClick={() => void check()}>重新连接</Button>
      </main>
    );
  if (!user) return <AuthScreen onLogin={setUser} />;
  return <Workbench key={user.id} user={user} onLogout={() => setUser(null)} />;
}
const labels: Record<string, string> = {
  optimize: "生成方案",
  map: "地图查看",
  compare: "对比基准",
  comparison: "查看对比",
  simulate: "播放预演",
};
function Workbench({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tasks, setTasks] = useState<Summary[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [sim, setSim] = useState<SimState | null>(null);
  const [previewSpeed, setPreviewSpeed] = useState(60);
  const simSequence = useRef(0);
  const [tab, setTab] = useState("map");
  const [modal, setModal] = useState<
    "editor" | "integrations" | "order" | "sources" | "guide" | null
  >(null);
  const [sidebar, setSidebar] = useState(true);
  const layoutKey = `dispatch-layout:${user.id}`;
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(layoutKey) || "null");
      if (Number.isFinite(saved?.sidebar) && Number.isFinite(saved?.chat))
        return {
          sidebar: Math.max(180, Math.min(360, saved.sidebar)),
          chat: Math.max(260, Math.min(720, saved.chat)),
        };
    } catch {}
    return { sidebar: 220, chat: 390 };
  });
  const [viewport, setViewport] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(widths));
    } catch {}
  }, [layoutKey, widths]);
  const sidebarMax = Math.max(180, Math.min(360, viewport - 596));
  const sidebarWidth = Math.min(widths.sidebar, sidebarMax);
  const chatMax = Math.max(
    260,
    Math.min(720, viewport - (sidebar ? sidebarWidth + 8 : 0) - 328),
  );
  const chatWidth = Math.min(widths.chat, chatMax);
  const [mobile, setMobile] = useState("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [input, setInput] = useState("");
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [connections, setConnections] = useState<Record<string, string>>({});
  const epoch = useRef(0);
  const current = useRef<Task | null>(null);
  const messages = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const loading = !!job && ["queued", "running"].includes(job.status);
  const locked = busy || loading;
  const scene = plan?.snapshot || scenario;
  const canPreview =
    !!plan &&
    plan.metrics.completed_orders > 0 &&
    plan.metrics.finish_seconds > 0;
  const stale =
    !!plan &&
    !!scenario &&
    (plan.scenario_id !== scenario.id ||
      plan.scenario_revision !== scenario.revision);
  useEffect(() => {
    current.current = task;
    document.title = `${task?.name || "城市配送"} — 路序`;
  }, [task]);
  async function fetchTasks() {
    const list = await api<{ items: Summary[] }>("/tasks");
    setTasks(list.items);
    return list.items;
  }
  async function refresh(id: string, version = epoch.current) {
    const value = await api<Task>(`/tasks/${id}`);
    if (version === epoch.current) {
      current.current = value;
      setTask(value);
    }
    return value;
  }
  async function switchTask(id: string) {
    const version = ++epoch.current;
    setBusy(true);
    setError("");
    setJob(null);
    setSim(null);
    setVehicle(null);
    setPage(1);
    setQuery("");
    setPlan(null);
    setComparison(null);
    setScenario(null);
    setModal(null);
    setInput("");
    try {
      const value = await api<Task>(`/tasks/${id}`);
      const s = value.scenario_id
        ? await api<Scenario>(`/scenarios/${value.scenario_id}`)
        : null;
      const p = value.plan_ids.length
        ? await api<Plan>(`/plans/${value.plan_ids.at(-1)}`)
        : null;
      const c = value.comparison_ids.length
        ? await api<Comparison>(`/comparisons/${value.comparison_ids.at(-1)}`)
        : null;
      if (version !== epoch.current) return;
      current.current = value;
      setTask(value);
      setScenario(s);
      setPlan(p || c?.optimized || null);
      setComparison(c);
      setJob(
        value.jobs?.findLast((j) => ["queued", "running"].includes(j.status)) ||
          null,
      );
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  useEffect(() => {
    let alive = true;
    api<{ items: Summary[] }>("/tasks")
      .then((list) => {
        if (!alive) return;
        setTasks(list.items);
        if (list.items.length) void switchTask(list.items[0].id);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    if (follow.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [task?.messages.length, job?.stage]);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const version = epoch.current;
    async function poll() {
      try {
        const j = await api<Job>(`/jobs/${job!.id}`);
        if (!alive || version !== epoch.current) return;
        setJob(j);
        if (j.status === "succeeded" && j.result_id) {
          if (j.result_kind === "plan") {
            const p = await api<Plan>(`/plans/${j.result_id}`);
            if (!alive || version !== epoch.current) return;
            setPlan(p);
            setSim(null);
            setTab("map");
          } else {
            const c = await api<Comparison>(`/comparisons/${j.result_id}`);
            if (!alive || version !== epoch.current) return;
            setComparison(c);
            setTab("comparison");
          }
          if (current.current) await refresh(current.current.id, version);
          await fetchTasks();
          return;
        }
        if (j.status === "failed") {
          setError(j.stage);
          return;
        }
        if (j.status === "cancelled") return;
        timer = setTimeout(poll, 700);
      } catch (e) {
        if (alive && version === epoch.current) {
          setError((e as Error).message);
          timer = setTimeout(poll, 2000);
        }
      }
    }
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [job?.id]);
  useEffect(() => {
    if (!sim || sim.status !== "playing") return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const version = epoch.current;
    async function poll() {
      try {
        const sequence = simSequence.current;
        const s = await api<SimState>(`/simulations/${sim!.id}/state`);
        if (!alive || version !== epoch.current) return;
        if (sequence !== simSequence.current) {
          timer = setTimeout(poll, 600);
          return;
        }
        setSim(s);
        if (s.status === "playing") timer = setTimeout(poll, 600);
      } catch (e) {
        if (alive && version === epoch.current) {
          setError((e as Error).message);
          timer = setTimeout(poll, 2000);
        }
      }
    }
    timer = setTimeout(poll, 600);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sim?.id, sim?.status]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    const version = epoch.current;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (version === epoch.current) setError((e as Error).message);
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function newTask() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<Task>("/tasks", "POST", {
        name: `城市配送 ${tasks.length + 1}`,
      });
      epoch.current++;
      current.current = value;
      setTask(value);
      setScenario(null);
      setPlan(null);
      setComparison(null);
      setJob(null);
      setSim(null);
      setVehicle(null);
      setQuery("");
      setPage(1);
      setInput("");
      setTab("map");
      setMobile("chat");
      await fetchTasks();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function ensureTask() {
    if (current.current) return current.current;
    const value = await api<Task>("/tasks", "POST", { name: "今日城市配送" });
    current.current = value;
    setTask(value);
    await fetchTasks();
    return value;
  }
  async function saveData(data: ScenarioInput) {
    const t = await ensureTask();
    const value = await api<Scenario>(
      scenario ? `/scenarios/${scenario.id}` : `/tasks/${t.id}/scenarios`,
      scenario ? "PATCH" : "POST",
      scenario ? { expected_revision: scenario.revision, data } : data,
    );
    setScenario(value);
    setSim(null);
    setComparison(null);
    await refresh(t.id);
    await fetchTasks();
    setModal(null);
  }
  async function optimize(compare = false) {
    if (!scenario || locked) return;
    if (compare && stale) {
      setError("当前方案基于旧数据，请先重新生成方案。");
      return;
    }
    await run(async () => {
      setJob(
        await api<Job>(
          compare ? "/comparison-jobs" : "/optimization-jobs",
          "POST",
          {
            scenario_id: scenario.id,
            expected_revision: scenario.revision,
            algorithm: "optimized",
            time_limit_seconds: 4,
          },
          crypto.randomUUID(),
        ),
      );
    });
  }
  async function send(content = input.trim()) {
    if (!content || busy) return;
    const version = epoch.current;
    await run(async () => {
      const t = await ensureTask();
      await api<Message>(`/tasks/${t.id}/messages`, "POST", {
        content,
        scenario_revision: scenario?.revision,
      });
      if (version !== epoch.current) return;
      setInput("");
      follow.current = true;
      await refresh(t.id);
      await fetchTasks();
    });
  }
  async function apply(message: Message) {
    if (!message.proposal || !scenario) return;
    await run(async () => {
      setScenario(
        await api<Scenario>(
          `/proposals/${message.proposal!.id}/apply`,
          "POST",
          { expected_revision: scenario.revision },
        ),
      );
      setSim(null);
      setComparison(null);
      if (task) await refresh(task.id);
    });
  }
  async function simulate() {
    if (!plan || busy) return;
    if (!canPreview) {
      setError(
        "当前方案没有可配送路线。请查看未分配原因，修改配送数据后重新生成方案。",
      );
      return;
    }
    const version = epoch.current;
    simSequence.current++;
    await run(async () => {
      let id = sim?.id;
      if (!id || sim?.plan_id !== plan.id)
        id = (
          await api<{ id: string }>("/simulations", "POST", {
            plan_id: plan.id,
          })
        ).id;
      if (sim?.status === "completed")
        await api<SimState>(`/simulations/${id}/commands`, "POST", {
          command: "reset",
          speed: previewSpeed,
        });
      if (previewSpeed !== (sim?.speed || 10))
        await api<SimState>(`/simulations/${id}/commands`, "POST", {
          command: "speed",
          speed: previewSpeed,
        });
      const result = await api<SimState>(
        `/simulations/${id}/commands`,
        "POST",
        {
          command: "play",
          speed: previewSpeed,
        },
      );
      if (version !== epoch.current) return;
      setSim(result);
      setTab("map");
      setMobile("workspace");
    });
  }
  async function simCommand(
    command: string,
    speed = previewSpeed,
    elapsed_seconds?: number,
  ) {
    if (!sim) return;
    const version = epoch.current;
    simSequence.current++;
    await run(async () => {
      const result = await api<SimState>(
        `/simulations/${sim.id}/commands`,
        "POST",
        {
          command,
          speed,
          elapsed_seconds,
        },
      );
      if (version === epoch.current) setSim(result);
    });
  }
  async function action(name: string, message?: Message) {
    if (name === "optimize") void optimize();
    if (name === "compare") void optimize(true);
    if (name === "simulate") void simulate();
    if (name === "map") {
      if (message?.plan_id)
        await run(async () => {
          setPlan(await api<Plan>(`/plans/${message.plan_id}`));
          setSim(null);
        });
      setTab("map");
      setMobile("workspace");
    }
    if (name === "comparison") {
      if (message?.comparison_id)
        await run(async () => {
          setComparison(
            await api<Comparison>(`/comparisons/${message.comparison_id}`),
          );
        });
      setTab("comparison");
      setMobile("workspace");
    }
  }
  function selectOrder(id: string) {
    const o = scene?.orders.find((o) => o.id === id);
    if (o) {
      setOrder(o);
      setModal("order");
    }
  }
  async function services() {
    setModal("integrations");
    await run(async () =>
      setIntegrations(
        (await api<{ items: Integration[] }>("/integrations/status")).items,
      ),
    );
  }
  function exportPlan() {
    if (!plan) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `dispatch-${plan.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
  const route = plan?.routes.find((r) => r.vehicle_id === vehicle);
  const filtered =
    scene?.orders.filter((o) =>
      (o.id + o.name + o.address).toLowerCase().includes(query.toLowerCase()),
    ) || [];
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const tabs = [
    ["map", "地图", Map],
    ["orders", "订单", Package],
    ["vehicles", "车辆", Truck],
    ["comparison", "对比", ChartNoAxesCombined],
  ] as const;
  return (
    <div
      className={`app ${sidebar ? "" : "collapsed"} mobile-${mobile}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--chat-width": `${chatWidth}px`,
        } as CSSProperties
      }
    >
      <aside className="sidebar" id="task-navigation" aria-label="任务导航">
        <div className="brand">
          <RouteIcon size={22} />
          <strong>路序</strong>
          <Button label="折叠侧边栏" onClick={() => setSidebar(false)}>
            <PanelLeftClose size={17} />
          </Button>
        </div>
        <Button
          className="new-task"
          disabled={busy}
          onClick={() => void newTask()}
        >
          <Plus size={17} />
          新建配送任务
        </Button>
        <p className="nav-section-label">配送任务</p>
        <nav className="task-list">
          {tasks.map((t) => (
            <button
              key={t.id}
              className={task?.id === t.id ? "active" : ""}
              onClick={() => void switchTask(t.id)}
              aria-current={task?.id === t.id ? "page" : undefined}
            >
              <MessageSquare size={15} />
              <span>{t.name}</span>
              {t.has_plan && <Check size={13} />}
            </button>
          ))}
          {!tasks.length && <p className="quiet nav-empty">暂无任务</p>}
        </nav>
        <Button className="service-button" onClick={() => void services()}>
          <Plug size={16} />
          服务连接
        </Button>
        <div className="user-row">
          <span className="avatar">{user.display_name.slice(0, 1)}</span>
          <span>{user.display_name}</span>
          <Button
            label="退出登录"
            onClick={() =>
              void run(async () => {
                await api("/auth/logout", "POST");
                onLogout();
              })
            }
          >
            <LogOut size={16} />
          </Button>
        </div>
      </aside>
      {sidebar && (
        <ResizableDivider
          label="调整任务栏宽度"
          controls="task-navigation"
          value={sidebarWidth}
          min={180}
          max={sidebarMax}
          onChange={(value) => setWidths((w) => ({ ...w, sidebar: value }))}
          onReset={() => setWidths((w) => ({ ...w, sidebar: 220 }))}
        />
      )}
      <div className="main-shell">
        <header className="app-header">
          {!sidebar && (
            <Button label="展开侧边栏" onClick={() => setSidebar(true)}>
              <PanelLeftOpen size={17} />
            </Button>
          )}
          <span className="header-title">{task?.name || "城市配送"}</span>
          <Button
            label="恢复默认栏宽"
            className="reset-layout"
            onClick={() => setWidths({ sidebar: 220, chat: 390 })}
          >
            <RotateCcw size={16} />
          </Button>
          <Button label="数据说明" onClick={() => setModal("guide")}>
            <Info size={16} />
            <span className="guide-label">数据说明</span>
          </Button>
          <div className="compact-nav">
            <label className="sr-only" htmlFor="task-select">
              切换配送任务
            </label>
            <select
              id="task-select"
              value={task?.id || ""}
              onChange={(e) => void switchTask(e.target.value)}
            >
              <option value="" disabled>
                配送任务
              </option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Button
              label="新建配送任务"
              disabled={busy}
              onClick={() => void newTask()}
            >
              <Plus size={16} />
            </Button>
            <Button label="服务连接" onClick={() => void services()}>
              <Plug size={16} />
            </Button>
            <Button
              label="退出登录"
              onClick={() =>
                void run(async () => {
                  await api("/auth/logout", "POST");
                  onLogout();
                })
              }
            >
              <LogOut size={16} />
            </Button>
          </div>
          <Button
            label="配送数据"
            disabled={locked}
            onClick={() => setModal("editor")}
          >
            <SlidersHorizontal size={16} />
            <span>配送数据</span>
          </Button>
        </header>
        <div className="mobile-switch">
          <button
            className={mobile === "chat" ? "active" : ""}
            onClick={() => setMobile("chat")}
          >
            调度助手
          </button>
          <button
            className={mobile === "workspace" ? "active" : ""}
            onClick={() => setMobile("workspace")}
          >
            配送方案
          </button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <Button label="关闭错误提示" onClick={() => setError("")}>
              <X size={15} />
            </Button>
          </div>
        )}
        <main className="workbench">
          <section className="chat-panel" id="chat-pane" aria-label="调度助手">
            <div className="chat-heading">
              <h1>调度助手</h1>
              <span className="small-pill">AI</span>
            </div>
            <div
              className="message-list"
              ref={messages}
              onScroll={() => {
                if (messages.current)
                  follow.current =
                    messages.current.scrollHeight -
                      messages.current.scrollTop -
                      messages.current.clientHeight <
                    80;
              }}
            >
              {!task?.messages.length ? (
                <div className="chat-empty">
                  <span className="welcome-mark">
                    <RouteIcon size={30} />
                  </span>
                  <h2>
                    今天的配送，
                    <br />
                    从这里安排。
                  </h2>
                  <p>
                    录入配送站、订单与车辆，
                    <br />
                    在真实道路上规划每一程。
                  </p>
                  <Button
                    primary
                    disabled={locked}
                    onClick={() => setModal("editor")}
                  >
                    录入配送数据
                    <ArrowRight size={15} />
                  </Button>
                </div>
              ) : (
                task.messages.map((m) => (
                  <article className={`message ${m.role}`} key={m.id}>
                    {m.role === "assistant" && (
                      <span className="message-author">
                        {m.source === "local_ai" || m.source === "model"
                          ? "调度 AI"
                          : "路序"}
                      </span>
                    )}
                    <p>{m.content}</p>
                    {m.proposal && (
                      <div className="proposal">
                        <strong>{m.proposal.description}</strong>
                        <Button
                          disabled={
                            locked ||
                            m.proposal.applied ||
                            m.proposal.scenario_revision !== scenario?.revision
                          }
                          onClick={() => void apply(m)}
                        >
                          {m.proposal.applied ? "已应用" : "应用重调度建议"}
                        </Button>
                      </div>
                    )}
                    {m.actions?.length ? (
                      <div className="message-actions">
                        {m.actions.map((a) => (
                          <Button
                            key={a}
                            disabled={
                              locked ||
                              (!scenario && a !== "map") ||
                              (a === "simulate" && !canPreview)
                            }
                            onClick={() => void action(a, m)}
                          >
                            {labels[a] || a}
                            <ArrowRight size={13} />
                          </Button>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
              {loading && (
                <div className="job-card" role="status">
                  <LoaderCircle size={16} className="spin" />
                  <span>
                    {job.stage}
                    <small>已用 {job.elapsed_seconds.toFixed(1)} 秒</small>
                  </span>
                  <Button
                    onClick={() =>
                      void run(async () => {
                        await api(`/jobs/${job.id}/cancel`, "POST");
                      })
                    }
                  >
                    取消
                  </Button>
                </div>
              )}
            </div>
            <div className="chat-bottom">
              {scenario && (
                <div className="quick-actions">
                  <Button
                    disabled={locked}
                    onClick={() => void send("分析订单风险")}
                  >
                    检查风险
                  </Button>
                  <Button
                    disabled={locked || !plan}
                    onClick={() => void send("解释当前方案")}
                  >
                    解释方案
                  </Button>
                </div>
              )}
              <div className="composer">
                <label className="sr-only" htmlFor="chat-input">
                  向调度助手发送消息
                </label>
                <textarea
                  className="resize-none"
                  id="chat-input"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="例如：V01 故障，请重新调度"
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <Button
                  primary
                  label="发送消息"
                  disabled={busy || !input.trim()}
                  onClick={() => void send()}
                >
                  <ArrowUp size={18} />
                </Button>
              </div>
              <div className="workflow-actions">
                <Button disabled={locked} onClick={() => setModal("editor")}>
                  录入数据
                </Button>
                <Button
                  primary
                  disabled={!scenario || locked}
                  onClick={() => void optimize()}
                >
                  生成方案
                </Button>
                <Button
                  disabled={!plan || locked || stale}
                  onClick={() => void optimize(true)}
                >
                  对比基准
                </Button>
              </div>
            </div>
          </section>
          <ResizableDivider
            label="调整对话栏宽度"
            controls="chat-pane"
            value={chatWidth}
            min={260}
            max={chatMax}
            onChange={(value) => setWidths((w) => ({ ...w, chat: value }))}
            onReset={() => setWidths((w) => ({ ...w, chat: 390 }))}
          />
          <section className="workspace" aria-label="配送方案">
            <div className="workspace-header">
              <h1 className="sr-only">配送方案</h1>
              <div className="tabs" role="tablist" aria-label="方案视图">
                {tabs.map(([key, label, Icon]) => (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={tab === key}
                    className={tab === key ? "active" : ""}
                    onClick={() => setTab(key)}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>
              <Button label="数据来源" onClick={() => setModal("sources")}>
                <Info size={16} />
              </Button>
              <Button
                label="导出当前方案"
                disabled={!plan}
                onClick={exportPlan}
              >
                <Download size={16} />
              </Button>
            </div>
            <div className="metric-strip">
              {[
                [
                  "按时完成",
                  plan
                    ? `${plan.metrics.completed_orders}/${plan.metrics.total_orders}`
                    : "—",
                ],
                ["道路里程", plan ? km(plan.metrics.total_distance_m) : "—"],
                ["使用车辆", plan ? `${plan.metrics.vehicles_used} 辆` : "—"],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            {stale && (
              <div className="stale-banner" role="status">
                数据已更新，当前方案为历史版本。请重新生成方案。
              </div>
            )}
            <div className="workspace-content">
              {plan && !canPreview && (
                <div className="infeasible-notice" role="status">
                  <strong>当前方案没有可配送路线，暂不能播放预演。</strong>
                  <ul>
                    {plan.unassigned.map((item) => (
                      <li key={item.order_id}>
                        {item.order_id}：{item.reason}
                      </li>
                    ))}
                  </ul>
                  <Button disabled={locked} onClick={() => setModal("editor")}>
                    修改配送数据
                  </Button>
                </div>
              )}
              {tab === "map" ? (
                <>
                  <RoadMap
                    scenario={scene}
                    plan={plan}
                    sim={sim}
                    selectedVehicle={vehicle}
                    onVehicle={setVehicle}
                    onOrder={selectOrder}
                  />
                  {!scenario && (
                    <div className="map-empty-hint">
                      搜索或在地图上选择实际配送位置
                    </div>
                  )}
                  {plan && (
                    <div className="route-legend">
                      {plan.routes
                        .filter((r) => r.used)
                        .map((r, i) => (
                          <button
                            key={r.vehicle_id}
                            aria-pressed={vehicle === r.vehicle_id}
                            onClick={() =>
                              setVehicle(
                                vehicle === r.vehicle_id ? null : r.vehicle_id,
                              )
                            }
                          >
                            <i
                              style={{
                                background:
                                  ROUTE_COLORS[i % ROUTE_COLORS.length],
                              }}
                            />
                            {r.vehicle_id}
                            <span>{r.order_ids.length} 单</span>
                          </button>
                        ))}
                    </div>
                  )}
                  {route && (
                    <div className="route-detail">
                      <strong>
                        {route.vehicle_id} · {km(route.distance_m)}
                      </strong>
                      <p>配送站 → {route.order_ids.join(" → ")} → 配送站</p>
                      <small>
                        载重 {route.load_kg} kg · 预计返站{" "}
                        {clock(route.return_seconds, scene?.start_time)}
                      </small>
                    </div>
                  )}
                </>
              ) : !scene ? (
                <div className="empty-list">
                  <Package size={28} />
                  <p>
                    录入配送数据后查看
                    {tab === "orders"
                      ? "订单"
                      : tab === "vehicles"
                        ? "车辆"
                        : "方案对比"}
                    。
                  </p>
                  <Button onClick={() => setModal("editor")}>录入数据</Button>
                </div>
              ) : tab === "orders" ? (
                <div className="list-view">
                  <div className="list-heading">
                    <h2>配送订单</h2>
                    <span>{filtered.length} 单</span>
                  </div>
                  <div className="search-field">
                    <Search size={15} />
                    <label className="sr-only" htmlFor="order-search">
                      搜索订单
                    </label>
                    <input
                      id="order-search"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setPage(1);
                      }}
                      placeholder="订单编号、地点或地址"
                    />
                    {query && (
                      <Button
                        label="清除搜索"
                        onClick={() => {
                          setQuery("");
                          setPage(1);
                        }}
                      >
                        <X size={14} />
                      </Button>
                    )}
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>订单 / 配送点</th>
                          <th>重量</th>
                          <th>收货窗口</th>
                          <th>车辆 / 状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.slice((page - 1) * 10, page * 10).map((o) => {
                          const r = plan?.routes.find((r) =>
                            r.order_ids.includes(o.id),
                          );
                          return (
                            <tr key={o.id}>
                              <td>
                                <button
                                  className="text-button"
                                  onClick={() => selectOrder(o.id)}
                                >
                                  {o.id}
                                </button>
                                <small>{o.name}</small>
                              </td>
                              <td>{o.weight_kg} kg</td>
                              <td>
                                {clock(o.window_start, scene.start_time)}
                                <br />
                                {clock(o.window_end, scene.start_time)}
                              </td>
                              <td>
                                {r?.vehicle_id || "—"}
                                <small>
                                  {sim?.orders[o.id] ||
                                    (plan
                                      ? r
                                        ? "待配送"
                                        : "未分配"
                                      : "待规划")}
                                </small>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!filtered.length && (
                      <p className="empty-list">没有匹配的订单，请清除搜索。</p>
                    )}
                  </div>
                  <div className="pagination">
                    <span>
                      第 {page} / {pages} 页
                    </span>
                    <Button
                      label="上一页订单"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ArrowLeft size={14} />
                    </Button>
                    <Button
                      label="下一页订单"
                      disabled={page >= pages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      <ArrowRight size={14} />
                    </Button>
                  </div>
                </div>
              ) : tab === "vehicles" ? (
                <div className="list-view">
                  <div className="list-heading">
                    <h2>车辆与运力</h2>
                    <span>{scene.vehicles.length} 辆可用</span>
                  </div>
                  {scene.vehicles.map((v) => {
                    const r = plan?.routes.find((r) => r.vehicle_id === v.id);
                    return (
                      <button
                        className="vehicle-card"
                        key={v.id}
                        onClick={() => {
                          setVehicle(v.id);
                          if (plan) setTab("map");
                        }}
                      >
                        <Truck size={22} />
                        <span>
                          <strong>
                            {v.id} · {v.name}
                          </strong>
                          <small>
                            载重 {v.capacity_kg} kg · 续航 {km(v.range_m)}
                          </small>
                        </span>
                        <span className="vehicle-stats">
                          <strong>{r?.order_ids.length || 0} 单</strong>
                          <small>
                            {r?.used
                              ? `返站 ${clock(r.return_seconds, scene.start_time)}`
                              : "待分配"}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="list-view">
                  <div className="list-heading">
                    <h2>调度方案对比</h2>
                    <span>
                      版本 {comparison?.scenario_revision || scenario?.revision}
                    </span>
                  </div>
                  {comparison ? (
                    <>
                      <p className="quiet">{comparison.note}</p>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>指标</th>
                              <th>就近基准</th>
                              <th>优化方案</th>
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              [
                                "按时完成",
                                `${comparison.baseline.metrics.completed_orders}/${comparison.baseline.metrics.total_orders}`,
                                `${comparison.optimized.metrics.completed_orders}/${comparison.optimized.metrics.total_orders}`,
                              ],
                              [
                                "道路里程",
                                km(
                                  comparison.baseline.metrics.total_distance_m,
                                ),
                                km(
                                  comparison.optimized.metrics.total_distance_m,
                                ),
                              ],
                              [
                                "使用车辆",
                                `${comparison.baseline.metrics.vehicles_used} 辆`,
                                `${comparison.optimized.metrics.vehicles_used} 辆`,
                              ],
                              [
                                "估算配送费用",
                                `¥ ${(comparison.baseline.metrics.cost_cents / 100).toFixed(2)}`,
                                `¥ ${(comparison.optimized.metrics.cost_cents / 100).toFixed(2)}`,
                              ],
                              [
                                "求解耗时",
                                `${comparison.baseline.metrics.solve_seconds.toFixed(2)} s`,
                                `${comparison.optimized.metrics.solve_seconds.toFixed(2)} s`,
                              ],
                            ].map(([label, a, b]) => (
                              <tr key={label}>
                                <td>{label}</td>
                                <td>{a}</td>
                                <td>{b}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="quiet">
                        费用按录入计费参数估算；行驶时间不包含实时拥堵。
                      </p>
                      <Button
                        onClick={() => {
                          setPlan(comparison.optimized);
                          setSim(null);
                          setTab("map");
                        }}
                      >
                        地图查看优化方案
                        <ArrowRight size={14} />
                      </Button>
                    </>
                  ) : (
                    <div className="empty-list">
                      <ChartNoAxesCombined size={28} />
                      <p>生成方案后，比较同一批订单的完成量与道路里程。</p>
                      <Button
                        primary
                        disabled={!plan || locked || stale}
                        onClick={() => void optimize(true)}
                      >
                        对比基准
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {plan && (
              <div className="simulation-bar">
                <div className="simulation-main">
                  <Button
                    label={
                      sim?.status === "playing"
                        ? "暂停路线预演"
                        : sim?.status === "completed"
                          ? "重新播放路线预演"
                          : "播放路线预演"
                    }
                    disabled={locked || !canPreview}
                    onClick={() =>
                      void (sim?.status === "playing"
                        ? simCommand("pause")
                        : simulate())
                    }
                  >
                    {sim?.status === "playing" ? (
                      <Pause size={17} />
                    ) : (
                      <Play size={17} />
                    )}
                  </Button>
                  <Button
                    label="重置路线预演"
                    disabled={!sim || locked}
                    onClick={() => void simCommand("reset")}
                  >
                    <RotateCcw size={15} />
                  </Button>
                  <strong>
                    {clock(sim?.elapsed_seconds || 0, scene?.start_time)}
                  </strong>
                  <div
                    className="sim-track"
                    role="progressbar"
                    aria-label="路线预演进度"
                    aria-valuenow={Math.round(
                      ((sim?.elapsed_seconds || 0) /
                        Math.max(1, plan.metrics.finish_seconds)) *
                        100,
                    )}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <i
                      style={{
                        width: `${((sim?.elapsed_seconds || 0) / Math.max(1, plan.metrics.finish_seconds)) * 100}%`,
                      }}
                    />
                  </div>
                  <label className="sr-only" htmlFor="sim-speed">
                    预演播放倍速
                  </label>
                  <select
                    id="sim-speed"
                    value={previewSpeed}
                    disabled={!canPreview || locked}
                    onChange={(e) => {
                      const speed = Number(e.target.value);
                      setPreviewSpeed(speed);
                      if (sim) void simCommand("speed", speed);
                    }}
                  >
                    <option value={1}>1×</option>
                    <option value={10}>10×</option>
                    <option value={60}>60×</option>
                    <option value={120}>120×</option>
                  </select>
                </div>
                <label className="sim-seek">
                  预演进度
                  <input
                    type="range"
                    aria-label="跳转预演时间"
                    min={0}
                    max={Math.max(1, plan.metrics.finish_seconds)}
                    step={1}
                    value={Math.floor(sim?.elapsed_seconds || 0)}
                    disabled={!sim || locked}
                    onChange={(e) => {
                      if (!busy)
                        void simCommand(
                          "seek",
                          previewSpeed,
                          Number(e.target.value),
                        );
                    }}
                  />
                  <span>
                    {Math.floor(sim?.elapsed_seconds || 0)} /{" "}
                    {plan.metrics.finish_seconds} 秒
                  </span>
                </label>
                <div className="sim-footer">
                  <span>
                    路线预演 · {sim?.delivered_count || 0}/
                    {plan.metrics.total_orders} 单
                  </span>
                  <span>
                    {!canPreview
                      ? "先修改约束并重新生成方案"
                      : sim?.status === "completed"
                        ? "全部路线已结束，可重新播放"
                        : sim?.events[0]?.text || "车辆沿预计道路路线移动"}
                  </span>
                </div>
              </div>
            )}
          </section>
        </main>
      </div>
      {modal === "editor" && (
        <ScenarioEditor
          scenario={scenario}
          storageKey={`dispatch-draft:${user.id}:${task?.id || "new"}:${scenario?.revision || 0}`}
          onClose={() => setModal(null)}
          onSave={saveData}
        />
      )}{" "}
      {modal === "sources" && (
        <Modal title="数据来源" onClose={() => setModal(null)}>
          <dl className="details">
            <dt>订单与车辆</dt>
            <dd>用户录入</dd>
            <dt>地图与地点</dt>
            <dd>OpenStreetMap · Photon</dd>
            <dt>道路与路线</dt>
            <dd>OSRM · 普通道路驾车配置</dd>
            <dt>道路获取时间</dt>
            <dd>
              {scene
                ? new Date(scene.road_matrix.fetched_at).toLocaleString(
                    "zh-CN",
                    { timeZone: "Asia/Shanghai" },
                  )
                : "尚未加载"}
            </dd>
          </dl>
          <p className="quiet">
            道路行驶时间为静态估计。无人车专属禁行、实时交通和实际车辆位置需要车辆或地图平台提供。路线预演用于检查方案。
          </p>
          {scenario && (
            <div className="modal-actions">
              <Button
                disabled={locked}
                onClick={() =>
                  void run(async () => {
                    const value = await api<Scenario>(
                      `/scenarios/${scenario.id}/refresh-roads`,
                      "POST",
                      { expected_revision: scenario.revision },
                    );
                    setScenario(value);
                    setSim(null);
                    setComparison(null);
                    if (task) await refresh(task.id);
                    setModal(null);
                  })
                }
              >
                刷新道路数据
              </Button>
            </div>
          )}
        </Modal>
      )}
      {modal === "guide" && (
        <Modal title="数据说明与填写规则" onClose={() => setModal(null)}>
          <DataGuide />
        </Modal>
      )}
      {modal === "integrations" && (
        <Modal title="服务连接" onClose={() => setModal(null)}>
          {integrations.map((s) => (
            <div className="integration-card" key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <span className="small-pill">
                  {s.status === "connected"
                    ? "已启用"
                    : s.status === "configured"
                      ? "已配置"
                      : "未配置"}
                </span>
              </div>
              <p>{s.description}</p>
              {["llm", "vehicle"].includes(s.id) && (
                <Button
                  busy={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await api<{ message: string }>(
                        `/integrations/${s.id}/check`,
                        "POST",
                      );
                      setConnections((c) => ({ ...c, [s.id]: r.message }));
                    })
                  }
                >
                  检查连接
                </Button>
              )}
              <small role="status">{connections[s.id]}</small>
            </div>
          ))}
        </Modal>
      )}
      {modal === "order" && order && (
        <Modal title={`${order.id} · 订单详情`} onClose={() => setModal(null)}>
          <h3>{order.name}</h3>
          <p className="quiet">{order.address}</p>
          <dl className="details">
            <dt>货物重量</dt>
            <dd>{order.weight_kg} kg</dd>
            <dt>收货窗口</dt>
            <dd>
              {clock(order.window_start, scene?.start_time)}—
              {clock(order.window_end, scene?.start_time)}
            </dd>
            <dt>交付耗时</dt>
            <dd>{order.service_seconds / 60} 分钟</dd>
            {(() => {
              const r = plan?.routes.find((r) =>
                r.order_ids.includes(order.id),
              );
              const stop = r?.stops.find((s) => s.order_id === order.id);
              return (
                <>
                  <dt>分配车辆</dt>
                  <dd>{r?.vehicle_id || "未分配"}</dd>
                  {stop && (
                    <>
                      <dt>预计到达</dt>
                      <dd>{clock(stop.arrival, scene?.start_time)}</dd>
                      <dt>交付完成</dt>
                      <dd>{clock(stop.departure, scene?.start_time)}</dd>
                    </>
                  )}
                  {plan?.unassigned.find((o) => o.order_id === order.id) && (
                    <>
                      <dt>未分配原因</dt>
                      <dd>
                        {
                          plan.unassigned.find((o) => o.order_id === order.id)
                            ?.reason
                        }
                      </dd>
                    </>
                  )}
                </>
              );
            })()}
          </dl>
          <a
            className="external-map-link"
            href={`https://www.openstreetmap.org/?mlat=${order.location.lat}&mlon=${order.location.lon}#map=17/${order.location.lat}/${order.location.lon}`}
            target="_blank"
            rel="noreferrer"
          >
            在真实地图中打开收货点 ↗
          </a>
        </Modal>
      )}
    </div>
  );
}
