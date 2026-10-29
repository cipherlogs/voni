"""Ticket 142: every recorded provider fixture is exercised in the Python CI job.

Spec: `.scratch/meta-cascade/spec.md`, "Fixtures, chaos and live smoke" —
fixtures block every PR, one suite per provider replays recorded frames, a
changed known field fails and names the drift, and nothing needs a vendor key.

Three provider suites exist (STT ticket 34, model stream ticket 45, voice
ticket 56) and each already pins its own projection. This manifest is the
guard that makes those suites a CI contract instead of three files that happen
to be discovered:

* every JSON file under ``cascade/fixtures/{stt,meta_llm,tts}/`` is replayed
  *successfully* by a named test in its provider suite — a fixture added to
  disk but not exercised fails, and a listed fixture no test replays fails;
* a changed known frame in each provider still fails *by fixture name*;
* the suites run with an empty environment, so no vendor key can creep in;
* ``.github/workflows/ci.yml`` names all three suites inside the ``python``
  job, has no path filter and no ``continue-on-error``, and its
  ``required-python`` gate fails when the job is skipped, cancelled or failed.

The manifest deliberately re-runs each provider suite (about 70 tests, tens of
milliseconds) with a recording wrapper around the suite's own
``assert_parity``. That is the only honest way to prove "exercised": a test
that imports the fixture but never replays it, or a skip that hides a broken
fixture, does not count.
"""

from __future__ import annotations

import importlib
import io
import os
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"

#: One entry per provider. ``fixtures`` is the attribute the provider test
#: module exposes for its fixture directory; ``expect_module`` is what the CI
#: step names and what discovery must import.
PROVIDERS = (
    {
        "name": "stt",
        "module": "cascade.test_meta_stt_fixtures",
        "fixtures": "FIXTURE_DIR",
    },
    {
        "name": "meta_llm",
        "module": "cascade.test_meta_llm_fixtures",
        "fixtures": "FIXTURES",
    },
    {
        "name": "tts",
        "module": "cascade.test_tts_fixtures",
        "fixtures": "FIXTURE_DIR",
    },
)


def run_provider(provider: dict) -> tuple[object, set[str], unittest.TestResult]:
    """Run one provider suite, recording which fixtures replayed successfully."""
    module = importlib.import_module(provider["module"])
    fixture_dir = Path(getattr(module, provider["fixtures"]))
    on_disk = {path.stem for path in fixture_dir.glob("*.json")}
    replayed: set[str] = set()

    original = module.assert_parity

    def recording_assert(document):
        result = original(document)
        name = document.get("name")
        if name in on_disk:
            replayed.add(name)
        return result

    module.assert_parity = recording_assert
    try:
        suite = unittest.defaultTestLoader.loadTestsFromModule(module)
        result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(
            suite
        )
    finally:
        module.assert_parity = original
    return module, replayed, result


class EveryProviderFixtureExercisedTests(unittest.TestCase):
    def test_each_provider_suite_replays_every_recorded_fixture(self):
        for provider in PROVIDERS:
            with self.subTest(provider=provider["name"]):
                module = importlib.import_module(provider["module"])
                fixture_dir = Path(getattr(module, provider["fixtures"]))
                on_disk = {path.stem for path in fixture_dir.glob("*.json")}
                listed = set(module.EXERCISED)

                self.assertTrue(
                    on_disk,
                    f"{provider['name']} has no recorded fixture under "
                    f"{fixture_dir}; the suite would pass vacuously",
                )
                self.assertEqual(
                    on_disk,
                    listed,
                    f"{provider['name']} manifest and fixtures disagree: "
                    f"{sorted(on_disk ^ listed)}",
                )

                # Run under an empty environment: a suite that needs a vendor
                # key (or any ambient config) fails here instead of in a PR.
                with mock.patch.dict(os.environ, {}, clear=True):
                    _, replayed, result = run_provider(provider)

                self.assertTrue(
                    result.wasSuccessful(),
                    f"{provider['name']} suite must be green before it can "
                    f"prove anything: {result.failures + result.errors}",
                )
                self.assertEqual(
                    result.skipped,
                    [],
                    f"{provider['name']} must not skip a fixture: "
                    f"{result.skipped}",
                )
                self.assertEqual(
                    replayed,
                    on_disk,
                    f"{provider['name']} fixtures recorded but never replayed: "
                    f"{sorted(on_disk - replayed)}",
                )


class FixtureDriftNamesTheFixtureTests(unittest.TestCase):
    """A changed known frame in each provider fails and names the fixture."""

    def _assert_drift_names(self, provider_name: str, fixture: str, mutate):
        provider = next(p for p in PROVIDERS if p["name"] == provider_name)
        module = importlib.import_module(provider["module"])
        document = module.load(fixture)
        mutate(document)

        with self.assertRaises(AssertionError) as caught:
            module.assert_parity(document)

        self.assertIn(fixture, str(caught.exception))

    def test_a_changed_stt_frame_fails_by_name(self):
        def mutate(document):
            complete = next(
                frame
                for frame in document["plans"][0]
                if isinstance(frame.get("json"), dict)
                and frame["json"].get("type") == "speechComplete"
            )
            complete["json"]["text"] = "How are you"

        self._assert_drift_names("stt", "events-turn", mutate)

    def test_a_changed_model_stream_frame_fails_by_name(self):
        def mutate(document):
            document["chunks"] = [
                chunk.replace('"finish_reason":"stop"', '"finish_reason":"length"')
                for chunk in document["chunks"]
            ]

        self._assert_drift_names("meta_llm", "normal-reply", mutate)

    def test_a_changed_tts_frame_fails_by_name(self):
        def mutate(document):
            document["begin"]["configuration"]["sample_rate"] = 8000

        self._assert_drift_names("tts", "begin-echo", mutate)


class CiWiringTests(unittest.TestCase):
    """The workflow must run these suites and must not be able to skip them."""

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        # The `python` job block: from its key to the next top-level job.
        cls.python_job = cls.text.split("\n  python:\n", 1)[1].split(
            "\n  required-python:", 1
        )[0]
        cls.fixture_step = cls._step(cls.python_job, "Provider fixture suites")

    @staticmethod
    def _step(job_text: str, name: str) -> str:
        """The lines of one named step, so a comment cannot satisfy a check."""
        marker = f"- name: {name}"
        start = job_text.index(marker) + len(marker)
        rest = job_text[start:]
        ends = [
            index
            for index in (rest.find("\n\n"), rest.find("\n      - name: "))
            if index != -1
        ]
        return rest[: min(ends)] if ends else rest

    def test_the_python_job_names_every_provider_suite(self):
        for provider in PROVIDERS:
            with self.subTest(provider=provider["name"]):
                self.assertIn(provider["module"], self.fixture_step)

    def test_the_fixture_step_has_a_name_a_human_can_read(self):
        self.assertIn("Provider fixture suites", self.python_job)

    def test_the_fixture_step_cannot_be_skipped_or_soft_failed(self):
        self.assertNotIn("if:", self.fixture_step)
        self.assertNotIn("continue-on-error", self.fixture_step)

    def test_no_step_can_continue_on_error(self):
        self.assertNotIn("continue-on-error", self.text)

    def test_the_workflow_has_no_path_filter_or_job_level_if(self):
        # A real key sits on its own indented line; the workflow comment above
        # the job explains *why* there is no `paths:` filter, so match the key.
        self.assertNotIn("\n    paths:", self.text)
        self.assertNotIn("\n    if:", self.python_job)

    def test_the_python_job_has_a_timeout(self):
        self.assertIn("timeout-minutes:", self.python_job)

    def test_the_job_needs_no_vendor_key(self):
        for name in ("META_API_KEY", "ASSEMBLYAI_API_KEY", "OPENAI_API_KEY"):
            with self.subTest(key=name):
                self.assertNotIn(name, self.python_job)

    def test_the_required_gate_turns_skip_and_cancel_into_failure(self):
        self.assertIn("required-python:", self.text)
        gate = self.text.split("\n  required-python:", 1)[1]
        self.assertIn("needs: [python]", gate)
        self.assertIn("if: always()", gate)
        self.assertIn(
            'test "${{ needs.python.result }}" = "success"', gate
        )


if __name__ == "__main__":
    unittest.main()
