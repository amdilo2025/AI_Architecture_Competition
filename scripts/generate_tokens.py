"""Generate runtime design tokens from the deliberately restricted DESIGN.md schema."""
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root.joinpath('DESIGN.md').read_text(encoding='utf-8').split('---')[1]
tokens = []
group = ''
role = ''
for line in source.splitlines():
    if re.match(r'^\w+:$', line):
        group = line[:-1]
    match = re.match(r'^  (\w+): "(.+)"$', line)
    if match and group in ('colors', 'rounded', 'spacing'):
        prefix = {'colors': 'color', 'rounded': 'radius', 'spacing': 'space'}[group]
        tokens.append(f'  --{prefix}-{match[1]}: {match[2]};')
    role_match = re.match(r'^  (\w+):$', line)
    if role_match and group == 'typography':
        role = role_match[1]
    prop = re.match(r'^    (\w+): "(.+)"$', line)
    if prop and group == 'typography':
        name = {'fontFamily': 'family', 'fontSize': 'size', 'lineHeight': 'leading'}[prop[1]]
        tokens.append(f'  --font-{role}-{name}: {prop[2]};')
target = root / 'frontend/src/tokens.css'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text('/* Generated from DESIGN.md. */\n:root {\n'+'\n'.join(tokens)+'\n}\n', encoding='utf-8')
