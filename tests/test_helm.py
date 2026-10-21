import json

import pytest

from cxviz import helm


def fake_helm(before, after, update_fails=False):
    """Stand-in for helm._run: `search repo` answers from the before/after lists."""
    state = {"versions": before, "calls": []}

    def run(args, timeout):
        state["calls"].append(args[:2])
        if args[:2] == ["repo", "update"]:
            if update_fails:
                raise helm.HelmError("no repo named coralogix")
            state["versions"] = after
            return ""
        if args[:2] == ["search", "repo"]:
            return json.dumps([{"version": v} for v in state["versions"]])
        raise AssertionError(f"unexpected helm call: {args}")

    return run, state


def test_refresh_repo_reports_versions_that_appeared(monkeypatch):
    run, state = fake_helm(["0.0.200", "0.0.199"], ["0.0.202", "0.0.201", "0.0.200", "0.0.199"])
    monkeypatch.setattr(helm, "_run", run)
    assert helm.refresh_repo() == ["0.0.202", "0.0.201"]
    assert ["repo", "update"] in state["calls"]


def test_refresh_repo_with_nothing_new(monkeypatch):
    run, _ = fake_helm(["0.0.200"], ["0.0.200"])
    monkeypatch.setattr(helm, "_run", run)
    assert helm.refresh_repo() == []


def test_refresh_repo_propagates_update_failure(monkeypatch):
    run, _ = fake_helm(["0.0.200"], ["0.0.200"], update_fails=True)
    monkeypatch.setattr(helm, "_run", run)
    with pytest.raises(helm.HelmError):
        helm.refresh_repo()
