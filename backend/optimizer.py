"""CVRPTW with return-range constraints and lexicographically dominant dropped-order penalty."""
import time
from ortools.constraint_solver import pywrapcp, routing_enums_pb2
from .scenario import RoadNetwork
from .store import identifier, timestamp


class Cancelled(Exception):
    pass


def schedule(scenario, vehicle, sequence, road):
    orders = {o['id']: o for o in scenario['orders']}
    now, distance, load = 0, 0, 0
    current = scenario['depot_node']
    stops, legs = [], []
    for order_id in sequence:
        order = orders[order_id]
        path = road.route(current, order['node_id'])
        if not path['nodes']:
            return None
        arrival = now + path['seconds']
        service_start = max(arrival, order['window_start'])
        departure = service_start + order['service_seconds']
        if departure > order['window_end']:
            return None
        legs.append({'from': current, 'to': order['node_id'], 'start': now, 'end': arrival, 'path': path['nodes'], 'order_id': order_id})
        stops.append({'order_id': order_id, 'node_id': order['node_id'], 'arrival': arrival, 'service_start': service_start, 'departure': departure})
        now, current = departure, order['node_id']
        distance += path['meters']
        load += round(order['weight_kg']*1000)
    return_path = road.route(current, scenario['depot_node'])
    distance += return_path['meters']
    now += return_path['seconds']
    if load > round(vehicle['capacity_kg']*1000) or distance > vehicle['range_m'] or now > scenario['horizon_seconds'] or not return_path['nodes']:
        return None
    legs.append({'from': current, 'to': scenario['depot_node'], 'start': now-return_path['seconds'], 'end': now, 'path': return_path['nodes'], 'order_id': None})
    return {'vehicle_id': vehicle['id'], 'order_ids': sequence, 'stops': stops, 'legs': legs, 'distance_m': distance if sequence else 0, 'load_kg': load/1000, 'return_seconds': now if sequence else 0, 'used': bool(sequence), 'cost_cents': vehicle['fixed_cost_cents']+round(distance*vehicle['cost_per_km_cents']/1000) if sequence else 0}


def baseline_sequences(scenario, road, cancel):
    remaining = {o['id']: o for o in scenario['orders']}
    result = []
    for vehicle in scenario['vehicles']:
        sequence = []
        current = scenario['depot_node']
        while remaining:
            if cancel.is_set():
                raise Cancelled()
            ordered = sorted(remaining.values(), key=lambda o: (road.route(current, o['node_id'])['meters'], o['id']))
            found = next((o for o in ordered if schedule(scenario, vehicle, sequence+[o['id']], road)), None)
            if found is None:
                break
            sequence.append(found['id'])
            current = found['node_id']
            del remaining[found['id']]
        result.append(sequence)
    return result


def optimized_sequences(scenario, road, seconds, cancel):
    orders, vehicles = scenario['orders'], scenario['vehicles']
    nodes = [scenario['depot_node']] + [o['node_id'] for o in orders]
    paths = [[road.route(a, b) for b in nodes] for a in nodes]
    manager = pywrapcp.RoutingIndexManager(len(nodes), len(vehicles), 0)
    routing = pywrapcp.RoutingModel(manager)
    distance_cb = routing.RegisterTransitCallback(lambda a, b: paths[manager.IndexToNode(a)][manager.IndexToNode(b)]['meters'])
    routing.AddDimensionWithVehicleCapacity(distance_cb, 0, [v['range_m'] for v in vehicles], True, 'Range')
    demand_cb = routing.RegisterUnaryTransitCallback(lambda a: 0 if manager.IndexToNode(a) == 0 else orders[manager.IndexToNode(a)-1].get('weight_g', round(orders[manager.IndexToNode(a)-1]['weight_kg']*1000)))
    routing.AddDimensionWithVehicleCapacity(demand_cb, 0, [v.get('capacity_g', round(v['capacity_kg']*1000)) for v in vehicles], True, 'Load')
    def transit(a, b):
        node = manager.IndexToNode(a)
        return paths[node][manager.IndexToNode(b)]['seconds'] + (orders[node-1]['service_seconds'] if node else 0)
    time_cb = routing.RegisterTransitCallback(transit)
    routing.AddDimension(time_cb, scenario['horizon_seconds'], scenario['horizon_seconds'], True, 'Time')
    time_dim = routing.GetDimensionOrDie('Time')
    # This upper bound makes one additional completed order dominate all possible fleet cost savings.
    maximum_fleet_cost = sum(v['fixed_cost_cents'] + round(v['range_m']*v['cost_per_km_cents']/1000) for v in vehicles)
    maximum_distance = sum(v['range_m'] for v in vehicles)
    tie_scale = maximum_distance+1
    # Complete more orders, then lower recorded fees, then lower distance even when fees are zero.
    penalty = maximum_fleet_cost*tie_scale+maximum_distance+1
    for i, order in enumerate(orders, 1):
        index = manager.NodeToIndex(i)
        upper = order['window_end']-order['service_seconds']
        if upper < order['window_start']:
            routing.ActiveVar(index).SetValue(0)
        else:
            time_dim.CumulVar(index).SetRange(order['window_start'], upper)
        routing.AddDisjunction([index], penalty)
    for v, vehicle in enumerate(vehicles):
        rate = vehicle['cost_per_km_cents']
        cost_cb = routing.RegisterTransitCallback(lambda a, b, rate=rate: round(paths[manager.IndexToNode(a)][manager.IndexToNode(b)]['meters']*rate/1000)*tie_scale+paths[manager.IndexToNode(a)][manager.IndexToNode(b)]['meters'])
        routing.SetArcCostEvaluatorOfVehicle(cost_cb, v)
        routing.SetFixedCostOfVehicle(vehicle['fixed_cost_cents']*tie_scale, v)
        routing.AddVariableMinimizedByFinalizer(time_dim.CumulVar(routing.End(v)))
    def on_solution():
        if cancel.is_set():
            routing.solver().FinishCurrentSearch()
    routing.AddAtSolutionCallback(on_solution)
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION
    params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.seconds = seconds
    solution = routing.SolveWithParameters(params)
    if cancel.is_set():
        raise Cancelled()
    if solution is None:
        return [[] for _ in vehicles]
    result = []
    for v in range(len(vehicles)):
        index, sequence = routing.Start(v), []
        while not routing.IsEnd(index):
            node = manager.IndexToNode(index)
            if node:
                sequence.append(orders[node-1]['id'])
            index = solution.Value(routing.NextVar(index))
        result.append(sequence)
    return result


def validate_plan(scenario, routes):
    """Recompute routes from source input rather than trusting solver totals."""
    road = RoadNetwork(scenario)
    seen, violations = set(), []
    vehicle_map = {v['id']: v for v in scenario['vehicles']}
    seen_vehicles = set()
    known_orders = {o['id'] for o in scenario['orders']}
    for route in routes:
        if route['vehicle_id'] not in vehicle_map or route['vehicle_id'] in seen_vehicles:
            violations.append('车辆未知或重复')
            continue
        seen_vehicles.add(route['vehicle_id'])
        for order_id in route['order_ids']:
            if order_id in seen or order_id not in known_orders:
                violations.append(f'订单重复或未知：{order_id}')
            seen.add(order_id)
        if set(route['order_ids']) <= known_orders:
            recalculated = schedule(scenario, vehicle_map[route['vehicle_id']], route['order_ids'], road)
            if recalculated is None:
                violations.append(f'{route["vehicle_id"]}违反道路、时间、载重或返程续航约束')
            elif any(route[k] != recalculated[k] for k in ['distance_m', 'load_kg', 'return_seconds', 'cost_cents', 'stops']) or [{k: v for k, v in leg.items() if k != 'geometry'} for leg in route['legs']] != recalculated['legs']:
                violations.append(f'{route["vehicle_id"]}路线数据与重新计算结果不一致')
    return {'valid': not violations, 'violations': violations, 'checked': ['订单唯一性', '道路通行', '交付时间窗口', '最大载重', '含返程续航', '路线数据一致性']}


def unassigned_reason(scenario, order, road):
    outward = road.route(scenario['depot_node'], order['node_id'])
    backward = road.route(order['node_id'], scenario['depot_node'])
    if not outward['nodes'] or not backward['nodes']:
        return '配送站与收货点之间没有可用往返道路，请核对位置或道路服务'
    issues = []
    capacity = max((v['capacity_kg'] for v in scenario['vehicles']), default=0)
    distance = outward['meters'] + backward['meters']
    available_range = max((v['range_m'] for v in scenario['vehicles']), default=0)
    if round(order['weight_kg']*1000) > round(capacity*1000):
        issues.append(f'订单重 {order["weight_kg"]:g} kg，最大可用载重仅 {capacity:g} kg')
    if distance > available_range:
        issues.append(f'道路往返约 {distance/1000:.2f} km，最大可用续航仅 {available_range/1000:g} km')
    departure = max(outward['seconds'], order['window_start']) + order['service_seconds']
    if departure > order['window_end']:
        issues.append('最早交付完成时间超过收货截止时间，请放宽时间窗口')
    if departure + backward['seconds'] > scenario['horizon_seconds']:
        issues.append('完成交付并返站需要超过当前工作时长')
    if issues:
        return '；'.join(issues)
    if any(schedule(scenario, v, [order['id']], road) for v in scenario['vehicles']):
        return '单独配送可行，当前车队组合或搜索预算下未分配；可增加可用车辆或放宽时间窗口'
    return '没有同一辆可用车辆同时满足本单的载重、往返续航与时间约束，请核对车辆参数'


def solve(scenario, algorithm, time_limit, cancel, stage=lambda value: None):
    started = time.perf_counter()
    stage('计算道路距离和行驶时间')
    road = RoadNetwork(scenario)
    stage('分配订单并优化访问顺序')
    sequences = optimized_sequences(scenario, road, time_limit, cancel) if algorithm == 'optimized' else baseline_sequences(scenario, road, cancel)
    routes = []
    for vehicle, sequence in zip(scenario['vehicles'], sequences):
        route = schedule(scenario, vehicle, sequence, road)
        if route is None:
            raise ValueError('求解输出未通过独立调度重算')
        routes.append(route)
    stage('检查方案约束')
    validation = validate_plan(scenario, routes)
    if not validation['valid']:
        raise ValueError('方案约束校验失败')
    assigned = {o for r in routes for o in r['order_ids']}
    unassigned = []
    for order in scenario['orders']:
        if order['id'] not in assigned:
            reason = unassigned_reason(scenario, order, road)
            unassigned.append({'order_id': order['id'], 'reason': reason})
    used = [r for r in routes if r['used']]
    return {'id': identifier('plan'), 'task_id': scenario['task_id'], 'scenario_id': scenario['id'], 'scenario_revision': scenario['revision'], 'snapshot': scenario, 'algorithm': algorithm, 'solver': 'OR-Tools CVRPTW / Guided Local Search' if algorithm == 'optimized' else 'Feasible nearest-neighbor greedy', 'outcome': 'full' if not unassigned else ('partial' if assigned else 'infeasible'), 'routes': routes, 'unassigned': unassigned, 'validation': validation, 'metrics': {'total_orders': len(scenario['orders']), 'completed_orders': len(assigned), 'completion_rate': len(assigned)/len(scenario['orders']), 'total_distance_m': sum(r['distance_m'] for r in routes), 'vehicles_used': len(used), 'cost_cents': sum(r['cost_cents'] for r in routes), 'finish_seconds': max((r['return_seconds'] for r in used), default=0), 'solve_seconds': round(time.perf_counter()-started, 4)}, 'created_at': timestamp()}
