"""Integer policy lemmas only; not JS refinement, economic optimality or contract safety."""
import json
import sys

INSTALL_COMMAND = "python3 -m pip install --user --break-system-packages z3-solver"


def _require_z3():
    """Return the ``z3`` module, or abort with remediation and a non-zero exit.

    This gate is deliberately fail-closed: a missing, shadowed or mislinked Z3
    binding must stop the run, never downgrade it to a skip. A prover that
    reports success while the solver is absent is not evidence.
    """
    try:
        import z3
    except ImportError as exc:
        _abort("the Python module `z3` is not importable", exc)
    except Exception as exc:  # e.g. AttributeError from a dlsym against a mismatched libz3
        _abort(
            "the Python module `z3` failed to initialise, which usually means "
            "its bindings and the libz3 shared library are different versions",
            f"{type(exc).__name__}: {exc}",
        )

    if getattr(z3, "__file__", None) is None:
        _abort(
            "the name `z3` resolved to an empty namespace package with no "
            "importable contents, not to a real Z3 binding",
            f"empty directories claiming the name: {list(getattr(z3, '__path__', []))}",
        )

    missing = [name for name in ("Int", "Not", "Solver", "unsat") if not hasattr(z3, name)]
    if missing:
        _abort(
            "the resolved `z3` binding is incomplete",
            f"loaded from {z3.__file__}; missing: {', '.join(missing)}",
        )

    try:
        z3.get_version_string()
    except Exception as exc:
        _abort(
            "the resolved `z3` binding could not reach its solver library",
            f"loaded from {z3.__file__}; {type(exc).__name__}: {exc}",
        )

    return z3


def _abort(reason, detail=None):
    lines = [
        "FORMAL VERIFICATION TOOLCHAIN UNAVAILABLE - refusing to report a result.",
        "",
        f"  reason:      {reason}",
    ]
    if detail:
        lines.append(f"  detail:      {detail}")
    lines += [
        f"  interpreter: {sys.executable}",
        f"  version:     {sys.version.split()[0]}",
        "",
        "Install the Python binding for Z3, then re-run:",
        "",
        f"    {INSTALL_COMMAND}",
        "",
        "Why the wheel and not Homebrew: the `z3` formula installs its Python",
        "binding only for the Python version that formula was built against. A",
        "`brew upgrade z3` can therefore move the binding to a Python version",
        "that is not installed and leave an empty directory behind on sys.path,",
        "which then resolves as an implicit PEP 420 namespace package named",
        "`z3` with no importable contents. The `z3-solver` wheel ships its own",
        "matching libz3 and survives Homebrew upgrades.",
        "",
        "Why those flags: a Homebrew Python is marked externally managed (PEP",
        "668), so pip refuses to install without `--break-system-packages`.",
        "Pairing it with `--user` is what Homebrew itself recommends: the wheel",
        "lands in the per-user site-packages and Homebrew's own site-packages is",
        "left untouched. A virtual environment works too, but these provers are",
        "invoked as bare `python3` by npm and would not see it unless activated.",
        "",
        "Do not silence this check. This step must fail when the solver is",
        "absent; a prover that passes without a solver is not evidence.",
    ]
    print("\n".join(lines), file=sys.stderr)
    raise SystemExit(1)


_z3 = _require_z3()
Int, Solver, Not, unsat = _z3.Int, _z3.Solver, _z3.Not, _z3.unsat

reward, fee, current, target, threshold = [Int(name) for name in
    ('reward', 'fee_bps', 'current_net', 'target_net', 'threshold_bps')]
maximum = 9007199254740991
net = reward * (10000 - fee) / 10000
improvement = (target - current) * 10000 / current
assumptions = [reward >= 0, reward <= maximum, fee >= 0, fee <= 10000,
    current > 0, current <= target, target <= maximum,
    threshold >= 0, threshold <= maximum]
claims = {
    'net_nonnegative': net >= 0,
    'net_does_not_exceed_gross': net <= reward,
    'fee_rounding_error_below_one_unit': reward * (10000 - fee) - net * 10000 < 10000,
    'improvement_nonnegative': improvement >= 0,
    'improvement_rounding_error_below_one_bp': (target - current) * 10000 < (improvement + 1) * current,
    'threshold_matches_exact_cross_product': (improvement >= threshold) == ((target - current) * 10000 >= threshold * current),
}
results = {}
for name, claim in claims.items():
    solver = Solver()
    solver.set(timeout=10000)
    solver.add(*assumptions, Not(claim))
    result = solver.check()
    if result != unsat:
        raise AssertionError(f'{name}: {result}')
    results[name] = str(result)
print(json.dumps({
    'scope': 'Integer model for fee and positive-current reward comparison; not whole-system verification',
    'max_input_integer': maximum,
    'assumptions': '0<=fee<=10000; 0<current<=target; nonnegative integer threshold; trusted comparable reward observations',
    'obligations': results,
}, indent=2))
