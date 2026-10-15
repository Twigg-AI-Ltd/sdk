from __future__ import annotations

import httpx
import pytest

from twigg import (
    APIConnectionError,
    APITimeoutError,
    RateLimitError,
    RequestOptions,
    ServiceUnavailableError,
)

from .helpers import RUN, api_error, json_response, run_record, setup


def test_retries_a_read_after_a_503() -> None:
    twigg, api, _ = setup()
    api.reply(api_error(503, "unavailable"), json_response([]))
    assert twigg.models.list() == []
    assert len(api.requests) == 2


def test_gives_up_after_max_retries() -> None:
    twigg, api, _ = setup(max_retries=1)
    api.reply(api_error(503, "unavailable"), api_error(503, "unavailable"), json_response([]))
    with pytest.raises(ServiceUnavailableError):
        twigg.models.list()
    assert len(api.requests) == 2


def test_does_not_retry_a_publish_after_a_5xx() -> None:
    twigg, api, _ = setup()
    api.reply(api_error(502, "external_service_error"))
    with pytest.raises(Exception, match="external_service_error"):
        twigg.config.instructions.publish(body="Be brief.")
    assert len(api.requests) == 1


def test_retries_a_publish_after_a_429() -> None:
    twigg, api, _ = setup()
    version = {
        "id": "v2",
        "version": 2,
        "estimated_tokens": 3,
        "is_active": True,
        "created_at": "2026-10-14T00:00:00Z",
    }
    api.reply(api_error(429, "rate_limited"), json_response(version))
    assert twigg.config.instructions.publish(body="Be brief.").id == "v2"
    assert len(api.requests) == 2


def test_honours_retry_after_in_seconds() -> None:
    twigg, api, sleeps = setup()
    api.reply(
        json_response(
            {"error": {"code": "rate_limited", "message": "slow"}}, 429, {"retry-after": "3"}
        ),
        json_response([]),
    )
    twigg.models.list()
    assert sleeps == [3.0]


def test_backs_off_exponentially_without_retry_after() -> None:
    twigg, api, sleeps = setup()
    api.reply(api_error(503, "unavailable"), api_error(503, "unavailable"), json_response([]))
    twigg.models.list()
    assert 0.25 <= sleeps[0] <= 0.5
    assert 0.5 <= sleeps[1] <= 1.0


def test_retries_a_read_after_a_network_error() -> None:
    twigg, api, _ = setup()
    api.reply(httpx.ConnectError("refused"), json_response([]))
    assert twigg.models.list() == []


def test_reports_connection_error_once_retries_run_out() -> None:
    twigg, api, _ = setup(max_retries=0)
    api.reply(httpx.ConnectError("refused"))
    with pytest.raises(APIConnectionError):
        twigg.models.list()


def test_reports_a_timeout_as_timeout_error() -> None:
    twigg, api, _ = setup()
    api.reply(httpx.ReadTimeout("slow"))
    with pytest.raises(APITimeoutError):
        twigg.models.list(options=RequestOptions(max_retries=0))


def test_reports_rate_limit_error_once_retries_run_out() -> None:
    twigg, api, _ = setup(max_retries=0)
    api.reply(api_error(429, "rate_limited"))
    with pytest.raises(RateLimitError):
        twigg.models.list()


def test_waits_for_a_run_to_settle() -> None:
    twigg, api, sleeps = setup()
    pending = run_record("succeeded")
    settled = run_record("succeeded", cost="0.002", settled_at="2026-10-14T10:00:00Z")
    api.reply(json_response(pending), json_response(pending), json_response(settled))
    run = twigg.runs.wait_for_settlement(RUN)
    assert str(run.cost) == "0.002"
    assert sleeps == [1.0, 2.0]


def test_gives_up_waiting_for_settlement_after_the_deadline() -> None:
    twigg, api, sleeps = setup()
    api.reply(json_response(run_record("succeeded")))
    with pytest.raises(APITimeoutError) as caught:
        twigg.runs.wait_for_settlement(RUN, wait=0.5)
    assert caught.value.code == "settlement_timeout"
    assert sleeps == []
