#!/usr/bin/env python
"""Convierte los Excel de comisión del cliente en diccionarios para BigQuery.

    python scripts/tablas_cliente.py            # solo escribe los CSV
    python scripts/tablas_cliente.py --cargar   # además reemplaza las tablas en BigQuery

Lee TODO lo que haya en `reportes_proan/` y produce cinco tablas normalizadas:
el SET de cada material, la tarifa por caja, el modelo aparte de abarrotes, el
diccionario almacén+oficina+comisionista, y una lista suelta de almacén ->
nombre de CEDIS. Qué contiene cada fichero del cliente y por qué está en
`data/notas/tablas_del_cliente.md`.

NADA DEPENDE DEL NOMBRE DE UN FICHERO NI DE UNA HOJA. Es la regla de diseño
principal y no es teórica: el fichero de Leche trae su tabla en una hoja
titulada "DIVISIÓN HUEVO (H)", y los ficheros son copias de una plantilla que
arrastran hojas mal rotuladas. Así que:

  - Cada hoja se clasifica por su CONTENIDO (ver `clasifica`), no por su título.
  - La división sale siempre de la columna `División` de cada fila.
  - `fichero` y `hoja` viajan como columnas, pero solo como rastro de dónde
    salió cada dato. Ninguna lógica los mira.
  - Una hoja que no encaje en ninguna forma conocida NO se ignora en silencio:
    se avisa por pantalla, para que un fichero nuevo del cliente no pase
    desapercibido.

SIN DEPENDENCIAS PARA PARSEAR: un .xlsx es un zip con XML, así que se lee con la
librería estándar. Solo `--cargar` necesita google-cloud-bigquery.

LAS CUATRO TRAMPAS DE FORMATO, cada una descubierta después de sacar una
conclusión falsa:

  1. El vocabulario de tipos de venta cambia por división —huevo usa PISO/RUTA/
     1-2 MAYOREO/MAYOREO/ABASTOS, botana y croqueta MENUDEO/MAYOREO, leche solo
     RUTA, abarrotes ABARROTES—, así que no se puede fijar una lista: se toma lo
     que rotule la segunda fila de cabecera.
  2. La columna de almacén está unas veces en la primera fila de cabecera y
     otras en la segunda.
  3. En el fichero de SETs, el nombre del SET va encima de la columna de
     DENOMINACIÓN, no de la de material.
  4. Los códigos de material vienen de 5 a 12 dígitos según división y en SAP
     llegan rellenos a 18 con ceros.
"""
from __future__ import annotations

import argparse
import csv
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGEN = os.path.join(RAIZ, "reportes_proan")
DESTINO = os.path.join(RAIZ, "data", "tablas_cliente")

PROYECTO, DATASET, REGION = "proan-quantrue", "ZZ_PRUEBAS", "us-west4"

# Divisiones que el cliente confirmó en operación (correo del 24/08/2026). Las
# demás están configuradas en SAP pero las llevan otros departamentos.
EN_OPERACION = {"H", "BO", "IA", "A", "L"}

# Rótulos que son columnas de identificación, nunca nombres de SET ni tipos.
IDENTIFICACION = {
    "SOCIEDAD", "DIVISIÓN", "DIVISION", "ORG. VENTAS", "ORG. DE VENTAS", "CENTRO",
    "CENTRO (CEDIS)", "ALMACÉN", "ALMACEN", "PERSONA", "OFICINA DE VENTAS",
    "USUARIO QUE MOFIFICO", "FECHA DE MODIFICACIÓN", "NOMBRE", "MATERIAL",
    "DISTRIBUIDORA ALMACÉN", "PERSONAS (PROVEEDORES)", "PORCENTAJE",
    "GRUPO DE CLIENTES", "DENOMINACIÓN", "DENOMINACIÓN DEL MATERIAL", "DESCRIPCION",
}


# ── Lectura de xlsx con la librería estándar ────────────────────────────────

def _texto(nodo) -> str:
    return "".join(t.text or "" for t in nodo.iter(f"{NS}t"))


class Libro:
    def __init__(self, ruta: str):
        self.z = zipfile.ZipFile(ruta)
        self.compartidas = self._compartidas()
        self.hojas = self._hojas()

    def _compartidas(self):
        if "xl/sharedStrings.xml" not in self.z.namelist():
            return []
        raiz = ET.fromstring(self.z.read("xl/sharedStrings.xml"))
        return [_texto(si) for si in raiz.findall(f"{NS}si")]

    def _hojas(self):
        wb = ET.fromstring(self.z.read("xl/workbook.xml"))
        rels = ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))
        destino = {r.get("Id"): r.get("Target") for r in rels}
        salida = []
        for h in wb.find(f"{NS}sheets"):
            objetivo = destino.get(h.get(f"{REL}id"), "").lstrip("/")
            salida.append((h.get("name"), objetivo if objetivo.startswith("xl/") else "xl/" + objetivo))
        return salida

    def filas(self, objetivo: str) -> list[dict]:
        raiz = ET.fromstring(self.z.read(objetivo))
        salida = []
        for fila in raiz.iter(f"{NS}row"):
            celdas = {}
            for c in fila.findall(f"{NS}c"):
                col = re.match(r"([A-Z]+)", c.get("r") or "")
                if not col:
                    continue
                tipo, v = c.get("t"), c.find(f"{NS}v")
                if tipo == "s" and v is not None:
                    valor = self.compartidas[int(v.text)]
                elif tipo == "inlineStr":
                    nodo = c.find(f"{NS}is")
                    valor = _texto(nodo) if nodo is not None else ""
                else:
                    valor = v.text if v is not None else ""
                if valor not in (None, ""):
                    celdas[col.group(1)] = valor.strip() if isinstance(valor, str) else valor
            if celdas:
                salida.append(celdas)
        return salida


def num(col: str) -> int:
    n = 0
    for c in col:
        n = n * 26 + (ord(c) - 64)
    return n


def letra(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def limpia(v) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip()


def numero(v):
    try:
        return round(float(str(v).strip()), 4)
    except (TypeError, ValueError):
        return None


def normaliza_set(nombre: str) -> str:
    """Los dos ficheros escriben el mismo SET distinto: BIG_CHO vs BIG CHOCOLATE."""
    s = limpia(nombre).upper().replace("_", " ")
    return {"BIG CHO": "BIG CHOCOLATE", "BIG VAI": "BIG VAINILLA",
            "SW ROLL": "SWICH ROLL"}.get(s, s)


# ── Clasificación por contenido ────────────────────────────────────────────

CODIGO_ALMACEN = re.compile(r"^[A-Z]{1,3}\d{2,4}$")


def parece_lista(filas: list[dict]) -> bool:
    """Una lista pelada de dos columnas: código de almacén y nombre de CEDIS.
    Es el ÚLTIMO recurso de la clasificación, no uno más: la forma es tan
    genérica que aplicada antes se tragaría hojas de SETs cuyos materiales
    también son código + texto. Puesta al final, hoy solo la cumple la hoja
    suelta del diccionario de botana."""
    pares = 0
    for c in filas:
        valores = [limpia(v) for v in c.values() if limpia(v)]
        if (len(valores) == 2 and CODIGO_ALMACEN.match(valores[0].upper())
                and not valores[1].isdigit()):
            pares += 1
    return pares >= 5


def clasifica(filas: list[dict]) -> tuple[str, int]:
    """Qué es esta hoja, mirando solo lo que contiene. Devuelve (tipo, fila de
    cabecera). Comprobado contra los trece ficheros: `Grupo de Clientes` solo
    aparece en los diccionarios, ninguna hoja de SETs tiene `Sociedad`, y el
    orden importa — ver `parece_lista`."""
    i_soc = next((i for i, c in enumerate(filas)
                  if any(limpia(v).lower() == "sociedad" for v in c.values())), None)
    if i_soc is not None:
        cab = filas[i_soc]
        if any(limpia(v).lower().startswith("grupo de cliente") for v in cab.values()):
            return "diccionario", i_soc
        return "comision", i_soc
    i_mat = next((i for i, c in enumerate(filas)
                  if i > 0 and any(limpia(v).lower() == "material" for v in c.values())), None)
    if i_mat is not None:
        return "sets", i_mat
    if parece_lista(filas):
        return "lista", 0
    return "desconocida", -1


# ── Extractores, uno por forma ─────────────────────────────────────────────

def de_sets(filas, cab, rastro) -> list[dict]:
    """SET -> materiales. Sin columna de división a propósito: esta hoja no la
    trae, y deducirla del título de la hoja sería depender de un nombre. El
    material ya determina su división al cruzar con el flujo."""
    arriba = filas[cab - 1] if cab else {}
    bloques = {}
    for col, val in filas[cab].items():
        if limpia(val).lower() != "material":
            continue
        denom = letra(num(col) + 1)
        for candidata in (denom, col):   # trampa 3
            nombre = limpia(arriba.get(candidata, ""))
            if nombre and not nombre.isdigit() and "set de datos" not in nombre.lower():
                bloques[col] = (nombre, denom)
                break
    salida, vistos = [], set()
    for c in filas[cab + 1:]:
        for col, (nombre_set, denom) in bloques.items():
            material = limpia(c.get(col, ""))
            if not re.fullmatch(r"\d{3,14}", material):
                continue
            # El mismo material puede venir repetido dentro de su propio SET con
            # dos descripciones distintas (pasa con `17377` en botana: "VUALA
            # SORPRESA CHOC C/ GRANEL" y "VUALA CHOCOLATE 60 PACK"). Es un
            # duplicado del Excel, no dos cosas: si se deja, al cruzar contra el
            # flujo duplica el importe de ese material y nadie lo ve.
            #
            # Se deduplica por SET + material, NO por material solo: si algún
            # día un material apareciera en dos SETs distintos eso sí sería un
            # conflicto real, y tiene que seguir viéndose en vez de que el
            # extractor elija por su cuenta.
            clave = (normaliza_set(nombre_set), material)
            if clave in vistos:
                continue
            vistos.add(clave)
            salida.append({**rastro, "set": normaliza_set(nombre_set),
                           "set_original": nombre_set, "material": material,
                           "material_sap": material.zfill(18),
                           "denominacion": limpia(c.get(denom, "")),
                           "origen": "cliente", "fundamento": ""})
    return salida


def de_lista(filas, rastro) -> list[dict]:
    """Almacén -> nombre de CEDIS. Sin división a propósito: la hoja no la trae,
    y deducirla del prefijo del código sería adivinar. Es hoy la única fuente
    del CEDIS de los almacenes de botana, que `dm_cedis` no recoge.

    `planta` va vacía porque la lista del cliente no la trae; la rellenan las
    filas nuestras (ver `de_mapeo_manual`), donde sí hace falta."""
    salida, vistos = [], set()
    for c in filas:
        valores = [limpia(v) for v in c.values() if limpia(v)]
        if len(valores) != 2 or not CODIGO_ALMACEN.match(valores[0].upper()):
            continue
        almacen, nombre = valores[0].upper(), valores[1]
        if nombre.isdigit() or almacen in vistos:
            continue
        vistos.add(almacen)
        salida.append({**rastro, "planta": "", "almacen": almacen,
                       "nombre_cedis": nombre, "origen": "cliente",
                       "fundamento": ""})
    return salida


def de_mapeo_manual() -> list[dict]:
    """Nuestras propias decisiones, en la misma tabla que la lista del cliente y
    distinguidas por la columna `origen`. Viven en `data/mapeo_manual.csv`, en
    el repo, para que re-ejecutar el script no las borre.

    Aquí solo entra lo que NINGUNA regla puede deducir. **Hoy está vacío**, y la
    razón conviene leerla antes de volver a llenarlo: tuvo una fila, `H793` ->
    "San Juan", deducida de que en el maestro de almacenes de SAP ese almacén se
    llama "CEDIS SAN JUAN". El cliente la desmintió el 25/08/2026 — es un
    almacén central, no un CEDIS —, así que se quitó. Un nombre que dice "CEDIS"
    no prueba que lo sea.

    La planta es parte de la llave y no un adorno: el mismo `H793` en la planta
    `H7AG` se llama "MT AGUASCALIENTE" y es otro sitio."""
    ruta = os.path.join(RAIZ, "data", "mapeo_manual.csv")
    if not os.path.exists(ruta):
        return []
    with open(ruta, encoding="utf-8") as fh:
        return [{"fichero": "data/mapeo_manual.csv", "hoja": "", "planta": limpia(r["planta"]),
                 "almacen": limpia(r["almacen"]), "nombre_cedis": limpia(r["nombre_cedis"]),
                 "origen": "deducido", "fundamento": limpia(r["fundamento"])}
                for r in csv.DictReader(fh)]


def de_mapeo_set() -> list[dict]:
    """Materiales que el fichero de SETs del cliente no trae, en la misma tabla
    y distinguidos por `origen`. Viven en `data/mapeo_set_material.csv`.

    Hoy son los tres de LECHE, y el caso explica para qué sirve este fichero.
    Preguntamos al cliente qué material era cada leche y contestó «83 light, 83
    entera y 84 deslactosada» — con el 83 repetido, así que la respuesta no se
    podía usar. Pero SAP lo dice solo: `sap_VBAP.ARKTX` rotula cada línea de
    pedido, y las 179.720 líneas de los tres materiales coinciden sin una sola
    excepción. Con leche fuera, su división cruzaba al 0% y se quedaban $31,8 M
    sin poder comisionar.

    Que la deducción sea sólida no la convierte en dato del cliente: por eso va
    marcada `deducido` y con el porqué en `fundamento`, para que quien la mire
    dentro de un año sepa que la escribimos nosotros y sobre qué evidencia.

    Los SET se escriben con la grafía del cliente, erratas incluidas
    (`LLIGTH`, `LDESLACTOZADA`): la llave tiene que cruzar con su tabla de
    tarifas, no leerse bien."""
    ruta = os.path.join(RAIZ, "data", "mapeo_set_material.csv")
    if not os.path.exists(ruta):
        return []
    with open(ruta, encoding="utf-8") as fh:
        return [{"fichero": "data/mapeo_set_material.csv", "hoja": "",
                 "set": normaliza_set(limpia(r["set"])),
                 "set_original": limpia(r["set"]),
                 "material": limpia(r["material"]),
                 "material_sap": limpia(r["material"]).zfill(18),
                 "denominacion": limpia(r["denominacion"]),
                 "origen": "deducido", "fundamento": limpia(r["fundamento"])}
                for r in csv.DictReader(fh)]


def roles(cab1: dict, cab2: dict) -> dict:
    rol = {}
    for col, val in cab1.items():
        v = limpia(val).lower()
        if v == "sociedad": rol["sociedad"] = col
        elif v.startswith("divisi"): rol["division"] = col
        elif v.startswith("centro"): rol["centro"] = col
        elif v == "almacen": rol["almacen"] = col
        elif v.startswith("distribuidora") or v == "almacén": rol.setdefault("nombre_almacen", col)
        elif v.startswith("persona"): rol["persona"] = col
        elif v.startswith("oficina"): rol["oficina"] = col
        elif v == "material": rol["material"] = col
        elif v.startswith("grupo"): rol["grupo"] = col
    for col, val in cab2.items():                      # trampa 2
        if limpia(val).lower() in ("almacen", "almacén"):
            rol["almacen"] = col
    return rol


def de_comision(filas, cab, rastro) -> tuple[list[dict], list[dict]]:
    cab1 = filas[cab]
    cab2 = filas[cab + 1] if cab + 1 < len(filas) else {}
    rol = roles(cab1, cab2)

    etiquetas = {num(c): limpia(v) for c, v in cab1.items()
                 if limpia(v) and limpia(v).upper() not in IDENTIFICACION}
    casillas = {}
    for col, val in cab2.items():                      # trampa 1
        tipo = limpia(val).upper()
        if not tipo or tipo in IDENTIFICACION or numero(tipo) is not None:
            continue
        izquierda = [n for n in etiquetas if n <= num(col)]
        if izquierda:
            casillas[col] = (etiquetas[max(izquierda)], tipo)
    columnas_pct = {c: limpia(v) for c, v in cab1.items() if limpia(v).startswith("%")}

    tarifas, abarrotes = [], []
    for c in filas[cab + 2:]:
        division = limpia(c.get(rol.get("division", ""), ""))
        centro = limpia(c.get(rol.get("centro", ""), ""))
        if not division or len(division) > 3 or not centro:
            continue
        comun = {**rastro, "semana": limpia(c.get("B", "")), "division": division,
                 "en_operacion": division in EN_OPERACION, "centro": centro,
                 "almacen": limpia(c.get(rol.get("almacen", ""), "")),
                 "persona_cod": limpia(c.get(rol.get("persona", ""), "")), "persona": "",
                 "oficina": limpia(c.get(rol.get("oficina", ""), ""))}
        if rol.get("persona"):
            comun["persona"] = limpia(c.get(letra(num(rol["persona"]) + 1), ""))

        for col, (nombre_set, tipo) in casillas.items():
            valor = numero(c.get(col))
            if valor is not None:
                tarifas.append({**comun, "set": normaliza_set(nombre_set),
                                "set_original": nombre_set, "tipo_venta": tipo,
                                "tarifa": valor})
        if columnas_pct and rol.get("material"):
            material = limpia(c.get(rol["material"], ""))
            if re.fullmatch(r"\d{3,14}", material):
                for col, etiqueta in columnas_pct.items():
                    valor = numero(c.get(col))
                    if valor is not None:
                        abarrotes.append({**comun, "material": material,
                                          "material_sap": material.zfill(18),
                                          "columna_cedis": etiqueta, "valor": valor})
    return tarifas, abarrotes


def de_diccionario(filas, cab, rastro) -> list[dict]:
    cab1 = filas[cab]
    cab2 = filas[cab + 1] if cab + 1 < len(filas) else {}
    rol = roles(cab1, cab2)
    if not rol.get("oficina"):
        return []
    # Las columnas de oficina son la rotulada y las que la segunda cabecera
    # marque a su derecha; cada rótulo es un tipo de venta (trampa 1).
    columnas = {col: limpia(val).upper() for col, val in cab2.items()
                if limpia(val) and num(col) >= num(rol["oficina"])
                and limpia(val).upper() not in IDENTIFICACION}
    if not columnas:
        columnas = {rol["oficina"]: ""}

    salida = []
    for c in filas[cab + 1:]:
        division = limpia(c.get(rol.get("division", ""), ""))
        almacen = limpia(c.get(rol.get("almacen", ""), ""))
        if not division or len(division) > 3 or not almacen:
            continue
        for col, tipo in columnas.items():
            bruto = limpia(c.get(col, ""))
            # Algunas celdas traen dos oficinas juntas: "0091-0092".
            for oficina in re.findall(r"\d{3,5}", bruto):
                salida.append({**rastro, "division": division,
                               "en_operacion": division in EN_OPERACION,
                               "centro": limpia(c.get(rol.get("centro", ""), "")),
                               "almacen": almacen,
                               "nombre_almacen": limpia(c.get(rol.get("nombre_almacen", ""), "")),
                               "persona": limpia(c.get(rol.get("persona", ""), "")),
                               "tipo_venta": tipo, "oficina": oficina,
                               "grupo_clientes": limpia(c.get(rol.get("grupo", ""), ""))})
    return salida


# ── Orquestación ───────────────────────────────────────────────────────────

CLAVE_TARIFA = ("division", "centro", "almacen", "oficina", "set", "tipo_venta")


def recorre():
    sets, tarifas, abarrotes, diccionario, listas, desconocidas = [], [], [], [], [], []
    for ruta in sorted(glob.glob(os.path.join(ORIGEN, "*.xlsx"))):
        libro = Libro(ruta)
        for hoja, objetivo in libro.hojas:
            filas = libro.filas(objetivo)
            if not filas:
                continue
            forma, cab = clasifica(filas)
            rastro = {"fichero": os.path.basename(ruta), "hoja": limpia(hoja)}
            if forma == "sets":
                sets += de_sets(filas, cab, rastro)
            elif forma == "comision":
                t, a = de_comision(filas, cab, rastro)
                tarifas += t
                abarrotes += a
            elif forma == "diccionario":
                diccionario += de_diccionario(filas, cab, rastro)
            elif forma == "lista":
                listas += de_lista(filas, rastro)
            else:
                desconocidas.append(f"{rastro['fichero']} · «{rastro['hoja']}» ({len(filas)} filas)")
    listas += de_mapeo_manual()
    # Después del recorrido, no dentro: así una fila nuestra nunca puede
    # tapar una del cliente sin que el aviso de "material en más de un SET"
    # lo cante.
    sets += de_mapeo_set()
    return sets, tarifas, abarrotes, diccionario, listas, desconocidas


def conflictos(tarifas):
    """Combinaciones con más de un valor. No se resuelven aquí: se enseñan."""
    m = defaultdict(set)
    for t in tarifas:
        m[tuple(t[k] for k in CLAVE_TARIFA)].add(t["tarifa"])
    return {k: sorted(v) for k, v in m.items() if len(v) > 1}


def escribe_csv(nombre, filas):
    os.makedirs(DESTINO, exist_ok=True)
    ruta = os.path.join(DESTINO, nombre + ".csv")
    with open(ruta, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(filas[0].keys()))
        w.writeheader()
        w.writerows(filas)
    return ruta


# Esquema EXPLÍCITO, nunca autodetect. Estas tablas son casi todo códigos con
# ceros a la izquierda —`material_sap` = 000000000000012011, `oficina` = 0126— y
# el autodetect los lee como enteros y se los come: 12011 y 126. Justo las dos
# columnas que existen para cruzar contra el flujo dejarían de cruzar, y en
# silencio, porque la tabla se carga sin error. Solo estas dos son números.
COLUMNAS_NUMERICAS = {"tarifa", "valor"}
COLUMNAS_BOOLEANAS = {"en_operacion"}


def carga(nombre, ruta_csv):
    from google.cloud import bigquery
    from google.oauth2 import service_account
    cliente = bigquery.Client(
        credentials=service_account.Credentials.from_service_account_file(
            os.path.join(RAIZ, "config", "bq_credentials.json")),
        project=PROYECTO, location=REGION)
    destino = f"{PROYECTO}.{DATASET}.{nombre}"
    with open(ruta_csv, encoding="utf-8") as fh:
        cabecera = next(csv.reader(fh))
    esquema = [
        bigquery.SchemaField(
            c,
            "FLOAT64" if c in COLUMNAS_NUMERICAS
            else "BOOL" if c in COLUMNAS_BOOLEANAS
            else "STRING")
        for c in cabecera
    ]
    config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.CSV, skip_leading_rows=1, schema=esquema,
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE)
    with open(ruta_csv, "rb") as fh:
        cliente.load_table_from_file(fh, destino, job_config=config).result()
    tipos = ", ".join(f"{c.name}:{c.field_type[0]}" for c in esquema[:4])
    print(f"   cargada {destino} ({tipos}…)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cargar", action="store_true",
                    help="además de escribir los CSV, reemplaza las tablas en BigQuery")
    args = ap.parse_args()

    sets, tarifas, abarrotes, diccionario, listas, desconocidas = recorre()
    tablas = {
        "DBC_dim_set_material": sets,
        "DBC_dim_comision_tarifa": tarifas,
        "DBC_dim_comision_abarrotes": abarrotes,
        "DBC_dim_almacen_oficina": diccionario,
        "DBC_dim_almacen_nombre": listas,
    }
    for nombre, filas in tablas.items():
        if not filas:
            print(f"!! {nombre}: 0 filas — algo cambió de forma en los Excel")
            continue
        ruta = escribe_csv(nombre, filas)
        dentro = sum(1 for f in filas if f.get("en_operacion") is True)
        detalle = f" · {dentro} de divisiones en operación" if "en_operacion" in filas[0] else ""
        print(f"{nombre:28s} {len(filas):5d} filas{detalle}")
        if args.cargar:
            carga(nombre, ruta)

    # Un material en DOS SETs distintos sí sería un conflicto real, y al
    # cruzar duplicaría importe. Se avisa, no se resuelve por cuenta propia.
    por_material = defaultdict(set)
    for r in sets:
        por_material[r["material_sap"]].add(r["set"])
    en_varios = {m: s for m, s in por_material.items() if len(s) > 1}
    deducidos = sum(1 for r in sets if r["origen"] == "deducido")
    print(f"\nSET -> material: {len(sets) - deducidos} del cliente + {deducidos} deducidos por nosotros")
    print(f"Materiales en más de un SET (duplicarían al cruzar): {len(en_varios)}")
    for m, s in list(en_varios.items())[:5]:
        print(f"   {m}: {sorted(s)}")

    choques = conflictos(tarifas)
    print(f"\nCombinaciones {' + '.join(CLAVE_TARIFA)}")
    print(f"   únicas: {len({tuple(t[k] for k in CLAVE_TARIFA) for t in tarifas}) - len(choques)}")
    print(f"   con más de un valor (van al correo, no se resuelven aquí): {len(choques)}")
    porcentaje = defaultdict(int)
    for k in choques:
        porcentaje[k[0]] += 1
    for div, n in sorted(porcentaje.items(), key=lambda x: -x[1]):
        print(f"      división {div}: {n}")

    if desconocidas:
        print("\nHojas que no encajan en ninguna forma conocida (revisar):")
        for d in desconocidas:
            print("   " + d)
    if not args.cargar:
        print("\nCSV escritos. Nada tocado en BigQuery.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
