# Auto-loaded by Python at interpreter startup (this dir is put on PYTHONPATH by
# the sandbox). Purpose: make Chinese PDFs "just work" regardless of what code the
# model writes.
#
# reportlab's built-in CID fonts (STSong-Light / MSung-Light) are NOT embedded and
# are Simplified (Adobe-GB1) ordered with no ToUnicode map -> in many viewers they
# render blank or garbled for Traditional Chinese, and text can't be copied. This
# hook transparently swaps any UnicodeCIDFont(...) for an EMBEDDED system CJK
# TrueType font registered under the same name, so glyphs are correct everywhere and
# the PDF has a proper text layer. Fully silent and defensive: if anything is off
# (no font found, reportlab absent), it leaves behavior unchanged.
import os
import sys
import builtins

_CANDIDATES = [
    ("C:/Windows/Fonts/msjh.ttc", 0),     # Microsoft JhengHei  — Traditional (preferred)
    ("C:/Windows/Fonts/mingliu.ttc", 0),  # MingLiU             — Traditional
    ("C:/Windows/Fonts/msyh.ttc", 0),     # Microsoft YaHei     — Simplified
    ("C:/Windows/Fonts/simsun.ttc", 0),   # SimSun              — Simplified
    ("/System/Library/Fonts/PingFang.ttc", 0),                      # macOS
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),  # Linux
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
]


def _find_font():
    for path, idx in _CANDIDATES:
        if os.path.exists(path):
            return path, idx
    return None, None


_state = {"done": False}


def _dbg(*a):
    if os.environ.get("PYBOOT_DEBUG"):
        print("[pyboot]", *a, file=sys.stderr)


def _patch():
    if _state["done"] or _state.get("running"):
        return
    cid = sys.modules.get("reportlab.pdfbase.cidfonts")
    # Wait until the module is FULLY initialized (its class exists). During the
    # module's own body execution it is in sys.modules but partially initialized;
    # don't give up then — just retry on the next import.
    if cid is None or not hasattr(cid, "UnicodeCIDFont"):
        return
    _orig = cid.UnicodeCIDFont
    if getattr(_orig, "_pyboot", False):
        _state["done"] = True
        return
    # Guard against reentrancy: the imports below re-trigger the import hook, which
    # would call _patch again before we finish (infinite recursion) without this.
    _state["running"] = True
    _dbg("patching; cidfonts fully initialized")
    try:
        path, idx = _find_font()
        if not path:
            _state["done"] = True
            return
        from reportlab.pdfbase.ttfonts import TTFont

        def _embedded_cid(name, *args, **kwargs):
            # Return an embedded TTF under the requested CID name; fall back to the
            # original CID font if the TTF can't be loaded for some reason.
            try:
                return TTFont(name, path, subfontIndex=idx)
            except Exception:
                return _orig(name, *args, **kwargs)

        _embedded_cid._pyboot = True
        cid.UnicodeCIDFont = _embedded_cid
        # Also patch the name as re-exported via pdfmetrics, if present.
        try:
            pm = sys.modules.get("reportlab.pdfbase.pdfmetrics")
            if pm is not None and hasattr(pm, "UnicodeCIDFont"):
                pm.UnicodeCIDFont = _embedded_cid
        except Exception:
            pass
        _state["done"] = True
        _dbg("patched OK using", path)
    except Exception as e:
        _dbg("patch FAILED:", repr(e))
        # Do NOT set done — allow a later import to retry.
    finally:
        _state["running"] = False


# Patch lazily: reportlab is imported by the user's code, not at startup. After each
# import, check whether reportlab's CID module is now loaded and patch it once.
_real_import = builtins.__import__


def _hooked_import(name, *args, **kwargs):
    module = _real_import(name, *args, **kwargs)
    if not _state["done"]:
        try:
            _patch()
        except Exception:
            pass
    return module


try:
    builtins.__import__ = _hooked_import
except Exception:
    pass
