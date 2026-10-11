import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {readFileSync} from 'node:fs';

const password='Disposable-QA-2026';
async function isolateTiles(page:Page){
  // Public OSM tiles prohibit headless pan/zoom scans. Browser tests use a test-only tile.
  await page.route('https://tile.openstreetmap.org/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eef2ed"/></svg>'}));
}
async function register(page:Page){
  const username=`qa_${Date.now()}_${Math.floor(Math.random()*9999)}`;
  await page.goto('/');await page.getByRole('button',{name:'创建账号',exact:true}).click();
  await page.getByLabel('姓名或昵称').fill('浏览器测试');await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);await page.getByRole('button',{name:'注册并进入',exact:true}).click();await expect(page.getByRole('heading',{name:'调度助手',exact:true})).toBeVisible();
  return username;
}
async function coordinate(page:Page,lat:string,lon:string,name:string){await page.getByRole('button',{name:'输入坐标',exact:true}).click();await page.getByLabel('纬度 WGS84').fill(lat);await page.getByLabel('经度 WGS84').fill(lon);await page.getByRole('button',{name:'使用坐标',exact:true}).click();await page.getByLabel('地点名称',{exact:true}).fill(name);}
async function addOrder(page:Page,id:string,lat:string,lon:string,name:string){await page.getByLabel('订单编号',{exact:true}).fill(id);await page.getByLabel('货物重量（kg）').fill('12.5');await page.getByLabel('收货开始时间').fill('08:00');await page.getByLabel('收货截止时间').fill('12:00');await coordinate(page,lat,lon,name);await page.getByRole('button',{name:'添加订单',exact:true}).click();}
async function addVehicle(page:Page,id:string){await page.getByLabel('车辆编号',{exact:true}).fill(id);await page.getByLabel('车辆名称',{exact:true}).fill('测试车辆 '+id);await page.getByLabel('可用载重（kg）').fill('40');await page.getByLabel('可用续航（km）').fill('30');await page.getByLabel('出车费用（元）').fill('30');await page.getByLabel('每公里费用（元）').fill('1.2');
  if(id==='V01'){
    await page.getByLabel('可用续航（km）').fill('100000');await page.getByLabel('出车费用（元）').fill('200000');await page.getByRole('button',{name:'添加车辆',exact:true}).click();
    await expect(page.getByText('可用续航须大于 0，且不超过 500 km。',{exact:true})).toBeVisible();await expect(page.getByText('出车费用须为 0～10000 元，按每次出车填写。',{exact:true})).toBeVisible();
    await expect(page.getByLabel('可用续航（km）')).toBeFocused();await expect(page.getByLabel('出车费用（元）')).toHaveValue('200000');
    await page.getByLabel('可用续航（km）').fill('30');await page.getByLabel('出车费用（元）').fill('30');
  }
  await page.getByRole('button',{name:'添加车辆',exact:true}).click();}

test('registration, real-road scheduling, AI fault proposal, comparison and preview',async({page})=>{
  test.setTimeout(180000);await isolateTiles(page);const username=await register(page);
  await expect(page.getByText('本地工作空间')).toHaveCount(0);await expect(page.getByText('模拟环境 · 无需付费 API')).toHaveCount(0);
  expect(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
  await page.getByRole('button',{name:'新建配送任务',exact:true}).filter({visible:true}).click();await page.getByRole('button',{name:'录入配送数据',exact:true}).click();
  await page.getByRole('button',{name:'加载真实道路',exact:true}).click();await expect(page.getByRole('alert')).toContainText('至少一个订单');
  await page.getByLabel('出发日期与时间').fill('2026-10-12T08:00');await coordinate(page,'30.252','120.158','验收配送站');
  await page.getByLabel('配送城市').fill('杭州');
  await page.getByRole('tab',{name:'订单 (0)',exact:true}).click();await addOrder(page,'QA01','30.259','120.164','验收收货点一');await addOrder(page,'QA02','30.253','120.173','验收收货点二');
  await page.getByRole('tab',{name:'车辆 (0)',exact:true}).click();await addVehicle(page,'V01');await addVehicle(page,'V02');
  await page.getByRole('button',{name:'加载真实道路',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0,{timeout:60000});
  await expect(page.getByText('已加载 2 个订单')).toBeVisible();
  await page.getByRole('button',{name:'生成方案',exact:true}).filter({visible:true}).first().click();await expect(page.locator('.metric-strip')).toContainText('2/2',{timeout:90000});
  await expect(page.locator('.leaflet-overlay-pane path')).not.toHaveCount(0);
  await page.getByRole('button',{name:'解释方案',exact:true}).click();await expect(page.getByText('路线依据 OSRM 真实道路距离',{exact:false})).toBeVisible({timeout:30000});
  await page.getByRole('button',{name:'对比基准',exact:true}).filter({visible:true}).first().click();await expect(page.getByRole('columnheader',{name:'就近基准'})).toBeVisible({timeout:90000});
  await page.getByRole('button',{name:'地图查看优化方案',exact:true}).click();await page.getByLabel('预演播放倍速').selectOption('120');await page.getByRole('button',{name:'播放路线预演',exact:true}).click();await expect(page.getByRole('button',{name:'暂停路线预演',exact:true})).toBeVisible();
  const marker=page.locator('.map-marker-wrapper:has(.car)').first();await expect(marker).toBeVisible();const before=await marker.getAttribute('style');await expect.poll(()=>marker.getAttribute('style')).not.toBe(before);
  await expect.poll(async()=>Number(await page.getByRole('progressbar',{name:'路线预演进度'}).getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('button',{name:'暂停路线预演',exact:true}).click();await expect(page.getByRole('button',{name:'播放路线预演',exact:true})).toBeVisible();
  await page.getByLabel('跳转预演时间').focus();await page.getByLabel('跳转预演时间').press('End');await expect(page.getByRole('button',{name:'重新播放路线预演',exact:true})).toBeVisible();await expect(page.locator('.sim-footer')).toContainText('2/2');
  await page.getByRole('button',{name:'重新播放路线预演',exact:true}).click();await expect(page.getByRole('button',{name:'暂停路线预演',exact:true})).toBeVisible();await page.getByRole('button',{name:'暂停路线预演',exact:true}).click();await page.getByRole('button',{name:'重置路线预演',exact:true}).click();
  await page.getByLabel('向调度助手发送消息').fill('V01 故障，请重新调度');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByRole('button',{name:'应用重调度建议',exact:true})).toBeVisible({timeout:30000});
  await page.getByRole('button',{name:'应用重调度建议',exact:true}).click();await expect(page.getByText('数据已更新，当前方案为历史版本。请重新生成方案。')).toBeVisible();
  await page.reload();await expect(page.getByText('已应用',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'退出登录',exact:true}).filter({visible:true}).click();await expect(page.getByRole('heading',{name:'欢迎回来'})).toBeVisible();
  await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByText('已应用',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'配送方案',exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('button',{name:'配送数据',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
});

test('accessibility, form validation, retry and narrow viewport',async({page})=>{
  test.setTimeout(120000);await isolateTiles(page);await page.goto('/');
  await page.screenshot({path:'../artifacts/login-v2.png',fullPage:true});
  let results=await new AxeBuilder({page}).analyze();expect(results.violations).toEqual([]);
  await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByLabel('用户名',{exact:true})).toHaveAttribute('aria-invalid','true');
  await register(page);await expect(page.getByRole('button',{name:'生成方案',exact:true})).toBeDisabled();
  results=await new AxeBuilder({page}).analyze();expect(results.violations).toEqual([]);
  await page.getByRole('button',{name:'录入配送数据',exact:true}).click();await page.getByLabel('配送城市').fill('南京');await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await page.getByRole('button',{name:'录入配送数据',exact:true}).click();await expect(page.getByLabel('配送城市')).toHaveValue('南京');
  results=await new AxeBuilder({page}).analyze();expect(results.violations).toEqual([]);
  await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await page.getByLabel('向调度助手发送消息').fill('检查订单风险');
  await page.route('**/api/v1/tasks/*/messages',route=>route.abort());await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByRole('alert')).toContainText('已保留当前内容');await expect(page.getByLabel('向调度助手发送消息')).toHaveValue('检查订单风险');
  await page.unroute('**/api/v1/tasks/*/messages');await page.getByRole('button',{name:'发送消息',exact:true}).click();await expect(page.getByText('请先录入配送站、订单和车辆',{exact:false})).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);await page.getByRole('button',{name:'配送方案',exact:true}).click();results=await new AxeBuilder({page}).analyze();expect(results.violations).toEqual([]);
  await page.screenshot({path:'../artifacts/mobile-v2.png',fullPage:true});
});

test('national map, data guide and adjustable persistent columns',async({page})=>{
  await isolateTiles(page);await register(page);
  const mapLink=page.getByRole('link',{name:'在 OpenStreetMap 打开当前位置'});
  expect(Number((await mapLink.getAttribute('href'))!.split('#map=')[1].split('/')[0])).toBeLessThanOrEqual(5);
  await page.getByRole('button',{name:'全国视图',exact:true}).click();
  await page.getByRole('button',{name:'数据说明',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('不是购车价');await expect(page.getByRole('dialog')).toContainText('包含配送后返站');await page.getByRole('button',{name:'关闭窗口',exact:true}).click();
  const sidebar=page.getByRole('separator',{name:'调整任务栏宽度'}), chat=page.getByRole('separator',{name:'调整对话栏宽度'});
  const initial=Number(await sidebar.getAttribute('aria-valuenow'));const rect=(await sidebar.boundingBox())!;
  await page.mouse.move(rect.x+rect.width/2,rect.y+100);await page.mouse.down();await page.mouse.move(rect.x+rect.width/2+60,rect.y+100);await page.mouse.up();await expect(sidebar).toHaveAttribute('aria-valuenow',String(initial+60));
  await chat.focus();const initialChat=Number(await chat.getAttribute('aria-valuenow'));await chat.press('ArrowRight');await expect(chat).toHaveAttribute('aria-valuenow',String(initialChat+10));
  await page.reload();await expect(sidebar).toHaveAttribute('aria-valuenow',String(initial+60));await expect(chat).toHaveAttribute('aria-valuenow',String(initialChat+10));
  await page.getByRole('button',{name:'恢复默认栏宽',exact:true}).click();await expect(sidebar).toHaveAttribute('aria-valuenow','220');await expect(chat).toHaveAttribute('aria-valuenow','390');
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.setViewportSize({width:390,height:844});await expect(sidebar).not.toBeVisible();await expect(chat).not.toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('infeasible data explains why preview cannot play',async({page})=>{
  await isolateTiles(page);await register(page);
  const input=JSON.parse(readFileSync('../docs/example-input.json','utf-8'));input.orders.forEach((o:{weight_kg:number})=>o.weight_kg=100);
  const task=await (await page.request.post('/api/v1/tasks',{data:{name:'约束不足验收'}})).json();
  const created=await page.request.post(`/api/v1/tasks/${task.id}/scenarios`,{data:input});expect(created.status()).toBe(201);
  await page.reload();await expect(page.getByText('已加载 2 个订单',{exact:false})).toBeVisible();await page.getByRole('button',{name:'生成方案',exact:true}).filter({visible:true}).first().click();
  await expect(page.locator('.metric-strip')).toContainText('0/2',{timeout:90000});await expect(page.locator('.infeasible-notice')).toContainText('100 kg');await expect(page.locator('.infeasible-notice')).toContainText('40 kg');
  await expect(page.getByRole('button',{name:'播放路线预演',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'播放预演',exact:true})).toBeDisabled();await page.getByRole('button',{name:'修改配送数据',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
});
