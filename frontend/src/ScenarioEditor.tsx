import { useEffect, useRef, useState } from "react";
import { MapPin, Search, Plus, Pencil, Trash2, X } from "lucide-react";
import { api, ApiError } from "./api";
import { Button, Input, Modal } from "./ui";
import { RoadMap } from "./RoadMap";
import { DataGuide } from "./DataGuide";
import {
  clock,
  type Location,
  type OrderInput,
  type VehicleInput,
  type Scenario,
  type ScenarioInput,
} from "./types";

const emptyLocation = (): Location => ({
  name: "",
  address: "",
  lat: 0,
  lon: 0,
  source: "user_coordinates",
});
type VehicleField = "id" | "name" | "capacity" | "range" | "fixed" | "rate";
type VehicleErrors = Partial<Record<VehicleField, string>>;
function PlacePicker({
  value,
  onChange,
}: {
  value: Location | null;
  onChange: (value: Location) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Location[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [searched, setSearched] = useState(false);
  const version = useRef(0);
  useEffect(
    () => () => {
      version.current++;
    },
    [],
  );
  async function search() {
    if (busy) return;
    if (query.trim().length < 2) {
      setError("请输入至少两个字的公共地点名称");
      return;
    }
    setBusy(true);
    setError("");
    const requestVersion = ++version.current;
    try {
      const found = (
        await api<{ items: Location[] }>(
          `/places/search?query=${encodeURIComponent(query.trim())}&lat=${value?.lat ?? 35}&lon=${value?.lon ?? 105}`,
        )
      ).items;
      if (requestVersion === version.current) {
        setItems(found);
        setSearched(true);
      }
    } catch (e) {
      if (requestVersion === version.current) setError((e as Error).message);
    } finally {
      if (requestVersion === version.current) setBusy(false);
    }
  }
  function choose(p: Location) {
    onChange({
      name: p.name,
      address: p.address,
      lat: p.lat,
      lon: p.lon,
      source: p.source,
    });
    setItems([]);
    setError("");
  }
  return (
    <div className="place-picker">
      <div className="place-search">
        <Input
          label="搜索公共地点"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setItems([]);
            setSearched(false);
          }}
          disabled={busy}
          placeholder="城市 + 道路、建筑或公共地点"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void search();
            }
          }}
        />
        {query && (
          <Button
            label="清除地点搜索"
            disabled={busy}
            onClick={() => {
              setQuery("");
              setItems([]);
              setSearched(false);
              setError("");
            }}
          >
            <X size={15} />
          </Button>
        )}
        <Button busy={busy} onClick={() => void search()}>
          <Search size={16} />
          搜索
        </Button>
      </div>
      {searched && !items.length && (
        <p className="quiet" role="status">
          没有找到公共地点，可补充城市名称或直接在地图选点。
        </p>
      )}
      {items.length > 0 && (
        <ul className="place-results">
          {items.map((p, i) => (
            <li key={i}>
              <button onClick={() => choose(p)}>
                <MapPin size={16} />
                <span>
                  <strong>{p.name}</strong>
                  <small>{p.address}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="picker-map">
        <RoadMap point={value} onPick={choose} />
      </div>
      <div className="location-line">
        <span>
          {value
            ? `${value.lat.toFixed(6)}, ${value.lon.toFixed(6)}`
            : "点击地图选点，或搜索后选择结果"}
        </span>
        <button
          className="text-button"
          onClick={() => {
            setManual(!manual);
            setLat(String(value?.lat ?? ""));
            setLon(String(value?.lon ?? ""));
          }}
        >
          输入坐标
        </button>
      </div>
      {manual && (
        <div className="coordinate-inputs">
          <Input
            label="纬度 WGS84"
            value={lat}
            onChange={(e) => setLat(e.target.value)}
            type="number"
            step="any"
          />
          <Input
            label="经度 WGS84"
            value={lon}
            onChange={(e) => setLon(e.target.value)}
            type="number"
            step="any"
          />
          <Button
            onClick={() => {
              const a = Number(lat),
                b = Number(lon);
              if (
                !lat ||
                !lon ||
                !Number.isFinite(a) ||
                !Number.isFinite(b) ||
                Math.abs(a) > 85 ||
                Math.abs(b) > 180
              ) {
                setError("请输入有效的 WGS84 经纬度");
                return;
              }
              choose({
                ...(value || emptyLocation()),
                lat: a,
                lon: b,
                source: "user_coordinates",
              });
              setManual(false);
            }}
          >
            使用坐标
          </Button>
        </div>
      )}
      <Input
        label="地点名称"
        disabled={!value}
        value={value?.name || ""}
        onChange={(e) =>
          onChange({ ...(value || emptyLocation()), name: e.target.value })
        }
        placeholder="例如道路入口或收货建筑"
      />
      <Input
        label="地址补充"
        disabled={!value}
        value={value?.address || ""}
        onChange={(e) =>
          onChange({ ...(value || emptyLocation()), address: e.target.value })
        }
        placeholder="只保存在你的任务中"
      />
    </div>
  );
}
type Draft = {
  city: string;
  start: string;
  hours: string;
  depot: Location | null;
  orders: OrderInput[];
  vehicles: VehicleInput[];
};
const fresh = (): Draft => ({
  city: "",
  start:
    new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) + "T08:00",
  hours: "8",
  depot: null,
  orders: [],
  vehicles: [],
});
export function ScenarioEditor({
  scenario,
  storageKey,
  onClose,
  onSave,
}: {
  scenario: Scenario | null;
  storageKey: string;
  onClose: () => void;
  onSave: (data: ScenarioInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      if (stored) return JSON.parse(stored) as Draft;
    } catch {}
    return scenario
      ? {
          city: scenario.input.city,
          start: scenario.input.start_time.slice(0, 16),
          hours: String(scenario.input.horizon_seconds / 3600),
          depot: scenario.input.depot,
          orders: scenario.input.orders,
          vehicles: scenario.input.vehicles,
        }
      : fresh();
  });
  const [tab, setTab] = useState("depot");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [orderPoint, setOrderPoint] = useState<Location | null>(null);
  const [orderId, setOrderId] = useState("");
  const [weight, setWeight] = useState("");
  const [from, setFrom] = useState("08:00");
  const [until, setUntil] = useState("16:00");
  const [service, setService] = useState("2");
  const [editingOrder, setEditingOrder] = useState<number | null>(null);
  const [vehicleId, setVehicleId] = useState("");
  const [vehicleName, setVehicleName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [range, setRange] = useState("");
  const [fixed, setFixed] = useState("0");
  const [rate, setRate] = useState("0");
  const [editingVehicle, setEditingVehicle] = useState<number | null>(null);
  const [vehicleErrors, setVehicleErrors] = useState<VehicleErrors>({});
  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, storageKey]);
  function seconds(value: string) {
    const [h, m] = value.split(":").map(Number);
    const [a, b] = draft.start.slice(11, 16).split(":").map(Number);
    return ((h - a) * 60 + m - b) * 60;
  }
  function addOrder() {
    setError("");
    const start = seconds(from),
      end = seconds(until);
    if (
      !/^[A-Za-z0-9_-]{1,40}$/.test(orderId) ||
      !orderPoint?.name.trim() ||
      !Number.isFinite(Number(weight)) ||
      Number(weight) < 0.001 ||
      Number(weight) > 500 ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > Number(draft.hours) * 3600 ||
      start + Number(service) * 60 > end ||
      !service ||
      Number(service) < 0 ||
      Number(service) > 60
    ) {
      setError(
        "请检查订单编号、地点、重量和收货时间。时间窗口需在工作时段内，且足够完成交付。",
      );
      return;
    }
    if (draft.orders.some((o, i) => o.id === orderId && i !== editingOrder)) {
      setError("订单编号已存在，请使用不同编号。");
      return;
    }
    const order: OrderInput = {
      id: orderId,
      location: orderPoint,
      weight_kg: Number(weight),
      window_start: start,
      window_end: end,
      service_seconds: Math.round(Number(service) * 60),
    };
    setDraft((d) => ({
      ...d,
      orders:
        editingOrder === null
          ? [...d.orders, order]
          : d.orders.map((o, i) => (i === editingOrder ? order : o)),
    }));
    setOrderId("");
    setWeight("");
    setOrderPoint(null);
    setEditingOrder(null);
  }
  function addVehicle() {
    setError("");
    const errors: VehicleErrors = {};
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(vehicleId))
      errors.id = "编号须为 1～40 位字母、数字、下划线或短横线。";
    if (!vehicleName.trim() || vehicleName.trim().length > 80)
      errors.name = "请填写 1～80 个字符的车辆名称。";
    const within = (value: string, min: number, max: number) =>
      !!value.trim() &&
      Number.isFinite(Number(value)) &&
      Number(value) >= min &&
      Number(value) <= max;
    if (!within(capacity, 0.001, 500))
      errors.capacity = "可用载重须为 0.001～500 kg。";
    if (!within(range, 0, 500) || Number(range) <= 0)
      errors.range = "可用续航须大于 0，且不超过 500 km。";
    if (!within(fixed, 0, 10000))
      errors.fixed = "出车费用须为 0～10000 元，按每次出车填写。";
    if (!within(rate, 0, 1000)) errors.rate = "每公里费用须为 0～1000 元。";
    if (
      draft.vehicles.some((v, i) => v.id === vehicleId && i !== editingVehicle)
    ) {
      errors.id = "车辆编号已存在，请使用不同编号。";
    }
    setVehicleErrors(errors);
    const first = Object.keys(errors)[0];
    if (first) {
      setError("请修改标红的车辆字段后再添加，已填写的内容会保留。");
      requestAnimationFrame(() =>
        document.getElementById(`vehicle-${first}`)?.focus(),
      );
      return;
    }
    const vehicle: VehicleInput = {
      id: vehicleId,
      name: vehicleName.trim(),
      capacity_kg: Number(capacity),
      range_km: Number(range),
      fixed_cost_cents: Math.round(Number(fixed) * 100),
      cost_per_km_cents: Math.round(Number(rate) * 100),
      available:
        editingVehicle === null
          ? true
          : draft.vehicles[editingVehicle].available,
    };
    setDraft((d) => ({
      ...d,
      vehicles:
        editingVehicle === null
          ? [...d.vehicles, vehicle]
          : d.vehicles.map((v, i) => (i === editingVehicle ? vehicle : v)),
    }));
    setVehicleId("");
    setVehicleName("");
    setCapacity("");
    setRange("");
    setEditingVehicle(null);
  }
  function clearVehicleError(field: VehicleField) {
    setVehicleErrors((errors) => ({ ...errors, [field]: undefined }));
    setError("");
  }
  async function save() {
    // Older drafts may contain values accepted by the previous client checks.
    const invalidVehicle = draft.vehicles.find(
      (v) =>
        v.capacity_kg < 0.001 ||
        v.capacity_kg > 500 ||
        v.range_km <= 0 ||
        v.range_km > 500 ||
        v.fixed_cost_cents < 0 ||
        v.fixed_cost_cents > 1000000 ||
        v.cost_per_km_cents < 0 ||
        v.cost_per_km_cents > 100000,
    );
    if (invalidVehicle) {
      setTab("vehicles");
      setError(
        `车辆 ${invalidVehicle.id} 的参数超出范围。请点击该车辆的“编辑”：载重 0.001～500 kg，续航大于 0 且不超过 500 km，出车费用 0～10000 元，每公里费用 0～1000 元。`,
      );
      return;
    }
    if (
      !draft.depot?.name.trim() ||
      !draft.orders.length ||
      !draft.vehicles.some((v) => v.available) ||
      !draft.city.trim() ||
      !draft.start ||
      Number(draft.hours) <= 0 ||
      Number(draft.hours) > 24
    ) {
      setError("请填写配送站、工作时段，并录入至少一个订单和一辆可用车辆。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        city: draft.city,
        start_time: draft.start + ":00+08:00",
        horizon_seconds: Math.round(Number(draft.hours) * 3600),
        depot: draft.depot,
        orders: draft.orders,
        vehicles: draft.vehicles,
      });
      sessionStorage.removeItem(storageKey);
    } catch (e) {
      setError(
        (e as Error).message +
          (e instanceof ApiError && e.fields.length
            ? "：" + e.fields.map((f) => `${f.field} ${f.message}`).join("；")
            : ""),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="配送数据"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <div className="editor-tabs" role="tablist" aria-label="配送数据类别">
        {[
          ["depot", "配送站"],
          ["orders", `订单 (${draft.orders.length})`],
          ["vehicles", `车辆 (${draft.vehicles.length})`],
        ].map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => {
              setTab(key);
              setError("");
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="editor-body">
        <details className="field-guide-disclosure">
          <summary>字段说明与填写示例</summary>
          <DataGuide />
        </details>
        {tab === "depot" ? (
          <>
            <div className="field-grid">
              <Input
                label="配送城市"
                placeholder="例如：杭州、北京、成都"
                value={draft.city}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, city: e.target.value }))
                }
              />
              <Input
                label="出发日期与时间"
                type="datetime-local"
                value={draft.start}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, start: e.target.value }))
                }
              />
              <Input
                label="工作时长（小时）"
                hint="包括行驶、等待、交付与返站，最多 24 小时"
                type="number"
                min={1}
                max={24}
                value={draft.hours}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, hours: e.target.value }))
                }
              />
            </div>
            <h3>配送站位置</h3>
            <PlacePicker
              value={draft.depot}
              onChange={(value) => setDraft((d) => ({ ...d, depot: value }))}
            />
          </>
        ) : tab === "orders" ? (
          <>
            <p className="quiet">订单由你录入，收货时间按北京时间填写。</p>
            <div className="record-list">
              {draft.orders.map((o, i) => (
                <div key={o.id}>
                  <span>
                    <strong>
                      {o.id} · {o.location.name}
                    </strong>
                    <small>
                      {o.weight_kg} kg ·{" "}
                      {clock(o.window_start, draft.start + ":00+08:00")}—
                      {clock(o.window_end, draft.start + ":00+08:00")}
                    </small>
                  </span>
                  <Button
                    label={`编辑订单 ${o.id}`}
                    onClick={() => {
                      setEditingOrder(i);
                      setOrderId(o.id);
                      setOrderPoint(o.location);
                      setWeight(String(o.weight_kg));
                      setFrom(clock(o.window_start, draft.start + ":00+08:00"));
                      setUntil(clock(o.window_end, draft.start + ":00+08:00"));
                      setService(String(o.service_seconds / 60));
                    }}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    label={`移除订单 ${o.id}`}
                    onClick={() => {
                      setDraft((d) => ({
                        ...d,
                        orders: d.orders.filter((_, j) => j !== i),
                      }));
                      setEditingOrder(null);
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
            <div className="field-grid">
              <Input
                label="订单编号"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                placeholder="业务订单编号"
              />
              <Input
                label="货物重量（kg）"
                min="0.001"
                max="500"
                hint="整笔订单重量，0.001～500 kg，须在车辆载重内"
                type="number"
                step="0.001"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
              />
              <Input
                label="收货开始时间"
                type="time"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <Input
                label="收货截止时间"
                hint="交付须在此时间前完成，且在工作时段内"
                type="time"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
              <Input
                label="交付耗时（分钟）"
                min="0"
                max="60"
                hint="卸货与签收耗时，0～60 分钟"
                type="number"
                value={service}
                onChange={(e) => setService(e.target.value)}
              />
            </div>
            <PlacePicker value={orderPoint} onChange={setOrderPoint} />
            <Button
              primary
              disabled={draft.orders.length >= 50 && editingOrder === null}
              onClick={addOrder}
            >
              <Plus size={15} />
              {editingOrder === null ? "添加订单" : "保存订单修改"}
            </Button>
          </>
        ) : (
          <>
            <p className="quiet">
              填写车辆当前可用载重与续航。费用为你的计费参数，填 0
              时不计算费用。
            </p>
            <div className="record-list">
              {draft.vehicles.map((v, i) => (
                <div key={v.id}>
                  <span>
                    <strong>
                      {v.id} · {v.name}
                    </strong>
                    <small>
                      {v.capacity_kg} kg · {v.range_km} km
                    </small>
                  </span>
                  <label className="available">
                    <input
                      type="checkbox"
                      checked={v.available}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          vehicles: d.vehicles.map((row, j) =>
                            i === j
                              ? { ...row, available: e.target.checked }
                              : row,
                          ),
                        }))
                      }
                    />
                    可用
                  </label>
                  <Button
                    label={`编辑车辆 ${v.id}`}
                    onClick={() => {
                      setEditingVehicle(i);
                      setVehicleId(v.id);
                      setVehicleName(v.name);
                      setCapacity(String(v.capacity_kg));
                      setRange(String(v.range_km));
                      setFixed(String(v.fixed_cost_cents / 100));
                      setRate(String(v.cost_per_km_cents / 100));
                    }}
                  >
                    <Pencil size={14} />
                  </Button>
                  <Button
                    label={`移除车辆 ${v.id}`}
                    onClick={() => {
                      setDraft((d) => ({
                        ...d,
                        vehicles: d.vehicles.filter((_, j) => j !== i),
                      }));
                      setEditingVehicle(null);
                    }}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
            <div className="field-grid">
              <Input
                label="车辆编号"
                id="vehicle-id"
                error={vehicleErrors.id}
                value={vehicleId}
                onChange={(e) => {
                  setVehicleId(e.target.value);
                  clearVehicleError("id");
                }}
              />
              <Input
                label="车辆名称"
                id="vehicle-name"
                error={vehicleErrors.name}
                value={vehicleName}
                onChange={(e) => {
                  setVehicleName(e.target.value);
                  clearVehicleError("name");
                }}
              />
              <Input
                label="可用载重（kg）"
                id="vehicle-capacity"
                error={vehicleErrors.capacity}
                hint="0.001～500 kg"
                min="0.001"
                max="500"
                type="number"
                step="any"
                value={capacity}
                onChange={(e) => {
                  setCapacity(e.target.value);
                  clearVehicleError("capacity");
                }}
              />
              <Input
                label="可用续航（km）"
                id="vehicle-range"
                error={vehicleErrors.range}
                hint="本次出车可行驶的距离，大于 0 且不超过 500 km"
                min="0"
                max="500"
                type="number"
                step="any"
                value={range}
                onChange={(e) => {
                  setRange(e.target.value);
                  clearVehicleError("range");
                }}
              />
              <Input
                label="出车费用（元）"
                id="vehicle-fixed"
                error={vehicleErrors.fixed}
                hint="每次出车费用，0～10000 元；填 0 不计此项"
                min="0"
                max="10000"
                type="number"
                step="0.01"
                value={fixed}
                onChange={(e) => {
                  setFixed(e.target.value);
                  clearVehicleError("fixed");
                }}
              />
              <Input
                label="每公里费用（元）"
                id="vehicle-rate"
                error={vehicleErrors.rate}
                hint="0～1000 元/km；填 0 不计此项"
                min="0"
                max="1000"
                type="number"
                step="0.01"
                value={rate}
                onChange={(e) => {
                  setRate(e.target.value);
                  clearVehicleError("rate");
                }}
              />
            </div>
            <Button
              primary
              disabled={draft.vehicles.length >= 15 && editingVehicle === null}
              onClick={addVehicle}
            >
              <Plus size={15} />
              {editingVehicle === null ? "添加车辆" : "保存车辆修改"}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <span className="quiet">
          {draft.orders.length} 单 ·{" "}
          {draft.vehicles.filter((v) => v.available).length} 辆可用
        </span>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button primary busy={busy} onClick={() => void save()}>
          {scenario ? "保存配送数据" : "加载真实道路"}
        </Button>
      </div>
    </Modal>
  );
}
