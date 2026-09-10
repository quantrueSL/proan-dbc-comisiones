"""Módulo 3 · Conciliación por comisionista — el detalle que hoy se arma a mano.

Quien concilia hace esto cada semana (sábado a viernes, se paga el viernes
siguiente): ve la factura del comisionista, ve qué vendió esa semana, escribe
los productos uno por uno con su tarifa y cantidad, multiplica, y compara el
total contra lo que le pagaron. Ese último paso YA NO hay que hacerlo a mano
(2026-09-08): `pago_real`/`comision_calculada`/`diferencia` en
`por_comisionista` traen la comparación lista, y el detalle por producto de
esa misma fila es su justificación -- no hay una explicación aparte de la
diferencia, es la venta que la sustenta. Fuente: `DBC_gold_conciliacion_pago_semanal`
(`Datos/sql/v1_conciliacion_pago_semanal.sql` -- ahí está el porqué de cada
decisión: identificación por texto de BSAK, fecha de venta en vez de cobro,
sociedad en la llave). SIGUE SIN SER LA FUENTE ESTRUCTURADA que se buscó en su
momento (`Datos/Comisiones_DBC_Borrador_Tecnico.md`, sección 16.3) -- es texto
libre, con sus límites (ver el archivo SQL).

Lee `ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario` (grano día) con JOIN a
`DBC_dim_periodo_pago` (fecha -> periodo de pago, `Datos/sql/v1_dim_periodo_pago.sql`
-- ahí está el porqué de cada corte de mes) y agrupa por periodo × sociedad ×
comisionista × CEDIS × oficina × tipo de venta × producto — el mismo grano
que ella escribe en su hoja. La diferencia con antes (2026-09-09, pedido de
Silvana): el filtro de fecha corta el DÍA exacto, no el periodo completo -- si
el rango pedido corta un periodo a la mitad, esa fila del periodo solo trae
los días que sí caen en el rango, "Calculado" responde al filtro de verdad en
vez de meter o quitar un periodo entero. `DBC_gold_conciliacion_producto_semanal`
(la tabla pre-agregada por periodo completo, `v1_conciliacion_producto_semanal.sql`)
ya NO la lee este módulo -- se deja viva por si el cliente la necesita para
algo fuera de esta app, pero aquí quedó reemplazada. `detalle_diario()` lee la
misma tabla diaria sin el JOIN de periodo, para la pestaña de detalle día por
día del Excel exportado. `detalle_factura()` baja un nivel más, a la línea de
factura real (`DBC_gold_conciliacion_factura_linea`, la base de la que sale
diario) — trae también cobro por línea, la única excepción a "en pausa
perseguir cobro": cuando se pueda calcular comisión sobre lo cobrado, sale de
esta tabla.

PENDIENTE, a propósito, no resuelto aquí:
  - La fecha que alinea pago vs. calculado es de VENTA, no de cobro -- se
    probaron las dos, dieron parecido, y venta no depende del rezago de
    `sap_bsad_cleared_items` en meses recientes. PENDIENTE DE CONFIRMAR con el
    cliente cuál usan de verdad (ver la cabecera de `v1_conciliacion_pago_semanal.sql`).
  - ~$5.1M de comisión calculada (3 comisionistas, ver memoria de sesión) no
    tiene con qué compararse: su LIFNR nunca aparece pagando comisión en BSAK,
    en ninguna división ni sociedad. Sale como "cálculo sin pago" en toda su
    fila, no como un error silencioso.
  - "Calculado" es dinámico (exacto al filtro, 2026-09-09) pero "Pagado" sigue
    atómico por periodo completo (es un pago real de BSAK, identificado por
    periodo en su texto -- no se puede partir un pago que nunca existió a la
    mitad, ver `v1_conciliacion_pago_semanal.sql`). Por diseño pueden no
    coincidir en el borde de un periodo si el filtro lo corta: no es un bug,
    es que uno de los dos lados sí se puede recortar exacto y el otro no.
  - El corte de periodo en fin de mes (2026-09-02) sigue siendo un supuesto de
    Silvana sin confirmar con el cliente -- ver la cabecera de
    `v1_dim_periodo_pago.sql`. Por eso existe el detalle diario: para poder
    verificar o ajustar a mano si un caso concreto no encaja.
  - `unidad_venta`/`unidad_tarifa` confirmadas 2026-09-07 con la distribución
    real de `sales_unit` por división (monto DBC 2026): H 99.97% CS -> caja;
    IA ~100% SAC -> saco; BO 99.4% PAQ -> paquete; A y L 100% PZA -> pieza.
    `unidad_tarifa` (antes `base_unidad`) es kg en H/IA (peso real) e igual a
    `unidad_venta` en BO/A/L (no hay conversión real ahí, es la misma
    cantidad). Ya no es un supuesto pendiente.
  - `comisionista` sigue en NULL donde ninguna fuente trae su nombre — esas
    líneas se agrupan bajo `None`, no desaparecen.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from comisionesbi.db import run_query

_TABLA_DIARIA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_producto_diario`"
_TABLA_FACTURA = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_factura_linea`"
_TABLA_PAGO = "`proan-quantrue.ZZ_PRUEBAS.DBC_gold_conciliacion_pago_semanal`"
_TABLA_DIM_PERIODO = "`proan-quantrue.ZZ_PRUEBAS.DBC_dim_periodo_pago`"

# Grano día (filtro `fecha BETWEEN`, no `semana BETWEEN`) agrupado por periodo
# de pago solo para mostrarse -- 2026-09-09, pedido de Silvana: antes leía la
# tabla ya pre-agregada por periodo (`DBC_gold_conciliacion_producto_semanal`)
# y un filtro que cortara un periodo a la mitad lo incluía o excluía COMPLETO
# según de qué lado cayera el corte (ver el aviso en pantalla de antes de este
# cambio). Al filtrar el día real y agrupar después con el JOIN, un periodo
# cortado por el filtro solo trae los días que sí caen en el rango.
_DETALLE_SQL = f"""
SELECT
  d.sociedad, p.periodo_inicio AS semana, p.periodo_fin, d.division_code, d.division, d.cedis,
  d.oficina, d.comisionista_id, d.comisionista, d.tipo_venta, d.matnr, d.descripcion, d.unidad_venta, d.unidad_tarifa,
  ANY_VALUE(d.tarifa)            AS tarifa,
  SUM(d.num_lineas)              AS num_lineas,
  SUM(d.cantidad_venta_total)    AS cantidad_venta_total,
  SUM(d.monto_total)             AS monto_total,
  SUM(d.cantidad_base_total)     AS cantidad_base_total,
  SUM(d.comision_total)          AS comision_total,
  SUM(d.lineas_sin_comision)     AS lineas_sin_comision
FROM {_TABLA_DIARIA} d
JOIN {_TABLA_DIM_PERIODO} p ON p.fecha = d.fecha
WHERE d.fecha BETWEEN @start AND @end
  AND (@division IS NULL OR d.division_code = @division)
  AND (@comisionista_id IS NULL OR d.comisionista_id = @comisionista_id)
GROUP BY p.periodo_inicio, p.periodo_fin, d.sociedad, d.division_code, d.division, d.cedis, d.oficina,
         d.comisionista_id, d.comisionista, d.tipo_venta, d.matnr, d.descripcion, d.unidad_venta, d.unidad_tarifa
"""

# Pago real (BSAK) por sociedad+comisionista+división+periodo -- ver
# v1_conciliacion_pago_semanal.sql para el porqué de cada decisión (texto en
# vez de campo estructural, fecha de venta en vez de cobro, sociedad en la
# llave). Solo se usa `pago_real`: `comision_calculada` de esa tabla es el
# LEFT JOIN acotado a los periodos que sí tienen un pago real, no el total del
# rango -- lo que se muestra como "Calculado" en el nivel 1 es `comision_total`
# de `_DETALLE_SQL` (el mismo total que ya ve el detalle), para que no
# desaparezca en $0 cuando un comisionista tiene comisión calculada pero
# ningún pago con el que cruzarla. A diferencia de `_DETALLE_SQL`, esta sigue
# filtrando por `periodo` (no por un día real dentro de él): un pago de BSAK
# es un solo importe por periodo completo, no hay un día más fino al que bajar.
_DETALLE_PAGO_SQL = f"""
SELECT sociedad, comisionista_id, comisionista, division_code, periodo, periodo_fin, pago_real
FROM {_TABLA_PAGO}
WHERE periodo BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
"""

# Mismas columnas que `_DETALLE_SQL` pero por día (`fecha`), no por periodo de
# pago -- la transparencia que pidió Silvana para el borde de mes: el periodo
# agregado es un supuesto (ver v1_conciliacion_producto_semanal.sql), así que
# el Excel también trae el desglose día por día para que se pueda verificar o
# ajustar a mano si el supuesto no encaja con un caso concreto.
#
# Filtro de `sociedad` obligatorio en la práctica (aunque opcional en SQL):
# se pide siempre para UN comisionista+división ya elegidos en la pantalla, y
# la misma persona puede tener datos en DBC y en PAN -- sin este filtro las
# dos sociedades se mezclan en una sola hoja del Excel.
_DETALLE_DIARIO_SQL = f"""
SELECT
  fecha, sociedad, division_code, division, cedis, oficina, comisionista_id, comisionista, tipo_venta,
  matnr, descripcion, unidad_venta, unidad_tarifa, tarifa,
  num_lineas, cantidad_venta_total, monto_total, cantidad_base_total,
  comision_total, lineas_sin_comision
FROM {_TABLA_DIARIA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
  AND (@sociedad IS NULL OR sociedad = @sociedad)
"""

# Grano línea de factura -- la hoja de máximo detalle del Excel: de la
# comisión calculada a la factura exacta que la compone. Incluye cobro
# (se_cobro/monto_cobrado/comision_cobrada), a diferencia de las otras dos: es
# la excepción a propósito a "en pausa perseguir cobro" (2026-09-02) porque
# cuando se pueda calcular la comisión sobre lo cobrado, sale de aquí.
# Mismo filtro de `sociedad` que `_DETALLE_DIARIO_SQL` y por el mismo motivo.
_DETALLE_FACTURA_SQL = f"""
SELECT
  billing_document, item_number, fecha, sociedad, division_code, division, cedis,
  oficina, comisionista_id, comisionista, tipo_venta, matnr, descripcion, unidad_venta,
  cantidad_venta, unidad_tarifa, cantidad_base, tarifa, monto, comision,
  comision_estado, se_cobro, monto_cobrado, cantidad_cobrada,
  comision_cobrada, fecha_cobro
FROM {_TABLA_FACTURA}
WHERE fecha BETWEEN @start AND @end
  AND (@division IS NULL OR division_code = @division)
  AND (@comisionista_id IS NULL OR comisionista_id = @comisionista_id)
  AND (@sociedad IS NULL OR sociedad = @sociedad)
"""

# Sin filtro de fechas a propósito, igual que en flujo/comisiones: "hasta
# cuándo hay datos" es una propiedad del dataset, no del rango pedido. Sobre
# la tabla diaria (no la semanal, que ya no lee este módulo): `MAX(fecha)` es
# el último día real con dato, más preciso que el inicio del último periodo.
_COBERTURA_SQL = f"SELECT MIN(fecha) AS desde, MAX(fecha) AS hasta FROM {_TABLA_DIARIA}"


def _iso(valor) -> str | None:
    return valor.isoformat() if hasattr(valor, "isoformat") else valor


def cobertura() -> dict:
    filas = run_query(_COBERTURA_SQL, "la cobertura de conciliación")
    if not filas:
        return {}
    return {"desde": _iso(filas[0]["desde"]), "hasta": _iso(filas[0]["hasta"])}


def _nuevo_comisionista() -> dict:
    return {
        "num_lineas": 0,
        "monto_total": 0.0,
        "comision_total": 0.0,
        "lineas_sin_comision": 0,
        "semanas": set(),
        # Lo que de verdad se le pagó (BSAK), sumado sobre TODO el rango --
        # "el total es el total" (no por periodo). Sigue siendo atómico por
        # periodo completo (2026-09-09): un pago de BSAK no se puede partir a
        # la mitad, así que si el rango pedido corta un periodo, ese periodo
        # entra o sale completo aquí -- a diferencia de `comision_total` de
        # arriba, que desde `_DETALLE_SQL` ya viene exacto al día pedido.
        # `tiene_pago`/`tiene_calculo` existen porque 0.0 no dice si de verdad
        # no hubo nada o si esa fuente nunca llegó a tocar esta fila.
        "pago_real": 0.0,
        "tiene_pago": False,
        "tiene_calculo": False,
    }


def build_conciliacion(
    *,
    division: str | None,
    comisionista_id: str | None,
    start_date: date,
    end_date: date,
) -> dict:
    """Punto de entrada de POST /v1/comisionesbi/conciliacion.

    `por_comisionista` es el nivel 1 de la pantalla (a quién hay que pagarle
    esta semana), con lo pagado (BSAK) al lado de lo calculado -- el detalle
    por producto de la propia fila es su justificación, sin nada nuevo que
    explicar la diferencia: eso lo hace quien concilia, no la pantalla.
    `detalle` trae cada fila tal cual sale de la tabla gold —ya al grano de
    producto— para que la pantalla arme la cascada CEDIS → oficina → tipo de
    venta → producto agrupando en memoria: filtrado a un comisionista y unas
    semanas, son decenas de filas, no miles, así que no hace falta que el
    backend pre-agregue cada nivel como sí hace `comisiones_engine`. `pago_semanal`
    (2026-09-09) es el mismo pago real que ya se sumó en `por_comisionista`,
    pero SIN colapsar por periodo -- el nivel 2 (panel de detalle + Excel) lo
    usa para mostrar Pagado al lado de Calculado en CADA periodo, no solo el
    total del rango completo.
    """
    filas = run_query(
        _DETALLE_SQL,
        "la conciliación por comisionista",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista_id": ("STRING", comisionista_id),
        },
    )
    filas_pago = run_query(
        _DETALLE_PAGO_SQL,
        "el pago real por comisionista",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista_id": ("STRING", comisionista_id),
        },
    )

    por_comisionista: dict = defaultdict(_nuevo_comisionista)
    nombre_division: dict = {}
    # Se agrupa por `comisionista_id`, no por el texto -- el mismo persona_cod
    # llega con grafía distinta desde el Excel de DBC y el de PAN (ver
    # `v1_comision_dbc_gold_v2.sql`). La sociedad SÍ se queda en la llave: la
    # misma persona puede tener oficinas en DBC y en PAN con pagos y cálculos
    # distintos, y eso no debe mezclarse (ver
    # test_las_dos_sociedades_del_mismo_comisionista_no_se_mezclan).
    nombre_comisionista: dict = {}

    for fila in filas:
        clave = (fila["sociedad"], fila["comisionista_id"], fila["division_code"])
        c = por_comisionista[clave]
        c["num_lineas"] += fila["num_lineas"] or 0
        c["monto_total"] += fila["monto_total"] or 0.0
        c["comision_total"] += fila["comision_total"] or 0.0
        c["lineas_sin_comision"] += fila["lineas_sin_comision"] or 0
        c["semanas"].add(fila["semana"])
        # Hay comisión calculada para este comisionista+división, exista o no
        # un pago de BSAK con el que compararla -- eso es lo que distingue
        # "cálculo sin pago" de un simple cero.
        c["tiene_calculo"] = True
        if fila["division_code"] and fila["division"]:
            nombre_division[fila["division_code"]] = fila["division"]
        if fila["comisionista_id"] and fila["comisionista"]:
            nombre_comisionista[fila["comisionista_id"]] = fila["comisionista"]

    for fila in filas_pago:
        clave = (fila["sociedad"], fila["comisionista_id"], fila["division_code"])
        c = por_comisionista[clave]
        # `pago_real` sale de una columna NUMERIC en BigQuery (DMBTR de BSAK)
        # y llega como Decimal, no float -- float() explícito para poder
        # sumarlo con el resto de la aritmética del módulo.
        c["pago_real"] += float(fila["pago_real"] or 0.0)
        c["tiene_pago"] = True
        if fila["comisionista_id"] and fila["comisionista"]:
            nombre_comisionista[fila["comisionista_id"]] = fila["comisionista"]

    filas_comisionista = [
        {
            "sociedad": sociedad,
            "comisionista_id": comisionista_id_,
            "comisionista": nombre_comisionista.get(comisionista_id_),
            "division_code": division_code,
            "division": nombre_division.get(division_code),
            "num_lineas": datos["num_lineas"],
            "monto_total": datos["monto_total"],
            "comision_total": datos["comision_total"],
            "lineas_sin_comision": datos["lineas_sin_comision"],
            "num_semanas": len(datos["semanas"]),
            "pago_real": datos["pago_real"] if datos["tiene_pago"] else None,
            "comision_calculada": datos["comision_total"] if datos["tiene_calculo"] else None,
            "diferencia": (
                datos["comision_total"] - datos["pago_real"]
                if datos["tiene_pago"] and datos["tiene_calculo"]
                else None
            ),
            "diff_pct": (
                round(100 * (datos["comision_total"] - datos["pago_real"]) / datos["pago_real"], 1)
                if datos["tiene_pago"] and datos["tiene_calculo"] and datos["pago_real"]
                else None
            ),
            # Los dos casos que más interesa revisar: se le pagó algo que
            # nuestra herramienta no calculó, o calculamos algo que nunca se
            # le pagó. Ninguno de los dos es necesariamente un error -- puede
            # ser un ajuste real (ver v1_conciliacion_pago_semanal.sql) o un
            # periodo que todavía no le toca pagarse -- pero son la primera
            # pregunta que alguien conciliando se va a hacer.
            "pago_sin_calculo": datos["tiene_pago"] and not datos["tiene_calculo"],
            "calculo_sin_pago": datos["tiene_calculo"] and not datos["tiene_pago"],
        }
        for (sociedad, comisionista_id_, division_code), datos in por_comisionista.items()
    ]
    # Por pagado de mayor a menor (pedido de Silvana, 2026-09-09 -- reemplaza
    # el orden anterior por diferencia absoluta). Sin pago (None) al final,
    # alfabético por comisionista y división como desempate -- mismo criterio
    # de siempre, nulos al final.
    filas_comisionista.sort(
        key=lambda f: (
            f["pago_real"] is None,
            -(f["pago_real"] or 0),
            f["comisionista"] is None,
            f["comisionista"] or "",
            f["division_code"] or "",
        )
    )

    return {
        "cobertura": cobertura(),
        "por_comisionista": filas_comisionista,
        "detalle": [
            {**fila, "semana": _iso(fila["semana"]), "periodo_fin": _iso(fila["periodo_fin"])} for fila in filas
        ],
        # Mismas filas que ya se sumaron en `por_comisionista` arriba, pero SIN
        # colapsar por periodo (2026-09-09, pedido de Silvana): el nivel 1 solo
        # trae el total de TODO el rango, y el nivel 2 (panel de detalle +
        # Excel) necesita el pago real de CADA periodo para compararlo contra
        # el calculado de ese mismo periodo, no solo el gran total.
        "pago_semanal": [
            {
                "sociedad": fila["sociedad"],
                "comisionista_id": fila["comisionista_id"],
                "comisionista": fila["comisionista"],
                "division_code": fila["division_code"],
                "periodo": _iso(fila["periodo"]),
                "periodo_fin": _iso(fila["periodo_fin"]),
                "pago_real": float(fila["pago_real"] or 0.0),
            }
            for fila in filas_pago
        ],
    }


def detalle_diario(
    *,
    sociedad: str | None,
    division: str | None,
    comisionista_id: str | None,
    start_date: date,
    end_date: date,
) -> list[dict]:
    """Punto de entrada de POST /v1/comisionesbi/conciliacion/diario.

    Se pide aparte y no dentro de `build_conciliacion`: esa respuesta ya trae
    el detalle de TODOS los comisionistas del rango para armar la tabla
    maestra, y el diario solo hace falta al exportar UNO -- pedirlo siempre
    multiplicaría el tamaño de cada carga de pantalla por días en vez de por
    periodos, sin que nadie lo use casi nunca. `sociedad` sí es obligatorio en
    la práctica aquí (a diferencia de `build_conciliacion`): la pantalla
    siempre pide un comisionista+división+sociedad ya elegidos de una fila
    concreta, y la misma persona puede tener datos en DBC y en PAN.
    """
    filas = run_query(
        _DETALLE_DIARIO_SQL,
        "el detalle diario de conciliación",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista_id": ("STRING", comisionista_id),
            "sociedad": ("STRING", sociedad),
        },
    )
    return [{**fila, "fecha": _iso(fila["fecha"])} for fila in filas]


def detalle_factura(
    *,
    sociedad: str | None,
    division: str | None,
    comisionista_id: str | None,
    start_date: date,
    end_date: date,
) -> list[dict]:
    """Punto de entrada de POST /v1/comisionesbi/conciliacion/factura.

    Un renglón por línea de factura real (billing_document + item_number) —
    el nivel de trazabilidad máximo: de la comisión calculada a la factura
    exacta que la compone. Se pide aparte por el mismo motivo que
    `detalle_diario`: solo hace falta al exportar un comisionista, no en cada
    carga de pantalla. Mismo motivo para `sociedad`, ver `detalle_diario`.
    """
    filas = run_query(
        _DETALLE_FACTURA_SQL,
        "el detalle de factura de conciliación",
        {
            "start": ("DATE", start_date),
            "end": ("DATE", end_date),
            "division": ("STRING", division),
            "comisionista_id": ("STRING", comisionista_id),
            "sociedad": ("STRING", sociedad),
        },
    )
    return [
        {**fila, "fecha": _iso(fila["fecha"]), "fecha_cobro": _iso(fila["fecha_cobro"])} for fila in filas
    ]
