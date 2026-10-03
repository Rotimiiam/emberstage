#!/usr/bin/env python3
"""Check package closure without touching OBS or building a disk image."""
import importlib.util
from html.parser import HTMLParser
from pathlib import Path
import tempfile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_macos', ROOT / 'scripts/package-macos.py')
assert spec is not None and spec.loader is not None
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key == 'src' or (tag == 'link' and key == 'href'):
                url = urlsplit(value or '')
                if url.path and not url.scheme and not url.netloc:
                    self.paths.append(unquote(url.path))


with tempfile.TemporaryDirectory(prefix='emberstage-package-assets-') as temporary:
    stage = Path(temporary)
    package.stage(ROOT, stage)
    payload = stage / 'payload'
    for html in package.APP_FILES:
        parser = References()
        parser.feed((payload / html).read_text())
        for reference in parser.paths:
            assert (payload / reference).is_file(), f'{html}: missing packaged asset {reference}'
    assert (payload / 'assets/js/media/native-install.js').read_text().strip().endswith(
        'window.EmberstageNativeInstall = null;'
    ), 'Do not package a machine-specific native connection binding'
    assert not list(payload.rglob('obs-connection.js')), 'Do not package OBS credentials'
    print(f'PASS package closure: {len(package.APP_FILES)} HTML entrypoints and {len(package.PAYLOAD_FILES)} payload files')
