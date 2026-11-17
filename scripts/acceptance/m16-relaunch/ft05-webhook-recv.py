#!/usr/bin/env python3
"""自建 webhook 接收端（TC-FT-05 告警触达演练用）。

设计：
- 监听 127.0.0.1:18098（演练专用，绑定本机不暴露公网）
- 兼容两种推送契约：
  1) schema-backup.sh 风格 {"text": "..."}
  2) fault-drill 风格 {"level": "P0|P1|P2", "text": "...", "at": "..."}
- 每条告警追加写入 inbox.jsonl：服务器接收时刻（recv_at，含毫秒）+ 原始 payload
- 触达时延由脚本侧 send 时刻与 recv_at 差值计算（同机时钟，无 NTP 偏差）
- GET /_ping 返回存活探针；GET /_inbox 返回已收条数（演练断言用）
启动：nohup python3 /opt/schema/staging/ft05-webhook-recv.py >/opt/schema/staging/ft05-webhook.log 2>&1 &
"""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

INBOX = "/opt/schema/staging/fault-drill/ft05-webhook-inbox.jsonl"
PORT = 18098


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/_ping":
            self._json(200, {"ok": True, "recv_ts": time.time()})
        elif self.path == "/_inbox":
            try:
                with open(INBOX, encoding="utf-8") as f:
                    n = sum(1 for _ in f)
            except FileNotFoundError:
                n = 0
            self._json(200, {"count": n})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        recv_ns = time.time_ns()
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {"_raw": raw.decode("utf-8", "replace")}
        record = {
            "recv_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(recv_ns / 1e9))
            + ".%03dZ" % (recv_ns % 1_000_000_000 // 1_000_000),
            "recv_ts": recv_ns / 1e9,
            "payload": payload,
        }
        with open(INBOX, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
        # 兼容钉钉/企微响应契约：{"errcode":0} 表示接收成功
        self._json(200, {"errcode": 0, "errmsg": "ok"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("webhook receiver on 127.0.0.1:%d -> %s" % (PORT, INBOX), flush=True)
    server.serve_forever()
