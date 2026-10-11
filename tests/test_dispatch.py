import asyncio
import copy
import json
import time
import os
import subprocess
import sys
from threading import Event

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.legacy_fixture import ScenarioConfig, generate
from backend.scenario import RoadNetwork
from backend.optimizer import solve, validate_plan
from backend.integrations import LLMGateway, MapGateway, VehicleGateway
from backend import simulation
from backend.store import Store
from backend.auth import Auth
from backend.roads import RoadService, prepare, RoadServiceError, enrich_plan
from backend.models import RealScenarioInput
from backend import ai
import backend.main as server


def test_import_does_not_interrupt_another_process(tmp_path):
    db = Store(tmp_path / 'import.sqlite')
    job = {'id': 'active', 'status': 'running', 'stage': '获取真实道路路线 3/3'}
    db.put('job', job)
    subprocess.run([sys.executable, '-c', 'import backend.main'],
                   env={**os.environ, 'DISPATCH_DB': str(db.path)}, check=True, timeout=30)
    assert db.get('job', 'active') == job


def test_startup_recovers_orphans_and_preserves_results(tmp_path, monkeypatch):
    db = Store(tmp_path / 'restart.sqlite')
    for status in ('queued', 'running', 'succeeded'):
        db.put('job', {'id': status, 'status': status, 'stage': '原阶段'})
    monkeypatch.setattr(server, 'store', db)
    with TestClient(server.app):
        assert db.get('job', 'queued')['status'] == 'failed'
        assert db.get('job', 'running')['stage'] == '服务重启，计算已中断，请重新计算'
        assert db.get('job', 'succeeded')['status'] == 'succeeded'


@pytest.fixture
def client(tmp_path, monkeypatch):
    db = Store(tmp_path / 'test.sqlite')
    monkeypatch.setattr(server, 'store', db)
    monkeypatch.setattr(server, 'auth', Auth(db))
    monkeypatch.setattr(server, 'roads', RoadService(db, httpx.MockTransport(road_response)))
    monkeypatch.setattr(server, 'cancellations', {})
    monkeypatch.delenv('LLM_BASE_URL', raising=False)
    browser = TestClient(server.app)
    response = browser.post('/api/v1/auth/register', json={'username':'test_dispatch','display_name':'测试账号','password':'test-password-2026'})
    assert response.status_code == 201
    return browser


def real_input():
    location = {'name':'测试配送站','address':'测试输入','lat':30.252,'lon':120.158,'source':'user_coordinates'}
    return {'city':'杭州','start_time':'2026-10-12T08:00:00+08:00','horizon_seconds':28800,'depot':location,'orders':[{'id':'TEST01','location':{**location,'name':'测试点','lat':30.259,'lon':120.164},'weight_kg':12.5,'window_start':0,'window_end':7200,'service_seconds':120}],'vehicles':[{'id':f'V{i:02}','name':f'测试车辆{i}','capacity_kg':100,'range_km':45,'fixed_cost_cents':3000,'cost_per_km_cents':120} for i in range(1,6)]}


def road_response(request):
    # Explicit fake transport isolates tests from public provider load.
    if '/table/' in request.url.path:
        return httpx.Response(200,json={'code':'Ok','distances':[[0,1400],[1600,0]],'durations':[[0,160],[180,0]],'sources':[{'location':[120.158,30.252]},{'location':[120.164,30.259]}]})
    if '/route/' in request.url.path:
        first=request.url.path.split('/')[-1].split(';')[0]
        forward=first.startswith('120.158')
        points=[[120.158,30.252],[120.16,30.253],[120.162,30.255],[120.164,30.259]]
        return httpx.Response(200,json={'code':'Ok','routes':[{'distance':1400 if forward else 1600,'duration':160 if forward else 180,'geometry':{'type':'LineString','coordinates':points if forward else list(reversed(points))}}]})
    return httpx.Response(200,json={'features':[]})


def scenario(count=12, **params):
    return generate(ScenarioConfig(order_count=count, **params).model_dump(), 'test-task')


def wait_job(client, id):
    deadline = time.monotonic()+15
    while time.monotonic() < deadline:
        job = client.get(f'/api/v1/jobs/{id}').json()
        if job['status'] not in ('queued', 'running'):
            return job
        time.sleep(.05)
    raise AssertionError('job timeout')


def setup_scene(client):
    task = client.post('/api/v1/tasks', json={'name': '测试配送'}).json()
    response = client.post(f'/api/v1/tasks/{task["id"]}/scenarios', json=real_input())
    assert response.status_code == 201, response.text
    scene = response.json()
    return task, scene


def test_generation_reproducible_and_directed():
    a, b = scenario(), scenario()
    for field in ['nodes', 'edges', 'orders', 'vehicles']:
        assert a[field] == b[field]
    assert any(not e['allowed'] for e in a['edges'])
    assert any(e['allowed'] and not next(other for other in a['edges'] if other['from'] == e['to'] and other['to'] == e['from'])['allowed'] for e in a['edges'])
    road = RoadNetwork(a)
    for order in a['orders']:
        assert road.route(a['depot_node'], order['node_id'])['nodes']
        assert road.route(order['node_id'], a['depot_node'])['nodes']


@pytest.mark.parametrize('algorithm', ['baseline', 'optimized'])
def test_solver_covers_every_order_once_and_respects_return(algorithm):
    scene = scenario()
    plan = solve(scene, algorithm, 1, Event())
    assert plan['validation']['valid']
    ids = [id for route in plan['routes'] for id in route['order_ids']]
    assert len(ids) == len(set(ids))
    assert set(ids) | {u['order_id'] for u in plan['unassigned']} == {o['id'] for o in scene['orders']}
    vehicles = {v['id']: v for v in scene['vehicles']}
    for route in plan['routes']:
        assert route['distance_m'] <= vehicles[route['vehicle_id']]['range_m']
        assert route['load_kg'] <= vehicles[route['vehicle_id']]['capacity_kg']
        assert route['legs'][-1]['to'] == scene['depot_node']


def test_infeasible_orders_remain_in_denominator():
    scene = scenario(capacity_kg=5, range_km=2)
    plan = solve(scene, 'optimized', 1, Event())
    assert plan['outcome'] in ('partial', 'infeasible')
    assert plan['metrics']['completion_rate'] == plan['metrics']['completed_orders']/12
    assert len(plan['unassigned'])+plan['metrics']['completed_orders'] == 12


def test_independent_validation_rejects_forged_route():
    scene = scenario()
    plan = solve(scene, 'baseline', 1, Event())
    tampered = copy.deepcopy(plan['routes'])
    tampered[0]['distance_m'] = 0
    assert not validate_plan(scene, tampered)['valid']
    tampered = copy.deepcopy(plan['routes'])
    tampered[1]['order_ids'] += tampered[0]['order_ids']
    assert not validate_plan(scene, tampered)['valid']


def test_revision_idempotency_and_plan_snapshot(client):
    task, scene = setup_scene(client)
    payload = {'scenario_id': scene['id'], 'expected_revision': 1, 'time_limit_seconds': 1}
    first = client.post('/api/v1/optimization-jobs', json=payload, headers={'Idempotency-Key':'same-request'})
    assert first.status_code == 202
    repeat = client.post('/api/v1/optimization-jobs', json=payload, headers={'Idempotency-Key':'same-request'})
    assert repeat.json()['id'] == first.json()['id']
    changed = copy.deepcopy(scene['input'])
    changed['vehicles'] = changed['vehicles'][:3]
    assert client.patch(f'/api/v1/scenarios/{scene["id"]}', json={'expected_revision':1,'data':changed}).status_code == 200
    assert client.patch(f'/api/v1/scenarios/{scene["id"]}', json={'expected_revision':1,'data':changed}).status_code == 409
    result = wait_job(client, first.json()['id'])
    assert result['status'] == 'succeeded'
    plan = client.get(f'/api/v1/plans/{result["result_id"]}').json()
    assert plan['scenario_revision'] == 1
    assert len(plan['snapshot']['vehicles']) == 5
    assert client.get(f'/api/v1/tasks/{task["id"]}').json()['plan_ids']
    assert client.post('/api/v1/optimization-jobs', json=payload, headers={'Idempotency-Key':'same-request'}).json()['id'] == first.json()['id']


def test_comparison_same_snapshot_and_cancellation(client):
    _, scene = setup_scene(client)
    payload = {'scenario_id': scene['id'], 'expected_revision': 1, 'time_limit_seconds': 1}
    job = client.post('/api/v1/comparison-jobs', json=payload).json()
    result = wait_job(client, job['id'])
    assert result['status'] == 'succeeded'
    comparison = client.get(f'/api/v1/comparisons/{result["result_id"]}').json()
    assert comparison['baseline']['snapshot'] == comparison['optimized']['snapshot']
    assert comparison['comparable_cost'] == (comparison['baseline']['metrics']['completed_orders'] == comparison['optimized']['metrics']['completed_orders'])
    pending = client.post('/api/v1/optimization-jobs', json={**payload,'time_limit_seconds':5}).json()
    client.post(f'/api/v1/jobs/{pending["id"]}/cancel')
    cancelled = wait_job(client, pending['id'])
    assert cancelled['status'] == 'cancelled'
    assert cancelled['result_id'] is None


def test_chat_proposal_requires_application_and_revision(client):
    task, scene = setup_scene(client)
    reply = client.post(f'/api/v1/tasks/{task["id"]}/messages',json={'content':'V01 故障，请重新调度','scenario_revision':1}).json()
    assert reply['source'] == 'local_ai'
    assert reply['ai']['intent'] == 'fault'
    assert len(client.get(f'/api/v1/scenarios/{scene["id"]}').json()['vehicles']) == 5
    applied = client.post(f'/api/v1/proposals/{reply["proposal"]["id"]}/apply',json={'expected_revision':1})
    assert applied.status_code == 200
    assert len(applied.json()['vehicles']) == 4
    assert next(m for m in client.get(f'/api/v1/tasks/{task["id"]}').json()['messages'] if m.get('proposal'))['proposal']['applied']
    assert client.post(f'/api/v1/tasks/{task["id"]}/messages',json={'content':'生成方案','scenario_revision':1}).status_code == 409


def test_simulation_wait_delivery_pause_and_reset(monkeypatch):
    scene = scenario(1)
    scene['orders'][0]['window_start'] = 3600
    scene['orders'][0]['window_end'] = 7200
    plan = solve(scene,'baseline',1,Event())
    simulated = simulation.create(plan)
    stop = plan['routes'][0]['stops'][0]
    simulated['elapsed'] = stop['arrival']+.1
    state = simulation.state(simulated,plan)
    assert state['vehicles'][0]['status'] == '等待收货'
    assert state['delivered_count'] == 0
    simulated['elapsed'] = stop['departure']+.1
    assert simulation.state(simulated,plan)['delivered_count'] == 1
    simulation.command(simulated,'reset',10)
    assert simulation.state(simulated,plan)['elapsed_seconds'] == 0
    simulation.command(simulated,'play',10)
    simulation.command(simulated,'pause',10)
    first = simulation.state(simulated,plan)['elapsed_seconds']
    time.sleep(.02)
    assert simulation.state(simulated,plan)['elapsed_seconds'] == first


def test_empty_plan_explains_capacity_range_and_cannot_play(client):
    task = client.post('/api/v1/tasks', json={'name':'不可行配送'}).json()
    data = real_input()
    data['orders'][0]['weight_kg'] = 100
    for vehicle in data['vehicles']:
        vehicle.update(capacity_kg=40, range_km=1)
    scene = client.post(f'/api/v1/tasks/{task["id"]}/scenarios', json=data).json()
    job = client.post('/api/v1/optimization-jobs',json={'scenario_id':scene['id'],'expected_revision':1,'time_limit_seconds':1}).json()
    result = wait_job(client, job['id'])
    plan = client.get(f'/api/v1/plans/{result["result_id"]}').json()
    assert plan['metrics']['completed_orders'] == 0
    reason = plan['unassigned'][0]['reason']
    assert '100 kg' in reason and '40 kg' in reason and '3.00 km' in reason and '1 km' in reason
    response = client.post('/api/v1/simulations',json={'plan_id':plan['id']})
    assert response.status_code == 409 and '没有可配送路线' in response.text


def test_real_road_preview_seek_pause_complete_and_reset(client):
    _, scene = setup_scene(client)
    job = client.post('/api/v1/optimization-jobs',json={'scenario_id':scene['id'],'expected_revision':1,'time_limit_seconds':1}).json()
    result = wait_job(client,job['id'])
    plan = client.get(f'/api/v1/plans/{result["result_id"]}').json()
    sim = client.post('/api/v1/simulations',json={'plan_id':plan['id']}).json()
    endpoint = f'/api/v1/simulations/{sim["id"]}/commands'
    assert client.post(endpoint,json={'command':'seek'}).status_code == 422
    midway = client.post(endpoint,json={'command':'seek','elapsed_seconds':80}).json()
    car = next(v for v in midway['vehicles'] if v['status']=='行驶中')
    assert 120.158 < car['x'] < 120.164 and 30.252 < car['y'] < 30.259
    time.sleep(.02)
    assert client.get(f'/api/v1/simulations/{sim["id"]}/state').json()['elapsed_seconds'] == 80
    end = client.post(endpoint,json={'command':'seek','elapsed_seconds':86400}).json()
    assert end['status'] == 'completed' and end['delivered_count'] == 1
    assert end['elapsed_seconds'] == plan['metrics']['finish_seconds']
    reset = client.post(endpoint,json={'command':'reset'}).json()
    assert reset['elapsed_seconds'] == 0 and reset['delivered_count'] == 0


def test_validation_and_missing_services(client):
    assert client.post('/api/v1/tasks',json={'name':'','unknown':True}).status_code == 422
    assert client.get('/api/v1/tasks/missing').status_code == 404
    assert client.get('/api/v1/integrations/vehicle/vehicles').status_code == 503
    assert client.post('/api/v1/integrations/llm/check').json()['status'] == 'unconfigured'


def test_external_gateway_contracts_and_model_whitelist():
    seen=[]
    def handler(request):
        seen.append(request)
        if request.url.path.endswith('/chat/completions'):
            return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'text':'建议停用V01','disable_vehicle_ids':['V01']})}}]})
        return httpx.Response(200,json={'items':[]})
    transport=httpx.MockTransport(handler)
    async def run():
        assert (await LLMGateway('https://example.test/v1','test-key',transport).reply('V01故障',scenario()))['disable_vehicle_ids'] == ['V01']
        await MapGateway('https://example.test','test-key',transport).matrix([{'x':1,'y':2}],'WGS84')
        await VehicleGateway('https://example.test','test-key',transport).vehicles()
    asyncio.run(run())
    assert seen[0].headers['Authorization'] == 'Bearer test-key'
    assert seen[1].url.path == '/routing/matrix'
    def invalid(request):
        return httpx.Response(200,json={'choices':[{'message':{'content':json.dumps({'text':'执行','params':{'execute_code':'bad'}})}}]})
    with pytest.raises(ValueError):
        asyncio.run(LLMGateway('https://example.test',transport=httpx.MockTransport(invalid)).reply('test',scenario()))


def test_auth_sessions_and_account_isolation(client):
    task, scene = setup_scene(client)
    anonymous = TestClient(server.app)
    assert anonymous.get('/api/v1/tasks').status_code == 401
    assert anonymous.post('/api/v1/auth/register',json={'username':'other_user','display_name':'另一个账号','password':'another-password'}).status_code == 201
    assert anonymous.get('/api/v1/tasks').json()['total'] == 0
    assert anonymous.get(f'/api/v1/tasks/{task["id"]}').status_code == 404
    assert anonymous.get(f'/api/v1/scenarios/{scene["id"]}').status_code == 404
    assert anonymous.post('/api/v1/optimization-jobs',json={'scenario_id':scene['id'],'expected_revision':1}).status_code == 404
    assert client.post('/api/v1/auth/register',json={'username':'TEST_DISPATCH','display_name':'重复','password':'test-password-2026'}).status_code == 409
    assert client.post('/api/v1/tasks',json={},headers={'Origin':'https://evil.example'}).status_code == 403
    response=client.post('/api/v1/auth/logout')
    assert response.status_code == 200 and client.get('/api/v1/auth/me').status_code == 401
    assert client.post('/api/v1/auth/login',json={'username':'test_dispatch','password':'bad-password'}).status_code == 401
    login=client.post('/api/v1/auth/login',json={'username':'test_dispatch','password':'test-password-2026'})
    assert login.status_code == 200 and 'HttpOnly' in login.headers['set-cookie']
    assert 'password' not in login.text
    assert client.get(f'/api/v1/tasks/{task["id"]}').status_code == 200


def test_real_input_rejects_legacy_synthetic_and_invalid_windows(client):
    task=client.post('/api/v1/tasks',json={}).json()
    assert client.post(f'/api/v1/tasks/{task["id"]}/scenarios',json={'order_count':30}).status_code == 422
    data=real_input()
    data['orders'][0]['window_end']=10
    assert client.post(f'/api/v1/tasks/{task["id"]}/scenarios',json=data).status_code == 422
    data=real_input();data['orders'].append(data['orders'][0])
    assert client.post(f'/api/v1/tasks/{task["id"]}/scenarios',json=data).status_code == 422


def test_real_roads_cache_directional_geometry_decimal_weights(tmp_path):
    count=[]
    def counted(request):count.append(request);return road_response(request)
    road=RoadService(Store(tmp_path/'cache.sqlite'),httpx.MockTransport(counted))
    data=RealScenarioInput(**real_input())
    a=prepare(data,'test',road);b=prepare(data,'test',road)
    assert len(count)==1 and a['road_matrix']==b['road_matrix']
    network=RoadNetwork(a)
    assert network.route('depot','point_1')['meters']==1400
    assert network.route('point_1','depot')['meters']==1600
    plan=solve(a,'optimized',1,Event())
    enrich_plan(plan,road,Event(),lambda _:None)
    assert plan['metrics']['total_distance_m']==3000
    assert len(next(r for r in plan['routes'] if r['used'])['legs'][0]['geometry'])>=3
    assert validate_plan(a,plan['routes'])['valid']
    data.vehicles[0].capacity_kg=12
    assert not __import__('backend.optimizer',fromlist=['schedule']).schedule(a,{**a['vehicles'][0],'capacity_kg':12},['TEST01'],network)


@pytest.mark.parametrize('text,intent',[('请帮忙检查订单是否会超时','risk'),('V01坏了，需要重新安排任务','fault'),('麻烦解释一下车辆分配理由','explain'),('比较一下基准的里程','compare'),('帮忙优化配送路径','optimize'),('写一首春天的诗','help')])
def test_local_ai_unseen_intents(text,intent):
    assert ai.classify(text)['intent']==intent


def test_road_failure_is_not_synthetic_fallback(client,monkeypatch):
    def failed(points):raise RoadServiceError('真实道路服务不可用')
    monkeypatch.setattr(server.roads,'matrix',failed)
    task=client.post('/api/v1/tasks',json={}).json()
    response=client.post(f'/api/v1/tasks/{task["id"]}/scenarios',json=real_input())
    assert response.status_code==502
    assert client.get(f'/api/v1/tasks/{task["id"]}').json()['scenario_id'] is None


def test_load_uses_grams_without_float_boundary(tmp_path):
    from backend.optimizer import schedule
    s=prepare(RealScenarioInput(**real_input()),'test',RoadService(Store(tmp_path/'test.sqlite'),httpx.MockTransport(road_response)))
    s['orders'][0]['weight_kg']=.1
    second=copy.deepcopy(s['orders'][0]);second.update(id='TEST02',weight_kg=.2);s['orders'].append(second)
    v={**s['vehicles'][0],'capacity_kg':.3}
    route=schedule(s,v,['TEST01','TEST02'],RoadNetwork(s))
    assert route and route['load_kg']==.3
