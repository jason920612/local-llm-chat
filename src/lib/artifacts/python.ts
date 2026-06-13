"use client";

import { loadPyodideRuntime, type PyodideApi } from "./loaders";

export interface PyRunResult {
  stdout: string;
  stderr: string;
  error: string;
  /** data: URLs for any matplotlib figures produced. */
  images: string[];
}

// Harness appended after the user code: collect any open matplotlib figures as
// base64 PNGs into a global the JS side can read. No-op if matplotlib is unused.
const FIG_HARNESS = `
import sys as _sys, json as _json
_figs = []
if "matplotlib.pyplot" in _sys.modules:
    import io as _io, base64 as _b64
    _plt = _sys.modules["matplotlib.pyplot"]
    for _n in _plt.get_fignums():
        _buf = _io.BytesIO()
        _plt.figure(_n).savefig(_buf, format="png", bbox_inches="tight")
        _figs.append("data:image/png;base64," + _b64.b64encode(_buf.getvalue()).decode())
    _plt.close("all")
_figs_json = _json.dumps(_figs)
`;

/**
 * Run Python in the browser via Pyodide. Auto-installs imported packages,
 * captures stdout/stderr, and returns any matplotlib figures as images.
 */
export async function runPythonPreview(code: string): Promise<PyRunResult> {
  let py: PyodideApi;
  try {
    py = await loadPyodideRuntime();
  } catch {
    return { stdout: "", stderr: "", error: "Pyodide 載入失敗", images: [] };
  }

  let stdout = "";
  let stderr = "";
  let error = "";
  py.setStdout({ batched: (s) => (stdout += s + "\n") });
  py.setStderr({ batched: (s) => (stderr += s + "\n") });

  try {
    // Force a non-interactive matplotlib backend before user code imports it.
    await py.runPythonAsync(
      "import os as _os; _os.environ['MPLBACKEND']='AGG'",
    );
    await py.loadPackagesFromImports(code);
    await py.runPythonAsync(code);
  } catch (e) {
    error = String((e as Error)?.message || e).slice(0, 4000);
  }

  let images: string[] = [];
  try {
    await py.runPythonAsync(FIG_HARNESS);
    const raw = py.globals.get("_figs_json");
    if (typeof raw === "string") images = JSON.parse(raw);
  } catch {
    /* no figures / matplotlib not used */
  }

  return {
    stdout: stdout.slice(0, 20000),
    stderr: stderr.slice(0, 20000),
    error,
    images,
  };
}
