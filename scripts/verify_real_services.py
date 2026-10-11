"""Small opt-in public-road check; creates no business orders or vehicles."""
import json
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.roads import RoadService

road=RoadService()
points=[{'lat':30.252,'lon':120.158},{'lat':30.259,'lon':120.164},{'lat':30.253,'lon':120.173}]
matrix=road.matrix(points)
segments=[]
for a,b in [(0,1),(1,2),(2,0)]:
    geometry=road.geometry(points[a],points[b])
    segments.append({'from':a,'to':b,'matrix_distance_m':matrix['distances'][a][b],'route_distance_m':geometry['distance_m'],'coordinate_count':len(geometry['coordinates'])})
    assert len(geometry['coordinates'])>2
places=road.search('Hangzhou West Lake')
assert places and matrix['distances'][0][1] != matrix['distances'][1][0]
result={'scope':'Public roads and places only; no operational orders or vehicles','provider':'OSRM / OpenStreetMap / Photon','matrix_fetched_at':matrix['fetched_at'],'points':points,'distances_m':matrix['distances'],'durations_seconds':matrix['durations'],'segments':segments,'public_place_names':[p['name'] for p in places]}
Path('artifacts/real-services.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'directional_roads':True,'full_geometry':True,'public_places':len(places)},ensure_ascii=False))
