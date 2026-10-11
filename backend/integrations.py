"""Server-only external API gateways. No credentials are returned to the browser."""
import json
import os
import httpx


class ExternalGateway:
    def __init__(self, base_url, api_key='', transport=None):
        if not base_url.startswith(('http://', 'https://')):
            raise ValueError('外部服务地址必须是 http(s) URL')
        self.base_url = base_url.rstrip('/')
        self.api_key = api_key
        self.transport = transport

    async def request(self, method, path, payload=None):
        headers = {'Authorization': f'Bearer {self.api_key}'} if self.api_key else {}
        async with httpx.AsyncClient(timeout=15, transport=self.transport, follow_redirects=False) as client:
            response = await client.request(method, self.base_url+path, headers=headers, json=payload)
            response.raise_for_status()
            return response.json()


class MapGateway(ExternalGateway):
    async def matrix(self, points, coordinate_system):
        return await self.request('POST', '/routing/matrix', {'points': points, 'coordinate_system': coordinate_system, 'vehicle_type': 'unmanned_delivery'})

    async def route(self, origin, destination, coordinate_system):
        return await self.request('POST', '/routing/route', {'origin': origin, 'destination': destination, 'coordinate_system': coordinate_system, 'vehicle_type': 'unmanned_delivery'})


class VehicleGateway(ExternalGateway):
    async def vehicles(self):
        return await self.request('GET', '/vehicles')

    async def telemetry(self, vehicle_id):
        return await self.request('GET', f'/vehicles/{vehicle_id}/telemetry')

    async def dispatch(self, task, idempotency_key):
        return await self.request('POST', '/missions', {**task, 'idempotency_key': idempotency_key})


class LLMGateway(ExternalGateway):
    async def reply(self, content, scenario):
        system = '你是城市配送调度助手。仅使用给定订单与车辆事实，不能编造效果或执行任务。返回JSON对象：text为中文说明，disable_vehicle_ids为建议停用的已有车辆编号列表（无建议时null）。必须保留至少一辆车。没有真实交通数据，不能声称实时路况。'
        context = {'instruction': content, 'orders': scenario['orders'] if scenario else [], 'vehicles': scenario['vehicles'] if scenario else []}
        response = await self.request('POST', '/chat/completions', {'model': os.getenv('LLM_MODEL', 'local-model'), 'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': json.dumps(context, ensure_ascii=False)}], 'response_format': {'type': 'json_object'}, 'temperature': .2})
        result = json.loads(response['choices'][0]['message']['content'])
        if not isinstance(result.get('text'), str) or len(result['text']) > 8000:
            raise ValueError('模型返回格式无效')
        ids = result.get('disable_vehicle_ids')
        if result.get('params') is not None:
            raise ValueError('模型建议含不允许的字段')
        if ids is not None:
            known = {v['id'] for v in scenario['vehicles']} if scenario else set()
            if not isinstance(ids, list) or not all(isinstance(v, str) for v in ids) or not set(ids) <= known or len(set(ids)) >= len(known):
                raise ValueError('模型车辆建议无效')
        return result


def integration_status():
    return [{'id': key, 'name': name, 'status': 'configured' if os.getenv(env) else 'unconfigured', 'description': '已配置，需检查连接' if os.getenv(env) else fallback} for key, name, env, fallback in [('llm','扩展大模型','LLM_BASE_URL','可连接免费的本地模型服务'),('vehicle','车辆平台','VEHICLE_BASE_URL','可接入车辆列表与遥测数据')]]
