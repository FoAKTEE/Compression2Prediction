"""N1 tests: guide §12.2 reference cases plus row-convention and product checks."""

import pytest

from c2p.kernels import (
    UNIT,
    Kernel,
    Space,
    constant,
    copy,
    discard,
    fit_counts,
    forecast,
    identity,
    posterior,
    product,
    product_all,
)

BIT = Space("Bit", ("0", "1"))
COIN = Kernel(UNIT, BIT, ((0.5, 0.5),))
FLIP = Kernel(BIT, BIT, ((0.8, 0.2), (0.1, 0.9)))


def approx_vector(left, right):
    assert len(left) == len(right)
    for a, b in zip(left, right):
        assert a == pytest.approx(b, rel=0.0, abs=1e-12)


# Guide §12.2 reference cases, same numbers and assertions.


def test_reference_reject_unnormalized():
    with pytest.raises(ValueError):
        Kernel(UNIT, BIT, ((0.2, 0.2),))


def test_reference_reject_nan():
    with pytest.raises(ValueError):
        Kernel(UNIT, BIT, ((float("nan"), 1.0),))


def test_reference_reject_negative():
    with pytest.raises(ValueError):
        Kernel(UNIT, BIT, ((-0.1, 1.1),))


def test_reference_type_mismatch():
    other = Space("NotBit", ("0", "1"))
    with pytest.raises(ValueError):
        COIN.then(identity(other))


def test_reference_identity():
    assert FLIP.then(identity(BIT)) == FLIP
    assert identity(BIT).then(FLIP) == FLIP


def test_reference_associativity():
    left = COIN.then(FLIP).then(FLIP)
    right = COIN.then(FLIP.then(FLIP))
    approx_vector(left.rows[0], right.rows[0])


def test_reference_discard():
    assert FLIP.then(discard(BIT)) == discard(BIT)


def test_reference_copy_is_not_resampling():
    copied = COIN.then(copy(BIT)).rows[0]
    independent = COIN.tensor(COIN).rows[0]
    approx_vector(copied, (0.5, 0.0, 0.0, 0.5))
    approx_vector(independent, (0.25, 0.25, 0.25, 0.25))


def test_reference_tensor_order():
    assert product(BIT, BIT).values == ('["0","0"]', '["0","1"]', '["1","0"]', '["1","1"]')
    approx_vector(FLIP.tensor(FLIP).rows[0], (0.64, 0.16, 0.16, 0.04))


def test_reference_hard_intervention_ignores_parents():
    replacement = constant(BIT, BIT, "1")
    assert replacement.rows == ((0.0, 1.0), (0.0, 1.0))


def test_reference_bad_intervention():
    with pytest.raises(ValueError):
        constant(BIT, BIT, "missing")


def test_reference_bayes_update():
    emission = Kernel(BIT, Space("Signal", ("absent", "present")),
                      ((0.9, 0.1), (0.2, 0.8)))
    approx_vector(posterior((0.5, 0.5), emission, "present"), (1 / 9, 8 / 9))


def test_reference_zero_evidence_is_not_silently_repaired():
    emission = Kernel(BIT, BIT, ((1.0, 0.0), (1.0, 0.0)))
    with pytest.raises(ValueError):
        posterior((0.5, 0.5), emission, "1")


def test_reference_prior_for_unseen_row():
    prior = Kernel(BIT, BIT, ((0.5, 0.5), (0.5, 0.5)))
    fitted = fit_counts(BIT, ((8, 2), (0, 0)), prior, 2.0)
    approx_vector(fitted.rows[0], (0.75, 0.25))
    approx_vector(fitted.rows[1], (0.5, 0.5))


def test_reference_zero_horizon():
    approx_vector(forecast((1.0, 0.0), FLIP, 0), (1.0, 0.0))


def test_reference_negative_horizon():
    with pytest.raises(ValueError):
        forecast((1.0, 0.0), FLIP, -1)


def test_reference_illustrative_incident_forecast():
    incident = Space("IncidentStatus", ("unacknowledged", "acknowledged", "resolved"))
    baseline = Kernel(incident, incident,
                      ((0.6, 0.3, 0.1), (0.0, 0.7, 0.3), (0.0, 0.0, 1.0)))
    extra_crew = Kernel(incident, incident,
                        ((0.3, 0.4, 0.3), (0.0, 0.4, 0.6), (0.0, 0.0, 1.0)))
    approx_vector(forecast((1, 0, 0), baseline, 2), (0.36, 0.39, 0.25))
    approx_vector(forecast((1, 0, 0), extra_crew, 2), (0.09, 0.28, 0.63))


# Additional N1 acceptance checks (memo §1.2 and §4.4, init.md §1.4).


def test_tensor_order():
    assert product(BIT, BIT).values == ('["0","0"]', '["0","1"]', '["1","0"]', '["1","1"]')
    approx_vector(COIN.then(copy(BIT)).rows[0], (0.5, 0, 0, 0.5))


def test_product_all_unit_single_and_left_fold():
    a = Space("A", ("a0", "a1"))
    b = Space("B", ("b0", "b1", "b2"))
    c = Space("C", ("c0", "c1"))
    assert product_all([]) == UNIT
    assert product_all(()) is UNIT
    assert product_all([a]) is a
    assert product_all([a]) == a
    folded = product_all([a, b, c])
    assert folded.name == "((A*B)*C)"
    assert folded.values == product(product(a, b), c).values
    assert folded == product(product(a, b), c)
    assert folded.values != product(a, product(b, c)).values


def test_composition_matches_matrix_product():
    x = Space("X", ("x0", "x1", "x2"))
    y = Space("Y", ("y0", "y1", "y2"))
    z = Space("Z", ("z0", "z1"))
    k = Kernel(x, y, ((0.5, 0.25, 0.25), (0.1, 0.6, 0.3), (0.0, 0.2, 0.8)))
    l = Kernel(y, z, ((0.9, 0.1), (0.3, 0.7), (0.4, 0.6)))
    composed = k.then(l)
    assert composed.source == x
    assert composed.target == z
    expected = tuple(
        tuple(sum(k.rows[i][j] * l.rows[j][m] for j in range(3)) for m in range(2))
        for i in range(3)
    )
    assert len(composed.rows) == 3
    for row, expected_row in zip(composed.rows, expected):
        approx_vector(row, expected_row)
    # Row 0 by hand: 0.5*0.9 + 0.25*0.3 + 0.25*0.4 = 0.625.
    approx_vector(composed.rows[0], (0.625, 0.375))
    # The other order does not typecheck, so a silent transpose cannot slip in.
    with pytest.raises(ValueError):
        l.then(k)


def test_forecast_rejects_bool_steps():
    with pytest.raises(ValueError):
        forecast((1.0, 0.0), FLIP, True)
