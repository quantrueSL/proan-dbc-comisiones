"""Conciliación por cortes: ventanas, estados, sugerencias de borde y congelado."""

from datetime import date, timedelta

import pytest

from comisionesbi import conciliacion_cortes_engine as cc
from comisionesbi.conciliacion_cortes_engine import (
    CONSOLIDADO,
    OK,
    SIN_EXPLICACION,
    SIN_VENTANA,
    SUGERENCIA,
    DocPago,
    ErrorCorte,
    EstadoFila,
    Foto,
    SerieDiaria,
    agrupar_pagos,
    construir_filas,
    resolver_fila,
)

D0 = date(2026, 6, 27)  # sábado
KEY = ("DBC", "0000001000", "H")

# 35 días; los domingos (índice 1, 8, 15...) sin cobros, como en la realidad.
MONTOS = [
    0 if i % 7 == 1 else m
    for i, m in enumerate(
        [6300, 0, 9800, 11200, 8700, 12200, 4100, 7100, 0, 10400, 12900, 9300, 11300, 6800]
        + [5200, 0, 8800, 10100, 9100, 11700, 5900, 6400, 0, 9700, 12100, 8300, 10800, 7200]
        + [4800, 0, 9300, 10600, 8900, 12400, 5500]
    )
]


def d(i: int) -> date:
    return D0 + timedelta(days=i)


def serie(montos=MONTOS) -> SerieDiaria:
    return SerieDiaria({d(i): m for i, m in enumerate(montos)})


def suma(montos, a, b) -> float:
    return float(sum(montos[a : b + 1]))


def docs(ventanas, pagados, *, key=KEY, base=1):
    """Un DocPago por ventana (índices de día), con su pagado."""
    return [
        DocPago(f"{key[0]}|2026|{base + n:010d}", key[0], key[1], key[2], d(a), d(b), pagado)
        for n, ((a, b), pagado) in enumerate(zip(ventanas, pagados))
    ]


SEMANAS = [(0, 6), (7, 13), (14, 20), (21, 27), (28, 34)]


def fila_con_cortes_reales(verdad, montos=MONTOS, estado=None):
    """Pagos con el texto estándar (sáb-vie), pero pagado según los cortes `verdad`."""
    ventanas_pagadas = []
    ini = 0
    for corte in verdad + [34]:
        ventanas_pagadas.append((ini, corte))
        ini = corte + 1
    pagados = [suma(montos, a, b) for a, b in ventanas_pagadas]
    pagos = agrupar_pagos(docs(SEMANAS, pagados))[KEY]
    return resolver_fila(KEY, pagos, serie(montos), estado)


# ─── Agrupación ──────────────────────────────────────────────────────────


def test_dos_documentos_de_la_misma_ventana_son_un_pago_con_el_menor_id():
    ds = [
        DocPago("DBC|2026|0000000009", "DBC", "X", "H", d(0), d(6), 100.0),
        DocPago("DBC|2026|0000000003", "DBC", "X", "H", d(0), d(6), 50.5),
    ]
    (pago,) = agrupar_pagos(ds)[("DBC", "X", "H")]
    assert pago.pago_id == "DBC|2026|0000000003"
    assert pago.docs == ("DBC|2026|0000000003", "DBC|2026|0000000009")
    assert pago.pagado == 150.5


def test_documento_sin_ventana_queda_como_pago_sin_ventana():
    fila = {"doc_id": "DBC|2026|1", "sociedad": "DBC", "comisionista_id": "X", "division_code": "H",
            "desde_texto": d(0), "hasta_texto": d(6), "ventana_valida": False, "pagado": 80}
    pagos = agrupar_pagos([DocPago.desde_fila(fila)])[("DBC", "X", "H")]
    fr = resolver_fila(("DBC", "X", "H"), pagos, serie())
    assert fr.pagos[0].estado == SIN_VENTANA
    assert fr.pagos[0].calculado is None


def test_override_le_da_ventana_a_un_pago_sin_ventana():
    fila = {"doc_id": "DBC|2026|1", "sociedad": "DBC", "comisionista_id": "X", "division_code": "H",
            "desde_texto": None, "hasta_texto": None, "ventana_valida": False, "pagado": suma(MONTOS, 0, 6)}
    pagos = agrupar_pagos([DocPago.desde_fila(fila)])[("DBC", "X", "H")]
    estado = EstadoFila(overrides={"DBC|2026|1": {"ini": d(0), "fin": d(6)}})
    fr = resolver_fila(("DBC", "X", "H"), pagos, serie(), estado)
    assert fr.pagos[0].estado == OK


# ─── Estados ─────────────────────────────────────────────────────────────


def test_pago_que_cuadra_es_ok_y_el_calculado_es_la_suma_de_su_ventana():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    assert [p.estado for p in fr.pagos] == [OK] * 5
    assert fr.pagos[1].calculado == suma(MONTOS, 7, 13)
    assert fr.huecos == [] and fr.traslapes == []
    assert len(fr.cortes) == 4


def test_diferencia_que_ningun_borde_explica_es_sin_explicacion():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    pagos = agrupar_pagos(docs(SEMANAS, [suma(MONTOS, 0, 6) * 0.9] + [suma(MONTOS, a, b) for a, b in SEMANAS[1:]]))[KEY]
    fr = resolver_fila(KEY, pagos, serie())
    assert fr.pagos[0].estado == SIN_EXPLICACION
    assert fr.pagos[0].sugerencia is None
    assert fr.pagos[1].estado == OK


def test_pago_sin_ningun_calculo_se_marca():
    pagos = agrupar_pagos(docs([(0, 6)], [500.0]))[KEY]
    fr = resolver_fila(KEY, pagos, SerieDiaria({}))
    assert fr.pagos[0].sin_calculo is True
    assert fr.pagos[0].estado == SIN_EXPLICACION


# ─── Sugerencias de borde ────────────────────────────────────────────────


def test_sugerencia_unica_mueve_el_corte_compartido_de_los_dos_pagos():
    fr = fila_con_cortes_reales([5, 12, 19, 26])  # el pago real corta un día antes
    p0 = fr.pagos[0]
    assert p0.estado == SUGERENCIA
    s = p0.sugerencia
    assert s.unica is True
    assert {(c.pago_id, c.borde, c.de, c.a) for c in s.cambios} == {
        (fr.pagos[0].pago_id, "fin", d(6), d(5)),
        (fr.pagos[1].pago_id, "ini", d(7), d(6)),
    }
    assert s.afectados[0].diferencia_despues == 0.0
    assert s.afectados[0].diferencia_antes == MONTOS[6]


def test_aplicar_la_sugerencia_deja_el_pago_en_cero_y_destapa_la_del_siguiente():
    fr = fila_con_cortes_reales([5, 12, 19, 26])
    overrides = fr.aplicar_sugerencia(fr.pagos[0].sugerencia)
    fr2 = fila_con_cortes_reales([5, 12, 19, 26], estado=EstadoFila(overrides=overrides))
    assert fr2.pagos[0].estado == OK
    assert fr2.pagos[0].fin == d(5) and fr2.pagos[1].ini == d(6)
    assert fr2.pagos[1].estado == SUGERENCIA  # le falta mover su otro corte
    assert fr2.pagos[1].ini_default == d(7) and fr2.pagos[1].ajustado


def test_sugerencia_que_toca_dos_cortes_cuando_el_pago_esta_desfasado_de_los_dos_lados():
    fr = fila_con_cortes_reales([5, 12, 19, 26])
    s = fr.pagos[1].sugerencia
    assert s is not None
    assert {c.borde for c in s.cambios if c.pago_id == fr.pagos[1].pago_id} == {"ini", "fin"}
    propio = next(a for a in s.afectados if a.pago_id == fr.pagos[1].pago_id)
    assert propio.diferencia_despues == 0.0
    assert {a.pago_id for a in s.afectados} == {p.pago_id for p in fr.pagos[:3]}


def test_los_dias_sin_cobros_no_crean_ambiguedad():
    montos = [0] * 35
    montos[0:8] = [1000, 2000, 3000, 0, 4000, 0, 500, 900]  # índice 6 = 500; 7 = 900
    # pago A: 0..3 (texto); el real cubre hasta 5, pero el día 5 no tiene cobros
    pagados = [suma(montos, 0, 5), suma(montos, 6, 7)]
    pagos = agrupar_pagos(docs([(0, 3), (4, 7)], pagados))[KEY]
    fr = resolver_fila(KEY, pagos, serie(montos))
    s = fr.pagos[0].sugerencia
    assert s is not None
    # llegar al día 4 o al 5 da lo mismo (el 5 vale 0): una sola respuesta, la de menor movimiento
    assert s.unica is True
    assert s.n_opciones >= 2
    assert fr.pagos[0].estado == SUGERENCIA
    cambio_fin = next(c for c in s.cambios if c.pago_id == fr.pagos[0].pago_id)
    assert cambio_fin.a == d(4)


def test_un_corte_congelado_no_se_sugiere_ni_se_mueve():
    base = fila_con_cortes_reales([6, 13, 19, 27])
    fotos = {
        base.pagos[0].pago_id: Foto(d(0), d(6), base.pagos[0].pagado, base.pagos[0].calculado),
        base.pagos[1].pago_id: Foto(d(7), d(13), base.pagos[1].pagado, base.pagos[1].calculado),
    }
    fr = fila_con_cortes_reales([6, 13, 19, 27], estado=EstadoFila(consolidados=fotos))
    assert [p.estado for p in fr.pagos[:2]] == [CONSOLIDADO, CONSOLIDADO]
    s = fr.pagos[2].sugerencia
    assert s is not None
    assert all(c.pago_id in (fr.pagos[2].pago_id, fr.pagos[3].pago_id) for c in s.cambios)
    with pytest.raises(ErrorCorte) as e:
        fr.mover_corte(fr.pagos[1].pago_id, d(12))
    assert e.value.codigo == "corte_congelado"


def test_sugerencia_descartada_deja_el_pago_sin_explicacion():
    fr = fila_con_cortes_reales([5, 12, 19, 26])
    pid = fr.pagos[0].pago_id
    fr2 = fila_con_cortes_reales([5, 12, 19, 26], estado=EstadoFila(descartadas={pid}))
    assert fr2.pagos[0].estado == SIN_EXPLICACION and fr2.pagos[0].sugerencia is None


# ─── Consolidado ─────────────────────────────────────────────────────────


def test_consolidado_se_lee_de_la_foto_y_avisa_si_el_dato_cambio():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    pid = fr.pagos[0].pago_id
    foto = fr.foto(pid)
    montos_nuevos = list(MONTOS)
    montos_nuevos[3] += 500  # llega un cobro tardío dentro de la ventana
    fr2 = fila_con_cortes_reales([6, 13, 20, 27], montos=montos_nuevos, estado=EstadoFila(consolidados={pid: foto}))
    p = fr2.pagos[0]
    assert p.estado == CONSOLIDADO
    assert p.calculado == foto.calculado  # sigue siendo el congelado
    assert p.drift == 500.0


def test_drift_es_la_diferencia_entre_el_calculado_vivo_y_el_congelado():
    pagos = agrupar_pagos(docs([(0, 6)], [suma(MONTOS, 0, 6)]))[KEY]
    foto = Foto(d(0), d(6), suma(MONTOS, 0, 6), suma(MONTOS, 0, 6) - 700)
    fr = resolver_fila(KEY, pagos, serie(), EstadoFila(consolidados={pagos[0].pago_id: foto}))
    assert fr.pagos[0].drift == 700.0
    assert fr.pagos[0].calculado == foto.calculado


def test_foto_de_un_pago_ya_consolidado_falla():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    pid = fr.pagos[0].pago_id
    fr2 = fila_con_cortes_reales([6, 13, 20, 27], estado=EstadoFila(consolidados={pid: fr.foto(pid)}))
    with pytest.raises(ErrorCorte) as e:
        fr2.foto(pid)
    assert e.value.codigo == "ya_consolidado"


def test_plan_de_lote_va_de_izquierda_a_derecha_y_se_detiene_en_el_primero_que_no_cuadra():
    pagados = [suma(MONTOS, a, b) for a, b in SEMANAS]
    pagados[2] *= 0.8
    pagos = agrupar_pagos(docs(SEMANAS, pagados))[KEY]
    fr = resolver_fila(KEY, pagos, serie())
    assert fr.plan_lote() == [fr.pagos[0].pago_id, fr.pagos[1].pago_id]


# ─── Huecos, traslapes y movimientos manuales ────────────────────────────


def test_hueco_entre_pagos_se_reporta_con_sus_cobros_y_no_hay_corte_compartido():
    pagos = agrupar_pagos(docs([(0, 6), (10, 13)], [suma(MONTOS, 0, 6), suma(MONTOS, 10, 13)]))[KEY]
    fr = resolver_fila(KEY, pagos, serie())
    (h,) = fr.huecos
    assert (h.ini, h.fin) == (d(7), d(9))
    assert h.comision == suma(MONTOS, 7, 9)
    assert fr.cortes == []


def test_traslape_se_reporta_y_no_bloquea():
    pagos = agrupar_pagos(docs([(0, 8), (6, 13)], [suma(MONTOS, 0, 8), suma(MONTOS, 6, 13)]))[KEY]
    fr = resolver_fila(KEY, pagos, serie())
    (t,) = fr.traslapes
    assert (t.ini, t.fin) == (d(6), d(8))
    assert all(p.estado == OK for p in fr.pagos)


def test_mover_corte_actualiza_los_dos_pagos_y_volver_al_default_limpia_el_override():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    izq = fr.pagos[0].pago_id
    ov = fr.mover_corte(izq, d(5))
    assert ov[izq]["fin"] == d(5) and ov[fr.pagos[1].pago_id]["ini"] == d(6)
    fr2 = fila_con_cortes_reales([6, 13, 20, 27], estado=EstadoFila(overrides=ov))
    assert fr2.overrides == ov
    assert fr2.mover_corte(izq, d(6)) == {}


def test_mover_corte_valida_que_cada_pago_conserve_al_menos_un_dia():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    with pytest.raises(ErrorCorte) as e:
        fr.mover_corte(fr.pagos[0].pago_id, d(13))
    assert e.value.codigo == "ventana_invalida"


def test_mover_borde_de_un_corte_compartido_pide_usar_mover_corte():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    with pytest.raises(ErrorCorte) as e:
        fr.mover_borde(fr.pagos[0].pago_id, "fin", d(5))
    assert e.value.codigo == "usa_mover_corte"


def test_mover_borde_extremo_de_la_fila_si_se_puede():
    fr = fila_con_cortes_reales([6, 13, 20, 27])
    ov = fr.mover_borde(fr.pagos[0].pago_id, "ini", d(2))
    assert ov[fr.pagos[0].pago_id] == {"ini": d(2)}


# ─── Conjunto ────────────────────────────────────────────────────────────


def test_construir_filas_suma_el_diario_por_fila_y_resuelve_cada_una():
    ds = docs(SEMANAS, [suma(MONTOS, a, b) for a, b in SEMANAS])
    otra = ("PAN", "0000002000", "H")
    ds += docs([(0, 6)], [999.0], key=otra, base=50)
    diario = [
        {"sociedad": KEY[0], "comisionista_id": KEY[1], "division_code": KEY[2], "fecha": d(i), "comision": m}
        for i, m in enumerate(MONTOS)
    ]
    filas = construir_filas(ds, diario)
    assert set(filas) == {KEY, otra}
    assert all(p.estado == OK for p in filas[KEY].pagos)
    assert filas[otra].pagos[0].estado == SIN_EXPLICACION and filas[otra].pagos[0].sin_calculo


def test_sugerir_en_limita_la_busqueda_a_los_pagos_del_rango():
    pagados = [suma(MONTOS, a, b) for a, b in [(0, 5), (6, 12), (13, 19), (20, 26), (27, 34)]]
    pagos = agrupar_pagos(docs(SEMANAS, pagados))[KEY]
    fr = resolver_fila(KEY, pagos, serie(), sugerir_en=(d(0), d(6)))
    assert fr.pagos[0].estado == SUGERENCIA  # toca el rango
    assert fr.pagos[3].sugerencia is None and fr.pagos[3].estado == SIN_EXPLICACION  # fuera del rango
