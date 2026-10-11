"""Legacy grid fixtures solely for algorithm regression tests; never application data."""
import heapq
import random
from pydantic import BaseModel, Field
from backend.store import identifier, timestamp

class ScenarioConfig(BaseModel):
    seed: int = Field(default=42, ge=0, le=999999)
    order_count: int = Field(default=30, ge=1, le=120)
    vehicle_count: int = Field(default=5, ge=1, le=15)
    capacity_kg: int = Field(default=100, ge=5, le=500)
    range_km: int = Field(default=45, ge=2, le=200)
    window_minutes: int = Field(default=120, ge=10, le=240)
    service_seconds: int = Field(default=120, ge=30, le=600)



def generate(config, task_id, id=None, revision=1):
    rng = random.Random(config['seed'])
    nodes = [{'id': f'n{x}_{y}', 'x': x * 1000, 'y': y * 1000} for y in range(7) for x in range(7)]
    edges = []
    for node in nodes:
        x, y = node['x'] // 1000, node['y'] // 1000
        for dx, dy in [(1, 0), (0, 1)]:
            if x+dx > 6 or y+dy > 6:
                continue
            target = f'n{x+dx}_{y+dy}'
            speed = rng.choice([18, 22, 26, 30])
            # Outer ring remains bidirectional, ensuring the graph is connected.
            interior = 0 < x < 5 and 0 < y < 5
            # Vertical corridors are always open; every node can reach the outer ring.
            mode = rng.random() if interior and dx == 1 else 1
            # Always demonstrate both a closure and a one-way street, for every seed.
            if dx == 1 and (x, y) == (2, 2):
                mode = 0
            elif dx == 1 and (x, y) == (4, 4):
                mode = .15
            allowed_forward = mode >= .07
            allowed_reverse = mode >= .23
            for a, b, allowed in [(node['id'], target, allowed_forward), (target, node['id'], allowed_reverse)]:
                edges.append({'id': f'{a}:{b}', 'from': a, 'to': b, 'distance_m': 1000, 'travel_seconds': round(3600/speed), 'allowed': allowed})
    points = [n for n in nodes if n['id'] != 'n3_3']
    rng.shuffle(points)
    orders = []
    for i in range(config['order_count']):
        point = points[i % len(points)]
        start = rng.choice([0, 1200, 2400, 3600])
        end = min(14400, start + config['window_minutes'] * 60)
        orders.append({'id': f'O{i+1:03}', 'name': f'{["青禾", "云桥", "望江", "文景", "北辰", "长乐"][i%6]}配送点 {i+1:02}', 'node_id': point['id'], 'weight_kg': rng.randint(5, 18), 'window_start': start, 'window_end': end, 'service_seconds': config['service_seconds']})
    vehicles = [{'id': f'V{i+1:02}', 'name': f'配送车 {i+1:02}', 'capacity_kg': config['capacity_kg'], 'range_m': config['range_km']*1000, 'fixed_cost_cents': 3000, 'cost_per_km_cents': 120} for i in range(config['vehicle_count'])]
    return {'id': id or identifier('scenario'), 'task_id': task_id, 'revision': revision, 'source': 'synthetic', 'coordinate_system': 'local_meters', 'start_time': '2026-10-12T08:00:00+08:00', 'horizon_seconds': 14400, 'params': config, 'depot_node': 'n3_3', 'nodes': nodes, 'edges': edges, 'orders': orders, 'vehicles': vehicles, 'created_at': timestamp()}
