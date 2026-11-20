import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture(autouse=True)
def _fresh_demo_engine(monkeypatch):
    """The demo engine is a process-wide singleton; give every test a clean one and no live LLM."""
    import demo_engine

    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    demo_engine.set_engine(None)
    yield
    demo_engine.set_engine(None)
