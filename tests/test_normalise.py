from cxviz.normalise import GLOBAL_PLACEHOLDERS, UMBRELLA_KEY, normalise_values


def test_plain_values_pass_through_with_globals_filled():
    values = {"global": {"domain": "eu2.coralogix.com"}, "opentelemetry-agent": {"config": {}}}
    out = normalise_values(values)
    assert out.unwrapped is None
    assert out.values["opentelemetry-agent"] == {"config": {}}
    assert out.values["global"]["domain"] == "eu2.coralogix.com"
    assert out.values["global"]["clusterName"] == GLOBAL_PLACEHOLDERS["clusterName"]
    assert out.filled_globals == ["clusterName"]
    assert out.changed


def test_complete_plain_values_are_unchanged():
    values = {"global": {"domain": "d", "clusterName": "c"}, "opentelemetry-agent": {}}
    out = normalise_values(values)
    assert out.values == values
    assert not out.changed


def test_umbrella_key_is_unwrapped_and_siblings_reported():
    values = {
        "externalSecrets": {"name": "x"},
        "global": {"domain": "outer", "clusterName": "c"},
        UMBRELLA_KEY: {"global": {"domain": "inner", "logLevel": "debug"},
                       "opentelemetry-agent": {"config": {"processors": {"p": {}}}}},
    }
    out = normalise_values(values)
    assert out.unwrapped == {"key": UMBRELLA_KEY, "dropped": ["externalSecrets"]}
    assert out.values["opentelemetry-agent"]["config"]["processors"] == {"p": {}}
    # parent-chart globals win over the subchart's own, as in Helm
    assert out.values["global"] == {"domain": "outer", "logLevel": "debug", "clusterName": "c"}
    assert "externalSecrets" not in out.values
    assert out.filled_globals == []


def test_umbrella_without_any_globals_gets_placeholders():
    out = normalise_values({UMBRELLA_KEY: {"opentelemetry-agent": {}}})
    assert out.values["global"] == GLOBAL_PLACEHOLDERS
    assert out.filled_globals == ["domain", "clusterName"]


def test_input_is_not_mutated():
    values = {UMBRELLA_KEY: {"global": {"domain": "x"}}}
    normalise_values(values)
    assert values == {UMBRELLA_KEY: {"global": {"domain": "x"}}}


def test_non_mapping_umbrella_value_is_left_alone():
    out = normalise_values({UMBRELLA_KEY: "oops", "global": {"domain": "d", "clusterName": "c"}})
    assert out.unwrapped is None
