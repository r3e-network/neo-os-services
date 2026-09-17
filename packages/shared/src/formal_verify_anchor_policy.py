"""Integer policy lemmas only; not JS refinement, economic optimality or contract safety."""
import json
from z3 import Int, Solver, Not, unsat

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
