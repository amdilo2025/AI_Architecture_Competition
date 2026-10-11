"""Package source, prebuilt frontend and evidence; exclude credentials and runtime data."""
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
paths = [root / name for name in ['README.md','API.md','DESIGN.md','UX-CONTRACT.md','premium-ui.json','.gitignore','.env.example','requirements.txt','requirements.lock.txt','setup.ps1','start.ps1','run.py','frontend/package.json','frontend/package-lock.json','frontend/index.html','frontend/tsconfig.json','frontend/vite.config.ts','frontend/playwright.config.ts','frontend/.prettierignore']]
for folder in ['backend','frontend/src','frontend/dist','frontend/tests','tests','scripts','docs']:
    paths += [p for p in (root/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
paths += [root/'artifacts'/name for name in ['backend-tests.xml','browser-tests.json','premium-audit.json','verification.json','real-services.json','example-validation.json','workbench-v2.png','login-v2.png','mobile-v2.png']]
destination = root / '路序-城市配送调度-完整项目.zip'
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(set(paths)):
        if path.exists():
            archive.write(path, path.relative_to(root).as_posix())
with zipfile.ZipFile(destination) as archive:
    names = archive.namelist()
    assert archive.testzip() is None
    assert not any('.env' == Path(n).name or 'node_modules/' in n or '.venv/' in n or 'data/' in n for n in names)
    assert 'frontend/dist/index.html' in names and 'backend/main.py' in names
print(json.dumps({'file':str(destination),'bytes':destination.stat().st_size,'entries':len(names)},ensure_ascii=False))
