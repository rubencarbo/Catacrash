# Catacrash

Aplicación web (three.js, sin servidor) para **recrear escenarios de accidentes de tráfico** a escala real y, en fases posteriores, animar la secuencia del siniestro.

Esta primera fase es el **editor de escenarios**:

| Herramienta | Atajo | Qué hace |
|---|---|---|
| Seleccionar | `V` | Selecciona y edita cualquier elemento; arrastra puntos de control y objetos. |
| Carretera | `C` | Dibuja el eje; sección editable (carriles, arcén, acera con bordillo, cuneta, aparcamiento, carril bici, tierra, hierba), marcas viales, bombeo, peralte y talud. Excava/rellena el terreno automáticamente. |
| Glorieta | `U` | Glorieta paramétrica: radio, ancho, carriles, gorjal, isleta (ajardinada, tierra, pavimentada) y borde exterior. |
| Áreas | `B` | Polígonos de asfalto, hormigón, adoquín, tierra, grava, hierba o cebreado; enrasados o elevados con bordillo (isletas). Para chaflanes de cruces, aparcamientos, explanadas o plazas. |
| Río / cauce | `A` | Excava el cauce y crea la lámina de agua. |
| Elementos lineales | `L` | Muros (hormigón, piedra, ladrillo, bloque), vallas, guardarraíl, barrera New Jersey, setos, bordillos y tendidos eléctricos/telefónicos con catenaria. |
| Vehículos y peatones | `H` | Catálogo de modelos reales (medidas y pesos por generación), 20 tipos genéricos (turismos, comerciales, camión, autobús, moto, bici, patinete, peatón), biblioteca propia y lectura de fichas pegadas (auto-data, km77, ficha ITV…). Se alinean solos con el carril. |
| Objetos | `O` | Árboles (9 especies, altura/tronco/copa/follaje), rocas, farolas (con luz real), semáforos, señales verticales, carteles, hitos, bolardos, mobiliario, edificios, casetas y marcas viales (paso de peatones, línea de detención, flechas). |
| Terreno | `T` | Pincel para subir, bajar, suavizar, aplanar o llevar a cota fija (desniveles, barrancos, rampas, terraplenes). |
| Calcos | `K` | Croquis manuscrito, capturas de Google Maps/Street View u ortofoto PNOA del IGN proyectados sobre el terreno, con calibración de escala. |
| Fotos de referencia | `I` | Fotos normales, panorámicas de móvil o 360° situadas en su punto de toma. «Ver desde aquí» superpone la foto a la escena para ajustar rumbo, inclinación, giro, altura y campo de visión. |
| Medir | `M` | Distancia 3D, horizontal, desnivel y pendiente. |

Vehículos: carrocería 3D generada a escala a partir de la ficha (largo, ancho, alto, batalla, vías, voladizos, rueda), color y matrícula. Cada dato indica su origen (catálogo, ficha, estimado o genérico); los que faltan (voladizos, altura del centro de gravedad, inercia de guiñada…) se estiman y se recalculan al corregir cualquier medida. Los daños se marcan por zonas en una silueta (lado, tramo, profundidad y banda de altura) y deforman la carrocería; cada vehículo guarda sus fotos.

Simulación física (no pericial, pero físicamente coherente): el movimiento de los vehículos no se dibuja a mano, lo calcula un motor en planta a paso de 1 ms.
- Neumáticos con fuerza lateral por deriva, frenada con ABS o con bloqueo (huella), tracción y rodadura, limitadas por el círculo de fricción μ·Fz; carga por rueda con transferencia longitudinal y lateral; adherencia según firme (asfalto, tierra, hierba) y estado (seco/mojado); pendiente del terreno.
- Choques entre carrocerías y contra muros, biondas, barreras, vallas, árboles, postes, señales y edificios: fuerza proporcional a la penetración con rigidez de aplastamiento según la masa, descarga con restitución baja, rozamiento entre carrocerías y par de giro. Se conserva la cantidad de movimiento.
- Daños calculados: lado, tramo y profundidad del aplastamiento de cada contacto deforman la carrocería desde el instante del choque.
- Conductor: sigue su ruta (generada por el carril o dibujada) a la velocidad indicada y ejecuta sus acciones (frenar, volantazo, acelerar, soltar). Tras el impacto pierde el control. Con «llegar al punto de colisión en t = 0» la app ajusta su salida para que coincida con el punto marcado en el croquis.
- Resultados por vehículo: velocidad en el impacto, Δv, aplastamiento, fuerza máxima, reposo; y comparación con la posición final observada (contorno discontinuo).
- `npm test` ejecuta 21 comprobaciones de plausibilidad (distancias de frenada, crucero, curva, choque contra muro y poste, frontal y lateral, conservación del momento, huellas sin ABS) y una prueba del ajuste automático.

Ajustar a los hechos (reconstrucción inversa): cuando no se conocen las velocidades, la app las averigua. Se marcan los datos observados (posición final de cada vehículo según el croquis, aplastamiento medido en las fotos, longitud de la huella de frenada) y las incógnitas (velocidad, instante e intensidad de la frenada, volantazo). La búsqueda prueba cientos de simulaciones:
- Con punto de colisión fijado y frenada previa, la incógnita es la velocidad en el impacto y la inicial se deduce de las maniobras (como en una reconstrucción clásica); así las incógnitas quedan casi independientes.
- Rejilla sobre las velocidades, evolución diferencial (tolera que un pequeño cambio produzca un choque distinto), barridos locales y Nelder–Mead.
- Resultado: valores propuestos, margen compatible con la precisión de un croquis y, si las hay, otras combinaciones distintas que también cuadran (la solución no siempre es única). Se aplica con un clic y se puede deshacer.
- El instante de la frenada solo se busca si hay huella medida: la posición final por sí sola no lo determina.

Rendimiento: la simulación usa una caché de altura y firme, una rejilla espacial de obstáculos y se detiene cuando todo está en reposo (≈ 30–40 ms por simulación de 16 s con dos vehículos).

La línea de tiempo (0 = impacto) reproduce la simulación a varias velocidades con las velocidades instantáneas, marca acciones y contactos, ofrece cámaras libre, de seguimiento y del conductor y graba vídeo WebM.

Catálogo: `scripts/scrape_autodata.py` extrae de auto-data.net (uso personal) una versión representativa por generación y `scripts/normalize_catalog.py` genera `public/data/vehiculos.json`, que la app carga bajo demanda.

Cruces: cada carretera tiene una jerarquía (principal, normal, secundaria). Donde se solapan, la de menor rango se recorta, sus extremos toman la cota de la superior y las líneas de borde se interrumpen. Las glorietas tienen siempre el rango más alto.

Terreno: tamaño de 150 a 1000 m y malla de 2, 1 o 0,5 m. Relieve real importando el MDT del CNIG (GeoTIFF o ASC, en ETRS89 UTM o geográficas), descarga directa del IGN o relieve global (Terrarium) como respaldo. La barra de estado muestra la altitud real y las coordenadas UTM.

Ambiente: hora y mes (posición solar), firme mojado y niebla. Deshacer/rehacer, autoguardado en el navegador (IndexedDB) y exportación/importación en un único `.json`.

## Desarrollo

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # dist/ (para Firebase Hosting)
npm run build:demo   # dist-demo/index.html autocontenido
```

Despliegue gratuito en Firebase Hosting (plan Spark): `npx firebase-tools deploy --only hosting` tras `npm run build`.

## Estructura

- `src/model` — modelo de datos, historial y escenario de ejemplo.
- `src/scene` — generación 3D: terreno, carreteras, ríos, elementos lineales, objetos, calcos, cielo y luz.
- `src/tools` — herramientas de edición.
- `src/ui` — paneles (lista de escena, inspector, barra superior).
- `src/io` — archivos y georreferenciación (UTM ETRS89, WMS del IGN).
