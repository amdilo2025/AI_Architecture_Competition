import time
from .store import identifier


def create(plan):
    return {'id': identifier('sim'), 'plan_id': plan['id'], 'task_id': plan['task_id'], 'status': 'paused', 'elapsed': 0.0, 'speed': 10, 'anchor': time.monotonic()}


def elapsed(sim):
    return sim['elapsed'] + ((time.monotonic()-sim['anchor'])*sim['speed'] if sim['status'] == 'playing' else 0)


def command(sim, action, speed, elapsed_seconds=None):
    sim['elapsed'] = elapsed(sim)
    sim['anchor'] = time.monotonic()
    if action == 'play':
        sim['status'] = 'playing'
    elif action == 'pause':
        sim['status'] = 'paused'
    elif action == 'reset':
        sim['status'], sim['elapsed'] = 'paused', 0.0
    elif action == 'speed':
        sim['speed'] = speed
    elif action == 'seek':
        sim['elapsed'] = elapsed_seconds
    return sim


def state(sim, plan):
    total = plan['metrics']['finish_seconds']
    t = min(elapsed(sim), total)
    snapshot = plan['snapshot']
    nodes = {n['id']: n for n in snapshot['nodes']}
    edges = {(e['from'], e['to']): e for e in snapshot['edges'] if e['allowed']}
    vehicles, events = [], []
    delivered = set()
    for route in plan['routes']:
        point = nodes[snapshot['depot_node']]
        status = '未使用' if not route['used'] else '已返回' if t >= route['return_seconds'] else '配送中'
        for leg in route['legs']:
            if t >= leg['end']:
                point = nodes[leg['to']]
            elif t >= leg['start']:
                local = t-leg['start']
                if leg.get('geometry'):
                    import math
                    geometry = leg['geometry']
                    lengths = [math.hypot((b[0]-a[0])*math.cos(math.radians(a[1])), b[1]-a[1]) for a, b in zip(geometry, geometry[1:])]
                    remaining = sum(lengths)*local/max(1, leg['end']-leg['start'])
                    for a, b, length in zip(geometry, geometry[1:], lengths):
                        if remaining <= length:
                            fraction = remaining/max(length, 1e-12)
                            point = {'x': a[0]+(b[0]-a[0])*fraction, 'y': a[1]+(b[1]-a[1])*fraction}
                            break
                        remaining -= length
                    status = '返回配送站' if leg['order_id'] is None else '行驶中'
                    break
                for a, b in zip(leg['path'], leg['path'][1:]):
                    duration = edges[a, b]['travel_seconds']
                    if local <= duration:
                        fraction = local/duration
                        point = {'x': nodes[a]['x']+(nodes[b]['x']-nodes[a]['x'])*fraction, 'y': nodes[a]['y']+(nodes[b]['y']-nodes[a]['y'])*fraction}
                        break
                    local -= duration
                status = '返回配送站' if leg['order_id'] is None else '行驶中'
                break
        for stop in route['stops']:
            if stop['departure'] <= t:
                delivered.add(stop['order_id'])
                events.append({'time': stop['departure'], 'vehicle_id': route['vehicle_id'], 'text': f'{route["vehicle_id"]} 已交付 {stop["order_id"]}'})
            elif stop['arrival'] <= t:
                point = nodes[stop['node_id']]
                status = '等待收货' if t < stop['service_start'] else '交付中'
                break
        vehicles.append({'id': route['vehicle_id'], 'x': point['x'], 'y': point['y'], 'status': status})
    assigned = {o for route in plan['routes'] for o in route['order_ids']}
    orders = {o['id']: '已送达' if o['id'] in delivered else '配送中' if o['id'] in assigned and t > 0 else '待出发' if o['id'] in assigned else '未分配' for o in snapshot['orders']}
    return {'id': sim['id'], 'plan_id': plan['id'], 'status': 'completed' if t >= total and total > 0 else sim['status'], 'elapsed_seconds': round(t, 2), 'total_seconds': total, 'speed': sim['speed'], 'delivered_count': len(delivered), 'vehicles': vehicles, 'orders': orders, 'events': sorted(events, key=lambda e: e['time'], reverse=True)[:20]}
