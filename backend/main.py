import copy
import hashlib
import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Event

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()
from . import simulation
from . import ai
from .auth import Auth, COOKIE
from .roads import RoadService, RoadServiceError, prepare, enrich_plan
from .integrations import ExternalGateway, LLMGateway, MapGateway, VehicleGateway, integration_status
from .models import ApplyProposal, MessageRequest, Credentials, Registration, RealScenarioInput, RealScenarioPatch, SimulationCommand, SimulationCreate, SolveRequest, TaskCreate
from .optimizer import Cancelled, solve, unassigned_reason
from .scenario import RoadNetwork
from .store import Store, identifier, timestamp

@asynccontextmanager
async def lifespan(application):
    # Only an actual server startup recovers orphaned work. Importing the module
    # for tests or tooling must not interrupt another process using this store.
    with store.lock:
        for interrupted in store.all('job'):
            if interrupted['status'] in ('queued', 'running'):
                interrupted.update(status='failed', stage='服务重启，计算已中断，请重新计算')
                store.put('job', interrupted)
        for previous in store.all('simulation'):
            previous.update(status='paused', anchor=time.monotonic())
            store.put('simulation', previous)
    yield


app = FastAPI(title='路序 · 城市配送调度 API', version='2.0.0', lifespan=lifespan)
store = Store()
auth = Auth(store)
roads = RoadService(store)
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='dispatch')
cancellations = {}


def own_object(kind, id, user):
    obj = required(kind, id)
    task = obj if kind == 'task' else required('task', obj['task_id'])
    if task.get('owner_id') != user['id']:
        raise HTTPException(404, '任务或数据不存在')
    return obj


@app.middleware('http')
async def account_boundary(request: Request, call_next):
    path = request.url.path
    if not path.startswith('/api/v1/'):
        return await call_next(request)
    try:
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            origin = request.headers.get('origin')
            allowed = {str(request.base_url).rstrip('/'), os.getenv('PUBLIC_APP_URL', 'http://127.0.0.1:8080').rstrip('/')}
            if origin and origin not in allowed:
                raise HTTPException(403, '请求来源无效，请从工作台重新操作')
        if path != '/api/v1/health' and not path.startswith('/api/v1/auth/'):
            user = auth.current(request)
            request.state.user = user
            parts = path.split('/')[3:]
            kinds = {'tasks': 'task', 'scenarios': 'scenario', 'jobs': 'job', 'plans': 'plan', 'comparisons': 'comparison', 'proposals': 'proposal', 'simulations': 'simulation'}
            if len(parts) > 1 and parts[0] in kinds:
                own_object(kinds[parts[0]], parts[1], user)
            if request.method == 'POST' and parts[0] in ('optimization-jobs', 'comparison-jobs', 'simulations'):
                payload = await request.json()
                key, kind = ('plan_id', 'plan') if parts[0] == 'simulations' else ('scenario_id', 'scenario')
                if isinstance(payload, dict) and payload.get(key):
                    own_object(kind, payload[key], user)
        return await call_next(request)
    except HTTPException as exc:
        return await http_error(request, exc)
    except (ValueError, KeyError):
        return JSONResponse(status_code=422, content={'error': {'message': '请求格式无效'}})


@app.post('/api/v1/auth/register', status_code=201)
def register(body: Registration, request: Request, response: Response):
    auth.throttle(request.client.host if request.client else '', 'register')
    return auth.session(auth.register(body), response)


@app.post('/api/v1/auth/login')
def login(body: Credentials, request: Request, response: Response):
    key = auth.throttle(request.client.host if request.client else '', body.username)
    user = auth.login(body)
    auth.attempts.pop(key, None)
    return auth.session(user, response)


@app.get('/api/v1/auth/me')
def me(request: Request):
    return auth.current(request)


@app.post('/api/v1/auth/logout')
def logout(request: Request, response: Response):
    auth.logout(request, response)
    return {'status': 'ok'}

@app.exception_handler(HTTPException)
async def http_error(request, exc):
    detail = exc.detail if isinstance(exc.detail, dict) else {'code': 'REQUEST_ERROR', 'message': str(exc.detail)}
    return JSONResponse(status_code=exc.status_code, content={'error': {**detail, 'request_id': identifier('req')}})


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    fields = [{'field': '.'.join(map(str, e['loc'][1:])), 'message': e['msg']} for e in exc.errors()]
    return JSONResponse(status_code=422, content={'error': {'code': 'VALIDATION_ERROR', 'message': '参数无效，请检查字段范围', 'fields': fields, 'request_id': identifier('req')}})


def required(kind, id):
    obj = store.get(kind, id)
    if obj is None:
        raise HTTPException(404, {'code': 'NOT_FOUND', 'message': '任务或数据不存在，请返回任务列表'})
    return obj


def check_revision(scenario, expected):
    if scenario['revision'] != expected:
        raise HTTPException(409, {'code': 'REVISION_CONFLICT', 'message': '场景已修改，请刷新数据后重试', 'current_revision': scenario['revision']})


def add_message(task_id, content, role='assistant', **metadata):
    with store.lock:
        task = required('task', task_id)
        msg = {'id': identifier('msg'), 'role': role, 'content': content, 'created_at': timestamp(), **metadata}
        task['messages'].append(msg)
        task['updated_at'] = timestamp()
        store.put('task', task)
        return msg


@app.get('/api/v1/health')
def health():
    return {'status': 'ok', 'version': '2.0.0'}


@app.post('/api/v1/tasks', status_code=201)
def create_task(body: TaskCreate, request: Request):
    task = {'id': identifier('task'), 'owner_id': request.state.user['id'], 'name': body.name, 'scenario_id': None, 'plan_ids': [], 'comparison_ids': [], 'job_ids': [], 'messages': [], 'created_at': timestamp(), 'updated_at': timestamp()}
    return store.put('task', task)


@app.get('/api/v1/tasks')
def list_tasks(request: Request, page: int = 1, page_size: int = 30):
    page, page_size = max(1, page), min(100, max(1, page_size))
    items = sorted([t for t in store.all('task') if t.get('owner_id') == request.state.user['id']], key=lambda t: t['updated_at'], reverse=True)
    return {'items': [{'id': t['id'], 'name': t['name'], 'updated_at': t['updated_at'], 'has_plan': bool(t['plan_ids'])} for t in items[(page-1)*page_size:page*page_size]], 'total': len(items)}


@app.get('/api/v1/tasks/{id}')
def get_task(id: str):
    task = required('task', id)
    return {**task, 'jobs': [public_job(required('job', jid)) for jid in task['job_ids'][-10:]]}


@app.post('/api/v1/tasks/{id}/scenarios', status_code=201)
def create_scenario(id: str, body: RealScenarioInput):
    required('task', id)
    try:
        prepared = prepare(body, id, roads)
    except RoadServiceError as exc:
        raise HTTPException(502, str(exc))
    with store.lock:
        task = required('task', id)
        if task['scenario_id']:
            raise HTTPException(409, {'code': 'SCENARIO_EXISTS', 'message': '此任务已有场景，请修改场景或新建任务'})
        scenario = store.put('scenario', prepared)
        task.update(scenario_id=scenario['id'], updated_at=timestamp())
        store.put('task', task)
    add_message(id, f'已加载 {len(scenario["orders"])} 个订单、{len(scenario["vehicles"])} 辆可用车辆及真实道路距离。可以生成方案或先检查配送风险。', source='system', actions=['optimize'])
    return scenario


@app.get('/api/v1/scenarios/{id}')
def get_scenario(id: str):
    return required('scenario', id)


@app.get('/api/v1/scenarios/{id}/orders')
def list_orders(id: str, page: int = 1, page_size: int = 10, query: str = ''):
    scenario = required('scenario', id)
    page, page_size = max(1, page), min(100, max(1, page_size))
    items = [o for o in scenario['orders'] if query.casefold() in (o['id']+o['name']).casefold()]
    return {'items': items[(page-1)*page_size:page*page_size], 'total': len(items), 'page': page, 'page_size': page_size}


def patch_scenario(id, expected_revision, data):
    old = required('scenario', id)
    check_revision(old, expected_revision)
    try:
        prepared = prepare(data, old['task_id'], roads, id, old['revision']+1, old)
    except RoadServiceError as exc:
        raise HTTPException(502, str(exc))
    with store.lock:
        old = required('scenario', id)
        check_revision(old, expected_revision)
        scenario = store.put('scenario', prepared)
    add_message(old['task_id'], '场景参数已更新。已有方案保留原始快照，请重新计算以使用最新场景。', source='rules', actions=['optimize'])
    return scenario


@app.patch('/api/v1/scenarios/{id}')
def update_scenario(id: str, body: RealScenarioPatch):
    return patch_scenario(id, body.expected_revision, body.data)


@app.get('/api/v1/places/search')
def search_places(query: str, lat: float = 35, lon: float = 105):
    if not 2 <= len(query.strip()) <= 160 or not -85 <= lat <= 85 or not -180 <= lon <= 180:
        raise HTTPException(422, '请输入 2～160 字的公共地点名称及有效坐标')
    try:
        return {'items': roads.search(query, lat, lon)}
    except RoadServiceError as exc:
        raise HTTPException(502, str(exc))


@app.post('/api/v1/scenarios/{id}/refresh-roads')
def refresh_roads(id: str, body: ApplyProposal):
    old = required('scenario', id)
    check_revision(old, body.expected_revision)
    try:
        fresh = prepare(RealScenarioInput(**old['input']), old['task_id'], roads, id, old['revision']+1, refresh=True)
    except RoadServiceError as exc:
        raise HTTPException(502, str(exc))
    with store.lock:
        check_revision(required('scenario', id), body.expected_revision)
        store.put('scenario', fresh)
    add_message(old['task_id'], '真实道路数据已刷新，请重新生成方案。', source='system', actions=['optimize'])
    return fresh


@app.get('/api/v1/map/config')
def map_config():
    return {'tile_url': os.getenv('MAP_TILE_URL', 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'), 'attribution': os.getenv('MAP_ATTRIBUTION', '&copy; OpenStreetMap contributors'), 'max_zoom': 19}


def set_job_stage(job_id, stage):
    with store.lock:
        job = required('job', job_id)
        job.update(stage=stage, elapsed_seconds=round(time.monotonic()-job.get('_started', time.monotonic()), 2))
        store.put('job', job)


def run_job(job_id, snapshot, body, comparison):
    event = cancellations[job_id]
    try:
        with store.lock:
            job = required('job', job_id)
            job.update(status='running', _started=time.monotonic())
            store.put('job', job)
        if event.is_set():
            raise Cancelled()
        stage = lambda value: set_job_stage(job_id, value)
        if comparison:
            stage('运行可行就近贪心基准')
            base = solve(snapshot, 'baseline', body.time_limit_seconds, event, stage)
            optimized = solve(snapshot, 'optimized', body.time_limit_seconds, event, stage)
            enrich_plan(base, roads, event, stage)
            enrich_plan(optimized, roads, event, stage)
            result = {'id': identifier('comparison'), 'task_id': snapshot['task_id'], 'scenario_id': snapshot['id'], 'scenario_revision': snapshot['revision'], 'baseline': base, 'optimized': optimized, 'comparable_cost': base['metrics']['completed_orders'] == optimized['metrics']['completed_orders'], 'note': '两种方法使用同一场景、硬约束与评价口径；完成量不同时不宣称成本节约比例。', 'created_at': timestamp()}
            kind = 'comparison'
        else:
            result = solve(snapshot, body.algorithm, body.time_limit_seconds, event, stage)
            enrich_plan(result, roads, event, stage)
            kind = 'plan'
        with store.lock:
            if event.is_set():
                raise Cancelled()
            store.put(kind, result)
            task = required('task', snapshot['task_id'])
            task['comparison_ids' if comparison else 'plan_ids'].append(result['id'])
            if comparison:
                store.put('plan', base)
                store.put('plan', optimized)
            task['updated_at'] = timestamp()
            store.put('task', task)
            job = required('job', job_id)
            job.update(status='succeeded', stage='已完成', result_id=result['id'], result_kind=kind, elapsed_seconds=round(time.monotonic()-job['_started'], 3))
            store.put('job', job)
            if comparison:
                add_message(snapshot['task_id'], '基准对比已完成。两种方法使用同一份场景，查看订单完成量与成本差异。', source='solver', comparison_id=result['id'], actions=['comparison'])
            else:
                metrics = result['metrics']
                add_message(snapshot['task_id'], f'方案已生成，完成 {metrics["completed_orders"]}/{metrics["total_orders"]} 个订单，使用 {metrics["vehicles_used"]} 辆车。约束校验通过。', source='solver', plan_id=result['id'], actions=['map', 'compare', 'simulate'])
    except Cancelled:
        with store.lock:
            job = required('job', job_id)
            job.update(status='cancelled', stage='已取消，未发布计算结果')
            store.put('job', job)
    except Exception as exc:
        logging.exception('Dispatch job failed')
        with store.lock:
            job = required('job', job_id)
            job.update(status='failed', stage=str(exc) if isinstance(exc, RoadServiceError) else '计算失败，请重试或调整订单与车辆')
            store.put('job', job)
    finally:
        cancellations.pop(job_id, None)


def start_job(body, comparison, key):
    with store.lock:
        scenario = required('scenario', body.scenario_id)
        digest = hashlib.sha256(json.dumps({'body': body.model_dump(), 'comparison': comparison}, sort_keys=True).encode()).hexdigest()
        if key:
            for job in store.all('job'):
                if job.get('idempotency_key') == key and job['task_id'] == scenario['task_id']:
                    if job['request_digest'] != digest:
                        raise HTTPException(409, {'code': 'IDEMPOTENCY_CONFLICT', 'message': '请求编号已用于其他参数，请重新提交'})
                    return public_job(job)
        check_revision(scenario, body.expected_revision)
        snapshot = copy.deepcopy(scenario)
        job = {'id': identifier('job'), 'task_id': scenario['task_id'], 'scenario_revision': scenario['revision'], 'status': 'queued', 'stage': '检查订单与车辆', 'elapsed_seconds': 0, 'result_id': None, 'result_kind': 'comparison' if comparison else 'plan', 'idempotency_key': key, 'request_digest': digest, 'created_at': timestamp()}
        store.put('job', job)
        task = required('task', scenario['task_id'])
        task['job_ids'].append(job['id'])
        store.put('task', task)
        cancellations[job['id']] = Event()
        executor.submit(run_job, job['id'], snapshot, body, comparison)
        return public_job(job)


def public_job(job):
    return {k: v for k, v in job.items() if not k.startswith('_') and k not in ('idempotency_key', 'request_digest')}


@app.post('/api/v1/optimization-jobs', status_code=202)
def create_job(body: SolveRequest, idempotency_key: str | None = Header(default=None)):
    return start_job(body, False, idempotency_key)


@app.post('/api/v1/comparison-jobs', status_code=202)
def create_comparison(body: SolveRequest, idempotency_key: str | None = Header(default=None)):
    return start_job(body, True, idempotency_key)


@app.get('/api/v1/jobs/{id}')
def get_job(id: str):
    job = required('job', id)
    result = public_job(job)
    if job['status'] == 'running':
        result['elapsed_seconds'] = round(time.monotonic()-job['_started'], 2)
    return result


@app.post('/api/v1/jobs/{id}/cancel')
def cancel_job(id: str):
    with store.lock:
        job = required('job', id)
        if id in cancellations:
            cancellations[id].set()
            return {**public_job(job), 'cancel_requested': True}
        return {**public_job(job), 'cancel_requested': False}


@app.get('/api/v1/plans/{id}')
def get_plan(id: str):
    plan = required('plan', id)
    # Explain legacy saved plans from their immutable snapshots without rewriting them.
    road = RoadNetwork(plan['snapshot'])
    orders = {o['id']: o for o in plan['snapshot']['orders']}
    for item in plan['unassigned']:
        item['reason'] = unassigned_reason(plan['snapshot'], orders[item['order_id']], road)
    return plan


@app.get('/api/v1/comparisons/{id}')
def get_comparison(id: str):
    return required('comparison', id)


@app.post('/api/v1/tasks/{id}/messages')
async def send_message(id: str, body: MessageRequest):
    task = required('task', id)
    scenario = required('scenario', task['scenario_id']) if task['scenario_id'] else None
    if scenario and body.scenario_revision is not None:
        check_revision(scenario, body.scenario_revision)
    add_message(id, body.content, role='user')
    latest = required('plan', task['plan_ids'][-1]) if task['plan_ids'] else None
    result = ai.reply(body.content, scenario, latest)
    content, actions, source = result['text'], result['actions'], 'local_ai'
    disable_ids = result['disable_vehicle_ids']
    if os.getenv('LLM_BASE_URL'):
        try:
            reply = await LLMGateway(os.environ['LLM_BASE_URL'], os.getenv('LLM_API_KEY', '')).reply(body.content, scenario)
            content, source = reply['text'], 'model'
            disable_ids = reply.get('disable_vehicle_ids')
        except Exception:
            content = result['text']+'\n大模型服务暂时不可用，本次由本地调度助手处理。'
            source = 'local_ai'
    proposal = None
    if disable_ids and scenario:
        data = copy.deepcopy(scenario['input'])
        for v in data['vehicles']:
            if v['id'] in disable_ids:
                v['available'] = False
        RealScenarioInput(**data)
        proposal = store.put('proposal', {'id': identifier('proposal'), 'task_id': id, 'scenario_id': scenario['id'], 'scenario_revision': scenario['revision'], 'data': data, 'description': '停用车辆：'+'、'.join(disable_ids), 'applied': False})
    return add_message(id, content, source=source, ai={k: result[k] for k in ('intent', 'confidence', 'model', 'training_examples')}, actions=actions, proposal=proposal)


@app.post('/api/v1/proposals/{id}/apply')
def apply_proposal(id: str, body: ApplyProposal):
    with store.lock:
        proposal = required('proposal', id)
        if proposal['applied']:
            return required('scenario', proposal['scenario_id'])
        if proposal['scenario_revision'] != body.expected_revision:
            raise HTTPException(409, '建议基于旧场景，请重新生成建议')
        scenario = patch_scenario(proposal['scenario_id'], body.expected_revision, RealScenarioInput(**proposal['data']))
        proposal['applied'] = True
        store.put('proposal', proposal)
        task = required('task', proposal['task_id'])
        for message in task['messages']:
            if (message.get('proposal') or {}).get('id') == proposal['id']:
                message['proposal'] = proposal
        store.put('task', task)
        return scenario


@app.post('/api/v1/simulations', status_code=201)
def create_simulation(body: SimulationCreate):
    plan = required('plan', body.plan_id)
    if not plan['metrics']['completed_orders'] or not plan['metrics']['finish_seconds']:
        raise HTTPException(409, '当前方案没有可配送路线，请先调整载重、续航或时间窗口并重新生成方案')
    return store.put('simulation', simulation.create(plan))


@app.post('/api/v1/simulations/{id}/commands')
def control_simulation(id: str, body: SimulationCommand):
    with store.lock:
        sim = required('simulation', id)
        plan = required('plan', sim['plan_id'])
        if body.command == 'play' and not plan['metrics']['completed_orders']:
            raise HTTPException(409, '当前方案没有可配送路线，请修改配送数据并重新生成方案')
        if body.command == 'play' and simulation.elapsed(sim) >= plan['metrics']['finish_seconds']:
            raise HTTPException(409, '配送仿真已结束，请先重置')
        target = min(body.elapsed_seconds, plan['metrics']['finish_seconds']) if body.elapsed_seconds is not None else None
        store.put('simulation', simulation.command(sim, body.command, body.speed, target))
        return simulation.state(sim, plan)


@app.get('/api/v1/simulations/{id}/state')
def get_simulation(id: str):
    sim = required('simulation', id)
    return simulation.state(sim, required('plan', sim['plan_id']))


@app.get('/api/v1/integrations/status')
def get_integrations():
    return {'items': [{'id': 'local_ai', 'name': '调度 AI', 'status': 'connected', 'description': '本地意图识别、约束诊断与路线优化'}, {'id': 'osm', 'name': '公开地图与道路', 'status': 'configured', 'description': 'OpenStreetMap · Leaflet · Photon · OSRM'}]+integration_status()}


@app.post('/api/v1/integrations/{kind}/check')
async def check_integration(kind: str):
    env = {'llm': 'LLM_BASE_URL', 'map': 'MAP_BASE_URL', 'vehicle': 'VEHICLE_BASE_URL'}
    if kind not in env:
        raise HTTPException(404, '未知服务')
    url = os.getenv(env[kind])
    if not url:
        return {'status': 'unconfigured', 'message': '未配置此服务'}
    try:
        gateway = ExternalGateway(url, os.getenv(f'{kind.upper()}_API_KEY', ''))
        await gateway.request('GET', '/models' if kind == 'llm' else '/vehicles' if kind == 'vehicle' else '/health')
        return {'status': 'connected', 'message': '连接检查通过'}
    except Exception:
        return {'status': 'error', 'message': '连接失败，请检查后端服务地址、凭证与网络'}


@app.post('/api/v1/integrations/map/matrix')
async def external_matrix(request: Request):
    if not os.getenv('MAP_BASE_URL'):
        raise HTTPException(503, '自定义地图网关未配置；工作台可使用 OSRM 真实道路')
    payload = await request.json()
    points = payload.get('points')
    if not isinstance(points, list) or not 1 <= len(points) <= 120:
        raise HTTPException(422, 'points 需要包含 1～120 个坐标')
    try:
        return await MapGateway(os.environ['MAP_BASE_URL'], os.getenv('MAP_API_KEY', '')).matrix(points, payload.get('coordinate_system', 'WGS84'))
    except Exception:
        raise HTTPException(502, '地图网关调用失败')


@app.get('/api/v1/integrations/vehicle/vehicles')
async def external_vehicles():
    if not os.getenv('VEHICLE_BASE_URL'):
        raise HTTPException(503, '车辆网关未配置，请在配送数据中录入车辆')
    try:
        return await VehicleGateway(os.environ['VEHICLE_BASE_URL'], os.getenv('VEHICLE_API_KEY', '')).vehicles()
    except Exception:
        raise HTTPException(502, '车辆平台调用失败')


dist = Path(__file__).resolve().parents[1] / 'frontend/dist'
if dist.exists():
    app.mount('/', StaticFiles(directory=dist, html=True), name='frontend')
