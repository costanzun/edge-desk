"""Options-implied fair value from the Deribit option chain.

1. Per expiry: forward F (median underlying), OTM mark IVs -> smile in log-moneyness.
2. Smiles are re-expressed in standardised moneyness z = ln(K/F) / (atm_vol * sqrt(T)) so a
   1-day smile can be applied to a 1-hour horizon without pretending strikes scale linearly
   (sticky-delta). ATM total variance is interpolated linearly in time between expiries and
   held at the front expiry's vol below it (flat-forward extrapolation; stated caveat).
3. P(S_T > K) = -dC/dK on the interpolated smile (Breeden-Litzenberger first derivative).
4. Error band: half the spread of P when every vol is bumped by +/- ``vol_unc`` (relative),
   widened when we are extrapolating below the front expiry, plus a spot-staleness term.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import dataclass

from edgedesk.models.pricing import YEAR_S, digital_smile, npdf

MIN_EXPIRY_LEFT_S = 20 * 60  # ignore an expiry with < 20 min left (marks get noisy)


@dataclass
class Smile:
    exp_ms: int
    T: float                 # years from snapshot time
    F: float
    atm: float
    z: list[float]           # standardised moneyness, ascending
    iv: list[float]

    def vol_z(self, z: float) -> float:
        zs = self.z
        if z <= zs[0]:
            return self.iv[0]
        if z >= zs[-1]:
            return self.iv[-1]
        i = bisect.bisect_left(zs, z)
        z0, z1 = zs[i - 1], zs[i]
        w = (z - z0) / (z1 - z0) if z1 > z0 else 0.0
        return self.iv[i - 1] * (1 - w) + self.iv[i] * w


def build_smiles(rows: list[list], t_ms: int) -> list[Smile]:
    """rows: [exp_ms, strike, cp, iv, und, bid, ask, mark] from a chain snapshot."""
    by_exp: dict[int, list[list]] = {}
    for r in rows:
        by_exp.setdefault(int(r[0]), []).append(r)
    smiles = []
    for exp_ms in sorted(by_exp):
        left_s = (exp_ms - t_ms) / 1000
        if left_s < MIN_EXPIRY_LEFT_S:
            continue
        rs = by_exp[exp_ms]
        unds = sorted(r[4] for r in rs)
        F = unds[len(unds) // 2]
        T = left_s / YEAR_S
        pts: dict[float, float] = {}
        for _, K, cp, iv, *_ in rs:
            if (cp == "C" and K >= F) or (cp == "P" and K < F):
                pts[math.log(K / F)] = iv
        if len(pts) < 4:
            continue
        ks = sorted(pts)
        ivs = [pts[k] for k in ks]
        # ATM vol by linear interpolation at k = 0
        j = bisect.bisect_left(ks, 0.0)
        if j == 0:
            atm = ivs[0]
        elif j >= len(ks):
            atm = ivs[-1]
        else:
            w = (0 - ks[j - 1]) / (ks[j] - ks[j - 1])
            atm = ivs[j - 1] * (1 - w) + ivs[j] * w
        sdev = atm * math.sqrt(T)
        smiles.append(Smile(exp_ms, T, F, atm, [k / sdev for k in ks], ivs))
    return smiles


@dataclass
class Fair:
    p: float
    band: float
    sigma: float      # vol used at the strike
    extrapolated: bool


class OptionsImplied:
    name = "options"

    def __init__(self, vol_unc: float = 0.10, extrap_unc: float = 0.10) -> None:
        self.vol_unc = vol_unc
        self.extrap_unc = extrap_unc
        self.smiles: dict[str, list[Smile]] = {}
        self.chain_t: dict[str, int] = {}

    def on_chain(self, sym: str, rows: list[list], t_ns: int) -> None:
        sm = build_smiles(rows, t_ns // 1_000_000)
        if sm:
            self.smiles[sym] = sm
            self.chain_t[sym] = t_ns

    def _atm_var(self, sm: list[Smile], T: float) -> tuple[float, bool]:
        """ATM total variance at T, and whether we extrapolated below the front expiry."""
        if T <= sm[0].T:
            return sm[0].atm ** 2 * T, True
        for a, b in zip(sm, sm[1:]):
            if a.T <= T <= b.T:
                wa, wb = a.atm ** 2 * a.T, b.atm ** 2 * b.T
                return wa + (wb - wa) * (T - a.T) / (b.T - a.T), False
        return sm[-1].atm ** 2 * T, False

    def vol_fn(self, sym: str, spot: float, T: float, scale: float = 1.0):
        sm = self.smiles[sym]
        w_atm, extrap = self._atm_var(sm, T)
        atm_T = math.sqrt(w_atm / T)
        sdev = atm_T * math.sqrt(T)
        # bracketing smiles for the shape in z-space
        if T <= sm[0].T or len(sm) == 1:
            pair = (sm[0], sm[0], 0.0)
        elif T >= sm[-1].T:
            pair = (sm[-1], sm[-1], 0.0)
        else:
            i = next(i for i in range(1, len(sm)) if sm[i].T >= T)
            a, b = sm[i - 1], sm[i]
            pair = (a, b, (T - a.T) / (b.T - a.T))
        a, b, w = pair

        def vol_at(K: float) -> float:
            z = math.log(K / spot) / sdev
            # smile shape relative to each expiry's own ATM, rescaled to the target ATM vol
            ra = a.vol_z(z) / a.atm
            rb = b.vol_z(z) / b.atm
            return atm_T * (ra * (1 - w) + rb * w) * scale

        return vol_at, extrap

    def fair(self, sym: str, spot: float, strike: float, expiry_ms: int, t_ns: int,
             spot_age_s: float = 0.0) -> Fair | None:
        if sym not in self.smiles or spot <= 0:
            return None
        T = (expiry_ms - t_ns / 1e6) / 1000 / YEAR_S
        if T <= 0:
            return None
        # time since the chain snapshot shortens the horizon of each smile slightly; ignored
        vol_at, extrap = self.vol_fn(sym, spot, T)
        p = digital_smile(spot, strike, T, vol_at)
        u = self.vol_unc + (self.extrap_unc if extrap else 0.0)
        hi_fn, _ = self.vol_fn(sym, spot, T, 1 + u)
        lo_fn, _ = self.vol_fn(sym, spot, T, 1 - u)
        band = abs(digital_smile(spot, strike, T, hi_fn) - digital_smile(spot, strike, T, lo_fn)) / 2
        sig = vol_at(strike)
        # spot staleness: the price may have moved by ~ sig * sqrt(age) since our last quote
        sd = sig * math.sqrt(T)
        if spot_age_s > 0 and sd > 0:
            d2 = (math.log(spot / strike) - 0.5 * sd * sd) / sd
            band += npdf(d2) * sig * math.sqrt(spot_age_s / YEAR_S) / sd
        return Fair(p, band, sig, extrap)
