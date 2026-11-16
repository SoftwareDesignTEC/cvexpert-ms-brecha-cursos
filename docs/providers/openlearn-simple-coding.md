# Simple coding — evidencia para revisión futura

Revisión: 15 de noviembre de 2026, America/Costa_Rica. No es un registro RDF, una
asociación aprobada ni un candidato añadido automáticamente a staging/publicación.

## Página oficial

La [página oficial de Simple coding](https://www.open.edu/openlearn/digital-computing/simple-coding/content-section-0)
presenta un curso gratuito e introductorio, con dos horas de estudio. Sus resultados
describen escribir código Python, interpretar secuencias de instrucciones y comprender
repetición. Estos resultados sustentan **proponer para revisión Python básico**, sin
afirmar formación avanzada, dominio profesional, certificación o habilidades adicionales.
La página muestra publicación/actualización de 2018; su lectura no garantiza vigencia
de actividades, servicios opcionales o finalización del curso. No se revisaron lecciones.

Actualización **2026-11-16**: en la sección de reseñas de esa misma página, una reseña
de usuario del **2026-10-18** reporta dificultades con Trinket y ejercicios interactivos.
No se reprodujo el problema: es una advertencia reportada por usuarios, **no un fallo
técnico confirmado** ni evidencia de retirada. La persona revisora debe comprobar que
las actividades esenciales siguen funcionando antes de aprobar publicación operativa,
registrar resultado/fecha/referencia y dejar pendiente si no puede confirmarlo. La
disponibilidad de la página descriptiva permanece igual. El registro editorial y el
informe pendiente de fase 4B incluyen esta advertencia y su nuevo hash de contenido.

| Campo editorial posible | Evidencia / decisión |
| --- | --- |
| URL | URL oficial anterior, conservada literalmente |
| Título de página | Simple coding |
| Acceso al curso | Señal individual de curso gratuito; revisar vigencia antes de publicar |
| Duración descriptiva | Dos horas; no se infiere de RDF ni se inyecta al adaptador |
| Nivel del proveedor | Introductorio; no es un nivel ordinal de CVExpert |
| Habilidad propuesta | Python básico; pendiente de revisión y correspondencia exacta con vocabulario |
| Nombre canónico CVExpert | Desconocido; no se consultó vocabulario operativo |
| Identidad RDF / internalID | **No verificada**, no se fabrica |
| Código visible en la página | `SCOD_1`; no se asume equivalente a internalID ni IRI RDF |
| Decisión | Pendiente; sin aprobación ni publicación |

## Única consulta RDF adicional de esta fase

Se ejecutó una sola vez el probe existente, con autorización explícita, SELECT fijo del
adaptador, grafo `http://data.open.ac.uk/context/openlearn2`, `LIMIT 10`, una petición,
timeout y límite de bytes actuales. No se modificó el filtro, orden, endpoint o grafo
para forzar la aparición del curso ni se hicieron búsquedas exhaustivas.

| Evidencia | Resultado |
| --- | --- |
| Inicio UTC | `2026-11-16T03:03:24.248Z` (15 de noviembre, 21:03:24 en Costa Rica) |
| HTTP / formato | 200 / JSON SPARQL |
| Peticiones / filas recibidas / aceptadas | 1 / 10 / 10 |
| Bytes | 5864 |
| SHA-256 de respuesta | `7e462dec05950693c5e7870ee3f7f7ab13d88a7e9b1a213b3f89f0e35814e407` |
| Coincidencias de URL con `simple-coding` | 0 |
| Cobertura | Muestra acotada; no catálogo completo |
| Persistencia de datos reales | Ninguna |

**No se encontró una identidad verificable del curso en esa muestra.** Esto no demuestra
ausencia en todo el grafo. Una URL HTML real no prueba que exista una IRI RDF con una
forma parecida. No se inventaron resource/internalID, bindings, hashes ni metadatos para
añadirlo al fixture. La respuesta real no se incorporó a las pruebas automatizadas.

Su posible incorporación queda como proceso editorial separado hasta tener evidencia
de identidad adecuada o un procedimiento editorial explícito con identidad por URL
autorizado y revisado. No se altera la consulta fija de la integración para incluirlo.

## Procedencia y derechos

Fuente descriptiva: The Open University, página oficial enlazada arriba. Se revisaron
descripción y resultados; no se extrajeron lecciones, paquetes ni contenidos multimedia.
La página diferencia su licencia de las excepciones de terceros: antes de publicar
deben revisarse derechos y atribución aplicables.

Metadatos del probe: The Open University,
[OpenLearn metadata](https://data.open.ac.uk/datasets#openlearn),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Esta nota resume resultados
de una consulta y evidencia descriptiva; no implica respaldo de la universidad y no
extiende la licencia del dataset a todos los materiales del curso.
