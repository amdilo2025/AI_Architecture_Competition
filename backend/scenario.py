"""Directional routing over an immutable real-road matrix; graph fallback is test-only."""
import heapq

class RoadNetwork:
    def __init__(self, scenario):
        self.matrix = scenario.get('road_matrix')
        self.indices = {n['id']: i for i, n in enumerate(scenario['nodes'])}
        self.nodes = {n['id']: n for n in scenario['nodes']}
        self.adj = {n: [] for n in self.nodes}
        for edge in scenario['edges']:
            if edge['allowed']:
                self.adj[edge['from']].append(edge)
        self.cache = {}

    def paths_from(self, source):
        if source in self.cache:
            return self.cache[source]
        best = {source: (0, 0, [source])}
        queue = [(0, 0, source)]
        while queue:
            seconds, meters, node = heapq.heappop(queue)
            if (seconds, meters) != best[node][:2]:
                continue
            for edge in self.adj[node]:
                candidate = (seconds+edge['travel_seconds'], meters+edge['distance_m'])
                target = edge['to']
                if target not in best or candidate < best[target][:2]:
                    best[target] = (*candidate, best[node][2]+[target])
                    heapq.heappush(queue, (*candidate, target))
        self.cache[source] = best
        return best

    def route(self, source, target):
        if self.matrix:
            a, b = self.indices[source], self.indices[target]
            meters, seconds = self.matrix['distances'][a][b], self.matrix['durations'][a][b]
            if meters is None or seconds is None:
                return {'seconds': 10**7, 'meters': 10**8, 'nodes': []}
            return {'seconds': seconds, 'meters': meters, 'nodes': [source] if source == target else [source, target]}
        found = self.paths_from(source).get(target)
        if not found:
            return {'seconds': 10**7, 'meters': 10**8, 'nodes': []}
        return {'seconds': found[0], 'meters': found[1], 'nodes': found[2]}
