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
  - Cierre de mes: lo cobrado el último día CON COBROS de cada mes no entra en el pago de esa semana
    (regla del cliente); ver `aplicar_cierre_de_mes`. Queda como hueco y, si con él un pago posterior cuadra
    exacto, se sugiere asignárselo (`sugerir_cierre`); lo asignado se guarda en `dias_asignados`.

SUGERENCIAS
  Cada generador recibe el contexto de una fila y el índice de un pago y
  devuelve una `Sugerencia` o None: `sugerir_cierre` (asignar el día de cierre a un pago) y `sugerir_borde`
  (mover cortes). Sumar otro tipo es agregar una función a `GENERADORES`.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Callable, Collection, Iterable, Mapping

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
    # Días sueltos que la persona asignó a un pago, además de su ventana: {pago_id: [fecha, ...]}.
    dias_asignados: dict[str, list[date]] = field(default_factory=dict)


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


def _es_fin_de_mes(d: date) -> bool:
    return (d + DIA).month != d.month


def ultimos_dias_con_cobros(total_por_dia: Mapping[date, float]) -> frozenset[date]:
    """El último día con cobros de cada mes cerrado (hay datos de un mes posterior), con todas las filas juntas.

    El mes más reciente de los datos se deja fuera: todavía puede tener cobros después de su último día cargado.
    """
    por_mes: dict[tuple[int, int], date] = {}
    for dia, monto in total_por_dia.items():
        if monto > 0:
            m = (dia.year, dia.month)
            if m not in por_mes or dia > por_mes[m]:
                por_mes[m] = dia
    if not por_mes:
        return frozenset()
    ultimo_mes = max((d.year, d.month) for d in total_por_dia)
    return frozenset(d for m, d in por_mes.items() if m < ultimo_mes)


def _hueco_de_cierre(ini: date, fin: date, cierres: "Collection[date] | None") -> bool:
    """El bloque de fin de mes: los días sin pago que terminan en el día de cierre (hasta una semana)."""
    if cierres is None:
        return ini == fin and _es_fin_de_mes(ini)
    return fin in cierres and (fin - ini).days < 7


def _es_cierre(d: date, cierres: "Collection[date] | None") -> bool:
    """`cierres` None = el último día del calendario; si no, solo esos días (el último día con cobros de cada mes)."""
    return _es_fin_de_mes(d) if cierres is None else d in cierres


def aplicar_cierre_de_mes(pagos: list[Pago], cierres: "Collection[date] | None" = None) -> list[Pago]:
    """Regla del cliente: lo cobrado el último día con cobros de cada mes no entra en el pago de esa semana.

    El cierre se hace durante ese día y no alcanza a entrar. Un pago cuya ventana termina en ese día pasa a
    terminar un día antes. Ese día queda como un hueco de un día (`Hueco.cierre`) y no se le asigna a ningún pago
    por defecto: medido sobre 740 casos con cobros ese día, sacarlo del pago deja cuadrando 225 pagos (de 7 a 232
    de 734). Dónde se paga después cambia de un mes a otro y de un comisionista a otro (1.º, 2.º o 3.º pago del
    mes siguiente, y a veces solo una parte), así que no se adivina: `sugerir_cierre` lo propone solo donde
    cuadra exacto. Solo mueve extremos exactos: una ventana que cruza ese día por dentro no se toca.
    """
    salida = []
    for p in pagos:
        if p.ini and p.fin and _es_cierre(p.fin, cierres) and p.fin > p.ini:
            p = replace(p, fin=p.fin - DIA)
        salida.append(p)
    return salida


def _es_inicio_de_tramo(d: date) -> bool:
    return d.weekday() == 5 or d.day == 1  # sábado, o primer día del mes


def _es_fin_de_tramo(d: date) -> bool:
    return d.weekday() == 4 or _es_fin_de_mes(d)  # viernes, o último día del mes


def _tramo_mas_cercano(d: date, cumple) -> date:
    """El día más cercano a `d` que cumple `cumple`; si hay dos a la misma distancia, el anterior."""
    for k in range(0, 8):
        for candidato in (d - timedelta(days=k), d + timedelta(days=k)):
            if cumple(candidato):
                return candidato
    return d


def ventana_estandar(desde: date, hasta: date) -> tuple[date, date]:
    """La ventana del texto acomodada a las semanas sábado-viernes y al fin de mes.

    El texto de SAP trae ventanas que se traslapan o se corren un día ("5 al 12" y "12 al 18"); la regla del
    negocio es la semana sábado a viernes, cortada en el cambio de mes. Cada borde se lleva al inicio o fin de
    tramo más cercano. Si así la ventana quedara al revés (un texto de un solo día suelto), se deja como viene.
    """
    ini = _tramo_mas_cercano(desde, _es_inicio_de_tramo)
    fin = _tramo_mas_cercano(hasta, _es_fin_de_tramo)
    return (ini, fin) if ini <= fin else (desde, hasta)


def _sin_traslapes(pagos: list[Pago]) -> list[Pago]:
    """Si un pago empieza antes de que acabe el anterior, empieza el día siguiente (los pagos ya vienen ordenados)."""
    salida: list[Pago] = []
    for p in pagos:
        previo = next((q for q in reversed(salida) if q.ini is not None), None)
        if previo is not None and p.ini is not None and p.ini <= previo.fin < p.fin:
            p = replace(p, ini=previo.fin + DIA)
        salida.append(p)
    return salida


def agrupar_pagos(
    docs: Iterable[DocPago],
    cierre_de_mes: bool = True,
    estandar: bool = True,
    cierres: Collection[date] | None = None,
) -> dict[FilaKey, list[Pago]]:
    """Agrupa documentos en pagos por fila y ventana; los sin ventana quedan sueltos.

    Con `estandar` la ventana de cada pago es la del texto acomodada a sábado-viernes y fin de mes
    (`ventana_estandar`) y los pagos no se traslapan; dos documentos que quedan en la misma ventana son un pago.
    """
    por_fila: dict[FilaKey, dict[tuple, list[DocPago]]] = defaultdict(lambda: defaultdict(list))
    for d in docs:
        llave = (d.sociedad, d.comisionista_id, d.division_code)
        if d.desde and d.hasta:
            grupo = ventana_estandar(d.desde, d.hasta) if estandar else (d.desde, d.hasta)
        else:
            grupo = ("sin", d.doc_id)
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
        if estandar:
            pagos = _sin_traslapes(pagos)
        out[llave] = aplicar_cierre_de_mes(pagos, cierres) if cierre_de_mes else pagos
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
    # Tipo "cierre": los días sueltos que se le asignan al pago (no hay cambios de borde).
    dias_asignar: tuple[date, ...] = ()


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
    drift_pagado: float | None = None  # consolidado: pagado vivo - pagado congelado
    descartada: bool = False  # la persona descartó la sugerencia de este pago
    sugerencia: Sugerencia | None = None
    dias_asignados: tuple[date, ...] = ()

    @property
    def ajustado(self) -> bool:
        return (self.ini, self.fin) != (self.ini_default, self.fin_default) or bool(self.dias_asignados)


@dataclass(frozen=True)
class Hueco:
    ini: date
    fin: date
    comision: float
    despues_de: str
    antes_de: str
    # El último día con cobros del mes: no entra en el pago de su semana (regla del cliente); no es un cobro olvidado.
    cierre: bool = False


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
    dias_asignados: dict[str, list[date]] = field(default_factory=dict)

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

    def con_dias(self, s: Sugerencia) -> dict[str, list[date]]:
        """Los días asignados con los de una sugerencia de cierre sumados (devuelve el nuevo dict, no lo guarda)."""
        if self._congelado(s.pago_id):
            raise ErrorCorte("corte_congelado", "El pago está consolidado.")
        nuevo = {k: list(v) for k, v in self.dias_asignados.items()}
        nuevo[s.pago_id] = sorted(set(nuevo.get(s.pago_id, [])) | set(s.dias_asignar))
        return nuevo

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
    def __init__(
        self,
        vs: list[_V],
        serie: SerieDiaria,
        descartadas: set[str],
        dias_asignados: Mapping[str, Collection[date]] | None = None,
        cierres_libres: list[list[tuple[date, float]]] | None = None,
    ):
        self.vs = vs
        self.serie = serie
        self.descartadas = descartadas
        self.dias_asignados = dias_asignados or {}
        # Por cada día de cierre: los días seguidos, hasta él, que ningún pago cubre ni tiene asignado,
        # como (día, comisión), del más antiguo al día de cierre.
        self.cierres_libres = cierres_libres or []

    def calc(self, v: _V) -> float:
        if v.cons and v.frozen_calc is not None:
            return v.frozen_calc
        extra = sum(self.serie.suma(d, d) for d in self.dias_asignados.get(v.pago_id, ()))
        return self.serie.suma(v.ini, v.fin) + extra

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
    cierres: Collection[date] | None = None,
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
    asignados = {pid: tuple(sorted(set(ds))) for pid, ds in estado.dias_asignados.items() if ds}
    ocupados = {d for ds in asignados.values() for d in ds}
    def libre(d: date) -> bool:
        return d not in ocupados and not any(v.ini <= d <= v.fin for v in vs)

    libres: list[list[tuple[date, float]]] = []
    for dia in sorted(cierres or ()):
        corrida: list[tuple[date, float]] = []
        d = dia
        while len(corrida) < DIAS_DE_COLA and libre(d):
            corrida.insert(0, (d, round(serie.suma(d, d), 2)))
            d -= DIA
        if any(m > 0 for _, m in corrida):
            libres.append(corrida)
    ctx = _Ctx(vs, serie, estado.descartadas, asignados, libres)
    docs_de = {p.pago_id: p.docs for p in pagos}
    pagado_vivo = {p.pago_id: p.pagado for p in pagos}

    resueltos: list[PagoResuelto] = []
    for i, v in enumerate(vs):
        calculado = ctx.calc(v)
        dif = calculado - v.pagado
        ini_d, fin_d = defaults[v.pago_id]
        r = PagoResuelto(
            v.pago_id, docs_de[v.pago_id], v.ini, v.fin, ini_d, fin_d, v.pagado,
            round(calculado, 2), round(dif, 2), OK, sin_calculo=calculado == 0,
            descartada=v.pago_id in ctx.descartadas,
            dias_asignados=asignados.get(v.pago_id, ()),
        )
        if v.cons:
            r.estado = CONSOLIDADO
            r.drift = round(serie.suma(v.ini, v.fin) - (v.frozen_calc or 0.0), 2)
            r.drift_pagado = round(pagado_vivo[v.pago_id] - v.pagado, 2)
        elif abs(dif) > TOLERANCIA:
            fuera = sugerir_en is not None and not (v.ini <= sugerir_en[1] and v.fin >= sugerir_en[0])
            r.sugerencia = None if fuera or v.pago_id in ctx.descartadas else _mejor_sugerencia(ctx, i)
            r.estado = SUGERENCIA if r.sugerencia else SIN_EXPLICACION
        resueltos.append(r)

    huecos, traslapes, cortes = [], [], []
    for a, b in zip(vs, vs[1:]):
        if b.ini > a.fin + DIA:
            ini, fin = a.fin + DIA, b.ini - DIA
            huecos.append(
                Hueco(ini, fin, round(serie.suma(ini, fin), 2), a.pago_id, b.pago_id, cierre=_hueco_de_cierre(ini, fin, cierres))
            )
        elif b.ini <= a.fin:
            traslapes.append(Traslape(b.ini, min(a.fin, b.fin), (a.pago_id, b.pago_id)))
        else:
            cortes.append(Corte(a.pago_id, b.pago_id, a.fin, a.cons or b.cons))

    # un hueco que solo es un día asignado a un pago ya no es comisión sin pago
    huecos = [h for h in huecos if not all((h.ini + timedelta(days=k)) in ocupados for k in range((h.fin - h.ini).days + 1))]
    return FilaResuelta(
        key, resueltos + sin_ventana, huecos, traslapes, cortes, dict(estado.overrides),
        {k: list(v) for k, v in asignados.items()},
    )


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
    if abs(ctx.calc(nv) - nv.pagado) > TOLERANCIA:
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


DIAS_DE_COLA = 7  # cuántos días hacia atrás, desde el día de cierre, se juntan en el bloque de fin de mes
PAGOS_PARA_ASIGNAR_CIERRE = 4  # el día de cierre se busca en los primeros pagos que empiezan después de él


def sugerir_cierre(ctx: _Ctx, i: int) -> Sugerencia | None:
    """Asignar al pago el bloque de fin de mes que lo deja en $0.

    El bloque son los días sin pago que terminan en el último día con cobros de un mes (el día de cierre, y los
    que lo preceden si la semana de arriba ya los soltó). Se prueba cada cola posible, de un día a siete, y se
    ofrece la más corta que deja el pago exacto. Solo entre los primeros pagos que empiezan después del cierre: ahí
    es donde el cliente lo paga (mismo mes siguiente para todos, pero distinto entre meses y a veces solo una parte).
    """
    vs, v = ctx.vs, ctx.vs[i]
    if v.cons or not ctx.cierres_libres:
        return None
    dif = ctx.dif(v)
    candidatos = []
    for corrida in ctx.cierres_libres:
        cierre = corrida[-1][0]
        if cierre >= v.ini:
            continue
        despues = [x for x in vs if x.ini > cierre and not x.cons]
        if v.pago_id not in [x.pago_id for x in despues[:PAGOS_PARA_ASIGNAR_CIERRE]]:
            continue
        for j, (_, monto_j) in enumerate(corrida):
            if monto_j <= 0:
                continue  # la cola arranca en un día con cobros: una cola que empieza en un día vacío repite a otra
            bloque = corrida[j:]
            total = round(sum(m for _, m in bloque), 2)
            if abs(dif + total) <= TOLERANCIA:
                candidatos.append((len(bloque), cierre, tuple(d for d, _ in bloque), total))
    if not candidatos:
        return None
    candidatos.sort(key=lambda c: (c[0], -c[1].toordinal()))  # la cola más corta; a igual largo, el cierre más cercano
    _, _, dias, total = candidatos[0]
    afectado = Afectado(v.pago_id, v.ini, v.fin, v.ini, v.fin, round(dif, 2), round(dif + total, 2))
    return Sugerencia("cierre", v.pago_id, (), (afectado,), len(candidatos) == 1, len(candidatos), dias_asignar=dias)


GENERADORES: list[Callable[[_Ctx, int], "Sugerencia | None"]] = [sugerir_cierre, sugerir_borde]


# ─── Conjunto de filas ───────────────────────────────────────────────────


def construir_filas(
    docs: Iterable[DocPago],
    diario: Iterable[Mapping],
    estados: Mapping[FilaKey, EstadoFila] | None = None,
    sugerir_en: tuple[date, date] | None = None,
    cierre_de_mes: bool = True,
    estandar: bool = True,
    cierres: Collection[date] | None = None,
) -> dict[FilaKey, FilaResuelta]:
    """Resuelve todas las filas. `diario`: dicts con sociedad, comisionista_id, division_code, fecha, comision."""
    dias: dict[FilaKey, dict[date, float]] = defaultdict(dict)
    for r in diario:
        k = (r["sociedad"], r["comisionista_id"], r["division_code"])
        dias[k][r["fecha"]] = dias[k].get(r["fecha"], 0.0) + float(r["comision"] or 0.0)

    estados = estados or {}
    out = {}
    for key, pagos in agrupar_pagos(docs, cierre_de_mes, estandar, cierres).items():
        out[key] = resolver_fila(key, pagos, SerieDiaria(dias.get(key)), estados.get(key), sugerir_en, cierres)
    return out
