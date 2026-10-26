import os
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
directory = root / ".tools"
directory.mkdir(exist_ok=True)
log = directory / "pocket-console.log"
keyfile = directory / "pocket-session-key.txt"
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "wb") as output:
    process = subprocess.Popen([
        "xcrun", "devicectl", "device", "process", "launch", "--device", sys.argv[1],
        "--console", "--timeout", "35", "com.heypocket.app",
    ], stdout=output, stderr=subprocess.STDOUT)
    try:
        process.wait(timeout=40)
    except subprocess.TimeoutExpired:
        process.terminate()
        process.wait(timeout=5)
data = log.read_bytes()
matches = set(re.findall(rb"APP&SK&([A-Za-z0-9]{16})", data))
if len(matches) == 1:
    fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(matches.pop() + b"\n")
    print("Pocket session key captured and saved locally with owner-only permissions.")
else:
    print(f"Pocket console capture finished: {len(data)} bytes; no unique session-key exchange found.")
    uid_labels = re.findall(rb"(?i)(firebase.{0,12}uid|distinct_id|user.?id)", data)
    print(f"Potential identity-label occurrences for local inspection: {len(uid_labels)}")
