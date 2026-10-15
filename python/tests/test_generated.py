import subprocess
import sys
from pathlib import Path


def test_the_sync_client_is_up_to_date_with_the_async_source() -> None:
    script = Path(__file__).resolve().parents[1] / "scripts/unasync.py"
    result = subprocess.run(
        [sys.executable, str(script), "--check"], capture_output=True, text=True
    )
    assert result.returncode == 0, result.stdout + result.stderr
