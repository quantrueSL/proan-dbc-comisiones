"""Conciliación por cortes: ventanas, estados, sugerencias de borde y congelado."""

from datetime import date, timedelta

import pytest

from comisionesbi import conciliacion_cortes_engine as cc
from dataclasses import replace

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
    Pago,
    SerieDiaria,
    agrupar_pagos,
    construir_filas,
    aplicar_cierre_de_mes,
    resolver_fila,
    ultimos_dias_con_cobros,
    ventana_estandar,
)

D0 = date(2026, 6, 20)  # sábado; ninguna ventana de estas pruebas termina en fin de mes
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
    pagos = agrupar_pagos(docs([(0, 3), (4, 7)], pagados), estandar=False)[KEY]
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
    assert fr2.pagos[0].descartada is True and fr.pagos[0].descartada is False


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
    pagos = agrupar_pagos(docs([(0, 6), (10, 13)], [suma(MONTOS, 0, 6), suma(MONTOS, 10, 13)]), estandar=False)[KEY]
    fr = resolver_fila(KEY, pagos, serie())
    (h,) = fr.huecos
    assert (h.ini, h.fin) == (d(7), d(9))
    assert h.comision == suma(MONTOS, 7, 9)
    assert fr.cortes == []


def test_traslape_se_reporta_y_no_bloquea():
    pagos = agrupar_pagos(docs([(0, 8), (6, 13)], [suma(MONTOS, 0, 8), suma(MONTOS, 6, 13)]), estandar=False)[KEY]
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


# ─── Cierre de mes ───────────────────────────────────────────────────────


def test_el_ultimo_dia_del_mes_sale_del_pago_que_termina_ese_dia_y_queda_como_hueco_de_cierre():
    # 25 jun a 30 jun, y el siguiente pago arranca el 1 jul
    base = date(2026, 6, 25)
    ds = [
        DocPago("DBC|2026|0000000001", "DBC", "X", "H", base, date(2026, 6, 30), 100.0),
        DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 7, 1), date(2026, 7, 3), 60.0),
    ]
    dias = {base + timedelta(days=i): 20.0 for i in range(9)}  # 20 por día del 25 jun al 3 jul
    pagos = agrupar_pagos(ds, estandar=False)[("DBC", "X", "H")]
    assert [(p.ini, p.fin) for p in pagos] == [(date(2026, 6, 25), date(2026, 6, 29)), (date(2026, 7, 1), date(2026, 7, 3))]
    fr = resolver_fila(("DBC", "X", "H"), pagos, SerieDiaria(dias))
    assert fr.pagos[0].calculado == 100.0 and fr.pagos[0].estado == OK  # 5 días x 20, sin el 30
    assert fr.pagos[1].calculado == 60.0 and fr.pagos[1].estado == OK  # no se lleva el día de cierre
    (h,) = fr.huecos
    assert (h.ini, h.fin, h.comision, h.cierre) == (date(2026, 6, 30), date(2026, 6, 30), 20.0, True)
    assert fr.cortes == []  # ya no comparten un corte


def test_el_cierre_de_mes_se_puede_apagar_y_no_toca_ventanas_de_un_dia_ni_las_que_no_terminan_en_fin_de_mes():
    ds = [DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 6, 30), date(2026, 6, 30), 10.0)]
    assert agrupar_pagos(ds)[("DBC", "X", "H")][0].fin == date(2026, 6, 30)  # una sola jornada: no se acorta
    ds = [DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 6, 23), date(2026, 6, 30), 10.0)]
    assert agrupar_pagos(ds)[("DBC", "X", "H")][0].fin == date(2026, 6, 29)
    assert agrupar_pagos(ds, cierre_de_mes=False)[("DBC", "X", "H")][0].fin == date(2026, 6, 30)
    medio = [DocPago("DBC|2026|0000000003", "DBC", "X", "H", date(2026, 6, 23), date(2026, 6, 26), 10.0)]
    assert agrupar_pagos(medio)[("DBC", "X", "H")][0].fin == date(2026, 6, 26)


def test_un_hueco_de_un_dia_que_no_es_fin_de_mes_no_es_cierre():
    pagos = agrupar_pagos(docs([(0, 6), (8, 13)], [suma(MONTOS, 0, 6), suma(MONTOS, 8, 13)]), estandar=False)[KEY]
    fr = resolver_fila(KEY, pagos, serie())
    assert fr.huecos[0].cierre is False


# ─── Ventanas estándar: sábado-viernes y fin de mes, sin traslapes ───────


def test_la_ventana_del_texto_se_acomoda_a_sabado_viernes():
    # "5 al 12 sep" (sáb a sáb) pasa a sáb 5 a vie 11; "11 al 18" arranca el sábado 12
    assert ventana_estandar(date(2026, 9, 5), date(2026, 9, 12)) == (date(2026, 9, 5), date(2026, 9, 11))
    assert ventana_estandar(date(2026, 9, 11), date(2026, 9, 18)) == (date(2026, 9, 12), date(2026, 9, 18))
    # lo que ya es sáb-vie no cambia
    assert ventana_estandar(date(2026, 9, 12), date(2026, 9, 18)) == (date(2026, 9, 12), date(2026, 9, 18))


def test_el_cambio_de_mes_tambien_corta_el_tramo():
    assert ventana_estandar(date(2026, 9, 26), date(2026, 9, 30)) == (date(2026, 9, 26), date(2026, 9, 30))
    assert ventana_estandar(date(2026, 10, 1), date(2026, 10, 2)) == (date(2026, 10, 1), date(2026, 10, 2))
    # un acumulado de varias semanas conserva su largo
    assert ventana_estandar(date(2026, 8, 1), date(2026, 8, 31)) == (date(2026, 8, 1), date(2026, 8, 31))


def test_un_texto_de_un_solo_dia_suelto_se_deja_como_viene():
    # el 30 sep (miércoles) quedaría con inicio el 1 oct: al revés, así que no se toca
    assert ventana_estandar(date(2026, 9, 30), date(2026, 9, 30)) == (date(2026, 9, 30), date(2026, 9, 30))


def test_dos_pagos_que_el_texto_traslapa_quedan_contiguos_y_sin_traslape():
    ds = [
        DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 9, 5), date(2026, 9, 12), 100.0),
        DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 9, 12), date(2026, 9, 18), 100.0),
    ]
    pagos = agrupar_pagos(ds)[("DBC", "X", "H")]
    assert [(p.ini, p.fin) for p in pagos] == [(date(2026, 9, 5), date(2026, 9, 11)), (date(2026, 9, 12), date(2026, 9, 18))]
    fr = resolver_fila(("DBC", "X", "H"), pagos, SerieDiaria({}))
    assert fr.traslapes == [] and fr.huecos == [] and len(fr.cortes) == 1
    # y con el texto tal cual, sí se traslapan (el modo anterior sigue disponible)
    crudos = agrupar_pagos(ds, estandar=False)[("DBC", "X", "H")]
    assert [(p.ini, p.fin) for p in crudos] == [(date(2026, 9, 5), date(2026, 9, 12)), (date(2026, 9, 12), date(2026, 9, 18))]


def test_dos_documentos_que_quedan_en_la_misma_ventana_son_un_solo_pago():
    ds = [
        DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 9, 5), date(2026, 9, 11), 60.0),
        DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 9, 5), date(2026, 9, 12), 40.0),
    ]
    (pago,) = agrupar_pagos(ds)[("DBC", "X", "H")]
    assert pago.pagado == 100.0 and pago.pago_id == "DBC|2026|0000000001" and len(pago.docs) == 2


def test_un_pago_contenido_en_otro_no_se_recorta():
    ds = [
        DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 9, 5), date(2026, 9, 25), 300.0),
        DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 9, 12), date(2026, 9, 18), 100.0),
    ]
    pagos = agrupar_pagos(ds)[("DBC", "X", "H")]
    assert [(p.ini, p.fin) for p in pagos] == [(date(2026, 9, 5), date(2026, 9, 25)), (date(2026, 9, 12), date(2026, 9, 18))]


# ─── Cierre de mes: último día con cobros y asignación a un pago ─────────


def test_el_ultimo_dia_con_cobros_de_cada_mes_cerrado_se_toma_de_todos_juntos():
    total = {
        date(2026, 7, 30): 500.0, date(2026, 7, 31): 0.0,       # el 31 sin cobros: el cierre es el 30
        date(2026, 8, 29): 900.0, date(2026, 8, 31): 120.0,
        date(2026, 9, 2): 300.0,                                  # el mes más reciente no está cerrado
    }
    assert ultimos_dias_con_cobros(total) == {date(2026, 7, 30), date(2026, 8, 31)}
    assert ultimos_dias_con_cobros({}) == frozenset()


def test_el_pago_que_termina_en_el_dia_de_cierre_lo_pierde_aunque_no_sea_fin_de_calendario():
    pagos = [Pago("a", ("a",), "DBC", "X", "H", date(2026, 7, 25), date(2026, 7, 30), 10.0)]
    assert aplicar_cierre_de_mes(pagos, {date(2026, 7, 30)})[0].fin == date(2026, 7, 29)
    # si el cierre es otro día, un pago que termina el 31 no se toca
    pagos31 = [Pago("a", ("a",), "DBC", "X", "H", date(2026, 7, 25), date(2026, 7, 31), 10.0)]
    assert aplicar_cierre_de_mes(pagos31, {date(2026, 7, 30)})[0].fin == date(2026, 7, 31)
    # sin lista de cierres, el último día del calendario (comportamiento anterior)
    assert aplicar_cierre_de_mes(pagos31)[0].fin == date(2026, 7, 30)


def _fila_con_cierre(pagado_b, *, extra_pagos=()):
    """A: sáb 27 a mar 30 jun (el 30 es el cierre, queda fuera); B: 1 a 3 jul, pagado con el cierre incluido."""
    ds = [
        DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 6, 27), date(2026, 6, 30), 60.0),
        DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 7, 1), date(2026, 7, 3), pagado_b),
        *extra_pagos,
    ]
    dias = {date(2026, 6, 25) + timedelta(days=i): 20.0 for i in range(9)}  # 20 por día del 25 jun al 3 jul
    cierres = {date(2026, 6, 30)}
    key = ("DBC", "X", "H")
    pagos = agrupar_pagos(ds, cierres=cierres)[key]
    return key, pagos, SerieDiaria(dias), cierres


def test_se_sugiere_asignar_el_cierre_al_pago_siguiente_solo_si_lo_deja_exacto():
    key, pagos, serie, cierres = _fila_con_cierre(80.0)  # 3 días x 20 + el cierre de 20
    fr = resolver_fila(key, pagos, serie, None, cierres=cierres)
    a, b = fr.pagos
    assert a.estado == OK and a.calculado == 60.0  # 27, 28 y 29 jun; sin el 30
    assert b.estado == SUGERENCIA and b.sugerencia.tipo == "cierre"
    assert b.sugerencia.dias_asignar == (date(2026, 6, 30),) and b.sugerencia.cambios == ()
    (af,) = b.sugerencia.afectados
    assert (af.diferencia_antes, af.diferencia_despues) == (-20.0, 0.0)
    assert [(h.ini, h.cierre) for h in fr.huecos] == [(date(2026, 6, 30), True)]

    # con otro monto no hay sugerencia de cierre: no cuadra exacto
    key, pagos, serie, cierres = _fila_con_cierre(75.0)
    b = resolver_fila(key, pagos, serie, None, cierres=cierres).pagos[1]
    assert b.sugerencia is None or b.sugerencia.tipo != "cierre"


def test_un_dia_asignado_se_suma_al_pago_y_deja_de_ser_hueco():
    key, pagos, serie, cierres = _fila_con_cierre(80.0)
    estado = EstadoFila(dias_asignados={"DBC|2026|0000000002": [date(2026, 6, 30)]})
    fr = resolver_fila(key, pagos, serie, estado, cierres=cierres)
    b = fr.pagos[1]
    assert b.estado == OK and b.calculado == 80.0 and b.dias_asignados == (date(2026, 6, 30),)
    assert b.ajustado is True and b.sugerencia is None
    assert fr.huecos == []
    assert fr.dias_asignados == {"DBC|2026|0000000002": [date(2026, 6, 30)]}


def test_con_dias_suma_a_lo_ya_asignado_y_no_toca_un_pago_consolidado():
    key, pagos, serie, cierres = _fila_con_cierre(80.0)
    fr = resolver_fila(key, pagos, serie, None, cierres=cierres)
    sug = fr.pagos[1].sugerencia
    assert fr.con_dias(sug) == {"DBC|2026|0000000002": [date(2026, 6, 30)]}
    foto = Foto(date(2026, 7, 1), date(2026, 7, 3), 80.0, 60.0)
    fr2 = resolver_fila(key, pagos, serie, EstadoFila(consolidados={"DBC|2026|0000000002": foto}), cierres=cierres)
    with pytest.raises(ErrorCorte):
        fr2.con_dias(sug)


def test_el_cierre_solo_se_ofrece_a_los_primeros_pagos_que_empiezan_despues():
    # solo los cuatro primeros pagos después del cierre lo reciben como sugerencia
    ds = [DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 6, 25), date(2026, 6, 30), 100.0)]
    for n in range(2, 8):
        ini = date(2026, 7, 1) + timedelta(days=7 * (n - 2))
        ds.append(DocPago(f"DBC|2026|{n:010d}", "DBC", "X", "H", ini, ini + timedelta(days=6), 140.0))
    dias = {date(2026, 6, 25) + timedelta(days=i): 20.0 for i in range(60)}
    cierres = {date(2026, 6, 30)}
    key = ("DBC", "X", "H")
    pagos = agrupar_pagos(ds, cierres=cierres, estandar=False)[key]
    # cada pago siguiente calcula 140; con 160 de pagado, el cierre de 20 los dejaría exactos
    pagos = [replace(p, pagado=160.0) if p.pago_id != "DBC|2026|0000000001" else p for p in pagos]
    fr = resolver_fila(key, pagos, SerieDiaria(dias), None, cierres=cierres)
    con_cierre = [p for p in fr.pagos if p.sugerencia and p.sugerencia.tipo == "cierre"]
    assert len(con_cierre) == 4


def test_el_bloque_de_fin_de_mes_incluye_los_dias_que_la_semana_anterior_suelta():
    # A: 27 a 30 jun, pagado con solo 27 y 28; B: 1 a 3 jul, pagado con 29 y 30 jun además de sus tres días
    ds = [
        DocPago("DBC|2026|0000000001", "DBC", "X", "H", date(2026, 6, 27), date(2026, 6, 30), 40.0),
        DocPago("DBC|2026|0000000002", "DBC", "X", "H", date(2026, 7, 1), date(2026, 7, 3), 100.0),
    ]
    dias = {date(2026, 6, 27) + timedelta(days=i): 20.0 for i in range(7)}
    cierres = {date(2026, 6, 30)}
    key = ("DBC", "X", "H")
    pagos = agrupar_pagos(ds, cierres=cierres)[key]
    a_id, b_id = "DBC|2026|0000000001", "DBC|2026|0000000002"

    # paso 1: solo el 30 está suelto; con él B no cuadra y A pide soltar el 29 (terminar el 28)
    fr = resolver_fila(key, pagos, SerieDiaria(dias), None, cierres=cierres)
    a, b = fr.pagos
    assert b.sugerencia is None or b.sugerencia.tipo != "cierre"
    assert a.sugerencia is not None and a.sugerencia.tipo == "borde"

    # paso 2: al soltar el 29 y el 30, el bloque de fin de mes (29 y 30 jun) le cuadra a B
    fr = resolver_fila(key, pagos, SerieDiaria(dias), EstadoFila(overrides={a_id: {"fin": date(2026, 6, 28)}}), cierres=cierres)
    a, b = fr.pagos
    assert a.estado == OK
    (h,) = fr.huecos
    assert (h.ini, h.fin, h.cierre) == (date(2026, 6, 29), date(2026, 6, 30), True)
    assert b.sugerencia.tipo == "cierre" and b.sugerencia.dias_asignar == (date(2026, 6, 29), date(2026, 6, 30))
    (af,) = b.sugerencia.afectados
    assert (af.diferencia_antes, af.diferencia_despues) == (-40.0, 0.0)

    # paso 3: aplicarlo asigna los dos días y el hueco desaparece
    asignados = fr.con_dias(b.sugerencia)
    fr = resolver_fila(key, pagos, SerieDiaria(dias), EstadoFila(overrides={a_id: {"fin": date(2026, 6, 28)}}, dias_asignados=asignados), cierres=cierres)
    assert fr.huecos == [] and all(p.estado == OK for p in fr.pagos)
    assert fr.pagos[1].dias_asignados == (date(2026, 6, 29), date(2026, 6, 30))


# ─── 4 SKUs de Botana: cada semana se mueve entera al pago que la pagó ───


def _botana():
    key = ("DBC", "0000018853", "BO")
    resto = SerieDiaria({date(2026, 7, 20): 1000.0, date(2026, 7, 27): 1000.0})
    skus = SerieDiaria({date(2026, 7, 20): 491.25, date(2026, 7, 27): 264.0})
    docs_ = [
        DocPago("DBC|2026|A", "DBC", key[1], "BO", date(2026, 7, 18), date(2026, 7, 24), 1000.0),
        DocPago("DBC|2026|B", "DBC", key[1], "BO", date(2026, 7, 25), date(2026, 7, 31), 1755.25),
    ]
    return key, resto, skus, agrupar_pagos(docs_)[key]


def test_las_semanas_de_4_skus_se_agrupan_sabado_a_viernes_y_se_cortan_en_fin_de_mes():
    assert cc.bloque_de(date(2026, 7, 20)) == (date(2026, 7, 18), date(2026, 7, 24))
    assert cc.bloque_de(date(2026, 8, 30)) == (date(2026, 8, 29), date(2026, 8, 31))
    assert cc.bloque_de(date(2026, 9, 2)) == (date(2026, 9, 1), date(2026, 9, 4))


def test_los_4_skus_no_cuentan_en_su_semana_hasta_que_alguien_los_mueve():
    key, resto, skus, pagos = _botana()
    fila = resolver_fila(key, pagos, resto, serie4=skus)
    a, b = fila.pago("DBC|2026|A"), fila.pago("DBC|2026|B")
    assert (a.calculado, a.estado) == (1000.0, OK)
    assert b.calculado == 1000.0 and b.diferencia == -755.25
    assert [x["comision"] for x in fila.skus] == [491.25, 264.0]
    assert all(x["pago_id"] is None for x in fila.skus)


def test_mover_una_semana_de_4_skus_a_otro_pago_cambia_su_calculado():
    key, resto, skus, pagos = _botana()
    estado = EstadoFila(skus_movidos={date(2026, 7, 18): "DBC|2026|B", date(2026, 7, 25): "DBC|2026|B"})
    fila = resolver_fila(key, pagos, resto, estado, serie4=skus)
    b = fila.pago("DBC|2026|B")
    assert b.calculado == 1755.25 and b.estado == OK
    assert [x["ini"] for x in b.skus_incluidos] == [date(2026, 7, 18), date(2026, 7, 25)]
    assert fila.pago("DBC|2026|A").calculado == 1000.0
    assert [x["pago_id"] for x in fila.skus] == ["DBC|2026|B", "DBC|2026|B"]


def test_un_pago_que_paga_de_mas_sugiere_las_semanas_de_4_skus_que_suman_el_exceso():
    key = ("DBC", "0000018853", "BO")
    semanas = [date(2026, 7, 4), date(2026, 7, 11), date(2026, 7, 18), date(2026, 7, 25)]
    resto = SerieDiaria({**{s + timedelta(days=2): 1000.0 for s in semanas}, date(2026, 8, 4): 1000.0})
    skus = SerieDiaria({semanas[0] + timedelta(days=2): 421.5, semanas[1] + timedelta(days=2): 295.5,
                        semanas[2] + timedelta(days=2): 491.25, semanas[3] + timedelta(days=2): 426.0})
    docs_ = [DocPago(f"DBC|2026|{n}", "DBC", key[1], "BO", s, s + timedelta(days=6), 1000.0) for n, s in enumerate(semanas)]
    docs_.append(DocPago("DBC|2026|Z", "DBC", key[1], "BO", date(2026, 8, 1), date(2026, 8, 7), 1000.0 + 295.5 + 491.25))
    fila = resolver_fila(key, agrupar_pagos(docs_)[key], resto, serie4=skus)
    z = fila.pago("DBC|2026|Z")
    assert z.sugerencia and z.sugerencia.tipo == "skus"
    assert z.sugerencia.bloques_asignar == (date(2026, 7, 11), date(2026, 7, 18))
    assert z.sugerencia.afectados[0].diferencia_despues == 0.0
