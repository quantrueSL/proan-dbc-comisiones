"""Conciliación por cortes — motor puro (sin BigQuery ni Firestore).

Recibe pagos (`DBC_gold_conciliacion_pago_documento`), cobros diarios por
comisionista y división, y las decisiones guardadas del usuario; devuelve la
ventana efectiva de cada pago, su estado y las sugerencias. No lee ni escribe
nada: los endpoints lo alimentan y guardan lo que devuelve.

MODELO
  - Un pago se identifica por su documento (`doc_id`, BUKRS|GJAHR|BELNR), nunca
    por el texto. Si dos documentos comparten fila (sociedad, comisionista,
    división) y ventana, son UN pago y su id es el menor `doc_id`.
  - La ventana por defecto sale del texto del pago; el usuario la ajusta con
    `overrides` ({pago_id: {"ini": fecha, "fin": fecha}}). Un pago consolidado
    se lee de su `Foto` y no se vuelve a calcular.
  - Un "corte" es el borde compartido de dos pagos contiguos (fin de uno + 1 día
    = inicio del otro): moverlo mueve los dos. Si hay hueco o traslape entre
    pagos no hay corte compartido y cada borde se mueve por su cuenta.
  - Los cobros sin pago se ven como `huecos`; los días cubiertos por dos pagos,
    como `traslapes`. Ninguno se bloquea (en los datos reales hay 6.6% de huecos
    y 1.2% de traslapes entre pagos consecutivos).
  - Un borde congelado (de un pago consolidado) no se sugiere ni se mueve.

SUGERENCIAS
  Cada generador recibe el contexto de una fila y el índice de un pago y
  devuelve una `Sugerencia` o None. Hoy solo existe `sugerir_borde`; sumar otro
  tipo (p. ej. Abarrotes con Huevo) es agregar una función a `GENERADORES`.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Callable, Iterable, Mapping

TOLERANCIA = 1.0  # pesos: dentro de esto un pago "cuadra"
MAX_DESPLAZAMIENTO = 3  # días que una sugerencia de borde puede mover cada corte

OK = "ok"
SUGERENCIA = "sug"
SIN_EXPLICACION = "sin"
SIN_VENTANA = "sinv"
CONSOLIDADO = "cons"

DIA = timedelta(days=1)

FilaKey = tuple[str, str, "str | None"]  # (sociedad, comisionista_id, division_code)


class ErrorCorte(ValueError):
    """Un cambio de corte que no se puede aplicar; `codigo` lo distingue para la API."""

    def __init__(self, codigo: str, mensaje: str):
        super().__init__(mensaje)
        self.codigo = codigo


# ─── Entradas ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DocPago:
    doc_id: str
    sociedad: str
    comisionista_id: str
    division_code: str | None
    desde: date | None
    hasta: date | None
    pagado: float

    @classmethod
    def desde_fila(cls, fila: Mapping) -> "DocPago":
        """Fila de `DBC_gold_conciliacion_pago_documento` (la ventana solo cuenta si es válida)."""
        valida = bool(fila.get("ventana_valida"))
        return cls(
            doc_id=fila["doc_id"],
            sociedad=fila["sociedad"],
            comisionista_id=fila["comisionista_id"],
            division_code=fila.get("division_code"),
            desde=fila.get("desde_texto") if valida else None,
            hasta=fila.get("hasta_texto") if valida else None,
            pagado=float(fila["pagado"] or 0.0),
        )


class SerieDiaria:
    """Comisión por día con suma de rango en O(log n)."""

    def __init__(self, dias: Mapping[date, float] | None = None):
        dias = dias or {}
        self._fechas = sorted(dias)
        self._acum = [0.0]
        for f in self._fechas:
            self._acum.append(self._acum[-1] + float(dias[f] or 0.0))

    def suma(self, ini: date | None, fin: date | None) -> float:
        if ini is None or fin is None or ini > fin:
            return 0.0
        a = bisect_left(self._fechas, ini)
        b = bisect_right(self._fechas, fin)
        return self._acum[b] - self._acum[a]


@dataclass(frozen=True)
class Foto:
    """Lo que se congela al consolidar un pago."""

    ini: date
    fin: date
    pagado: float
    calculado: float


@dataclass
class EstadoFila:
    """Decisiones guardadas de una fila (lo que vive en Firestore)."""

    overrides: dict[str, dict[str, date]] = field(default_factory=dict)
    consolidados: dict[str, Foto] = field(default_factory=dict)
    descartadas: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class Pago:
    """Un pago ya agrupado, con la ventana que propone el texto (puede faltar)."""

    pago_id: str
    docs: tuple[str, ...]
    sociedad: str
    comisionista_id: str
    division_code: str | None
    ini: date | None
    fin: date | None
    pagado: float


def agrupar_pagos(docs: Iterable[DocPago]) -> dict[FilaKey, list[Pago]]:
    """Agrupa documentos en pagos por fila y ventana; los sin ventana quedan sueltos."""
    por_fila: dict[FilaKey, dict[tuple, list[DocPago]]] = defaultdict(lambda: defaultdict(list))
    for d in docs:
        llave = (d.sociedad, d.comisionista_id, d.division_code)
        grupo = (d.desde, d.hasta) if d.desde and d.hasta else ("sin", d.doc_id)
        por_fila[llave][grupo].append(d)

    out: dict[FilaKey, list[Pago]] = {}
    for llave, grupos in por_fila.items():
        pagos = []
        for (ini, fin), ds in grupos.items():
            ids = tuple(sorted(x.doc_id for x in ds))
            con_ventana = ini != "sin"
            pagos.append(
                Pago(
                    pago_id=ids[0],
                    docs=ids,
                    sociedad=llave[0],
                    comisionista_id=llave[1],
                    division_code=llave[2],
                    ini=ini if con_ventana else None,
                    fin=fin if con_ventana else None,
                    pagado=round(sum(x.pagado for x in ds), 2),
                )
            )
        pagos.sort(key=lambda p: (p.ini is None, p.ini or date.min, p.fin or date.min, p.pago_id))
        out[llave] = pagos
    return out


# ─── Salidas ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CambioBorde:
    pago_id: str
    borde: str  # "ini" | "fin"
    de: date
    a: date


@dataclass(frozen=True)
class Afectado:
    pago_id: str
    ini_antes: date
    fin_antes: date
    ini_despues: date
    fin_despues: date
    diferencia_antes: float
    diferencia_despues: float


@dataclass(frozen=True)
class Sugerencia:
    tipo: str
    pago_id: str
    cambios: tuple[CambioBorde, ...]
    afectados: tuple[Afectado, ...]
    unica: bool
    n_opciones: int


@dataclass
class PagoResuelto:
    pago_id: str
    docs: tuple[str, ...]
    ini: date | None
    fin: date | None
    ini_default: date | None
    fin_default: date | None
    pagado: float
    calculado: float | None
    diferencia: float | None
    estado: str
    sin_calculo: bool = False
    drift: float | None = None  # consolidado: calculado vivo - calculado congelado
    sugerencia: Sugerencia | None = None

    @property
    def ajustado(self) -> bool:
        return (self.ini, self.fin) != (self.ini_default, self.fin_default)


@dataclass(frozen=True)
class Hueco:
    ini: date
    fin: date
    comision: float
    despues_de: str
    antes_de: str


@dataclass(frozen=True)
class Traslape:
    ini: date
    fin: date
    pagos: tuple[str, str]


@dataclass(frozen=True)
class Corte:
    izq: str
    der: str
    fecha: date  # último día del pago de la izquierda
    congelado: bool


@dataclass
class FilaResuelta:
    key: FilaKey
    pagos: list[PagoResuelto]
    huecos: list[Hueco]
    traslapes: list[Traslape]
    cortes: list[Corte]
    overrides: dict[str, dict[str, date]]

    def pago(self, pago_id: str) -> PagoResuelto:
        for p in self.pagos:
            if p.pago_id == pago_id:
                return p
        raise KeyError(pago_id)

    # --- Cambios (devuelven el nuevo `overrides`; el llamante lo guarda) ---

    def _con(self, cambios: Iterable[CambioBorde]) -> dict[str, dict[str, date]]:
        nuevo = {k: dict(v) for k, v in self.overrides.items()}
        for c in cambios:
            p = self.pago(c.pago_id)
            nuevo.setdefault(c.pago_id, {})[c.borde] = c.a
            if c.a == (p.ini_default if c.borde == "ini" else p.fin_default):
                nuevo[c.pago_id].pop(c.borde)
        return {k: v for k, v in nuevo.items() if v}

    def aplicar_sugerencia(self, s: Sugerencia) -> dict[str, dict[str, date]]:
        for c in s.cambios:
            if self._congelado(c.pago_id):
                raise ErrorCorte("corte_congelado", "El pago está consolidado.")
        return self._con(s.cambios)

    def mover_corte(self, izq_id: str, nueva_fecha: date) -> dict[str, dict[str, date]]:
        """Mueve el corte entre un pago y el siguiente (deben ser contiguos)."""
        corte = next((c for c in self.cortes if c.izq == izq_id), None)
        if corte is None:
            raise ErrorCorte("no_contiguos", "Los pagos no comparten un corte (hay hueco o traslape).")
        if corte.congelado:
            raise ErrorCorte("corte_congelado", "El corte pertenece a un pago consolidado.")
        izq, der = self.pago(corte.izq), self.pago(corte.der)
        if not (izq.ini <= nueva_fecha < der.fin):
            raise ErrorCorte("ventana_invalida", "El corte debe dejar al menos un día en cada pago.")
        return self._con(
            [
                CambioBorde(izq.pago_id, "fin", izq.fin, nueva_fecha),
                CambioBorde(der.pago_id, "ini", der.ini, nueva_fecha + DIA),
            ]
        )

    def mover_borde(self, pago_id: str, borde: str, nueva_fecha: date) -> dict[str, dict[str, date]]:
        """Mueve un borde que NO es un corte compartido (hueco, traslape o extremo)."""
        if borde not in ("ini", "fin"):
            raise ErrorCorte("borde_invalido", "El borde debe ser 'ini' o 'fin'.")
        p = self.pago(pago_id)
        if self._congelado(pago_id):
            raise ErrorCorte("corte_congelado", "El pago está consolidado.")
        if any((c.izq == pago_id and borde == "fin") or (c.der == pago_id and borde == "ini") for c in self.cortes):
            raise ErrorCorte("usa_mover_corte", "Ese borde es un corte compartido: muévelo como corte.")
        ini, fin = (nueva_fecha, p.fin) if borde == "ini" else (p.ini, nueva_fecha)
        if ini is None or fin is None or ini > fin:
            raise ErrorCorte("ventana_invalida", "La ventana quedaría vacía o invertida.")
        return self._con([CambioBorde(pago_id, borde, p.ini if borde == "ini" else p.fin, nueva_fecha)])

    def _congelado(self, pago_id: str) -> bool:
        return self.pago(pago_id).estado == CONSOLIDADO

    def plan_lote(self) -> list[str]:
        """Pagos consolidables de izquierda a derecha: se detiene en el primero que no cuadra."""
        plan = []
        for p in self.pagos:
            if p.estado == CONSOLIDADO:
                continue
            if p.estado == OK:
                plan.append(p.pago_id)
            else:
                break
        return plan

    def foto(self, pago_id: str) -> Foto:
        p = self.pago(pago_id)
        if p.estado == CONSOLIDADO:
            raise ErrorCorte("ya_consolidado", "El pago ya está consolidado.")
        if p.ini is None or p.fin is None:
            raise ErrorCorte("sin_ventana", "El pago no tiene ventana.")
        return Foto(p.ini, p.fin, p.pagado, p.calculado or 0.0)


# ─── Resolución ──────────────────────────────────────────────────────────


@dataclass
class _V:
    """Ventana de trabajo de un pago (mutable solo dentro de una simulación)."""

    pago_id: str
    ini: date
    fin: date
    pagado: float
    cons: bool
    frozen_calc: float | None = None


class _Ctx:
    def __init__(self, vs: list[_V], serie: SerieDiaria, descartadas: set[str]):
        self.vs = vs
        self.serie = serie
        self.descartadas = descartadas

    def calc(self, v: _V) -> float:
        return v.frozen_calc if v.cons and v.frozen_calc is not None else self.serie.suma(v.ini, v.fin)

    def dif(self, v: _V) -> float:
        return self.calc(v) - v.pagado


def _solape(a: _V, b: _V) -> int:
    """Días que comparten dos pagos consecutivos (0 si no se tocan)."""
    return max(0, (a.fin - b.ini).days + 1)


def resolver_fila(
    key: FilaKey,
    pagos: list[Pago],
    serie: SerieDiaria,
    estado: EstadoFila | None = None,
    sugerir_en: tuple[date, date] | None = None,
) -> FilaResuelta:
    """`sugerir_en`: si se da, solo se buscan sugerencias en los pagos que tocan ese rango; los demás
    (vecinos cargados de margen) quedan como "sin explicación" sin gastar la búsqueda."""
    estado = estado or EstadoFila()
    vs: list[_V] = []
    sin_ventana: list[PagoResuelto] = []
    defaults: dict[str, tuple[date | None, date | None]] = {}

    for p in pagos:
        defaults[p.pago_id] = (p.ini, p.fin)
        foto = estado.consolidados.get(p.pago_id)
        if foto:
            vs.append(_V(p.pago_id, foto.ini, foto.fin, foto.pagado, True, foto.calculado))
            continue
        ov = estado.overrides.get(p.pago_id, {})
        ini, fin = ov.get("ini", p.ini), ov.get("fin", p.fin)
        if ini is None or fin is None or ini > fin:
            sin_ventana.append(
                PagoResuelto(p.pago_id, p.docs, None, None, p.ini, p.fin, p.pagado, None, None, SIN_VENTANA)
            )
        else:
            vs.append(_V(p.pago_id, ini, fin, p.pagado, False))

    vs.sort(key=lambda v: (v.ini, v.fin, v.pago_id))
    ctx = _Ctx(vs, serie, estado.descartadas)
    docs_de = {p.pago_id: p.docs for p in pagos}

    resueltos: list[PagoResuelto] = []
    for i, v in enumerate(vs):
        calculado = ctx.calc(v)
        dif = calculado - v.pagado
        ini_d, fin_d = defaults[v.pago_id]
        r = PagoResuelto(
            v.pago_id, docs_de[v.pago_id], v.ini, v.fin, ini_d, fin_d, v.pagado,
            round(calculado, 2), round(dif, 2), OK, sin_calculo=calculado == 0,
        )
        if v.cons:
            r.estado = CONSOLIDADO
            r.drift = round(serie.suma(v.ini, v.fin) - (v.frozen_calc or 0.0), 2)
        elif abs(dif) > TOLERANCIA:
            fuera = sugerir_en is not None and not (v.ini <= sugerir_en[1] and v.fin >= sugerir_en[0])
            r.sugerencia = None if fuera or v.pago_id in ctx.descartadas else _mejor_sugerencia(ctx, i)
            r.estado = SUGERENCIA if r.sugerencia else SIN_EXPLICACION
        resueltos.append(r)

    huecos, traslapes, cortes = [], [], []
    for a, b in zip(vs, vs[1:]):
        if b.ini > a.fin + DIA:
            ini, fin = a.fin + DIA, b.ini - DIA
            huecos.append(Hueco(ini, fin, round(serie.suma(ini, fin), 2), a.pago_id, b.pago_id))
        elif b.ini <= a.fin:
            traslapes.append(Traslape(b.ini, min(a.fin, b.fin), (a.pago_id, b.pago_id)))
        else:
            cortes.append(Corte(a.pago_id, b.pago_id, a.fin, a.cons or b.cons))

    return FilaResuelta(key, resueltos + sin_ventana, huecos, traslapes, cortes, dict(estado.overrides))


# ─── Sugerencias ─────────────────────────────────────────────────────────


def _mejor_sugerencia(ctx: _Ctx, i: int) -> Sugerencia | None:
    for gen in GENERADORES:
        s = gen(ctx, i)
        if s:
            return s
    return None


def sugerir_borde(ctx: _Ctx, i: int) -> Sugerencia | None:
    """Mover hasta 3 días el corte de la izquierda, el de la derecha o los dos, para dejar el pago en $0."""
    vs, v = ctx.vs, ctx.vs[i]
    izq = vs[i - 1] if i > 0 else None
    der = vs[i + 1] if i + 1 < len(vs) else None
    acopla_izq = izq if izq and izq.fin + DIA == v.ini else None
    acopla_der = der if der and v.fin + DIA == der.ini else None
    if v.cons:
        return None
    # un corte compartido con un pago consolidado está congelado: ese lado no se mueve
    libre_izq = not (acopla_izq and acopla_izq.cons)
    libre_der = not (acopla_der and acopla_der.cons)

    rango = range(-MAX_DESPLAZAMIENTO, MAX_DESPLAZAMIENTO + 1)
    candidatas = []
    for dl in rango if libre_izq else (0,):
        for dr in rango if libre_der else (0,):
            if dl == 0 and dr == 0:
                continue
            c = _evaluar(ctx, i, dl, dr, acopla_izq, acopla_der)
            if c:
                candidatas.append(c)
    if not candidatas:
        return None

    candidatas.sort(key=lambda c: (c["total"], c["n_bordes"], c["magnitud"]))
    mejor = candidatas[0]
    unica = all(c["vector"] == mejor["vector"] for c in candidatas)
    return Sugerencia("borde", v.pago_id, mejor["cambios"], mejor["afectados"], unica, len(candidatas))


def _evaluar(ctx: _Ctx, i: int, dl: int, dr: int, acopla_izq: _V | None, acopla_der: _V | None) -> dict | None:
    vs, v = ctx.vs, ctx.vs[i]
    izq = vs[i - 1] if i > 0 else None
    der = vs[i + 1] if i + 1 < len(vs) else None

    nuevo = {v.pago_id: (v.ini + dl * DIA, v.fin + dr * DIA)}
    if acopla_izq and dl:
        nuevo[acopla_izq.pago_id] = (acopla_izq.ini, acopla_izq.fin + dl * DIA)
    if acopla_der and dr:
        nuevo[acopla_der.pago_id] = (der.ini + dr * DIA, der.fin)

    por_id = {x.pago_id: x for x in vs}
    for pid, (ini, fin) in nuevo.items():
        if ini > fin:
            return None

    def ventana(x: _V) -> _V:
        n = nuevo.get(x.pago_id)
        return replace(x, ini=n[0], fin=n[1]) if n else x

    # no crear más traslape del que ya había con los vecinos
    for a, b in ((izq, v), (v, der)):
        if a and b and _solape(ventana(a), ventana(b)) > _solape(a, b):
            return None

    nv = ventana(v)
    if abs(ctx.serie.suma(nv.ini, nv.fin) - nv.pagado) > TOLERANCIA:
        return None

    total = 0.0
    vector = []
    afectados = []
    for x in vs:
        w = ventana(x)
        d_ant, d_new = ctx.dif(x), ctx.dif(w)
        total += abs(d_new)
        vector.append(round(d_new, 2))
        if x.pago_id in nuevo:
            afectados.append(
                Afectado(x.pago_id, x.ini, x.fin, w.ini, w.fin, round(d_ant, 2), round(d_new, 2))
            )

    cambios = []
    for pid, (ini, fin) in nuevo.items():
        x = por_id[pid]
        if ini != x.ini:
            cambios.append(CambioBorde(pid, "ini", x.ini, ini))
        if fin != x.fin:
            cambios.append(CambioBorde(pid, "fin", x.fin, fin))
    return {
        "cambios": tuple(cambios),
        "afectados": tuple(afectados),
        "total": total,
        "vector": tuple(vector),
        "n_bordes": (dl != 0) + (dr != 0),
        "magnitud": abs(dl) + abs(dr),
    }


GENERADORES: list[Callable[[_Ctx, int], "Sugerencia | None"]] = [sugerir_borde]


# ─── Conjunto de filas ───────────────────────────────────────────────────


def construir_filas(
    docs: Iterable[DocPago],
    diario: Iterable[Mapping],
    estados: Mapping[FilaKey, EstadoFila] | None = None,
    sugerir_en: tuple[date, date] | None = None,
) -> dict[FilaKey, FilaResuelta]:
    """Resuelve todas las filas. `diario`: dicts con sociedad, comisionista_id, division_code, fecha, comision."""
    dias: dict[FilaKey, dict[date, float]] = defaultdict(dict)
    for r in diario:
        k = (r["sociedad"], r["comisionista_id"], r["division_code"])
        dias[k][r["fecha"]] = dias[k].get(r["fecha"], 0.0) + float(r["comision"] or 0.0)

    estados = estados or {}
    out = {}
    for key, pagos in agrupar_pagos(docs).items():
        out[key] = resolver_fila(key, pagos, SerieDiaria(dias.get(key)), estados.get(key), sugerir_en)
    return out
