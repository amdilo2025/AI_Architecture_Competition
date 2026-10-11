"""Free local ML intent classification + grounded dispatch diagnostics.

The classifier is a small trained intent classifier, not a general-purpose LLM.
Suggestions are immutable proposals and never execute vehicle changes directly.
"""
import re
from functools import lru_cache
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from .optimizer import schedule
from .scenario import RoadNetwork

CORPUS = {
    'optimize': ['生成配送方案', '安排今天的配送', '优化车辆路线', '帮我规划路线', '开始智能调度', '分配订单给车辆', '计算最优配送路径', '重新安排配送任务', '这些订单怎么分配', '规划车队配送', '重新计算方案', '开始路线优化'],
    'compare': ['对比基准方案', '比较优化前后效果', '和就近调度比较', '运行基准算法', '看看节省多少公里', '比较两种方案的成本', '验证调度效率', '做路线对比', '评估优化效果', '基准方法有何不同', '比较里程变化', '看看基准表现'],
    'risk': ['分析订单风险', '哪些订单可能超时', '检查时间窗口', '看看车辆运力够不够', '分析载重和续航', '哪些单配送不了', '检查订单可行性', '诊断任务约束', '帮我检查配送风险', '为什么订单无法完成', '检查运力缺口', '订单有什么问题'],
    'explain': ['解释当前方案', '为什么这样分配车辆', '说明这条路线的理由', '讲解调度结果', '帮我看方案逻辑', '解释订单分配原因', '这套方案怎么计算的', '告诉我每辆车的任务', '分析路线安排', '解释优化结果', '怎么看这个方案', '为什么要这样绕路'],
    'fault': ['车辆V01故障重新调度', 'V02停用重新安排', '配送车坏了重新分配任务', 'V03不可用重新规划', '车辆故障怎么办', '把V01移出可用车队', 'V02维修停用', '排除故障车辆', '停用车辆并重算', '车辆下线重新调度', '车无法使用', 'V01故障请重排订单'],
    'preview': ['播放配送预演', '查看配送执行过程', '开始路线播放', '看看车辆如何配送', '预演配送路线', '查看车辆行驶过程', '开始配送动画', '播放当前方案', '路线预演', '看看订单交付顺序', '查看地图上的车辆', '演示配送过程'],
    'help': ['你好', '谢谢', '今天天气如何', '帮我写一首诗', '我要吃什么', '你叫什么名字', '注册账号', '修改密码', '打开设置', '录入订单', '添加车辆', '搜索配送地址', '介绍一下功能', '您好有什么功能', '我想新增数据', '删除数据'],
}


@lru_cache(maxsize=1)
def classifier():
    texts, labels = [], []
    for label, phrases in CORPUS.items():
        for phrase in phrases:
            for prefix in ('', '请', '麻烦帮我'):
                texts.append(prefix+phrase)
                labels.append(label)
    model = make_pipeline(TfidfVectorizer(analyzer='char', ngram_range=(1, 4), sublinear_tf=True), LogisticRegression(C=12, max_iter=400, random_state=42))
    model.fit(texts, labels)
    return model


def classify(text):
    model = classifier()
    probabilities = model.predict_proba([text])[0]
    index = int(probabilities.argmax())
    # Unsupported input does not become an executable action.
    intent = str(model.classes_[index]) if float(probabilities[index]) >= .40 else 'help'
    return {'intent': intent, 'confidence': round(float(probabilities[index]), 3), 'model': 'char-TFIDF + LogisticRegression', 'training_examples': sum(len(p)*3 for p in CORPUS.values())}


def diagnose(scenario):
    road = RoadNetwork(scenario)
    risks = []
    for order in scenario['orders']:
        path = road.route(scenario['depot_node'], order['node_id'])
        feasible = any(schedule(scenario, v, [order['id']], road) for v in scenario['vehicles'])
        if not feasible:
            risks.append(f'{order["id"]}：即使单独配送也无法满足道路、时间窗、载重或返程续航约束')
        elif order['window_end']-max(path['seconds'], order['window_start'])-order['service_seconds'] < 900:
            risks.append(f'{order["id"]}：最早交付的时间余量不足 15 分钟，建议优先安排')
    weight = sum(o['weight_kg'] for o in scenario['orders'])
    capacity = sum(v['capacity_kg'] for v in scenario['vehicles'])
    if weight > capacity:
        risks.append(f'总货重 {weight:g} kg 超过单次车队载重 {capacity:g} kg，需要增加车辆或拆分任务')
    return f'检查了 {len(scenario["orders"])} 个订单、{len(scenario["vehicles"])} 辆可用车辆。'+ ('\n'+'\n'.join(risks) if risks else '\n未发现单订单不可行或明显的运力缺口。多订单组合仍需通过路线求解验证。')


def reply(text, scenario, plan=None):
    prediction = classify(text)
    result = {**prediction, 'text': '我可以规划路线、诊断订单风险、解释方案、对比基准，以及为故障车辆提出重调度建议。', 'actions': [], 'disable_vehicle_ids': None}
    if not scenario:
        result['text'] = '请先录入配送站、订单和车辆，再加载真实道路。我会根据这些数据进行调度。'
        return result
    intent = prediction['intent']
    if intent == 'risk':
        result['text'] = diagnose(scenario)
    elif intent == 'fault':
        mentioned = [v['id'] for v in scenario['vehicles'] if re.search(r'(?<![A-Za-z0-9_-])'+re.escape(v['id'])+r'(?![A-Za-z0-9_-])', text, re.I)]
        if not mentioned:
            result['text'] = '请明确需要停用的车辆编号，例如“V01 故障，请重新调度”。'
        elif len(mentioned) == len(scenario['vehicles']):
            result['text'] = '至少需要保留一辆可用车辆。请先录入替补车辆，再停用故障车辆。'
        else:
            result['disable_vehicle_ids'] = mentioned
            result['text'] = '建议停用 '+ '、'.join(mentioned)+'，保留订单与真实道路。应用后重新求解，已生成方案仍可查看。'
    elif intent == 'explain':
        if plan:
            m = plan['metrics']
            sequences = '；'.join(r['vehicle_id']+'：'+' → '.join(r['order_ids']) for r in plan['routes'] if r['used'])
            result['text'] = f'当前方案完成 {m["completed_orders"]}/{m["total_orders"]} 单，使用 {m["vehicles_used"]} 辆车，总道路里程 {m["total_distance_m"]/1000:.2f} km。先优先完成订单，再降低车辆与里程费用。\n{sequences}\n路线依据 OSRM 真实道路距离与静态行驶时间，载重、交付窗口与返程续航通过独立校验。有限搜索不保证全局最优。'
        else:
            result.update(text='请先生成方案，我会结合实际路线和订单解释结果。', actions=['optimize'])
    elif intent == 'optimize':
        result.update(text='已识别路线规划请求。点击生成方案，按当前订单与车辆进行计算。', actions=['optimize'])
    elif intent == 'compare':
        result.update(text='使用同一份订单、车辆和道路快照比较两种调度方法。', actions=['compare'])
    elif intent == 'preview':
        result.update(text='可以沿真实道路预演当前方案的交付顺序。', actions=['simulate'])
    return result
