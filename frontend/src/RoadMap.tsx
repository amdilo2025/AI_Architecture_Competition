import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { ExternalLink, LocateFixed, Globe2 } from "lucide-react";
import { api } from "./api";
import { Button } from "./ui";
import type { Location, Scenario, Plan, SimState } from "./types";

export const ROUTE_COLORS = [
  "#187c61",
  "#2b64bc",
  "#ad5931",
  "#7b4aaf",
  "#a53869",
  "#647324",
];
const NATIONAL_BOUNDS: L.LatLngBoundsExpression = [
  [18, 73],
  [54, 135],
];
const icon = (text: string, color: string, kind = "point") =>
  L.divIcon({
    className: "map-marker-wrapper",
    html: `<span class="map-pin ${kind}" style="--pin-color:${color}">${text.replace(/[<>&"']/g, "")}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
export function RoadMap({
  scenario,
  plan,
  sim,
  selectedVehicle,
  onVehicle,
  onOrder,
  onPick,
  point,
}: {
  scenario?: Scenario | null;
  plan?: Plan | null;
  sim?: SimState | null;
  selectedVehicle?: string | null;
  onVehicle?: (id: string) => void;
  onOrder?: (id: string) => void;
  onPick?: (location: Location) => void;
  point?: Location | null;
}) {
  const div = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const cars = useRef(new globalThis.Map<string, L.Marker>());
  const callbacks = useRef({ onOrder, onVehicle });
  callbacks.current = { onOrder, onVehicle };
  const pick = useRef(onPick);
  pick.current = onPick;
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [center, setCenter] = useState<[number, number]>([35, 105]);
  const [zoom, setZoom] = useState(4);
  const pendingFit = useRef(true);
  const fitScope = useRef<() => void>(() => {});
  fitScope.current = () => {
    const view = map.current;
    if (!view || view.getSize().x <= 0 || view.getSize().y <= 0) return;
    if (point) view.setView([point.lat, point.lon], 15, { animate: false });
    else if (scenario)
      view.fitBounds(
        L.latLngBounds(
          scenario.nodes.map((n) => [n.y, n.x] as [number, number]),
        ),
        { padding: [42, 42], maxZoom: 16, animate: false },
      );
    else view.fitBounds(NATIONAL_BOUNDS, { padding: [12, 12], animate: false });
    pendingFit.current = false;
  };
  useEffect(() => {
    if (!div.current) return;
    const view = L.map(div.current, {
      zoomControl: false,
      attributionControl: true,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
    }).setView([35, 105], 4, { animate: false });
    L.control
      .zoom({ zoomInTitle: "放大地图", zoomOutTitle: "缩小地图" })
      .addTo(view);
    map.current = view;
    layer.current = L.layerGroup().addTo(view);
    let alive = true;
    api<{ tile_url: string; attribution: string; max_zoom: number }>(
      "/map/config",
    )
      .then((config) => {
        if (!alive) return;
        L.tileLayer(config.tile_url, {
          attribution: config.attribution,
          maxZoom: config.max_zoom,
          updateWhenIdle: true,
        })
          .on("tileerror", () => setTileError(true))
          .addTo(view);
      })
      .catch(() => {
        if (alive) setTileError(true);
      });
    view.on("click", (e: L.LeafletMouseEvent) => {
      if (pick.current)
        pick.current({
          name: "",
          address: "",
          lat: Number(e.latlng.lat.toFixed(6)),
          lon: Number(e.latlng.lng.toFixed(6)),
          source: "map_pick",
        });
    });
    view.on("moveend", () => {
      const c = view.getCenter();
      setCenter([c.lat, c.lng]);
      setZoom(view.getZoom());
    });
    const initialCenter = view.getCenter();
    setCenter([initialCenter.lat, initialCenter.lng]);
    setZoom(view.getZoom());
    const observer = new ResizeObserver((entries) => {
      if (
        !alive ||
        map.current !== view ||
        !entries[0]?.contentRect.width ||
        !entries[0]?.contentRect.height
      )
        return;
      view.invalidateSize({ pan: false, animate: false });
      if (pendingFit.current) fitScope.current();
    });
    observer.observe(div.current);
    setReady(true);
    return () => {
      alive = false;
      observer.disconnect();
      cars.current.clear();
      view.stop();
      view.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    pendingFit.current = true;
    fitScope.current();
  }, [ready, scenario?.id, scenario?.revision, point?.lat, point?.lon]);
  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    group.clearLayers();
    if (point)
      L.marker([point.lat, point.lon], {
        icon: icon("●", "#20252b"),
        title: "已选择的位置",
      }).addTo(group);
    if (!scenario) return;
    plan?.routes
      .filter((r) => r.used)
      .forEach((r, i) => {
        const color = ROUTE_COLORS[i % ROUTE_COLORS.length];
        const muted = selectedVehicle && selectedVehicle !== r.vehicle_id;
        r.legs.forEach((leg) => {
          if (!leg.geometry) return;
          L.polyline(
            leg.geometry.map(([lon, lat]) => [lat, lon]),
            {
              color,
              weight: selectedVehicle === r.vehicle_id ? 5 : 3,
              opacity: muted ? 0.2 : 0.8,
            },
          )
            .on("click", () => callbacks.current.onVehicle?.(r.vehicle_id))
            .bindTooltip(r.vehicle_id)
            .addTo(group);
        });
      });
    scenario.nodes.forEach((n, i) => {
      const order = scenario.orders.find((o) => o.node_id === n.id);
      const marker = L.marker([n.y, n.x], {
        icon: icon(
          i === 0 ? "站" : String(i),
          i === 0 ? "#20252b" : "#ffffff",
          i === 0 ? "depot" : "point",
        ),
        title: i === 0 ? scenario.input.depot.name : order?.name,
        keyboard: true,
        alt: i === 0 ? "配送站" : `订单 ${order?.id}`,
      }).addTo(group);
      const tooltip = document.createElement("span");
      tooltip.textContent = n.name;
      marker.bindTooltip(tooltip);
      marker.on("click", () => {
        if (order) callbacks.current.onOrder?.(order.id);
      });
    });
  }, [ready, scenario, plan, selectedVehicle, point]);
  useEffect(() => {
    const view = map.current;
    if (!view) return;
    const used = new Set(
      plan?.routes.filter((r) => r.used).map((r) => r.vehicle_id),
    );
    const visible = sim?.vehicles.filter((v) => used.has(v.id)) || [];
    for (const [id, marker] of cars.current) {
      if (!visible.some((v) => v.id === id)) {
        marker.remove();
        cars.current.delete(id);
      }
    }
    visible.forEach((v) => {
      const i =
        plan?.routes
          .filter((r) => r.used)
          .findIndex((r) => r.vehicle_id === v.id) ?? 0;
      let marker = cars.current.get(v.id);
      if (!marker) {
        marker = L.marker([v.y, v.x], {
          icon: icon(
            "车",
            ROUTE_COLORS[Math.max(0, i) % ROUTE_COLORS.length],
            "car",
          ),
          title: `${v.id} ${v.status}`,
        })
          .on("click", () => callbacks.current.onVehicle?.(v.id))
          .bindTooltip(`${v.id} · ${v.status}`)
          .addTo(view);
        cars.current.set(v.id, marker);
      }
      marker.setLatLng([v.y, v.x]);
      marker.setTooltipContent(`${v.id} · ${v.status}`);
    });
  }, [ready, plan, sim]);
  return (
    <div className={`road-map ${onPick ? "map-picking" : ""}`}>
      <div
        ref={div}
        className="leaflet-container-host"
        aria-label={onPick ? "点击真实地图选择位置" : "真实道路配送地图"}
      />
      <div className="map-tools">
        <Button
          label="全国视图"
          onClick={() =>
            map.current?.fitBounds(NATIONAL_BOUNDS, {
              padding: [12, 12],
              animate: false,
            })
          }
        >
          <Globe2 size={16} />
          全国
        </Button>
        <Button
          label="查看全部配送点"
          onClick={() => {
            if (scenario)
              map.current?.fitBounds(
                L.latLngBounds(
                  scenario.nodes.map((n) => [n.y, n.x] as [number, number]),
                ),
                { padding: [42, 42], maxZoom: 16, animate: false },
              );
            else
              map.current?.fitBounds(NATIONAL_BOUNDS, {
                padding: [12, 12],
                animate: false,
              });
          }}
        >
          <LocateFixed size={16} />
        </Button>
        <a
          href={`https://www.openstreetmap.org/#map=${Math.round(zoom)}/${center[0]}/${center[1]}`}
          target="_blank"
          rel="noreferrer"
          aria-label="在 OpenStreetMap 打开当前位置"
        >
          <ExternalLink size={15} />
        </a>
      </div>
      {tileError && (
        <p className="map-error" role="status">
          地图图层连接失败，可重试页面或打开地图链接。已有路线仍可查看。
        </p>
      )}
      <div className="map-source">
        <a href="https://project-osrm.org/" target="_blank" rel="noreferrer">
          路线：OSRM
        </a>
        <a
          href="https://www.openstreetmap.org/fixthemap"
          target="_blank"
          rel="noreferrer"
        >
          纠正地图
        </a>
      </div>
    </div>
  );
}
