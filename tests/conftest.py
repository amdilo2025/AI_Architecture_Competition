"""Keep application imports in pytest away from the running workbench database."""
import os
from pathlib import Path

os.environ['DISPATCH_DB'] = str(Path(__file__).resolve().parents[1] / '.tmp' / f'pytest-import-{os.getpid()}.sqlite')
