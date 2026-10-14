"""Conciliación por cortes: capa de datos (BigQuery simulado) y endpoints."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from comisionesbi import app as app_module
from comisionesbi import conciliacion_cortes_estado as estado
from comisionesbi import conciliacion_cortes_service as svc
from comisionesbi.conciliacion_cortes_engine import ErrorCorte
from comisionesbi.conciliacion_cortes_estado import ConflictoVersion

client = TestClient(app_module.app)

D0 = date(2026, 6, 27)  # sábado
LIFNR = "0000001450"
MONTOS = [0 if i % 7 == 1 else 1000 + 137 * i for i in range(35)]


def _doc(n, ini, fin, pagado, *, valida=True, division="H", sociedad="DBC", lifnr=LIFNR, fecha_pago=None):
    return {
        "sociedad": sociedad,
        "doc_id": f"{sociedad}|2026|{n:010d}",
        "comisionista_id": lifnr,
        "division_code": division,
        "desde_texto": D0 + timedelta(days=ini) if valida else None,
        "hasta_texto": D0 + timedelta(days=fin) if valida else None,
        "ventana_valida": valida,
        "pagado": pagado,
        "fecha_pago": fecha_pago or D0 + timedelta(days=fin + 7),
        "comisionista": "EDGARDO TRUJILLO DE LA TORRE",
        "augbl": f"20000{n:05d}",
        "texto": f"COMISION HUEVO {n}",
    }


def _suma(a, b):
    return float(sum(MONTOS[a : b + 1]))


@pytest.fixture
def bq(monkeypatch):
    """Dos semanas de pagos, la primera desfasada un día respecto al texto, más un documento sin ventana."""
    docs = [
        _doc(1, 0, 6, _suma(0, 5)),
        _doc(2, 7, 13, _suma(6, 13)),
        _doc(3, 99, 99, 500.0, valida=False, fecha_pago=date(2026, 7, 8)),
    ]
    diario = [
        {"sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H", "fecha": D0 + timedelta(days=i), "comision": m}
        for i, m in enumerate(MONTOS)
    ]
    llamadas = []

    def fake(sql, nombre, parametros=None):
        llamadas.append((nombre, parametros))
        if "pagos por documento" in nombre:
            # como el SQL: un pago sin ventana solo entra por la fecha en que se pagó
            return [
                d for d in docs
                if d["ventana_valida"] or parametros["ini"][1] <= d["fecha_pago"] <= parametros["fin_pago"][1]
            ]
        if "cobros diarios" in nombre:
            return diario
        if "detalle por producto" in nombre:
            return [
                {"cedis": "Norte", "oficina": "0023", "tipo_venta": "VTA EN RUTA", "matnr": "1", "descripcion": "A",
                 "unidad_venta": "caja", "unidad_tarifa": "kg", "tarifa": 1.5, "num_lineas": 2,
                 "cantidad_venta_total": 10.0, "monto_total": 100.0, "cantidad_base_total": 300.0,
                 "comision_total": 450.0, "lineas_sin_comision": 0},
                {"cedis": "Norte", "oficina": "0023", "tipo_venta": "VTA EN RUTA", "matnr": "2", "descripcion": "B",
                 "unidad_venta": "caja", "unidad_tarifa": "kg", "tarifa": 1.5, "num_lineas": 1,
                 "cantidad_venta_total": 20.0, "monto_total": 200.0, "cantidad_base_total": 600.0,
                 "comision_total": 900.0, "lineas_sin_comision": 0},
            ]
        raise AssertionError(nombre)

    monkeypatch.setattr(svc, "run_query", fake)
    monkeypatch.setattr(svc, "cobertura", lambda: {"desde": "2026-01-02", "hasta": "2026-10-06"})
    # Sin caché entre pruebas y con el estado guardado en memoria, no en Firestore.
    svc._CACHE.clear()
    monkeypatch.setattr(estado, "_store", estado.MemoriaStore())
    return llamadas


def test_rango_mes():
    assert svc.rango_mes("2026-02") == (date(2026, 2, 1), date(2026, 2, 28))
    assert svc.rango_mes("2026-12") == (date(2026, 12, 1), date(2026, 12, 31))
    with pytest.raises(ValueError):
        svc.rango_mes("2026-13")


def test_el_mes_trae_los_pagos_con_su_estado_y_la_sugerencia(bq):
    r = svc.build_mes(mes="2026-07")
    assert r["cobertura"] == {"desde": "2026-01-02", "hasta": "2026-10-06"}
    (fila,) = r["filas"]
    assert fila["fila_id"] == f"DBC|{LIFNR}|H"
    assert fila["comisionista"] == "EDGARDO TRUJILLO DE LA TORRE"
    por_estado = {p["pago_id"]: p for p in fila["pagos"]}
    con_ventana = [p for p in fila["pagos"] if p["ini"]]
    # el primer pago termina el 3 jul pero se pagó hasta el 2: sugerencia única
    assert con_ventana[0]["estado"] == "sug"
    assert con_ventana[0]["sugerencia"]["unica"] is True
    assert {c["borde"] for c in con_ventana[0]["sugerencia"]["cambios"]} == {"fin", "ini"}
    assert con_ventana[0]["ini"] == "2026-06-27" and con_ventana[0]["fin"] == "2026-07-03"
    sin = [p for p in fila["pagos"] if p["estado"] == "sinv"]
    assert len(sin) == 1 and sin[0]["ini"] is None and sin[0]["pagado"] == 500.0
    assert len(por_estado) == 3


def test_los_pagos_que_no_tocan_el_mes_no_se_devuelven(bq):
    r = svc.build_mes(mes="2026-09")
    assert r["filas"] == []


def test_el_rango_cargado_lleva_margen_a_cada_lado(bq):
    svc.build_mes(mes="2026-07")
    nombre, params = bq[0]
    assert params["ini_ext"][1] == date(2026, 7, 1) - timedelta(days=svc.MARGEN_DIAS)
    assert params["fin_ext"][1] == date(2026, 7, 31) + timedelta(days=svc.MARGEN_DIAS)


def test_el_panel_trae_los_pagos_de_la_fila_y_sus_cobros_diarios(bq):
    r = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert len(r["fila"]["pagos"]) == 3
    assert len(r["dias"]) == 35
    assert r["dias"][0] == ["2026-06-27", MONTOS[0]]
    assert r["fila"]["cortes"][0]["fecha"] == "2026-07-03"


def test_el_panel_de_una_fila_inexistente_no_falla(bq):
    r = svc.build_fila(mes="2026-07", sociedad="PAN", comisionista_id="0000009999", division_code="H")
    assert r == {"mes": "2026-07", "fila": None, "dias": [], "dias_partes": {}}


def test_el_detalle_devuelve_las_filas_y_el_total_de_comision(bq):
    r = svc.build_detalle(sociedad="DBC", comisionista_id=LIFNR, division_code="H", ini=date(2026, 7, 4), fin=date(2026, 7, 10))
    assert r["comision_total"] == 1350.0
    assert [f["matnr"] for f in r["filas"]] == ["2", "1"]  # mayor cantidad primero


def test_endpoint_mes(bq):
    r = client.post("/v1/comisionesbi/cortes/mes", json={"mes": "2026-07"})
    assert r.status_code == 200
    assert r.json()["filas"][0]["pagos"][0]["estado"] in ("sug", "ok", "sin")


def test_endpoint_mes_rechaza_un_mes_mal_escrito():
    assert client.post("/v1/comisionesbi/cortes/mes", json={"mes": "julio"}).status_code == 422
    assert client.post("/v1/comisionesbi/cortes/mes", json={"mes": "2026-13"}).status_code == 422


def test_endpoint_fila_y_detalle(bq):
    r = client.post(
        "/v1/comisionesbi/cortes/fila",
        json={"mes": "2026-07", "sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H"},
    )
    assert r.status_code == 200 and len(r.json()["dias"]) == 35
    r = client.post(
        "/v1/comisionesbi/cortes/detalle",
        json={"sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H", "ini": "2026-07-04", "fin": "2026-07-10"},
    )
    assert r.status_code == 200 and r.json()["comision_total"] == 1350.0


def test_endpoint_detalle_rechaza_un_rango_al_reves():
    r = client.post(
        "/v1/comisionesbi/cortes/detalle",
        json={"sociedad": "DBC", "comisionista_id": LIFNR, "ini": "2026-07-10", "fin": "2026-07-04"},
    )
    assert r.status_code == 422


# ─── Ediciones guardadas ─────────────────────────────────────────────────

KEY = ("DBC", LIFNR, "H")
PAGO1 = "DBC|2026|0000000001"
PAGO2 = "DBC|2026|0000000002"
ADMIN = {"x-rol": "admin", "x-usuario": "ana@proan.com"}


def _fila(vista):
    return {p["pago_id"]: p for p in vista["fila"]["pagos"]}


def test_aplicar_la_sugerencia_se_guarda_y_devuelve_la_fila_ya_actualizada(bq):
    antes = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert antes["fila"]["version"] == 0 and _fila(antes)[PAGO1]["estado"] == "sug"

    vista = svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=None, version=0, usuario="ana")

    assert vista["fila"]["version"] == 1
    assert _fila(vista)[PAGO1]["estado"] == "ok" and _fila(vista)[PAGO2]["estado"] == "ok"
    assert _fila(vista)[PAGO1]["fin"] == "2026-07-02" and _fila(vista)[PAGO1]["ajustado"] is True
    assert _fila(vista)[PAGO1]["fin_default"] == "2026-07-03"
    # y sobrevive: una lectura nueva ve lo mismo
    de_nuevo = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert _fila(de_nuevo)[PAGO1]["fin"] == "2026-07-02"
    # la lista del mes también lo refleja
    mes = svc.build_mes(mes="2026-07")
    assert {p["estado"] for p in mes["filas"][0]["pagos"] if p["ini"]} == {"ok"}


def test_dos_ediciones_con_la_misma_version_chocan(bq):
    svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=None, version=0, usuario="ana")
    with pytest.raises(ConflictoVersion):
        svc.descartar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, version=0, usuario="luis")


def test_una_sugerencia_que_ya_es_otra_no_se_aplica(bq):
    vista = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    vistos = list(_fila(vista)[PAGO1]["sugerencia"]["cambios"])
    vistos[0] = {**vistos[0], "a": "2026-07-01"}
    with pytest.raises(ErrorCorte) as e:
        svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=vistos, version=0, usuario="ana")
    assert e.value.codigo == "sugerencia_distinta"
    # con los cambios tal cual los vio, sí
    vistos_ok = _fila(vista)[PAGO1]["sugerencia"]["cambios"]
    assert svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=vistos_ok, version=0, usuario="ana")


def test_descartar_deja_el_pago_sin_explicacion_y_recuperar_la_devuelve(bq):
    v = svc.descartar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, version=0, usuario="ana")
    assert _fila(v)[PAGO1]["estado"] == "sin" and _fila(v)[PAGO1]["sugerencia"] is None
    assert _fila(v)[PAGO1]["descartada"] is True
    v = svc.recuperar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, version=1, usuario="ana")
    assert _fila(v)[PAGO1]["estado"] == "sug" and v["fila"]["version"] == 2


def test_mover_el_corte_a_mano_actualiza_los_dos_pagos_y_queda_en_el_historial(bq):
    v = svc.mover_corte(mes="2026-07", key=KEY, izq_pago_id=PAGO1, fecha=date(2026, 7, 2), version=0, usuario="ana")
    assert _fila(v)[PAGO1]["fin"] == "2026-07-02" and _fila(v)[PAGO2]["ini"] == "2026-07-03"
    (evento,) = svc.build_historial(key=KEY)["eventos"]
    assert evento["tipo"] == "mover_corte" and evento["usuario"] == "ana" and evento["pago_id"] == PAGO1
    assert evento["antes"] == {} and evento["despues"][PAGO1] == {"fin": "2026-07-02"}


def test_restablecer_devuelve_la_ventana_del_texto_en_los_dos_pagos(bq):
    svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=None, version=0, usuario="ana")
    v = svc.restablecer_pago(mes="2026-07", key=KEY, pago_id=PAGO1, version=1, usuario="ana")
    assert _fila(v)[PAGO1]["fin"] == "2026-07-03" and _fila(v)[PAGO2]["ini"] == "2026-07-04"
    assert not _fila(v)[PAGO1]["ajustado"] and not _fila(v)[PAGO2]["ajustado"]
    assert estado.get_store().leer([KEY])[KEY].overrides == {}


def test_un_corte_de_un_pago_consolidado_no_se_mueve(bq):
    foto = estado.Foto(date(2026, 7, 4), date(2026, 7, 10), 100.0, 100.0)
    estado.get_store().escribir(KEY, 0, estado.DocFila(consolidados={PAGO2: foto}), {"tipo": "prueba"})
    with pytest.raises(ErrorCorte) as e:
        svc.mover_corte(mes="2026-07", key=KEY, izq_pago_id=PAGO1, fecha=date(2026, 7, 2), version=1, usuario="ana")
    assert e.value.codigo == "corte_congelado"


def test_editar_un_pago_que_ya_no_existe_falla_con_claridad(bq):
    with pytest.raises(ErrorCorte) as e:
        svc.descartar_sugerencia(mes="2026-07", key=KEY, pago_id="DBC|2026|9999999999", version=0, usuario="ana")
    assert e.value.codigo == "pago_inexistente"


def test_la_lista_del_mes_trae_la_version_de_cada_fila(bq):
    svc.descartar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, version=0, usuario="ana")
    assert svc.build_mes(mes="2026-07")["filas"][0]["version"] == 1


# ─── Endpoints de edición ────────────────────────────────────────────────

CUERPO = {"mes": "2026-07", "sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H", "version": 0}


def test_editar_sin_rol_de_administrador_es_403(bq):
    r = client.post("/v1/comisionesbi/cortes/sugerencia/descartar", json={**CUERPO, "pago_id": PAGO1})
    assert r.status_code == 403
    r = client.post("/v1/comisionesbi/cortes/sugerencia/descartar", json={**CUERPO, "pago_id": PAGO1},
                    headers={"x-rol": "viewer", "x-usuario": "x"})
    assert r.status_code == 403


def test_aplicar_por_la_api_devuelve_la_fila_y_un_segundo_intento_viejo_es_409(bq):
    r = client.post("/v1/comisionesbi/cortes/sugerencia/aplicar", json={**CUERPO, "pago_id": PAGO1}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["fila"]["version"] == 1
    r = client.post("/v1/comisionesbi/cortes/sugerencia/aplicar", json={**CUERPO, "pago_id": PAGO1}, headers=ADMIN)
    assert r.status_code == 409 and r.json()["codigo"] == "conflicto_version"


def test_mover_por_la_api_y_error_de_corte_invalido_es_422(bq):
    r = client.post("/v1/comisionesbi/cortes/mover", json={**CUERPO, "izq_pago_id": PAGO1, "fecha": "2026-07-02"}, headers=ADMIN)
    assert r.status_code == 200
    r = client.post("/v1/comisionesbi/cortes/mover",
                    json={**CUERPO, "version": 1, "izq_pago_id": PAGO1, "fecha": "2026-07-20"}, headers=ADMIN)
    assert r.status_code == 422 and r.json()["codigo"] == "ventana_invalida"


def test_el_historial_lo_puede_ver_cualquiera(bq):
    client.post("/v1/comisionesbi/cortes/sugerencia/descartar", json={**CUERPO, "pago_id": PAGO1}, headers=ADMIN)
    r = client.post("/v1/comisionesbi/cortes/historial",
                    json={"sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H"})
    assert r.status_code == 200 and r.json()["eventos"][0]["tipo"] == "descartar_sugerencia"


def test_huevo_de_dbc_junta_abarrotes_en_un_solo_calculo(bq, monkeypatch):
    """El SQL ya manda Abarrotes con la división de pago H y su origen A: el calculado y el panel los suman."""
    original = svc.run_query

    def con_abarrotes(sql, nombre, parametros=None):
        filas = original(sql, nombre, parametros)
        if "cobros diarios" in nombre:
            extra = [
                {"sociedad": "DBC", "comisionista_id": LIFNR, "division_code": "H", "origen": "A",
                 "fecha": D0 + timedelta(days=i), "comision": 100.0}
                for i in range(35)
            ]
            filas = [{**f, "origen": "H"} for f in filas] + extra
        return filas

    monkeypatch.setattr(svc, "run_query", con_abarrotes)
    r = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert dict(r["dias"])["2026-06-27"] == MONTOS[0] + 100.0
    assert set(r["dias_partes"]) == {"H", "A"}
    assert dict(r["dias_partes"]["A"])["2026-06-27"] == 100.0
    assert r["fila"]["junta_con"] == ["A"]
    # El pago de 27 jun a 3 jul cuadra con Huevo + Abarrotes (7 días = 700 más), no solo con Huevo
    primero = next(p for p in r["fila"]["pagos"] if p["ini"] == "2026-06-27")
    assert primero["calculado"] == pytest.approx(_suma(0, 6) + 700.0)


def test_las_divisiones_que_no_se_juntan_no_traen_partes(bq):
    r = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    # H de DBC sí declara junta_con aunque ese comisionista no tenga Abarrotes cobrado
    assert r["fila"]["junta_con"] == ["A"]
    assert set(r["dias_partes"]) == {"H"}


def test_cada_pago_trae_su_documento_su_compensacion_y_el_texto_de_sap(bq):
    r = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    primero = next(p for p in r["fila"]["pagos"] if p["ini"] == "2026-06-27")
    (doc,) = primero["documentos"]
    assert doc["documento"] == "0000000001"
    assert doc["compensacion"] == "2000000001"
    assert doc["texto"] == "COMISION HUEVO 1"
    mes = svc.build_mes(mes="2026-07")
    assert mes["filas"][0]["pagos"][0]["documentos"]


# ─── Fase 5: consolidar, reabrir, lote, ventana a mano y huérfanos ───────

PAGO3 = "DBC|2026|0000000003"  # sin ventana legible
FILA_ID = f"DBC|{LIFNR}|H"


def test_consolidar_congela_el_pago_y_sus_cortes_y_guarda_quien_lo_hizo(bq):
    svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=None, version=0, usuario="ana")
    v = svc.consolidar(mes="2026-07", key=KEY, pago_id=PAGO1, version=1, usuario="luis")
    p = _fila(v)[PAGO1]
    assert p["estado"] == "cons" and p["consolidado_por"] == "luis" and p["consolidado_en"]
    assert p["drift"] == 0 and p["drift_pagado"] == 0
    assert v["fila"]["cortes"][0]["congelado"] is True
    # el corte que comparte con el vecino ya no se mueve
    with pytest.raises(ErrorCorte) as e:
        svc.mover_corte(mes="2026-07", key=KEY, izq_pago_id=PAGO1, fecha=date(2026, 7, 3), version=2, usuario="ana")
    assert e.value.codigo == "corte_congelado"
    # y sobrevive a una lectura nueva
    de_nuevo = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert _fila(de_nuevo)[PAGO1]["estado"] == "cons"
    assert svc.build_historial(key=KEY)["eventos"][0]["tipo"] == "consolidar"


def test_se_puede_consolidar_con_diferencia_y_la_foto_guarda_lo_de_ese_momento(bq):
    v = svc.consolidar(mes="2026-07", key=KEY, pago_id=PAGO1, version=0, usuario="ana")
    p = _fila(v)[PAGO1]
    assert p["estado"] == "cons" and p["diferencia"] != 0
    foto = estado.get_store().leer([KEY])[KEY].consolidados[PAGO1]
    assert foto.calculado == pytest.approx(_suma(0, 6)) and foto.pagado == pytest.approx(_suma(0, 5))
    with pytest.raises(ErrorCorte) as e:
        svc.consolidar(mes="2026-07", key=KEY, pago_id=PAGO1, version=1, usuario="ana")
    assert e.value.codigo == "ya_consolidado"


def test_si_los_datos_cambian_despues_de_consolidar_se_avisa_con_el_drift(bq):
    foto = estado.Foto(date(2026, 7, 4), date(2026, 7, 10), 100.0, 100.0)
    estado.get_store().escribir(KEY, 0, estado.DocFila(consolidados={PAGO2: foto}), {"tipo": "prueba"})
    vista = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    p = _fila(vista)[PAGO2]
    assert p["estado"] == "cons"
    assert p["drift"] == pytest.approx(_suma(7, 13) - 100.0)
    assert p["drift_pagado"] == pytest.approx(_suma(6, 13) - 100.0)


def test_reabrir_devuelve_el_pago_a_calcularse_y_no_se_puede_reabrir_lo_abierto(bq):
    svc.consolidar(mes="2026-07", key=KEY, pago_id=PAGO1, version=0, usuario="ana")
    v = svc.reabrir(mes="2026-07", key=KEY, pago_ids=[PAGO1], version=1, usuario="ana")
    assert _fila(v)[PAGO1]["estado"] == "sug" and _fila(v)[PAGO1]["consolidado_por"] is None
    with pytest.raises(ErrorCorte) as e:
        svc.reabrir(mes="2026-07", key=KEY, pago_ids=[PAGO1], version=2, usuario="ana")
    assert e.value.codigo == "no_consolidado"
    assert [x["tipo"] for x in svc.build_historial(key=KEY)["eventos"]][:2] == ["reabrir", "consolidar"]


def test_consolidar_lo_que_cuadra_va_de_izquierda_a_derecha_y_se_detiene_en_lo_que_no_cuadra(bq):
    # el primer pago aún pide sugerencia: el lote no consolida nada
    assert svc.build_mes(mes="2026-07")["filas"][0]["lote"] == []
    assert svc.consolidar_lote(mes="2026-07", fila_ids=[FILA_ID], usuario="ana") == {"consolidados": 0, "filas": 0, "omitidas": 0}
    vista = svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=None, version=0, usuario="ana")
    # la fila que devuelve una edición trae el mismo lote que la lista, para que el conteo de la pantalla no baile
    assert vista["fila"]["lote"] == [PAGO1, PAGO2]
    assert svc.build_mes(mes="2026-07")["filas"][0]["lote"] == [PAGO1, PAGO2]
    r = svc.consolidar_lote(mes="2026-07", fila_ids=[FILA_ID], usuario="ana")
    assert r == {"consolidados": 2, "filas": 1, "omitidas": 0}
    pagos = _fila(svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H"))
    assert pagos[PAGO1]["estado"] == pagos[PAGO2]["estado"] == "cons" and pagos[PAGO2]["consolidado_por"] == "ana"
    assert svc.build_mes(mes="2026-07")["filas"][0]["lote"] == []


def test_el_lote_solo_toca_las_filas_pedidas(bq):
    svc.aplicar_sugerencia(mes="2026-07", key=KEY, pago_id=PAGO1, cambios_vistos=None, version=0, usuario="ana")
    assert svc.consolidar_lote(mes="2026-07", fila_ids=["DBC|0000000000|H"], usuario="ana")["consolidados"] == 0


def test_un_pago_sin_ventana_recibe_la_que_le_da_la_persona(bq):
    v = svc.fijar_ventana(mes="2026-07", key=KEY, pago_id=PAGO3, ini=date(2026, 7, 4), fin=date(2026, 7, 10), version=0, usuario="ana")
    p = _fila(v)[PAGO3]
    assert p["ini"] == "2026-07-04" and p["fin"] == "2026-07-10" and p["estado"] != "sinv"
    assert p["ini_default"] is None and p["ajustado"] is True
    # volver a la ventana del texto lo devuelve a "sin ventana"
    v = svc.restablecer_pago(mes="2026-07", key=KEY, pago_id=PAGO3, version=1, usuario="ana")
    assert _fila(v)[PAGO3]["estado"] == "sinv"


def test_fijar_ventana_rechaza_un_pago_que_ya_la_tiene_y_un_rango_al_reves(bq):
    with pytest.raises(ErrorCorte) as e:
        svc.fijar_ventana(mes="2026-07", key=KEY, pago_id=PAGO1, ini=date(2026, 7, 1), fin=date(2026, 7, 2), version=0, usuario="ana")
    assert e.value.codigo == "tiene_ventana"
    with pytest.raises(ErrorCorte) as e:
        svc.fijar_ventana(mes="2026-07", key=KEY, pago_id=PAGO3, ini=date(2026, 7, 10), fin=date(2026, 7, 4), version=0, usuario="ana")
    assert e.value.codigo == "ventana_invalida"


def test_un_ajuste_de_un_documento_que_ya_no_esta_en_sap_se_avisa_y_se_puede_quitar(bq):
    fantasma = "DBC|2026|9999999999"
    ov = {fantasma: {"ini": date(2026, 7, 5), "fin": date(2026, 7, 8)}}
    estado.get_store().escribir(KEY, 0, estado.DocFila(overrides=ov), {"tipo": "prueba"})
    fila = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")["fila"]
    assert fila["huerfanos"] == [{"pago_id": fantasma, "tipo": "ajuste", "ini": "2026-07-05", "fin": "2026-07-08"}]
    v = svc.quitar_huerfano(mes="2026-07", key=KEY, pago_id=fantasma, version=1, usuario="ana")
    assert v["fila"]["huerfanos"] == []
    with pytest.raises(ErrorCorte) as e:
        svc.quitar_huerfano(mes="2026-07", key=KEY, pago_id=PAGO1, version=2, usuario="ana")
    assert e.value.codigo == "no_huerfano"


def test_los_ajustes_de_otro_rango_no_cuentan_como_huerfanos(bq):
    lejos = {"DBC|2026|8888888888": {"ini": date(2025, 1, 5), "fin": date(2025, 1, 8)}}
    estado.get_store().escribir(KEY, 0, estado.DocFila(overrides=lejos), {"tipo": "prueba"})
    vista = svc.build_fila(mes="2026-07", sociedad="DBC", comisionista_id=LIFNR, division_code="H")
    assert vista["fila"]["huerfanos"] == []


def test_consolidar_y_reabrir_por_la_api_piden_rol_de_administrador(bq):
    url = "/v1/comisionesbi/cortes"
    viewer = {"x-rol": "viewer", "x-usuario": "x"}
    assert client.post(f"{url}/consolidar", json={**CUERPO, "pago_id": PAGO1}, headers=viewer).status_code == 403
    r = client.post(f"{url}/consolidar", json={**CUERPO, "pago_id": PAGO1}, headers=ADMIN)
    assert r.status_code == 200 and {p["pago_id"]: p for p in r.json()["fila"]["pagos"]}[PAGO1]["estado"] == "cons"
    r = client.post(f"{url}/reabrir", json={**CUERPO, "version": 1, "pago_ids": [PAGO1]}, headers=ADMIN)
    assert r.status_code == 200
    r = client.post(f"{url}/reabrir", json={**CUERPO, "version": 2, "pago_ids": [PAGO1]}, headers=ADMIN)
    assert r.status_code == 422 and r.json()["codigo"] == "no_consolidado"
    r = client.post(f"{url}/consolidar-lote", json={"mes": "2026-07", "fila_ids": [FILA_ID]}, headers=ADMIN)
    assert r.status_code == 200 and r.json()["consolidados"] == 0
