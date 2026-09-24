import yaml
from cxviz.templating import neutralise


def test_replaces_standalone_expression_with_quoted_scalar():
    src = 'arn: {{ exec "secret-tool" (list "get" "${clusterName}-x" "arn") }}\n'
    out = neutralise(src)
    assert yaml.safe_load(out.text) == {"arn": "TEMPLATED_0"}
    assert out.placeholders[0].line == 1
    assert out.placeholders[0].expression.startswith("{{ exec")


def test_embedded_expression_is_not_quoted():
    out = neutralise('repo: "123.dkr.{{ .Region }}.aws/img"\n')
    assert yaml.safe_load(out.text) == {"repo": "123.dkr.TEMPLATED_0.aws/img"}


def test_env_references_are_kept_and_shell_vars_reported():
    src = "a: ${env:K8S_NODE_IP}\nb: ${clusterName}\nc: ${primaryRegion}\n"
    out = neutralise(src)
    assert out.text == src
    assert out.variables == ["clusterName", "primaryRegion"]


def test_multiple_expressions_get_distinct_placeholders():
    out = neutralise("- {{ a }}\n- {{ b }}\n")
    assert yaml.safe_load(out.text) == ["TEMPLATED_0", "TEMPLATED_1"]
