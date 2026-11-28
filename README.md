# Catacrash

Aplicación web (three.js, sin servidor) para **recrear escenarios de accidentes de tráfico** a escala real y, en fases posteriores, animar la secuencia del siniestro.

Lectura automática del croquis: se sube (o se pega) la foto del croquis dibujado a mano y Claude, un modelo de visión, lo interpreta: reconoce las vías y el cruce, cada vehículo con sus posiciones (1 inicial, 2 choque, 3 final o «PF»), el punto de colisión («PC»), las señales (STOP, ceda el paso, velocidad, semáforo), las marcas viales y los textos (nombre de la vía, punto kilométrico, sentidos, causa). La app monta el escenario a escala real: la escala sale de las cotas escritas si las hay, si no del ancho de la vía principal según su tipo y número de carriles, y si no del tamaño de los coches dibujados. Las vías secundarias terminan en el eje de la principal, los STOP llevan su línea de detención en el borde del cruce, los vehículos quedan con sus posiciones ① ② ③ y el croquis se queda debajo como calco alineado para comparar. Antes de crear la escena se muestra lo que se ha leído (resumen, vías, vehículos, señales, textos y dudas). Dentro de claude.ai funciona con la cuenta de quien la usa (pide permiso la primera vez); en una instalación propia, con una clave de la API de Anthropic guardada en el navegador. Los textos del croquis pasan al informe («Según el croquis»).

Posiciones del croquis (la forma principal de plantear el accidente): cada vehículo se sitúa como en el croquis del atestado, con contornos A1, A2, A3… que se arrastran y se giran.
- ② En el choque: dónde estaba en el instante del impacto. ① Inicial: dónde estaba al empezar (cuando surgió el peligro). ③ Final: dónde quedó. Intermedias: por dónde pasó.
- La app deduce el recorrido siguiendo la carretera entre las posiciones (si se cambia la carretera, el recorrido la sigue), hace que cada vehículo esté en su ② en t = 0 y empieza la secuencia con todos en su ①: si no se indica la velocidad, se calcula (el de recorrido más largo va a la velocidad habitual de la vía; con frenada previa, se compensa). Con ③ conocida, «Ajustar a los hechos» busca las velocidades que la reproducen.
- Al añadir un vehículo se elige qué posición se marca (② por defecto) y la app pide después las demás (① y ③), con la opción de saltarlas. Arrastrar el vehículo en un instante de la animación fija la posición de ese instante.

Uso guiado:
- **Al empezar**, el asistente «¿Cómo quieres empezar?» ofrece: carretera tipo (recta, curva, cruce en T o en X, glorieta, con el tipo de vía), captura aérea de Google Maps u ortofoto (calco con calibración de escala en dos clics), fotos del lugar o de Street View (encajadas en 3D), croquis a mano (la app lo lee y monta la escena; o solo como calco con el papel transparente), lugar real de España por coordenadas o dirección (ortofoto PNOA y relieve del IGN) o el ejemplo. Pegar una imagen con Ctrl+V en cualquier momento pregunta si es vista aérea, croquis o foto del lugar.
- **Pasos guiados** en la parte superior, en el orden de trabajo: 1 Lugar → 2 Croquis y fotos → 3 Vehículos (posiciones ① ② ③ de cada uno) → 4 Velocidades → 5 Ver e informe, con explicaciones de qué hacer y cuándo, y botones que lo hacen.
- **Vehículos con el ratón**: al colocar, clic (se alinea con el carril) o pulsar y arrastrar en el sentido de la marcha; el seleccionado se mueve arrastrando la carrocería y se gira con la flecha naranja de su dial (se ajusta a la vía; Mayús: pasos de 15°). Barra contextual junto al vehículo: girar ±15°, invertir sentido, alinear con la vía, darle movimiento o ajustar, duplicar y borrar.
- **Secuencia del accidente** (barra inferior): regla con INICIO y FIN editables y la marca del IMPACTO, y una pista por vehículo con su curva de velocidad, las acciones del conductor (se arrastran para cambiar el instante, doble clic en la pista para añadir frenadas, volantazos, aceleraciones…, clic derecho para quitar), las posiciones fijadas, el choque y el reposo. Arrastrando la regla o cualquier pista se va a ese instante y el vehículo se coloca en la escena arrastrándolo. Se puede plegar.
- **Mover y girar**: el cursor de mano indica qué se puede agarrar; mantener pulsado un vehículo y arrastrar lo mueve (también con la herramienta Vehículos abierta); el icono ↻ junto al vehículo se arrastra alrededor para girarlo.
- **Cámara**: por defecto, botón izquierdo gira e inclina, central (o derecho) desplaza la escena, la rueda acerca; opcional (izquierdo desplaza, derecho gira); panel de navegación con brújula (clic: norte arriba), acercar/alejar, girar 45°, planta ↔ 3D y ver todo; doble clic para ir a un punto; flechas y Q/E; transiciones suaves y sin atravesar el suelo.

El **editor de escenarios**:

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
- Choques entre carrocerías y contra muros, biondas, barreras, vallas, árboles, postes, señales y edificios con el modelo de impulso usado en reconstrucción: en el punto de contacto se conservan la cantidad de movimiento y el momento angular, la velocidad normal se invierte con un coeficiente de restitución bajo que disminuye con la velocidad (≈ 0,3 a 10 km/h, ≈ 0,05 por encima de 80 km/h) y la tangencial se anula si el rozamiento entre carrocerías (μ ≈ 0,55) lo permite; si no, deslizan. La energía cinética solo puede disminuir: lo que se pierde es la deformación. El impulso se aplica como un pulso de fuerza con la duración que corresponde al aplastamiento (≈ 0,07–0,12 s), las carrocerías quedan encajadas lo que se han aplastado sin atravesarse y los golpes posteriores (la trasera que gira, un segundo roce) son impactos secundarios.
- Daños calculados: la energía de deformación se reparte entre los dos según su rigidez (el frontal ≈ 800 N/m por kg de masa; el costado, algo más de la mitad) y el ancho de enganche, y da la profundidad del aplastamiento; lado y tramo salen de la zona de contacto. Deforman la carrocería desde el instante del choque.
- Conductor: sigue su ruta (generada por el carril o dibujada) a la velocidad indicada y ejecuta sus acciones (frenar, volantazo, acelerar, soltar). Tras el impacto pierde el control: los daños frenan algo (≈ 0,2) y, pasado el tiempo de reacción (0,8 s), pisa el freno (se puede desmarcar en el inspector). Con «llegar al punto de colisión en t = 0» la app ajusta su salida para que coincida con el punto marcado en el croquis, y con posición ② cada vehículo está exactamente en ella en t = 0 (la pequeña desviación del seguimiento de la ruta se reparte en el segundo y medio previo), de modo que el choque empieza en el punto de colisión.
- Croquis leído por la IA: las posiciones ② se ajustan lo mínimo para tocarse en el PC dibujado (el lado que golpea o es golpeado), el PC queda fijo y, como el dibujo no dice las velocidades, se lanza «Ajustar a los hechos» para averiguar las que llevan a las posiciones finales (③ / PF).
- Análisis: detecta las señales de STOP y ceda el paso que encara cada vehículo: si rebasó la línea sin detenerse o, tras detenerse, no cedió el paso al que venía por la vía preferente; la invasión del carril contrario solo cuenta como causa si el otro venía de frente.
- Resultados por vehículo: velocidad en el impacto, Δv, aplastamiento, fuerza máxima, reposo; y comparación con la posición final observada (contorno discontinuo).
- `npm test` ejecuta 28 comprobaciones de plausibilidad (distancias de frenada, crucero, curva, choque contra muro y poste, frontal, lateral y en cruce, conservación del momento, que la energía nunca aumente, giros acotados, detención tras el choque, huellas sin ABS) y una prueba del ajuste automático.

Ajustar a los hechos (reconstrucción inversa): cuando no se conocen las velocidades, la app las averigua. Se marcan los datos observados (posición final de cada vehículo según el croquis, aplastamiento medido en las fotos, longitud de la huella de frenada) y las incógnitas (velocidad, instante e intensidad de la frenada, volantazo). La búsqueda prueba cientos de simulaciones:
- Con punto de colisión fijado y frenada previa, la incógnita es la velocidad en el impacto y la inicial se deduce de las maniobras (como en una reconstrucción clásica); así las incógnitas quedan casi independientes.
- Rejilla sobre las velocidades, evolución diferencial (tolera que un pequeño cambio produzca un choque distinto), barridos locales y Nelder–Mead.
- Resultado: valores propuestos, margen compatible con la precisión de un croquis y, si las hay, otras combinaciones distintas que también cuadran (la solución no siempre es única). Se aplica con un clic y se puede deshacer.
- El instante de la frenada solo se busca si hay huella medida: la posición final por sí sola no lo determina.

Recolocar durante el accidente: con la barra de tiempo en cualquier instante, el vehículo seleccionado se arrastra o gira (G / R) tal como está en ese momento y la reconstrucción se adapta.
- Antes del choque: la ruta se rehace para pasar por la nueva posición y la velocidad se recalcula para que esté ahí en ese instante (posiciones iniciales o de aproximación).
- En el instante del impacto: además se desplaza el punto de colisión y los vehículos sincronizados llegan al nuevo punto.
- Después del choque o en reposo: queda como posición observada (o posición final) y se lanza «Ajustar a los hechos» para buscar las velocidades que la reproducen. Las posiciones observadas se ven como contornos con su instante y se pueden quitar en el inspector.

Daños: la carrocería se deforma de forma progresiva (aplastamiento con perfil redondeado, compresión en acordeón, capó pandeado, costados abombados, esquinas plegadas, arrugas irregulares), con pintura rascada, faros y pilotos rotos, retrovisores arrancados, parabrisas agrietado en golpes graves, ruedas desplazadas y restos (cristales, plásticos, pintura) esparcidos en el suelo desde el instante del choque.

Informe del accidente (botón del informe en la barra superior): análisis automático de la reconstrucción, orientativo y no pericial.
- Cronología: acciones de los conductores, inicio de la invasión del carril contrario, momento en que cada conductor puede ver al otro (línea de visión contra el relieve, árboles, edificios y muros), contactos y reposo.
- Factores: velocidad frente al límite (última señal R-301 que encara el vehículo o límite genérico de la vía), invasión del carril contrario o salida de la calzada, radio de la curva frente a la velocidad (habitual y límite físico), adherencia utilizada, tiempo de reacción (referencia 1 s) y si podía detenerse antes del punto de colisión, firme, luz y niebla.
- Evitabilidad: vuelve a simular el accidente desde las mismas posiciones cambiando una sola conducta: circular al límite, mantenerse en el carril (y el otro sin tener que esquivar) o frenar 1 s después de poder ver al otro. Dice si el choque se habría evitado y, si no, con qué Δv.
- Imágenes en planta (antes, impacto, posiciones finales) con trayectorias, velocidades, escala y norte; gráfica de velocidades; narración y conclusión prudente. Se imprime o se guarda en PDF.

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
