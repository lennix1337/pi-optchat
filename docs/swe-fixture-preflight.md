# OpenHuman SWE-bench fixture preflight

## Scope and provenance

Prepared the fixed 10-task suite for `SWE-bench/SWE-bench_Verified` at revision `78f471bf655a3137b2e8a75af1501690ec009ec3`, using the IDs in the benchmark checkout's `swebench/instances-10.txt` (seed `20261001`). The local copy is byte-identical to that source list (SHA-256 `7c4e97d44a4c422ac88c92576c5ca3c852dc0e0a8ee1f63e0aaba517780083d0`). It contains, in sorted order:

- `django__django-13569`
- `django__django-14672`
- `django__django-15277`
- `django__django-15572`
- `matplotlib__matplotlib-24570`
- `psf__requests-5414`
- `pylint-dev__pylint-4970`
- `scikit-learn__scikit-learn-14141`
- `sympy__sympy-13031`
- `sympy__sympy-16766`

`scratchpad/openhuman-fixtures/prepare_fixtures.py` streams the explicitly pinned dataset revision, selects only these rows, checks for missing/duplicate IDs and required fields, and writes the benchmark-compatible prompt wrapper, `tasks.json`, per-task `metadata.json`, and `manifest.json`. It is a small independent extractor; no OpenHuman source code was copied. The fixed list is used directly rather than re-sampling.

The ten prompt files total 20,980 bytes. Their SHA-256 values are recorded in `scratchpad/openhuman-fixtures/manifest.json`. The generated task IDs were verified against the fixed list, and each prompt hash and image metadata was checked. The Hugging Face dataset cache directory is empty; its local Hub metadata cache is 7,165 bytes. Streaming transport bytes were not measured, so this does not claim that the network transferred only the selected rows.

## Isolated preparation and grader environment

All Python installation, package, and Hugging Face caches are under the ignored `scratchpad/openhuman-fixtures/` directory. No global Python packages or machine PATH changes were made.

- `uv`: 0.11.0
- Local Python: CPython 3.12.13
- Official preparation/evaluator packages: `datasets==5.1.0`, `swebench==5.0.2`
- Full installed-package snapshot: `scratchpad/openhuman-fixtures/requirements-freeze.txt`
- Approximate local sizes: Python 129,951,357 bytes; `.uv-cache` 272,360,375 bytes; venv 266,058,032 bytes; selected prompts 20,980 bytes.
- Hub access was explicitly unauthenticated (`HF_HUB_DISABLE_IMPLICIT_TOKEN=1`, empty `HF_TOKEN`); no Pi or other auth files were accessed.

`python -m swebench.harness.run_evaluation --help` succeeded in the isolated venv. This proves the installed official evaluator module imports and exposes its CLI, not that a grading run succeeds. No predictions were available, so no official evaluation or model inference was run.

## Exact pinned-revision grading

In `swebench==5.0.2`, `swebench.harness.utils.load_swebench_dataset` accepts a local `.json` file. The fixture now contains `evaluator-dataset.json` (147,043 bytes): the exact 10 full rows streamed from the pinned revision, including the official grader's test metadata. Its SHA-256 (`62e18376ac124257210d16e0a79a21fed97585d62e9349dda7bf8ece2e72e6fe`) and the fixed-list SHA-256 are recorded in `manifest.json`. The JSON includes reference/test patches; it is grader-only and must never be mounted into an agent task directory. `tasks.json` points only to the per-instance prompt directories.

Use `grade_pinned.py` instead of the benchmark checkout's stock `swebench/grade.mjs` when grading these predictions. It validates the fixed list, manifest, row hash, dataset IDs, and that predictions cover exactly the 10 fixed IDs with no duplicates, then invokes the unmodified official evaluator with `--dataset_name <fixture>/evaluator-dataset.json` and the fixed instance IDs. It forces Hugging Face offline mode, disables python-dotenv, forwards only standard process variables, and supplies a temporary empty `HOME`/`USERPROFILE`/`DOCKER_CONFIG` so the evaluator cannot read the user's Docker credential configuration. Evaluator output stays beneath the ignored fixture directory. It assumes the default local Docker endpoint rather than inheriting a custom remote `DOCKER_HOST`. The benchmark's stock `grade.mjs` hardcodes the Hub dataset name, so using it directly would not guarantee the pinned revision. Example from PowerShell after a harness has produced predictions:

```powershell
$fixtures = 'C:\projetos\pi-optchat\scratchpad\openhuman-fixtures'
& "$fixtures\.venv\Scripts\python.exe" "$fixtures\grade_pinned.py" `
  --predictions-path '<benchmark-root>\results\<run-id>\<harness>\predictions.jsonl' `
  --run-id '<run-id>-<harness>' --max-workers 1 --timeout 1800
```

The report and evaluator logs remain under `scratchpad/openhuman-fixtures/`; this wrapper does not modify the benchmark's result directory or produce its `grade.json` post-processing file. Four offline unit tests passed: the official loader uses the local JSON without invoking Hugging Face `load_dataset`, all ten rows build official `TestSpec`s and match their prompt inputs, incomplete prediction sets are rejected, and the wrapper passes the pinned local path/IDs with offline and credential-free environment settings. These checks do not run Docker evaluation.

## Docker and host snapshot

- Windows 11 Pro, build `10.0.26200`
- AMD Ryzen 7 9800X3D; 8 physical cores / 16 logical processors
- Docker Engine 29.7.2, Linux `x86_64`; 8 CPUs; memory limit 16,771,149,824 bytes (~15.62 GiB)
- Host-visible RAM: 32,413,084 KiB total; this worker's last snapshot showed 6,352,464 KiB free (~6.06 GiB), and the coordinator's later independent reading was ~6.13 GiB.
- Free disk at that snapshot: C: 177,506,852,864 bytes; D: 95,242,649,600 bytes

The single authorized task image `swebench/sweb.eval.x86_64.psf_1776_requests-5414:latest` was pulled and is present (Docker reports 3.84 GB). No other SWE-bench task images were pulled, and no unrelated images, containers, or networks were removed. A task-container smoke was attempted but is **not verified**: the first invocation hit Git Bash path conversion; the corrected invocation's result was uncertain, and a later read-only container listing showed no remaining container for this image.

The benchmark runbook's configured minimum is 6 CPUs, 12 GB free RAM, and 60 GB disk. Docker is configured for 8 CPUs and ~15.62 GiB, and both C: and D: have more than 60 GiB free. However, host free RAM remains about 6.13 GiB, so the 12 GB free-memory gate is **not met**; recheck before a run. No benchmark harness/agent task run or model call was started here.

## Remaining prerequisites / limitations

1. Build and smoke-test the intended Pi/OptChat harness adapter without exporting credentials or using OpenRouter. This worker did not access the logged-in Pi account or make inference calls.
2. After memory and runner-readiness gates pass, pull the other nine pinned task images before a full 10-task run; they were deliberately not pulled while those gates remain blocked.
3. Recheck available host memory against the runbook before running the sequential tasks and official grader.
4. Use the local `grade_pinned.py` wrapper for the official evaluation; the stock benchmark `grade.mjs` still points at the current Hub dataset and is not revision-pinned. The wrapper's `reports/` output needs a later comparison/report integration step.
5. No `predictions.jsonl`, official grades, task-success results, cost, cache, or latency comparisons exist yet.
