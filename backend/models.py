from typing import Literal
from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class TaskCreate(StrictModel):
    name: str = Field(default='今日城市配送', min_length=1, max_length=80)


class Credentials(StrictModel):
    username: str = Field(min_length=3, max_length=40, pattern=r'^[A-Za-z0-9_\u4e00-\u9fff]+$')
    password: str = Field(min_length=10, max_length=128)


class Registration(Credentials):
    display_name: str = Field(min_length=1, max_length=40)


class Location(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    address: str = Field(default='', max_length=300)
    lat: float = Field(ge=-85, le=85, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    source: Literal['map_pick', 'photon', 'user_coordinates'] = 'user_coordinates'


class OrderInput(StrictModel):
    id: str = Field(min_length=1, max_length=40, pattern=r'^[A-Za-z0-9_-]+$')
    location: Location
    weight_kg: float = Field(ge=.001, le=500, allow_inf_nan=False)
    window_start: int = Field(ge=0, le=86400)
    window_end: int = Field(gt=0, le=86400)
    service_seconds: int = Field(default=120, ge=0, le=3600)


class VehicleInput(StrictModel):
    id: str = Field(min_length=1, max_length=40, pattern=r'^[A-Za-z0-9_-]+$')
    name: str = Field(min_length=1, max_length=80)
    capacity_kg: float = Field(ge=.001, le=500, allow_inf_nan=False)
    range_km: float = Field(gt=0, le=500, allow_inf_nan=False)
    fixed_cost_cents: int = Field(default=0, ge=0, le=1000000)
    cost_per_km_cents: int = Field(default=0, ge=0, le=100000)
    available: bool = True


class RealScenarioInput(StrictModel):
    city: str = Field(default='杭州', min_length=1, max_length=80)
    start_time: datetime
    horizon_seconds: int = Field(default=28800, ge=600, le=86400)
    depot: Location
    orders: list[OrderInput] = Field(min_length=1, max_length=50)
    vehicles: list[VehicleInput] = Field(min_length=1, max_length=15)

    @field_validator('start_time')
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None:
            raise ValueError('出发时间必须包含时区')
        return value

    @model_validator(mode='after')
    def consistency(self):
        for rows in (self.orders, self.vehicles):
            ids = [row.id for row in rows]
            if len(set(ids)) != len(ids):
                raise ValueError('订单编号与车辆编号各自必须唯一')
        if not any(v.available for v in self.vehicles):
            raise ValueError('至少需要一辆可用车辆')
        for o in self.orders:
            if o.window_start + o.service_seconds > o.window_end or o.window_end > self.horizon_seconds:
                raise ValueError(f'{o.id} 的交付窗口或耗时超出工作时段')
        return self


class RealScenarioPatch(StrictModel):
    expected_revision: int = Field(ge=1)
    data: RealScenarioInput


class SolveRequest(StrictModel):
    scenario_id: str
    expected_revision: int = Field(ge=1)
    algorithm: Literal['optimized', 'baseline'] = 'optimized'
    time_limit_seconds: int = Field(default=4, ge=1, le=20)


class MessageRequest(StrictModel):
    content: str = Field(min_length=1, max_length=2000)
    scenario_revision: int | None = None


class ApplyProposal(StrictModel):
    expected_revision: int = Field(ge=1)


class SimulationCreate(StrictModel):
    plan_id: str


class SimulationCommand(StrictModel):
    command: Literal['play', 'pause', 'reset', 'speed', 'seek']
    speed: int = Field(default=10, ge=1, le=120)
    elapsed_seconds: float | None = Field(default=None, ge=0, le=86400, allow_inf_nan=False)

    @model_validator(mode='after')
    def seek_requires_time(self):
        if self.command == 'seek' and self.elapsed_seconds is None:
            raise ValueError('跳转预演需要指定 elapsed_seconds')
        return self
