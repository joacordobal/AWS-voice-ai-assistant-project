"""
Create the vector index in an OpenSearch Serverless collection.

Reads configuration from environment variables (see deploy.env.template):
  OSS_ENDPOINT, OSS_INDEX_NAME, AWS_REGION

Requires AWS credentials with aoss:APIAccessAll on the collection.
Run after `source deploy.env`.
"""

import json
import os
import hashlib
import hmac
import datetime
import urllib.request
import urllib.error
import ssl
import subprocess

ENDPOINT = os.environ["OSS_ENDPOINT"].replace("https://", "")
INDEX = os.environ.get("OSS_INDEX_NAME", "voice-assistant-index")
REGION = os.environ.get("AWS_REGION", "us-east-1")
SERVICE = "aoss"

ak = subprocess.check_output(["aws", "configure", "get", "aws_access_key_id"]).decode().strip()
sk = subprocess.check_output(["aws", "configure", "get", "aws_secret_access_key"]).decode().strip()

index_body = {
    "settings": {"index": {"knn": True, "knn.algo_param.ef_search": 512}},
    "mappings": {
        "properties": {
            "embedding": {
                "type": "knn_vector",
                "dimension": 1024,
                "method": {"engine": "faiss", "space_type": "l2", "name": "hnsw", "parameters": {}},
            },
            "text": {"type": "text"},
            "metadata": {"type": "text"},
        }
    },
}

body = json.dumps(index_body).encode()
t = datetime.datetime.utcnow()
ds = t.strftime("%Y%m%d")
ts = t.strftime("%Y%m%dT%H%M%SZ")
scope = f"{ds}/{REGION}/{SERVICE}/aws4_request"
signed_headers = "content-type;host;x-amz-date"
payload_hash = hashlib.sha256(body).hexdigest()

canonical = f"PUT\n/{INDEX}\n\ncontent-type:application/json\nhost:{ENDPOINT}\nx-amz-date:{ts}\n\n{signed_headers}\n{payload_hash}"
string_to_sign = f"AWS4-HMAC-SHA256\n{ts}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"

def sign(key, msg):
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()

k = sign(sign(sign(sign(f"AWS4{sk}".encode(), ds), REGION), SERVICE), "aws4_request")
sig = hmac.new(k, string_to_sign.encode(), hashlib.sha256).hexdigest()

headers = {
    "Content-Type": "application/json",
    "Host": ENDPOINT,
    "X-Amz-Date": ts,
    "Authorization": f"AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed_headers}, Signature={sig}",
}

req = urllib.request.Request(f"https://{ENDPOINT}/{INDEX}", data=body, method="PUT", headers=headers)
try:
    resp = urllib.request.urlopen(req, context=ssl.create_default_context())
    print(f"Status: {resp.status}")
    print(resp.read().decode())
except urllib.error.HTTPError as e:
    print(f"Error {e.code}: {e.read().decode()}")
