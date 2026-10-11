export type User = { id: string; username: string; display_name: string };
export type Location = {
  name: string;
  address: string;
  lat: number;
  lon: number;
  source: "map_pick" | "photon" | "user_coordinates";
};
export type OrderInput = {
  id: string;
  location: Location;
  weight_kg: number;
  window_start: number;
  window_end: number;
  service_seconds: number;
};
export type VehicleInput = {
  id: string;
  name: string;
  capacity_kg: number;
  range_km: number;
  fixed_cost_cents: number;
  cost_per_km_cents: number;
  available: boolean;
};
export type ScenarioInput = {
  city: string;
  start_time: string;
  horizon_seconds: number;
  depot: Location;
  orders: OrderInput[];
  vehicles: VehicleInput[];
};
export type Order = OrderInput & {
  name: string;
  address: string;
  node_id: string;
};
export type Vehicle = VehicleInput & { range_m: number };
export type Node = {
  id: string;
  x: number;
  y: number;
  lat: number;
  lon: number;
  name: string;
};
export type Scenario = {
  id: string;
  task_id: string;
  revision: number;
  source: string;
  coordinate_system: string;
  city: string;
  start_time: string;
  horizon_seconds: number;
  input: ScenarioInput;
  nodes: Node[];
  orders: Order[];
  vehicles: Vehicle[];
  depot_node: string;
  road_matrix: {
    provider: string;
    fetched_at: string;
    profile: string;
    snapped: { lon: number; lat: number; distance_m: number }[];
  };
  provenance: Record<string, string>;
};
export type Proposal = {
  id: string;
  scenario_revision: number;
  description: string;
  applied: boolean;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  source?: string;
  actions?: string[];
  plan_id?: string;
  comparison_id?: string;
  proposal?: Proposal;
  ai?: { intent: string; confidence: number; model: string };
};
export type Task = {
  id: string;
  name: string;
  messages: Message[];
  scenario_id: string | null;
  plan_ids: string[];
  comparison_ids: string[];
  jobs?: Job[];
};
export type Summary = {
  id: string;
  name: string;
  updated_at: string;
  has_plan: boolean;
};
export type Job = {
  id: string;
  task_id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  stage: string;
  elapsed_seconds: number;
  result_kind: "plan" | "comparison";
  result_id: string | null;
};
export type Metrics = {
  total_orders: number;
  completed_orders: number;
  completion_rate: number;
  total_distance_m: number;
  vehicles_used: number;
  cost_cents: number;
  finish_seconds: number;
  solve_seconds: number;
};
export type Route = {
  vehicle_id: string;
  used: boolean;
  order_ids: string[];
  stops: {
    order_id: string;
    node_id: string;
    arrival: number;
    service_start: number;
    departure: number;
  }[];
  legs: {
    from: string;
    to: string;
    start: number;
    end: number;
    path: string[];
    order_id: string | null;
    geometry?: [number, number][];
  }[];
  distance_m: number;
  load_kg: number;
  return_seconds: number;
  cost_cents: number;
};
export type Plan = {
  id: string;
  scenario_id: string;
  scenario_revision: number;
  snapshot: Scenario;
  algorithm: string;
  outcome: string;
  routes: Route[];
  unassigned: { order_id: string; reason: string }[];
  validation: { valid: boolean; checked: string[]; violations: string[] };
  metrics: Metrics;
};
export type Comparison = {
  id: string;
  scenario_revision: number;
  baseline: Plan;
  optimized: Plan;
  comparable_cost: boolean;
  note: string;
};
export type SimState = {
  id: string;
  plan_id: string;
  status: string;
  elapsed_seconds: number;
  total_seconds: number;
  speed: number;
  delivered_count: number;
  vehicles: { id: string; x: number; y: number; status: string }[];
  orders: Record<string, string>;
  events: { time: number; vehicle_id: string; text: string }[];
};
export type Integration = {
  id: string;
  name: string;
  status: string;
  description: string;
};
export const clock = (seconds: number, start?: string) => {
  const date = new Date(
    (start ? Date.parse(start) : Date.parse("2026-10-12T08:00:00+08:00")) +
      seconds * 1000,
  );
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
};
export const km = (meters: number) => `${(meters / 1000).toFixed(2)} km`;
