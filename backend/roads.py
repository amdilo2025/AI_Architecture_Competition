"""Real OSM places, directional OSRM road matrices and full route geometry.

Public endpoints are modest-use demos. Cache and globally serialize at <=1 request/sec.
Never replace failures with synthetic or straight-line routes.
"""
import hashlib
import json
import math
import os
import time
from threading import Lock
import httpx
from .store import Store, identifier, timestamp


class RoadServiceError(Exception):
    pass


_lock = Lock()
_last_request = 0.0


class RoadService:
    def __init__(self, store=None, transport=None):
        self.store = store or Store()
        self.transport = transport
        self.osrm = os.getenv('OSRM_BASE_URL', 'https://routing.openstreetmap.de/routed-car').rstrip('/')
        self.photon = os.getenv('PHOTON_BASE_URL', 'https://photon.komoot.io').rstrip('/')

    def get(self, url, params, ttl=86400):
        global _last_request
        key = hashlib.sha256(json.dumps([url, params], sort_keys=True).encode()).hexdigest()
        cached = self.store.get('road_cache', key)
        if cached and time.time()-cached['saved'] < ttl:
            return cached['data']
        with _lock:
            cached = self.store.get('road_cache', key)
            if cached and time.time()-cached['saved'] < ttl:
                return cached['data']
            if not self.transport:
                time.sleep(max(0, 1.05-(time.monotonic()-_last_request)))
            _last_request = time.monotonic()
            try:
                with httpx.Client(timeout=40, transport=self.transport, follow_redirects=False, headers={'User-Agent': 'LuxuDispatch/2.0 (architecture competition; open-source OSM routing)', 'Referer': os.getenv('PUBLIC_APP_URL', 'http://127.0.0.1:8080')}) as client:
                    response = client.get(url, params=params)
                    response.raise_for_status()
                    data = response.json()
                if data.get('code') and data['code'] != 'Ok':
                    raise ValueError(data['code'])
                data['_retrieved_at'] = timestamp()
            except (httpx.HTTPError, ValueError) as exc:
                raise RoadServiceError('真实道路或地点服务暂时不可用，请重试，或在服务配置中切换自建服务') from exc
            self.store.put('road_cache', {'id': key, 'saved': time.time(), 'data': data})
            return data

    def search(self, query, lat=35, lon=105):
        data = self.get(self.photon+'/api/', {'q': query, 'limit': 6, 'lat': lat, 'lon': lon})
        result = []
        for feature in data.get('features', []):
            props = feature['properties']
            coordinate = feature['geometry']['coordinates']
            address = ' · '.join(dict.fromkeys(str(props[k]) for k in ('country', 'state', 'city', 'district', 'street', 'housenumber') if props.get(k)))
            result.append({'name': props.get('name') or props.get('street') or address, 'address': address, 'lat': coordinate[1], 'lon': coordinate[0], 'source': 'photon', 'osm_id': props.get('osm_id')})
        return result

    def matrix(self, points, refresh=False):
        if refresh:
            # Geometry and matrix must refresh together; otherwise an old route could be compared to new roads.
            with self.store.lock, self.store.connection() as db:
                db.execute("DELETE FROM objects WHERE kind='road_cache'")
        coords = ';'.join(f'{p["lon"]:.6f},{p["lat"]:.6f}' for p in points)
        data = self.get(self.osrm+'/table/v1/driving/'+coords, {'annotations': 'distance,duration', 'radiuses': ';'.join('300' for _ in points)}, ttl=0 if refresh else 86400)
        if len(data.get('distances', [])) != len(points) or len(data.get('durations', [])) != len(points):
            raise RoadServiceError('道路服务返回的距离矩阵不完整，请重试')
        for row in data['distances']+data['durations']:
            if len(row) != len(points):
                raise RoadServiceError('道路矩阵格式异常')
        return {'distances': [[round(v) if v is not None else None for v in row] for row in data['distances']], 'durations': [[math.ceil(v) if v is not None else None for v in row] for row in data['durations']], 'snapped': [{'lon': p['location'][0], 'lat': p['location'][1], 'distance_m': p.get('distance', 0)} for p in data['sources']], 'provider': 'OSRM / OpenStreetMap', 'profile': 'driving', 'fetched_at': data.get('_retrieved_at', timestamp())}

    def geometry(self, a, b):
        if a['lon'] == b['lon'] and a['lat'] == b['lat']:
            return {'coordinates': [[a['lon'], a['lat']], [b['lon'], b['lat']]], 'distance_m': 0, 'seconds': 0}
        coords = f'{a["lon"]:.6f},{a["lat"]:.6f};{b["lon"]:.6f},{b["lat"]:.6f}'
        data = self.get(self.osrm+'/route/v1/driving/'+coords, {'overview': 'full', 'geometries': 'geojson', 'radiuses': '300;300', 'steps': 'false', 'continue_straight': 'false'})
        route = data['routes'][0]
        return {'coordinates': route['geometry']['coordinates'], 'distance_m': round(route['distance']), 'seconds': math.ceil(route['duration'])}


def prepare(data, task_id, road, id=None, revision=1, previous=None, refresh=False):
    request = data.model_dump(mode='json')
    locations = [request['depot']]+[o['location'] for o in request['orders']]
    nodes = [{'id': 'depot' if i == 0 else f'point_{i}', 'x': p['lon'], 'y': p['lat'], 'lon': p['lon'], 'lat': p['lat'], 'name': p['name']} for i, p in enumerate(locations)]
    # Vehicle/weight/window edits reuse the same immutable road snapshot.
    same = previous and [(n['x'], n['y']) for n in previous['nodes']] == [(n['x'], n['y']) for n in nodes]
    matrix = previous['road_matrix'] if same and not refresh else road.matrix(locations, refresh=True) if refresh else road.matrix(locations)
    orders = [{**{k: o[k] for k in ('id', 'weight_kg', 'window_start', 'window_end', 'service_seconds')}, 'weight_g': round(o['weight_kg']*1000), 'name': o['location']['name'], 'address': o['location']['address'], 'location': o['location'], 'node_id': nodes[i+1]['id']} for i, o in enumerate(request['orders'])]
    vehicles = [{**v, 'capacity_g': round(v['capacity_kg']*1000), 'range_m': round(v['range_km']*1000)} for v in request['vehicles'] if v['available']]
    return {'id': id or identifier('scenario'), 'task_id': task_id, 'revision': revision, 'source': 'user_input_osm', 'coordinate_system': 'WGS84', 'city': request['city'], 'start_time': request['start_time'], 'horizon_seconds': request['horizon_seconds'], 'input': request, 'params': {}, 'depot_node': 'depot', 'nodes': nodes, 'edges': [], 'orders': orders, 'vehicles': vehicles, 'road_matrix': matrix, 'provenance': {'orders': '用户录入', 'vehicles': '用户录入', 'roads': 'OpenStreetMap / OSRM', 'places': '用户地图选点、输入坐标或 Photon 搜索'}, 'created_at': timestamp()}


def enrich_plan(plan, road, cancel, stage):
    from .optimizer import Cancelled
    nodes = {n['id']: n for n in plan['snapshot']['nodes']}
    matrix = plan['snapshot']['road_matrix']
    indices = {n['id']: i for i, n in enumerate(plan['snapshot']['nodes'])}
    legs = [leg for r in plan['routes'] if r['used'] for leg in r['legs']]
    for i, leg in enumerate(legs):
        if cancel.is_set():
            raise Cancelled()
        stage(f'获取真实道路路线 {i+1}/{len(legs)}')
        value = road.geometry(nodes[leg['from']], nodes[leg['to']])
        a, b = indices[leg['from']], indices[leg['to']]
        # OSRM Table uses segment weights; Route reconstructs geometry with small interpolation differences.
        # Accept only small numeric differences, never a different road path/time regime.
        if abs(value['distance_m']-matrix['distances'][a][b]) > max(20, matrix['distances'][a][b]*.01) or abs(value['seconds']-matrix['durations'][a][b]) > max(3, matrix['durations'][a][b]*.01):
            raise RoadServiceError('道路数据已变化，路径与距离矩阵不一致，请刷新道路后重新计算')
        leg['geometry'] = value['coordinates']
    plan['routing_source'] = 'OSRM / OpenStreetMap'
    return plan
