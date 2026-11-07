import pytest

from edgedesk.sim.synthetic import Scenario, generate


@pytest.fixture(scope="session")
def synth_recs():
    return generate(Scenario(hours=2.0))


@pytest.fixture(scope="session")
def synth_long():
    return generate(Scenario(hours=3.0, seed=11))
