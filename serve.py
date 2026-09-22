"""Tiny no-cache static server for local play/dev: python serve.py [port]"""
import http.server
import os
import base64
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript'}

    def do_POST(self):
        # Dev-only: POST a canvas dataURL to /__shot?name=x to save x.png (set SHOT_DIR env var to enable).
        shot_dir = os.environ.get('SHOT_DIR')
        if not shot_dir or not self.path.startswith('/__shot'):
            self.send_error(404)
            return
        name = self.path.partition('name=')[2] or 'shot'
        name = ''.join(c for c in name if c.isalnum() or c in '-_') or 'shot'
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        with open(os.path.join(shot_dir, name + '.png'), 'wb') as f:
            f.write(base64.b64decode(body.split(',', 1)[-1]))
        self.send_response(204)
        self.end_headers()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'public'))
print(f'Serving on http://127.0.0.1:{PORT}/')
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), NoCacheHandler).serve_forever()
